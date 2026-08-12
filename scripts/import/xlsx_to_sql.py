#!/usr/bin/env python3
"""Turn the salon's DAILY SERVICE SALES REPORT workbooks into one paste-ready
SQL file for the Supabase SQL editor.

Usage:
    python3 xlsx_to_sql.py [-o import.sql] FILE.xlsx [FILE.xlsx ...]

Branch is read from the filename (MAIN_* / BRANCH_*). Reruns are safe: every
ticket carries a deterministic idempotency key and the SQL only inserts
tickets whose key is absent.

Source facts this transform is built around (verified against Jan+Feb 2026):
- Header order differs between months (SERVICE and TYPE OF SERVICE swap), so
  columns are mapped by header text per file.
- "DAILY SALES (2)" is a duplicate of "DAILY SALES" (same totals); only the
  latter is read.
- Most rows are anonymous daily tallies (no NAME). They become one ticket per
  row against a per-branch pooled walk-in client (clients.is_pool).
- Named rows group into one ticket per (date, name): the salon's history has
  no phone numbers, so identity is the normalised name.
- SHARING is a percent pair or "FIXED SHARING"; COMPANY SHARE is authoritative.
  The line's sharing_rate is fitted (6 dp) so the database's generated
  company_share_cents reproduces the workbook's peso split exactly.
- ASSIST is a peso deduction paid to the shampoo assistant out of the
  technician's share. The schema does not model intra-staff redistribution;
  totals are reported so nothing vanishes silently.
"""

import argparse
import hashlib
import re
import sys
from collections import Counter, defaultdict
from datetime import date, datetime
from decimal import Decimal, ROUND_HALF_UP

from openpyxl import load_workbook

TYPE_MAP = {"HAIR": "Hair", "NAILS": "Nail & Foot", "OTHERS": "Others"}

def q(s):
    """SQL string literal."""
    if s is None:
        return "null"
    return "'" + str(s).replace("'", "''") + "'"

def norm_name(s):
    return re.sub(r"\s+", " ", str(s).strip().upper())

def fit_rate(company_cents, total_cents):
    """Rate (6 dp) such that round-half-up(total*rate) == company, exactly."""
    if total_cents <= 0:
        return Decimal("0"), True
    base = (Decimal(company_cents) / Decimal(total_cents)).quantize(
        Decimal("0.000001"), rounding=ROUND_HALF_UP)
    step = Decimal("0.000001")
    for k in range(0, 40):
        for cand in ({base} if k == 0 else {base + k * step, base - k * step}):
            if cand < 0 or cand > 1:
                continue
            got = int((Decimal(total_cents) * cand).quantize(Decimal("1"), rounding=ROUND_HALF_UP))
            if got == company_cents:
                return cand, True
    return base, False


def read_file(path, branch):
    wb = load_workbook(path, data_only=True, read_only=True)
    ws = wb["DAILY SALES"]
    it = ws.iter_rows(values_only=True)
    header = [str(h).strip().upper() if h else "" for h in next(it)]

    def col(*names):
        for n in names:
            if n in header:
                return header.index(n)
        raise SystemExit(f"{path}: none of {names} in header {header}")

    ix = {
        "date": col("DATE"), "name": col("NAME"), "brgy": col("BRGY."),
        "town": col("TOWN & PROVINCE"), "oldnew": col("OLD OR NEW"),
        "source": col("INQUIRY SOURCE"), "referred": col("REFERRED BY"),
        "service": col("SERVICE"), "type": col("TYPE OF SERVICE"),
        "amount": col("AMOUNT"), "no": col("NO."), "total": col("TOTAL AMOUNT"),
        "sharing": col("SHARING"), "company": col("COMPANY SHARE"),
        "tech": col("TECHNICIAN"), "assist": col("ASSIST", "ASSIST (BANLAW)"),
        "rate": col("RATE"),
    }

    rows, skipped = [], []
    last_date = None
    for lineno, r in enumerate(it, start=2):
        total = r[ix["total"]]
        if not isinstance(total, (int, float)):
            continue
        d = r[ix["date"]]
        if isinstance(d, datetime):
            d = d.date()
        elif d is None:
            d = last_date
        if not isinstance(d, date):
            skipped.append((lineno, "no usable date"))
            continue
        last_date = d

        service = r[ix["service"]]
        tech = r[ix["tech"]]
        if not service or not tech:
            skipped.append((lineno, f"missing {'service' if not service else 'technician'}"))
            continue

        qty = r[ix["no"]]
        qty = int(qty) if isinstance(qty, (int, float)) and qty >= 1 else 1
        amount = r[ix["amount"]]
        company = r[ix["company"]]
        rating = r[ix["rate"]]
        try:
            rating = int(str(rating))
        except (TypeError, ValueError):
            rating = None
        if rating is not None and not (1 <= rating <= 5):
            rating = None

        rows.append({
            "lineno": lineno,
            "date": d,
            "name": str(r[ix["name"]]).strip() if r[ix["name"]] else None,
            "brgy": str(r[ix["brgy"]]).strip() if r[ix["brgy"]] else None,
            "town": str(r[ix["town"]]).strip() if r[ix["town"]] else None,
            "oldnew": str(r[ix["oldnew"]]).strip().upper() if r[ix["oldnew"]] else None,
            "source": str(r[ix["source"]]).strip() if r[ix["source"]] else None,
            "referred": str(r[ix["referred"]]).strip() if r[ix["referred"]] else None,
            "service": norm_name(service),
            "type": TYPE_MAP.get(norm_name(r[ix["type"]]) if r[ix["type"]] else "", None),
            "sharing_label": str(r[ix["sharing"]]).strip() if r[ix["sharing"]] else None,
            "qty": qty,
            "amount_cents": int(round(float(amount) * 100)) if isinstance(amount, (int, float)) else None,
            "total_cents": int(round(float(total) * 100)),
            "company_cents": int(round(float(company) * 100)) if isinstance(company, (int, float)) else None,
            "tech": norm_name(tech),
            "assist_cents": int(round(float(r[ix["assist"]]) * 100))
                if isinstance(r[ix["assist"]], (int, float)) else None,
            "rating": rating,
            "branch": branch,
        })
    return rows, skipped


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="+")
    ap.add_argument("-o", "--output", default="import_history.sql")
    args = ap.parse_args()

    all_rows, all_skipped = [], []
    for path in args.files:
        fname = path.rsplit("/", 1)[-1]
        m = re.search(r"(MAIN|BRANCH)_", fname)
        if not m:
            sys.exit(f"Cannot infer branch from filename: {fname}")
        rows, skipped = read_file(path, m.group(1))
        all_rows.extend(rows)
        all_skipped.extend((fname, ln, why) for ln, why in skipped)
        print(f"{fname}: {len(rows)} rows, {len(skipped)} skipped", file=sys.stderr)

    # Fill missing type from the same service seen elsewhere; default Others.
    type_by_service = {}
    for r in all_rows:
        if r["type"]:
            type_by_service.setdefault(r["service"], Counter())[r["type"]] += 1
    for r in all_rows:
        if not r["type"]:
            c = type_by_service.get(r["service"])
            r["type"] = c.most_common(1)[0][0] if c else "Others"

    # Fit the sharing rate per line so generated company share is exact.
    unfit = 0
    for r in all_rows:
        company = r["company_cents"]
        if company is None:
            company = round(r["total_cents"] / 2)  # absent: assume 50-50, reported
            r["company_cents"] = company
            r["company_assumed"] = True
        rate, ok = fit_rate(company, r["total_cents"])
        r["rate6"] = f"{rate:.6f}"
        if not ok:
            unfit += 1

    # qty * unit - discount must equal the workbook total exactly.
    for r in all_rows:
        qty, total = r["qty"], r["total_cents"]
        unit = r["amount_cents"]
        if unit is None or unit * qty < total:
            unit = -(-total // qty)  # ceil division
        r["unit_cents"] = unit
        r["discount_cents"] = unit * qty - total

    # Ticket keys: named rows group per (branch, date, name); anonymous rows
    # are one ticket each, disambiguated by an occurrence counter.
    occurrence = Counter()
    for r in all_rows:
        if r["name"]:
            key = f"import:{r['branch']}:{r['date']}:N:{hashlib.sha1(norm_name(r['name']).encode()).hexdigest()[:16]}"
        else:
            sig = f"{r['branch']}|{r['date']}|{r['service']}|{r['tech']}|{r['qty']}|{r['total_cents']}"
            occurrence[sig] += 1
            key = f"import:{r['branch']}:{r['date']}:R:{hashlib.sha1(f'{sig}|{occurrence[sig]}'.encode()).hexdigest()[:16]}"
        r["ticket_key"] = key

    # Per-service defaults: modal sharing rate, and one canonical type per
    # service name — the source files a service under different types on a
    # handful of rows (SHAVE under HAIR and NAILS), and a split identity
    # would fracture the analytics.
    svc_rates = defaultdict(Counter)
    svc_types_votes = defaultdict(Counter)
    for r in all_rows:
        svc_rates[r["service"]][r["rate6"]] += 1
        svc_types_votes[r["service"]][r["type"]] += 1
    svc_default_rate = {s: c.most_common(1)[0][0] for s, c in svc_rates.items()}
    svc_type = {s: c.most_common(1)[0][0] for s, c in svc_types_votes.items()}

    # Modal clean unit price per (branch, service) for the price list.
    price_votes = defaultdict(Counter)
    for r in all_rows:
        if r["discount_cents"] == 0 and r["amount_cents"] is not None:
            price_votes[(r["branch"], r["service"])][r["unit_cents"]] += 1
    modal_price = {k: c.most_common(1)[0][0] for k, c in price_votes.items()}

    # Validation expectations per branch-month.
    expect = defaultdict(lambda: {"revenue": 0, "company": 0, "treatments": 0, "rows": 0})
    assist_total = defaultdict(int)
    for r in all_rows:
        k = (r["branch"], r["date"].strftime("%Y-%m"))
        expect[k]["revenue"] += r["total_cents"]
        expect[k]["company"] += r["company_cents"]
        expect[k]["treatments"] += r["qty"]
        expect[k]["rows"] += 1
        if r["assist_cents"]:
            assist_total[k] += r["assist_cents"]

    # ------------------------------------------------------------------ SQL
    out = []
    w = out.append
    w("-- inStyle Salon history import — generated by scripts/import/xlsx_to_sql.py")
    w(f"-- Files: {', '.join(p.rsplit('/', 1)[-1] for p in args.files)}")
    w("-- Rerun-safe: existing idempotency keys are skipped.")
    w("begin;")
    w("""
create temp table _imp (
  seq int, branch text, tdate date, ticket_key text,
  cname text, brgy text, town text, oldnew text, isource text, referred text,
  service text, stype text, qty int, unit_cents bigint, discount_cents bigint,
  rate6 numeric(8,6), tech text, rating int, total_cents bigint, company_cents bigint
) on commit drop;""")

    CHUNK = 400
    for i in range(0, len(all_rows), CHUNK):
        vals = []
        for seq, r in enumerate(all_rows[i:i + CHUNK], start=i):
            vals.append(
                f"({seq},{q(r['branch'])},'{r['date']}',{q(r['ticket_key'])},"
                f"{q(r['name'])},{q(r['brgy'])},{q(r['town'])},{q(r['oldnew'])},"
                f"{q(r['source'])},{q(r['referred'])},{q(r['service'])},{q(r['type'])},"
                f"{r['qty']},{r['unit_cents']},{r['discount_cents']},{r['rate6']},"
                f"{q(r['tech'])},{r['rating'] if r['rating'] else 'null'},"
                f"{r['total_cents']},{r['company_cents']})")
        w("insert into _imp values\n" + ",\n".join(vals) + ";")

    w("""
-- Reference ids
create temp table _ctx on commit drop as
select
  (select id from businesses where code = 'SALON') as biz,
  (select id from profiles where role = 'owner' order by created_at limit 1) as owner;

do $$ begin
  if (select owner from _ctx) is null then
    raise exception 'No owner profile exists yet. Create the owner account first.';
  end if;
end $$;

-- Service types (Hair / Nail & Foot exist; Others may not)
insert into service_types (name, sort_order, business_id)
select v.stype, 50, (select biz from _ctx)
from (select distinct stype from _imp) v
where not exists (select 1 from service_types st
                  where st.name = v.stype and st.business_id = (select biz from _ctx));
""")

    svc_values = ",\n".join(
        f"({q(s)},{q(svc_type[s])},{svc_default_rate[s]})" for s in sorted(svc_type))
    w(f"""
-- Services observed in the history, with their modal company share
create temp table _svc (name text, stype text, rate numeric(8,6)) on commit drop;
insert into _svc values\n{svc_values};

insert into services (service_type_id, name, default_sharing_rate, default_duration_min)
select st.id, v.name, round(v.rate, 3), 45
from _svc v
join service_types st on st.name = v.stype and st.business_id = (select biz from _ctx)
on conflict (service_type_id, name) do nothing;
""")

    w("""
-- Technicians observed in the history (branch = where they mostly worked)
insert into technicians (branch_id, full_name, active)
select b.id, v.tech, true
from (select distinct on (tech) tech, branch
      from (select tech, branch, count(*) c from _imp group by 1, 2) x
      order by tech, c desc) v
join branches b on b.code = v.branch and b.business_id = (select biz from _ctx)
where not exists (
  select 1 from technicians t
  join branches tb on tb.id = t.branch_id
  where t.full_name = v.tech and tb.business_id = (select biz from _ctx)
);

-- The seeded placeholder roster and catalogue were stand-ins; retire any
-- that carry no history so pickers show the real salon.
update technicians t set active = false
from branches b
where b.id = t.branch_id and b.business_id = (select biz from _ctx)
  and t.full_name in ('Ana Ramos','Bea Salvador','Cristy Delos Reyes','Divine Ocampo',
                      'Elmer Padilla','Fely Baldoza','Grace Nolasco','Hazel Villar','Ivy Marquez')
  and not exists (select 1 from ticket_lines tl where tl.technician_id = t.id);

update services s set active = false
from service_types st
where st.id = s.service_type_id and st.business_id = (select biz from _ctx)
  and s.name not in (select name from _svc)
  and not exists (select 1 from ticket_lines tl where tl.service_id = s.id);

-- Pooled walk-in client per branch (money counts, retention excludes)
insert into clients (phone, phone_declined, full_name, is_pool)
select 'WALKIN-POOL-' || b.code, true, 'Walk-ins (unrecorded, ' || b.name || ')', true
from branches b
where b.business_id = (select biz from _ctx)
  and b.code in (select distinct branch from _imp)
on conflict (phone) do nothing;

-- Named clients: identity is the normalised name (history has no phones).
insert into clients (phone, phone_declined, full_name, barangay, town, inquiry_source,
                     first_visit_on, notes)
select
  'WALKIN-N-' || md5(upper(v.cname)),
  true,
  v.cname,
  v.brgy, v.town, v.isource,
  v.first_date,
  case when v.referred is not null then 'Referred by ' || v.referred else null end
from (
  select distinct on (upper(cname))
    cname,
    first_value(brgy) over w as brgy,
    first_value(town) over w as town,
    first_value(isource) over w as isource,
    first_value(referred) over w as referred,
    min(tdate) over (partition by upper(cname)) as first_date
  from _imp where cname is not null
  window w as (partition by upper(cname) order by (brgy is null), seq
               rows between unbounded preceding and unbounded following)
) v
on conflict (phone) do nothing;

-- Tickets: one per ticket_key not already imported
create temp table _new_tickets (id uuid, idempotency_key text) on commit drop;

with heads as (
  select distinct on (ticket_key)
    ticket_key, branch, tdate, cname,
    bool_or(oldnew = 'NEW') over (partition by ticket_key) as any_new
  from _imp
  order by ticket_key, seq
),
ins as (
  insert into tickets (branch_id, client_id, ticket_date, payment_method,
                       is_new_client, idempotency_key, created_by)
  select
    b.id,
    coalesce(nc.id, pc.id),
    h.tdate,
    'cash',
    coalesce(h.any_new, false) and h.cname is not null,
    h.ticket_key,
    (select owner from _ctx)
  from heads h
  join branches b on b.code = h.branch and b.business_id = (select biz from _ctx)
  left join clients nc on h.cname is not null
                      and nc.phone = 'WALKIN-N-' || md5(upper(h.cname))
  left join clients pc on h.cname is null and pc.phone = 'WALKIN-POOL-' || h.branch
  where not exists (select 1 from tickets t where t.idempotency_key = h.ticket_key)
  returning id, idempotency_key
)
insert into _new_tickets select id, idempotency_key from ins;

-- Lines for the tickets created in this run
insert into ticket_lines (ticket_id, service_id, technician_id, qty, unit_price_cents,
                          discount_type, discount_cents, sharing_rate, rating, line_number)
select
  nt.id, s.id, tech.id, i.qty, i.unit_cents,
  case when i.discount_cents > 0 then 'negotiated' end,
  i.discount_cents, i.rate6, i.rating,
  row_number() over (partition by nt.id order by i.seq)
from _imp i
join _new_tickets nt on nt.idempotency_key = i.ticket_key
-- Lines resolve their service through the canonical mapping, not the row's
-- own type column, so a SHAVE filed under NAILS still lands on SHAVE.
join _svc sv on sv.name = i.service
join service_types st on st.name = sv.stype and st.business_id = (select biz from _ctx)
join services s on s.service_type_id = st.id and s.name = sv.name
join branches b on b.code = i.branch and b.business_id = (select biz from _ctx)
join lateral (
  select t.id from technicians t
  join branches tb on tb.id = t.branch_id
  where t.full_name = i.tech and tb.business_id = (select biz from _ctx)
  order by (t.branch_id = b.id) desc limit 1
) tech on true;

-- One cash payment per new ticket
insert into ticket_payments (ticket_id, method, amount_cents)
select nt.id, 'cash', sum(i.total_cents)
from _imp i join _new_tickets nt on nt.idempotency_key = i.ticket_key
group by nt.id;

-- Abort rather than commit a partial import: every staged row must have
-- landed, and every ticket's lines must equal its payment.
do $$
declare v_staged bigint; v_landed bigint; v_bad bigint;
begin
  select count(*) into v_staged from _imp i
  where exists (select 1 from _new_tickets nt where nt.idempotency_key = i.ticket_key);
  select count(*) into v_landed from ticket_lines tl
  where exists (select 1 from _new_tickets nt where nt.id = tl.ticket_id);
  if v_staged <> v_landed then
    raise exception 'Import aborted: % rows staged but % lines landed (service or technician failed to resolve).',
      v_staged, v_landed;
  end if;

  select count(*) into v_bad from _new_tickets nt
  where (select coalesce(sum(total_cents), 0) from ticket_lines where ticket_id = nt.id)
     <> (select coalesce(sum(amount_cents), 0) from ticket_payments where ticket_id = nt.id);
  if v_bad > 0 then
    raise exception 'Import aborted: % tickets have lines that do not equal their payment.', v_bad;
  end if;
end $$;
""")

    price_values = ",\n".join(
        f"({q(b)},{q(s)},{cents})" for (b, s), cents in sorted(modal_price.items()))
    w(f"""
-- Branch price list from the modal undiscounted charge per service
create temp table _prices (branch text, service text, cents bigint) on commit drop;
insert into _prices values\n{price_values};

insert into branch_service_prices (branch_id, service_id, price_cents, effective_from)
select b.id, s.id, p.cents, date '2026-01-01'
from _prices p
join branches b on b.code = p.branch and b.business_id = (select biz from _ctx)
join service_types st on st.business_id = (select biz from _ctx)
join services s on s.service_type_id = st.id and s.name = p.service
on conflict (branch_id, service_id, effective_from) do nothing;

-- Monthly targets from the workbook dashboards
update branches set monthly_target_cents = 49500000
where business_id = (select biz from _ctx) and code in ('MAIN','BRANCH');
""")

    w("""
-- ---------------------------------------------------------------------------
-- Verification: these totals must match the workbook dashboards exactly.
-- ---------------------------------------------------------------------------
select b.code as branch,
       to_char(t.ticket_date, 'YYYY-MM') as month,
       sum(tl.total_cents) / 100.0 as sales,
       sum(tl.company_share_cents) / 100.0 as company_share,
       sum(tl.qty) as treatments,
       count(distinct t.id) as tickets
from tickets t
join branches b on b.id = t.branch_id
join ticket_lines tl on tl.ticket_id = t.id
where t.idempotency_key like 'import:%' and t.voided_at is null
group by 1, 2 order by 1, 2;

commit;""")

    with open(args.output, "w") as f:
        f.write("\n".join(out) + "\n")

    # ------------------------------------------------------------- report
    print(f"\nWrote {args.output} ({len(all_rows)} lines staged)", file=sys.stderr)
    print("\nExpected totals (compare with the verification query output):", file=sys.stderr)
    for (branch, month), e in sorted(expect.items()):
        print(f"  {branch:6s} {month}  sales {e['revenue']/100:>12,.2f}  "
              f"company {e['company']/100:>12,.2f}  treatments {e['treatments']:>5}  "
              f"rows {e['rows']}", file=sys.stderr)
    if unfit:
        print(f"\nWARNING: {unfit} lines could not fit an exact sharing rate", file=sys.stderr)
    assumed = sum(1 for r in all_rows if r.get("company_assumed"))
    if assumed:
        print(f"NOTE: {assumed} lines had no company share; assumed 50%", file=sys.stderr)
    if all_skipped:
        print(f"\nSkipped {len(all_skipped)} rows:", file=sys.stderr)
        for fname, ln, why in all_skipped[:20]:
            print(f"  {fname} line {ln}: {why}", file=sys.stderr)
    if assist_total:
        print("\nAssist (banlaw) deductions present in source but not modelled "
              "(intra-staff redistribution; company share unaffected):", file=sys.stderr)
        for (branch, month), cents in sorted(assist_total.items()):
            print(f"  {branch:6s} {month}  {cents/100:,.2f}", file=sys.stderr)


if __name__ == "__main__":
    main()

-- 0032_daily_cash_perf.sql — the Daily cash view, ~100× faster.
--
-- Profiling at production volume found exactly one slow path in the whole
-- database: v_daily_cash. Its old shape ran ~12 correlated subqueries per
-- row plus expected_cash() twice per row — and that 20-subplan shape also
-- tricked Postgres's JIT cost heuristic into compiling ~240 functions per
-- query (over a second of pure compilation). Measured on a full copy of
-- production data: 1.3–4.0 s per load, and 10–20 ms after this rewrite,
-- verified row-identical (EXCEPT in both directions = 0 over all rows).
--
-- The rewrite makes ONE grouped pass each over ticket_payments,
-- ticket_lines and expenses, joined by branch+date. expected_cash is
-- inlined (same formula as the 0027 function: opening float + cash
-- takings − technician shares − cash expenses, closed tickets only);
-- if expected_cash() ever changes, change this view to match.
--
-- Also: JIT off for the API roles — for OLTP-shaped queries like this
-- app's, JIT compilation only ever burns time; and a small aggregate
-- function so the cash page's earnings card stops downloading every
-- ticket line of the period.
--
-- Rerun-safe. Run as-is in the Supabase SQL editor (default role).

create or replace view v_daily_cash
with (security_invoker = on) as
with days as (
  select branch_id, ticket_date as business_date from tickets
  where voided_at is null and status = 'closed'
  union
  select branch_id, spent_on from expenses
  union
  select branch_id, business_date from cash_days
),
pay as (
  select t.branch_id, t.ticket_date as business_date,
         sum(tp.amount_cents) filter (where tp.method = 'cash')  as cash,
         sum(tp.amount_cents) filter (where tp.method <> 'cash') as non_cash,
         sum(tp.amount_cents) filter (where tp.method = 'gcash') as gcash,
         sum(tp.amount_cents) filter (where tp.method = 'maya')  as maya,
         sum(tp.amount_cents) filter (where tp.method in ('bank', 'card')) as bank_card,
         sum(tp.amount_cents) filter (where tp.method in ('package', 'comp')) as package_comp,
         sum(tp.amount_cents) filter (where tp.method = 'gift_cert') as gift_cert
  from ticket_payments tp
  join tickets t on t.id = tp.ticket_id
  where t.voided_at is null and t.status = 'closed'
  group by t.branch_id, t.ticket_date
),
lin as (
  select t.branch_id, t.ticket_date as business_date,
         sum(tl.total_cents)            as gross,
         sum(tl.technician_share_cents) as tech_share,
         sum(tl.company_share_cents)    as company_share,
         sum(tl.discount_cents)         as discounts
  from ticket_lines tl
  join tickets t on t.id = tl.ticket_id
  where t.voided_at is null and t.status = 'closed'
  group by t.branch_id, t.ticket_date
),
exp as (
  select branch_id, spent_on as business_date,
         sum(amount_cents) filter (where paid_from = 'cash') as cash_expenses,
         sum(amount_cents) as expenses
  from expenses
  group by branch_id, spent_on
)
select
  d.branch_id,
  d.business_date,
  coalesce(cd.opening_float_cents, 0) as opening_float_cents,
  coalesce(p.cash, 0)     as cash_takings_cents,
  coalesce(p.non_cash, 0) as non_cash_takings_cents,
  coalesce(e.cash_expenses, 0) as cash_expenses_cents,
  coalesce(e.expenses, 0)      as expenses_cents,
  (coalesce(cd.opening_float_cents, 0) + coalesce(p.cash, 0)
     - coalesce(l.tech_share, 0) - coalesce(e.cash_expenses, 0))::bigint
    as expected_cash_cents,
  cd.counted_cash_cents,
  case when cd.counted_cash_cents is null then null
       else cd.counted_cash_cents
            - (coalesce(cd.opening_float_cents, 0) + coalesce(p.cash, 0)
               - coalesce(l.tech_share, 0) - coalesce(e.cash_expenses, 0))::bigint
  end as variance_cents,
  cd.closed_at,
  cd.note,
  coalesce(l.gross, 0)         as gross_sales_cents,
  coalesce(l.tech_share, 0)    as technician_share_cents,
  coalesce(l.company_share, 0) as company_share_cents,
  coalesce(l.discounts, 0)     as discounts_cents,
  coalesce(p.gcash, 0)     as gcash_takings_cents,
  coalesce(p.maya, 0)      as maya_takings_cents,
  coalesce(p.bank_card, 0) as bank_card_takings_cents,
  coalesce(p.package_comp, 0) as package_comp_cents,
  coalesce(p.gift_cert, 0)    as gift_cert_cents
from days d
left join cash_days cd
  on cd.branch_id = d.branch_id and cd.business_date = d.business_date
left join pay p on p.branch_id = d.branch_id and p.business_date = d.business_date
left join lin l on l.branch_id = d.branch_id and l.business_date = d.business_date
left join exp e on e.branch_id = d.branch_id and e.business_date = d.business_date;

-- ---------------------------------------------------------------------------
-- JIT off for the API roles: for short OLTP queries the compiler burns
-- far more time than it saves (measured: over a second on the old view).
-- Session-level setting, applies to every future connection of the role.
-- ---------------------------------------------------------------------------

alter role authenticated set jit = off;
alter role anon set jit = off;

-- ---------------------------------------------------------------------------
-- Earnings by technician, aggregated server-side: the cash page card was
-- downloading every ticket line of the period (dozens of round trips on a
-- YTD view) to sum five numbers in the browser.
-- ---------------------------------------------------------------------------

create or replace function f_technician_earnings(
  p_branch uuid, p_from date default null, p_to date default null)
returns table (
  technician_name text, lines bigint, treatments bigint,
  revenue_cents bigint, company_share_cents bigint, technician_share_cents bigint)
language sql stable security invoker set search_path = public as $$
  select technician_name,
         count(*)::bigint,
         sum(qty)::bigint,
         sum(total_cents)::bigint,
         sum(company_share_cents)::bigint,
         sum(technician_share_cents)::bigint
  from v_ticket_lines_active
  where branch_id = p_branch
    and (p_from is null or ticket_date >= p_from)
    and (p_to   is null or ticket_date <= p_to)
  group by technician_name
  order by sum(technician_share_cents) desc
$$;

-- ---------------------------------------------------------------------------
-- Verification: the view's column list is unchanged (create or replace
-- would have refused otherwise) and both new pieces exist.
-- ---------------------------------------------------------------------------

select
  (select count(*) from information_schema.columns
   where table_name = 'v_daily_cash') as view_columns,      -- expect 21
  to_regprocedure('f_technician_earnings(uuid, date, date)') is not null
    as earnings_fn_ready,
  (select setconfig from pg_db_role_setting s join pg_roles r on r.oid = s.setrole
   where r.rolname = 'authenticated') as authenticated_settings;

-- 0028_inventory.sql — product inventory core (Stage: pulled forward).
--
-- Scope: the process-independent core. A product catalogue per business,
-- and an IMMUTABLE movement ledger per branch — deliveries (with unit
-- cost), usage, count corrections, and branch transfers. Stock on hand is
-- always the sum of the ledger, never a stored number; costing is a
-- weighted average over deliveries. Corrections are made by writing an
-- opposite movement, never by editing history — the ledger is the audit.
--
-- Deliberately NOT here (waiting on the salon's answers): automatic
-- per-service consumption, and retail product sales at the POS.
--
-- Rerun-safe. Run as-is in the Supabase SQL editor (default role).

-- ---------------------------------------------------------------------------
-- Catalogue
-- ---------------------------------------------------------------------------

create table if not exists products (
  id                  uuid primary key default gen_random_uuid(),
  business_id         uuid not null references businesses(id) on delete restrict,
  name                text not null,
  unit                text not null default 'pc',      -- bottle, sachet, box, pc…
  low_stock_threshold int  not null default 0 check (low_stock_threshold >= 0),
  active              boolean not null default true,
  created_at          timestamptz not null default now()
);

create unique index if not exists products_business_lower_name_key
  on products (business_id, lower(name));

-- ---------------------------------------------------------------------------
-- Movement ledger. qty is always positive; kind carries the sign.
-- ---------------------------------------------------------------------------

create table if not exists stock_moves (
  id              uuid primary key default gen_random_uuid(),
  product_id      uuid not null references products(id) on delete restrict,
  branch_id       uuid not null references branches(id) on delete restrict,
  moved_on        date not null default business_date(),
  kind            text not null check (kind in
                    ('delivery', 'usage', 'adjust_in', 'adjust_out',
                     'transfer_in', 'transfer_out')),
  qty             int  not null check (qty > 0),
  unit_cost_cents bigint check (unit_cost_cents >= 0),  -- deliveries only
  supplier        text,
  note            text,
  expense_id      uuid references expenses(id) on delete set null,
  transfer_id     uuid,                                 -- pairs the two legs
  recorded_by     uuid not null references auth.users(id) on delete restrict,
  created_at      timestamptz not null default now()
);

create index if not exists stock_moves_product_branch_idx
  on stock_moves (product_id, branch_id, moved_on);
create index if not exists stock_moves_branch_date_idx
  on stock_moves (branch_id, moved_on);

/** +qty for stock coming in, −qty for stock going out. */
create or replace function stock_signed_qty(p_kind text, p_qty int)
returns int language sql immutable as $$
  select case when p_kind in ('delivery', 'adjust_in', 'transfer_in')
              then p_qty else -p_qty end
$$;

-- ---------------------------------------------------------------------------
-- Guards: the product must belong to the branch's business; a cost rides
-- only on deliveries; outgoing stock cannot exceed what is on hand.
-- ---------------------------------------------------------------------------

create or replace function guard_stock_move()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_biz_product uuid;
  v_biz_branch  uuid;
  v_on_hand     bigint;
begin
  select business_id into v_biz_product from products where id = new.product_id;
  select business_id into v_biz_branch  from branches where id = new.branch_id;
  if v_biz_product is distinct from v_biz_branch then
    raise exception 'That product belongs to a different business than this branch.'
      using errcode = 'check_violation', hint = 'business_mismatch';
  end if;

  if new.unit_cost_cents is not null and new.kind <> 'delivery' then
    raise exception 'Only deliveries carry a unit cost.'
      using errcode = 'check_violation', hint = 'cost_on_non_delivery';
  end if;

  if new.kind in ('usage', 'adjust_out', 'transfer_out') then
    -- Serialise per product+branch so two tablets cannot overdraw together.
    perform pg_advisory_xact_lock(hashtext(new.product_id::text || new.branch_id::text));
    select coalesce(sum(stock_signed_qty(kind, qty)), 0) into v_on_hand
    from stock_moves
    where product_id = new.product_id and branch_id = new.branch_id;
    if v_on_hand < new.qty then
      raise exception 'Only % on hand — cannot take out %.', v_on_hand, new.qty
        using errcode = 'check_violation', hint = 'insufficient_stock';
    end if;
  end if;

  return new;
end
$$;

drop trigger if exists stock_moves_guard on stock_moves;
create trigger stock_moves_guard
  before insert on stock_moves
  for each row execute function guard_stock_move();

-- ---------------------------------------------------------------------------
-- RLS. The ledger is append-only for everyone — no update or delete
-- policies exist, so history cannot be rewritten from the API at all.
-- ---------------------------------------------------------------------------

alter table products    enable row level security;
alter table stock_moves enable row level security;

drop policy if exists products_read on products;
create policy products_read on products
  for select to authenticated using (auth_role() is not null);

drop policy if exists products_owner_write on products;
create policy products_owner_write on products
  to authenticated
  using (auth_role() = 'owner')
  with check (auth_role() = 'owner');

drop policy if exists stock_moves_read on stock_moves;
create policy stock_moves_read on stock_moves
  for select to authenticated using (can_read_branch(branch_id));

drop policy if exists stock_moves_insert on stock_moves;
create policy stock_moves_insert on stock_moves
  for insert to authenticated
  with check (can_read_branch(branch_id) and recorded_by = auth.uid());

-- ---------------------------------------------------------------------------
-- Transfers: one atomic act writes both legs. Definer, because the sender
-- records the receiving branch's leg too — branch staff cannot otherwise
-- write outside their own branch. The caller must belong to the SOURCE
-- branch; the destination just has to be a branch of the same business.
-- ---------------------------------------------------------------------------

create or replace function transfer_stock(
  p_product uuid, p_from uuid, p_to uuid, p_qty int, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_transfer uuid := gen_random_uuid();
  v_note     text := nullif(btrim(p_note), '');
begin
  if auth_role() is null then
    raise exception 'Not signed in.' using errcode = 'insufficient_privilege';
  end if;
  if not can_read_branch(p_from) then
    raise exception 'You can only send stock from your own branch.'
      using errcode = 'insufficient_privilege', hint = 'branch_forbidden';
  end if;
  if p_from = p_to then
    raise exception 'Pick two different branches.'
      using errcode = 'check_violation', hint = 'same_branch';
  end if;
  if p_qty is null or p_qty <= 0 then
    raise exception 'Quantity must be at least 1.'
      using errcode = 'check_violation', hint = 'bad_qty';
  end if;
  if (select business_id from branches where id = p_from)
     is distinct from (select business_id from branches where id = p_to) then
    raise exception 'Both branches must belong to the same business.'
      using errcode = 'check_violation', hint = 'business_mismatch';
  end if;

  insert into stock_moves (product_id, branch_id, kind, qty, note, transfer_id, recorded_by)
  values (p_product, p_from, 'transfer_out', p_qty, v_note, v_transfer, auth.uid());
  insert into stock_moves (product_id, branch_id, kind, qty, note, transfer_id, recorded_by)
  values (p_product, p_to, 'transfer_in', p_qty, v_note, v_transfer, auth.uid());

  return jsonb_build_object('transfer_id', v_transfer);
end
$$;

-- Branch staff can only SELECT their own branch row (RLS), so they could
-- never name a destination. This lists the sibling branches of a branch
-- the caller belongs to — just id/code/name, nothing sensitive.
create or replace function f_stock_destinations(p_from uuid)
returns table (id uuid, code text, name text)
language sql stable security definer set search_path = public as $$
  select b.id, b.code, b.name
  from branches b
  where can_read_branch(p_from)
    and b.business_id = (select business_id from branches where id = p_from)
    and b.id <> p_from
    and b.active
  order by b.name
$$;

-- ---------------------------------------------------------------------------
-- Views. Costing: weighted average over ALL of a product's deliveries —
-- product-level, so transfers between branches never distort it.
-- ---------------------------------------------------------------------------

create or replace view v_product_cost
with (security_invoker = on) as
select
  p.id as product_id,
  case when sum(m.qty) filter (where m.unit_cost_cents is not null) > 0
       then (sum(m.qty * m.unit_cost_cents)
               filter (where m.unit_cost_cents is not null)
             / sum(m.qty) filter (where m.unit_cost_cents is not null))::bigint
       end as avg_cost_cents
from products p
left join stock_moves m
  on m.product_id = p.id and m.kind = 'delivery'
group by p.id;

create or replace view v_stock_on_hand
with (security_invoker = on) as
select
  p.id            as product_id,
  p.business_id,
  p.name          as product_name,
  p.unit,
  p.low_stock_threshold,
  p.active,
  b.id            as branch_id,
  b.code          as branch_code,
  b.name          as branch_name,
  coalesce(sum(stock_signed_qty(m.kind, m.qty)), 0) as on_hand,
  c.avg_cost_cents,
  (coalesce(sum(stock_signed_qty(m.kind, m.qty)), 0)
     * coalesce(c.avg_cost_cents, 0))::bigint as value_cents,
  max(m.moved_on) as last_moved_on
from products p
join branches b on b.business_id = p.business_id
left join stock_moves m on m.product_id = p.id and m.branch_id = b.id
left join v_product_cost c on c.product_id = p.id
group by p.id, p.business_id, p.name, p.unit, p.low_stock_threshold, p.active,
         b.id, b.code, b.name, c.avg_cost_cents;

create or replace view v_stock_activity
with (security_invoker = on) as
select
  m.id,
  m.moved_on,
  m.created_at,
  m.kind,
  m.qty,
  stock_signed_qty(m.kind, m.qty) as signed_qty,
  m.unit_cost_cents,
  m.supplier,
  m.note,
  m.expense_id,
  m.transfer_id,
  m.recorded_by,
  m.product_id,
  p.name as product_name,
  p.unit,
  m.branch_id,
  b.code as branch_code,
  b.name as branch_name
from stock_moves m
join products p on p.id = m.product_id
join branches b on b.id = m.branch_id;

-- ---------------------------------------------------------------------------
-- Verification: everything in place, in one row.
-- ---------------------------------------------------------------------------

select
  to_regclass('products') is not null      as products_ready,
  to_regclass('stock_moves') is not null   as ledger_ready,
  to_regprocedure('transfer_stock(uuid, uuid, uuid, int, text)') is not null
                                           as transfer_ready,
  (select count(*) from pg_policies
   where tablename in ('products', 'stock_moves')) as policies,
  to_regclass('v_stock_on_hand') is not null and
  to_regclass('v_stock_activity') is not null and
  to_regclass('v_product_cost') is not null as views_ready;

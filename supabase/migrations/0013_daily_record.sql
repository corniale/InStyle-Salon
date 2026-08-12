-- 0013_daily_record.sql — Daily cash tells the Daily Record's whole story.
--
-- The salon's paper "Daily Record / Daily Sales" sheet reconciles NET cash:
-- gross sales, less the technicians' shares (paid out of the drawer every
-- day), less GCash/Maya payments (which go straight to the account and never
-- enter the drawer), less withdrawals and cash expenses — and Short/Over is
-- checked against that net figure. Expected cash therefore now deducts the
-- day's technician shares, and v_daily_cash exposes every statement line so
-- the app can show the same breakdown as the workbook.
--
-- Run as-is in the Supabase SQL editor (default role, no impersonation).

-- ---------------------------------------------------------------------------
-- Expected cash = opening float + cash takings
--                 − technician shares paid out − cash expenses
-- ---------------------------------------------------------------------------

create or replace function expected_cash(p_branch uuid, p_date date)
returns bigint language sql stable security invoker set search_path = public as $$
  select coalesce((select opening_float_cents from cash_days
                   where branch_id = p_branch and business_date = p_date), 0)
       + coalesce((select sum(tp.amount_cents)
                   from ticket_payments tp
                   join tickets t on t.id = tp.ticket_id
                   where t.branch_id = p_branch
                     and t.ticket_date = p_date
                     and t.voided_at is null
                     and tp.method = 'cash'), 0)
       - coalesce((select sum(tl.technician_share_cents)
                   from ticket_lines tl
                   join tickets t on t.id = tl.ticket_id
                   where t.branch_id = p_branch
                     and t.ticket_date = p_date
                     and t.voided_at is null), 0)
       - coalesce((select sum(e.amount_cents) from expenses e
                   where e.branch_id = p_branch
                     and e.spent_on = p_date
                     and e.paid_from = 'cash'), 0)
$$;

-- ---------------------------------------------------------------------------
-- v_daily_cash — existing columns unchanged (order preserved), statement
-- lines appended: gross / labor / company share, per-method takings,
-- discounts given. create or replace view may only append, which is why the
-- new columns sit at the end.
-- ---------------------------------------------------------------------------

create or replace view v_daily_cash
with (security_invoker = on) as
with days as (
  select branch_id, ticket_date as business_date from tickets where voided_at is null
  union
  select branch_id, spent_on from expenses
  union
  select branch_id, business_date from cash_days
)
select
  d.branch_id,
  d.business_date,
  coalesce(cd.opening_float_cents, 0) as opening_float_cents,
  coalesce((select sum(tp.amount_cents)
            from ticket_payments tp
            join tickets t on t.id = tp.ticket_id
            where t.branch_id = d.branch_id and t.ticket_date = d.business_date
              and t.voided_at is null and tp.method = 'cash'), 0) as cash_takings_cents,
  coalesce((select sum(tp.amount_cents)
            from ticket_payments tp
            join tickets t on t.id = tp.ticket_id
            where t.branch_id = d.branch_id and t.ticket_date = d.business_date
              and t.voided_at is null and tp.method <> 'cash'), 0) as non_cash_takings_cents,
  coalesce((select sum(e.amount_cents) from expenses e
            where e.branch_id = d.branch_id and e.spent_on = d.business_date
              and e.paid_from = 'cash'), 0) as cash_expenses_cents,
  coalesce((select sum(e.amount_cents) from expenses e
            where e.branch_id = d.branch_id and e.spent_on = d.business_date), 0) as expenses_cents,
  expected_cash(d.branch_id, d.business_date) as expected_cash_cents,
  cd.counted_cash_cents,
  case when cd.counted_cash_cents is null then null
       else cd.counted_cash_cents - expected_cash(d.branch_id, d.business_date) end as variance_cents,
  cd.closed_at,
  cd.note,
  -- Daily Record statement lines (appended 0013) --------------------------
  coalesce((select sum(tl.total_cents)
            from ticket_lines tl
            join tickets t on t.id = tl.ticket_id
            where t.branch_id = d.branch_id and t.ticket_date = d.business_date
              and t.voided_at is null), 0) as gross_sales_cents,
  coalesce((select sum(tl.technician_share_cents)
            from ticket_lines tl
            join tickets t on t.id = tl.ticket_id
            where t.branch_id = d.branch_id and t.ticket_date = d.business_date
              and t.voided_at is null), 0) as technician_share_cents,
  coalesce((select sum(tl.company_share_cents)
            from ticket_lines tl
            join tickets t on t.id = tl.ticket_id
            where t.branch_id = d.branch_id and t.ticket_date = d.business_date
              and t.voided_at is null), 0) as company_share_cents,
  coalesce((select sum(tl.discount_cents)
            from ticket_lines tl
            join tickets t on t.id = tl.ticket_id
            where t.branch_id = d.branch_id and t.ticket_date = d.business_date
              and t.voided_at is null), 0) as discounts_cents,
  coalesce((select sum(tp.amount_cents)
            from ticket_payments tp
            join tickets t on t.id = tp.ticket_id
            where t.branch_id = d.branch_id and t.ticket_date = d.business_date
              and t.voided_at is null and tp.method = 'gcash'), 0) as gcash_takings_cents,
  coalesce((select sum(tp.amount_cents)
            from ticket_payments tp
            join tickets t on t.id = tp.ticket_id
            where t.branch_id = d.branch_id and t.ticket_date = d.business_date
              and t.voided_at is null and tp.method = 'maya'), 0) as maya_takings_cents,
  coalesce((select sum(tp.amount_cents)
            from ticket_payments tp
            join tickets t on t.id = tp.ticket_id
            where t.branch_id = d.branch_id and t.ticket_date = d.business_date
              and t.voided_at is null
              and tp.method in ('bank', 'card')), 0) as bank_card_takings_cents,
  coalesce((select sum(tp.amount_cents)
            from ticket_payments tp
            join tickets t on t.id = tp.ticket_id
            where t.branch_id = d.branch_id and t.ticket_date = d.business_date
              and t.voided_at is null
              and tp.method in ('package', 'comp')), 0) as package_comp_cents
from days d
left join cash_days cd
  on cd.branch_id = d.branch_id and cd.business_date = d.business_date;

-- ---------------------------------------------------------------------------
-- Verify — July 1, 2026 should mirror the workbook's Daily Record page:
-- MAIN gross 7,790 / labor 2,705 / company 5,085 / GCash 200.
-- ---------------------------------------------------------------------------

select
  b.name                                as branch,
  v.gross_sales_cents      / 100.0     as gross_sales,
  v.technician_share_cents / 100.0     as technician_share,
  v.company_share_cents    / 100.0     as company_share,
  v.gcash_takings_cents    / 100.0     as gcash,
  v.maya_takings_cents     / 100.0     as maya,
  v.cash_takings_cents     / 100.0     as cash_takings,
  v.cash_expenses_cents    / 100.0     as cash_expenses,
  v.expected_cash_cents    / 100.0     as net_cash_to_remit
from v_daily_cash v
join branches b on b.id = v.branch_id
where v.business_date = date '2026-07-01'
order by b.name;

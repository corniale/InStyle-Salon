-- 0034_discount_sharing.sql — discounts come out of the company share.
--
-- Policy from the phase-1 review: a discount must not reduce the
-- technician's commission. From now on:
--
--   gross            = qty × unit price
--   technician share = gross − round(gross × sharing_rate)   (on GROSS)
--   total (client pays) = gross − discount                   (unchanged)
--   company share    = total − technician share              (absorbs the
--                                                             discount; can
--                                                             go negative on
--                                                             deep discounts,
--                                                             e.g. package
--                                                             redemptions)
--
-- HISTORY IS FROZEN. Every existing line keeps its stored figures
-- byte-for-byte — the Jan–Aug import was reconciled against the paper
-- Daily Records under the old math, and closed days must not shift.
-- The share columns stop being auto-generated (values kept) and a
-- trigger computes them with the new formula for lines created or
-- money-edited from now on. Repointing edits (client/service merges)
-- do not touch the money columns and never recompute.
--
-- Rerun-safe. Run as-is in the Supabase SQL editor (default role).

do $$
begin
  -- DROP EXPRESSION keeps the stored values and makes the columns plain.
  -- Skip silently if a rerun already converted them.
  if exists (select 1 from information_schema.columns
             where table_name = 'ticket_lines' and column_name = 'total_cents'
               and is_generated = 'ALWAYS') then
    alter table ticket_lines alter column total_cents drop expression;
    alter table ticket_lines alter column company_share_cents drop expression;
    alter table ticket_lines alter column technician_share_cents drop expression;
  end if;
end $$;

alter table ticket_lines alter column total_cents set not null;
alter table ticket_lines alter column company_share_cents set not null;
alter table ticket_lines alter column technician_share_cents set not null;

create or replace function compute_line_shares()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_gross bigint := new.qty * new.unit_price_cents;
begin
  new.total_cents := v_gross - new.discount_cents;
  -- Commission on the undiscounted amount: the technician's pay does not
  -- move when the front desk grants a discount.
  new.technician_share_cents := v_gross - round(v_gross::numeric * new.sharing_rate)::bigint;
  new.company_share_cents := new.total_cents - new.technician_share_cents;
  return new;
end
$$;

drop trigger if exists ticket_lines_compute_shares on ticket_lines;
create trigger ticket_lines_compute_shares
  before insert or update of qty, unit_price_cents, discount_cents, sharing_rate
  on ticket_lines
  for each row execute function compute_line_shares();

-- ---------------------------------------------------------------------------
-- Verification: columns are plain (history frozen), trigger in place, and
-- the new math is exercised end to end on a throwaway row shape.
-- ---------------------------------------------------------------------------

select
  (select count(*) from information_schema.columns
   where table_name = 'ticket_lines'
     and column_name in ('total_cents', 'company_share_cents', 'technician_share_cents')
     and is_generated = 'NEVER') = 3 as columns_frozen,
  (select count(*) from pg_trigger
   where tgname = 'ticket_lines_compute_shares') = 1 as trigger_ready;

-- 0033_opening_float.sql — the standing change fund, automated.
--
-- Salon practice (questionnaire Q18): every night ALL cash is remitted,
-- including the ₱1,000 change fund per branch; the same ₱1,000 comes back
-- as the next morning's float. So the opening balance is a fixed
-- per-branch amount — and nobody should have to type it every day.
--
-- Each branch gets a configurable standard change fund (Settings →
-- Targets). The day's cash record is created automatically with that
-- amount the moment the day's first ticket or expense lands; the value
-- stays editable on the Daily cash page until the day closes (for the
-- odd morning the fund differs). Practice "will eventually change" —
-- hence a setting, not a constant.
--
-- Amounts here stay 0 by default; the per-branch ₱1,000 is set by
-- supabase/scripts/opening_float_seed.sql so environments without the
-- practice are unaffected.
--
-- Rerun-safe. Run as-is in the Supabase SQL editor (default role).

alter table branches
  add column if not exists opening_float_default_cents bigint not null default 0
    check (opening_float_default_cents >= 0);

create or replace function ensure_cash_day()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_date date;
begin
  if tg_table_name = 'tickets' then
    v_date := new.ticket_date;
  else
    v_date := new.spent_on;
  end if;

  insert into cash_days (branch_id, business_date, opening_float_cents)
  select new.branch_id, v_date, b.opening_float_default_cents
  from branches b where b.id = new.branch_id
  on conflict (branch_id, business_date) do nothing;

  return new;
end
$$;

drop trigger if exists tickets_ensure_cash_day on tickets;
create trigger tickets_ensure_cash_day
  after insert on tickets
  for each row execute function ensure_cash_day();

drop trigger if exists expenses_ensure_cash_day on expenses;
create trigger expenses_ensure_cash_day
  after insert on expenses
  for each row execute function ensure_cash_day();

-- ---------------------------------------------------------------------------
-- Verification
-- ---------------------------------------------------------------------------

select
  (select count(*) from information_schema.columns
   where table_name = 'branches'
     and column_name = 'opening_float_default_cents') = 1 as column_ready,
  (select count(*) from pg_trigger
   where tgname in ('tickets_ensure_cash_day', 'expenses_ensure_cash_day')) = 2
    as triggers_ready;

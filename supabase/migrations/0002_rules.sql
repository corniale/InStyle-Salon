-- inStyle Salon — Stage 1 business rules held in the database.
-- Anything the UI could bypass lives here.

-- ---------------------------------------------------------------------------
-- Identity helpers (also used by every RLS policy in 0004)
-- ---------------------------------------------------------------------------

create or replace function auth_role()
returns text language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid() and active
$$;

create or replace function auth_branch()
returns uuid language sql stable security definer set search_path = public as $$
  select branch_id from public.profiles where id = auth.uid() and active
$$;

create or replace function can_read_branch(target uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.active
      and (p.role = 'owner' or p.branch_id = target)
  )
$$;

-- ---------------------------------------------------------------------------
-- Series numbers — assigned server-side so two offline devices cannot claim
-- the same number (offline mechanism, point 5)
-- ---------------------------------------------------------------------------

create table series_counters (
  branch_id uuid not null references branches on delete cascade,
  period    text not null,
  next_val  int  not null default 1,
  primary key (branch_id, period)
);

create or replace function assign_series_no()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_period text := to_char(new.ticket_date, 'YYYY');
  v_code   text;
  v_next   int;
begin
  if new.series_no is not null then
    return new;
  end if;

  select code into v_code from branches where id = new.branch_id;

  insert into series_counters (branch_id, period, next_val)
  values (new.branch_id, v_period, 1)
  on conflict (branch_id, period) do update
    set next_val = series_counters.next_val + 1
  returning next_val into v_next;

  new.series_no := v_code || '-' || v_period || '-' || lpad(v_next::text, 5, '0');
  return new;
end
$$;

create trigger tickets_series_no
  before insert on tickets
  for each row execute function assign_series_no();

-- ---------------------------------------------------------------------------
-- Closed cash days are closed (edge cases 12 and 20)
-- ---------------------------------------------------------------------------

create or replace function cash_day_is_closed(p_branch uuid, p_date date)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.cash_days
    where branch_id = p_branch and business_date = p_date and closed_at is not null
  )
$$;

create or replace function guard_closed_day()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_branch uuid;
  v_date   date;
  v_row    record;
begin
  if tg_op = 'DELETE' then v_row := old; else v_row := new; end if;

  if tg_table_name = 'tickets' then
    v_branch := v_row.branch_id;
    v_date   := v_row.ticket_date;
  elsif tg_table_name = 'expenses' then
    v_branch := v_row.branch_id;
    v_date   := v_row.spent_on;
  else
    select t.branch_id, t.ticket_date into v_branch, v_date
    from tickets t where t.id = v_row.ticket_id;
  end if;

  if cash_day_is_closed(v_branch, v_date) then
    raise exception 'Cash day % is closed for this branch. Reopen the day before changing its takings.', v_date
      using errcode = 'check_violation', hint = 'cash_day_closed';
  end if;

  return v_row;
end
$$;

create trigger tickets_guard_closed_day
  before insert or update or delete on tickets
  for each row execute function guard_closed_day();

create trigger ticket_lines_guard_closed_day
  before insert or update or delete on ticket_lines
  for each row execute function guard_closed_day();

create trigger ticket_payments_guard_closed_day
  before insert or update or delete on ticket_payments
  for each row execute function guard_closed_day();

create trigger expenses_guard_closed_day
  before insert or update or delete on expenses
  for each row execute function guard_closed_day();

-- ---------------------------------------------------------------------------
-- Expected cash is computed, never stored
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
       - coalesce((select sum(e.amount_cents) from expenses e
                   where e.branch_id = p_branch
                     and e.spent_on = p_date
                     and e.paid_from = 'cash'), 0)
$$;

-- A day cannot close with an unexplained variance (edge case 21).
create or replace function guard_cash_close()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_variance bigint;
begin
  if new.closed_at is not null and old.closed_at is null then
    if new.counted_cash_cents is null then
      raise exception 'Count the cash drawer before closing the day.'
        using errcode = 'check_violation', hint = 'counted_cash_required';
    end if;

    v_variance := new.counted_cash_cents - expected_cash(new.branch_id, new.business_date);

    if v_variance <> 0 and coalesce(btrim(new.note), '') = '' then
      raise exception 'Cash variance of % centavos needs a note before the day can be closed.', v_variance
        using errcode = 'check_violation', hint = 'variance_note_required';
    end if;

    new.closed_by := coalesce(new.closed_by, auth.uid());
  end if;

  return new;
end
$$;

create trigger cash_days_guard_close
  before update on cash_days
  for each row execute function guard_cash_close();

-- ---------------------------------------------------------------------------
-- Packages (edge case 10)
-- ---------------------------------------------------------------------------

create or replace function guard_package_session()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  p record;
begin
  select * into p from packages where id = new.package_id for update;

  if p.expires_on is not null and new.used_on > p.expires_on then
    raise exception 'That package expired on %.', p.expires_on
      using errcode = 'check_violation', hint = 'package_expired';
  end if;

  if p.sessions_used >= p.sessions_total then
    raise exception 'That package has no sessions left (% of % used).', p.sessions_used, p.sessions_total
      using errcode = 'check_violation', hint = 'package_exhausted';
  end if;

  update packages set sessions_used = sessions_used + 1 where id = p.id;
  return new;
end
$$;

create trigger package_sessions_guard
  before insert on package_sessions
  for each row execute function guard_package_session();

-- Releasing a redemption (a void, an edit) returns the session to the client.
create or replace function release_package_session()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update packages set sessions_used = greatest(sessions_used - 1, 0)
  where id = old.package_id;
  return old;
end
$$;

create trigger package_sessions_release
  after delete on package_sessions
  for each row execute function release_package_session();

-- ---------------------------------------------------------------------------
-- Voids (edge case 20). Tickets are never deleted; voiding is a status.
-- ---------------------------------------------------------------------------

create or replace function on_ticket_void()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.voided_at is not null and old.voided_at is null then
    new.voided_by := coalesce(new.voided_by, auth.uid());

    delete from package_sessions
    where ticket_line_id in (select id from ticket_lines where ticket_id = new.id);
  end if;
  return new;
end
$$;

create trigger tickets_on_void
  before update on tickets
  for each row execute function on_ticket_void();

-- ---------------------------------------------------------------------------
-- Audit trail — voids, price changes, sharing-rate changes, client merges
-- ---------------------------------------------------------------------------

create or replace function write_audit()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_action text;
  v_before jsonb := case when tg_op = 'INSERT' then null else to_jsonb(old) end;
  v_after  jsonb := case when tg_op = 'DELETE' then null else to_jsonb(new) end;
  v_id     uuid  := coalesce((v_after ->> 'id')::uuid, (v_before ->> 'id')::uuid);
begin
  if tg_table_name = 'tickets' then
    if new.voided_at is null or old.voided_at is not null then
      return new;
    end if;
    v_action := 'void';
  elsif tg_table_name = 'clients' then
    if new.merged_into_id is null or old.merged_into_id is not null then
      return new;
    end if;
    v_action := 'merge';
  elsif tg_table_name = 'branch_service_prices' then
    v_action := lower(tg_op);
  elsif tg_table_name = 'services' then
    if tg_op = 'UPDATE' and new.default_sharing_rate = old.default_sharing_rate then
      return new;
    end if;
    v_action := 'sharing_rate_change';
  else
    v_action := lower(tg_op);
  end if;

  insert into audit_log (actor_id, action, table_name, record_id, before, after)
  values (auth.uid(), v_action, tg_table_name, v_id, v_before, v_after);

  if tg_op = 'DELETE' then return old; else return new; end if;
end
$$;

create trigger tickets_audit after update on tickets
  for each row execute function write_audit();
create trigger clients_audit after update on clients
  for each row execute function write_audit();
create trigger prices_audit after insert or update or delete on branch_service_prices
  for each row execute function write_audit();
create trigger services_audit after update on services
  for each row execute function write_audit();
create trigger cash_days_audit after update on cash_days
  for each row execute function write_audit();

-- ---------------------------------------------------------------------------
-- Ticket validation that CHECK constraints cannot express
-- ---------------------------------------------------------------------------

create or replace function validate_ticket()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_merged uuid;
begin
  if new.ticket_date > business_date() then
    raise exception 'A ticket cannot be dated in the future (business date is %).', business_date()
      using errcode = 'check_violation', hint = 'future_ticket_date';
  end if;

  select merged_into_id into v_merged from clients where id = new.client_id;
  if v_merged is not null then
    raise exception 'That client record was merged into another. Use the surviving record.'
      using errcode = 'check_violation', hint = 'client_merged';
  end if;

  return new;
end
$$;

create trigger tickets_validate
  before insert or update on tickets
  for each row execute function validate_ticket();

-- A technician who left, or a service that was retired, stays on historical
-- tickets but cannot be picked for today's work (edge cases 15 and 16).
create or replace function validate_ticket_line()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_date   date;
  v_active boolean;
  v_name   text;
begin
  select ticket_date into v_date from tickets where id = new.ticket_id;

  if v_date >= business_date() then
    select active, name into v_active, v_name from services where id = new.service_id;
    if not v_active then
      raise exception 'Service "%" is no longer offered.', v_name
        using errcode = 'check_violation', hint = 'service_inactive';
    end if;

    select active, full_name into v_active, v_name from technicians where id = new.technician_id;
    if not v_active then
      raise exception 'Technician "%" is no longer active.', v_name
        using errcode = 'check_violation', hint = 'technician_inactive';
    end if;
  end if;

  return new;
end
$$;

create trigger ticket_lines_validate
  before insert on ticket_lines
  for each row execute function validate_ticket_line();

-- Only owner and manager may reopen a closed day, and reopening is audited.
create or replace function guard_cash_reopen()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.closed_at is not null and new.closed_at is null then
    if auth_role() not in ('owner', 'manager') then
      raise exception 'Only an owner or branch manager can reopen a closed day.'
        using errcode = 'insufficient_privilege', hint = 'reopen_forbidden';
    end if;
    new.reopened_at := now();
    new.reopened_by := auth.uid();
  end if;
  return new;
end
$$;

create trigger cash_days_guard_reopen
  before update on cash_days
  for each row execute function guard_cash_reopen();

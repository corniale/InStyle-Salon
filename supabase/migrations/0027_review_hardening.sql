-- 0027_review_hardening.sql — pre-go-live review fixes (database layer).
--
-- A senior-developer review of the full stack found gaps where financial
-- invariants lived only inside the RPC bodies while the API surface still
-- allowed raw writes around them, plus a handful of behaviours that would
-- break daily work after the first real day close. This migration:
--
--   1. expected_cash / f_payment_mix ignore OPEN (parked) tickets — the
--      drawer expectation no longer drops while tickets sit parked.
--   2. A deferred balance check makes "payments = ticket total" a database
--      invariant for every closed, non-void ticket — raw API writes can no
--      longer close a ticket unpaid or unbalance a billed one.
--   3. A closed cash day's reconciliation record (counted cash, opening
--      float, note) is immutable until the day is reopened.
--   4. Client merges work on history again: merge_clients repoints tickets
--      under a transaction-local flag the closed-day guard honours.
--      (Without this, the first closed day would break merging forever.)
--   5. The admin role is fully wired: invites keep it, day reopen and
--      birthday edits accept it — matching 0020's "manager powers, all
--      branches" contract.
--   6. revise_ticket keeps the original's new-client flag by default and
--      replays idempotently after a lost response.
--   7. save_open_ticket keeps a previously captured start time, and clears
--      stale payments before re-billing (with the delete policy to match).
--   8. A unique index backs the duplicate-service guard against races.
--
-- Rerun-safe. Run as-is in the Supabase SQL editor (default role).

-- ---------------------------------------------------------------------------
-- 1a. expected_cash: parked tickets count nowhere, including the drawer.
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
                     and t.status = 'closed'
                     and tp.method = 'cash'), 0)
       - coalesce((select sum(tl.technician_share_cents)
                   from ticket_lines tl
                   join tickets t on t.id = tl.ticket_id
                   where t.branch_id = p_branch
                     and t.ticket_date = p_date
                     and t.voided_at is null
                     and t.status = 'closed'), 0)
       - coalesce((select sum(e.amount_cents) from expenses e
                   where e.branch_id = p_branch
                     and e.spent_on = p_date
                     and e.paid_from = 'cash'), 0)
$$;

-- ---------------------------------------------------------------------------
-- 1b. f_payment_mix: same rule.
-- ---------------------------------------------------------------------------

create or replace function f_payment_mix(
  p_branch uuid default null, p_from date default null, p_to date default null)
returns table (method text, tickets bigint, amount_cents bigint, share_pct numeric)
language sql stable security invoker set search_path = public as $$
  with p as (
    select tp.method, tp.amount_cents, t.id as ticket_id
    from ticket_payments tp
    join tickets t on t.id = tp.ticket_id
                  and t.voided_at is null
                  and t.status = 'closed'
    where (p_branch is null or t.branch_id = p_branch)
      and (p_from is null or t.ticket_date >= p_from)
      and (p_to   is null or t.ticket_date <= p_to)
      and can_read_branch(t.branch_id)
  )
  select method, count(distinct ticket_id)::bigint, sum(amount_cents)::bigint,
         round(sum(amount_cents)::numeric / nullif((select sum(amount_cents) from p), 0) * 100, 1)
  from p group by method order by sum(amount_cents) desc
$$;

-- ---------------------------------------------------------------------------
-- 2. Payments must equal the ticket total for every closed, non-void
--    ticket — enforced at commit, so multi-statement RPCs stay free to
--    build the ticket in any order, while a raw API write that closes a
--    ticket unpaid (or slips an extra line/payment into a billed one)
--    fails the transaction.
-- ---------------------------------------------------------------------------

create or replace function check_ticket_balanced()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_row    record;
  v_ticket uuid;
  v_status text;
  v_voided timestamptz;
  v_total  bigint;
  v_paid   bigint;
begin
  if tg_op = 'DELETE' then v_row := old; else v_row := new; end if;
  -- Field access must stay inside the right branch: a record expression is
  -- resolved as a whole, and tickets rows have no ticket_id field.
  if tg_table_name = 'tickets' then
    v_ticket := v_row.id;
  else
    v_ticket := v_row.ticket_id;
  end if;

  select status, voided_at into v_status, v_voided from tickets where id = v_ticket;
  if not found or v_status <> 'closed' or v_voided is not null then
    return null;
  end if;

  select coalesce(sum(total_cents), 0)  into v_total from ticket_lines    where ticket_id = v_ticket;
  select coalesce(sum(amount_cents), 0) into v_paid  from ticket_payments where ticket_id = v_ticket;

  if v_total <> v_paid then
    raise exception 'Ticket payments (%) do not equal its total (%) — a billed ticket must balance.',
      v_paid, v_total
      using errcode = 'check_violation', hint = 'ticket_unbalanced';
  end if;

  return null;
end
$$;

drop trigger if exists tickets_balance_check on tickets;
create constraint trigger tickets_balance_check
  after insert or update of status, voided_at on tickets
  deferrable initially deferred
  for each row execute function check_ticket_balanced();

drop trigger if exists ticket_lines_balance_check on ticket_lines;
create constraint trigger ticket_lines_balance_check
  after insert or delete or update of qty, unit_price_cents, discount_cents, ticket_id
  on ticket_lines
  deferrable initially deferred
  for each row execute function check_ticket_balanced();

drop trigger if exists ticket_payments_balance_check on ticket_payments;
create constraint trigger ticket_payments_balance_check
  after insert or delete or update of amount_cents, ticket_id
  on ticket_payments
  deferrable initially deferred
  for each row execute function check_ticket_balanced();

-- ---------------------------------------------------------------------------
-- 3. A closed day's reconciliation record is read-only until reopened.
--    (The transitions themselves — closing, reopening — still pass.)
-- ---------------------------------------------------------------------------

create or replace function guard_closed_day_edit()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.closed_at is not null and new.closed_at is not null then
    raise exception 'Cash day % is closed. Reopen the day before changing its record.', old.business_date
      using errcode = 'check_violation', hint = 'cash_day_closed';
  end if;
  return new;
end
$$;

drop trigger if exists cash_days_guard_closed_edit on cash_days;
create trigger cash_days_guard_closed_edit
  before update on cash_days
  for each row execute function guard_closed_day_edit();

-- ---------------------------------------------------------------------------
-- 4. Reference repointing on closed days. merge_clients only changes which
--    client record a ticket points at — no money moves — but the closed-day
--    guard blocked it, which would have broken merging forever after the
--    first real day close. The guard now honours a transaction-local flag
--    that only server-side code can set (PostgREST cannot set arbitrary
--    settings), and merge_clients raises it around its repointing.
-- ---------------------------------------------------------------------------

create or replace function guard_closed_day()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_branch uuid;
  v_date   date;
  v_row    record;
begin
  if tg_op = 'DELETE' then v_row := old; else v_row := new; end if;

  -- Reference repointing (client/service merges) changes no amounts.
  if coalesce(current_setting('instyle.allow_repoint', true), '') = 'on' then
    return v_row;
  end if;

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

create or replace function merge_clients(p_loser uuid, p_winner uuid)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare
  v_moved int;
begin
  if p_loser = p_winner then
    raise exception 'Pick two different client records to merge.'
      using errcode = 'check_violation', hint = 'merge_same_client';
  end if;

  -- Repointing history is not a financial edit; let it through the
  -- closed-day guard for this transaction only.
  perform set_config('instyle.allow_repoint', 'on', true);

  update tickets set client_id = p_winner where client_id = p_loser;
  get diagnostics v_moved = row_count;

  perform set_config('instyle.allow_repoint', '', true);

  update packages set client_id = p_winner where client_id = p_loser;
  update clients set referred_by_client_id = p_winner where referred_by_client_id = p_loser;

  update clients w
     set first_visit_on = least(coalesce(w.first_visit_on, l.first_visit_on),
                                coalesce(l.first_visit_on, w.first_visit_on)),
         full_name  = coalesce(w.full_name, l.full_name),
         barangay   = coalesce(w.barangay, l.barangay),
         town       = coalesce(w.town, l.town),
         birth_month = coalesce(w.birth_month, l.birth_month),
         birth_day   = coalesce(w.birth_day, l.birth_day),
         special_discount_pct = coalesce(w.special_discount_pct, l.special_discount_pct),
         notes      = concat_ws(E'\n', nullif(w.notes, ''), nullif(l.notes, ''))
    from clients l
   where w.id = p_winner and l.id = p_loser;

  update clients set merged_into_id = p_winner where id = p_loser;

  return jsonb_build_object('tickets_moved', v_moved, 'winner', p_winner);
end
$$;

-- ---------------------------------------------------------------------------
-- 5. Admin role, fully wired.
-- ---------------------------------------------------------------------------

create or replace function handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_role      text := coalesce(new.raw_user_meta_data ->> 'role', 'front_desk');
  v_branch    uuid := nullif(new.raw_user_meta_data ->> 'branch_id', '')::uuid;
  v_name      text := coalesce(nullif(btrim(new.raw_user_meta_data ->> 'full_name'), ''),
                               split_part(new.email, '@', 1));
  v_first     boolean;
begin
  select not exists (select 1 from public.profiles) into v_first;

  if v_first then
    v_role := 'owner';
    v_branch := null;
  end if;

  if v_role not in ('owner', 'admin', 'manager', 'front_desk') then
    v_role := 'front_desk';
  end if;

  -- Owner and admin roam all branches; everyone else needs a home branch
  -- and is parked on the main branch until the owner moves them.
  if v_role in ('owner', 'admin') then
    v_branch := null;
  elsif v_branch is null then
    select id into v_branch from public.branches where code = 'MAIN';
  end if;

  insert into public.profiles (id, full_name, role, branch_id, active)
  values (new.id, v_name, v_role, v_branch, true)
  on conflict (id) do nothing;

  return new;
end
$$;

create or replace function guard_cash_reopen()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.closed_at is not null and new.closed_at is null then
    if auth_role() not in ('owner', 'admin', 'manager') then
      raise exception 'Only an owner, admin or branch manager can reopen a closed day.'
        using errcode = 'insufficient_privilege', hint = 'reopen_forbidden';
    end if;
    new.reopened_at := now();
    new.reopened_by := auth.uid();
  end if;
  return new;
end
$$;

create or replace function set_client_birthday(p_client uuid, p_month int, p_day int)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_has boolean;
begin
  if auth_role() is null then
    raise exception 'Not signed in.' using errcode = 'insufficient_privilege';
  end if;

  select birth_month is not null into v_has from clients where id = p_client;
  if v_has is null then
    raise exception 'Client not found.' using errcode = 'no_data_found';
  end if;

  if v_has and auth_role() not in ('owner', 'admin', 'manager') then
    raise exception 'Only a manager or the owner can change a recorded birthday.'
      using errcode = 'insufficient_privilege';
  end if;

  update clients set birth_month = p_month, birth_day = p_day where id = p_client;
end
$$;

-- ---------------------------------------------------------------------------
-- 6. revise_ticket: keep the original's new-client flag unless the payload
--    overrides it, and replay idempotently after a lost response.
-- ---------------------------------------------------------------------------

create or replace function revise_ticket(
  p_original uuid, p_remarks text, p_payload jsonb)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare
  v_remarks      text := nullif(btrim(p_remarks), '');
  v_new          jsonb;
  v_already_void boolean;
  v_orig_is_new  boolean;
begin
  if v_remarks is null then
    raise exception 'A revision needs remarks for the audit trail.'
      using errcode = 'check_violation', hint = 'remarks_required';
  end if;

  select voided_at is not null, is_new_client
    into v_already_void, v_orig_is_new
  from tickets where id = p_original;
  if v_already_void is null then
    raise exception 'That ticket does not exist.'
      using errcode = 'no_data_found', hint = 'ticket_missing';
  end if;

  -- The replacement inherits the original's first-visit flag: revising a
  -- first visit must not silently turn it into a returning visit.
  if nullif(p_payload ->> 'is_new_client', '') is null then
    p_payload := jsonb_set(p_payload, '{is_new_client}', to_jsonb(v_orig_is_new));
  end if;

  v_new := create_ticket(p_payload);

  if (v_new ->> 'duplicate')::boolean then
    if v_already_void then
      -- Same payload, original already voided: this exact revision went
      -- through before and the response was lost. Report success again.
      return v_new || jsonb_build_object('voided_original', p_original);
    end if;
    raise exception 'This revision was already saved.'
      using errcode = 'check_violation', hint = 'duplicate_revision';
  end if;

  if v_already_void then
    -- New payload against an already-void original: refuse (and roll back
    -- the replacement just created).
    raise exception 'That ticket is already void.'
      using errcode = 'check_violation', hint = 'already_void';
  end if;

  perform void_ticket(
    p_original,
    'Revised as TS#' || coalesce(v_new ->> 'series_no', '?') || ' — ' || v_remarks);

  return v_new || jsonb_build_object('voided_original', p_original);
end
$$;

-- ---------------------------------------------------------------------------
-- 7. save_open_ticket: never lose a captured start time; clear stale
--    payments before re-billing. Plus the delete policy that allows it.
-- ---------------------------------------------------------------------------

drop policy if exists ticket_payments_delete_open on ticket_payments;
create policy ticket_payments_delete_open on ticket_payments
  for delete to authenticated using (
    exists (select 1 from tickets t
            where t.id = ticket_id and can_read_branch(t.branch_id)
              and t.voided_at is null and t.status = 'open')
  );

create or replace function save_open_ticket(
  p_ticket uuid, p_payload jsonb, p_close boolean)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare
  v_ticket  tickets;
  v_line    jsonb;
  v_line_id uuid;
  v_n       int := 0;
  v_total   bigint := 0;
  v_paid    bigint := 0;
  v_pay     jsonb;
  v_methods text[] := '{}';
begin
  select * into v_ticket from tickets where id = p_ticket;
  if not found or v_ticket.voided_at is not null or v_ticket.status <> 'open' then
    raise exception 'That ticket is not open.'
      using errcode = 'check_violation', hint = 'not_open';
  end if;

  if jsonb_array_length(coalesce(p_payload -> 'lines', '[]'::jsonb)) = 0 then
    raise exception 'A ticket needs at least one service line.'
      using errcode = 'check_violation', hint = 'lines_required';
  end if;

  delete from ticket_lines where ticket_id = p_ticket;
  -- Stale payments (a ticket flipped back to open after billing) would
  -- otherwise double-count against the new payment set.
  delete from ticket_payments where ticket_id = p_ticket;

  for v_line in select * from jsonb_array_elements(p_payload -> 'lines')
  loop
    v_n := v_n + 1;
    insert into ticket_lines (ticket_id, service_id, technician_id, assist_technician_id,
                              qty, unit_price_cents, discount_type, discount_cents,
                              sharing_rate, rating, line_number,
                              is_upsell, started_at, ended_at)
    values (p_ticket,
            (v_line ->> 'service_id')::uuid,
            (v_line ->> 'technician_id')::uuid,
            nullif(v_line ->> 'assist_technician_id', '')::uuid,
            coalesce((v_line ->> 'qty')::int, 1),
            (v_line ->> 'unit_price_cents')::bigint,
            nullif(v_line ->> 'discount_type', ''),
            coalesce((v_line ->> 'discount_cents')::bigint, 0),
            (v_line ->> 'sharing_rate')::numeric,
            nullif(v_line ->> 'rating', '')::int,
            v_n,
            coalesce(nullif(v_line ->> 'is_upsell', '')::boolean, false),
            nullif(v_line ->> 'started_at', '')::timestamptz,
            nullif(v_line ->> 'ended_at', '')::timestamptz)
    returning id into v_line_id;

    if p_close and nullif(v_line ->> 'package_id', '') is not null then
      insert into package_sessions (package_id, ticket_line_id, used_on)
      values ((v_line ->> 'package_id')::uuid, v_line_id, v_ticket.ticket_date);
    end if;
  end loop;

  select coalesce(sum(total_cents), 0) into v_total
  from ticket_lines where ticket_id = p_ticket;

  if not p_close then
    update tickets
       set started_at = coalesce(
             nullif(p_payload ->> 'started_at', '')::timestamptz,
             (select min(nullif(x ->> 'started_at', '')::timestamptz)
              from jsonb_array_elements(p_payload -> 'lines') x),
             started_at),
           is_new_client = coalesce(nullif(p_payload ->> 'is_new_client', '')::boolean,
                                    is_new_client)
     where id = p_ticket;
    return jsonb_build_object(
      'ticket_id', p_ticket, 'series_no', v_ticket.series_no,
      'status', 'open', 'total_cents', v_total);
  end if;

  for v_pay in select * from jsonb_array_elements(
    case when jsonb_array_length(coalesce(p_payload -> 'payments', '[]'::jsonb)) = 0
         then jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', v_total))
         else p_payload -> 'payments' end)
  loop
    insert into ticket_payments (ticket_id, method, amount_cents, reference)
    values (p_ticket,
            v_pay ->> 'method',
            (v_pay ->> 'amount_cents')::bigint,
            nullif(btrim(v_pay ->> 'reference'), ''));
  end loop;

  select coalesce(sum(amount_cents), 0), coalesce(array_agg(distinct method), '{}')
    into v_paid, v_methods
  from ticket_payments where ticket_id = p_ticket;

  if v_paid <> v_total then
    raise exception 'Payments total % but the ticket totals %.', v_paid, v_total
      using errcode = 'check_violation', hint = 'payment_mismatch';
  end if;

  update tickets
     set status = 'closed',
         started_at = coalesce(
           nullif(p_payload ->> 'started_at', '')::timestamptz,
           (select min(nullif(x ->> 'started_at', '')::timestamptz)
            from jsonb_array_elements(p_payload -> 'lines') x),
           started_at),
         ended_at = coalesce(
           nullif(p_payload ->> 'ended_at', '')::timestamptz,
           (select max(nullif(x ->> 'ended_at', '')::timestamptz)
            from jsonb_array_elements(p_payload -> 'lines') x),
           ended_at),
         payment_method = case
           when array_length(v_methods, 1) > 1 then 'split'
           when v_methods[1] in ('package', 'comp', 'gift_cert') then v_methods[1]
           when v_methods[1] is null or v_methods[1] = 'cash' then 'cash'
           else 'online' end,
         is_new_client = coalesce(nullif(p_payload ->> 'is_new_client', '')::boolean,
                                  is_new_client)
   where id = p_ticket;

  return jsonb_build_object(
    'ticket_id', p_ticket, 'series_no', v_ticket.series_no,
    'status', 'closed', 'total_cents', v_total);
end
$$;

-- ---------------------------------------------------------------------------
-- 8. Unique index behind the duplicate-service guard: two simultaneous
--    "add service" calls can both pass the trigger's SELECT; the index
--    makes the second one fail instead of recreating a duplicate. (The
--    guard trigger still covers same-name-different-type within a
--    business, which a single-table index cannot express.)
-- ---------------------------------------------------------------------------

create unique index if not exists services_type_lower_name_key
  on services (service_type_id, lower(name));

-- ---------------------------------------------------------------------------
-- Verification: the new invariants in one result. balanced_violations must
-- be 0 — any rows listed are historical tickets whose payments do not match
-- their lines (none are expected).
-- ---------------------------------------------------------------------------

select
  (select count(*) from tickets t
   where t.status = 'closed' and t.voided_at is null
     and (select coalesce(sum(total_cents), 0) from ticket_lines where ticket_id = t.id)
      <> (select coalesce(sum(amount_cents), 0) from ticket_payments where ticket_id = t.id))
    as balanced_violations,
  (select count(*) from pg_trigger
   where tgname in ('tickets_balance_check', 'ticket_lines_balance_check',
                    'ticket_payments_balance_check', 'cash_days_guard_closed_edit'))
    as new_triggers,
  to_regprocedure('revise_ticket(uuid, text, jsonb)') is not null as revise_ready,
  (select count(*) from pg_indexes where indexname = 'services_type_lower_name_key') = 1
    as service_index_ready;

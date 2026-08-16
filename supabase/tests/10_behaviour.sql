-- Behavioural tests: business rules, RLS, and the anon probe.
-- Runs under ON_ERROR_STOP; any raise exception that is not caught by an
-- expected-failure block fails the suite.

\set QUIET on
set client_min_messages = warning;

-- RPC results are stashed here: psql variables are not substituted inside
-- dollar-quoted DO bodies, so \gset is useless to them.
create temp table _r (name text primary key, j jsonb);
grant all on _r to authenticated;

-- ---------------------------------------------------------------------------
-- Fixtures: three staff accounts
-- ---------------------------------------------------------------------------

insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-000000000001', 'emily@instyle.ph',  '{}'),
  ('00000000-0000-0000-0000-000000000002', 'maria@instyle.ph',
   jsonb_build_object('role', 'manager', 'full_name', 'Maria Cruz')),
  ('00000000-0000-0000-0000-000000000003', 'joy@instyle.ph',
   jsonb_build_object('role', 'front_desk', 'full_name', 'Joy Perez'));

-- First user became owner via trigger; move the manager to BRANCH.
update profiles set branch_id = (select id from branches where code = 'BRANCH')
 where id = '00000000-0000-0000-0000-000000000002';

do $$
begin
  if (select role from profiles where id = '00000000-0000-0000-0000-000000000001') <> 'owner' then
    raise exception 'bootstrap: first user should be owner';
  end if;
  if (select role from profiles where id = '00000000-0000-0000-0000-000000000003') <> 'front_desk' then
    raise exception 'bootstrap: third user should be front_desk';
  end if;
  if (select branch_id from profiles where id = '00000000-0000-0000-0000-000000000003')
     <> (select id from branches where code = 'MAIN') then
    raise exception 'bootstrap: front desk should default to MAIN';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Anon probe (§8.3): every table must be unreadable, every write must fail
-- ---------------------------------------------------------------------------

select set_config('request.jwt.claim.sub', '', false);
set role anon;

do $$
declare t text; n bigint;
begin
  for t in select tablename from pg_tables where schemaname = 'public'
  loop
    begin
      execute format('select count(*) from public.%I', t) into n;
      raise exception 'ANON LEAK: % is readable by anon (% rows)', t, n;
    exception
      when insufficient_privilege then null; -- expected: no grant at all
    end;
  end loop;

  begin
    insert into public.clients (phone, full_name) values ('09171234567', 'attacker');
    raise exception 'ANON LEAK: anon could insert into clients';
  exception when insufficient_privilege then null;
  end;
end $$;

reset role;

-- ---------------------------------------------------------------------------
-- Front desk (MAIN) creates tickets through the RPC
-- ---------------------------------------------------------------------------

set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000003', false);

do $$
declare r jsonb;
begin
  r := create_ticket(jsonb_build_object(
    'idempotency_key', 'test-key-1',
    'branch_id', (select id from public.branches where code = 'MAIN'),
    'client', jsonb_build_object('phone', '09171112222', 'full_name', 'Liza Reyes',
                                 'town', 'Goa'),
    'started_at', now() - interval '1 hour',
    'ended_at', now(),
    'lines', jsonb_build_array(
      jsonb_build_object(
        'service_id', (select id from public.services where name = 'Keratin treatment'),
        'technician_id', (select id from public.technicians where full_name = 'Ana Ramos'),
        'qty', 1, 'unit_price_cents', 390000, 'sharing_rate', 0.700, 'rating', 5),
      jsonb_build_object(
        'service_id', (select id from public.services where name = 'Manicure'),
        'technician_id', (select id from public.technicians where full_name = 'Divine Ocampo'),
        'qty', 1, 'unit_price_cents', 15000, 'sharing_rate', 0.500)),
    'payments', jsonb_build_array(
      jsonb_build_object('method', 'cash', 'amount_cents', 300000),
      jsonb_build_object('method', 'gcash', 'amount_cents', 105000))));

  if (r ->> 'duplicate')::boolean then raise exception 'first insert flagged duplicate'; end if;
  if (r ->> 'total_cents')::bigint <> 405000 then
    raise exception 'expected 405000 total, got %', r ->> 'total_cents';
  end if;
  if not (r ->> 'is_new_client')::boolean then raise exception 'client should be new'; end if;
  if (r ->> 'series_no') is null then raise exception 'series_no not assigned'; end if;

  -- The split payment is summarised on the header (edge case 19).
  if (select payment_method from public.tickets where id = (r ->> 'ticket_id')::uuid) <> 'split' then
    raise exception 'split payment not summarised as split';
  end if;

  insert into _r values ('first', r);

  -- Replay with the same key: success, duplicate = true, still one ticket
  -- (edge case 22, offline mechanism point 4).
  r := create_ticket(jsonb_build_object(
    'idempotency_key', 'test-key-1',
    'branch_id', (select id from public.branches where code = 'MAIN'),
    'client', jsonb_build_object('phone', '09171112222'),
    'lines', jsonb_build_array(jsonb_build_object(
      'service_id', (select id from public.services where name = 'Manicure'),
      'technician_id', (select id from public.technicians where full_name = 'Ana Ramos'),
      'qty', 1, 'unit_price_cents', 15000, 'sharing_rate', 0.500))));

  if not (r ->> 'duplicate')::boolean then
    raise exception 'replay was not detected as duplicate';
  end if;
  if (select count(*) from public.tickets) <> 1 then
    raise exception 'replay created a second ticket';
  end if;
end $$;

-- Generated columns: PHP 3,900 at 70% -> company 273000, technician 117000;
-- shares must sum exactly to the line total (edge case 18).
do $$
declare l record;
begin
  select * into l from public.ticket_lines where unit_price_cents = 390000;
  if l.company_share_cents <> 273000 or l.technician_share_cents <> 117000 then
    raise exception 'sharing split wrong: company %, technician %',
      l.company_share_cents, l.technician_share_cents;
  end if;
  perform 1 from public.ticket_lines
   where company_share_cents + technician_share_cents <> total_cents;
  if found then raise exception 'shares do not sum to total'; end if;
end $$;

do $$
declare r jsonb;
begin
  -- Duplicate phone resolves to the same client rather than erroring (edge 2).
  r := create_ticket(jsonb_build_object(
    'idempotency_key', 'test-key-2',
    'branch_id', (select id from public.branches where code = 'MAIN'),
    'client', jsonb_build_object('phone', '09171112222', 'full_name', 'L. Reyes'),
    'lines', jsonb_build_array(jsonb_build_object(
      'service_id', (select id from public.services where name = 'Manicure'),
      'technician_id', (select id from public.technicians where full_name = 'Divine Ocampo'),
      'qty', 1, 'unit_price_cents', 15000, 'sharing_rate', 0.500))));

  if (select count(*) from public.clients where phone = '09171112222') <> 1 then
    raise exception 'duplicate phone created a second client';
  end if;
  if (r ->> 'is_new_client')::boolean then
    raise exception 'returning client flagged as new';
  end if;
  insert into _r values ('second', r);

  -- Walk-in who declined a phone number (open question 1 resolution).
  r := create_ticket(jsonb_build_object(
    'idempotency_key', 'test-key-3',
    'branch_id', (select id from public.branches where code = 'MAIN'),
    'client', jsonb_build_object('phone_declined', true, 'full_name', 'Walk-in'),
    'lines', jsonb_build_array(jsonb_build_object(
      'service_id', (select id from public.services where name = 'Haircut - adult'),
      'technician_id', (select id from public.technicians where full_name = 'Elmer Padilla'),
      'qty', 1, 'unit_price_cents', 25000, 'sharing_rate', 0.700))));

  if (select count(*) from public.clients where phone_declined) <> 1 then
    raise exception 'declined walk-in not recorded';
  end if;
  insert into _r values ('walkin', r);

  -- Missing phone without the declined flag is refused (edge case 1).
  begin
    perform create_ticket(jsonb_build_object(
      'idempotency_key', 'test-key-4',
      'branch_id', (select id from public.branches where code = 'MAIN'),
      'client', jsonb_build_object('full_name', 'No Phone'),
      'lines', jsonb_build_array(jsonb_build_object(
        'service_id', (select id from public.services where name = 'Manicure'),
        'technician_id', (select id from public.technicians where full_name = 'Ana Ramos'),
        'qty', 1, 'unit_price_cents', 15000, 'sharing_rate', 0.500))));
    raise exception 'phoneless ticket was accepted';
  exception when check_violation then null;
  end;

  -- Discount larger than the line total is refused (edge case 8).
  begin
    perform create_ticket(jsonb_build_object(
      'idempotency_key', 'test-key-5',
      'branch_id', (select id from public.branches where code = 'MAIN'),
      'client', jsonb_build_object('phone', '09171112222'),
      'lines', jsonb_build_array(jsonb_build_object(
        'service_id', (select id from public.services where name = 'Manicure'),
        'technician_id', (select id from public.technicians where full_name = 'Ana Ramos'),
        'qty', 1, 'unit_price_cents', 15000, 'discount_cents', 20000,
        'sharing_rate', 0.500))));
    raise exception 'over-discount was accepted';
  exception when check_violation then null;
  end;

  -- Future-dated ticket is refused (edge case 37 companion).
  begin
    perform create_ticket(jsonb_build_object(
      'idempotency_key', 'test-key-6',
      'branch_id', (select id from public.branches where code = 'MAIN'),
      'ticket_date', (business_date() + 5)::text,
      'client', jsonb_build_object('phone', '09171112222'),
      'lines', jsonb_build_array(jsonb_build_object(
        'service_id', (select id from public.services where name = 'Manicure'),
        'technician_id', (select id from public.technicians where full_name = 'Ana Ramos'),
        'qty', 1, 'unit_price_cents', 15000, 'sharing_rate', 0.500))));
    raise exception 'future-dated ticket was accepted';
  exception when check_violation then null;
  end;

  -- Front desk cannot reach the other branch (edge case 35): RLS, not UI.
  begin
    perform create_ticket(jsonb_build_object(
      'idempotency_key', 'test-key-7',
      'branch_id', (select id from public.branches where code = 'BRANCH'),
      'client', jsonb_build_object('phone', '09171112222'),
      'lines', jsonb_build_array(jsonb_build_object(
        'service_id', (select id from public.services where name = 'Manicure'),
        'technician_id', (select id from public.technicians where full_name = 'Fely Baldoza'),
        'qty', 1, 'unit_price_cents', 12000, 'sharing_rate', 0.500))));
    raise exception 'front desk crossed branches';
  exception when insufficient_privilege or check_violation then null;
  end;

  -- Front desk cannot void (no UPDATE policy match).
  begin
    perform void_ticket(((select j from _r where name = 'second') ->> 'ticket_id')::uuid, 'test');
    raise exception 'front desk voided a ticket';
  exception when no_data_found or insufficient_privilege then null;
  end;

  -- Front desk cannot read the audit log.
  if (select count(*) from public.audit_log) <> 0 then
    raise exception 'front desk can read audit_log';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Branch isolation and owner reach
-- ---------------------------------------------------------------------------

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000002', false);

do $$
begin
  if (select count(*) from public.tickets) <> 0 then
    raise exception 'BRANCH manager can see MAIN tickets';
  end if;
end $$;

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', false);

do $$
begin
  if (select count(*) from public.tickets) <> 3 then
    raise exception 'owner does not see all tickets, sees %',
      (select count(*) from public.tickets);
  end if;

  -- Owner voids the walk-in; analytics must exclude it and the void is audited.
  perform void_ticket(((select j from _r where name = 'walkin') ->> 'ticket_id')::uuid,
                      'entered twice');

  if exists (select 1 from public.v_ticket_lines_active l
             join public.tickets t on t.id = l.ticket_id
             where t.voided_at is not null) then
    raise exception 'voided lines leak into v_ticket_lines_active';
  end if;
  if not exists (select 1 from public.audit_log where action = 'void') then
    raise exception 'void was not audited';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Cash day: expected computed, variance needs a note, closed day locks
-- ---------------------------------------------------------------------------

do $$
declare v_main uuid; v_expected bigint; v_res jsonb;
begin
  select id into v_main from public.branches where code = 'MAIN';

  insert into public.expenses (branch_id, spent_on, category, amount_cents, description, recorded_by)
  values (v_main, business_date(), 'supplies', 50000, 'shampoo restock', auth.uid());

  -- Cash takings today: 300000 (the split ticket's cash leg) + 15000
  -- (test-key-2, defaulted to cash). The voided walk-in's 25000 is excluded.
  -- Minus technician shares 132000 (117000 + 7500 + 7500) paid out of the
  -- drawer daily, minus the 50000 cash expense = 133000 (no float row yet).
  v_expected := expected_cash(v_main, business_date());
  if v_expected <> 133000 then
    raise exception 'expected cash wrong: %', v_expected;
  end if;

  -- Closing with a variance and no note must fail (edge case 21).
  begin
    v_res := close_cash_day(v_main, business_date(), 120000, null);
    raise exception 'variance closed without a note';
  exception when check_violation then null;
  end;

  v_res := close_cash_day(v_main, business_date(), 120000, 'PHP 130 short, change float miscount');
  if (v_res ->> 'variance_cents')::bigint <> -13000 then
    raise exception 'variance wrong: %', v_res ->> 'variance_cents';
  end if;

  -- A closed day rejects new takings (edge case 12).
  begin
    insert into public.expenses (branch_id, spent_on, category, amount_cents, recorded_by)
    values (v_main, business_date(), 'supplies', 1000, auth.uid());
    raise exception 'closed day accepted an expense';
  exception when check_violation then null;
  end;

  perform reopen_cash_day(v_main, business_date());

  insert into public.expenses (branch_id, spent_on, category, amount_cents, description, recorded_by)
  values (v_main, business_date(), 'supplies', 1000, 'after reopen', auth.uid());
end $$;

-- ---------------------------------------------------------------------------
-- Open tickets: park, edit, blocked cash close, bill (0021)
-- ---------------------------------------------------------------------------

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000003', false);

do $$
declare v_main uuid; v_res jsonb; v_ticket uuid;
begin
  select id into v_main from public.branches where code = 'MAIN';

  -- Front desk parks a ticket: TS# assigned, nothing counted yet.
  v_res := open_ticket(jsonb_build_object(
    'idempotency_key', 'test-open-1',
    'branch_id', v_main,
    'client', jsonb_build_object('phone', '09171112222'),
    'lines', jsonb_build_array(jsonb_build_object(
      'service_id', (select id from public.services where name = 'Manicure'),
      'technician_id', (select id from public.technicians where full_name = 'Ana Ramos'),
      'qty', 1, 'unit_price_cents', 15000, 'sharing_rate', 0.500))));
  v_ticket := (v_res ->> 'ticket_id')::uuid;

  if (v_res ->> 'series_no') is null then raise exception 'open ticket got no series'; end if;
  if exists (select 1 from public.v_ticket_lines_active where ticket_id = v_ticket) then
    raise exception 'open ticket leaked into analytics';
  end if;

  -- Edit while open: replace with two lines, still open.
  v_res := save_open_ticket(v_ticket, jsonb_build_object(
    'lines', jsonb_build_array(
      jsonb_build_object(
        'service_id', (select id from public.services where name = 'Manicure'),
        'technician_id', (select id from public.technicians where full_name = 'Ana Ramos'),
        'qty', 1, 'unit_price_cents', 15000, 'sharing_rate', 0.500),
      jsonb_build_object(
        'service_id', (select id from public.services where name = 'Foot spa'),
        'technician_id', (select id from public.technicians where full_name = 'Divine Ocampo'),
        'qty', 1, 'unit_price_cents', 25000, 'sharing_rate', 0.500))), false);
  if (v_res ->> 'status') <> 'open' then raise exception 'keep-open closed the ticket'; end if;

  -- The cash day refuses to close while it stays open.
  begin
    perform close_cash_day(v_main, business_date(), 0, 'try');
    raise exception 'cash day closed over an open ticket';
  exception when check_violation then null;
  end;

  -- Front desk still cannot void, even an open ticket.
  begin
    perform void_ticket(v_ticket, 'should not work');
    raise exception 'front desk voided an open ticket';
  exception when no_data_found or insufficient_privilege then null;
  end;

  -- Bill and close: payments recorded, ticket enters analytics.
  v_res := save_open_ticket(v_ticket, jsonb_build_object(
    'lines', jsonb_build_array(
      jsonb_build_object(
        'service_id', (select id from public.services where name = 'Manicure'),
        'technician_id', (select id from public.technicians where full_name = 'Ana Ramos'),
        'qty', 1, 'unit_price_cents', 15000, 'sharing_rate', 0.500),
      jsonb_build_object(
        'service_id', (select id from public.services where name = 'Foot spa'),
        'technician_id', (select id from public.technicians where full_name = 'Divine Ocampo'),
        'qty', 1, 'unit_price_cents', 25000, 'sharing_rate', 0.500)),
    'payments', jsonb_build_array(
      jsonb_build_object('method', 'cash', 'amount_cents', 40000))), true);
  if (v_res ->> 'status') <> 'closed' then raise exception 'billing did not close'; end if;
  if (select count(*) from public.v_ticket_lines_active where ticket_id = v_ticket) <> 2 then
    raise exception 'billed ticket missing from analytics';
  end if;
end $$;

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', false);

-- ---------------------------------------------------------------------------
-- Packages: exhaustion refused, void releases the session (edge case 10)
-- ---------------------------------------------------------------------------

do $$
declare v_client uuid; v_pkg uuid; v_service uuid; v_tech uuid; v_main uuid;
        v_res jsonb; v_redeem_ticket uuid;
begin
  select id into v_main from public.branches where code = 'MAIN';
  select id into v_client from public.clients where phone = '09171112222';
  select id into v_service from public.services where name = 'Foot spa';
  select id into v_tech from public.technicians where full_name = 'Divine Ocampo';

  insert into public.packages (client_id, service_id, branch_id, sessions_total,
                               purchased_on, amount_paid_cents)
  values (v_client, v_service, v_main, 1, business_date(), 150000)
  returning id into v_pkg;

  v_res := create_ticket(jsonb_build_object(
    'idempotency_key', 'test-key-8',
    'branch_id', v_main,
    'client', jsonb_build_object('id', v_client),
    'lines', jsonb_build_array(jsonb_build_object(
      'service_id', v_service, 'technician_id', v_tech,
      'qty', 1, 'unit_price_cents', 35000, 'discount_type', 'package',
      'discount_cents', 35000, 'sharing_rate', 0.550, 'package_id', v_pkg)),
    'payments', jsonb_build_array(
      jsonb_build_object('method', 'package', 'amount_cents', 0))));
  v_redeem_ticket := (v_res ->> 'ticket_id')::uuid;

  if (select sessions_used from public.packages where id = v_pkg) <> 1 then
    raise exception 'package session not consumed';
  end if;

  begin
    perform create_ticket(jsonb_build_object(
      'idempotency_key', 'test-key-9',
      'branch_id', v_main,
      'client', jsonb_build_object('id', v_client),
      'lines', jsonb_build_array(jsonb_build_object(
        'service_id', v_service, 'technician_id', v_tech,
        'qty', 1, 'unit_price_cents', 35000, 'discount_type', 'package',
        'discount_cents', 35000, 'sharing_rate', 0.550, 'package_id', v_pkg)),
      'payments', jsonb_build_array(
        jsonb_build_object('method', 'package', 'amount_cents', 0))));
    raise exception 'exhausted package accepted a redemption';
  exception when check_violation then null;
  end;

  perform void_ticket(v_redeem_ticket, 'client cancelled');
  if (select sessions_used from public.packages where id = v_pkg) <> 0 then
    raise exception 'void did not release the package session';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Client merge keeps both histories (edge case 3)
-- ---------------------------------------------------------------------------

do $$
declare v_a uuid; v_b uuid; v_res jsonb; v_main uuid;
begin
  select id into v_main from public.branches where code = 'MAIN';

  insert into public.clients (phone, full_name) values ('09330000001', 'Katrina D.')
  returning id into v_a;
  insert into public.clients (phone, full_name) values ('09330000002', 'Katrina Dizon')
  returning id into v_b;

  v_res := create_ticket(jsonb_build_object(
    'idempotency_key', 'test-key-10',
    'branch_id', v_main,
    'client', jsonb_build_object('id', v_a),
    'lines', jsonb_build_array(jsonb_build_object(
      'service_id', (select id from public.services where name = 'Manicure'),
      'technician_id', (select id from public.technicians where full_name = 'Ana Ramos'),
      'qty', 1, 'unit_price_cents', 15000, 'sharing_rate', 0.500))));

  v_res := merge_clients(v_a, v_b);

  if (select client_id from public.tickets where idempotency_key = 'test-key-10') <> v_b then
    raise exception 'merge did not move tickets';
  end if;
  if (select merged_into_id from public.clients where id = v_a) <> v_b then
    raise exception 'merge did not mark the loser';
  end if;
  if not exists (select 1 from public.audit_log where action = 'merge') then
    raise exception 'merge was not audited';
  end if;

  -- A new ticket against the merged (loser) id follows the chain to the winner.
  v_res := create_ticket(jsonb_build_object(
    'idempotency_key', 'test-key-11',
    'branch_id', v_main,
    'client', jsonb_build_object('id', v_a),
    'lines', jsonb_build_array(jsonb_build_object(
      'service_id', (select id from public.services where name = 'Manicure'),
      'technician_id', (select id from public.technicians where full_name = 'Ana Ramos'),
      'qty', 1, 'unit_price_cents', 15000, 'sharing_rate', 0.500))));

  if (v_res ->> 'client_id')::uuid <> v_b then
    raise exception 'ticket for merged client did not follow the chain';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Analytics sanity: division-by-zero paths return nulls, not errors
-- ---------------------------------------------------------------------------

do $$
declare j jsonb;
begin
  j := f_sales_summary(null, date '2030-01-01', date '2030-01-31'); -- empty range
  if (j ->> 'revenue_cents')::bigint <> 0 then
    raise exception 'empty summary should be zero';
  end if;
  if j -> 'margin_pct' <> 'null'::jsonb then
    raise exception 'margin over zero revenue should be null, got %', j -> 'margin_pct';
  end if;

  j := f_pace_vs_target(null, null);
  if j is null then raise exception 'pace query failed'; end if;

  j := f_retention_summary(null, null, null);
  if j is null then raise exception 'retention query failed'; end if;

  perform * from f_sales_by_service(null, null, null, 50);
  perform * from f_payment_mix(null, null, null);
  perform * from f_daily_series(null, null, null);
  perform * from f_monthly_series(null, 12);
  perform * from f_technician_ranking(null, null, null, 10);
  perform * from f_branch_comparison(null, null);
  perform * from f_service_branch_matrix(null, null);
  perform * from f_price_divergence();
  perform * from f_at_risk_clients(null, 50, 0);
  perform * from f_rebooking_by_service(null, 1);
  j := f_data_quality(null, null, null);
  if j is null then raise exception 'data quality query failed'; end if;
end $$;

reset role;
select 'behaviour suite passed' as result;

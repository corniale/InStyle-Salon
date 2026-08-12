-- Multi-business dimension checks (0009).

\set QUIET on
set client_min_messages = warning;

-- Setup as superuser: a second business with its own branch and catalogue.
insert into businesses (name, code, sort_order) values ('inStyle Spa', 'SPA', 2);

insert into branches (name, code, accent, business_id)
select 'Spa', 'SPA-MAIN', 'slate', id from businesses where code = 'SPA';

insert into service_types (name, sort_order, business_id)
select 'Massage', 1, id from businesses where code = 'SPA';

insert into services (service_type_id, name, default_sharing_rate, default_duration_min)
select st.id, 'Swedish massage', 0.600, 60
from service_types st join businesses bz on bz.id = st.business_id
where bz.code = 'SPA';

insert into technicians (branch_id, full_name)
select id, 'Mara Spa Tech' from branches where code = 'SPA-MAIN';

-- Owner tries to sell a spa service at a salon branch: refused.
set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', false);

do $$
begin
  begin
    perform create_ticket(jsonb_build_object(
      'idempotency_key', 'biz-key-1',
      'branch_id', (select id from public.branches where code = 'MAIN'),
      'client', jsonb_build_object('phone', '09171112222'),
      'lines', jsonb_build_array(jsonb_build_object(
        'service_id', (select id from public.services where name = 'Swedish massage'),
        'technician_id', (select id from public.technicians where full_name = 'Ana Ramos'),
        'qty', 1, 'unit_price_cents', 50000, 'sharing_rate', 0.600))));
    raise exception 'spa service sold at salon branch';
  exception when check_violation then null;
  end;

  -- Same service at the spa branch: accepted.
  perform create_ticket(jsonb_build_object(
    'idempotency_key', 'biz-key-2',
    'branch_id', (select id from public.branches where code = 'SPA-MAIN'),
    'client', jsonb_build_object('phone', '09171112222'),
    'lines', jsonb_build_array(jsonb_build_object(
      'service_id', (select id from public.services where name = 'Swedish massage'),
      'technician_id', (select id from public.technicians where full_name = 'Mara Spa Tech'),
      'qty', 1, 'unit_price_cents', 50000, 'sharing_rate', 0.600))));

  -- Comparison scoped to the salon must not include the spa branch.
  if exists (
    select 1 from f_branch_comparison(
      (select id from public.businesses where code = 'SALON'), null, null)
    where branch_code = 'SPA-MAIN'
  ) then
    raise exception 'salon comparison leaked a spa branch';
  end if;

  -- Unscoped comparison sees both businesses' branches (owner reads all).
  if (select count(*) from f_branch_comparison(null, null, null)) < 3 then
    raise exception 'unscoped comparison missing branches';
  end if;

  -- The spine view carries the business.
  if exists (select 1 from public.v_ticket_lines_active where business_code is null) then
    raise exception 'business_code missing on active lines';
  end if;
end $$;

reset role;
select 'business suite passed' as result;

-- Multi-business dimension. The owner runs a salon, a barbershop, a brow &
-- lash studio, and a spa: same operating shape (services, technicians,
-- commission splits, walk-ins, daily cash), different catalogues.
--
-- One database, one client identity across every business — that is the
-- asset separate apps could never have. Comparisons stay WITHIN a business:
-- a spa vs a barbershop ranking is noise, so the comparison functions grow
-- a business scope and the catalogue joins are pinned to it.
--
-- Applied while only the salon exists, so everything backfills to it and
-- the January-July import lands already scoped.

-- ---------------------------------------------------------------------------
-- The businesses table, seeded with the salon
-- ---------------------------------------------------------------------------

create table businesses (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  code       text not null unique,
  sort_order int not null default 0,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

insert into businesses (name, code, sort_order) values ('inStyle Salon', 'SALON', 1);

alter table businesses enable row level security;

create policy businesses_read on businesses
  for select to authenticated using (auth_role() is not null);

create policy businesses_owner_write on businesses
  for all to authenticated
  using (auth_role() = 'owner') with check (auth_role() = 'owner');

-- ---------------------------------------------------------------------------
-- Scope branches and the catalogue to a business
-- ---------------------------------------------------------------------------

alter table branches add column business_id uuid references businesses on delete restrict;
update branches set business_id = (select id from businesses where code = 'SALON');
alter table branches alter column business_id set not null;

alter table service_types add column business_id uuid references businesses on delete restrict;
update service_types set business_id = (select id from businesses where code = 'SALON');
alter table service_types alter column business_id set not null;

-- "Hair" can exist per business; it was globally unique before.
alter table service_types drop constraint service_types_name_key;
alter table service_types add constraint service_types_business_name_key
  unique (business_id, name);

create index branches_business_idx on branches (business_id);
create index service_types_business_idx on service_types (business_id);

-- ---------------------------------------------------------------------------
-- Cross-business guard: a ticket line's service must belong to the same
-- business as the branch the work happened at. Technicians already inherit
-- a branch (and so a business); services inherit via their service type.
-- ---------------------------------------------------------------------------

create or replace function validate_ticket_line()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_date     date;
  v_branch_business uuid;
  v_service_business uuid;
  v_active boolean;
  v_name   text;
begin
  select t.ticket_date, b.business_id into v_date, v_branch_business
  from tickets t join branches b on b.id = t.branch_id
  where t.id = new.ticket_id;

  select st.business_id into v_service_business
  from services s join service_types st on st.id = s.service_type_id
  where s.id = new.service_id;

  if v_service_business is distinct from v_branch_business then
    raise exception 'That service belongs to a different business than this branch.'
      using errcode = 'check_violation', hint = 'business_mismatch';
  end if;

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

-- ---------------------------------------------------------------------------
-- The spine view carries the business, so every consumer can scope by it
-- (columns appended; existing consumers are unaffected)
-- ---------------------------------------------------------------------------

create or replace view v_ticket_lines_active
with (security_invoker = on) as
select
  tl.id                    as line_id,
  tl.ticket_id,
  t.branch_id,
  b.code                   as branch_code,
  b.name                   as branch_name,
  t.ticket_date,
  date_trunc('month', t.ticket_date)::date as month,
  t.client_id,
  t.is_new_client,
  t.payment_method,
  t.started_at,
  t.ended_at,
  tl.service_id,
  s.name                   as service_name,
  s.service_type_id,
  st.name                  as service_type_name,
  s.default_sharing_rate,
  s.default_duration_min,
  tl.technician_id,
  tech.full_name           as technician_name,
  tl.assist_technician_id,
  tl.qty,
  tl.unit_price_cents,
  tl.discount_type,
  tl.discount_cents,
  tl.sharing_rate,
  tl.rating,
  tl.total_cents,
  tl.company_share_cents,
  tl.technician_share_cents,
  coalesce(
    nullif(extract(epoch from (t.ended_at - t.started_at)) / 60, 0)
      / nullif(count(*) over (partition by tl.ticket_id), 0),
    s.default_duration_min * tl.qty
  )::numeric(10,2) as attributed_minutes,
  b.business_id,
  biz.code                 as business_code
from ticket_lines tl
join tickets t       on t.id = tl.ticket_id and t.voided_at is null
join branches b      on b.id = t.branch_id
join businesses biz  on biz.id = b.business_id
join services s      on s.id = tl.service_id
join service_types st on st.id = s.service_type_id
join technicians tech on tech.id = tl.technician_id;

-- ---------------------------------------------------------------------------
-- Comparison functions become business-scoped. Old signatures are dropped
-- (not overloaded) so PostgREST rpc resolution stays unambiguous.
-- ---------------------------------------------------------------------------

drop function if exists f_branch_comparison(date, date);

create or replace function f_branch_comparison(
  p_business uuid default null, p_from date default null, p_to date default null)
returns table (
  branch_id uuid, branch_code text, branch_name text, accent text,
  revenue_cents bigint, company_share_cents bigint, margin_pct numeric,
  tickets bigint, treatments bigint, clients bigint, new_clients bigint,
  avg_ticket_cents numeric, discount_pct numeric, avg_rating numeric,
  monthly_target_cents bigint)
language sql stable security invoker set search_path = public as $$
  with l as (
    select * from v_ticket_lines_active
    where (p_from is null or ticket_date >= p_from)
      and (p_to   is null or ticket_date <= p_to)
      and (p_business is null or business_id = p_business)
  ),
  t as (
    select branch_id, ticket_id, client_id, is_new_client, sum(total_cents) as ticket_total
    from l group by branch_id, ticket_id, client_id, is_new_client
  )
  select b.id, b.code, b.name, b.accent,
         coalesce(sum(l.total_cents), 0)::bigint,
         coalesce(sum(l.company_share_cents), 0)::bigint,
         round(sum(l.company_share_cents)::numeric / nullif(sum(l.total_cents), 0) * 100, 1),
         (select count(*) from t where t.branch_id = b.id)::bigint,
         coalesce(sum(l.qty), 0)::bigint,
         (select count(distinct client_id) from t where t.branch_id = b.id)::bigint,
         (select count(*) from t where t.branch_id = b.id and t.is_new_client)::bigint,
         (select round(avg(ticket_total)) from t where t.branch_id = b.id),
         round(sum(l.discount_cents)::numeric / nullif(sum(l.qty * l.unit_price_cents), 0) * 100, 1),
         round(avg(l.rating) filter (where l.rating is not null), 2),
         b.monthly_target_cents
  from branches b
  left join l on l.branch_id = b.id
  where b.active and can_read_branch(b.id)
    and (p_business is null or b.business_id = p_business)
  group by b.id, b.code, b.name, b.accent, b.monthly_target_cents
  order by b.code
$$;

drop function if exists f_service_branch_matrix(date, date);

create or replace function f_service_branch_matrix(
  p_business uuid default null, p_from date default null, p_to date default null)
returns table (
  service_id uuid, service_name text, service_type_name text,
  branch_id uuid, branch_code text, offered boolean,
  units bigint, revenue_cents bigint, company_share_cents bigint,
  margin_pct numeric, list_price_cents bigint)
language sql stable security invoker set search_path = public as $$
  with pairs as (
    select s.id as service_id, s.name as service_name, st.name as service_type_name,
           b.id as branch_id, b.code as branch_code
    from services s
    join service_types st on st.id = s.service_type_id
    -- Catalogue pinned to the business: a spa service never pairs with a
    -- barbershop branch.
    join branches b on b.business_id = st.business_id
    where s.active and b.active and can_read_branch(b.id)
      and (p_business is null or st.business_id = p_business)
  ),
  price as (
    select p.service_id, p.branch_id,
           (price_on(p.branch_id, p.service_id, coalesce(p_to, business_date()))).price_cents
    from pairs p
  ),
  agg as (
    select service_id, branch_id, sum(qty) as units, sum(total_cents) as revenue,
           sum(company_share_cents) as share
    from v_ticket_lines_active
    where (p_from is null or ticket_date >= p_from)
      and (p_to   is null or ticket_date <= p_to)
    group by service_id, branch_id
  )
  select p.service_id, p.service_name, p.service_type_name, p.branch_id, p.branch_code,
         price.price_cents is not null,
         agg.units::bigint, agg.revenue::bigint, agg.share::bigint,
         round(agg.share::numeric / nullif(agg.revenue, 0) * 100, 1),
         price.price_cents
  from pairs p
  left join price on price.service_id = p.service_id and price.branch_id = p.branch_id
  left join agg on agg.service_id = p.service_id and agg.branch_id = p.branch_id
  order by p.service_type_name, p.service_name, p.branch_code
$$;

drop function if exists f_price_divergence();

create or replace function f_price_divergence(p_business uuid default null)
returns table (service_id uuid, service_name text, branches int,
               min_price_cents bigint, max_price_cents bigint, spread_pct numeric)
language sql stable security invoker set search_path = public as $$
  with current_prices as (
    select b.id as branch_id, s.id as service_id, s.name as service_name,
           (price_on(b.id, s.id, business_date())).price_cents as price_cents
    from services s
    join service_types st on st.id = s.service_type_id
    join branches b on b.business_id = st.business_id
    where s.active and b.active and can_read_branch(b.id)
      and (p_business is null or st.business_id = p_business)
  )
  select service_id, service_name, count(*)::int,
         min(price_cents), max(price_cents),
         round((max(price_cents) - min(price_cents))::numeric
               / nullif(min(price_cents), 0) * 100, 1)
  from current_prices
  where price_cents is not null
  group by service_id, service_name
  having min(price_cents) <> max(price_cents)
  order by (max(price_cents) - min(price_cents))::numeric / nullif(min(price_cents), 0) desc
$$;

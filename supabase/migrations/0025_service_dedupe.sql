-- 0025_service_dedupe.sql — merge duplicate services and prevent new ones.
--
-- The workbooks filed the same service under different TYPE columns in
-- different months (FOOT SPA under Nail & Foot, Others, even Hair), and
-- the import faithfully created one service row per (type, name) pair.
-- This migration merges each duplicate group into one keeper — the
-- variant with the most recorded treatments, i.e. the type the salon
-- actually used most — and repoints every ticket line, package and price
-- row before deleting the rest. Money is untouched: lines keep their
-- prices, rates and shares; only which catalogue row they point at
-- changes, so service and type analytics stop double-counting.
--
-- If a keeper's type still looks wrong afterwards, fix it in one click:
-- Settings -> Services and prices -> click the service name -> Type.
--
-- A trigger then refuses any future service whose name already exists
-- in the same business under any type.
--
-- Run as-is in the Supabase SQL editor (default role, no impersonation).

drop table if exists _svc_groups;
create temp table _svc_groups as
with svc as (
  select s.id, s.name, s.service_type_id, s.active,
         st.business_id, st.name as type_name,
         coalesce((select sum(l.qty) from ticket_lines l
                   where l.service_id = s.id), 0) as treatments,
         (select max(t.ticket_date)
          from ticket_lines l join tickets t on t.id = l.ticket_id
          where l.service_id = s.id) as last_used
  from services s
  join service_types st on st.id = s.service_type_id
)
select *,
       first_value(id) over (
         partition by business_id, lower(name)
         order by treatments desc, last_used desc nulls last, id) as keeper_id,
       count(*) over (partition by business_id, lower(name)) as n
from svc;

delete from _svc_groups where n < 2;

-- The report, captured before anything moves.
drop table if exists _svc_report;
create temp table _svc_report as
select max(g.name)      filter (where g.id = g.keeper_id) as name,
       max(g.type_name) filter (where g.id = g.keeper_id) as kept_type,
       string_agg(distinct g.type_name, ', ')
         filter (where g.id <> g.keeper_id)               as merged_from_types,
       coalesce(sum(g.treatments) filter (where g.id <> g.keeper_id), 0)
                                                          as treatments_moved
from _svc_groups g
group by g.business_id, lower(g.name);

-- Repoint history and references.
update ticket_lines l set service_id = g.keeper_id
from _svc_groups g
where l.service_id = g.id and g.id <> g.keeper_id;

update packages p set service_id = g.keeper_id
from _svc_groups g
where p.service_id = g.id and g.id <> g.keeper_id;

-- Price rule: the keeper's price list wins outright. A duplicate's price
-- history is carried over only for a branch where the keeper has no price
-- at all (otherwise the service would turn "not offered" there). Every
-- conflicting price that gets dropped is captured for the report first —
-- past tickets are untouched either way, since each line stores the price
-- it was actually sold at.
drop table if exists _price_report;
create temp table _price_report as
select g.name,
       b.code as branch_code,
       (select k.price_cents from branch_service_prices k
        where k.service_id = g.keeper_id and k.branch_id = dp.branch_id
        order by k.effective_from desc limit 1) as kept_cents,
       dp.price_cents as dropped_cents
from _svc_groups g
join branch_service_prices dp on dp.service_id = g.id
join branches b on b.id = dp.branch_id
where g.id <> g.keeper_id
  and dp.effective_from = (select max(p2.effective_from)
                           from branch_service_prices p2
                           where p2.service_id = g.id and p2.branch_id = dp.branch_id)
  and exists (select 1 from branch_service_prices k
              where k.service_id = g.keeper_id and k.branch_id = dp.branch_id);

insert into branch_service_prices (branch_id, service_id, price_cents, sharing_rate, effective_from)
select p.branch_id, g.keeper_id, p.price_cents, p.sharing_rate, p.effective_from
from branch_service_prices p
join _svc_groups g on g.id = p.service_id and g.id <> g.keeper_id
where not exists (
  select 1 from branch_service_prices k
  where k.service_id = g.keeper_id
    and k.branch_id = p.branch_id)
on conflict (branch_id, service_id, effective_from) do nothing;

delete from branch_service_prices p
using _svc_groups g
where p.service_id = g.id and g.id <> g.keeper_id;

-- A keeper stays sellable if any of its variants was active.
update services s set active = true
from _svc_groups g
where s.id = g.keeper_id and not s.active
  and exists (select 1 from _svc_groups d
              where d.keeper_id = g.keeper_id and d.active);

delete from services s
using _svc_groups g
where s.id = g.id and g.id <> g.keeper_id;

-- ---------------------------------------------------------------------------
-- Never again: one service name per business, whatever the type.
-- ---------------------------------------------------------------------------

create or replace function guard_duplicate_service()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_business uuid;
  v_type     text;
begin
  select business_id into v_business from service_types where id = new.service_type_id;
  select st.name into v_type
  from services s
  join service_types st on st.id = s.service_type_id
  where lower(s.name) = lower(new.name)
    and s.id <> new.id
    and st.business_id = v_business
  limit 1;
  if v_type is not null then
    raise exception 'A service named "%" already exists in this business under type "%". Edit that one instead of creating a duplicate.',
      new.name, v_type
      using errcode = 'unique_violation', hint = 'duplicate_service_name';
  end if;
  return new;
end
$$;

drop trigger if exists services_no_duplicate_names on services;
create trigger services_no_duplicate_names
  before insert or update of name, service_type_id on services
  for each row execute function guard_duplicate_service();

-- Verify: what was merged, dropped price conflicts to review, and that no
-- duplicates remain.
select r.name, r.kept_type, r.merged_from_types, r.treatments_moved,
       (select string_agg(distinct
                 pr.branch_code || ': kept ' || round(pr.kept_cents / 100.0, 2)
                 || ', dropped ' || round(pr.dropped_cents / 100.0, 2), ' · ')
        from _price_report pr
        where lower(pr.name) = lower(r.name)
          and pr.dropped_cents <> pr.kept_cents) as price_conflicts,
       (select count(*) from (
          select 1
          from services s join service_types st on st.id = s.service_type_id
          group by st.business_id, lower(s.name)
          having count(*) > 1) d) as remaining_duplicate_groups
from _svc_report r
order by r.treatments_moved desc nulls last;

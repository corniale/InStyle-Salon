-- 0026_service_manual_merges.sql — owner-directed service merges on top
-- of the 0025 dedupe (run 0025 first):
--
--   MANICURE CLEANING -> MANICURE (CLEANING), type Nail & Foot
--   PEDICURE CLEANING -> PEDICURE (CLEANING), type Nail & Foot
--   FOOTSCRUB         -> type Nail & Foot
--
-- Same merge rules as 0025: history repoints to the keeper, the keeper's
-- price list wins (a loser's prices carry over only for a branch where
-- the keeper has none), past tickets keep the prices they were sold at.
--
-- Run as-is in the Supabase SQL editor (default role, no impersonation).

do $$
declare
  pairs   text[] := array['MANICURE (CLEANING)|MANICURE CLEANING',
                          'PEDICURE (CLEANING)|PEDICURE CLEANING'];
  pair    text;
  keep_nm text;
  lose_nm text;
  r       record;
  v_keeper uuid;
  v_loser  uuid;
  v_type   uuid;
begin
  foreach pair in array pairs loop
    keep_nm := split_part(pair, '|', 1);
    lose_nm := split_part(pair, '|', 2);

    for r in
      select distinct st.business_id
      from services s join service_types st on st.id = s.service_type_id
      where lower(s.name) in (lower(keep_nm), lower(lose_nm))
    loop
      select s.id into v_keeper
      from services s join service_types st on st.id = s.service_type_id
      where st.business_id = r.business_id and lower(s.name) = lower(keep_nm)
      limit 1;
      select s.id into v_loser
      from services s join service_types st on st.id = s.service_type_id
      where st.business_id = r.business_id and lower(s.name) = lower(lose_nm)
      limit 1;

      -- Only the losing name exists: it becomes the keeper by renaming.
      if v_keeper is null and v_loser is not null then
        update services set name = keep_nm where id = v_loser;
        v_keeper := v_loser;
        v_loser := null;
      end if;

      if v_keeper is not null and v_loser is not null and v_keeper <> v_loser then
        update ticket_lines set service_id = v_keeper where service_id = v_loser;
        update packages set service_id = v_keeper where service_id = v_loser;

        insert into branch_service_prices (branch_id, service_id, price_cents, sharing_rate, effective_from)
        select bp.branch_id, v_keeper, bp.price_cents, bp.sharing_rate, bp.effective_from
        from branch_service_prices bp
        where bp.service_id = v_loser
          and not exists (select 1 from branch_service_prices k
                          where k.service_id = v_keeper and k.branch_id = bp.branch_id)
        on conflict (branch_id, service_id, effective_from) do nothing;
        delete from branch_service_prices where service_id = v_loser;

        update services k
           set active = k.active or coalesce(
                 (select l.active from services l where l.id = v_loser), false)
         where k.id = v_keeper;

        delete from services where id = v_loser;
      end if;

      if v_keeper is not null then
        select id into v_type from service_types
        where business_id = r.business_id and lower(name) = 'nail & foot'
        limit 1;
        if v_type is not null then
          update services set service_type_id = v_type
          where id = v_keeper and service_type_id <> v_type;
        end if;
      end if;

      v_keeper := null;
      v_loser := null;
      v_type := null;
    end loop;
  end loop;

  -- FOOTSCRUB belongs under Nail & Foot.
  for r in
    select s.id, st.business_id
    from services s join service_types st on st.id = s.service_type_id
    where lower(s.name) = 'footscrub'
  loop
    select id into v_type from service_types
    where business_id = r.business_id and lower(name) = 'nail & foot'
    limit 1;
    if v_type is not null then
      update services set service_type_id = v_type
      where id = r.id and service_type_id <> v_type;
    end if;
    v_type := null;
  end loop;
end $$;

-- Verify: the three services, their final type, history and current prices.
select s.name, st.name as type, s.active,
       coalesce((select sum(l.qty) from ticket_lines l where l.service_id = s.id), 0) as treatments,
       (select string_agg(b.code || ' ' || round(p.price_cents / 100.0, 2), ' · '
                          order by b.code)
        from branch_service_prices p
        join branches b on b.id = p.branch_id
        where p.service_id = s.id
          and p.effective_from = (select max(p2.effective_from)
                                  from branch_service_prices p2
                                  where p2.service_id = s.id
                                    and p2.branch_id = p.branch_id)) as current_prices
from services s
join service_types st on st.id = s.service_type_id
where lower(s.name) in ('manicure (cleaning)', 'pedicure (cleaning)', 'footscrub')
   or lower(s.name) in ('manicure cleaning', 'pedicure cleaning')
order by s.name;

-- service_durations_seed.sql — set standard durations from the salon's
-- 2026 Features & Benefits guide (InStyle page; a few sourced from the
-- sister businesses' guides where the operation is identical and marked
-- 'inferred' below). Ranges become the midpoint rounded to 5 minutes;
-- durations are TOTAL client-in-chair time including chemical processing.
--
-- Costing prefers the median of actually-timed treatments and uses this
-- only as fallback; the booking module will plan slots from it.
--
-- Safe to rerun. The final SELECT lists every active salon service with
-- where its duration came from — 'review' rows kept the old 45-minute
-- default and need a human number. Run as-is in the Supabase SQL editor.

update services s
set default_duration_min = v.mins
from (values
  -- From the InStyle guide (midpoint of the stated range)
  ('HC',                          40),  -- Haircut & Style 30-45
  ('HAIR COLOR/HILITES',          75),  -- 1-1.5 hr (incl. 30-45 processing)
  ('HAIRSPA/KERATIN MASK',        40),  -- 30-45
  ('REBOND',                     195),  -- 3-3.5 hr (incl. ~1 hr processing)
  ('BRAZILIAN BOTOX',             75),  -- 1-1.5 hr (incl. ~1 hr processing)
  ('KERATIN STRAIGHT/KOS',       105),  -- 1.5-2 hr (incl. ~1 hr processing)
  ('BALAYAGE+H.TRTMNT (BHT)',    150),  -- 2-3 hr
  ('MANICURE',                    25),  -- 15-30
  ('PEDICURE',                    40),  -- 30-45
  ('MANI. GEL',                   75),  -- Mani/Pedi Gel 1-1.5 hr
  ('PEDI. GEL',                   75),
  ('FOOTSCRUB',                   25),  -- 20-30
  ('FOOTSPA',                     55),  -- 45-60
  ('MAKE UP',                     55),  -- 45-60
  ('HAIR AND MAKE UP',           105),  -- 1.5-2 hr
  ('NAIL ART',                    45),  -- add-on 30-60
  -- Inferred from the sister businesses' guides (same operation)
  ('MANICURE (CLEANING)',         30),
  ('PEDICURE (CLEANING)',         30),
  ('FOOTSCRUB W/ PEDI.',          60),
  ('FOOTSPA W/ MANI. PEDI.',     120),
  ('SHAMPOO W/ BLOW DRY',         25),
  ('SBS - SHAMPOO+BLOWER STYLE',  30),
  ('GEL REMOVAL',                 30),
  ('SHAVE',                       20),
  ('BROW SHAVE W/ PENCIL',        10)
) as v(name, mins),
service_types st, businesses biz
where st.id = s.service_type_id
  and biz.id = st.business_id
  and biz.code = 'SALON'
  and s.name = v.name;

-- Every active salon service, with the source of its duration.
select st.name as type, s.name, s.default_duration_min,
       case
         when s.name in (
           'HC','HAIR COLOR/HILITES','HAIRSPA/KERATIN MASK','REBOND',
           'BRAZILIAN BOTOX','KERATIN STRAIGHT/KOS','BALAYAGE+H.TRTMNT (BHT)',
           'MANICURE','PEDICURE','MANI. GEL','PEDI. GEL','FOOTSCRUB',
           'FOOTSPA','MAKE UP','HAIR AND MAKE UP','NAIL ART')
           then 'guide'
         when s.name in (
           'MANICURE (CLEANING)','PEDICURE (CLEANING)','FOOTSCRUB W/ PEDI.',
           'FOOTSPA W/ MANI. PEDI.','SHAMPOO W/ BLOW DRY',
           'SBS - SHAMPOO+BLOWER STYLE','GEL REMOVAL','SHAVE',
           'BROW SHAVE W/ PENCIL')
           then 'inferred'
         else 'review'
       end as source
from services s
join service_types st on st.id = s.service_type_id
join businesses biz on biz.id = st.business_id and biz.code = 'SALON'
where s.active
order by 4 desc, st.name, s.name;

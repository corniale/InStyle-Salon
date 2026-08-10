-- inStyle Salon — catalogue seed.
-- Idempotent: running it twice changes nothing (edge case 36).

insert into branches (name, code, accent, monthly_target_cents) values
  ('Main',   'MAIN',   'slate', 45000000),
  ('Branch', 'BRANCH', 'plum',  30000000)
on conflict (code) do nothing;

insert into service_types (name, sort_order) values
  ('Hair', 1), ('Nail & Foot', 2), ('Treatment', 3)
on conflict (name) do nothing;

-- name, type, company sharing rate, duration, main price, branch price.
-- A null branch price means the service is not offered there, which the
-- comparison reports as "not offered" rather than zero (edge case 28).
with catalogue (name, type_name, rate, duration, main_price, branch_price) as (
  values
    ('Haircut - adult',            'Hair',        0.700,  45,  25000,  20000),
    ('Haircut - kids',             'Hair',        0.700,  30,  18000,  15000),
    ('Shampoo with blow dry',      'Hair',        0.700,  45,  30000,  20000),
    ('Hair color - full',          'Hair',        0.700, 120, 150000, 130000),
    ('Hair color - retouch',       'Hair',        0.700,  90,  90000,  80000),
    ('Highlights',                 'Hair',        0.700, 150, 250000, 220000),
    ('Rebond',                     'Hair',        0.700, 240, 280000, 300000),
    ('Keratin treatment',          'Hair',        0.700, 210, 390000, 350000),
    ('Brazilian blowout',          'Hair',        0.700, 180, 350000,   null),
    ('Perm',                       'Hair',        0.700, 180, 220000, 200000),
    ('Cellophane',                 'Hair',        0.700,  60,  60000,  55000),
    ('Manicure',                   'Nail & Foot', 0.500,  40,  15000,  12000),
    ('Pedicure',                   'Nail & Foot', 0.500,  50,  18000,  15000),
    ('Gel polish - hands',         'Nail & Foot', 0.580,  60,  45000,  40000),
    ('Gel polish - feet',          'Nail & Foot', 0.580,  60,  50000,  45000),
    ('Nail art - per nail',        'Nail & Foot', 0.500,  15,   5000,   5000),
    ('Foot spa',                   'Nail & Foot', 0.550,  60,  35000,  30000),
    ('Callus removal',             'Nail & Foot', 0.500,  40,  25000,  20000),
    ('Hair spa',                   'Treatment',   0.600,  60,  60000,  50000),
    ('Hot oil',                    'Treatment',   0.600,  45,  35000,  30000),
    ('Scalp treatment',            'Treatment',   0.600,  60,  70000,  60000),
    ('Deep conditioning',          'Treatment',   0.600,  45,  45000,  40000)
)
insert into services (service_type_id, name, default_sharing_rate, default_duration_min)
select st.id, c.name, c.rate, c.duration
from catalogue c join service_types st on st.name = c.type_name
on conflict (service_type_id, name) do nothing;

-- Opening price list, effective from the start of the imported history.
with catalogue (name, main_price, branch_price) as (
  values
    ('Haircut - adult',        25000,  20000),
    ('Haircut - kids',         18000,  15000),
    ('Shampoo with blow dry',  30000,  20000),
    ('Hair color - full',     150000, 130000),
    ('Hair color - retouch',   90000,  80000),
    ('Highlights',            250000, 220000),
    ('Rebond',                280000, 300000),
    ('Keratin treatment',     390000, 350000),
    ('Brazilian blowout',     350000,   null),
    ('Perm',                  220000, 200000),
    ('Cellophane',             60000,  55000),
    ('Manicure',               15000,  12000),
    ('Pedicure',               18000,  15000),
    ('Gel polish - hands',     45000,  40000),
    ('Gel polish - feet',      50000,  45000),
    ('Nail art - per nail',     5000,   5000),
    ('Foot spa',               35000,  30000),
    ('Callus removal',         25000,  20000),
    ('Hair spa',               60000,  50000),
    ('Hot oil',                35000,  30000),
    ('Scalp treatment',        70000,  60000),
    ('Deep conditioning',      45000,  40000)
),
rows as (
  select b.id as branch_id, s.id as service_id,
         case when b.code = 'MAIN' then c.main_price else c.branch_price end as price_cents
  from catalogue c
  join services s on s.name = c.name
  cross join branches b
)
insert into branch_service_prices (branch_id, service_id, price_cents, effective_from)
select branch_id, service_id, price_cents, date '2026-01-01'
from rows where price_cents is not null
on conflict (branch_id, service_id, effective_from) do nothing;

insert into technicians (branch_id, full_name, hired_on)
select b.id, t.full_name, t.hired_on
from (values
  ('MAIN',   'Ana Ramos',        date '2019-03-04'),
  ('MAIN',   'Bea Salvador',     date '2021-06-14'),
  ('MAIN',   'Cristy Delos Reyes',date '2018-01-22'),
  ('MAIN',   'Divine Ocampo',    date '2023-02-06'),
  ('MAIN',   'Elmer Padilla',    date '2020-09-01'),
  ('BRANCH', 'Fely Baldoza',     date '2022-04-18'),
  ('BRANCH', 'Grace Nolasco',    date '2020-11-09'),
  ('BRANCH', 'Hazel Villar',     date '2024-01-15'),
  ('BRANCH', 'Ivy Marquez',      date '2023-08-07')
) as t(branch_code, full_name, hired_on)
join branches b on b.code = t.branch_code
where not exists (
  select 1 from technicians x where x.full_name = t.full_name and x.branch_id = b.id
);

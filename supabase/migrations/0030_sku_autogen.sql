-- 0030_sku_autogen.sql — SKUs assign themselves.
--
-- A product saved without a SKU gets the next free "P-00001"-style code
-- for its business, so the encoder never has to invent one. A typed SKU
-- still wins (e.g. to mirror a supplier barcode). Existing products with
-- no SKU are backfilled in name order.
--
-- Rerun-safe. Run as-is in the Supabase SQL editor (default role).

create table if not exists sku_counters (
  business_id uuid primary key references businesses(id) on delete cascade,
  next_val    int not null default 1
);

alter table sku_counters enable row level security;
-- No policies on purpose: only the definer functions below touch it.

-- Draws the next free code under a row lock (same pattern as ticket
-- numbers), skipping any code a manually-typed SKU already took, so two
-- simultaneous saves cannot collide.
create or replace function next_sku(p_business uuid)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_next int;
  v_sku  text;
begin
  insert into sku_counters (business_id, next_val)
  values (p_business, 1)
  on conflict (business_id) do nothing;

  select next_val into v_next from sku_counters
  where business_id = p_business for update;

  loop
    v_sku := 'P-' || lpad(v_next::text, 5, '0');
    exit when not exists (
      select 1 from products
      where business_id = p_business and lower(sku) = lower(v_sku));
    v_next := v_next + 1;
  end loop;

  update sku_counters set next_val = v_next + 1
  where business_id = p_business;

  return v_sku;
end
$$;

create or replace function assign_sku()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if nullif(btrim(coalesce(new.sku, '')), '') is not null then
    new.sku := btrim(new.sku);
  else
    new.sku := next_sku(new.business_id);
  end if;
  return new;
end
$$;

drop trigger if exists products_assign_sku on products;
create trigger products_assign_sku
  before insert on products
  for each row execute function assign_sku();

-- Backfill existing products without a SKU, in name order per business.
do $$
declare r record;
begin
  for r in
    select id, business_id from products
    where nullif(btrim(coalesce(sku, '')), '') is null
    order by business_id, lower(name), lower(coalesce(brand, '')), created_at
  loop
    update products set sku = next_sku(r.business_id) where id = r.id;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Verification: generator in place, and no product left without a SKU.
-- ---------------------------------------------------------------------------

select
  to_regprocedure('next_sku(uuid)') is not null as generator_ready,
  (select count(*) from pg_trigger where tgname = 'products_assign_sku') = 1
    as trigger_ready,
  (select count(*) from products
   where nullif(btrim(coalesce(sku, '')), '') is null) as products_without_sku;

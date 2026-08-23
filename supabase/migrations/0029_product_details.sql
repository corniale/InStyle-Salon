-- 0029_product_details.sql — a real product catalogue.
--
-- Products gain the identity that keeps a shelf reviewable: SKU, brand,
-- category and sub-category, size, a standard unit cost (what a delivery
-- normally costs — it pre-fills delivery entry; the ledger's weighted
-- average still reports what was actually paid), and a retail price for
-- the later POS-retail step.
--
-- Categories are DATA, not code: a business-scoped table the owner edits
-- from the product form itself ("+ Add new category…"), with sub-categories
-- as children. No developer needed to add one, ever.
--
-- Uniqueness relaxes to (name, brand, size) per business — "Shampoo 1L"
-- from two brands is two products. SKUs are unique per business when set.
--
-- Rerun-safe. Run as-is in the Supabase SQL editor (default role).

-- ---------------------------------------------------------------------------
-- Categories: one table, two levels. parent_id null = category,
-- set = sub-category of that category.
-- ---------------------------------------------------------------------------

create table if not exists product_categories (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete restrict,
  parent_id   uuid references product_categories(id) on delete restrict,
  name        text not null,
  created_at  timestamptz not null default now()
);

create unique index if not exists product_categories_unique_name_key
  on product_categories (business_id, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name));

-- Only two levels: a sub-category's parent must itself be top-level and of
-- the same business.
create or replace function guard_product_category()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_parent product_categories;
begin
  if new.parent_id is not null then
    select * into v_parent from product_categories where id = new.parent_id;
    if not found or v_parent.parent_id is not null then
      raise exception 'A sub-category must sit under a top-level category.'
        using errcode = 'check_violation', hint = 'bad_parent';
    end if;
    if v_parent.business_id <> new.business_id then
      raise exception 'The parent category belongs to a different business.'
        using errcode = 'check_violation', hint = 'business_mismatch';
    end if;
  end if;
  return new;
end
$$;

drop trigger if exists product_categories_guard on product_categories;
create trigger product_categories_guard
  before insert or update on product_categories
  for each row execute function guard_product_category();

alter table product_categories enable row level security;

drop policy if exists product_categories_read on product_categories;
create policy product_categories_read on product_categories
  for select to authenticated using (auth_role() is not null);

drop policy if exists product_categories_owner_write on product_categories;
create policy product_categories_owner_write on product_categories
  to authenticated
  using (auth_role() = 'owner')
  with check (auth_role() = 'owner');

-- ---------------------------------------------------------------------------
-- Product columns
-- ---------------------------------------------------------------------------

alter table products add column if not exists sku text;
alter table products add column if not exists brand text;
alter table products add column if not exists category_id uuid
  references product_categories(id) on delete restrict;
alter table products add column if not exists subcategory_id uuid
  references product_categories(id) on delete restrict;
alter table products add column if not exists size text;
alter table products add column if not exists standard_cost_cents bigint
  check (standard_cost_cents >= 0);
alter table products add column if not exists retail_price_cents bigint
  check (retail_price_cents >= 0);

-- Same name is fine across brands/sizes; the trio must be unique.
drop index if exists products_business_lower_name_key;
create unique index if not exists products_identity_key
  on products (business_id, lower(name),
               lower(coalesce(brand, '')), lower(coalesce(size, '')));

create unique index if not exists products_sku_key
  on products (business_id, lower(sku)) where sku is not null;

-- The chosen sub-category must be a child of the chosen category, and
-- both must belong to the product's business.
create or replace function guard_product_hierarchy()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_cat product_categories;
  v_sub product_categories;
begin
  if new.category_id is not null then
    select * into v_cat from product_categories where id = new.category_id;
    if v_cat.parent_id is not null then
      raise exception 'Pick a top-level category (that one is a sub-category).'
        using errcode = 'check_violation', hint = 'category_is_sub';
    end if;
    if v_cat.business_id <> new.business_id then
      raise exception 'That category belongs to a different business.'
        using errcode = 'check_violation', hint = 'business_mismatch';
    end if;
  end if;
  if new.subcategory_id is not null then
    if new.category_id is null then
      raise exception 'A sub-category needs its category picked too.'
        using errcode = 'check_violation', hint = 'subcategory_without_category';
    end if;
    select * into v_sub from product_categories where id = new.subcategory_id;
    if v_sub.parent_id is distinct from new.category_id then
      raise exception 'That sub-category does not belong to the chosen category.'
        using errcode = 'check_violation', hint = 'subcategory_mismatch';
    end if;
  end if;
  return new;
end
$$;

drop trigger if exists products_hierarchy_guard on products;
create trigger products_hierarchy_guard
  before insert or update of category_id, subcategory_id on products
  for each row execute function guard_product_hierarchy();

-- ---------------------------------------------------------------------------
-- Views: existing columns keep their positions; new detail appended.
-- Stock value falls back to the standard cost until a delivery has been
-- recorded with a real one.
-- ---------------------------------------------------------------------------

create or replace view v_stock_on_hand
with (security_invoker = on) as
select
  p.id            as product_id,
  p.business_id,
  p.name          as product_name,
  p.unit,
  p.low_stock_threshold,
  p.active,
  b.id            as branch_id,
  b.code          as branch_code,
  b.name          as branch_name,
  coalesce(sum(stock_signed_qty(m.kind, m.qty)), 0) as on_hand,
  c.avg_cost_cents,
  (coalesce(sum(stock_signed_qty(m.kind, m.qty)), 0)
     * coalesce(c.avg_cost_cents, p.standard_cost_cents, 0))::bigint as value_cents,
  max(m.moved_on) as last_moved_on,
  p.sku,
  p.brand,
  p.size,
  p.standard_cost_cents,
  p.retail_price_cents,
  cat.name        as category_name,
  sub.name        as subcategory_name,
  p.category_id,
  p.subcategory_id
from products p
join branches b on b.business_id = p.business_id
left join stock_moves m on m.product_id = p.id and m.branch_id = b.id
left join v_product_cost c on c.product_id = p.id
left join product_categories cat on cat.id = p.category_id
left join product_categories sub on sub.id = p.subcategory_id
group by p.id, p.business_id, p.name, p.unit, p.low_stock_threshold, p.active,
         b.id, b.code, b.name, c.avg_cost_cents, p.sku, p.brand, p.size,
         p.standard_cost_cents, p.retail_price_cents, cat.name, sub.name,
         p.category_id, p.subcategory_id;

create or replace view v_stock_activity
with (security_invoker = on) as
select
  m.id,
  m.moved_on,
  m.created_at,
  m.kind,
  m.qty,
  stock_signed_qty(m.kind, m.qty) as signed_qty,
  m.unit_cost_cents,
  m.supplier,
  m.note,
  m.expense_id,
  m.transfer_id,
  m.recorded_by,
  m.product_id,
  p.name as product_name,
  p.unit,
  m.branch_id,
  b.code as branch_code,
  b.name as branch_name,
  p.sku,
  p.brand,
  p.size
from stock_moves m
join products p on p.id = m.product_id
join branches b on b.id = m.branch_id;

-- ---------------------------------------------------------------------------
-- Verification
-- ---------------------------------------------------------------------------

select
  to_regclass('product_categories') is not null as categories_ready,
  (select count(*) from information_schema.columns
   where table_name = 'products'
     and column_name in ('sku', 'brand', 'category_id', 'subcategory_id',
                         'size', 'standard_cost_cents', 'retail_price_cents'))
    as new_product_columns,
  (select count(*) from pg_indexes
   where indexname in ('products_identity_key', 'products_sku_key',
                       'product_categories_unique_name_key')) as new_indexes,
  (select count(*) from pg_policies where tablename = 'product_categories')
    as category_policies;

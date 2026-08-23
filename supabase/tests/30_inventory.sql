-- Inventory behaviour: catalogue rights, append-only ledger, on-hand
-- math, overdraw refusal, transfers, costing. Runs after 10_behaviour
-- (same database, its users still exist: 1 = owner, 3 = front desk MAIN).

\set QUIET on
set client_min_messages = warning;

set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', false);

-- Owner creates products; the catalogue refuses case-duplicate names.
do $$
declare v_biz uuid;
begin
  select business_id into v_biz from public.branches where code = 'MAIN';
  insert into public.products (business_id, name, unit, low_stock_threshold)
  values (v_biz, 'Shampoo 1L', 'bottle', 2),
         (v_biz, 'Nail polish red', 'bottle', 0);
  begin
    insert into public.products (business_id, name) values (v_biz, 'SHAMPOO 1L');
    raise exception 'duplicate product name accepted';
  exception when unique_violation then null;
  end;
end $$;

-- Product details (0029): categories are data, identity is name+brand+size,
-- SKUs are unique, the hierarchy is validated.
do $$
declare v_biz uuid; v_cat uuid; v_sub uuid; v_other_cat uuid;
begin
  select business_id into v_biz from public.branches where code = 'MAIN';

  insert into public.product_categories (business_id, name)
  values (v_biz, 'Hair care') returning id into v_cat;
  insert into public.product_categories (business_id, parent_id, name)
  values (v_biz, v_cat, 'Shampoo') returning id into v_sub;
  insert into public.product_categories (business_id, name)
  values (v_biz, 'Nail care') returning id into v_other_cat;

  -- A sub-category cannot hang off another sub-category.
  begin
    insert into public.product_categories (business_id, parent_id, name)
    values (v_biz, v_sub, 'Too deep');
    raise exception 'three-level category accepted';
  exception when check_violation then null;
  end;

  -- Same name, different brand/size: two legitimate products.
  insert into public.products (business_id, name, brand, size, unit, sku,
                               category_id, subcategory_id,
                               standard_cost_cents, retail_price_cents)
  values (v_biz, 'Shampoo 1L', 'Palmolive', '1 L', 'bottle', 'SH-PAL-1L',
          v_cat, v_sub, 25000, 45000),
         (v_biz, 'Shampoo 1L', 'Pantene', '1 L', 'bottle', 'SH-PAN-1L',
          v_cat, v_sub, 30000, 52000);

  -- …but the same name+brand+size trio is a duplicate.
  begin
    insert into public.products (business_id, name, brand, size)
    values (v_biz, 'SHAMPOO 1L', 'palmolive', '1 l');
    raise exception 'duplicate name+brand+size accepted';
  exception when unique_violation then null;
  end;

  -- A SKU cannot repeat within the business.
  begin
    insert into public.products (business_id, name, sku)
    values (v_biz, 'Different product', 'sh-pal-1l');
    raise exception 'duplicate SKU accepted';
  exception when unique_violation then null;
  end;

  -- A sub-category under the wrong category is refused.
  begin
    insert into public.products (business_id, name, category_id, subcategory_id)
    values (v_biz, 'Miscategorised', v_other_cat, v_sub);
    raise exception 'mismatched sub-category accepted';
  exception when check_violation then null;
  end;
end $$;

-- Front desk cannot touch the catalogue.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000003', false);
do $$
declare v_biz uuid; v_ok boolean := false;
begin
  select business_id into v_biz from public.branches where code = 'MAIN';
  begin
    insert into public.products (business_id, name) values (v_biz, 'Rogue product');
  exception when insufficient_privilege or check_violation then v_ok := true;
  end;
  if not v_ok and exists (select 1 from public.products where name = 'Rogue product') then
    raise exception 'front desk created a product';
  end if;
end $$;

-- Front desk records a delivery and usage at their own branch; on-hand and
-- weighted-average cost follow the ledger.
do $$
declare v_main uuid; v_prod uuid;
begin
  select id into v_main from public.branches where code = 'MAIN';
  select id into v_prod from public.products where name = 'Shampoo 1L';

  insert into public.stock_moves (product_id, branch_id, kind, qty, unit_cost_cents, supplier, recorded_by)
  values (v_prod, v_main, 'delivery', 10, 25000, 'Goa Beauty Supply', auth.uid()),
         (v_prod, v_main, 'delivery', 10, 35000, 'Goa Beauty Supply', auth.uid());
  insert into public.stock_moves (product_id, branch_id, kind, qty, note, recorded_by)
  values (v_prod, v_main, 'usage', 4, 'weekly usage', auth.uid());

  if (select on_hand from public.v_stock_on_hand
      where product_id = v_prod and branch_id = v_main) <> 16 then
    raise exception 'on hand wrong after delivery + usage';
  end if;
  -- (10×250 + 10×350) / 20 = ₱300
  if (select avg_cost_cents from public.v_stock_on_hand
      where product_id = v_prod and branch_id = v_main) <> 30000 then
    raise exception 'weighted average cost wrong';
  end if;

  -- Taking out more than on hand is refused.
  begin
    insert into public.stock_moves (product_id, branch_id, kind, qty, recorded_by)
    values (v_prod, v_main, 'usage', 999, auth.uid());
    raise exception 'overdraw accepted';
  exception when check_violation then null;
  end;

  -- Cost on a non-delivery is refused.
  begin
    insert into public.stock_moves (product_id, branch_id, kind, qty, unit_cost_cents, recorded_by)
    values (v_prod, v_main, 'usage', 1, 100, auth.uid());
    raise exception 'cost on usage accepted';
  exception when check_violation then null;
  end;
end $$;

-- The ledger is append-only: no update, no delete, for anyone.
do $$
declare v_n int;
begin
  update public.stock_moves set qty = 999 where kind = 'usage';
  get diagnostics v_n = row_count;
  if v_n <> 0 then raise exception 'ledger row was editable'; end if;
  delete from public.stock_moves where kind = 'usage';
  get diagnostics v_n = row_count;
  if v_n <> 0 then raise exception 'ledger row was deletable'; end if;
end $$;

-- Front desk cannot write another branch's ledger directly…
do $$
declare v_branch uuid; v_prod uuid; v_ok boolean := false;
begin
  select id into v_branch from public.branches where code = 'BRANCH';
  select id into v_prod from public.products where name = 'Shampoo 1L';
  begin
    insert into public.stock_moves (product_id, branch_id, kind, qty, recorded_by)
    values (v_prod, v_branch, 'delivery', 5, auth.uid());
  exception when others then v_ok := true;
  end;
  if not v_ok then raise exception 'front desk wrote another branch ledger'; end if;
end $$;

-- …but CAN send a transfer there, which writes both legs atomically.
do $$
declare v_main uuid; v_branch uuid; v_prod uuid;
begin
  select id into v_main from public.branches where code = 'MAIN';
  -- Front desk cannot SELECT other branches; destinations come from the
  -- definer helper, exactly as the transfer dialog will.
  select id into v_branch from f_stock_destinations(v_main) where code = 'BRANCH';
  if v_branch is null then
    raise exception 'destination helper returned no sibling branch';
  end if;
  select id into v_prod from public.products where name = 'Shampoo 1L';

  perform transfer_stock(v_prod, v_main, v_branch, 6, 'restock BRANCH');

  if (select on_hand from public.v_stock_on_hand
      where product_id = v_prod and branch_id = v_main) <> 10 then
    raise exception 'transfer did not leave the source';
  end if;

  -- Sending from a branch that is not yours is refused.
  begin
    perform transfer_stock(v_prod, v_branch, v_main, 1, null);
    raise exception 'front desk sent stock from another branch';
  exception when insufficient_privilege then null;
  end;

  -- Overdrawing a transfer is refused by the same on-hand guard.
  begin
    perform transfer_stock(v_prod, v_main, v_branch, 999, null);
    raise exception 'transfer overdraw accepted';
  exception when check_violation then null;
  end;
end $$;

-- The receiving side, checked with cross-branch eyes (owner): stock
-- arrived, and the transfer never moved the average cost.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', false);
do $$
declare v_branch uuid; v_prod uuid;
begin
  select id into v_branch from public.branches where code = 'BRANCH';
  select id into v_prod from public.products where name = 'Shampoo 1L';
  if (select on_hand from public.v_stock_on_hand
      where product_id = v_prod and branch_id = v_branch) <> 6 then
    raise exception 'transfer did not arrive at the destination';
  end if;
  if (select avg_cost_cents from public.v_stock_on_hand
      where product_id = v_prod and branch_id = v_branch) <> 30000 then
    raise exception 'transfer distorted the average cost';
  end if;
end $$;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000003', false);

-- Low-stock flag: threshold 2, MAIN ended on 10 (no flag); draw it down.
do $$
declare v_main uuid; v_prod uuid;
begin
  select id into v_main from public.branches where code = 'MAIN';
  select id into v_prod from public.products where name = 'Shampoo 1L';
  insert into public.stock_moves (product_id, branch_id, kind, qty, note, recorded_by)
  values (v_prod, v_main, 'adjust_out', 9, 'count correction', auth.uid());
  if (select on_hand <= low_stock_threshold from public.v_stock_on_hand
      where product_id = v_prod and branch_id = v_main) is not true then
    raise exception 'low stock condition not reached';
  end if;
end $$;

reset role;
select 'inventory suite passed' as result;

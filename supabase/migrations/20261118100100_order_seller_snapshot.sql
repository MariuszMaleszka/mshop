-- Seller identity copied onto an order at creation.
-- The table must be empty: these columns are not null and have no backfill.

do $$
declare
  order_count bigint;
begin
  lock table public.orders in access exclusive mode;
  select count(*) into order_count from public.orders;
  if order_count > 0 then
    raise exception
      'public.orders has % row(s); refusing to add seller snapshot columns without a backfill',
      order_count;
  end if;
end
$$;

alter table public.orders
  add column seller_business_name_snapshot text not null,
  add column seller_nip_snapshot text not null,
  add column seller_street_snapshot text not null,
  add column seller_building_number_snapshot text not null,
  add column seller_unit_number_snapshot text,
  add column seller_postal_code_snapshot text not null,
  add column seller_city_snapshot text not null,
  add column seller_country_code_snapshot varchar(2) not null,
  add constraint orders_seller_nip_snapshot_check check (
    seller_nip_snapshot ~ '^[0-9]{10}$'
  ),
  add constraint orders_seller_postal_code_snapshot_check check (
    seller_postal_code_snapshot ~ '^[0-9]{2}-[0-9]{3}$'
  ),
  add constraint orders_seller_country_code_snapshot_check check (
    seller_country_code_snapshot ~ '^[A-Z]{2}$'
  ),
  add constraint orders_seller_identity_snapshot_check check (
    btrim(seller_business_name_snapshot) <> ''
    and btrim(seller_street_snapshot) <> ''
    and btrim(seller_building_number_snapshot) <> ''
    and btrim(seller_city_snapshot) <> ''
    and (
      seller_unit_number_snapshot is null
      or btrim(seller_unit_number_snapshot) <> ''
    )
  );

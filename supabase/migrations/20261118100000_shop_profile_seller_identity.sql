-- Seller identity on the single shop profile row.
-- A NULL regex comparison is unknown, and CHECK rejects only false.
-- Required NIP and postal code therefore test IS NOT NULL first.

alter table public.shop_profile
  add column business_name text,
  add column nip text,
  add column street text,
  add column building_number text,
  add column unit_number text,
  add column postal_code text,
  add column city text,
  add column country_code varchar(2) not null default 'PL';

alter table public.shop_profile
  add constraint shop_profile_country_code_check check (
    country_code ~ '^[A-Z]{2}$'
  ),
  add constraint shop_profile_identity_check check (
    (
      seller_tax_status = 'unknown'
      and (nip is null or nip ~ '^[0-9]{10}$')
      and (postal_code is null or postal_code ~ '^[0-9]{2}-[0-9]{3}$')
      and (unit_number is null or char_length(btrim(unit_number)) > 0)
    )
    or (
      seller_tax_status in ('registered', 'exempt')
      and nullif(btrim(business_name), '') is not null
      and nip is not null
      and nip ~ '^[0-9]{10}$'
      and nullif(btrim(street), '') is not null
      and nullif(btrim(building_number), '') is not null
      and postal_code is not null
      and postal_code ~ '^[0-9]{2}-[0-9]{3}$'
      and nullif(btrim(city), '') is not null
      and (unit_number is null or char_length(btrim(unit_number)) > 0)
    )
  );

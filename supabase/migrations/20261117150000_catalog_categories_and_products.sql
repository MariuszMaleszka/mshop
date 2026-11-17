-- Catalog: one category per product. Public reads are limited to active rows.

create table public.categories (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null,
  description text,
  is_active boolean not null,
  sort_order integer not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint categories_slug_key unique (slug)
);

create index categories_active_sort_idx
on public.categories (sort_order)
where is_active;

create trigger categories_set_updated_at
before update on public.categories
for each row
execute function public.set_updated_at();

create table public.products (
  id uuid primary key default gen_random_uuid(),
  category_id uuid references public.categories (id) on delete set null,
  name text not null,
  slug text not null,
  description text,
  product_type text not null,
  sku text,
  price_amount bigint not null,
  currency char(3) not null default 'PLN',
  tax_status text not null,
  vat_rate numeric(5,2),
  is_active boolean not null,
  stock_quantity integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint products_slug_key unique (slug),
  constraint products_sku_key unique (sku),
  constraint products_product_type_check check (
    product_type in ('physical', 'digital', 'service')
  ),
  constraint products_price_amount_check check (price_amount >= 0),
  constraint products_currency_check check (currency ~ '^[A-Z]{3}$'),
  constraint products_stock_quantity_check check (
    stock_quantity is null or stock_quantity >= 0
  ),
  constraint products_tax_check check (
    (
      tax_status = 'standard'
      and vat_rate is not null
      and vat_rate > 0
      and vat_rate <= 100
    )
    or (
      tax_status = 'zero_rated'
      and vat_rate is not null
      and vat_rate = 0
    )
    or (
      tax_status in ('exempt', 'not_subject')
      and vat_rate is null
    )
  )
);

create index products_category_id_idx
on public.products (category_id);

create index products_active_idx
on public.products (is_active)
where is_active;

create trigger products_set_updated_at
before update on public.products
for each row
execute function public.set_updated_at();

alter table public.categories enable row level security;
alter table public.products enable row level security;

revoke all on table public.categories from public, anon, authenticated;
revoke all on table public.products from public, anon, authenticated;

grant select on table public.categories to anon, authenticated;
grant select on table public.products to anon, authenticated;

create policy categories_select_active
on public.categories
for select
to anon, authenticated
using (is_active);

create policy products_select_active
on public.products
for select
to anon, authenticated
using (is_active);

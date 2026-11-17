-- Carts belong to one account or one guest session. Prices stay in the catalog.

create table public.carts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users (id) on delete cascade,
  session_id char(64),
  status text not null default 'active',
  currency char(3) not null default 'PLN',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint carts_status_check check (
    status in ('active', 'converted', 'abandoned')
  ),
  constraint carts_currency_check check (currency ~ '^[A-Z]{3}$'),
  constraint carts_owner_check check (
    (
      user_id is not null
      and session_id is null
    )
    or (
      user_id is null
      and session_id is not null
    )
  ),
  constraint carts_session_id_check check (
    session_id is null
    or session_id ~ '^[0-9a-f]{64}$'
  )
);

create unique index carts_one_active_user_idx
on public.carts (user_id)
where status = 'active' and user_id is not null;

create unique index carts_one_active_session_idx
on public.carts (session_id)
where status = 'active' and session_id is not null;

create trigger carts_set_updated_at
before update on public.carts
for each row
execute function public.set_updated_at();

create table public.cart_items (
  id uuid primary key default gen_random_uuid(),
  cart_id uuid not null references public.carts (id) on delete cascade,
  product_id uuid not null references public.products (id) on delete restrict,
  quantity integer not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint cart_items_quantity_check check (quantity >= 1),
  constraint cart_items_cart_id_product_id_key unique (cart_id, product_id)
);

create index cart_items_product_id_idx
on public.cart_items (product_id);

create trigger cart_items_set_updated_at
before update on public.cart_items
for each row
execute function public.set_updated_at();

alter table public.carts enable row level security;
alter table public.cart_items enable row level security;

revoke all on table public.carts from public, anon, authenticated;
revoke all on table public.cart_items from public, anon, authenticated;

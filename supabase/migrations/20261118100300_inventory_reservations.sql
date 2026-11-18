-- Reservations keep one row per order line.
-- payment_method is copied from the order. A CHECK cannot read orders,
-- and the existing unique key also includes currency and gross amount.
-- orders.id is already unique, so (id, payment_method) accepts every current row.

alter table public.order_items
  add constraint order_items_id_product_key unique (id, product_id);

alter table public.orders
  add constraint orders_id_payment_method_key unique (id, payment_method);

create table public.inventory_reservations (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null,
  order_item_id uuid not null,
  product_id uuid,
  payment_method text not null,
  quantity integer not null,
  status text not null,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint inventory_reservations_order_id_fkey
    foreign key (order_id) references public.orders (id) on delete restrict,
  constraint inventory_reservations_order_payment_fkey
    foreign key (order_id, payment_method)
    references public.orders (id, payment_method) on delete restrict,
  constraint inventory_reservations_order_item_id_fkey
    foreign key (order_item_id) references public.order_items (id),
  constraint inventory_reservations_product_id_fkey
    foreign key (product_id) references public.products (id) on delete set null,
  constraint inventory_reservations_order_item_product_fkey
    foreign key (order_item_id, product_id)
    references public.order_items (id, product_id)
    on update cascade
    on delete set null (product_id),
  constraint inventory_reservations_order_item_id_key unique (order_item_id),
  constraint inventory_reservations_quantity_check check (quantity >= 1),
  constraint inventory_reservations_status_check check (
    status in ('active', 'consumed', 'released', 'expired')
  ),
  constraint inventory_reservations_payment_method_check check (
    payment_method in ('online', 'cash')
  ),
  constraint inventory_reservations_active_product_check check (
    status <> 'active' or product_id is not null
  ),
  constraint inventory_reservations_expiry_check check (
    status <> 'active'
    or (
      payment_method = 'online'
      and expires_at is not null
    )
    or (
      payment_method = 'cash'
      and expires_at is null
    )
  )
);

create index inventory_reservations_order_id_idx
on public.inventory_reservations (order_id);

create index inventory_reservations_active_product_idx
on public.inventory_reservations (product_id)
where status = 'active';

create index inventory_reservations_active_expires_at_idx
on public.inventory_reservations (expires_at)
where status = 'active' and expires_at is not null;

create trigger inventory_reservations_set_updated_at
before update on public.inventory_reservations
for each row
execute function public.set_updated_at();

alter table public.inventory_reservations enable row level security;

revoke all on table public.inventory_reservations from public, anon, authenticated;

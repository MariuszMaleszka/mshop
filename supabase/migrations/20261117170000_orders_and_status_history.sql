-- Orders keep purchase snapshots. Line currency must match the order currency.
-- Header totals are checked per row. Equality with the sum of lines belongs to checkout.

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  order_number text not null,
  customer_id uuid references public.customers (id) on delete set null,
  user_id uuid references auth.users (id) on delete set null,
  customer_email text not null,
  customer_type text not null,
  billing_snapshot jsonb not null,
  seller_tax_status_snapshot text not null,
  currency char(3) not null,
  net_amount bigint not null,
  tax_amount bigint not null,
  gross_amount bigint not null,
  payment_method text not null,
  payment_status text not null default 'pending',
  fulfillment_status text not null default 'new',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint orders_order_number_key unique (order_number),
  constraint orders_id_currency_key unique (id, currency),
  constraint orders_customer_type_check check (
    customer_type in ('individual', 'company')
  ),
  constraint orders_seller_tax_status_snapshot_check check (
    seller_tax_status_snapshot in ('registered', 'exempt')
  ),
  constraint orders_currency_check check (currency ~ '^[A-Z]{3}$'),
  constraint orders_amounts_check check (
    net_amount >= 0
    and tax_amount >= 0
    and gross_amount >= 0
    and gross_amount = net_amount + tax_amount
  ),
  constraint orders_payment_method_check check (
    payment_method in ('online', 'cash')
  ),
  constraint orders_payment_status_check check (
    payment_status in (
      'pending',
      'paid',
      'failed',
      'cancelled',
      'refunded',
      'partially_refunded'
    )
  ),
  constraint orders_fulfillment_status_check check (
    fulfillment_status in ('new', 'processing', 'completed', 'cancelled')
  )
);

create index orders_user_id_created_at_idx
on public.orders (user_id, created_at);

create trigger orders_set_updated_at
before update on public.orders
for each row
execute function public.set_updated_at();

create table public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null,
  product_id uuid references public.products (id) on delete set null,
  product_name_snapshot text not null,
  product_type_snapshot text not null,
  sku_snapshot text,
  currency char(3) not null,
  catalog_tax_status_snapshot text not null,
  catalog_vat_rate_snapshot numeric(5, 2),
  tax_status_snapshot text not null,
  vat_rate_snapshot numeric(5, 2),
  unit_gross_amount bigint not null,
  quantity integer not null,
  line_net_amount bigint not null,
  line_tax_amount bigint not null,
  line_gross_amount bigint not null,
  constraint order_items_order_id_currency_fkey
    foreign key (order_id, currency)
    references public.orders (id, currency)
    on delete cascade,
  constraint order_items_product_type_snapshot_check check (
    product_type_snapshot in ('physical', 'digital', 'service')
  ),
  constraint order_items_currency_check check (currency ~ '^[A-Z]{3}$'),
  constraint order_items_quantity_check check (quantity >= 1),
  constraint order_items_amounts_check check (
    unit_gross_amount >= 0
    and line_net_amount >= 0
    and line_tax_amount >= 0
    and line_gross_amount >= 0
    and line_gross_amount = unit_gross_amount * quantity
    and line_gross_amount = line_net_amount + line_tax_amount
  ),
  constraint order_items_catalog_tax_check check (
    (
      catalog_tax_status_snapshot = 'standard'
      and catalog_vat_rate_snapshot is not null
      and catalog_vat_rate_snapshot > 0
      and catalog_vat_rate_snapshot <= 100
    )
    or (
      catalog_tax_status_snapshot = 'zero_rated'
      and catalog_vat_rate_snapshot is not null
      and catalog_vat_rate_snapshot = 0
    )
    or (
      catalog_tax_status_snapshot in ('exempt', 'not_subject')
      and catalog_vat_rate_snapshot is null
    )
  ),
  constraint order_items_applied_tax_check check (
    (
      tax_status_snapshot = 'standard'
      and vat_rate_snapshot is not null
      and vat_rate_snapshot > 0
      and vat_rate_snapshot <= 100
    )
    or (
      tax_status_snapshot = 'zero_rated'
      and vat_rate_snapshot is not null
      and vat_rate_snapshot = 0
      and line_tax_amount = 0
      and line_net_amount = line_gross_amount
    )
    or (
      tax_status_snapshot in ('exempt', 'not_subject')
      and vat_rate_snapshot is null
      and line_tax_amount = 0
      and line_net_amount = line_gross_amount
    )
  )
);

create index order_items_order_id_idx
on public.order_items (order_id);

create table public.order_status_history (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders (id) on delete cascade,
  status_type text not null,
  old_status text,
  new_status text not null,
  changed_by uuid references auth.users (id) on delete set null,
  note text,
  created_at timestamptz not null default now(),
  constraint order_status_history_status_type_check check (
    status_type in ('payment', 'fulfillment')
  ),
  constraint order_status_history_old_status_check check (
    old_status is null
    or (
      status_type = 'payment'
      and old_status in (
        'pending',
        'paid',
        'failed',
        'cancelled',
        'refunded',
        'partially_refunded'
      )
    )
    or (
      status_type = 'fulfillment'
      and old_status in ('new', 'processing', 'completed', 'cancelled')
    )
  ),
  constraint order_status_history_new_status_check check (
    (
      status_type = 'payment'
      and new_status in (
        'pending',
        'paid',
        'failed',
        'cancelled',
        'refunded',
        'partially_refunded'
      )
    )
    or (
      status_type = 'fulfillment'
      and new_status in ('new', 'processing', 'completed', 'cancelled')
    )
  )
);

create index order_status_history_order_id_created_at_idx
on public.order_status_history (order_id, created_at);

alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.order_status_history enable row level security;

revoke all on table public.orders from public, anon, authenticated;
revoke all on table public.order_items from public, anon, authenticated;
revoke all on table public.order_status_history from public, anon, authenticated;

grant select on table public.orders to authenticated;
grant select on table public.order_items to authenticated;

create policy orders_select_own
on public.orders
for select
to authenticated
using (user_id = (select auth.uid()));

create policy order_items_select_own
on public.order_items
for select
to authenticated
using (
  exists (
    select 1
    from public.orders
    where orders.id = order_items.order_id
      and orders.user_id = (select auth.uid())
  )
);

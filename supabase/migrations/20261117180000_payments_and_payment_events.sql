-- Payments mirror the order method, currency and gross amount.
-- Status changes stay in Express. This migration does not sync orders.payment_status.

alter table public.orders
add constraint orders_payment_snapshot_key
unique (id, payment_method, currency, gross_amount);

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null,
  method text not null,
  provider text,
  provider_transaction_id text,
  status text not null default 'pending',
  amount bigint not null,
  refunded_amount bigint not null default 0,
  currency char(3) not null,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payments_order_snapshot_fkey
    foreign key (order_id, method, currency, amount)
    references public.orders (id, payment_method, currency, gross_amount)
    on delete restrict,
  constraint payments_method_provider_check check (
    (
      method = 'cash'
      and provider is null
      and provider_transaction_id is null
    )
    or (
      method = 'online'
      and provider is not null
      and provider in ('przelewy24', 'stripe')
    )
  ),
  constraint payments_status_check check (
    status in (
      'pending',
      'paid',
      'failed',
      'cancelled',
      'refunded',
      'partially_refunded'
    )
  ),
  constraint payments_currency_check check (currency ~ '^[A-Z]{3}$'),
  constraint payments_amounts_check check (
    amount >= 0
    and refunded_amount >= 0
    and refunded_amount <= amount
  ),
  constraint payments_status_amounts_check check (
    (
      status in ('pending', 'failed', 'cancelled')
      and paid_at is null
      and refunded_amount = 0
    )
    or (
      status = 'paid'
      and paid_at is not null
      and refunded_amount = 0
    )
    or (
      status = 'partially_refunded'
      and paid_at is not null
      and refunded_amount > 0
      and refunded_amount < amount
    )
    or (
      status = 'refunded'
      and paid_at is not null
      and refunded_amount = amount
    )
  )
);

create index payments_order_id_idx
on public.payments (order_id);

create unique index payments_one_active_per_order_idx
on public.payments (order_id)
where status in ('pending', 'paid', 'partially_refunded');

create unique index payments_provider_transaction_idx
on public.payments (provider, provider_transaction_id)
where provider_transaction_id is not null;

create trigger payments_set_updated_at
before update on public.payments
for each row
execute function public.set_updated_at();

create table public.payment_events (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references public.payments (id) on delete cascade,
  provider text not null,
  provider_event_id text,
  event_type text not null,
  payload jsonb not null,
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint payment_events_provider_check check (
    provider in ('przelewy24', 'stripe', 'manual')
  ),
  constraint payment_events_event_type_check check (
    char_length(event_type) > 0
  ),
  constraint payment_events_payload_check check (
    jsonb_typeof(payload) = 'object'
  )
);

create index payment_events_payment_id_created_at_idx
on public.payment_events (payment_id, created_at);

create unique index payment_events_provider_event_idx
on public.payment_events (provider, provider_event_id)
where provider_event_id is not null;

alter table public.payments enable row level security;
alter table public.payment_events enable row level security;

revoke all on table public.payments from public, anon, authenticated;
revoke all on table public.payment_events from public, anon, authenticated;

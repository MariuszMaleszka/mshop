-- API idempotency keys. Payment webhooks stay in payment_events.
-- Express fills the response in the same transaction and commits only a finished row.

create table public.idempotency_keys (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null,
  operation text not null,
  user_id uuid references auth.users (id) on delete cascade,
  session_id char(64),
  request_hash char(64) not null,
  response_status integer,
  response_body jsonb,
  order_id uuid references public.orders (id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  constraint idempotency_keys_owner_check check (
    (
      user_id is not null
      and session_id is null
    )
    or (
      user_id is null
      and session_id is not null
    )
  ),
  constraint idempotency_keys_session_id_check check (
    session_id is null
    or session_id ~ '^[0-9a-f]{64}$'
  ),
  constraint idempotency_keys_key_length_check check (
    char_length(idempotency_key) between 1 and 255
  ),
  constraint idempotency_keys_operation_length_check check (
    char_length(operation) between 1 and 100
  ),
  constraint idempotency_keys_request_hash_check check (
    request_hash ~ '^[0-9a-f]{64}$'
  ),
  constraint idempotency_keys_expires_at_check check (
    expires_at > created_at
  ),
  constraint idempotency_keys_response_check check (
    (
      response_status is null
      and response_body is null
    )
    or (
      response_status is not null
      and response_body is not null
      and response_status between 200 and 299
      and jsonb_typeof(response_body) = 'object'
    )
  )
);

create unique index idempotency_keys_user_operation_key_idx
on public.idempotency_keys (user_id, operation, idempotency_key)
where user_id is not null;

create unique index idempotency_keys_session_operation_key_idx
on public.idempotency_keys (session_id, operation, idempotency_key)
where session_id is not null;

create index idempotency_keys_expires_at_idx
on public.idempotency_keys (expires_at);

create index idempotency_keys_order_id_idx
on public.idempotency_keys (order_id);

alter table public.idempotency_keys enable row level security;

revoke all on table public.idempotency_keys from public, anon, authenticated;

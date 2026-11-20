-- Guest orders keep the same SHA-256 session hash as the guest cart.
-- Existing rows may have neither user_id nor session_id. Do not backfill them.

alter table public.orders
  add column session_id char(64);

alter table public.orders
  add constraint orders_session_id_format_check check (
    session_id is null
    or session_id ~ '^[0-9a-f]{64}$'
  ),
  add constraint orders_owner_exclusive_check check (
    user_id is null
    or session_id is null
  );

create index orders_session_id_created_at_idx
on public.orders (session_id, created_at)
where session_id is not null;

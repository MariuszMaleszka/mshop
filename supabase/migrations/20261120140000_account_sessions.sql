-- Account session storage. Raw session ids, CSRF secrets, and Supabase tokens
-- are not stored. Login routes are not part of this migration.

create table public.account_sessions (
  id_hash char(64) primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  refresh_state text not null,
  refresh_generation uuid,
  refresh_started_at timestamptz,
  refresh_token_hash char(64),
  key_version smallint not null,
  access_ciphertext bytea,
  access_nonce bytea,
  access_tag bytea,
  refresh_ciphertext bytea,
  refresh_nonce bytea,
  refresh_tag bytea,
  csrf_token_hash char(64) not null,
  absolute_expires_at timestamptz not null,
  idle_expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint account_sessions_id_hash_check check (id_hash ~ '^[0-9a-f]{64}$'),
  constraint account_sessions_refresh_state_check check (
    refresh_state in ('ready', 'pending', 'unknown')
  ),
  constraint account_sessions_refresh_token_hash_check check (
    refresh_token_hash is null
    or refresh_token_hash ~ '^[0-9a-f]{64}$'
  ),
  constraint account_sessions_key_version_check check (key_version >= 1),
  constraint account_sessions_csrf_token_hash_check check (
    csrf_token_hash ~ '^[0-9a-f]{64}$'
  ),
  constraint account_sessions_expiry_check check (
    absolute_expires_at > created_at
    and idle_expires_at > created_at
    and idle_expires_at <= absolute_expires_at
  ),
  constraint account_sessions_access_token_check check (
    (
      access_ciphertext is null
      and access_nonce is null
      and access_tag is null
    )
    or (
      access_ciphertext is not null
      and octet_length(access_nonce) = 12
      and octet_length(access_tag) = 16
    )
  ),
  constraint account_sessions_refresh_token_check check (
    (
      refresh_ciphertext is null
      and refresh_nonce is null
      and refresh_tag is null
    )
    or (
      refresh_ciphertext is not null
      and octet_length(refresh_nonce) = 12
      and octet_length(refresh_tag) = 16
    )
  ),
  constraint account_sessions_ready_check check (
    refresh_state <> 'ready'
    or (
      refresh_generation is null
      and refresh_started_at is null
      and refresh_token_hash is null
      and access_ciphertext is not null
      and refresh_ciphertext is not null
    )
  ),
  constraint account_sessions_pending_check check (
    refresh_state <> 'pending'
    or (
      refresh_generation is not null
      and refresh_started_at is not null
      and refresh_token_hash is not null
      and access_ciphertext is not null
      and refresh_ciphertext is not null
    )
  ),
  constraint account_sessions_unknown_check check (
    refresh_state <> 'unknown'
    or (
      refresh_token_hash is null
      and access_ciphertext is null
      and refresh_ciphertext is null
    )
  )
);

create index account_sessions_pending_started_idx
on public.account_sessions (refresh_started_at)
where refresh_state = 'pending';

create trigger account_sessions_set_updated_at
before update on public.account_sessions
for each row
execute function public.set_updated_at();

create table public.login_challenges (
  id_hash char(64) primary key,
  csrf_token_hash char(64) not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint login_challenges_id_hash_check check (id_hash ~ '^[0-9a-f]{64}$'),
  constraint login_challenges_csrf_token_hash_check check (
    csrf_token_hash ~ '^[0-9a-f]{64}$'
  ),
  constraint login_challenges_expires_at_check check (expires_at > created_at),
  constraint login_challenges_consumed_at_check check (
    consumed_at is null or consumed_at >= created_at
  )
);

create index login_challenges_expires_at_idx
on public.login_challenges (expires_at);

create trigger login_challenges_set_updated_at
before update on public.login_challenges
for each row
execute function public.set_updated_at();

create table public.auth_attempt_counters (
  bucket_hash char(64) not null,
  purpose text not null,
  window_start timestamptz not null,
  count integer not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (bucket_hash, purpose, window_start),
  constraint auth_attempt_counters_bucket_hash_check check (
    bucket_hash ~ '^[0-9a-f]{64}$'
  ),
  constraint auth_attempt_counters_purpose_check check (
    purpose in ('login', 'login_pair', 'csrf', 'refresh')
  ),
  constraint auth_attempt_counters_count_check check (count >= 0)
);

create trigger auth_attempt_counters_set_updated_at
before update on public.auth_attempt_counters
for each row
execute function public.set_updated_at();

alter table public.account_sessions enable row level security;
alter table public.login_challenges enable row level security;
alter table public.auth_attempt_counters enable row level security;

revoke all on table public.account_sessions from public, anon, authenticated;
revoke all on table public.login_challenges from public, anon, authenticated;
revoke all on table public.auth_attempt_counters from public, anon, authenticated;

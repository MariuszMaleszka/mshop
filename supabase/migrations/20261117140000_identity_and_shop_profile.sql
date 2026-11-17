-- Identity tables and the single shop tax profile.
-- updated_at is maintained by trigger, as required by the data model.

create function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

revoke all on function public.set_updated_at() from public;
revoke all on function public.set_updated_at() from anon;
revoke all on function public.set_updated_at() from authenticated;

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger profiles_set_updated_at
before update on public.profiles
for each row
execute function public.set_updated_at();

create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id)
  values (new.id);

  return new;
end;
$$;

revoke all on function public.handle_new_user() from public;
revoke all on function public.handle_new_user() from anon;
revoke all on function public.handle_new_user() from authenticated;

create trigger on_auth_user_created
after insert on auth.users
for each row
execute function public.handle_new_user();

create table public.user_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null,
  created_at timestamptz not null default now(),
  constraint user_roles_role_check check (role = 'admin'),
  constraint user_roles_user_id_role_key unique (user_id, role)
);

create table public.customers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users (id) on delete set null,
  customer_type text not null default 'individual',
  email text not null,
  phone text,
  first_name text,
  last_name text,
  company_name text,
  nip text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint customers_customer_type_check check (
    customer_type in ('individual', 'company')
  )
);

create unique index customers_user_id_key
on public.customers (user_id)
where user_id is not null;

create trigger customers_set_updated_at
before update on public.customers
for each row
execute function public.set_updated_at();

create table public.shop_profile (
  id boolean primary key default true,
  seller_tax_status text not null default 'unknown',
  updated_at timestamptz not null default now(),
  constraint shop_profile_id_check check (id = true),
  constraint shop_profile_seller_tax_status_check check (
    seller_tax_status in ('registered', 'exempt', 'unknown')
  )
);

create trigger shop_profile_set_updated_at
before update on public.shop_profile
for each row
execute function public.set_updated_at();

insert into public.shop_profile (id, seller_tax_status)
values (true, 'unknown');

alter table public.profiles enable row level security;
alter table public.customers enable row level security;
alter table public.user_roles enable row level security;
alter table public.shop_profile enable row level security;

revoke all on table public.profiles from public, anon, authenticated;
revoke all on table public.customers from public, anon, authenticated;
revoke all on table public.user_roles from public, anon, authenticated;
revoke all on table public.shop_profile from public, anon, authenticated;

grant select on table public.profiles to authenticated;
grant select on table public.customers to authenticated;

create policy profiles_select_own
on public.profiles
for select
to authenticated
using (id = (select auth.uid()));

create policy customers_select_own
on public.customers
for select
to authenticated
using (user_id = (select auth.uid()));

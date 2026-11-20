-- Account session tables are written by the DATABASE_URL role.
-- The Supabase Data API role service_role must not read or write them.
-- Default privileges in public grant service_role at table creation.
-- Those privileges do not return after this revoke.

revoke all on table public.account_sessions from service_role;
revoke all on table public.login_challenges from service_role;
revoke all on table public.auth_attempt_counters from service_role;

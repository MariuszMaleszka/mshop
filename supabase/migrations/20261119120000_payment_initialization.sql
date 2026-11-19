-- Przelewy24 initialization is separate from the financial payment status.
-- provider_transaction_id stays the operator transaction id, not the redirect token.
-- Existing cash and non-Przelewy24 rows keep both new columns null.
-- An existing Przelewy24 row has no stored redirect token, so it cannot become
-- registered. A transaction id means registration may already have happened.
-- A NULL status comparison is unknown, and CHECK rejects only false, so
-- Przelewy24 requires initialization_status IS NOT NULL.

alter table public.payments
  add column initialization_status text,
  add column redirect_token text;

update public.payments
set initialization_status = case
  when provider_transaction_id is null then 'not_started'
  else 'unknown'
end
where provider = 'przelewy24'
  and initialization_status is null;

alter table public.payments
  add constraint payments_initialization_check check (
    (
      method = 'cash'
      and initialization_status is null
      and redirect_token is null
    )
    or (
      method = 'online'
      and provider = 'stripe'
      and initialization_status is null
      and redirect_token is null
    )
    or (
      method = 'online'
      and provider = 'przelewy24'
      and initialization_status is not null
      and (
        (
          initialization_status = 'registered'
          and redirect_token is not null
          and btrim(redirect_token) <> ''
        )
        or (
          initialization_status in ('not_started', 'unknown', 'rejected')
          and redirect_token is null
        )
      )
    )
  );

-- Standard VAT is limited to 23.00, 8.00 and 5.00.
-- IS NOT NULL stays explicit: a NULL comparison would pass CHECK.
-- The applied snapshot still requires zero tax and net = gross
-- for zero_rated, exempt and not_subject.

alter table public.products
  drop constraint products_tax_check,
  add constraint products_tax_check check (
    (
      tax_status = 'standard'
      and vat_rate is not null
      and vat_rate in (23.00, 8.00, 5.00)
    )
    or (
      tax_status = 'zero_rated'
      and vat_rate is not null
      and vat_rate = 0.00
    )
    or (
      tax_status in ('exempt', 'not_subject')
      and vat_rate is null
    )
  );

alter table public.order_items
  drop constraint order_items_catalog_tax_check,
  add constraint order_items_catalog_tax_check check (
    (
      catalog_tax_status_snapshot = 'standard'
      and catalog_vat_rate_snapshot is not null
      and catalog_vat_rate_snapshot in (23.00, 8.00, 5.00)
    )
    or (
      catalog_tax_status_snapshot = 'zero_rated'
      and catalog_vat_rate_snapshot is not null
      and catalog_vat_rate_snapshot = 0.00
    )
    or (
      catalog_tax_status_snapshot in ('exempt', 'not_subject')
      and catalog_vat_rate_snapshot is null
    )
  );

alter table public.order_items
  drop constraint order_items_applied_tax_check,
  add constraint order_items_applied_tax_check check (
    (
      tax_status_snapshot = 'standard'
      and vat_rate_snapshot is not null
      and vat_rate_snapshot in (23.00, 8.00, 5.00)
    )
    or (
      tax_status_snapshot = 'zero_rated'
      and vat_rate_snapshot is not null
      and vat_rate_snapshot = 0.00
      and line_tax_amount = 0
      and line_net_amount = line_gross_amount
    )
    or (
      tax_status_snapshot in ('exempt', 'not_subject')
      and vat_rate_snapshot is null
      and line_tax_amount = 0
      and line_net_amount = line_gross_amount
    )
  );

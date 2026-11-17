# Roadmap

Statusy: `TODO`, `IN_PROGRESS`, `BLOCKED`, `DONE`.
Nie oznaczaj zadania jako DONE bez spełnienia kryteriów akceptacji.

## Phase 0 — Decyzje i przygotowanie
- [ ] Potwierdzić zakup gościnny czy tylko konta.
- [ ] Wybrać operatora płatności.
- [ ] Potwierdzić reguły VAT/ceny i dokumentów sprzedaży.
- [ ] Potwierdzić hosting i środowiska.
- [ ] Zatwierdzić model klienta i produktów.

## Phase 1 — Foundation
- [ ] Utworzyć monorepo pnpm.
- [ ] Dodać `apps/web` (Nuxt 4, JS).
- [ ] Dodać `apps/api` (Express, JS).
- [ ] Dodać `packages/shared`.
- [ ] Dodać konfigurację lint/format/test.
- [ ] Dodać health check API.
- [ ] Skonfigurować Supabase lokalnie/dev.
- [ ] Dodać `.env.example`.
- [ ] Skonfigurować CI dla lint/test/build.

Acceptance:
- `pnpm install` działa od root.
- web i api uruchamiają się lokalnie.
- API health endpoint zwraca 200.
- brak sekretów w repo.

## Phase 2 — Database foundation
- [ ] Dodać migracje: profiles, user_roles.
- [ ] Dodać customers i customer_addresses.
- [ ] Dodać categories, products, product_images.
- [ ] Dodać carts i cart_items.
- [ ] Dodać orders i order_items.
- [ ] Dodać payments, payment_events, status history.
- [ ] Włączyć RLS i dodać polityki.
- [ ] Dodać seed danych demonstracyjnych.

Acceptance:
- czysta baza może zostać utworzona z migracji.
- polityki są przetestowane dla anon/customer/admin.
- klient nie odczytuje danych innego klienta.

## Phase 3 — Authentication & authorization
- [ ] Skonfigurować Supabase Auth.
- [ ] Rejestracja/logowanie e-mail.
- [ ] Google OAuth.
- [ ] Apple OAuth.
- [ ] Odzyskiwanie hasła.
- [ ] Sesja w Nuxt.
- [ ] Middleware UI.
- [ ] Weryfikacja JWT w Express.
- [ ] Role customer/admin i ochrona endpointów.

Acceptance:
- logowanie i wylogowanie działają.
- token nie daje dostępu do cudzych danych.
- klient nie może nadać sobie admina.

## Phase 4 — Customer profiles
- [ ] Pobieranie profilu.
- [ ] Aktualizacja danych.
- [ ] Typ individual/company.
- [ ] Walidacja NIP i danych adresowych.
- [ ] CRUD adresów.

Acceptance:
- walidacja po stronie API.
- dane konta i dane klienta nie są mylone.
- testy dostępu do własnych zasobów.

## Phase 5 — Catalog
- [ ] Publiczna lista produktów.
- [ ] Szczegóły produktu po slug.
- [ ] Kategorie.
- [ ] Admin CRUD produktów.
- [ ] Admin CRUD kategorii.
- [ ] Upload zdjęć do Supabase Storage.
- [ ] Typy physical/digital/service.

Acceptance:
- publicznie widoczne są tylko aktywne produkty.
- admin CRUD działa.
- pliki mają prawidłowe uprawnienia.

## Phase 6 — Cart & checkout
- [ ] Koszyk gościa lub sesyjny.
- [ ] Koszyk klienta.
- [ ] Dodawanie/usuwanie/zmiana ilości.
- [ ] Ponowna walidacja cen i dostępności.
- [ ] Checkout.
- [ ] Snapshot danych klienta i produktów.
- [ ] Idempotency-Key.

Acceptance:
- nie można zmienić ceny przez payload frontendu.
- ponowiony checkout nie tworzy duplikatu.
- zamówienie ma kompletne snapshoty.

## Phase 7 — Payments
- [ ] Integracja operatora w trybie sandbox.
- [ ] Utworzenie transakcji.
- [ ] Weryfikacja webhooka.
- [ ] Idempotencja webhooków.
- [ ] Zgodność kwoty i waluty.
- [ ] Ręczne potwierdzenie gotówki.
- [ ] Obsługa nieudanej płatności.
- [ ] Zwrot, jeśli wspierany przez operatora.

Acceptance:
- status paid wyłącznie po wiarygodnym potwierdzeniu.
- powtórzony webhook nie duplikuje operacji.
- kwota i waluta są weryfikowane.

## Phase 8 — Orders & admin
- [ ] Lista zamówień klienta.
- [ ] Szczegóły zamówienia.
- [ ] Admin lista i szczegóły.
- [ ] Zmiana statusu realizacji.
- [ ] Historia statusów.
- [ ] Lista klientów.
- [ ] Widok płatności.
- [ ] Dashboard podstawowy.

Acceptance:
- klient widzi wyłącznie swoje zamówienia.
- admin ma dostęp zgodny z rolą.
- zmiany statusów są audytowalne.

## Phase 9 — Notifications
- [ ] Integracja dostawcy e-mail.
- [ ] Potwierdzenie zamówienia.
- [ ] Potwierdzenie płatności.
- [ ] Zmiana statusu.
- [ ] Log wysyłek i obsługa błędów.

Acceptance:
- e-mail nie jest wysyłany wielokrotnie przez retry tego samego zdarzenia.

## Phase 10 — Hardening & deployment
- [ ] Testy E2E kluczowych ścieżek.
- [ ] Rate limiting.
- [ ] CORS i security headers.
- [ ] Monitoring i logi.
- [ ] Backup/restore plan.
- [ ] Konfiguracja domen i HTTPS.
- [ ] Polityka prywatności, regulamin, cookies.
- [ ] Testy procesu płatności i zwrotu.
- [ ] Produkcyjny deployment.

Acceptance:
- krytyczne scenariusze są przetestowane.
- istnieje procedura odtworzenia danych.
- środowisko produkcyjne nie używa kluczy testowych.

## Po MVP — rozszerzenia
- [ ] Booking: terminy i dostępność usług.
- [ ] Galleries: prywatne galerie zdjęć.
- [ ] Digital delivery: bezpieczne pobieranie plików.
- [ ] Coupons: rabaty.
- [ ] Invoices: integracja fakturowania.
- [ ] Delivery: wysyłka fizycznych produktów.
- [ ] Multi-tenant: wiele sklepów.
- [ ] Subscriptions: płatności cykliczne.

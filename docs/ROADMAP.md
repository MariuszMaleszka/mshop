# Roadmap

Statusy: `TODO`, `IN_PROGRESS`, `BLOCKED`, `DONE`.
Nie oznaczaj zadania jako DONE bez spełnienia kryteriów akceptacji.

## Phase 0 — Decyzje i przygotowanie
- [x] Zakup gościnny jest dozwolony. Historia konta obejmuje zamówienia złożone po zalogowaniu.
- [ ] Wybrać operatora płatności (`przelewy24` albo `stripe`) i środowisko testowe.
- [x] Zatwierdzić model cen, waluty i VAT dla schematu (`docs/DATABASE.md`).
- [ ] Potwierdzić dokumenty sprzedaży, moment obowiązku podatkowego i retencję danych.
- [ ] Potwierdzić hosting i środowiska.
- [x] Zatwierdzić model klienta, adresu rozliczeniowego i produktów.

## Phase 1 — Foundation
- [x] Utworzyć monorepo pnpm.
- [x] Dodać `apps/web` (Nuxt 4, JS).
- [x] Dodać `apps/api` (Express, JS).
- [x] Dodać `packages/shared`.
- [x] Dodać konfigurację lint/format/test.
- [x] Dodać health check API.
- [x] Skonfigurować Supabase lokalnie/dev.
- [x] Dodać `.env.example`.
- [x] Skonfigurować CI dla lint/test/build.

Acceptance:
- `pnpm install` działa od root.
- web i api uruchamiają się lokalnie.
- API health endpoint zwraca 200.
- brak sekretów w repo.

## Phase 2 — Database foundation — DONE
Sześć kroków modelu bazodanowego jest zakończonych i zaakceptowanych na lokalnej bazie. Phase 3 nie jest rozpoczęta. Ta faza nie obejmuje checkoutu, webhooków ani API płatności.

- [x] Dodać `profiles`, `user_roles` (wyłącznie rola `admin`) i `shop_profile` z jednym wierszem `seller_tax_status = unknown`.
- [x] Dodać `customers`. `user_id` może być puste. Zgodny e-mail nie przypina zamówień gościa.
- [x] Dodać `categories` i `products` (`tax_status`, `vat_rate`, `currency`).
- [x] Dodać `carts` i `cart_items`: jeden właściciel, jeden aktywny koszyk, w bazie skrót sesji.
- [x] Dodać `orders`, `order_items` i `order_status_history`: rozdzielone statusy płatności i realizacji, sumy netto, VAT i brutto oraz oba snapshoty podatkowe.
- [x] Dodać `payments` i `payment_events`: jedna aktywna płatność, zgodność metody, waluty i kwoty z zamówieniem, zdarzenia operatora osobno od kluczy HTTP.
- [x] Dodać `idempotency_keys` z unikalnością `(właściciel, operation, idempotency_key)`.
- [x] Włączyć RLS na tabelach z tych migracji. Klient nie ma zapisu. Odczyt ma tylko tam, gdzie opisuje to `docs/DATABASE.md`.
- [ ] Dodać `customer_addresses` (tylko `billing`).
- [ ] Dodać `product_images`.
- [ ] Dodać `store_settings` bez danych fiskalnych i sekretów.
- [ ] Dodać seed demonstracyjny.

Acceptance spełnione dla sześciu migracji:
- czysta baza powstaje z migracji, łącznie z jednym wierszem `shop_profile`.
- check wiąże `tax_status` z `vat_rate`; waluta ma check formatu ISO 4217 i nie ma checka `= PLN`.
- klient nie odczytuje cudzych zamówień ani koszyka przez PostgREST.

Jeszcze otwarte: seed nie zawiera sekretów ani nadania roli `admin` przez rejestrację, bo seeda demonstracyjnego nie ma.

## Phase 3 — Authentication & authorization — nierozpoczęta
- [ ] Skonfigurować Supabase Auth.
- [ ] Rejestracja/logowanie e-mail.
- [ ] Google OAuth.
- [ ] Apple OAuth.
- [ ] Odzyskiwanie hasła.
- [ ] Sesja w Nuxt.
- [ ] Middleware UI.
- [ ] Weryfikacja JWT w Express.
- [ ] Rola `admin` w `user_roles` i ochrona endpointów. Brak wiersza oznacza klienta.

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
- [ ] `tax_status`, `vat_rate` i waluta produktu. Na MVP API przyjmuje tylko `PLN`.

Acceptance:
- publicznie widoczne są tylko aktywne produkty.
- admin CRUD działa.
- pliki mają prawidłowe uprawnienia.

## Phase 6 — Cart & checkout
- [ ] Koszyk gościa identyfikowany ciasteczkiem `httpOnly`; w bazie tylko skrót sekretu.
- [ ] Koszyk zalogowanego klienta i jeden aktywny koszyk na właściciela.
- [ ] Połączenie koszyka gościa z koszykiem konta po zalogowaniu.
- [ ] Dodawanie/usuwanie/zmiana ilości.
- [ ] Ponowna walidacja kwoty, dostępności i zgodności waluty.
- [ ] Checkout zablokowany przy `seller_tax_status = unknown`.
- [ ] Snapshot danych klienta, katalogu podatkowego i podatku zastosowanego.
- [ ] Sumy `net_amount`, `tax_amount` i `gross_amount`.
- [ ] Idempotency-Key.

Acceptance:
- nie można zmienić ceny, podatku ani waluty przez payload frontendu.
- ponowiony checkout nie tworzy duplikatu.
- zamówienie ma oba snapshoty podatkowe i walutę z chwili zakupu.
- przy statusie sprzedawcy `unknown` zamówienie nie powstaje.

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

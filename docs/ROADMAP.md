# Roadmap

Statusy: `TODO`, `IN_PROGRESS`, `BLOCKED`, `DONE`.
Nie oznaczaj zadania jako DONE bez spełnienia kryteriów akceptacji.

## Phase 0 — Decyzje i przygotowanie
- [x] Zakup gościnny jest dozwolony. Historia konta obejmuje zamówienia złożone po zalogowaniu.
- [x] Wybrać operatora płatności online MVP: Przelewy24. Stripe nie wchodzi do tej wersji. Sandboxowy checkout woła rejestrację po commicie. Produkcyjny checkout online pozostaje wyłączony.
- [ ] Podłączyć środowisko testowe Przelewy24.
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
Migracje modelu są w repozytorium. API checkoutu, webhooka i płatności sandboxowych jest rozpoczęte. Produkcyjny checkout online pozostaje wyłączony.

- [x] Dodać `profiles`, `user_roles` (wyłącznie rola `admin`) i `shop_profile` z jednym wierszem `seller_tax_status = unknown`.
- [x] Dodać `customers`. `user_id` może być puste. Zgodny e-mail nie przypina zamówień gościa.
- [x] Dodać `categories` i `products` (`tax_status`, `vat_rate`, `currency`).
- [x] Dodać `carts` i `cart_items`: jeden właściciel, jeden aktywny koszyk, w bazie skrót sesji.
- [x] Dodać `orders`, `order_items` i `order_status_history`: rozdzielone statusy płatności i realizacji, sumy netto, VAT i brutto oraz oba snapshoty podatkowe.
- [x] Dodać `payments` i `payment_events`: jedna aktywna płatność, zgodność metody, waluty i kwoty z zamówieniem, zdarzenia operatora osobno od kluczy HTTP.
- [x] Dodać `idempotency_keys` z unikalnością `(właściciel, operation, idempotency_key)`.
- [x] Dodać dane identyfikacyjne sprzedawcy w `shop_profile`. Wiersz `unknown` zostaje bez nazwy i NIP.
- [x] Dodać snapshot nazwy, NIP i adresu sprzedawcy w `orders`, przy pustej tabeli i bez klucza do `shop_profile`.
- [x] Ograniczyć stawkę `standard` do `23.00`, `8.00` i `5.00` w produkcie oraz obu snapshotach pozycji.
- [x] Dodać `inventory_reservations`: jedna rezerwacja na pozycję, termin zależny od `online` albo `cash`, RLS bez polityk klienta.
- [x] Włączyć RLS na tabelach z tych migracji. Klient nie ma zapisu. Odczyt ma tylko tam, gdzie opisuje to `docs/DATABASE.md`.
- [ ] Dodać `customer_addresses` (tylko `billing`).
- [ ] Dodać `product_images`.
- [ ] Dodać `store_settings` bez danych fiskalnych i sekretów.
- [ ] Dodać seed demonstracyjny.

Acceptance spełnione dla zastosowanych migracji:
- czysta baza powstaje z migracji, łącznie z jednym wierszem `shop_profile`.
- check wiąże `tax_status` z `vat_rate`; waluta ma check formatu ISO 4217 i nie ma checka `= PLN`.
- klient nie odczytuje cudzych zamówień ani koszyka przez PostgREST.

Jeszcze otwarte: seed demonstracyjny całego sklepu nie istnieje. Lokalny skrypt katalogu nie nadaje roli `admin`, nie zawiera sekretów i nie zastępuje tego seeda.

## Phase 3 — Authentication & authorization
Konfiguracja środowiska API, obsługa błędów HTTP, pula PostgreSQL, weryfikacja JWT, rola `admin` oraz walidacja żądań Zod są ukończone. W repozytorium są tabele sesji, szyfr tokenów i limiter PostgreSQL. Logowanie, ciasteczka i sesja Nuxt nie są rozpoczęte. Szczegóły sesji, czasy i test wyścigu są tylko w `docs/AUTH-SESSION.md`. Ten dokument nie jest zgodą na dalszą implementację.

- [x] Scentralizować konfigurację API i walidować zmienne środowiskowe przez Zod.
- [x] Ujednolicić błędy HTTP, identyfikator żądania i logowanie bez sekretów.
- [x] Dodać pulę `pg`, zamknięcie procesu i `GET /api/v1/health/ready`.
- [ ] Skonfigurować Supabase Auth.
- [ ] Sesja konta według `docs/AUTH-SESSION.md`, po osobnej zgodzie. Tabele, szyfr i limiter już są. Brakuje logowania, odświeżenia, wylogowania i BFF. Do tego czasu zostaje obecny Bearer oraz `requireAuth` i `requireAdmin`.
- [ ] Google OAuth.
- [ ] Apple OAuth.
- [ ] Odzyskiwanie hasła.
- [ ] Middleware UI tylko jako wygoda. Nie zastępuje Expressa.
- [x] Weryfikacja JWT w Express.
- [x] Sprawdzać rolę `admin` w `user_roles` przez `requireAdmin`. Brak wiersza oznacza klienta.
- [x] Dodać walidację żądań Zod, `req.validated` i paginację `page`/`limit`.

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
Publiczny odczyt aktywnych kategorii i produktów jest ukończony. Zapis, panel administratora i zdjęcia nie są rozpoczęte.

- [x] Publiczna lista produktów.
- [ ] Szczegóły produktu po slug.
- [x] Publiczne kategorie oraz szczegóły kategorii i produktu po UUID.
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
Ciasteczko sesji gościa, API koszyka gościa, API koszyka konta i jawne łączenie koszyków są ukończone. Checkout API jest rozpoczęty. Zamówienie gotówkowe powstaje bez operatora online. Checkout online działa tylko w sandboxie i po commicie woła rejestrację Przelewy24. Produkcyjny checkout online pozostaje wyłączony. Frontend ma katalog, koszyk gościa, formularz checkoutu gotówkowego i stronę odczytu zamówienia. Nie woła `POST /api/v1/cart/merge`, nie oferuje działającej płatności online i nie ma strony powrotu z Przelewy24. Schemat snapshotu sprzedawcy, stawek VAT i rezerwacji stanu jest w bazie. Checkout pozostaje zablokowany przy `seller_tax_status = unknown` oraz przy sprzedawcy `registered` i produkcie `standard` (`VAT_POLICY_NOT_CONFIRMED`). Nie startuje sprzedaży, dopóki dane sprzedawcy nie zostaną świadomie uzupełnione, a strategia VAT dla stawek standardowych nie zostanie zatwierdzona. Tymczasowa precyzja VAT jest opisana w `docs/DATABASE.md`. Agregacja i zaokrąglanie VAT na dokumentach mają status `OPEN — ACCOUNTANT CONFIRMATION REQUIRED` i nie są warunkiem zapisu tej decyzji. Pozostałe kwestie podatkowe i księgowe, w tym dokumenty sprzedaży, kasa fiskalna, ewidencja płatności oraz wpływ wysyłki i odbioru osobistego, są odłożone do konsultacji z księgowym w `docs/PROJECT_HANDOFF.md`. Nie blokują dalszych prac technicznych i nie są rozstrzygane przez kod.

- [x] Ustawiać ciasteczko `shop_guest_session` i liczyć skrót SHA-256. Wiersz `carts` powstaje przy pierwszej pozycji gościa.
- [x] Koszyk gościa identyfikowany ciasteczkiem `httpOnly`; w bazie tylko skrót sekretu.
- [x] Koszyk zalogowanego klienta i jeden aktywny koszyk na właściciela. Właścicielem jest `req.auth.userId`. Koszyk gościa nie jest przy tym łączony.
- [x] Połączenie koszyka gościa z koszykiem konta w API. `POST /api/v1/cart/merge` jest zaimplementowane. Sam token nie łączy koszyków.
- [ ] Wywołanie `POST /api/v1/cart/merge` z `apps/web` po zalogowaniu.
- [x] Dodawanie, usuwanie i zmiana ilości w koszyku gościa i w koszyku konta.
- [x] Ponowna walidacja kwoty, dostępności i zgodności waluty.
- [x] Checkout zablokowany przy `seller_tax_status = unknown`.
- [x] Snapshot danych klienta, katalogu podatkowego i podatku zastosowanego.
- [x] Sumy `net_amount`, `tax_amount` i `gross_amount`.
- [x] Idempotency-Key.

Acceptance:
- nie można zmienić ceny, podatku ani waluty przez payload frontendu.
- ponowiony checkout nie tworzy duplikatu.
- zamówienie ma oba snapshoty podatkowe i walutę z chwili zakupu.
- przy statusie sprzedawcy `unknown` zamówienie nie powstaje.

## Phase 7 — Payments
Checkout gotówkowy zapisuje zamówienie bez operatora online. Płatność zostaje `pending`, rezerwacja `active` bez terminu wygaśnięcia, a odbiór gotówki potwierdza `POST /api/v1/admin/orders/:id/mark-paid`: zmniejsza stan, oznacza rezerwację `consumed` i zostawia realizację `new`. Checkout online rejestruje transakcję sandboxową po commicie zamówienia. Produkcyjny checkout online pozostaje wyłączony. Webhook i `transaction/verify` są podłączone. Zapisany token sandboxu wraca jako stały adres panelu. Końcowe potwierdzenie tego hosta podczas testu sandbox pozostaje otwarte, podobnie jak lista definitywnych odmów weryfikacji oraz automatyczne odzyskanie `unknown` i `verification_requested`. Powrót przeglądarki nie potwierdza płatności. `paid` po wygaśnięciu rezerwacji nie przywraca stanu ani nie ustawia realizacji.

- [x] Integracja operatora w trybie sandbox, bez produkcyjnego uruchomienia.
- [x] Utworzenie transakcji po commicie zamówienia.
- [x] Weryfikacja webhooka podpisem i `transaction/verify`.
- [x] Idempotencja webhooków przez blokadę sesyjną i stan płatności, bez drugiego `verifyTransaction`.
- [x] Zgodność kwoty i waluty.
- [x] Ręczne potwierdzenie gotówki przez administratora. Nie dotyczy płatności Przelewy24. Realizacja zostaje `new`. Anulowanie nieopłaconej gotówki robi `POST /api/v1/admin/orders/:id/cancel` i nie zmniejsza stanu. Zwrot nadal nie jest zaimplementowany.
- [ ] Obsługa nieudanej płatności. Status inny niż dokładne `success` jest nierozstrzygnięty.
- [ ] Zwrot, jeśli wspierany przez operatora.

Acceptance:
- status paid wyłącznie po wiarygodnym potwierdzeniu.
- powtórzony webhook nie duplikuje operacji.
- kwota i waluta są weryfikowane.

## Phase 8 — Orders & admin
- [ ] Lista zamówień klienta.
- [x] Szczegóły jednego zamówienia: `GET /api/v1/orders/:id` i strona `/orders/{id}`. Odczyt nie oznacza zamówienia jako opłaconego.
- [x] Administracyjna lista zamówień: `GET /api/v1/admin/orders`. Odczyt z paginacją, filtrami i sortowaniem. Bez zmian danych.
- [x] Szczegóły zamówienia w API: `GET /api/v1/admin/orders/:id`. Odczyt snapshotu, płatności, rezerwacji, historii i zdarzeń. Bez rozstrzygania płatności.
- [x] Layout panelu i lista `/admin/orders` czytają API. Szczegóły w panelu pokazują skrót zamówienia. Logowanie administratora nie jest podłączone.
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
- [ ] Rate limiting pozostałych tras. Limiter logowania należy do fazy 3 i nie czeka na ten punkt.
- [ ] CORS i security headers. Pomiar CSP jest opisany w `docs/AUTH-SESSION.md`. Egzekwowanie czeka na przegląd naruszeń.
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

Wspólny model integracji jest opisany w `docs/INTEGRATIONS.md` i nie jest zaimplementowany. Pozycje fakturowania i wysyłki nie wybierają dostawcy. Płatność, dokument i utworzenie przesyłki nie mogą być ślepo ponawiane. Fiskalizacja zależy od odłożonej konsultacji z księgowym.

- [ ] Booking: terminy i dostępność usług.
- [ ] Galleries: prywatne galerie zdjęć.
- [ ] Digital delivery: bezpieczne pobieranie plików.
- [ ] Coupons: rabaty.
- [ ] Invoices: integracja fakturowania. Dostawca i KSeF nie są wybrani.
- [ ] Delivery: wysyłka fizycznych produktów. Broker kurierski nie jest wybrany.
- [ ] Wspólne trwałe zlecenia integracji i panel „Integracje”. Outbox i worker integracji nie istnieją. Worker rezerwacji ich nie zastępuje.
- [ ] Multi-tenant: wiele sklepów.
- [ ] Subscriptions: płatności cykliczne.

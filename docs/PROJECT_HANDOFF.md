# Punkt kontrolny projektu – sklep internetowy

**Stan na:** 17 listopada 2026, po wypchnięciu Step 9A  
**Status bieżący:** Phase 6 / Step 9A jest zaimplementowany i wypchnięty na `main`. Czeka na review i akceptację. Step 9B (koszyk gościa) nie jest rozpoczęty.

> Ten plik jest krótkim punktem wznowienia pracy dla Cursor i ChatGPT. Nie zastępuje dokumentacji technicznej projektu (`ARCHITECTURE.md`, `API.md`, `ROADMAP.md`) ani raportów z wykonania. W razie rozbieżności najpierw sprawdź aktualny kod i właściwą dokumentację projektu. Nie zakładaj, że opis w tym pliku jest nowszy niż repozytorium.

## 1. Jak wznowić pracę

Przed rozpoczęciem kolejnego zadania:

1. Przeczytaj ten plik.
2. Sprawdź aktualne `docs/ROADMAP.md`, `docs/ARCHITECTURE.md` i `docs/API.md` (jeśli istnieją w tych lokalizacjach).
3. Sprawdź aktualny stan Git i pliki zmienione przez poprzednie zadanie. Nie nadpisuj ani nie cofaj zmian użytkownika.
4. Poproś użytkownika o raport Cursor z poprzedniego kroku, jeśli nie został jeszcze przekazany.
5. Nie rozpoczynaj następnego kroku bez review i wyraźnej akceptacji użytkownika.

## 2. Zasady współpracy

- Komunikacja i prompty dla Cursor: po polsku.
- Pracujemy etapami, małymi i jasno ograniczonymi zadaniami.
- ChatGPT przygotowuje precyzyjne prompty; użytkownik uruchamia je w Cursor i przekazuje raport.
- Po każdym raporcie najpierw wykonaj review, wskaż ryzyka i ewentualne poprawki, a następnie poczekaj na akceptację.
- Nie przechodź do kolejnego kroku bez wyraźnej akceptacji użytkownika.
- Nie twierdź, że ChatGPT samodzielnie sprawdził repozytorium lub zmienił kod. Ocena implementacji opiera się na raporcie Cursor i dostarczonych plikach.
- Cursor działa jak senior engineer: minimalny zakres, tylko niezbędne pliki, bez niepotrzebnego refaktoringu i zależności.
- Projekt używa JavaScript, nie TypeScript.
- Nie wykonuj commitów, chyba że użytkownik wyraźnie o to poprosi.
- Każdy prompt powinien określać zakres plików, ograniczenia, testy, dokumentację i wymagany raport końcowy.
- Nie rozszerzaj zakresu zadania bez zgody użytkownika.

## 3. Technologie i architektura

- Monorepo zarządzane przez pnpm.
- Frontend: Nuxt 4, JavaScript.
- Backend: Node.js + Express 5, JavaScript ES modules.
- Baza danych: Supabase PostgreSQL.
- Uwierzytelnianie: Supabase Auth.
- Walidacja: Zod.
- Dostęp do PostgreSQL: `pg` po stronie backendu Express.
- Testy: `node:test`.
- CI: GitHub Actions.

### Zasady architektoniczne

- Express jest właścicielem logiki biznesowej.
- Frontend nie implementuje logiki biznesowej i nie ma dostępu do sekretów.
- Backend weryfikuje JWT Supabase przez JWKS i samodzielnie egzekwuje autoryzację.
- Rola administratora pochodzi z tabeli `user_roles`, nie z claimu JWT.
- `requireAdmin` sprawdza rolę w PostgreSQL.
- Połączenie `pg` może omijać RLS. Express musi jawnie egzekwować autoryzację i własność zasobów; RLS jest dodatkową warstwą ochrony.
- Nie używać Supabase `service_role` ani Supabase JS SDK na froncie.
- SQL musi być parametryzowany.
- Nie zwracać `SELECT *` z publicznych endpointów.
- Błędy API mają bezpieczny, wspólny format. Nie ujawniać stack trace, SQL, connection stringów, tokenów, haseł ani danych żądania.
- Nie logować tokenów, cookie, sekretów, request body ani danych osobowych.

## 4. Założenia biznesowe MVP

- Jeden sklep, bez marketplace i multi-tenancy.
- Rynek MVP: Polska.
- Waluta API MVP: PLN. Model bazy może obsługiwać kody ISO 4217, ale MVP nie wdraża przeliczania walut.
- Kwoty przechowywane jako integer w najmniejszej jednostce waluty (dla PLN grosze), nigdy jako float.
- Typy produktów: `physical`, `digital`, `service`.
- Jeden `category_id` na produkt.
- Gość może kupować bez konta.
- `customers.user_id` jest nullable.
- Koszyk gościa identyfikowany cookie `httpOnly`; w bazie przechowywany jest wyłącznie SHA-256 hash identyfikatora.
- Historia zamówień konta obejmuje wyłącznie zamówienia przypisane przez `orders.user_id`. Zgodność adresu e-mail nie powoduje automatycznego przejęcia zamówienia gościa.
- Zamówienie przechowuje snapshot produktu i danych rozliczeniowych.
- Status płatności i realizacji zamówienia są rozdzielone.
- Webhook operatora płatności jest źródłem prawdy o płatności online; wymaga weryfikacji podpisu, kwoty, waluty, zamówienia i idempotencji.
- Operator płatności nie został wybrany (rozważane Przelewy24 lub Stripe).
- Checkout, płatności i webhooki nie są jeszcze implementowane.
- MVP nie obejmuje wariantów produktów, wysyłki, rezerwacji, kuponów, zaawansowanego magazynu ani fakturowania.

## 5. Baza danych – Phase 2

Phase 2 jest zakończona. Wykonano sześć migracji:

1. `20261117140000_identity_and_shop_profile.sql`
2. `20261117150000_catalog_categories_and_products.sql`
3. `20261117160000_carts_and_cart_items.sql`
4. `20261117170000_orders_and_status_history.sql`
5. `20261117180000_payments_and_payment_events.sql`
6. `20261117190000_idempotency_keys.sql`

Istotne tabele: `profiles`, `user_roles`, `customers`, `shop_profile`, `categories`, `products`, `carts`, `cart_items`, `orders`, `order_items`, `order_status_history`, `payments`, `payment_events`, `idempotency_keys`.

Nie dodawaj migracji ani nie zmieniaj RLS bez jawnego zakresu i akceptacji użytkownika.

### Istotne reguły podatkowe

- `shop_profile.seller_tax_status`: `registered`, `exempt`, `unknown`; domyślnie `unknown`.
- Checkout ma być blokowany, gdy status podatkowy sprzedawcy jest `unknown`.
- Produkty mają `tax_status`: `standard`, `zero_rated`, `exempt`, `not_subject`.
- Przy sprzedawcy zwolnionym z VAT pozycja zamówienia ma mieć status `exempt` i `vat_rate = NULL`.
- Przed checkoutem trzeba precyzyjnie ustalić algorytm obliczania VAT od brutto z integerami i zaokrągleniem half-up na poziomie pozycji.
- Ustalono: `line_gross = unit_gross * quantity`; `line_gross = line_net + line_tax`; kwoty pozostają integerami.

## 6. Zakończone prace

### Phase 1 – fundament repozytorium

Zakończona: `apps/api` (Express 5, health endpoint), `apps/web` (Nuxt 4.6.4), `packages/shared`, Supabase config/migracje/seed, Node 22.23.5, pnpm 10.34.9, skrypty root i GitHub Actions CI.

### Phase 3 – backend

- Step 1 – konfiguracja: zakończony.
- Step 2 – HTTP foundations: zakończony.
- Step 3 – PostgreSQL: zakończony.
- Step 4 – JWT Supabase: zakończony.
- Step 5 – autoryzacja administratora: zakończony.
- Step 6 – Zod i paginacja: zakończony.
- Step 7 – publiczny katalog: zakończony.
- Step 8 – sesja gościa: zaimplementowany i zaakceptowany przez użytkownika.
- Step 9A – wzmocnienie parsera i redakcji sesji gościa: zaimplementowany i wypchnięty; akceptacja użytkownika jeszcze nie padła.

### Step 8 – istniejąca sesja gościa

- Publiczny endpoint: `POST /api/v1/session/guest`.
- Cookie: `shop_guest_session`.
- Identyfikator: 32 losowe bajty z `node:crypto`, 64 znaki lowercase hex.
- Surowy identyfikator wyłącznie w HttpOnly cookie; helper SHA-256 zwraca hash do późniejszego użycia w DB.
- Cookie: `httpOnly`, `sameSite: 'lax'`, `path: '/'`, maxAge 30 dni, `secure` tylko w produkcji, bez `domain`.
- Poprawne cookie jest zachowywane, a jego ważność odnawiana; brak lub niepoprawne cookie powoduje wygenerowanie nowego identyfikatora.
- Odpowiedź nie ujawnia identyfikatora ani hasha.
- Step 8 nie tworzył rekordu koszyka, nie dodawał globalnego middleware sesji, migracji ani zmian RLS.
- Z raportu Cursor: 92 testy przechodziły; ESLint dla sesji był czysty.

## 7. Bieżący status – punkt wznowienia

### Phase 6 / Step 9A – wzmocnienie bezpieczeństwa sesji gościa

**Status: zaimplementowany i wypchnięty. Review i akceptacja użytkownika są następną czynnością. Koszyka nie zaczynać.**

Zrobione:

1. `readGuestSessionId` przyjmuje dokładnie jedno wystąpienie `shop_guest_session`. Dwa lub więcej, także o identycznej wartości, dają `null` i nowy identyfikator. Nie jest wybierana pierwsza ani ostatnia wartość.
2. Walidacja bez zmian: 32 bajty z `randomBytes`, dokładnie 64 znaki `[0-9a-f]`, jedno `decodeURIComponent`. Cudzysłów, wielkie litery, długość 63/65 i złe `%` odrzucają ciasteczko. Pojedynczy hex w formie URL-encoded zostaje.
3. Nazwa, flagi i odnawianie ważności bez zmian. Brak prefiksu `__Host-`. `routes.js` nie wymagał zmiany.
4. Logger nadal redaguje `postgres://`, `Bearer` oraz `password|secret|token|api_key`. Dodatkowo wycina wartość stojącą przy nazwie `shop_guest_session`, także po `JSON.stringify`. Sam 64-znakowy hex bez tej nazwy nie jest wycinany.
5. `docs/API.md` opisuje, że duplikat powoduje nowe losowanie. Status koszyka w roadmapie bez zmian.

Pliki kroku: `apps/api/src/session/guest-session.js`, `apps/api/src/http/logger.js`, `apps/api/test/guest-session.test.js`, `docs/API.md`.

Weryfikacja przed wypchnięciem: `pnpm --filter @shop/api test` — 103 testy, 0 niepowodzeń. ESLint i Prettier na zmienionych plikach były czyste.

**Następna czynność jutro:** review Step 9A. Po akceptacji przygotować plan Step 9B. Nie implementować koszyka, CORS, `__Host-` ani merge bez osobnej zgody.

Otwarte po 9A, świadomie odłożone: prefiks `__Host-`, credentialed CORS, `SameSite=Lax` przy osobnych domenach, redakcja gołego identyfikatora bez nazwy ciasteczka.

## 8. Zatwierdzony plan po Step 9A

### Step 9B – API koszyka gościa

Po akceptacji Step 9A przygotować osobny prompt dla implementacji wyłącznie koszyka gościa:

- `GET /api/v1/cart`
- `POST /api/v1/cart/items`
- `PATCH /api/v1/cart/items/:id`
- `DELETE /api/v1/cart/items/:id`

Założenia do zachowania:

- Wykorzystać istniejące tabele `carts` i `cart_items`; przed implementacją sprawdzić dokładny schemat migracji, nie zgadywać nazw kolumn ani ograniczeń.
- Właściciel koszyka identyfikowany po stronie backendu na podstawie hasha SHA-256 z cookie.
- Surowy identyfikator sesji nie trafia do bazy, JSON ani logów.
- Frontend nie przekazuje właściciela koszyka.
- Backend sprawdza aktywność produktu, ilość, cenę i walutę na podstawie danych w bazie.
- Nie ufać cenie, podatkom ani walucie przesłanym przez klienta.
- API MVP obsługuje PLN.
- Wszystkie kwoty są integerami w groszach.
- Jawna kontrola własności zasobów w Express; nie polegać wyłącznie na RLS.
- Parametryzowany SQL i transakcje tam, gdzie wymagane.
- Testy izolacji koszyków różnych gości, walidacji, braku produktu/nieaktywnego produktu i przypadków brzegowych.

**Poza zakresem Step 9B:**
- Koszyk zalogowanego użytkownika.
- Łączenie koszyków.
- Logowanie/rejestracja.
- Checkout i płatności.
- Frontend koszyka, chyba że użytkownik osobno zatwierdzi ten zakres.

### Step 9C – review koszyka

Po implementacji Step 9B: osobny przegląd testów, bezpieczeństwa, transakcji, własności i dokumentacji. Nie rozpoczynać kolejnego etapu bez akceptacji.

### Późniejsze, osobne etapy

1. Koszyk zalogowanego użytkownika – identyfikacja przez zweryfikowany JWT i `user_id`.
2. Łączenie koszyka gościa z koszykiem konta – osobny projekt i decyzja o regule merge. Użytkownik zaakceptował, że merge będzie osobnym późniejszym krokiem.
3. Integracja frontendu i obsługa CORS/cookie credentials – po ustaleniu domen i sposobu wdrożenia.
4. Checkout, VAT, płatności i webhooki – dopiero po rozstrzygnięciu otwartych decyzji.

## 9. Otwarte decyzje na przyszłość

- Dokładny algorytm VAT integer/half-up przed checkoutem.
- Wybór operatora płatności: Przelewy24 lub Stripe.
- Szczegóły wysyłki i obsługi produktów fizycznych.
- Fakturowanie i dokumenty sprzedażowe.
- Retencja danych.
- Hosting i domeny produkcyjne.
- Ograniczone uprawnienia użytkownika DB zamiast uprzywilejowanego połączenia `pg`.
- CORS i `credentials: 'include'` po ustaleniu domen. Obecnie credentialed CORS nie jest skonfigurowany; przy cookie przeglądarkowym wymagane będzie dokładne dozwolone Origin i `Access-Control-Allow-Credentials: true`.

## 10. Instrukcja dla Cursor przy wznowieniu

Nie wykonuj samodzielnie żadnych zmian tylko dlatego, że przeczytałeś ten plik.

Step 9A jest już w `main` i nie został jeszcze zaakceptowany. Jutro zacznij od review tego kroku. Nie rozpoczynaj Step 9B, dopóki użytkownik go nie zaakceptuje.

Jeśli użytkownik zaakceptuje Step 9A, przygotuj plan Step 9B zgodnie z sekcją 8 i poczekaj na zgodę przed implementacją. Nie implementuj zakresu, którego użytkownik wyraźnie nie zatwierdził.

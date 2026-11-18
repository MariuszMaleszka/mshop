# Punkt kontrolny projektu – sklep internetowy

**Stan na:** 18 listopada 2026, po Step 11B.2  
**Status bieżący:** Koszyk gościa i koszyk konta są ukończone i są na `main` (`2cbb056`). Wspólny protokół blokad oraz `POST /api/v1/cart/merge` są zaimplementowane i przetestowane w drzewie roboczym; nie są jeszcze zacommitowane. Checkout, zamówienia, płatności i webhooki nie są rozpoczęte.

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
- Koszyk konta identyfikowany wyłącznie przez `req.auth.userId` ze zweryfikowanego JWT. Na czterech ścieżkach koszyka ciasteczko gościa go nie wybiera. Oba koszyki mogą istnieć jednocześnie.
- Jawne `POST /api/v1/cart/merge` łączy koszyk gościa z koszykiem konta po zalogowaniu. Sam token tego nie robi. Ciasteczko `shop_guest_session` nie jest przy scalaniu ustawiane, usuwane ani odnawiane.
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
- Step 9A – wzmocnienie parsera i redakcji sesji gościa: ukończony. Jest na `main` w `d97c65a`.
- Step 9B i 9B.1 – API koszyka gościa, wyścig tworzenia koszyka i kwoty: ukończone. Są na `main` w `908ffca`.
- Step 9C – audyt koszyka gościa: wykonany. Brak ustaleń krytycznych, wysokich i średnich. Krok można zamknąć.
- Step 10B – koszyk konta na tych samych czterech ścieżkach: ukończony. Jest na `main` w `36972c1`.
- Step 10C – audyt koszyka konta i gościa: wykonany. Brak ustaleń krytycznych, wysokich i średnich. Krok można zamknąć.
- Step 11B.1 – wspólny protokół blokad doradczych dla sześciu operacji modyfikujących koszyk: ukończony w drzewie roboczym.
- Step 11B.2 – `POST /api/v1/cart/merge`: zaimplementowany i przetestowany w drzewie roboczym. Frontend jeszcze go nie wywołuje.

### Step 8 – istniejąca sesja gościa

- Publiczny endpoint: `POST /api/v1/session/guest`.
- Cookie: `shop_guest_session`.
- Identyfikator: 32 losowe bajty z `node:crypto`, 64 znaki lowercase hex.
- Surowy identyfikator wyłącznie w HttpOnly cookie. SHA-256 tego identyfikatora jest zapisywany w `carts.session_id` przez API koszyka.
- Cookie: `httpOnly`, `sameSite: 'lax'`, `path: '/'`, maxAge 30 dni, `secure` tylko w produkcji, bez `domain`.
- Poprawne cookie jest zachowywane, a jego ważność odnawiana; brak lub niepoprawne cookie powoduje wygenerowanie nowego identyfikatora.
- Odpowiedź nie ujawnia identyfikatora ani hasha.
- Sam endpoint sesji nie tworzy wiersza koszyka i nie jest globalnym middleware. Wiersz `carts` powstaje przy pierwszej pozycji przez API koszyka.

## 7. Bieżący status – punkt wznowienia

### Phase 6 – koszyk gościa, koszyk konta i scalanie

**Status: oba koszyki są ukończone i są na `main`. Blokady i scalanie są ukończone lokalnie. Nie implementować żadnego z nich ponownie.**

Te same endpointy:

- `GET /api/v1/cart`
- `POST /api/v1/cart/items`
- `PATCH /api/v1/cart/items/:id`
- `DELETE /api/v1/cart/items/:id`

Wybór właściciela:

1. Brak nagłówka `Authorization` zostawia koszyk gościa. Wymagane jest jedno poprawne ciasteczko. W SQL jest skrót, `user_id IS NULL` i `status = 'active'`.
2. Obecność nagłówka wybiera koszyk konta i przechodzi przez `requireAuth`. Zły token daje HTTP 401 i nie otwiera koszyka gościa.
3. Właścicielem konta jest wyłącznie `req.auth.userId`. SQL ma `session_id IS NULL` i `status = 'active'`. Ciasteczko nie jest wtedy czytane.
4. Cena i waluta schodzą z katalogu. MVP przyjmuje tylko `PLN`. Kwoty są liczbami całkowitymi w groszach.
5. Dodanie i zmiana ilości idą jedną transakcją: `INSERT ... ON CONFLICT DO NOTHING`, potem `SELECT ... FOR UPDATE`, a suma jest liczona jako `BigInt` przed zapisem pozycji.
6. Sześć operacji modyfikujących bierze najpierw transakcyjną blokadę właściciela: gość `71001`, konto `71002`. `GET` tej blokady nie bierze. Usunięcie gościa i konta też jest w transakcji.
7. Kwota poza bezpiecznym integerem JavaScriptu daje HTTP 400 i wycofanie transakcji. Przekroczenie zakresu ilości daje HTTP 400 i nie zapisuje nowej ilości.
8. Cudza albo nieznana pozycja daje HTTP 404. Te cztery ścieżki same koszyków nie scalają.

`POST /api/v1/cart/merge` wymaga `requireAuth`. Gościa rozpoznaje po jednym poprawnym `shop_guest_session` i istniejącym `hashGuestSessionId`. Brak, zły format albo wielokrotne ciasteczko zwraca aktualny koszyk konta i nie tworzy sesji ani wiersza. W jednej transakcji blokada gościa poprzedza blokadę konta, a potem blokowany jest rekord koszyka gościa.

- Brak pozycji: koszyk gościa zostaje `active`, nowy koszyk konta nie powstaje.
- Są pozycje i nie ma koszyka konta: ten sam wiersz dostaje `user_id`, `session_id` staje się puste, status zostaje `active`.
- Oba koszyki istnieją: ilości wspólnych produktów są sumowane, pozostałe pozycje gościa są dopisywane, a koszyk gościa dostaje `abandoned` z tym samym `session_id` i pustym `user_id`.
- Produkty nieaktywne też przechodzą. Waluta inna niż `PLN` oraz przekroczenie ilości albo bezpiecznej kwoty wycofuje całe scalanie.

Ostatnia weryfikacja: `pnpm --filter @shop/api test` — 183 testy, 0 niepowodzeń, 0 pominiętych. Testy integracyjne w `apps/api/test/cart.integration.test.js` wykonały się na lokalnym PostgreSQL, łącznie z wyścigami opartymi o `pg_locks`.

**Następna czynność:** czekać na decyzję użytkownika. Nie zaczynać CORS, `__Host-`, checkoutu, zamówień, płatności ani webhooków bez osobnej zgody. Nie podłączać scalania we frontendzie bez osobnej zgody.

Świadomie odłożone: prefiks `__Host-`, credentialed CORS, `SameSite=Lax` przy osobnych domenach, redakcja gołego skrótu bez nazwy ciasteczka.

## 8. Co pozostaje po scaleniu koszyków

Koszyk gościa, koszyk konta, protokół blokad i `POST /api/v1/cart/merge` nie są już zadaniami do zaplanowania. Poniższe etapy są osobne i niezacząte.

### Późniejsze, osobne etapy

1. Integracja frontendu i obsługa CORS/cookie credentials – po ustaleniu domen i sposobu wdrożenia. Frontend nie wywołuje jeszcze `POST /api/v1/cart/merge`.
2. Checkout, zamówienia, VAT, płatności i webhooki – nadal niezaimplementowane. Dopiero po rozstrzygnięciu otwartych decyzji.

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

Koszyk gościa i koszyk konta są ukończone i są na `main`. Protokół blokad oraz `POST /api/v1/cart/merge` są ukończone w drzewie roboczym. Nie traktuj żadnego z nich jako pracy w toku i nie implementuj ich od nowa.

Następny etap wybiera użytkownik. Bez osobnej zgody nie zaczynaj logowania, checkoutu, zamówień, płatności, webhooków, frontendu ani CORS.

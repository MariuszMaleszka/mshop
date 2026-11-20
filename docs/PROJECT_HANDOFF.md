# Punkt kontrolny projektu – sklep internetowy

**Stan na:** 20 listopada 2026, po Step 12E.22  
**Status bieżący:** Checkout gotówkowy i sandboxowy checkout online są na `main`. Rejestracja Przelewy24 następuje po commicie zamówienia. Webhook jest podłączony i potwierdza płatność przez `transaction/verify`. Produkcyjny checkout online pozostaje wyłączony. Rezerwacje online wygasają po 15 minutach od utworzenia zamówienia i spóźniona płatność ich nie przywraca ani nie rozwiązuje realizacji. Stany `unknown` oraz `verification_requested` bez `verification_accepted` wymagają ręcznego uzgodnienia z `docs/P24_RECONCILIATION.md`. Storefront ma katalog, koszyk gościa, formularz checkoutu gotówkowego i odczyt zamówienia. Checkout nadal blokują `SELLER_TAX_STATUS_UNKNOWN` i `VAT_POLICY_NOT_CONFIRMED`. Odbiór gotówki potwierdza wyłącznie administrator przez `POST /api/v1/admin/orders/:id/mark-paid`. Operacja zmniejsza stan i ustawia rezerwację na `consumed`. Realizacja zostaje `new`. Anulowanie nieopłaconej gotówki robi administrator przez `POST /api/v1/admin/orders/:id/cancel`. Listę zamówień czyta `GET /api/v1/admin/orders`, a szczegóły `GET /api/v1/admin/orders/:id`. Panel Nuxt ma `/admin/orders` i skrót szczegółów. Nie ma logowania administratora. Szczegóły nie wołają operatora i nie zwracają payloadu zdarzenia ani tokenu przekierowania. Zwrot nadal nie jest zaimplementowany. Strategia VAT dla stawek standardowych pozostaje nierozstrzygnięta.

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
- Sesja konta nie jest zaimplementowana. Jedyny opis jest w `docs/AUTH-SESSION.md`. Bez osobnej zgody nie wolno jej wdrażać. Gość zostaje przy `shop_guest_session`. Administrator nie dostaje osobnej tożsamości.

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
- Webhook operatora płatności jest źródłem prawdy o płatności online. Wymaga podpisu, kwoty, waluty i zgodności zamówienia. Powrót przeglądarki płatności nie potwierdza. `verification_requested` powstaje przed HTTP, a `verification_accepted` razem z `paid` tylko przy dokładnym statusie `success`. Inny status zostaje nierozstrzygnięty i nie zapisuje `verification_declined`. Drugiego `verifyTransaction` nie ma.
- Operatorem płatności online w MVP jest Przelewy24. Stripe nie wchodzi do tej wersji. Checkout online działa tylko w sandboxie i woła rejestrację po commicie. Produkcyjny checkout online pozostaje wyłączony. Integracja zostaje jednym adapterem, bez systemu wielu operatorów na zapas.
- MVP nie obejmuje wariantów produktów, wysyłki, rezerwacji terminów, kuponów, zaawansowanego magazynu ani fakturowania. Tabela `inventory_reservations` jest schematem rezerwacji stanu przy checkoutcie, nie rezerwacją terminów.

## 5. Baza danych – Phase 2

Phase 2 ma migracje w repozytorium, łącznie z inicjalizacją płatności Przelewy24. Lokalna baza to PostgreSQL 17.12 (`127.0.0.1:54322`). Supabase CLI 3.2.0 jest zależnością developerską katalogu głównego. Nowe migracje nanosi się przez `pnpm exec supabase migration up`. Nie używać `db reset`, `db push` ani zdalnego projektu. W `migration list` pole historii przy celu lokalnym oznacza tę bazę, nie hostowany Supabase.

1. `20261117140000_identity_and_shop_profile.sql`
2. `20261117150000_catalog_categories_and_products.sql`
3. `20261117160000_carts_and_cart_items.sql`
4. `20261117170000_orders_and_status_history.sql`
5. `20261117180000_payments_and_payment_events.sql`
6. `20261117190000_idempotency_keys.sql`
7. `20261118100000_shop_profile_seller_identity.sql`
8. `20261118100100_order_seller_snapshot.sql`
9. `20261118100200_standard_vat_rates.sql`
10. `20261118100300_inventory_reservations.sql`
11. `20261119120000_payment_initialization.sql`

Istotne tabele: `profiles`, `user_roles`, `customers`, `shop_profile`, `categories`, `products`, `carts`, `cart_items`, `orders`, `order_items`, `order_status_history`, `payments`, `payment_events`, `idempotency_keys`, `inventory_reservations`.

Nie dodawaj migracji ani nie zmieniaj RLS bez jawnego zakresu i akceptacji użytkownika.

### Istotne reguły podatkowe

- `shop_profile.seller_tax_status`: `registered`, `exempt`, `unknown`; domyślnie `unknown`. Istniejący wiersz został `unknown`, bez nazwy i NIP, z krajem `PL`.
- Przy `registered` i `exempt` nazwa, NIP, ulica, numer budynku, kod pocztowy i miasto są wymagane. NIP to 10 cyfr, kod to `NN-NNN`, kraj to dwie wielkie litery.
- Checkout ma być blokowany, gdy status podatkowy sprzedawcy jest `unknown`.
- Produkty mają `tax_status`: `standard`, `zero_rated`, `exempt`, `not_subject`.
- `standard` w produkcie, snapshocie katalogowym i snapshocie zastosowanym dopuszcza tylko `23.00`, `8.00` i `5.00`, z jawnym `IS NOT NULL`. `zero_rated` to `0.00`. `exempt` i `not_subject` mają stawkę `NULL`.
- Przy sprzedawcy zwolnionym z VAT pozycja zamówienia ma mieć status `exempt` i `vat_rate = NULL`. Snapshot katalogowy zostaje stawką produktu.
- Zamówienie ma snapshot nazwy, NIP i adresu sprzedawcy. Kolumny są `NOT NULL` i doszły przy pustej tabeli `orders`. Nie ma klucza obcego do `shop_profile`.
- Baza nie liczy VAT. Tymczasowa polityka techniczna, niezatwierdzona księgowo: cena katalogowa jest brutto i ma dokładność dwóch miejsc po przecinku, w bazie jako grosze. VAT od stawki procentowej liczy się „w stu”: brutto × stawka / (100 + stawka), bez zaokrąglania wyników pośrednich. VAT wykazywany w dokumentach zaokrągla się do grosza metodą half-up, a netto jest różnicą brutto i tego VAT. Arytmetyka ma być dziesiętna albo całkowita, nie zwykłym `Number` JavaScriptu. Kalkulator jest w `apps/api/src/order-amounts/calculate.js` i liczy na `BigInt`. Obsługuje strategie `per_line` i `per_rate`. To nie jest zatwierdzona produkcyjna polityka VAT dla sprzedawcy zarejestrowanego jako podatnik VAT. Sposób rozliczania VAT nadal wymaga potwierdzenia księgowego.
- Ustalono: `line_gross = unit_gross * quantity`; `line_gross = line_net + line_tax`; kwoty pozostają integerami.
- `inventory_reservations`: jedna rezerwacja na pozycję. Aktywna wymaga produktu. Aktywna `online` wymaga `expires_at`, aktywna `cash` wymaga pustego `expires_at`. Metoda jest kopią `orders.payment_method` i jest spięta kluczem `(order_id, payment_method)`.
- PostgreSQL 17.12 nie przyjmuje `ON UPDATE SET NULL` z listą kolumn. Złożony klucz rezerwacji używa `ON UPDATE CASCADE` i `ON DELETE SET NULL (product_id)`. Usunięcie produktu przy rezerwacji terminalnej zeruje `product_id` i zostawia `order_item_id`. Przy statusie `active` ten zapis odrzuca check i całe usunięcie produktu się wycofuje.
- Worker wygaszania działa jako osobny proces: należne rezerwacje online całego zamówienia oznacza jako `expired` i nie zmienia stanu produktu. Termin 15 minut liczy się od commitu checkoutu. Konsumpcja stanu przy `completed` nie jest zaimplementowana.

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
- Step 11B.1 – wspólny protokół blokad doradczych dla sześciu operacji modyfikujących koszyk: ukończony. Jest na `main` w `43e6e21`.
- Step 11B.2 – `POST /api/v1/cart/merge`: ukończony. Jest na `main` w `43e6e21`. Frontend jeszcze go nie wywołuje.
- Step 12C.1–12C.4 – tożsamość sprzedawcy, snapshot zamówienia, stawki VAT 23/8/5 i `inventory_reservations`: migracje są w repozytorium. Checkout, worker i webhook ich używają.
- Step 12E – sandboxowy checkout online, worker wygaszania i webhook Przelewy24 są na `main` (`315c438`). Produkcyjny checkout online pozostaje wyłączony.

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

**Status: oba koszyki, blokady i scalanie są ukończone i są na `main` (`43e6e21`). Nie implementować żadnego z nich ponownie.**

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

Ostatnia weryfikacja po migracji rezerwacji: `pnpm test` — 183 testy, 0 niepowodzeń, 0 pominiętych; `pnpm lint` i `pnpm format:check` czyste. Testy integracyjne koszyka w `apps/api/test/cart.integration.test.js` obejmują wyścigi oparte o `pg_locks`.

**Następna czynność:** czekać na decyzję użytkownika. Checkout, worker, webhook P24, odczyt jednego zamówienia i gotówkowy formularz są już na `main`. Nie implementować ich od nowa. Nie włączać produkcyjnego checkoutu online. Nie podłączać scalania we frontendzie bez osobnej zgody. Nie powtarzać migracji. Nie obchodzić blokad sprzedawcy i VAT.

Świadomie odłożone: prefiks `__Host-`, `SameSite=Lax` przy osobnych domenach, redakcja gołego skrótu bez nazwy ciasteczka. Credentialed CORS działa dla dokładnego `WEB_ORIGIN`.

## 8. Co pozostaje po scaleniu koszyków

Koszyk gościa, koszyk konta, protokół blokad i `POST /api/v1/cart/merge` nie są już zadaniami do zaplanowania. Poniższe etapy pozostają otwarte. Część frontendu jest już zrobiona i nie jest osobnym, niezaczątym zadaniem.

### Późniejsze, osobne etapy

1. Dokończenie frontendu. Credentialed CORS dla dokładnego `WEB_ORIGIN` jest włączony. Frontend ma katalog, koszyk gościa, formularz `cash` i stronę `/orders/{id}`. Nadal nie wywołuje `POST /api/v1/cart/merge`. Nie ma płatności online w formularzu ani strony powrotu z Przelewy24. Powrót przeglądarki nie potwierdza płatności.
2. Dokończenie płatności online poza sandboxem. API checkoutu, workera i webhooka jest na `main`. Checkout online działa tylko w sandboxie. Zapisany token wraca jako stały `https://sandbox.przelewy24.pl/trnRequest/{TOKEN}`; host wymaga końcowego potwierdzenia podczas testu sandbox, bo specyfikacja REST 1.0.18 podaje bezpośrednio tylko adres produkcyjny. Stany `unknown` oraz `verification_requested` bez `verification_accepted` nie odzyskują się same; procedura jest w `docs/P24_RECONCILIATION.md`. Checkout nadal blokuje `seller_tax_status = unknown` oraz `registered` ze stawką `standard`. `paid` po wygaśnięciu rezerwacji nie rozwiązuje realizacji. Gotówkę potwierdza `POST /api/v1/admin/orders/:id/mark-paid`. Nieopłaconą gotówkę anuluje `POST /api/v1/admin/orders/:id/cancel`. Zwrot nadal nie istnieje. Przed dokumentami sprzedaży zostaje otwarte potwierdzenie księgowe agregacji VAT.

## 9. Otwarte decyzje na przyszłość

- Przelewy24 — decyzja podjęta. Jedyny operator online w MVP. Stripe nie jest implementowany. Schemat nadal dopuszcza `stripe`, żeby później dodać adapter bez zmiany tej decyzji.
- Model pozostałych integracji — założenie opisane w `docs/INTEGRATIONS.md`, niezaimplementowane. mshop zostaje źródłem prawdy dla zamówienia, magazynu i realizacji. Dostawcy poza Przelewy24 nie są wybrani. Outbox, worker integracji i panel „Integracje” nie istnieją. Nie refaktoryzować P24 na generyczny adapter bez osobnej zgody. Nie ponawiać `transaction/register` ani `transaction/verify`.
- Polityka precyzji VAT — decyzja techniczna podjęta tymczasowo. Opis jest w `docs/DATABASE.md`. To nie jest zatwierdzona polityka księgowa.
- Konsultacja z księgowym jest odłożona. Implementacja nie rozstrzyga poniższych punktów i nie traktuje wartości domyślnych schematu, pustych pól ani lokalnego katalogu testowego jako decyzji. Nie blokują dalszych prac technicznych. Blokują ostateczne uruchomienie sprzedaży w zakresie, którego dotyczą.
  1. Status podatkowy sprzedawcy zostaje `unknown`, dopóki nie zostanie potwierdzony. Checkout przy `unknown` nie tworzy zamówienia.
  2. Dane identyfikacyjne sprzedawcy i jego status VAT nie są ustalone. `registered` i `exempt` nie są wyborem domyślnym.
  3. Klasyfikacja produktów i właściwe stawki VAT nie są ustalone.
  4. Metoda naliczania i zaokrąglania VAT pozostaje `per_line` albo `per_rate`, bez wyboru. Szczegół techniczny jest w `docs/DATABASE.md` jako `OPEN — ACCOUNTANT CONFIRMATION REQUIRED`.
  5. Rodzaje dokumentów sprzedaży dla osób prywatnych i firm nie są ustalone. Brak fakturowania w MVP nie wybiera rodzaju dokumentu.
  6. Obowiązek stosowania kasy fiskalnej i ewentualne zwolnienia nie są ustalone.
  7. Wymagania ewidencyjne dla płatności gotówkowych i internetowych nie są ustalone.
  8. Wpływ wysyłki i odbioru osobistego na dokumentowanie sprzedaży nie jest ustalony. Brak modułu dostawy nie jest decyzją o dokumentowaniu.
- Szczegóły operacyjne wysyłki i obsługi produktów fizycznych pozostają osobno od punktu 8.
- Retencja danych.
- Hosting i domeny produkcyjne.
- Ograniczone uprawnienia użytkownika DB zamiast uprzywilejowanego połączenia `pg`.
- Domeny produkcyjne muszą być ustawione jako dokładny `WEB_ORIGIN`. Lokalny CORS zezwala na `http://localhost:3000`, `Access-Control-Allow-Credentials: true` i nagłówek `Idempotency-Key`. Wildcard originu nie jest używany.

## 10. Instrukcja dla Cursor przy wznowieniu

Nie wykonuj samodzielnie żadnych zmian tylko dlatego, że przeczytałeś ten plik.

Koszyk gościa, koszyk konta, protokół blokad i `POST /api/v1/cart/merge` są ukończone na `main`. Cztery migracje 12C też są ukończone. Nie traktuj ich jako pracy w toku i nie implementuj ich od nowa.

Przy wznowieniu sprawdź `pnpm exec supabase migration list`. W repozytorium po rezerwacjach jest też `20261119120000_payment_initialization.sql`. Szczegóły kolumn są w `docs/DATABASE.md`.

Następny etap wybiera użytkownik. Bez osobnej zgody nie implementuj `docs/AUTH-SESSION.md`, nie wystawiaj logowania i nie dodawaj tabel sesji. Bez osobnej zgody nie włączaj produkcyjnego checkoutu online, nie powtarzaj `transaction/register` ani `transaction/verify` i nie obchodź blokad `SELLER_TAX_STATUS_UNKNOWN` oraz `VAT_POLICY_NOT_CONFIRMED`. Nie uzupełniaj `shop_profile`, nie zmieniaj `seller_tax_status` i nie wybieraj `per_line` ani `per_rate` jako polityki sprzedaży. Nie dodawaj outboxa, dostawcy faktur, kuriera, fiskalizacji ani poczty tylko dlatego, że `docs/INTEGRATIONS.md` opisuje kierunek. Decyzje z sekcji 9 zostają do konsultacji z księgowym. Katalog, koszyk gościa, checkout gotówkowy i odczyt jednego zamówienia już są. Nie implementuj ich od nowa.

# Architektura

## 1. Cel i zakres
Aplikacja e-commerce dla pojedynczego sklepu, początkowo dla fotografa sprzedającego sesje, usługi, pliki cyfrowe i ewentualnie wydruki.

MVP nie jest marketplace'em ani systemem SaaS multi-tenant.

## 2. Komponenty

### `apps/web` — Nuxt 4
Aplikacja jest w JavaScript, bez TypeScriptu w kodzie źródłowym. Storefront ma katalog, koszyk gościa, formularz checkoutu gotówkowego i stronę odczytu jednego zamówienia. Formularz wysyła wyłącznie `paymentMethod = cash`. Nie pokazuje płatności online jako działającej opcji i nie ma strony powrotu z Przelewy24. Konto klienta i panel `/admin` nadal są planowane.

- publiczny katalog;
- koszyk gościa i przejście do checkoutu gotówkowego;
- odczyt własnego zamówienia pod `/orders/{id}`;
- konto klienta;
- panel administracyjny pod `/admin`;
- wyświetlanie danych pobieranych z API;
- zarządzanie sesją Supabase Auth.

### `apps/api` — Express 5
API jest w JavaScript, w modułach ES. Zaimplementowany jest health check, publiczny odczyt katalogu, koszyk gościa, koszyk konta, checkout gotówkowy, sandboxowy checkout online i `GET /api/v1/orders/:id`. Konto klienta i panel nadal są planowane.

- REST API;
- weryfikacja access tokenu Supabase biblioteką `jose` i publicznym JWKS; podpis, `iss`, `aud`, `exp` i UUID w `sub` są sprawdzane, a `req.auth.userId` dostaje dopiero zweryfikowany `sub`;
- autoryzacja administratora przez `requireAdmin` po `requireAuth`; rola jest czytana z `public.user_roles`, a nie z JWT; brak wiersza `admin` oznacza klienta, a wiersz nadaje tylko serwer; wynik nie jest cache'owany;
- logika katalogu, koszyka, zamówień, płatności, waluty i podatku;
- konfiguracja w `apps/api/src/config.js`, walidowana raz przy starcie przez Zod; proces nie ładuje pliku `.env` sam;
- walidacja wejścia przyszłych endpointów przez `validateRequest` i schematy Zod; handler czyta `req.validated.body`, `req.validated.params` i `req.validated.query`, a nie surowe pola tam, gdzie walidacja już je przetworzyła;
- błędy HTTP przechodzą przez jedno middleware; logi nie zawierają nagłówków, body, query stringu ani sekretów;
- dostęp do PostgreSQL idzie przez jedną pulę `pg` i serwerowy `DATABASE_URL`, bez Supabase SDK i bez ORM;
- klucz `service_role` zostaje sekretem serwerowym i nie jest potrzebny, dopóki nie ma Storage albo administracyjnego API Auth;
- adapter HTTP Przelewy24 w `apps/api/src/p24` rejestruje transakcję sandboxową dopiero po commicie zamówienia; `payments.id` jest `sessionId`; webhook `POST /webhooks/payments/przelewy24` jest podłączony i potwierdza płatność wyłącznie przez `transaction/verify` z dokładnym `data.status` równym `success`; inne statusy zostają nierozstrzygnięte i nie zapisują `verification_declined`; `verification_requested` commituje się przed HTTP, a `verification_accepted` razem ze statusem `paid` w jednej transakcji; drugiego `verifyTransaction` nie ma; powrót przeglądarki nie ustawia `paid`; worker `pnpm --filter @shop/api expiry:worker` wygasza rezerwacje online po 15 minutach od utworzenia zamówienia i nie przywraca ich przy spóźnionej płatności; późniejsze `paid` nie zmienia realizacji ani stanu magazynowego; produkcyjny checkout online pozostaje wyłączony; zapisany token sandboxu wraca jako stały `https://sandbox.przelewy24.pl/trnRequest/{TOKEN}`, a host ten wymaga końcowego potwierdzenia podczas testu sandbox; dostawca e-mail nadal niepodłączony.

### Supabase
- PostgreSQL jako główna baza danych;
- Supabase Auth jako dostawca tożsamości;
- Storage dla zdjęć i plików;
- RLS dla dostępu z klienta;
- migracje SQL wersjonowane w repozytorium.

## 3. Zasady przepływu danych
1. Nuxt komunikuje się z Express przez HTTPS/REST.
2. Nuxt przekazuje access token Supabase w nagłówku `Authorization: Bearer <token>`.
3. Express weryfikuje access token. Supabase Auth loguje użytkownika i wydaje JWT. Express nie przyjmuje haseł i nie używa `SUPABASE_SERVICE_ROLE_KEY` ani sekretu HMAC. Adres JWKS powstaje z `SUPABASE_URL`: `{SUPABASE_URL}/auth/v1/.well-known/jwks.json`. Jedna funkcja `createRemoteJWKSet` powstaje przy starcie procesu i nie pobiera kluczy, dopóki pierwsza chroniona trasa nie sprawdzi tokenu. Zestaw jest cache'owany przez 10 minut. Nieznany `kid` powoduje ponowne pobranie po 30 sekundach, więc rotacja klucza nie wymaga restartu. Dozwolone algorytmy to `ES256` i `RS256`. Brak nagłówka albo token odrzucony daje HTTP 401. Niedostępny JWKS daje HTTP 503, a nie 401. Middleware `requireAuth` nie obejmuje całego API. `GET /api/v1/health` i `GET /api/v1/health/ready` pozostają publiczne.
4. Express sprawdza uprawnienia do konkretnej operacji i zasobu. `requireAdmin` wykonuje `SELECT 1 FROM public.user_roles WHERE user_id = $1 AND role = 'admin' LIMIT 1`. Brak wcześniejszego `req.auth.userId` daje HTTP 401. Brak wiersza daje HTTP 403. Błąd zapytania daje HTTP 503 i nie jest traktowany jako brak roli. Claim roli w JWT nie jest używany. Middleware nie jest globalne. Koszyk konta sprawdza właściciela w SQL przez `req.auth.userId`. `GET /api/v1/orders/:id` sprawdza właściciela w SQL: konto po `orders.user_id`, gość po `orders.session_id`. Lista zamówień klienta pozostaje przy przyszłym endpoincie. Administrator czyta `GET /api/v1/admin/orders`.
5. Operacje biznesowe są wykonywane w backendzie.
6. Backend zapisuje dane w PostgreSQL.
7. Frontend otrzymuje tylko dane niezbędne do wyświetlenia.

Katalog, dane klienta, koszyk, zamówienia i płatności mają być odczytywane przez Express. RLS jest dodatkową warstwą, bo klucz `anon` i tak jest w przeglądarce przy Supabase Auth. Nie zastępuje weryfikacji tokenu ani sprawdzenia właściciela i roli. Połączenie `pg` używa roli z `DATABASE_URL`. Na lokalnej bazie jest to zwykle `postgres`, które omija RLS tak samo jak `service_role`. Dlatego każde przyszłe zapytanie o zasób użytkownika musi mieć warunek właściciela w Express. Osobnej roli bazy o węższych uprawnieniach jeszcze nie ma: wymagałaby migracji i nadania praw do istniejących tabel. Sekretu `service_role` nie wolno umieszczać we frontendzie.

Nie używaj bezpośredniego zapisu z przeglądarki do tabel `orders`, `order_items`, `payments`, `payment_events`, `idempotency_keys`, `user_roles` ani do operacji administracyjnych. Koszyk gościa jest identyfikowany ciasteczkiem `httpOnly` `shop_guest_session`. Surowy identyfikator nie trafia do bazy, logów ani JSON. W bazie jest skrót SHA-256.

`idempotency_keys` i `payment_events` to dwa mechanizmy. Klucz idempotencji dotyczy powtórzonego żądania HTTP wybranych operacji `POST` i nie służy webhookom. Zdarzenie płatności dotyczy webhooka operatora albo ręcznego potwierdzenia gotówki. Webhook nie wysyła nagłówka `Idempotency-Key`.

Checkout liczy kwoty z katalogu. Przy `seller_tax_status = unknown` zamówienie nie powstaje. Na MVP Express odrzuca walutę inną niż `PLN`, ale schemat jej do `PLN` nie więzi. Waluta i kwota brutto zamówienia oraz płatności zostają takie, jakie były w chwili checkoutu.

## 4. Struktura monorepo

```text
shop/
├── AGENTS.md
├── README.md
├── package.json
├── pnpm-workspace.yaml
├── .env.example
├── .cursor/
│   └── rules/
│       ├── general.mdc
│       ├── frontend.mdc
│       ├── backend.mdc
│       └── database.mdc
├── apps/
│   ├── web/
│   └── api/
├── packages/
│   └── shared/
├── supabase/
│   ├── config.toml
│   ├── migrations/
│   └── seed.sql
└── docs/
```

## 5. Moduły domenowe backendu

Poniższy podział jest docelowy. Zaimplementowany jest publiczny odczyt katalogu, koszyk gościa, koszyk konta, jawne scalenie koszyków, checkout gotówkowy, sandboxowy checkout online, odczyt jednego zamówienia oraz administracyjna lista zamówień `GET /api/v1/admin/orders`. Produkcyjny checkout online pozostaje wyłączony. Lista zamówień klienta i powiadomienia nie są jeszcze zaimplementowane. Panel ma layout `admin` oraz strony `/admin/orders` i `/admin/orders/:id`. Obie tylko czytają API. Logowanie administratora w Nuxt nie istnieje, więc bez sesji te strony dostają odmowę API. Pozostałe moduły panelu nie mają stron. Trasy administracyjne to `GET /api/v1/admin/orders`, `GET /api/v1/admin/orders/:id`, `POST /api/v1/admin/orders/:id/mark-paid` i `POST /api/v1/admin/orders/:id/cancel`.

- `auth`: weryfikacja tożsamości i kontekst użytkownika; bez implementowania własnego systemu haseł.
- `customers`: profile, typ klienta, adresy.
- `catalog`: publiczny odczyt aktywnych kategorii i produktów przez `pg`. Zapytania jawnie filtrują `is_active = true`, bo rola z `DATABASE_URL` może omijać RLS. Szczegóły są po UUID. Nieaktywna kategoria nie zmienia wiersza produktu; w odpowiedzi szczegółów `category_id` jest wtedy `null`. Zapis, media i panel administratora nie są zaimplementowane.
- `cart`: `GET /api/v1/cart` oraz `POST`, `PATCH` i `DELETE` na `/api/v1/cart/items` obsługują dwa niezależne koszyki. Brak nagłówka `Authorization` zostawia koszyk gościa. Nagłówek kieruje żądanie przez `requireAuth`, a właścicielem jest `req.auth.userId`. Ciasteczko nie wybiera wtedy koszyka i nie jest zmieniane. Sesja gościa to ciasteczko `shop_guest_session` ustawiane wyłącznie przez `POST /api/v1/session/guest`. Surowy identyfikator zostaje w ciasteczku. Zapis koszyka gościa używa tylko `hashGuestSessionId`, czyli SHA-256 tej wartości. Zapis koszyka konta wymaga `user_id` z tokenu i `session_id IS NULL`. Cena zostaje w katalogu. Zmiana koszyka najpierw bierze transakcyjną blokadę właściciela. Dodanie i zmiana ilości idą jedną transakcją połączenia: koszyk jest blokowany, a kwota pozycji i suma są sprawdzane jako `bigint` przed zapisem. Kwota spoza bezpiecznego integera JavaScriptu daje HTTP 400 i wycofanie zapisu. `POST /api/v1/cart/merge` jest jawnym scaleniem po `requireAuth`. Ciasteczko czyta tylko ten endpoint. W jednej transakcji bierze blokadę gościa `71001`, potem konta `71002`, potem blokuje rekord koszyka gościa. Brak pozycji nic nie zmienia. Sam koszyk gościa staje się koszykiem konta przez zmianę właściciela. Gdy koszyk konta już jest, pozycje są dopisywane albo sumowane, a koszyk gościa dostaje `abandoned` bez zmiany `session_id`. `converted` zostaje dla checkoutu.
- `checkout`: `POST /api/v1/checkout` tworzy zamówienie gotówkowe oraz sandboxowe zamówienie online. `seller_tax_status = unknown` daje `SELLER_TAX_STATUS_UNKNOWN`. Sprzedawca `registered` i produkt `standard` dają `VAT_POLICY_NOT_CONFIRMED`. Produkcyjny checkout online pozostaje wyłączony. Storefront woła wyłącznie wariant gotówkowy.
- `orders`: `GET /api/v1/orders/:id` zwraca aktualny stan własnego zamówienia i niczego nie zapisuje. `GET /api/v1/admin/orders` zwraca administratorowi stronę zamówień. `GET /api/v1/admin/orders/:id` zwraca snapshot pozycji, płatności, rezerwacje, historię statusów i zdarzenia płatności bez payloadu oraz bez `redirect_token`. Oba odczyty administracyjne niczego nie zapisują i nie wołają operatora. `initialization_status` oraz `payment_events.event_type` pozostają osobno od statusu płatności. Lista zamówień klienta oraz zmiana statusu realizacji nie są zaimplementowane.
- `payments`: rejestracja sandboxowa, webhook i finalizacja po dokładnym `success` są podłączone. Zwroty nie są zaimplementowane. `POST /api/v1/admin/orders/:id/mark-paid` potwierdza wyłącznie gotówkę: rola `admin`, jedna transakcja, zmniejszenie stanu, rezerwacja `consumed`, płatność `paid`, realizacja `new`. `POST /api/v1/admin/orders/:id/cancel` anuluje nieopłaconą gotówkę: rezerwacja `released`, płatność i realizacja `cancelled`, bez zmiany `stock_quantity`. Powtórzenia żądań HTTP obsługuje `idempotency_keys`. Zdarzenie ręczne trafia do `payment_events` z `provider = manual`.
- `admin`: operacje administracyjne i dashboard.
- `notifications`: e-maile transakcyjne.
- `settings`: ustawienia niefiskalne w `store_settings` oraz status podatkowy sprzedawcy w `shop_profile`.

Każdy moduł powinien mieć tylko te warstwy, które faktycznie są potrzebne. Zalecany wzorzec dla modułu o większej złożoności:
- `*.routes.js`
- `*.controller.js`
- `*.service.js`
- `*.repository.js`
- `*.validation.js`

Nie twórz pustych plików ani warstw bez uzasadnienia.

## 6. Granice odpowiedzialności
- Controller: HTTP, statusy odpowiedzi, mapowanie request/response.
- Service: reguły biznesowe i koordynacja operacji.
- Repository: odczyt/zapis danych.
- Validation: `validateRequest` sprawdza wybrane części żądania schematem Zod. Nieudane dane dają HTTP 400 `VALIDATION_ERROR` z komunikatem `Invalid request data`. Szczegóły zawierają lokalizację, ścieżkę, kod Zod i komunikat, bez przesłanej wartości. Paginacja list używa `page` i `limit` z query string: domyślnie 1 i 20, limit najwyżej 100, `offset` to `(page - 1) * limit`.
- Integration: komunikacja z usługami zewnętrznymi.
- Frontend composable: stan i wywołania API związane z UI; bez reguł biznesowych.
- Shared: schematy/stałe współdzielone, bez dostępu do bazy i sekretów.

## 7. Panel administracyjny
Panel jest częścią aplikacji Nuxt i ma layout `admin`, osobny od layoutu sklepu. Działają `/admin/orders` i odczyt `/admin/orders/:id`. Pozostałe trasy poniżej nie mają stron. Middleware Nuxt nie zastępuje `requireAdmin`. Logowanie administratora nie jest podłączone. Stron nie mają:
- `/admin`
- `/admin/products`
- `/admin/categories`
- `/admin/customers`
- `/admin/payments`
- `/admin/settings`

Ochrona middleware w Nuxt służy UX, ale nie jest zabezpieczeniem. Każdy endpoint administracyjny musi ponownie sprawdzić rolę po stronie Express.

## 8. Rozszerzalność
Projektuj katalog tak, aby `product_type` rozróżniał:
- `physical`
- `digital`
- `service`

Nie implementuj jeszcze logiki dostawy, rezerwacji terminów ani galerii klienta. Dodaj je jako osobne moduły, gdy pojawi się konkretne wymaganie.

Nie dodawaj `store_id` i wielosklepowości do wszystkich tabel bez decyzji o budowie SaaS. Jeśli kierunek multi-tenant zostanie potwierdzony, należy zaprojektować izolację danych, role i RLS jako osobny etap architektoniczny.

## 9. Decyzje wymagające zatwierdzenia
Ustalone dla schematu i MVP:

- zakup gościnny jest dozwolony; historia konta obejmuje zamówienia złożone po zalogowaniu;
- model cen, waluty i tymczasowa arytmetyka VAT są opisane w `docs/DATABASE.md`; nie jest to zatwierdzona decyzja księgowa;
- jeden produkt ma jedną kategorię; typy to `physical`, `digital` i `service`;
- na MVP nie ma dostaw, wariantów, faktur, kuponów, rezerwacji ani wielu sklepów.

Przed implementacją produkcyjną nadal należy zatwierdzić:

- końcowe potwierdzenie hosta `https://sandbox.przelewy24.pl/trnRequest/{TOKEN}` podczas testu sandbox; specyfikacja REST 1.0.18 podaje bezpośrednio tylko adres produkcyjny; produkcyjny checkout online pozostaje wyłączony mimo podłączonego webhooka; ręczna rekonsyliacja stanów `unknown` oraz `verification_requested` bez `verification_accepted` jest w `docs/P24_RECONCILIATION.md`;
- sposób realizacji usług i produktów cyfrowych;
- dokumenty sprzedaży, moment obowiązku podatkowego i retencję danych; pełna lista kwestii odłożonych do konsultacji z księgowym jest w `docs/PROJECT_HANDOFF.md`; nie blokują dalszych prac technicznych, blokują ostateczne uruchomienie sprzedaży w zakresie, którego dotyczą, i implementacja ich nie rozstrzyga;
- hosting API, frontendu i Supabase.

## 10. Integracje zewnętrzne

mshop zostaje źródłem prawdy dla zamówienia, koszyka, magazynu, realizacji, uprawnień i konfiguracji. Dostawca wykonuje tylko swoją specjalizację i nie przejmuje logiki sklepu. Projekt jest w `docs/INTEGRATIONS.md`.

Zaimplementowane jest wyłącznie sandboxowe Przelewy24 oraz worker wygaszania rezerwacji. Nie ma outboxa, workera integracji, fakturowania, KSeF, kuriera, fiskalizacji, poczty transakcyjnej, SMS ani panelu „Integracje”. Produkcyjny checkout online pozostaje wyłączony. Wynik nieznany rejestracji albo weryfikacji nie jest automatycznie ponawiany.

Założenie na przyszłość: adapter na dostawcę, lokalny i zewnętrzny identyfikator, mapa statusów z jawnym stanem nierozstrzygniętym oraz trwałe zlecenie zapisywane razem ze zmianą lokalną. Płatność, dokument i przesyłka nie są bezpieczne do ślepego ponowienia. Dostawcy poza Przelewy24 nie są wybrani.

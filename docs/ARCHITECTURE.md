# Architektura

## 1. Cel i zakres
Aplikacja e-commerce dla pojedynczego sklepu, początkowo dla fotografa sprzedającego sesje, usługi, pliki cyfrowe i ewentualnie wydruki.

MVP nie jest marketplace'em ani systemem SaaS multi-tenant.

## 2. Komponenty

### `apps/web` — Nuxt 4
Aplikacja jest w JavaScript, bez TypeScriptu w kodzie źródłowym. Działa szkielet frontendu. Storefront, koszyk, checkout, konto i panel `/admin` są planowane, nie są jeszcze zaimplementowane.

- publiczny storefront;
- koszyk i checkout;
- konto klienta;
- panel administracyjny pod `/admin`;
- wyświetlanie danych pobieranych z API;
- zarządzanie sesją Supabase Auth.

### `apps/api` — Express 5
API jest w JavaScript, w modułach ES. Zaimplementowany jest health check, publiczny odczyt katalogu, koszyk gościa i koszyk konta. Zamówienia i płatności są planowane.

- REST API;
- weryfikacja access tokenu Supabase biblioteką `jose` i publicznym JWKS; podpis, `iss`, `aud`, `exp` i UUID w `sub` są sprawdzane, a `req.auth.userId` dostaje dopiero zweryfikowany `sub`;
- autoryzacja administratora przez `requireAdmin` po `requireAuth`; rola jest czytana z `public.user_roles`, a nie z JWT; brak wiersza `admin` oznacza klienta, a wiersz nadaje tylko serwer; wynik nie jest cache'owany;
- logika katalogu, koszyka, zamówień, płatności, waluty i podatku;
- konfiguracja w `apps/api/src/config.js`, walidowana raz przy starcie przez Zod; proces nie ładuje pliku `.env` sam;
- walidacja wejścia przyszłych endpointów przez `validateRequest` i schematy Zod; handler czyta `req.validated.body`, `req.validated.params` i `req.validated.query`, a nie surowe pola tam, gdzie walidacja już je przetworzyła;
- błędy HTTP przechodzą przez jedno middleware; logi nie zawierają nagłówków, body, query stringu ani sekretów;
- dostęp do PostgreSQL idzie przez jedną pulę `pg` i serwerowy `DATABASE_URL`, bez Supabase SDK i bez ORM;
- klucz `service_role` zostaje sekretem serwerowym i nie jest potrzebny, dopóki nie ma Storage albo administracyjnego API Auth;
- adapter HTTP Przelewy24 w `apps/api/src/p24` jest używany przez sandboxowy checkout po commicie zamówienia; worker wygaszania rezerwacji jest osobnym procesem `pnpm --filter @shop/api expiry:worker`; webhook i weryfikacja transakcji nie są podłączone; produkcyjny checkout online jest wyłączony do czasu webhooka; dostawca e-mail nadal niepodłączony.

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
4. Express sprawdza uprawnienia do konkretnej operacji i zasobu. `requireAdmin` wykonuje `SELECT 1 FROM public.user_roles WHERE user_id = $1 AND role = 'admin' LIMIT 1`. Brak wcześniejszego `req.auth.userId` daje HTTP 401. Brak wiersza daje HTTP 403. Błąd zapytania daje HTTP 503 i nie jest traktowany jako brak roli. Claim roli w JWT nie jest używany. Middleware nie jest globalne. Koszyk konta sprawdza właściciela w SQL przez `req.auth.userId`. Własność pozostałych zasobów klienta pozostaje przy przyszłych endpointach.
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

Poniższy podział jest docelowy. Zaimplementowany jest publiczny odczyt katalogu, koszyk gościa, koszyk konta i jawne scalenie koszyków. Pozostałe moduły nie są jeszcze zaimplementowane.

- `auth`: weryfikacja tożsamości i kontekst użytkownika; bez implementowania własnego systemu haseł.
- `customers`: profile, typ klienta, adresy.
- `catalog`: publiczny odczyt aktywnych kategorii i produktów przez `pg`. Zapytania jawnie filtrują `is_active = true`, bo rola z `DATABASE_URL` może omijać RLS. Szczegóły są po UUID. Nieaktywna kategoria nie zmienia wiersza produktu; w odpowiedzi szczegółów `category_id` jest wtedy `null`. Zapis, media i panel administratora nie są zaimplementowane.
- `cart`: `GET /api/v1/cart` oraz `POST`, `PATCH` i `DELETE` na `/api/v1/cart/items` obsługują dwa niezależne koszyki. Brak nagłówka `Authorization` zostawia koszyk gościa. Nagłówek kieruje żądanie przez `requireAuth`, a właścicielem jest `req.auth.userId`. Ciasteczko nie wybiera wtedy koszyka i nie jest zmieniane. Sesja gościa to ciasteczko `shop_guest_session` ustawiane wyłącznie przez `POST /api/v1/session/guest`. Surowy identyfikator zostaje w ciasteczku. Zapis koszyka gościa używa tylko `hashGuestSessionId`, czyli SHA-256 tej wartości. Zapis koszyka konta wymaga `user_id` z tokenu i `session_id IS NULL`. Cena zostaje w katalogu. Zmiana koszyka najpierw bierze transakcyjną blokadę właściciela. Dodanie i zmiana ilości idą jedną transakcją połączenia: koszyk jest blokowany, a kwota pozycji i suma są sprawdzane jako `bigint` przed zapisem. Kwota spoza bezpiecznego integera JavaScriptu daje HTTP 400 i wycofanie zapisu. `POST /api/v1/cart/merge` jest jawnym scaleniem po `requireAuth`. Ciasteczko czyta tylko ten endpoint. W jednej transakcji bierze blokadę gościa `71001`, potem konta `71002`, potem blokuje rekord koszyka gościa. Brak pozycji nic nie zmienia. Sam koszyk gościa staje się koszykiem konta przez zmianę właściciela. Gdy koszyk konta już jest, pozycje są dopisywane albo sumowane, a koszyk gościa dostaje `abandoned` bez zmiany `session_id`. `converted` zostaje dla checkoutu.
- `checkout`: walidacja danych i utworzenie zamówienia.
- `orders`: odczyt, statusy i historia zamówień.
- `payments`: inicjowanie płatności, webhooki, zwroty i rejestrowanie zdarzeń w `payment_events`. Powtórzenia żądań HTTP obsługuje `idempotency_keys`, nie ta tabela.
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
Panel jest częścią aplikacji Nuxt, ale ma osobny layout i chronione trasy:
- `/admin`
- `/admin/products`
- `/admin/categories`
- `/admin/orders`
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
- model cen, waluty i VAT opisany w `docs/DATABASE.md`;
- jeden produkt ma jedną kategorię; typy to `physical`, `digital` i `service`;
- na MVP nie ma dostaw, wariantów, faktur, kuponów, rezerwacji ani wielu sklepów.

Przed implementacją produkcyjną nadal należy zatwierdzić:

- host przekierowania Przelewy24 w sandboxie; produkcyjny checkout online pozostaje wyłączony do czasu webhooka i `transaction/verify`;
- sposób realizacji usług i produktów cyfrowych;
- dokumenty sprzedaży, moment obowiązku podatkowego i retencję danych;
- hosting API, frontendu i Supabase.

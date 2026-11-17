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
API jest w JavaScript, w modułach ES. Zaimplementowany jest health check. Logika katalogu, koszyka, zamówień i płatności jest planowana.

- REST API;
- weryfikacja tokenów Supabase;
- autoryzacja ról; brak wiersza w `user_roles` oznacza klienta, wiersz `admin` nadaje tylko serwer;
- logika katalogu, koszyka, zamówień, płatności, waluty i podatku;
- konfiguracja w `apps/api/src/config.js`, walidowana raz przy starcie przez Zod; proces nie ładuje pliku `.env` sam;
- błędy HTTP przechodzą przez jedno middleware; logi nie zawierają nagłówków, body, query stringu ani sekretów;
- dostęp do PostgreSQL jest planowany przez serwerowy `DATABASE_URL`, bez Supabase SDK; połączenia jeszcze nie ma;
- klucz `service_role` zostaje sekretem serwerowym i nie jest potrzebny, dopóki nie ma Storage albo administracyjnego API Auth;
- integracje z operatorem płatności i dostawcą e-mail, jeszcze niepodłączone.

### Supabase
- PostgreSQL jako główna baza danych;
- Supabase Auth jako dostawca tożsamości;
- Storage dla zdjęć i plików;
- RLS dla dostępu z klienta;
- migracje SQL wersjonowane w repozytorium.

## 3. Zasady przepływu danych
1. Nuxt komunikuje się z Express przez HTTPS/REST.
2. Nuxt przekazuje access token Supabase w nagłówku `Authorization: Bearer <token>`.
3. Express weryfikuje token i pobiera tożsamość użytkownika.
4. Express sprawdza uprawnienia do konkretnej operacji i zasobu.
5. Operacje biznesowe są wykonywane w backendzie.
6. Backend zapisuje dane w PostgreSQL.
7. Frontend otrzymuje tylko dane niezbędne do wyświetlenia.

Katalog, dane klienta, koszyk, zamówienia i płatności mają być odczytywane przez Express. RLS jest dodatkową warstwą, bo klucz `anon` i tak jest w przeglądarce przy Supabase Auth. Nie zastępuje weryfikacji tokenu ani sprawdzenia właściciela i roli. `service_role` omija RLS, dlatego backend sam sprawdza właściciela zasobu i rolę. Sekretu `service_role` nie wolno umieszczać we frontendzie.

Nie używaj bezpośredniego zapisu z przeglądarki do tabel `orders`, `order_items`, `payments`, `payment_events`, `idempotency_keys`, `user_roles` ani do operacji administracyjnych. Koszyk gościa jest identyfikowany ciasteczkiem `httpOnly`; surowy identyfikator sesji nie trafia do bazy.

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

Poniższy podział jest docelowy. Poza health checkiem moduły nie są jeszcze zaimplementowane.

- `auth`: weryfikacja tożsamości i kontekst użytkownika; bez implementowania własnego systemu haseł.
- `customers`: profile, typ klienta, adresy.
- `catalog`: produkty, usługi, kategorie, media.
- `cart`: koszyk i pozycje koszyka.
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
- Validation: walidacja wejścia.
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

- operatora płatności (`przelewy24` albo `stripe`) i jego środowisko testowe;
- sposób realizacji usług i produktów cyfrowych;
- dokumenty sprzedaży, moment obowiązku podatkowego i retencję danych;
- hosting API, frontendu i Supabase.

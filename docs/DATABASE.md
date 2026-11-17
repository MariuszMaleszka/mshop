# Model danych

Dokument opisuje zaakceptowany schemat PostgreSQL. Nie jest migracją. Źródłem prawdy po wdrożeniu pozostaną pliki SQL w `supabase/migrations/`.

## 1. Konwencje

- PostgreSQL w Supabase.
- Klucze główne: `uuid`, domyślnie `gen_random_uuid()`, poza `profiles.id` i singletonem `shop_profile`.
- Czas: `timestamptz` w UTC. `created_at` na każdej tabeli. `updated_at` tam, gdzie wiersz wolno zmieniać; ustawia go trigger.
- Kwoty: `bigint` w najmniejszej jednostce waluty. Dla PLN są to grosze. Zakaz `float` i `real`.
- Waluta: `char(3)`, kod alfabetyczny ISO 4217. Domyślnie `PLN`. Check formatu `^[A-Z]{3}$`. Brak checka ograniczającego wartość do `PLN`.
- Na MVP Express przyjmuje wyłącznie `PLN`. Kursów i przeliczania nie ma.
- `price_amount` produktu jest kwotą należną za sztukę. Przy sprzedawcy `registered` i `tax_status = standard` jest to cena brutto z VAT. W pozostałych przypadkach jest to cała kwota do zapłaty, bez wyliczania sztucznego podatku.
- Tabele dopisywane (`order_status_history`, `payment_events`, `idempotency_keys`) nie mają `updated_at`.
- Nie edytuj produkcyjnej bazy ręcznie bez migracji.

## 2. Tożsamość i klienci

`profiles` i `customers` są osobnymi tabelami. Supabase Auth przechowuje hasło i tożsamość logowania, w tym planowane logowanie e-mail, Google i Apple. Aplikacja nie ma własnej tabeli haseł.

### `profiles`

Konto użytkownika. Jeden wiersz na jedno `auth.users`.

- `id uuid PK references auth.users(id) on delete cascade`
- `display_name text null`
- `created_at timestamptz not null`
- `updated_at timestamptz not null`

Telefonu i e-maila kontaktowego tu nie ma. E-mail logowania zostaje w `auth.users`. Po rejestracji trigger tworzy profil.

### `user_roles`

Wyłącznie rola podwyższona.

- `id uuid PK`
- `user_id uuid not null references auth.users(id) on delete cascade`
- `role text not null` — dozwolone tylko `admin`
- `created_at timestamptz not null`
- unique (`user_id`, `role`)

Brak wiersza oznacza klienta. Rejestracja nie wstawia roli. `admin` nadaje tylko zaufana operacja serwerowa.

### `customers`

Dane klienta sklepu. Gość może kupić bez konta.

- `id uuid PK`
- `user_id uuid null references auth.users(id) on delete set null`
- `customer_type text not null` — `individual` lub `company`; domyślnie `individual`
- `email text not null` — e-mail kontaktowy zamówienia, niekoniecznie e-mail logowania
- `phone text null` — jedyny telefon w modelu
- `first_name text null`
- `last_name text null`
- `company_name text null`
- `nip text null` — format sprawdza Express, nie baza
- `created_at timestamptz not null`
- `updated_at timestamptz not null`

Indeks unikalny częściowy na `user_id`, gdzie `user_id is not null`: jedno konto ma najwyżej jednego klienta. E-mail nie jest unikalny.

Zakup nie wymaga rejestracji. Gość ma `user_id = null` i nowy wiersz przy checkoutcie. Historia konta to zamówienia z `orders.user_id` tego konta. Sam zgodny e-mail nie przypina historycznych zamówień gościa do nowego konta.

### `customer_addresses`

Książka adresów zalogowanego klienta. Na MVP tylko adres rozliczeniowy. Adresu dostawy nie ma.

- `id uuid PK`
- `customer_id uuid not null references customers(id) on delete cascade`
- `address_type text not null` — wyłącznie `billing`; domyślnie `billing`
- `recipient text null`
- `company_name text null`
- `street text not null`
- `building_number text not null`
- `apartment_number text null`
- `postal_code text not null`
- `city text not null`
- `country_code char(2) not null` — ISO 3166-1 alpha-2; domyślnie `PL`
- `created_at timestamptz not null`
- `updated_at timestamptz not null`

Zamówienie kopiuje adres do `billing_snapshot`. Późniejsza edycja albo usunięcie adresu nie zmienia historii.

## 3. Sklep i podatek sprzedawcy

### `shop_profile`

Jeden wiersz. Status podatkowy sprzedawcy nie trafia do `store_settings`.

- `id boolean PK` — check `id = true`; domyślnie `true`
- `seller_tax_status text not null` — `registered`, `exempt` albo `unknown`; domyślnie `unknown`
- `updated_at timestamptz not null`

Migracja wstawia jeden wiersz ze statusem `unknown`.

- `registered` — czynny podatnik VAT
- `exempt` — sprzedawca korzysta ze zwolnienia z VAT
- `unknown` — status nieustalony; checkout jest zablokowany i zamówienie nie powstaje

### `store_settings`

Ustawienia niefiskalne, na przykład nazwa sklepu i e-mail kontaktowy.

- `key text PK`
- `value jsonb not null`
- `updated_at timestamptz not null`

Bez sekretów operatora płatności, haseł i statusu VAT sprzedawcy.

## 4. Katalog

Jeden sklep, bez `store_id`. Produkt ma jedną kategorię. Wariantów produktów nie ma.

### `categories`

- `id uuid PK`
- `name text not null`
- `slug text not null unique`
- `description text null`
- `is_active boolean not null`
- `sort_order integer not null`
- `created_at timestamptz not null`
- `updated_at timestamptz not null`

### `products`

- `id uuid PK`
- `category_id uuid null references categories(id) on delete set null`
- `name text not null`
- `slug text not null unique`
- `description text null`
- `product_type text not null` — `physical`, `digital` albo `service`
- `sku text null unique`
- `price_amount bigint not null` — kwota należna za sztukę; check `>= 0`
- `currency char(3) not null` — domyślnie `PLN`
- `tax_status text not null` — bez wartości domyślnej
- `vat_rate numeric(5,2) null`
- `is_active boolean not null`
- `stock_quantity integer null` — null oznacza brak śledzenia stanu; gdy podany, check `>= 0`
- `created_at timestamptz not null`
- `updated_at timestamptz not null`

`tax_status` i `vat_rate` wiąże check:

| `tax_status` | `vat_rate` | Skutek przy sprzedawcy `registered` |
|---|---|---|
| `standard` | wymagany, większy od 0 i nie większy niż 100 | VAT liczony z kwoty brutto |
| `zero_rated` | dokładnie `0.00` | VAT = 0, netto = brutto |
| `exempt` | null | VAT = 0, netto = brutto |
| `not_subject` | null | VAT = 0, netto = brutto |

Null w `vat_rate` sam nie oznacza zwolnienia. Lista stawek 23, 8 i 5 nie jest checkiem bazy. Dozwolone stawki `standard` sprawdza później Express.

Stan magazynowy nie zależy od typu produktu. Usługa i produkt cyfrowy nie muszą go mieć. Zaawansowanego magazynu nie ma.

### `product_images`

- `id uuid PK`
- `product_id uuid not null references products(id) on delete cascade`
- `storage_path text not null` — ścieżka obiektu w Storage, nie URL od klienta
- `alt_text text null`
- `sort_order integer not null`
- `created_at timestamptz not null`
- `updated_at timestamptz not null`

Dla plików prywatnych Express wydaje krótkotrwałe signed URL.

## 5. Koszyk

Cena w koszyku nie jest źródłem prawdy. Checkout czyta aktualną cenę, walutę, aktywność i podatek z katalogu.

### `carts`

- `id uuid PK`
- `user_id uuid null references auth.users(id) on delete cascade`
- `session_id char(64) null` — hex SHA-256 tajnego ciasteczka, nie surowy token
- `status text not null` — `active`, `converted` albo `abandoned`; domyślnie `active`
- `currency char(3) not null` — domyślnie `PLN`
- `created_at timestamptz not null`
- `updated_at timestamptz not null`

Check: dokładnie jedno z pól `user_id` i `session_id` jest uzupełnione.

Jeden aktywny koszyk właściciela:

- unikalny `user_id`, gdzie `status = 'active'` i `user_id is not null`
- unikalny `session_id`, gdzie `status = 'active'` i `session_id is not null`

Ciasteczko gościa jest `httpOnly`, `Secure`, `SameSite=Lax` i niesie nieprzewidywalny losowy sekret. W bazie leży tylko skrót.

Po zalogowaniu, w jednej transakcji:

- jest tylko koszyk gościa: ustaw `user_id`, wyczyść `session_id`;
- są oba aktywne koszyki: sumuj ilości tego samego produktu w koszyku konta, a koszyk gościa ustaw na `abandoned`;
- koszyk gościa jest pusty: nic nie łącz.

`converted` ustawia checkout, nie logowanie. Zmiana `products.currency` albo `products.price_amount` nie przelicza istniejących koszyków.

### `cart_items`

- `id uuid PK`
- `cart_id uuid not null references carts(id) on delete cascade`
- `product_id uuid not null references products(id) on delete restrict`
- `quantity integer not null` — check `>= 1`
- `created_at timestamptz not null`
- `updated_at timestamptz not null`
- unique (`cart_id`, `product_id`)

Produkt obecny w koszyku nie może zostać usunięty. Admin go dezaktywuje.

## 6. Zamówienia

Checkout jest jedną transakcją. Przy `shop_profile.seller_tax_status = unknown` transakcja nie startuje.

Express sprawdza, że każdy produkt koszyka ma tę samą walutę co koszyk. Na MVP ta waluta musi być `PLN`. Do zamówienia i płatności trafia kod z tej chwili. Później się nie zmienia.

Dla `standard`, przy sprzedawcy `registered`: podatek jest różnicą brutto i netto, zaokrąglaną połową w górę do grosza, osobno na każdej pozycji, na liczbach całkowitych. Dla `zero_rated`, `exempt` i `not_subject` podatek wynosi 0, a netto równa się brutto. Stawki nie wyciąga się wtedy z ceny.

Gdy sprzedawca jest `exempt`, zastosowany status każdej pozycji to `exempt`, zastosowana stawka jest null, podatek wynosi 0, a netto równa się brutto. Snapshot katalogowy zostaje taki, jaki był na produkcie.

Gdy sprzedawca jest `registered`, zastosowany status i stawka pochodzą z produktu.

Sumy nagłówka równają się sumom pozycji. Sprawdza to transakcja checkoutu, nie klucz obcy.

### `orders`

- `id uuid PK`
- `order_number text not null unique`
- `customer_id uuid null references customers(id) on delete set null`
- `user_id uuid null references auth.users(id) on delete set null`
- `customer_email text not null`
- `customer_type text not null` — `individual` lub `company`
- `billing_snapshot jsonb not null`
- `seller_tax_status_snapshot text not null` — tylko `registered` albo `exempt`
- `currency char(3) not null`
- `net_amount bigint not null`
- `tax_amount bigint not null`
- `gross_amount bigint not null`
- `payment_method text not null` — `online` albo `cash`
- `payment_status text not null` — domyślnie `pending`
- `fulfillment_status text not null` — domyślnie `new`
- `created_at timestamptz not null`
- `updated_at timestamptz not null`

`gross_amount = net_amount + tax_amount`. Wszystkie trzy kwoty są nieujemne. `gross_amount` jest kwotą przekazywaną operatorowi płatności.

`billing_snapshot` zawiera wyłącznie dane z chwili zakupu: `first_name`, `last_name`, `company_name`, `nip`, `phone`, `recipient`, `street`, `building_number`, `apartment_number`, `postal_code`, `city`, `country_code`. Kształt sprawdza Express.

Status płatności: `pending`, `paid`, `failed`, `cancelled`, `refunded`, `partially_refunded`.

Status realizacji: `new`, `processing`, `completed`, `cancelled`.

Te osie są niezależne. Baza nie wymusza kolejności między nimi.

### `order_items`

Każda pozycja ma snapshot katalogowy i snapshot użyty do kwot. Przy sprzedawcy zwolnionym produkt może mieć katalogowo `standard` i stawkę 23, a pozycja i tak jest liczona jako `exempt` ze stawką null.

- `id uuid PK`
- `order_id uuid not null references orders(id) on delete cascade`
- `product_id uuid null references products(id) on delete set null`
- `product_name_snapshot text not null`
- `product_type_snapshot text not null`
- `sku_snapshot text null`
- `currency char(3) not null` — ten sam kod co `orders.currency`
- `catalog_tax_status_snapshot text not null`
- `catalog_vat_rate_snapshot numeric(5,2) null`
- `tax_status_snapshot text not null`
- `vat_rate_snapshot numeric(5,2) null`
- `unit_gross_amount bigint not null` — kwota należna za sztukę
- `quantity integer not null` — check `>= 1`
- `line_net_amount bigint not null`
- `line_tax_amount bigint not null`
- `line_gross_amount bigint not null`

Checki pozycji:

- `line_gross_amount = unit_gross_amount * quantity`
- `line_gross_amount = line_net_amount + line_tax_amount`
- `standard`: stawka większa od 0 i nie większa niż 100, podatek nieujemny
- `zero_rated`: stawka `0`, podatek `0`, netto = brutto
- `exempt` i `not_subject`: stawka null, podatek `0`, netto = brutto

Dla `standard` podatek nie musi być większy od zera. Zaokrąglenie bardzo małej kwoty może dać zero.

Późniejsza zmiana produktu, jego ceny, waluty albo stawki nie zmienia pozycji.

### `order_status_history`

Append-only.

- `id uuid PK`
- `order_id uuid not null references orders(id) on delete cascade`
- `status_type text not null` — `payment` albo `fulfillment`
- `old_status text null`
- `new_status text not null`
- `changed_by uuid null references auth.users(id) on delete set null`
- `note text null`
- `created_at timestamptz not null`

Nowe zamówienie dostaje dwa wpisy: płatność `pending` i realizacja `new`. `changed_by` jest null dla webhooka.

## 7. Płatności

Operator nie jest wybrany. Model przyjmuje gotówkę oraz jednego operatora online: `przelewy24` albo `stripe`. Sekrety operatora są w środowisku, nie w bazie. Danych karty nie zapisujemy.

Webhook jest źródłem prawdy dla płatności online. Powrót przeglądarki na stronę sukcesu nie ustawia `paid`. Przed `paid` Express sprawdza podpis, kwotę, walutę, zamówienie i status.

`payments.amount` równa się `orders.gross_amount` w chwili utworzenia. `payments.currency` równa się `orders.currency`. Obu pól waluty i kwoty należnej nie zmieniamy po utworzeniu. Zmiana katalogu ich nie przelicza.

### `payments`

- `id uuid PK`
- `order_id uuid not null references orders(id) on delete restrict`
- `method text not null` — `online` albo `cash`
- `provider text null` — `przelewy24` albo `stripe`, gdy `method = online`; null dla gotówki
- `provider_transaction_id text null`
- `status text not null` — ten sam zestaw co `orders.payment_status`; domyślnie `pending`
- `amount bigint not null`
- `refunded_amount bigint not null` — domyślnie `0`; check `<= amount`
- `currency char(3) not null`
- `paid_at timestamptz null`
- `created_at timestamptz not null`
- `updated_at timestamptz not null`

`cancelled` oznacza płatność, która nie doszła do skutku. Po `paid` zwrot całkowity to `refunded`, a częściowy to `partially_refunded`. Nowa próba po `failed` albo `cancelled` jest nowym wierszem.

Najwyżej jedna płatność `pending` i najwyżej jedna `paid` na zamówienie. Para (`provider`, `provider_transaction_id`) jest unikalna, gdy identyfikator nie jest null.

### `payment_events`

- `id uuid PK`
- `payment_id uuid not null references payments(id) on delete cascade`
- `provider text not null` — operator albo `manual` dla gotówki
- `provider_event_id text null`
- `event_type text not null`
- `payload jsonb not null` — zapis bez danych karty i bez sekretów
- `processed_at timestamptz null`
- `created_at timestamptz not null`

Para (`provider`, `provider_event_id`) jest unikalna, gdy identyfikator nie jest null. Gdy operator nie nadaje identyfikatora zdarzenia, Express zapisuje skrót zweryfikowanego payloadu. Powtórzone zdarzenie nie wykonuje drugi raz tej samej zmiany statusu.

### `idempotency_keys`

Powtórzony `POST /checkout` z tym samym kluczem i tym samym body nie tworzy drugiego zamówienia.

- `id uuid PK`
- `idempotency_key text not null` — nagłówek `Idempotency-Key`, do 255 znaków
- `user_id uuid null references auth.users(id) on delete cascade`
- `session_id char(64) null` — ten sam skrót ciasteczka co koszyk gościa
- `request_hash text not null`
- `response_status integer null`
- `response_body jsonb null`
- `order_id uuid null references orders(id) on delete set null`
- `created_at timestamptz not null`
- `expires_at timestamptz not null`

Check właściciela jest taki sam jak przy koszyku: dokładnie jedno z pól `user_id` i `session_id`. Unikalność klucza jest osobno dla konta i osobno dla sesji. Ten sam klucz przy innym `request_hash` jest konfliktem.

## 8. Relacje

- `auth.users` 1:1 `profiles`
- `auth.users` 1:N `user_roles`
- `auth.users` 0:1 `customers` na MVP
- `customers` 1:N `customer_addresses`
- `categories` 1:N `products`
- `products` 1:N `product_images`
- `carts` 1:N `cart_items`
- `orders` 1:N `order_items`
- `orders` 1:N `payments`
- `orders` 1:N `order_status_history`
- `payments` 1:N `payment_events`
- `shop_profile` — jeden wiersz, bez relacji
- `store_settings` — bez relacji

Usunięcie konta kasuje profil, role i koszyk. Klienta oraz zamówienie zostawia ze znulowanym `user_id`. Snapshoty zostają.

## 9. RLS i dostęp

RLS jest włączone na wszystkich tabelach tego dokumentu. Express, przez `service_role`, i tak omija RLS, więc uprawnienia sprawdza jawnie w API.

`anon` i `authenticated` nie mają `INSERT`, `UPDATE` ani `DELETE` na tych tabelach.

Odczyt przez PostgREST, jako dodatkowa warstwa:

- `anon` i `authenticated` mogą czytać aktywne kategorie, aktywne produkty i zdjęcia aktywnych produktów;
- `authenticated` może czytać własny profil, własnego klienta, własne adresy rozliczeniowe i własne zamówienia wraz z pozycjami;
- koszyki, płatności, zdarzenia płatności, historia statusów, role, `shop_profile`, `store_settings` i klucze idempotencji nie mają polityki odczytu dla klienta.

Rola `admin` nie dostaje polityki „czytaj wszystkie wiersze”. Admin chodzi przez Express.

## 10. Poza tym schematem

Nie wchodzą do schematu MVP: marketplace, multi-tenant, warianty, dostawa, kurierzy, faktury, kupony, rezerwacje terminów, galerie, subskrypcje, kursy walut, zagraniczne reguły VAT i silnik podatkowy.

`notification_logs` nie należy do tego schematu. Log wysyłek dochodzi przy fazie powiadomień.

Schemat nie jest systemem księgowym. Przed sprzedażą produkcyjną nadal trzeba ustalić dokumenty sprzedaży, moment obowiązku podatkowego i retencję danych. Sposób liczenia kwot w zamówieniu jest w sekcjach 4–6.

## 11. Kolejność przyszłych migracji

1. `profiles` i trigger z `auth.users`, potem `user_roles`.
2. `customers`, potem `customer_addresses`.
3. `shop_profile` z jednym wierszem `unknown`.
4. `categories`, `products`, `product_images`.
5. `carts`, `cart_items`.
6. `orders`, `order_items`, `order_status_history`.
7. `payments`, `payment_events`.
8. `idempotency_keys`.
9. `store_settings`.
10. RLS, zdjęcie zapisów dla ról klienta i indeksy, które nie powstały razem z tabelami.
11. Seed demonstracyjny, bez sekretów i bez nadania `admin` przez publiczną rejestrację.

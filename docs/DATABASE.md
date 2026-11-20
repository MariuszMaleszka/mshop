# Model danych

Dokument opisuje zaakceptowany schemat PostgreSQL. Nie jest migracją. Źródłem prawdy po wdrożeniu pozostaną pliki SQL w `supabase/migrations/`.

## 1. Konwencje

- PostgreSQL w Supabase.
- Klucze główne: `uuid`, domyślnie `gen_random_uuid()`, poza `profiles.id` i singletonem `shop_profile`.
- Czas: `timestamptz` w UTC. `created_at` na każdej tabeli. `updated_at` tam, gdzie wiersz wolno zmieniać; ustawia go trigger.
- Kwoty: `bigint` w najmniejszej jednostce waluty. Dla PLN są to grosze. Zakaz `float` i `real`.
- Waluta: `char(3)`, kod alfabetyczny ISO 4217. Check formatu `^[A-Z]{3}$`. Brak checka ograniczającego wartość do `PLN`, więc schemat nie wyklucza późniejszego `EUR` ani `USD`. `products.currency` i `carts.currency` mają domyślnie `PLN`. `orders`, `order_items` i `payments` nie mają domyślnej waluty.
- Na MVP Express przyjmuje wyłącznie `PLN`. Kursów i przeliczania nie ma.
- `price_amount` produktu jest ceną brutto za sztukę, z dokładnością do dwóch miejsc po przecinku. W bazie ta dokładność jest zapisana jako `bigint` w groszach, nie jako liczba zmiennoprzecinkowa. Przy sprzedawcy `registered` i `tax_status = standard` zawiera VAT. W pozostałych przypadkach jest to cała kwota do zapłaty, bez wyliczania sztucznego podatku.
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

### `account_sessions`

Sesja konta. Nie jest sesją gościa i nie zawiera logowania. Surowego identyfikatora sesji, sekretu CSRF, access tokenu ani refresh tokenu w tabeli nie ma.

- `id_hash char(64) PK` — SHA-256 identyfikatora sesji, tylko małe hex
- `user_id uuid not null references auth.users(id) on delete cascade`
- `refresh_state text not null` — `ready`, `pending` albo `unknown`
- `refresh_generation uuid null` — wymagane przy `pending`, puste przy `ready`
- `refresh_started_at timestamptz null` — wymagane przy `pending`
- `refresh_token_hash char(64) null` — SHA-256 refresh tokenu wysłanego do rotacji, tylko przy `pending`
- `key_version smallint not null` — wersja klucza AES-256-GCM, co najmniej 1
- `access_ciphertext`, `access_nonce`, `access_tag` — albo wszystkie puste, albo nonce ma 12 bajtów i tag 16
- `refresh_ciphertext`, `refresh_nonce`, `refresh_tag` — ten sam układ
- `csrf_token_hash char(64) not null`
- `absolute_expires_at timestamptz not null` — po `created_at`
- `idle_expires_at timestamptz not null` — po `created_at` i nie później niż `absolute_expires_at`
- `created_at timestamptz not null`
- `updated_at timestamptz not null`

`ready` wymaga obu zestawów tokenów i pustych pól rotacji. `pending` wymaga obu zestawów, generacji, czasu startu i skrótu refresh tokenu. `unknown` wymaga pustych tokenów i pustego skrótu refresh tokenu. Indeks częściowy `(refresh_started_at)` obejmuje tylko `pending`. RLS jest włączone. `anon`, `authenticated` i `service_role` nie mają żadnych uprawnień do tej tabeli ani do `login_challenges` i `auth_attempt_counters`.

### `login_challenges`

Wyzwanie CSRF przed sesją. Surowego identyfikatora i sekretu nie ma.

- `id_hash char(64) PK`
- `csrf_token_hash char(64) not null`
- `expires_at timestamptz not null` — po `created_at`
- `consumed_at timestamptz null` — puste albo nie wcześniejsze niż `created_at`
- `created_at timestamptz not null`
- `updated_at timestamptz not null`

Indeks na `expires_at`. RLS jak przy sesji konta.

### `auth_attempt_counters`

Licznik okna. Klucz nie zawiera jawnego adresu ani e-maila.

- klucz główny (`bucket_hash char(64)`, `purpose text`, `window_start timestamptz`)
- `purpose` — `login`, `login_pair`, `csrf` albo `refresh`
- `count integer not null` — co najmniej 0
- `created_at timestamptz not null`
- `updated_at timestamptz not null`

Podbicie licznika jest jednym `INSERT ... ON CONFLICT DO UPDATE`. RLS jak przy sesji konta.

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

Jeszcze bez migracji. Poniższy opis zostaje uzgodnionym modelem książki adresów.

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
- `business_name text` — wymagana przy `registered` i `exempt`; po `btrim` nie może być pusta
- `nip text` — `^[0-9]{10}$`; wymagany przy `registered` i `exempt`; przy `unknown` opcjonalny, a podany musi mieć ten format
- `street text` — wymagana przy `registered` i `exempt`
- `building_number text` — wymagany przy `registered` i `exempt`
- `unit_number text` — opcjonalny; podany nie może być pusty po `btrim`
- `postal_code text` — `^[0-9]{2}-[0-9]{3}$`; wymagany przy `registered` i `exempt`; przy `unknown` opcjonalny
- `city text` — wymagane przy `registered` i `exempt`
- `country_code varchar(2) not null` — `^[A-Z]{2}$`; domyślnie `PL`
- `updated_at timestamptz not null`

Migracja tożsamości dopisuje kolumny do istniejącego wiersza. Nie zmienia statusu `unknown` i nie wpisuje nazwy ani NIP. Kraj dostaje domyślne `PL`.

- `registered` — czynny podatnik VAT
- `exempt` — sprzedawca korzysta ze zwolnienia z VAT
- `unknown` — status nieustalony; checkout jest zablokowany i zamówienie nie powstaje

### `store_settings`

Jeszcze bez migracji. Status podatkowy sprzedawcy jest w `shop_profile`, nie tutaj.

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
| `standard` | wymagany, wyłącznie `23.00`, `8.00` albo `5.00` | VAT liczony z kwoty brutto |
| `zero_rated` | dokładnie `0.00` | VAT = 0, netto = brutto |
| `exempt` | null | VAT = 0, netto = brutto |
| `not_subject` | null | VAT = 0, netto = brutto |

Null w `vat_rate` sam nie oznacza zwolnienia. Check `products_tax_check` wymaga `vat_rate is not null` przy `standard` i `zero_rated`.

Stan magazynowy nie zależy od typu produktu. Usługa i produkt cyfrowy nie muszą go mieć. Zaawansowanego magazynu nie ma.

Lokalny skrypt `pnpm seed:local-catalog` dopisuje dwie aktywne kategorie i trzy aktywne produkty wyłącznie do PostgreSQL na `127.0.0.1:54322`, w bazie `postgres`. Jest idempotentny, nie nadpisuje różnych istniejących rekordów i nie zmienia `shop_profile`, klientów, zamówień, płatności, koszyków ani rezerwacji.

### `product_images`

Jeszcze bez migracji. Poniższy opis zostaje uzgodnionym modelem zdjęć produktu.

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

Ciasteczko gościa jest `httpOnly` i `SameSite=Lax`, bez `Domain`. Atrybut `Secure` dostaje tylko w produkcji. Niesie nieprzewidywalny losowy sekret. W bazie leży tylko skrót.

API koszyka konta i koszyka gościa jest zaimplementowane. Oba koszyki mogą być aktywne jednocześnie. Samo zalogowanie nie uruchamia łączenia. Łączy je jawne `POST /api/v1/cart/merge` w jednej transakcji, po blokadzie gościa i blokadzie konta:

- jest tylko koszyk gościa z pozycjami: ustaw `user_id`, wyczyść `session_id`, zostaw `active` i te same identyfikatory;
- są oba aktywne koszyki: dopisz albo zsumuj pozycje w koszyku konta, a koszyk gościa ustaw na `abandoned` bez zmiany `session_id` i z pustym `user_id`;
- koszyk gościa nie istnieje albo nie ma pozycji: nic nie łącz i nie twórz wiersza.

`converted` ustawia checkout, nie logowanie ani scalanie. Zmiana `products.currency` albo `products.price_amount` nie przelicza istniejących koszyków. Scalanie czyta aktualną cenę z katalogu i odrzuca walutę inną niż `PLN`.

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

Checkout jest jedną transakcją. Przy `shop_profile.seller_tax_status = unknown` odczyt profilu odrzuca żądanie kodem `SELLER_TAX_STATUS_UNKNOWN`, transakcja się wycofuje i zamówienie nie zostaje zapisane. Sprzedawca `registered` z produktem `standard` też wycofuje transakcję, kodem `VAT_POLICY_NOT_CONFIRMED`, bo strategia VAT dla stawki standardowej nie jest zatwierdzona.

Express sprawdza, że każdy produkt koszyka ma tę samą walutę co koszyk. Na MVP ta waluta musi być `PLN`. Do zamówienia i płatności trafia kod z tej chwili. Później się nie zmienia.

Dla `zero_rated`, `exempt` i `not_subject` podatek wynosi 0, a netto równa się brutto. Stawki nie wyciąga się wtedy z ceny. Schemat nie liczy VAT.

Czysty moduł `apps/api/src/order-amounts/calculate.js` liczy ofertę poza bazą i operatorem płatności. Checkout gotówkowy woła go tylko wtedy, gdy wynik da się zapisać bez wyboru strategii dla stawki `standard`. Wywołanie zawsze podaje strategię `per_line` albo `per_rate`. Nie ma strategii domyślnej i żadna nie jest zatwierdzoną polityką produkcyjną. Kwoty w wyniku są tekstowymi liczbami groszy. Liczenie idzie na `BigInt`: VAT procentowy to jedno dzielenie brutto × stawka / (100 + stawka), a half-up dotyczy tylko końcowego grosza. `per_line` zaokrągla VAT każdej pozycji. `per_rate` zaokrągla VAT sumy grupy i nie rozdziela go na pozycje, bo `order_items` wymaga `line_net_amount + line_tax_amount = line_gross_amount`, a reguła alokacji grosza nie jest zatwierdzona. Przy tej strategii pozycje ze stawką procentową mają puste kwoty VAT i netto oraz `lineAmountsComplete: false`. VAT równy zero jest dokładny na pozycji w obu strategiach.

Tymczasowa polityka techniczna dla `standard` przy sprzedawcy `registered`, niezatwierdzona księgowo:

1. Cena katalogowa jest brutto.
2. Kwota ma dwa miejsca po przecinku i w bazie jest liczbą całkowitą groszy.
3. VAT liczy się metodą „w stu”: brutto × stawka / (100 + stawka).
4. Wyników pośrednich nie zaokrągla się.
5. VAT wykazywany w dokumentach księgowych zaokrągla się do pełnego grosza metodą half-up.
6. Netto jest różnicą brutto i wykazanego VAT.
7. Liczenie używa arytmetyki całkowitej albo dziesiętnej. Zwykły `Number` JavaScriptu nie służy do kalkulacji finansowych.

`OPEN — ACCOUNTANT CONFIRMATION REQUIRED`:

- czy VAT zaokrąglać osobno dla każdej pozycji, czy po agregacji wartości według stawek;
- jak postępować z różnicami groszowymi między tymi metodami;
- czy ta kalkulacja i prezentacja kwot będzie prawidłowa na dokumentach sprzedaży sklepu.

Żadna z tych metod agregacji nie jest zatwierdzona. Status sprzedawcy, jego dane identyfikacyjne, klasyfikacja produktów i stawki, rodzaj dokumentu sprzedaży dla osoby prywatnej i firmy, kasa fiskalna, ewidencja płatności gotówkowych i internetowych oraz wpływ wysyłki i odbioru osobistego na dokumentowanie sprzedaży też nie są rozstrzygnięte. Są odłożone do konsultacji z księgowym w `docs/PROJECT_HANDOFF.md`. Nie blokują dalszych prac technicznych. Blokują ostateczne uruchomienie sprzedaży w zakresie, którego dotyczą. Implementacja nie wybiera dla nich wartości domyślnej.

Gdy sprzedawca jest `exempt`, zastosowany status każdej pozycji to `exempt`, zastosowana stawka jest null, podatek wynosi 0, a netto równa się brutto. Snapshot katalogowy zostaje taki, jaki był na produkcie.

Gdy sprzedawca jest `registered`, zastosowany status i stawka pochodzą z produktu.

Sumy nagłówka równają się sumom pozycji. Sprawdza to transakcja checkoutu, nie klucz obcy.

### `orders`

- `id uuid PK`
- `order_number text not null unique`
- `customer_id uuid null references customers(id) on delete set null`
- `user_id uuid null references auth.users(id) on delete set null`
- `session_id char(64) null` — SHA-256 ciasteczka `shop_guest_session`, 64 znaki hex; nie surowy identyfikator
- `customer_email text not null`
- `customer_type text not null` — `individual` lub `company`
- `billing_snapshot jsonb not null`
- `seller_tax_status_snapshot text not null` — tylko `registered` albo `exempt`
- `seller_business_name_snapshot text not null` — po `btrim` niepuste
- `seller_nip_snapshot text not null` — `^[0-9]{10}$`
- `seller_street_snapshot text not null` — po `btrim` niepuste
- `seller_building_number_snapshot text not null` — po `btrim` niepuste
- `seller_unit_number_snapshot text null` — null albo po `btrim` niepuste
- `seller_postal_code_snapshot text not null` — `^[0-9]{2}-[0-9]{3}$`
- `seller_city_snapshot text not null` — po `btrim` niepuste
- `seller_country_code_snapshot varchar(2) not null` — `^[A-Z]{2}$`
- `currency char(3) not null` — bez wartości domyślnej; check `^[A-Z]{3}$`
- `net_amount bigint not null`
- `tax_amount bigint not null`
- `gross_amount bigint not null`
- `payment_method text not null` — `online` albo `cash`
- `payment_status text not null` — domyślnie `pending`
- `fulfillment_status text not null` — domyślnie `new`
- `created_at timestamptz not null`
- `updated_at timestamptz not null`

`gross_amount = net_amount + tax_amount`. Wszystkie trzy kwoty są nieujemne. `gross_amount` jest kwotą przekazywaną operatorowi płatności. Nie ma kolumny `orders.status`. Snapshot sprzedawcy nie ma klucza obcego do `shop_profile`. Kolumny dodano przy pustej tabeli `orders`, bez wartości domyślnych.

Nowe zamówienie konta ma `user_id` i puste `session_id`. Nowe zamówienie gościa ma puste `user_id` i `session_id` równe skrótowi używanemu w koszyku. Check zabrania ustawienia obu pól naraz i nie wymaga żadnego z nich, więc istniejące wiersze bez właściciela pozostają bez zmian. Indeks `orders_session_id_created_at_idx` obejmuje tylko wiersze ze skrótem.

Na `orders` są klucze unikalne obok `order_number`: `(id, currency)`, `(id, payment_method)` oraz `(id, payment_method, currency, gross_amount)`. Służą kluczom obcym pozycji, rezerwacji i płatności. Nie zastępują klucza głównego. `(id, payment_method)` jest celem klucza rezerwacji; `id` jest już unikalne, więc ten klucz nie odrzuca istniejących wierszy.

`billing_snapshot` zawiera wyłącznie dane z chwili zakupu: `first_name`, `last_name`, `company_name`, `nip`, `phone`, `recipient`, `street`, `building_number`, `apartment_number`, `postal_code`, `city`, `country_code`. Kształt sprawdza Express.

Status płatności: `pending`, `paid`, `failed`, `cancelled`, `refunded`, `partially_refunded`.

Status realizacji: `new`, `processing`, `completed`, `cancelled`.

Te osie są niezależne. Baza nie wymusza kolejności między nimi.

### `order_items`

Każda pozycja ma snapshot katalogowy i snapshot użyty do kwot. Przy sprzedawcy zwolnionym produkt może mieć katalogowo `standard` i stawkę 23, a pozycja i tak jest liczona jako `exempt` ze stawką null.

- `id uuid PK`
- `order_id uuid not null`
- `product_id uuid null references products(id) on delete set null`
- `product_name_snapshot text not null`
- `product_type_snapshot text not null`
- `sku_snapshot text null`
- `currency char(3) not null` — bez wartości domyślnej; ten sam kod co `orders.currency`
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
- `standard`: stawka wyłącznie `23.00`, `8.00` albo `5.00` i `is not null`; podatek nieujemny
- `zero_rated`: stawka `0.00` i `is not null`, podatek `0`, netto = brutto
- `exempt` i `not_subject`: stawka null, podatek `0`, netto = brutto

Dla `standard` podatek nie musi być większy od zera. Zaokrąglenie bardzo małej kwoty może dać zero.

Zgodność waluty pozycji z zamówieniem wymusza klucz obcy `(order_id, currency)` → `orders (id, currency)` z `on delete cascade`. Usunięcie produktu zeruje `product_id` i zostawia snapshot. Późniejsza zmiana produktu, jego ceny, waluty albo stawki nie zmienia pozycji. `UNIQUE (id, product_id)` jest celem złożonego klucza rezerwacji.

### `inventory_reservations`

Jedna rezerwacja na pozycję zamówienia. `payment_method` jest kopią metody zamówienia i musi zgadzać się z `orders (id, payment_method)`.

- `id uuid PK`
- `order_id uuid not null references orders(id) on delete restrict`
- `order_item_id uuid not null references order_items(id)` — unikalne
- `product_id uuid null references products(id) on delete set null`
- `payment_method text not null` — `online` albo `cash`
- `quantity integer not null` — check `>= 1`
- `status text not null` — `active`, `consumed`, `released` albo `expired`
- `expires_at timestamptz null`
- `created_at timestamptz not null`
- `updated_at timestamptz not null`

Aktywna rezerwacja wymaga produktu. Aktywna rezerwacja `online` wymaga `expires_at`, a aktywna rezerwacja `cash` wymaga pustego `expires_at`. Checkout online zapisuje termin jako `clock_timestamp() + 15 minutes` w transakcji zamówienia. Osobny proces `pnpm --filter @shop/api expiry:worker` co 30 sekund po zakończeniu poprzedniego przebiegu oznacza należne aktywne rezerwacje online całego zamówienia jako `expired`. Nie zmienia `stock_quantity`, statusu zamówienia ani statusu płatności. Checkout gotówkowy zostawia rezerwację `active` z pustym `expires_at`. Aplikacja nie przechodzi tej rezerwacji do `consumed` ani `released` i nie ma endpointu, który oznacza gotówkę jako opłaconą. Późniejsze `paid`, także po wygaśnięciu rezerwacji online, nie zmienia rezerwacji, `stock_quantity` ani `fulfillment_status`, więc samo potwierdzenie płatności nie rozwiązuje realizacji. Zwolnienie rezerwacji zwiększa ilość dostępną w checkoutcie, bo ta ilość jest stanem produktu pomniejszonym o aktywne rezerwacje. Złożony klucz `(order_item_id, product_id)` wskazuje `order_items (id, product_id)`, z `on update cascade` i `on delete set null (product_id)`. Usunięcie produktu przy rezerwacji `consumed`, `released` albo `expired` zeruje `product_id` i zostawia `order_item_id`. Przy statusie `active` ten sam zapis odrzuca `CHECK` i całe usunięcie produktu się wycofuje.

RLS jest włączone. Nie ma polityk. `anon` i `authenticated` nie mają uprawnień.

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

Operatorem płatności online w MVP jest Przelewy24. Sklep jest skierowany na rynek polski. Stripe i inni operatorzy nie są teraz implementowani. Schemat nadal dopuszcza `stripe` w checku, więc kolejny operator może dojść później jako adapter, bez przebudowy zamówień. Sandboxowy checkout może zapisać płatność `not_started`, a po commicie ustawić `unknown` albo `registered` z tokenem w `redirect_token`. `provider_transaction_id` pozostaje puste do finalizacji webhooka. Produkcyjny checkout online pozostaje wyłączony. Worker wygaszania rezerwacji działa jako osobny proces. Webhook Przelewy24 jest podłączony. Zapisuje `verification_requested` przed `transaction/verify` i nie ponawia tego wywołania. Finalizacja zgodnej płatności `pending` zapisuje `verification_accepted` oraz status `paid` atomowo. Potwierdzenie nie przywraca rezerwacji wygasłych po 15 minutach od utworzenia zamówienia. Integracja operatora jest wydzielona, bez systemu wielu operatorów na zapas. Ta decyzja nie zmienia schematu. Model nadal przyjmuje gotówkę. Sekrety operatora są w środowisku, nie w bazie. Danych karty nie zapisujemy.

Webhook jest źródłem prawdy dla płatności online. Powrót przeglądarki na stronę sukcesu nie ustawia `paid`. Przed `paid` Express sprawdza podpis, kwotę, walutę, zamówienie i status.

`payments.amount` równa się `orders.gross_amount`, `payments.currency` równa się `orders.currency`, a `payments.method` równa się `orders.payment_method`. Wymusza to klucz obcy `(order_id, method, currency, amount)` → `orders (id, payment_method, currency, gross_amount)` z `on delete restrict`. Po utworzeniu tych pól nie zmieniamy. Zmiana katalogu ich nie przelicza. Nie ma triggera, który kopiuje `payments.status` do `orders.payment_status`. Webhook po dokładnym `data.status` równym `success` sam, w jednej transakcji, zapisuje `verification_accepted`, ustawia oba statusy na `paid`, `provider_transaction_id` i `paid_at` oraz dopisuje historię płatności. Nie zmienia rezerwacji ani `stock_quantity`. Produkcyjny checkout online pozostaje wyłączony.

Jedna próba to jeden wiersz. Kolejna próba po `failed`, `cancelled` albo `refunded` jest nowym wierszem. Częściowy zwrot nie zwalnia miejsca na następną aktywną próbę.

### `payments`

- `id uuid PK`
- `order_id uuid not null`
- `method text not null` — `online` albo `cash`
- `provider text null` — `przelewy24` albo `stripe`, gdy `method = online`; null dla gotówki
- `provider_transaction_id text null` — przy gotówce też null; przy online może być null, dopóki operator nie nada identyfikatora. To nie jest token przekierowania.
- `initialization_status text null` — tylko dla `provider = przelewy24`: `not_started`, `unknown`, `registered` albo `rejected`. Gotówka i `stripe` mają null. Stan finansowy `status` pozostaje osobny.
- `redirect_token text null` — token przekierowania Przelewy24. Wymagany wyłącznie przy `initialization_status = registered` i wtedy po `btrim` niepusty. Pozostałe stany oraz gotówka mają null.
- `status text not null` — ten sam zestaw co `orders.payment_status`; domyślnie `pending`
- `amount bigint not null` — check `>= 0`
- `refunded_amount bigint not null` — domyślnie `0`; check `>= 0` i `<= amount`
- `currency char(3) not null` — bez wartości domyślnej; check `^[A-Z]{3}$`
- `paid_at timestamptz null`
- `created_at timestamptz not null`
- `updated_at timestamptz not null`

`updated_at` ustawia istniejąca funkcja `set_updated_at`.

Check wiąże status z `paid_at` i `refunded_amount`:

| Status | `paid_at` | `refunded_amount` |
|---|---|---|
| `pending`, `failed`, `cancelled` | null | `0` |
| `paid` | wymagany | `0` |
| `partially_refunded` | wymagany | większy od 0 i mniejszy od `amount` |
| `refunded` | wymagany | równy `amount` |

Przy `amount = 0` częściowy zwrot jest niemożliwy. Pełny zwrot zera jest dozwolony.

`cancelled` oznacza płatność, która nie doszła do skutku. Po `paid` zwrot całkowity to `refunded`, a częściowy to `partially_refunded`.

Najwyżej jedna aktywna płatność na zamówienie. Aktywne statusy to `pending`, `paid` i `partially_refunded`. `failed`, `cancelled` i `refunded` nie blokują kolejnej próby. Para (`provider`, `provider_transaction_id`) jest unikalna, gdy identyfikator nie jest null.

### `payment_events`

Osobny mechanizm od `idempotency_keys`. Zdarzenie zapisuje webhook albo ręczne potwierdzenie gotówki. Nie zabezpiecza powtórzonego `POST` klienta.

- `id uuid PK`
- `payment_id uuid not null references payments(id) on delete cascade`
- `provider text not null` — `przelewy24`, `stripe` albo `manual`
- `provider_event_id text null`
- `event_type text not null` — niepusty tekst, bez listy nazw operatora
- `payload jsonb not null` — obiekt JSON, bez danych karty i bez sekretów
- `processed_at timestamptz null` — null oznacza zdarzenie przyjęte i jeszcze niezastosowane
- `created_at timestamptz not null`

Nie ma `updated_at` ani `changed_by`. Administratora potwierdzającego gotówkę zapisuje `order_status_history.changed_by`.

Para (`provider`, `provider_event_id`) jest unikalna, gdy identyfikator nie jest null. Kolumna zostaje nullable. Powiadomienie Przelewy24 nie ma identyfikatora zdarzenia, więc `verification_requested`, `verification_accepted` i ewentualne przyszłe `verification_declined` zapisują `provider_event_id` jako null. Nieznany status weryfikacji nie tworzy `verification_declined`. Brak automatycznego domknięcia tych stanów opisuje `docs/P24_RECONCILIATION.md`. Idempotencja wynika ze stanu płatności, tych zdarzeń i blokady sesyjnej, a nie ze skrótu payloadu ani z `processed_at`. Zgodność `payment_events.provider` z operatorem płatności sprawdza Express, nie klucz obcy: `stripe` tylko przy płatności `stripe`, `przelewy24` tylko przy `przelewy24`, `manual` tylko przy gotówce.

### `idempotency_keys`

Osobny mechanizm od `payment_events`. Zabezpiecza powtórzenie tego samego żądania HTTP. Nie obsługuje webhooków.

Wiersz powstaje w tej samej transakcji co operacja. Nie ma kolumny statusu ani wartości `pending`, `completed` i `failed`. Pusty wynik może istnieć tylko przed commitem. Express commituje dopiero uzupełnioną odpowiedź. Błąd walidacji i wycofana transakcja nie zostawiają zakończonego wyniku.

- `id uuid PK`
- `idempotency_key text not null` — nagłówek `Idempotency-Key`, od 1 do 255 znaków
- `operation text not null` — stała nazwa operacji, od 1 do 100 znaków, bez listy wartości i bez surowego URL
- `user_id uuid null references auth.users(id) on delete cascade`
- `session_id char(64) null` — ten sam skrót ciasteczka co koszyk gościa; check `^[0-9a-f]{64}$`
- `request_hash char(64) not null` — SHA-256 znormalizowanego żądania; check `^[0-9a-f]{64}$`
- `response_status integer null` — gdy ustawiony, od 200 do 299
- `response_body jsonb null` — gdy ustawiony, obiekt JSON przeznaczony dla klienta
- `order_id uuid null references orders(id) on delete set null`
- `created_at timestamptz not null`
- `expires_at timestamptz not null` — check `expires_at > created_at`

Oba pola wyniku są puste albo oba ustawione. Surowego żądania, tokenu, ciasteczka i danych karty tabela nie przechowuje. Nie ma klucza do koszyka ani do płatności. Checkout wypełnia `order_id`. Inne operacje mogą go zostawić puste.

Check właściciela jest taki sam jak przy koszyku: dokładnie jedno z pól `user_id` i `session_id`. Logowanie nie przepisuje kluczy gościa na konto.

Klucz nie jest unikalny globalnie. Unikalność obejmuje właściciela i operację:

- `(user_id, operation, idempotency_key)`, gdzie `user_id is not null`
- `(session_id, operation, idempotency_key)`, gdzie `session_id is not null`

Ten sam napis może więc wystąpić u innego właściciela albo w innej operacji. Ten sam klucz przy innym `request_hash` jest konfliktem i operacja się nie wykonuje. Ten sam klucz, operacja, właściciel i hash zwracają zapisany wynik.

Ważność wynosi 24 godziny. Indeks na `expires_at` służy usuwaniu starych wierszy. Predykat indeksu nie używa `now()`. Wygasły wiersz Express usuwa w transakcji nowego żądania z tym samym właścicielem, operacją i kluczem. Osobny proces cleanup nie jest częścią schematu. Jest też indeks na `order_id`.

## 8. Relacje

- `auth.users` 1:1 `profiles`
- `auth.users` 1:N `user_roles`
- `auth.users` 1:N `account_sessions`
- `auth.users` 0:1 `customers` na MVP
- `customers` 1:N `customer_addresses` — tabela adresów jeszcze bez migracji
- `categories` 1:N `products`
- `products` 1:N `product_images` — tabela zdjęć jeszcze bez migracji
- `carts` 1:N `cart_items`
- `orders` 1:N `order_items`
- `orders` 1:N `payments` — najwyżej jedna aktywna płatność
- `orders` 1:N `order_status_history`
- `orders` 1:N `idempotency_keys` — `order_id` może być null
- `payments` 1:N `payment_events`
- `shop_profile` — jeden wiersz, bez relacji
- `store_settings` — jeszcze bez migracji, bez relacji

Usunięcie konta kasuje profil, role, koszyk i klucze idempotencji tego konta. Klienta oraz zamówienie zostawia ze znulowanym `user_id`. Snapshoty zostają. Klucze gościa zostają przy sesji. Usunięcie zamówienia, które ma płatność, jest zablokowane. Usunięcie zamówienia bez płatności zeruje `idempotency_keys.order_id`.

## 9. RLS i dostęp

RLS jest włączone na każdej tabeli z obecnych migracji. Tabele jeszcze bez migracji dostaną RLS razem ze swoją migracją. Express łączy się rolą z `DATABASE_URL`, nie rolą `service_role` i nie kluczem `SUPABASE_SERVICE_ROLE_KEY`. Na lokalnej bazie ta rola to `postgres`: właściciel tabel, z `BYPASSRLS`, więc RLS jej nie ogranicza. Uprawnienia do zasobów użytkownika API sprawdza jawnie w zapytaniach. RLS nie zastępuje tej kontroli.

`anon` i `authenticated` nie mają `INSERT`, `UPDATE` ani `DELETE` na tych tabelach. Do `account_sessions`, `login_challenges` i `auth_attempt_counters` nie mają też `SELECT`. To samo dotyczy `service_role`, mimo że ta rola ma `BYPASSRLS`. Domyślne uprawnienia schematu `public` nadają jej prawa przy tworzeniu tabeli. Migracja `20261120160000_revoke_session_table_api_grants.sql` je odbiera. Domyślne uprawnienia nie nadają ich ponownie istniejącej tabeli. Nie ma widoku, funkcji ani publikacji, które wystawiają te trzy tabele przez API Supabase.

Odczyt przez PostgREST, jako dodatkowa warstwa:

- `anon` i `authenticated` mogą czytać aktywne kategorie, aktywne produkty i zdjęcia aktywnych produktów;
- `authenticated` może czytać własny profil, własnego klienta, własne adresy rozliczeniowe i własne zamówienia wraz z pozycjami;
- koszyki, płatności, zdarzenia płatności, historia statusów, role, `shop_profile`, `store_settings` i klucze idempotencji nie mają polityki odczytu dla klienta.

Rola `admin` nie dostaje polityki „czytaj wszystkie wiersze”. Admin chodzi przez Express.

## 10. Poza tym schematem

Nie wchodzą do schematu MVP: marketplace, multi-tenant, warianty, dostawa, kurierzy, faktury, kupony, rezerwacje terminów, galerie, subskrypcje, kursy walut, zagraniczne reguły VAT i silnik podatkowy.

`notification_logs` nie należy do tego schematu. Log wysyłek dochodzi przy fazie powiadomień.

Schemat nie jest systemem księgowym. Przed sprzedażą produkcyjną nadal trzeba ustalić dokumenty sprzedaży, moment obowiązku podatkowego i retencję danych. Sposób liczenia kwot w zamówieniu jest w sekcjach 4–6.

## 11. Migracje

Zastosowane lokalnie, w tej kolejności:

1. `20261117140000_identity_and_shop_profile.sql` — `profiles`, trigger `handle_new_user`, `user_roles`, `customers`, `shop_profile`.
2. `20261117150000_catalog_categories_and_products.sql` — `categories`, `products`.
3. `20261117160000_carts_and_cart_items.sql` — `carts`, `cart_items`.
4. `20261117170000_orders_and_status_history.sql` — `orders`, `order_items`, `order_status_history`.
5. `20261117180000_payments_and_payment_events.sql` — `payments`, `payment_events` oraz unikalność `(id, payment_method, currency, gross_amount)` na `orders`.
6. `20261117190000_idempotency_keys.sql` — `idempotency_keys`.
7. `20261118100000_shop_profile_seller_identity.sql` — dane identyfikacyjne w `shop_profile`.
8. `20261118100100_order_seller_snapshot.sql` — snapshot sprzedawcy w `orders`.
9. `20261118100200_standard_vat_rates.sql` — stawki `standard` 23, 8 i 5.
10. `20261118100300_inventory_reservations.sql` — `inventory_reservations` oraz klucze `(id, product_id)` i `(id, payment_method)`.
11. `20261119120000_payment_initialization.sql` — `payments.initialization_status` i `payments.redirect_token` dla Przelewy24.
12. `20261120120000_order_guest_session.sql` — `orders.session_id` dla skrótu sesji gościa, bez uzupełniania starych wierszy.
13. `20261120140000_account_sessions.sql` — `account_sessions`, `login_challenges`, `auth_attempt_counters`. Bez tras logowania.
14. `20261120160000_revoke_session_table_api_grants.sql` — odebranie `service_role` uprawnień do tych trzech tabel. Rola z `DATABASE_URL` zostaje.

RLS i indeksy tych tabel powstały razem z nimi.

Jeszcze bez migracji: `customer_addresses`, `product_images`, `store_settings` oraz seed demonstracyjny, bez sekretów i bez nadania `admin` przez publiczną rejestrację.

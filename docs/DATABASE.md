# Model danych

## 1. Konwencje
- PostgreSQL.
- Klucze główne: UUID.
- Daty: `timestamptz`, przechowywane w UTC.
- Kwoty: `bigint` w najmniejszej jednostce waluty (np. grosze); nie używaj `float`/`real`.
- Kwoty mają jawny kod waluty, np. `PLN`.
- Tabele mają `created_at`; `updated_at` tam, gdzie rekord jest edytowalny.
- Migracje są jedynym źródłem prawdy dla schematu.
- Nie edytuj produkcyjnej bazy ręcznie bez migracji.

## 2. Tożsamość i klienci

### `profiles`
- `id uuid PK references auth.users(id) on delete cascade`
- `display_name text null`
- `phone text null`
- `created_at timestamptz`
- `updated_at timestamptz`

`profiles` przechowuje podstawowe dane powiązane z kontem. Nie przechowuje hasła.

### `user_roles`
- `id uuid PK`
- `user_id uuid references auth.users(id) on delete cascade`
- `role text` — na start `admin` lub `customer`
- `created_at timestamptz`
- unique (`user_id`, `role`)

Nie pozwalaj użytkownikowi samodzielnie nadać sobie roli `admin`. Nadawanie ról wyłącznie przez zaufaną operację serwerową.

### `customers`
- `id uuid PK`
- `user_id uuid null references auth.users(id) on delete set null`
- `customer_type text` — `individual` lub `company`
- `email text not null`
- `phone text null`
- `first_name text null`
- `last_name text null`
- `company_name text null`
- `nip text null`
- `created_at timestamptz`
- `updated_at timestamptz`

Założenie MVP: jeden profil klienta może być powiązany z jednym kontem. Zakup gościnny może mieć `user_id = null`. Jeśli później jedno konto ma obsługiwać wiele podmiotów/firm, model należy rozszerzyć.

### `customer_addresses`
- `id uuid PK`
- `customer_id uuid references customers(id) on delete cascade`
- `address_type text` — `billing` lub `shipping`
- `recipient text null`
- `company_name text null`
- `street text`
- `building_number text`
- `apartment_number text null`
- `postal_code text`
- `city text`
- `country_code text`
- `created_at timestamptz`
- `updated_at timestamptz`

## 3. Katalog

### `categories`
- `id uuid PK`
- `name text`
- `slug text unique`
- `description text null`
- `is_active boolean`
- `sort_order integer`
- `created_at timestamptz`
- `updated_at timestamptz`

### `products`
- `id uuid PK`
- `category_id uuid null references categories(id) on delete set null`
- `name text`
- `slug text unique`
- `description text null`
- `product_type text` — `physical`, `digital`, `service`
- `sku text null unique`
- `price_amount bigint`
- `currency char(3)` — domyślnie `PLN`
- `vat_rate numeric(5,2) null`
- `is_active boolean`
- `stock_quantity integer null` — tylko jeśli faktycznie śledzimy stan
- `created_at timestamptz`
- `updated_at timestamptz`

Waliduj, że cena jest nieujemna. Nie zakładaj, że każda usługa ma stan magazynowy.

### `product_images`
- `id uuid PK`
- `product_id uuid references products(id) on delete cascade`
- `storage_path text`
- `alt_text text null`
- `sort_order integer`
- `created_at timestamptz`

W bazie przechowuj ścieżkę obiektu w Storage, nie zaufany URL przesłany przez klienta. Dla plików prywatnych generuj krótkotrwałe signed URLs.

## 4. Koszyk

### `carts`
- `id uuid PK`
- `user_id uuid null references auth.users(id) on delete cascade`
- `session_id text null`
- `status text` — `active`, `converted`, `abandoned`
- `currency char(3)`
- `created_at timestamptz`
- `updated_at timestamptz`

### `cart_items`
- `id uuid PK`
- `cart_id uuid references carts(id) on delete cascade`
- `product_id uuid references products(id) on delete restrict`
- `quantity integer`
- `created_at timestamptz`
- `updated_at timestamptz`
- unique (`cart_id`, `product_id`)

Cena w koszyku nie jest wiążąca. Backend ponownie pobiera aktualną cenę i dostępność podczas checkoutu.

## 5. Zamówienia

### `orders`
- `id uuid PK`
- `order_number text unique`
- `customer_id uuid null references customers(id) on delete set null`
- `user_id uuid null references auth.users(id) on delete set null`
- `customer_email text`
- `customer_type text` — `individual` lub `company`
- `billing_snapshot jsonb`
- `currency char(3)`
- `subtotal_amount bigint`
- `tax_amount bigint`
- `total_amount bigint`
- `payment_method text` — np. `online` lub `cash`
- `payment_status text` — `pending`, `paid`, `failed`, `refunded`, `partially_refunded`
- `fulfillment_status text` — `new`, `processing`, `completed`, `cancelled`
- `created_at timestamptz`
- `updated_at timestamptz`

Snapshot danych rozliczeniowych zachowuje dane z chwili zakupu. Ogranicz zawartość snapshotu do danych niezbędnych do realizacji obowiązków i obsługi zamówienia.

### `order_items`
- `id uuid PK`
- `order_id uuid references orders(id) on delete cascade`
- `product_id uuid null references products(id) on delete set null`
- `product_name_snapshot text`
- `product_type_snapshot text`
- `sku_snapshot text null`
- `unit_price_amount bigint`
- `quantity integer`
- `tax_rate_snapshot numeric(5,2) null`
- `line_total_amount bigint`

Dane pozycji są snapshotem — późniejsza zmiana produktu nie zmienia historycznego zamówienia.

### `order_status_history`
- `id uuid PK`
- `order_id uuid references orders(id) on delete cascade`
- `status_type text` — `payment` lub `fulfillment`
- `old_status text null`
- `new_status text`
- `changed_by uuid null`
- `note text null`
- `created_at timestamptz`

## 6. Płatności

### `payments`
- `id uuid PK`
- `order_id uuid references orders(id) on delete restrict`
- `provider text` — np. `przelewy24`
- `provider_transaction_id text null`
- `method text` — `online` lub `cash`
- `status text` — `pending`, `paid`, `failed`, `cancelled`, `refunded`
- `amount bigint`
- `currency char(3)`
- `paid_at timestamptz null`
- `created_at timestamptz`
- `updated_at timestamptz`

### `payment_events`
- `id uuid PK`
- `payment_id uuid references payments(id) on delete cascade`
- `provider_event_id text null`
- `event_type text`
- `payload jsonb`
- `processed_at timestamptz null`
- `created_at timestamptz`

Dodaj unikalność dla identyfikatora zdarzenia dostawcy, jeśli operator go udostępnia. Webhooki muszą być idempotentne. Nie przechowuj danych kart płatniczych ani sekretów.

## 7. Ustawienia i komunikacja

### `store_settings`
- `key text PK`
- `value jsonb`
- `updated_at timestamptz`

Nie przechowuj sekretów operatorów płatności w tej tabeli. Sekrety trzymaj w środowisku/menedżerze sekretów.

### `notification_logs` (opcjonalnie w MVP)
- `id uuid PK`
- `order_id uuid null references orders(id) on delete set null`
- `recipient text`
- `template_key text`
- `provider_message_id text null`
- `status text`
- `created_at timestamptz`

## 8. Relacje — skrót
- `auth.users` 1:1/0:1 `profiles`
- `auth.users` 1:N `user_roles`
- `auth.users` 0:1/N `customers` (MVP zakłada zwykle 0:1)
- `customers` 1:N `customer_addresses`
- `categories` 1:N `products`
- `products` 1:N `product_images`
- `carts` 1:N `cart_items`
- `orders` 1:N `order_items`
- `orders` 1:N `payments`
- `orders` 1:N `order_status_history`
- `payments` 1:N `payment_events`

## 9. RLS i dostęp
- Włącz RLS dla tabel, do których dostęp może mieć klient.
- Klient może odczytać wyłącznie własne profile, adresy, koszyki i zamówienia.
- Publiczny odczyt katalogu obejmuje wyłącznie aktywne produkty i aktywne kategorie.
- Klient nie może zapisywać statusów zamówienia ani płatności.
- Klient nie może nadawać ról.
- Operacje administracyjne są autoryzowane przez backend.
- Jeśli backend używa service role, pamiętaj, że omija ona RLS. Wtedy autoryzacja i ograniczenie zakresu danych muszą być jawnie wykonane w API.

## 10. Uwaga o VAT i dokumentach sprzedaży
Pola i snapshoty są punktem wyjścia, a nie kompletnym systemem księgowym. Przed sprzedażą produkcyjną należy potwierdzić z księgowością sposób liczenia VAT, ceny brutto/netto, moment powstania obowiązku podatkowego, dokumenty sprzedaży i wymagane dane dla klientów firmowych.

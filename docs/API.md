# Kontrakty REST API — wersja robocza

Zaimplementowane są `GET /api/v1/health`, `GET /api/v1/health/ready`, publiczny odczyt aktywnych kategorii i produktów oraz `POST /api/v1/session/guest`. Pozostałe endpointy w tym dokumencie są planowane. Nie są jeszcze dostępne w Express.

## 1. Konwencje
- Prefix: `/api/v1`
- JSON request/response.
- Przyszłe chronione endpointy: `Authorization: Bearer <Supabase access token>`. Express weryfikuje podpis przez JWKS Supabase Auth. Token nie jest logowany.
- Daty w ISO 8601 UTC.
- Kwoty jako integer w najmniejszej jednostce waluty. Dla PLN `12900` = 129,00 PLN.
- Waluta jako kod ISO 4217. Na MVP Express przyjmuje wyłącznie `PLN`.
- Cena w żądaniu klienta nie jest źródłem prawdy. Checkout bierze kwotę należną, walutę i podatek z katalogu.
- Błędy mają wspólny format.
- Nie zwracaj stack trace ani danych dostawców płatności.
- Każda odpowiedź ma nagłówek `X-Request-Id` nadany przez API. Identyfikator przesłany przez klienta nie jest używany. Nie wchodzi do treści JSON.

## 2. Format odpowiedzi

Sukces:
```json
{
  "data": {},
  "meta": {}
}
```

Błąd:
```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid request data",
    "details": [
      {
        "location": "body",
        "path": "name",
        "code": "too_small",
        "message": "Too small: expected string to have >=1 characters"
      }
    ]
  }
}
```

Niepoprawny JSON nadal zwraca HTTP 400, kod `VALIDATION_ERROR` i komunikat `Request validation failed`. Walidacja schematu Zod zwraca komunikat `Invalid request data`. `details` zawiera tylko lokalizację (`body`, `params`, `query`), ścieżkę pola, kod błędu Zod i komunikat walidacji. Nie zawiera przesłanej wartości, tokenu ani całego żądania.

Handler czyta dane z `req.validated`, na przykład `const { page, limit } = req.validated.query`. Middleware walidacji nie jest globalne.

## 3. Health
- `GET /api/v1/health` — sprawdzenie, że proces API działa. Nie wymaga autoryzacji.

```json
{
  "data": { "status": "ok" },
  "meta": {}
}
```

- `GET /api/v1/health/ready` — sprawdzenie, że wspólna pula PostgreSQL wykonuje `SELECT 1`. Nie wymaga autoryzacji. Nie zwraca szczegółów bazy.

Dostępna baza:

```json
{
  "data": { "status": "ready" },
  "meta": {}
}
```

Niedostępna baza: HTTP 503 i kod `SERVICE_UNAVAILABLE`.

## Uwierzytelnianie
Logowanie, rejestracja i odświeżanie sesji należą do Supabase Auth. Express sprawdza access token tylko na trasach, które dostaną middleware `requireAuth`. To middleware nie jest globalne.

Poprawny token udostępnia `req.auth.userId` równe claimowi `sub`. Sprawdzane są podpis, algorytm `ES256` albo `RS256`, issuer `{SUPABASE_URL}/auth/v1`, audience `authenticated`, `exp` i UUID w `sub`.

Brak nagłówka `Authorization` albo token odrzucony:

- HTTP 401
- kod `UNAUTHORIZED`
- komunikat `Authentication required`

Odpowiedź nie zawiera przyczyny kryptograficznej, adresu JWKS ani treści tokenu.

Gdy nie da się pobrać kluczy publicznych:

- HTTP 503
- kod `SERVICE_UNAVAILABLE`
- komunikat `Service unavailable`

Awaria JWKS nie jest zgłaszana jako błąd tokenu. `GET /api/v1/health` i `GET /api/v1/health/ready` nie wymagają nagłówka `Authorization`.

Przyszłe trasy administratora używają `requireAuth`, a potem `requireAdmin`. Rola jest sprawdzana w `public.user_roles` przy każdym żądaniu. Claim roli w JWT nie nadaje uprawnień.

Brak uwierzytelnienia przed sprawdzeniem roli:

- HTTP 401
- kod `UNAUTHORIZED`
- komunikat `Authentication required`

Zalogowany użytkownik bez wiersza `admin`:

- HTTP 403
- kod `FORBIDDEN`
- komunikat `Insufficient permissions`

Błąd odczytu roli z PostgreSQL:

- HTTP 503
- kod `SERVICE_UNAVAILABLE`
- komunikat `Service unavailable`

Odpowiedź 503 nie zawiera SQL, nazw tabel ani szczegółów połączenia. Nie oznacza braku uprawnień.

## 4. Publiczny katalog
Endpointy są publiczne. Nie wymagają `Authorization`. Zwracają tylko rekordy z `is_active = true`. Brak rekordu i rekord nieaktywny dają ten sam HTTP 404 `NOT_FOUND`. Niepoprawne UUID, `page`, `limit` albo `product_type` dają HTTP 400 `VALIDATION_ERROR`.

- `GET /api/v1/categories` — lista aktywnych kategorii. Query: `page`, `limit`. Sortowanie: `sort_order`, `name`, `id`.
- `GET /api/v1/categories/:id` — aktywna kategoria po UUID.
- `GET /api/v1/products` — lista aktywnych produktów. Query: `page`, `limit`, opcjonalnie `category_id` (UUID) i `product_type` (`physical`, `digital`, `service`). Sortowanie: `name`, `id`.
- `GET /api/v1/products/:id` — aktywny produkt po UUID.

Pola kategorii: `id`, `name`, `slug`, `description`, `sort_order`.

Pola produktu: `id`, `category_id`, `name`, `slug`, `description`, `product_type`, `sku`, `price_amount`, `currency`, `tax_status`, `vat_rate`, `stock_quantity`.

W szczegółach produktu `category_id` jest `null`, gdy powiązana kategoria nie jest aktywna. Lista produktów zostawia zapisany `category_id`. Relacja w bazie nie jest zmieniana.

Lista:

```json
{
  "data": [
    {
      "id": "33333333-3333-4333-8333-333333333333",
      "name": "Prints",
      "slug": "prints",
      "description": "Paper",
      "sort_order": 1
    }
  ],
  "meta": { "page": 1, "limit": 20, "total": 1, "totalPages": 1 }
}
```

Szczegóły:

```json
{
  "data": {
    "id": "44444444-4444-4444-8444-444444444444",
    "category_id": null,
    "name": "Session",
    "slug": "session",
    "description": "Portrait",
    "product_type": "service",
    "sku": null,
    "price_amount": 12900,
    "currency": "PLN",
    "tax_status": "standard",
    "vat_rate": 23,
    "stock_quantity": null
  },
  "meta": {}
}
```

`GET /api/v1/products/:slug` nie jest zaimplementowany.

## 5. Konto i klient
Planowane. Supabase Auth ma obsługiwać rejestrację, logowanie, OAuth i odzyskiwanie hasła. Express ma udostępniać:
- `GET /me` — bieżąca tożsamość i podstawowy profil.
- `GET /customers/me` — dane klienta.
- `PUT /customers/me` — aktualizacja danych klienta.
- `GET /customers/me/addresses` — adresy rozliczeniowe.
- `POST /customers/me/addresses` — dodanie adresu rozliczeniowego.
- `PUT /customers/me/addresses/:id` — aktualizacja własnego adresu rozliczeniowego.
- `DELETE /customers/me/addresses/:id` — usunięcie własnego adresu rozliczeniowego.

Adresu dostawy na MVP nie ma. Telefon kontaktowy należy do klienta, nie do profilu konta.

## Sesja gościa
`POST /api/v1/session/guest` jest publiczny. Nie wymaga `Authorization` i nie czyta identyfikatora z body. Tworzy albo odświeża ciasteczko `shop_guest_session`.

Odpowiedź:

```json
{ "data": { "authenticated": false }, "meta": {} }
```

Ciasteczko jest `HttpOnly`, `SameSite=Lax`, `Path=/`, bez `Domain`, z czasem życia 30 dni. W produkcji ma atrybut `Secure`. Wartość to 64 znaki hex z 32 losowych bajtów. Brak ciasteczka, niepoprawny format albo więcej niż jedno wystąpienie `shop_guest_session` powoduje nowe losowanie. Przy duplikatach nie jest wybierana żadna z przesłanych wartości, także gdy są identyczne. Poprawna, pojedyncza wartość zostaje, a czas życia jest ustawiany od nowa.

Surowy identyfikator jest tylko w ciasteczku. SHA-256 tego identyfikatora, zapisany jako 64 znaki hex, będzie jedyną postacią w przyszłym koszyku i w `carts.session_id`. Ten endpoint nie tworzy wiersza koszyka i nie zwraca identyfikatora ani skrótu.

Żądanie z Nuxt do API jest cross-origin. Przeglądarka zapisze i odeśle ciasteczko dopiero wtedy, gdy klient wyśle `credentials: 'include'`, a API doda `Access-Control-Allow-Credentials`. Obecny CORS tego nie włącza.

## 6. Koszyk
Planowane:
- `GET /cart` — pobranie koszyka.
- `POST /cart/items` — dodanie pozycji.
- `PATCH /cart/items/:id` — zmiana ilości.
- `DELETE /cart/items/:id` — usunięcie pozycji.

Koszyk konta jest powiązany z użytkownikiem z tokenu. Koszyk gościa jest powiązany z nieprzewidywalnym ciasteczkiem `httpOnly`; baza przechowuje skrót tego sekretu. Właściciel jest jeden. Jeden właściciel ma jeden koszyk aktywny.

Po zalogowaniu Express łączy koszyk gościa z koszykiem konta: przepisuje sam koszyk gościa albo sumuje ilości i porzuca koszyk gościa. Cena pozycji koszyka nie jest utrwalana jako cena sprzedaży.

Backend sprawdza aktywność produktu, ilość, aktualną kwotę należną i zgodność waluty produktu z walutą koszyka. Nie ufaj cenom, podatkowi ani walucie przesłanym przez frontend.

## 7. Checkout i zamówienia
Planowane:
- `POST /checkout` — walidacja koszyka i danych, utworzenie zamówienia oraz płatności.
- `GET /orders` — zamówienia zalogowanego klienta.
- `GET /orders/:id` — szczegóły własnego zamówienia.
- `POST /orders/:id/cancel` — anulowanie, jeśli reguły biznesowe na to pozwalają.

Checkout jest zablokowany, gdy `seller_tax_status` wynosi `unknown`.

Checkout jest jedną transakcją: ponowna walidacja katalogu, snapshot rozliczeniowy, snapshot katalogowy i zastosowany snapshot podatku, sumy `net_amount`, `tax_amount` i `gross_amount`, płatność oraz oznaczenie koszyka jako przekonwertowanego. Jeśli klient bazy nie obejmuje tych zapisów jedną transakcją, ta sama kolejność idzie do funkcji SQL. Nie twórz zamówienia w stanie częściowym.

`gross_amount` jest kwotą do zapłaty. Dla `standard` przy czynnym podatniku podatek jest różnicą brutto i netto, liczoną osobno na pozycji, połową w górę do grosza, na liczbach całkowitych. Dla `zero_rated`, `exempt`, `not_subject` oraz przy sprzedawcy `exempt` podatek wynosi 0, a netto równa się brutto. Zamówienie nie zapisuje statusu `unknown`.

`GET /orders` obejmuje zamówienia, których `user_id` jest kontem z tokenu. Zamówienie gościa nie dostaje tego powiązania przez sam e-mail.

## 8. Płatności
Planowane. Webhook nie jest zaimplementowany i nie korzysta z `Idempotency-Key`. Idempotencję webhooka zapewnia `payment_events`.
- `POST /payments/:id/retry` — ponowienie płatności, jeśli dozwolone. Nowa próba jest nową płatnością.
- `POST /webhooks/payments/:provider` — webhook operatora, bez zwykłej autoryzacji użytkownika. Express sprawdza podpis, kwotę, walutę, zamówienie i status, a zdarzenie zapisuje idempotentnie.
- `POST /admin/orders/:id/mark-paid` — ręczne potwierdzenie gotówki przez administratora, z audytem.

Operator nie jest wybrany. Kontrakt przewiduje `przelewy24` albo `stripe` oraz gotówkę. `payments.amount` równa się `orders.gross_amount`, a `payments.currency` równa się `orders.currency`. Po utworzeniu tych pól nie zmieniamy.

Nie uznawaj płatności na podstawie query parametru ani powrotu klienta na stronę sukcesu. `cancelled` oznacza płatność niedoszłą. Zwrot po wpłacie to `refunded` albo `partially_refunded`.

## 9. Admin
Planowane. Wszystkie endpointy `/admin/*` mają użyć `requireAuth` i `requireAdmin`. Middleware już sprawdza wiersz `admin` w `user_roles`. Samych tras jeszcze nie ma.
- `GET /admin/dashboard`
- CRUD `/admin/products`
- CRUD `/admin/categories`
- `GET /admin/orders`
- `GET /admin/orders/:id`
- `PATCH /admin/orders/:id/fulfillment-status`
- `GET /admin/customers`
- `GET /admin/payments`

## 10. Paginacja i filtrowanie
Wspólny schemat czyta `page` i `limit` z query string. `page` domyślnie wynosi 1, `limit` domyślnie 20, a najwyższy `limit` to 100. Obie wartości muszą być dodatnimi liczbami całkowitymi. `offset` wynosi `(page - 1) * limit`. Sortowanie, filtry domenowe i paginacja kursorowa nie są jeszcze zaimplementowane.

## 11. Idempotencja
Planowane. Nagłówek `Idempotency-Key` będzie wymagany dla:

- `POST /checkout`
- `POST /payments/:id/retry`
- `POST /orders/:id/cancel`
- `POST /admin/orders/:id/mark-paid`

Klucz jest unikalny dla właściciela i pola `operation`, nie globalnie. Ten sam klucz i ten sam odcisk żądania zwracają zapisany wynik. Inny odcisk jest konfliktem. Gość używa skrótu sesji. Po zalogowaniu klucze gościa nie przechodzą na konto.

Webhooki nie używają tego nagłówka. Zapisują zdarzenie w `payment_events` i nie wykonują drugi raz zmiany, która ma już `processed_at`. Operacje płatnicze sprawdzają zgodność kwoty, waluty, zamówienia i statusu.

## 12. Statusy
Status płatności: `pending`, `paid`, `failed`, `cancelled`, `refunded`, `partially_refunded`.
Status realizacji: `new`, `processing`, `completed`, `cancelled`.

Nie mieszaj statusu płatności ze statusem realizacji zamówienia.

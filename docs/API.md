# Kontrakty REST API — wersja robocza

Zaimplementowane są `GET /api/v1/health`, `GET /api/v1/health/ready`, publiczny odczyt aktywnych kategorii i produktów, `POST /api/v1/session/guest`, koszyk gościa i koszyk konta na ścieżkach `GET /api/v1/cart`, `POST /api/v1/cart/items`, `PATCH /api/v1/cart/items/:id` i `DELETE /api/v1/cart/items/:id` oraz jawne `POST /api/v1/cart/merge`. Pozostałe endpointy w tym dokumencie są planowane. Nie są jeszcze dostępne w Express.

## 1. Konwencje
- Prefix: `/api/v1`
- JSON request/response.
- Operacje konta używają `Authorization: Bearer <Supabase access token>`. Express weryfikuje podpis przez JWKS Supabase Auth. Token nie jest logowany. Koszyk konta już działa w ten sposób. Pozostałe operacje konta są planowane.
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

Surowy identyfikator jest tylko w ciasteczku. SHA-256 tego identyfikatora, zapisany jako 64 znaki hex, jest jedyną postacią w koszyku gościa i w `carts.session_id`. Ten endpoint nie tworzy wiersza koszyka i nie zwraca identyfikatora ani skrótu.

Żądanie z Nuxt do API jest cross-origin. Przeglądarka zapisze i odeśle ciasteczko dopiero wtedy, gdy klient wyśle `credentials: 'include'`, a API doda `Access-Control-Allow-Credentials`. Obecny CORS tego nie włącza.

## 6. Koszyk
Zaimplementowane są koszyk gościa, koszyk konta i `POST /api/v1/cart/merge`. Te cztery ścieżki same koszyków nie scalają.

Te same cztery ścieżki wybierają koszyk po nagłówku `Authorization`. Brak nagłówka oznacza koszyk gościa. Nagłówek, także zapisany inną wielkością liter, oznacza koszyk konta i przechodzi przez `requireAuth`. Pusty, błędny albo wygasły token daje HTTP 401 `UNAUTHORIZED`. Poprawne ciasteczko gościa nie otwiera wtedy koszyka gościa.

Koszyk gościa wymaga jednego poprawnego ciasteczka `shop_guest_session`. Brak ciasteczka, zły format albo więcej niż jedno wystąpienie dają HTTP 401. Te endpointy nie losują nowej sesji. Surowy identyfikator i jego skrót nie wracają w JSON ani w logu.

Koszyk konta bierze właściciela wyłącznie z `req.auth.userId`, czyli ze zweryfikowanego `sub`. `user_id` z body, query albo ciasteczka nie jest używany. Przy poprawnym tokenie ciasteczko nie jest czytane, jego skrót nie trafia do SQL, a wiersz koszyka gościa nie jest zmieniany. Oba koszyki mogą istnieć jednocześnie.

Cena pozycji nie jest zapisywana. Odpowiedź bierze aktualne `products.price_amount` i walutę. Wartość pozycji to cena jednostkowa razy ilość, na liczbach całkowitych. `total_amount` sumuje pozycje w `PLN`. Pola ceny, waluty, `session_id` i `user_id` przesłane przez klienta są ignorowane.

- `GET /api/v1/cart` — koszyk wybranego właściciela. Brak wiersza `carts` daje pustą listę i `total_amount: 0`, bez błędu.
- `POST /api/v1/cart/items` — dodanie produktu. Body: `productId` (UUID) i `quantity` (dodatni integer, najwyżej 2147483647). Produkt nieaktywny albo nieistniejący daje HTTP 404 `NOT_FOUND`. Waluta inna niż `PLN` daje HTTP 400 `VALIDATION_ERROR`. Ten sam produkt w koszyku zwiększa ilość. Przekroczenie zakresu `integer` daje HTTP 400 i nie zapisuje nowej ilości. Przekroczenie kwoty, której nie da się oddać jako bezpieczny integer JavaScriptu, daje HTTP 400 i wycofuje transakcję.
- `PATCH /api/v1/cart/items/:id` — ustawienie ilości własnej pozycji. Body: `quantity`. Cudza albo nieistniejąca pozycja daje HTTP 404.
- `DELETE /api/v1/cart/items/:id` — usunięcie własnej pozycji. Cudza albo nieistniejąca pozycja daje HTTP 404.

Sukces tych czterech endpointów to HTTP 200 i aktualny koszyk:

```json
{
  "data": {
    "currency": "PLN",
    "items": [
      {
        "id": "66666666-6666-4666-8666-666666666666",
        "product_id": "44444444-4444-4444-8444-444444444444",
        "name": "Session",
        "price_amount": 12900,
        "currency": "PLN",
        "quantity": 2,
        "line_amount": 25800
      }
    ],
    "total_amount": 25800
  },
  "meta": {}
}
```

Błąd bazy daje HTTP 503 `SERVICE_UNAVAILABLE` bez treści SQL. Kwota poza kontraktem liczbowym API daje HTTP 400 `VALIDATION_ERROR` ze ścieżką `total_amount`, także na `GET`. To nie jest awaria bazy.

Własność jest w zapytaniu. Koszyk gościa to aktywny wiersz z `user_id` pustym i `session_id` równym skrótowi ciasteczka. Koszyk konta to aktywny wiersz z `user_id` równym `req.auth.userId` i `session_id` pustym. Zmiana koszyka bierze najpierw transakcyjną blokadę `pg_advisory_xact_lock` swojego właściciela. Odczyt tej blokady nie bierze. Utworzenie używa `INSERT ... ON CONFLICT DO NOTHING` na właściwym indeksie częściowym, a potem osobnego `SELECT ... FOR UPDATE` na tym samym połączeniu. Drugie polecenie ma nową migawkę, więc widzi koszyk utworzony przez równoległe żądanie. `updated_at` koszyka nie jest przy tym ruszane. Pozycja używa unikalności `(cart_id, product_id)` i dodaje ilość. Suma kwot jest liczona na `bigint` pod blokadą koszyka, zanim pozycja zostanie zapisana. Równoległe dodania różnych produktów czekają na tę samą blokadę. Jeden właściciel ma jeden aktywny koszyk danego rodzaju.

`POST /api/v1/cart/merge` scala koszyk gościa z koszykiem konta. Ma go wywołać frontend po zalogowaniu. Aplikacja `apps/web` jeszcze tego nie robi. Sam nagłówek `Authorization` na czterech ścieżkach powyżej nie uruchamia scalania. Endpoint zawsze przechodzi przez `requireAuth`. Brak albo błędny token daje HTTP 401. Awaria weryfikacji tokenu daje HTTP 503. Właścicielem jest wyłącznie `req.auth.userId`. Body nie niesie właściciela ani sesji; pola `user_id` i `session_id` są ignorowane.

Koszyk gościa bierze się z jednego poprawnego ciasteczka `shop_guest_session` i z `hashGuestSessionId`. Brak ciasteczka, zły format albo więcej niż jedno wystąpienie oznacza, że nie ma czego scalać: endpoint zwraca aktualny koszyk konta i nie tworzy sesji ani wiersza `carts`. Ciasteczko nie jest przy tym ustawiane ani usuwane.

Gdy ciasteczko jest poprawne, scalanie idzie jedną transakcją. Najpierw blokada gościa `pg_advisory_xact_lock(71001, …)`, potem blokada konta `pg_advisory_xact_lock(71002, …)`, potem `FOR UPDATE` koszyka gościa. Brak aktywnego koszyka gościa albo brak jego pozycji kończy transakcję bez zapisu. Koszyk gościa bez pozycji zostaje `active`.

Są pozycje gościa i nie ma koszyka konta: ten sam wiersz `carts` dostaje `user_id`, `session_id` staje się puste, status zostaje `active`. Identyfikator koszyka i identyfikatory pozycji zostają. Są oba koszyki: ilości tego samego produktu są sumowane w koszyku konta, produkt tylko z koszyka gościa jest dopisywany dotychczasowym `INSERT`, a koszyk gościa dostaje status `abandoned` z niezmienionym `session_id` i pustym `user_id`. Produkty nieaktywne też przechodzą. Cena nadal pochodzi z katalogu.

Suma ilości powyżej `2147483647` daje HTTP 400 ze ścieżką `quantity` i wycofuje całą transakcję. Kwota pozycji albo suma koszyka poza bezpiecznym integerem JavaScriptu daje HTTP 400 ze ścieżką `total_amount` i wycofuje transakcję. Waluta koszyka albo produktu inna niż `PLN` daje HTTP 400 ze ścieżką `currency` i wycofuje transakcję. Sukces to HTTP 200 i aktualny koszyk konta w formacie powyżej. Powtórne wywołanie nie dolicza pozycji drugi raz, bo koszyk gościa nie jest już aktywnym źródłem.

Cena pozycji koszyka nie jest utrwalana jako cena sprzedaży.

Backend sprawdza aktywność produktu, ilość, aktualną kwotę należną i zgodność waluty produktu z walutą koszyka. Nie ufaj cenom, podatkowi ani walucie przesłanym przez frontend.

## 7. Checkout i zamówienia
`POST /api/v1/checkout` dla `paymentMethod = cash` tworzy zamówienie w jednej transakcji, gdy sprzedawca nie jest `unknown` i gdy nie trzeba wybierać strategii VAT dla stawki `standard`. Odpowiedź HTTP 201 zawiera identyfikator, numer, status płatności `pending`, status realizacji `new`, metodę `cash`, walutę i kwoty tekstowe w groszach. Ten sam klucz idempotencji i ten sam hash body zwracają ten zapis także po konwersji koszyka. Inny hash daje HTTP 409 `IDEMPOTENCY_KEY_REUSED`. Sprzedawca `registered` z produktem `standard` daje HTTP 409 `VAT_POLICY_NOT_CONFIRMED`. `stock_quantity` równe `NULL` daje HTTP 409 `STOCK_UNKNOWN`. Za mała dostępność, liczona jako stan minus aktywne rezerwacje, daje HTTP 409 `INSUFFICIENT_STOCK`. Checkout nie zmniejsza `stock_quantity`.

`paymentMethod = online` przy braku konfiguracji sandbox Przelewy24 albo przy środowisku produkcyjnym daje HTTP 503 i nie tworzy zamówienia. E-mail dłuższy niż 50 znaków daje HTTP 400. Przy kompletnej konfiguracji sandbox checkout w jednej transakcji zapisuje zamówienie, płatność `pending` / `not_started`, rezerwację aktywną na 15 minut od commitu i odpowiedź idempotencyjną, a dopiero potem rejestruje transakcję. Produkcyjny checkout online pozostaje wyłączony do czasu workera rezerwacji i webhooka. Rejestracja nie jest ponawiana automatycznie. Ponowienie tego samego klucza zwraca aktualny stan płatności. Po commicie błąd operatora daje HTTP 201 ze stanem inicjalizacji `unknown` i bez adresu przekierowania. Adres sandboxowego panelu transakcji nie jest jeszcze ustalony, więc zapisany token nie jest zwracany jako URL.

Nagłówek `Idempotency-Key` jest wymagany: jeden, od 1 do 255 widocznych znaków ASCII. Udane zamówienie gotówkowe zapisuje go w tej samej transakcji. Błąd walidacji i błąd biznesowy nie zostawiają zakończonej odpowiedzi. Body: `email`, `customerType` (`individual` albo `company`), `paymentMethod` (`online` albo `cash`) oraz `billing` zgodny ze snapshotem rozliczeniowym (`firstName`, `lastName`, `companyName`, `nip`, `phone`, `recipient`, `street`, `buildingNumber`, `apartmentNumber`, `postalCode`, `city`, `countryCode`). Adresu wysyłki nie ma. Osoba fizyczna wymaga imienia i nazwiska. Firma wymaga nazwy i NIP z 10 cyfr. Ulica, numer budynku, kod `NN-NNN`, miasto i dwuliterowy kraj są zawsze wymagane.

Właściciela wybiera nagłówek `Authorization`, tak jak w koszyku. Konto przechodzi przez `requireAuth`. Gość wymaga jednego poprawnego `shop_guest_session`. Checkout nie scala koszyków i nie czyta identyfikatora koszyka z body.

Kolejność w transakcji: blokada doradcza właściciela, idempotencja, koszyk `FOR UPDATE`, `shop_profile` `FOR SHARE`, produkty `FOR UPDATE` po `id`. Status `unknown` daje HTTP 409 `SELLER_TAX_STATUS_UNKNOWN` i wycofuje transakcję. Brak koszyka właściciela daje HTTP 404. Sam koszyk `converted` daje HTTP 409 `CART_CONVERTED`, chyba że ten sam klucz i hash odtwarzają wcześniejszą odpowiedź. Pusty koszyk `active` daje HTTP 409 `CART_EMPTY`. Nieaktywny albo brakujący produkt daje HTTP 409 `PRODUCT_UNAVAILABLE`.

Planowane później:
- `GET /orders` — zamówienia zalogowanego klienta.
- `GET /orders/:id` — szczegóły własnego zamówienia.
- `POST /orders/:id/cancel` — anulowanie, jeśli reguły biznesowe na to pozwalają.

Checkout jest zablokowany, gdy `seller_tax_status` wynosi `unknown`.

Zapis gotówkowy jest jedną transakcją: ponowna walidacja katalogu, snapshot rozliczeniowy, snapshot katalogowy i zastosowany snapshot podatku, sumy `net_amount`, `tax_amount` i `gross_amount`, płatność `pending`, rezerwacja oraz oznaczenie koszyka jako przekonwertowanego. Nie twórz zamówienia w stanie częściowym.

`gross_amount` jest kwotą do zapłaty. Dla `standard` przy czynnym podatniku tymczasowa polityka techniczna jest w `docs/DATABASE.md`: metoda „w stu”, bez zaokrąglania wyników pośrednich. Agregacja pozycji albo stawek przed half-up ma status `OPEN — ACCOUNTANT CONFIRMATION REQUIRED`. Dla `zero_rated`, `exempt`, `not_subject` oraz przy sprzedawcy `exempt` podatek wynosi 0, a netto równa się brutto. Zamówienie nie zapisuje statusu `unknown`.

`GET /orders` obejmuje zamówienia, których `user_id` jest kontem z tokenu. Zamówienie gościa nie dostaje tego powiązania przez sam e-mail.

## 8. Płatności
Planowane. Webhook nie jest zaimplementowany i nie korzysta z `Idempotency-Key`. Idempotencję webhooka zapewnia `payment_events`.
- `POST /payments/:id/retry` — ponowienie płatności, jeśli dozwolone. Nowa próba jest nową płatnością.
- `POST /webhooks/payments/:provider` — webhook operatora, bez zwykłej autoryzacji użytkownika. Express sprawdza podpis, kwotę, walutę, zamówienie i status, a zdarzenie zapisuje idempotentnie.
- `POST /admin/orders/:id/mark-paid` — ręczne potwierdzenie gotówki przez administratora, z audytem.

Operatorem online w MVP jest Przelewy24. Kontrakt nadal przewiduje gotówkę, a schemat zachowuje `stripe` na później. Integracji operatora jeszcze nie ma. `payments.amount` równa się `orders.gross_amount`, a `payments.currency` równa się `orders.currency`. Po utworzeniu tych pól nie zmieniamy.

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
`POST /api/v1/checkout` wymaga nagłówka `Idempotency-Key`. Udany zapis gotówkowy odkłada odpowiedź w `idempotency_keys`. Zapis wiersza będzie też wymagany dla:

- `POST /api/v1/checkout`
- `POST /payments/:id/retry`
- `POST /orders/:id/cancel`
- `POST /admin/orders/:id/mark-paid`

Klucz jest unikalny dla właściciela i pola `operation`, nie globalnie. Ten sam klucz i ten sam odcisk żądania zwracają zapisany wynik. Inny odcisk jest konfliktem. Gość używa skrótu sesji. Po zalogowaniu klucze gościa nie przechodzą na konto.

Webhooki nie używają tego nagłówka. Zapisują zdarzenie w `payment_events` i nie wykonują drugi raz zmiany, która ma już `processed_at`. Operacje płatnicze sprawdzają zgodność kwoty, waluty, zamówienia i statusu.

## 12. Statusy
Status płatności: `pending`, `paid`, `failed`, `cancelled`, `refunded`, `partially_refunded`.
Status realizacji: `new`, `processing`, `completed`, `cancelled`.

Nie mieszaj statusu płatności ze statusem realizacji zamówienia.

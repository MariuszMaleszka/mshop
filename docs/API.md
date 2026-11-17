# Kontrakty REST API — wersja robocza

Zaimplementowany jest tylko `GET /health`. Pozostałe endpointy w tym dokumencie są planowane. Nie są jeszcze dostępne w Express.

## 1. Konwencje
- Prefix: `/api/v1`
- JSON request/response.
- Chronione endpointy: `Authorization: Bearer <Supabase access token>`.
- Daty w ISO 8601 UTC.
- Kwoty jako integer w najmniejszej jednostce waluty. Dla PLN `12900` = 129,00 PLN.
- Waluta jako kod ISO 4217. Na MVP Express przyjmuje wyłącznie `PLN`.
- Cena w żądaniu klienta nie jest źródłem prawdy. Checkout bierze kwotę należną, walutę i podatek z katalogu.
- Błędy mają wspólny format.
- Nie zwracaj stack trace ani danych dostawców płatności.

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
    "message": "Request validation failed",
    "details": []
  }
}
```

## 3. Health
- `GET /health` — sprawdzenie, że proces API działa. Nie wymaga autoryzacji.

```json
{
  "data": { "status": "ok" },
  "meta": {}
}
```

## 4. Publiczny katalog
Planowane:
- `GET /products` — lista aktywnych produktów; filtry i paginacja.
- `GET /products/:slug` — szczegóły aktywnego produktu.
- `GET /categories` — lista aktywnych kategorii.

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
Planowane. Wszystkie endpointy `/admin/*` mają wymagać roli `admin` sprawdzanej po stronie Express.
- `GET /admin/dashboard`
- CRUD `/admin/products`
- CRUD `/admin/categories`
- `GET /admin/orders`
- `GET /admin/orders/:id`
- `PATCH /admin/orders/:id/fulfillment-status`
- `GET /admin/customers`
- `GET /admin/payments`

## 10. Paginacja i filtrowanie
Preferuj `page` i `limit` albo stabilny cursor. Ustal maksymalny limit po stronie backendu. Waliduj sortowanie i nazwy filtrów przez allowlistę.

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

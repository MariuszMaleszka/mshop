# Kontrakty REST API — wersja robocza

## 1. Konwencje
- Prefix: `/api/v1`
- JSON request/response.
- Chronione endpointy: `Authorization: Bearer <Supabase access token>`.
- Daty w ISO 8601 UTC.
- Kwoty jako integer w groszach, np. `12900` = 129,00 PLN.
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

## 3. Publiczny katalog
- `GET /products` — lista aktywnych produktów; filtry i paginacja.
- `GET /products/:slug` — szczegóły aktywnego produktu.
- `GET /categories` — lista aktywnych kategorii.

## 4. Konto i klient
Supabase Auth obsługuje rejestrację, logowanie, OAuth i odzyskiwanie hasła. Express udostępnia:
- `GET /me` — bieżąca tożsamość i podstawowy profil.
- `GET /customers/me` — dane klienta.
- `PUT /customers/me` — aktualizacja danych klienta.
- `GET /customers/me/addresses` — adresy.
- `POST /customers/me/addresses` — dodanie adresu.
- `PUT /customers/me/addresses/:id` — aktualizacja własnego adresu.
- `DELETE /customers/me/addresses/:id` — usunięcie własnego adresu.

## 5. Koszyk
- `GET /cart` — pobranie koszyka.
- `POST /cart/items` — dodanie pozycji.
- `PATCH /cart/items/:id` — zmiana ilości.
- `DELETE /cart/items/:id` — usunięcie pozycji.

Backend sprawdza aktywność produktu, ilość i aktualną cenę. Nie ufaj cenom przesłanym przez frontend.

## 6. Checkout i zamówienia
- `POST /checkout` — walidacja koszyka i danych, utworzenie zamówienia oraz płatności.
- `GET /orders` — zamówienia zalogowanego klienta.
- `GET /orders/:id` — szczegóły własnego zamówienia.
- `POST /orders/:id/cancel` — anulowanie, jeśli reguły biznesowe na to pozwalają.

Checkout powinien być transakcyjny. Jeśli użyty sposób dostępu do PostgreSQL nie zapewnia transakcji obejmującej wszystkie operacje, rozważ funkcję SQL/RPC lub odpowiednią warstwę transakcyjną. Nie twórz zamówienia w stanie częściowym.

## 7. Płatności
- `POST /payments/:id/retry` — ponowienie płatności, jeśli dozwolone.
- `POST /webhooks/payments/:provider` — webhook operatora, bez zwykłej autoryzacji użytkownika, ale z weryfikacją podpisu/uwierzytelnienia i idempotencją.
- `POST /admin/orders/:id/mark-paid` — ręczne potwierdzenie gotówki przez administratora, z audytem.

Nie uznawaj płatności na podstawie query parametru ani powrotu klienta na stronę sukcesu.

## 8. Admin
Wszystkie endpointy `/admin/*` wymagają roli `admin` sprawdzanej po stronie Express.
- `GET /admin/dashboard`
- CRUD `/admin/products`
- CRUD `/admin/categories`
- `GET /admin/orders`
- `GET /admin/orders/:id`
- `PATCH /admin/orders/:id/fulfillment-status`
- `GET /admin/customers`
- `GET /admin/payments`

## 9. Paginacja i filtrowanie
Preferuj `page` i `limit` albo stabilny cursor. Ustal maksymalny limit po stronie backendu. Waliduj sortowanie i nazwy filtrów przez allowlistę.

## 10. Idempotencja
- Checkout powinien przyjmować `Idempotency-Key`, aby uniknąć podwójnego utworzenia zamówienia po ponowieniu requestu.
- Webhooki powinny rejestrować unikalny identyfikator zdarzenia i nie wykonywać drugi raz tej samej zmiany.
- Operacje płatnicze muszą sprawdzać zgodność kwoty, waluty, zamówienia i statusu.

## 11. Statusy
Status płatności: `pending`, `paid`, `failed`, `cancelled`, `refunded`, `partially_refunded`.
Status realizacji: `new`, `processing`, `completed`, `cancelled`.

Nie mieszaj statusu płatności ze statusem realizacji zamówienia.

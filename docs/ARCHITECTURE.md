# Architektura

## 1. Cel i zakres
Aplikacja e-commerce dla pojedynczego sklepu, początkowo dla fotografa sprzedającego sesje, usługi, pliki cyfrowe i ewentualnie wydruki.

MVP nie jest marketplace'em ani systemem SaaS multi-tenant.

## 2. Komponenty

### `apps/web` — Nuxt 4
- publiczny storefront;
- koszyk i checkout;
- konto klienta;
- panel administracyjny pod `/admin`;
- wyświetlanie danych pobieranych z API;
- zarządzanie sesją Supabase Auth.

### `apps/api` — Express
- REST API;
- weryfikacja tokenów Supabase;
- autoryzacja ról;
- logika katalogu, koszyka, zamówień i płatności;
- komunikacja z Supabase/PostgreSQL;
- integracje z operatorem płatności i dostawcą e-mail.

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

Nie używaj bezpośredniego zapisu z przeglądarki do tabel `orders`, `order_items`, `payments`, `payment_events` ani do operacji administracyjnych.

## 4. Proponowana struktura monorepo

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

- `auth`: weryfikacja tożsamości i kontekst użytkownika; bez implementowania własnego systemu haseł.
- `customers`: profile, typ klienta, adresy.
- `catalog`: produkty, usługi, kategorie, media.
- `cart`: koszyk i pozycje koszyka.
- `checkout`: walidacja danych i utworzenie zamówienia.
- `orders`: odczyt, statusy i historia zamówień.
- `payments`: inicjowanie płatności, webhooki, zwroty i rejestrowanie zdarzeń.
- `admin`: operacje administracyjne i dashboard.
- `notifications`: e-maile transakcyjne.
- `settings`: konfiguracja sklepu.

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
Przed implementacją produkcyjną należy zatwierdzić:
- operatora płatności i jego środowisko testowe;
- czy zakup gościnny jest dozwolony;
- sposób realizacji usług i produktów cyfrowych;
- reguły VAT i dokumentów sprzedaży;
- retencję danych i politykę prywatności;
- hosting API, frontendu i Supabase.

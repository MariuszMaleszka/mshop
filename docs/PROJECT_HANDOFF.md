# PROJECT HANDOFF – mshop

**Stan na:** 24 listopada 2026  
**Cel pliku:** bezpieczne wznowienie pracy po przerwie bez czytania historii rozmów.

> W razie rozbieżności najpierw sprawdź kod i właściwy dokument (`AUTH-SESSION.md`, `API.md`, `DATABASE.md`, `ROADMAP.md`). Ten plik nie jest nowszy niż repozytorium.

## A. Stan projektu

### Opis

Monorepo jednego sklepu internetowego (`mshop`): katalog, koszyk gościa i konta, scalanie koszyków w API, checkout gotówkowy i sandboxowy checkout online (Przelewy24), odczyt zamówień klienta i administratora, sesja konta z logowaniem i odświeżeniem access tokenu.

### Stos

| Warstwa | Technologia |
| --- | --- |
| Frontend | Nuxt 4.6.x, Vue 3, JavaScript (bez TypeScript) |
| Backend | Node.js + Express 5, ES modules |
| Baza / Auth | Supabase PostgreSQL + Supabase Auth (JWKS) |
| Walidacja | Zod |
| Monorepo | pnpm workspaces (`apps/web`, `apps/api`, `packages/shared`) |
| Testy | `node:test` w `pnpm test`; Vitest + `@nuxt/test-utils` w `test:nuxt` (poza CI) |
| CI | GitHub Actions: lint, format:check, test, build |

Wymagane: Node.js `>=22.22.3`, pnpm `10.34.9`.

### Architektura

- `apps/web` — UI i BFF Nuxt (CSRF, login, inspect sesji, admin orders).
- `apps/api` — logika biznesowa, PostgreSQL (`pg`), JWT, role, płatności.
- `packages/shared` — schematy Zod i stałe, bez logiki biznesowej.
- `supabase/` — migracje SQL, seed, `config.toml`.

Express jest właścicielem logiki. Frontend nie zapisuje zamówień, płatności ani ról. Przeglądarka nie trzyma access/refresh tokenów.

### Ukończone obszary

- Fundament monorepo, CI, health API.
- Katalog publiczny, koszyk gościa i konta, `POST /api/v1/cart/merge` w API.
- Checkout gotówkowy; sandboxowy checkout online P24; webhook `transaction/verify`; worker wygaszania rezerwacji online (15 min).
- Odczyt zamówienia klienta; lista i szczegóły admin w Express + BFF Nuxt.
- Sesja konta: CSRF, login, strona `/login`, inspect z przedłużeniem idle, **odświeżenie access tokenu** (Stage 3F.1 i 3F.2).
- Testy Nuxt stron `/admin/orders`, `/admin/orders/:id`, `/login`.

### Częściowe / niezrealizowane

- **Logout** — niezaimplementowany.
- **Middleware** ochrony stron Nuxt — brak.
- **Frontendowe RBAC** — brak (rola tylko w Express `requireAdmin`).
- **`cart/merge` z Nuxt** — API jest; front nie woła.
- Produkcyjny checkout online — wyłączony.
- Zwrot płatności, dokumenty sprzedaży, powiadomienia, dostawa, faktury, fiskalizacja — poza MVP albo decyzja.
- Blokady checkoutu: `SELLER_TAX_STATUS_UNKNOWN`, `VAT_POLICY_NOT_CONFIRMED`; `stock_quantity = NULL` → `STOCK_UNKNOWN`.

## B. Aktualny stan uwierzytelniania

Szczegóły: `docs/AUTH-SESSION.md`. Trasy: `docs/API.md`.

### Login

1. Strona `/login` → `POST /api/v1/auth/csrf` (bootstrap challenge cookie + sekret CSRF w pamięci modułu `csrf-memory.js`).
2. `POST /api/v1/auth/login` na hoście Nuxt z hasłem i `X-CSRF-Token`.
3. Nuxt → Express `POST /api/v1/internal/login` (sekret BFF, peer, IP klienta).
4. Po sukcesie: HttpOnly cookie sesji (`mshop_session` / `__Host-mshop_session`), tokeny tylko w PostgreSQL (AES-256-GCM).
5. Brak access/refresh w `localStorage` / `sessionStorage` / HTML.
6. Błędy: 401 hasło, 403 CSRF, 429 rate limit, 503 niedostępność — mapowane w UI bez sekretów.

### CSRF

Osobne wyzwanie przed hasłem (`login_challenges`). Sekret challenge i sesji w pamięci modułu przeglądarki, nie w szablonie Vue.

### Sesje i refresh

- Odczyt: `POST /api/v1/internal/account-sessions/inspect` → `inspectAndExtendAccountSession`.
- Ważny JWT (`readAccessTokenExpiry` / `jose` `decodeJwt` + `exp`) → `extendAccountSessionIdleExpiry` (idle 30 min). Absolute 12 h **nie** jest przedłużane.
- Wygasły `exp` → `refreshAccountSession`: `consumeRefreshRateLimit` → `beginAccountSessionRefresh` (pending + nowy UUID `refresh_generation`, commit przed siecią) → `refreshSupabaseSession` (8 s) → `saveRefreshedSession` (warunkowy `UPDATE`, bez `INSERT`).
- Pending młodszy niż 15 s → równoległe żądania: `session_pending` / 503; po limicie odświeżeń: `rate_limited` / 429.
- Brak retry starego refresh tokenu; spóźnione odpowiedzi nie nadpisują nowszej generacji.
- Access uznawany za ważny wyłącznie na podstawie poprawnego JWT i `exp` (obecna implementacja).

### BFF

Admin orders: Nuxt czyta cookie → inspect → Bearer do Express. Przeglądarka nie wysyła Bearer.

### Brak logout

Trasy wylogowania nie ma. Wyścig logout × refresh **nieprzetestowany**. Helper `supabase-logout.js` nie jest podpięty do trasy produktu.

### Ograniczenia

- Middleware stron i frontendowe RBAC — deferred.
- `cart/merge` z frontu — deferred.
- Produkcyjny proxy / `BFF_TRUSTED_PEERS` musi być jawnie ustawiony; pusta lista blokuje wewnętrzne wywołania.

## C. Ważne decyzje architektoniczne

Zaakceptowane wcześniej — nie tworzyć nowych w tym etapie:

1. **Supabase Auth** jest źródłem tożsamości; hasła nie leżą w naszej bazie.
2. **Tokeny poza przeglądarką** — access/refresh w `account_sessions`, zaszyfrowane; cookie niesie tylko identyfikator.
3. **Sesja konta ≠ sesja gościa** — gość: `shop_guest_session`; konto: `mshop_session` / `__Host-mshop_session`.
4. **Przelewy24** — pierwszy i jedyny operator online w MVP; Stripe nie wchodzi.
5. **`stock_quantity = NULL`** oznacza nieznany stan i blokuje checkout (`STOCK_UNKNOWN`).
6. **Rezerwacje i płatności** — online: rezerwacja 15 min od checkoutu; webhook + `verify` jest źródłem prawdy o płatności; powrót przeglądarki nie potwierdza; gotówkę potwierdza admin (`mark-paid`); anulowanie nieopłaconej gotówki: `cancel`.
7. **Blokady sprzedaży** przy niepotwierdzonym statusie podatkowym (`unknown`) i niepotwierdzonej polityce VAT (`VAT_POLICY_NOT_CONFIRMED`).
8. **Brak samodzielnego nadawania uprawnień administratora** — rola tylko w `user_roles`, sprawdzana przez Express.

Nierozstrzygnięte (nie oznaczać jako rozwiązane): status podatkowy sprzedawcy, klasyfikacja VAT produktów, `per_line` vs `per_rate` jako polityka księgowa, dokumenty sprzedaży, kasa fiskalna, retencja, hosting produkcyjny, rotacja kluczy, ograniczone konto DB.

## D. Konfiguracja i uruchamianie

1. `pnpm install` w katalogu głównym.
2. Lokalny PostgreSQL Supabase: `127.0.0.1:54322`. Migracje: `pnpm exec supabase migration up`. **Nie** używać `db reset` / `db push` bez jawnej zgody.
3. API **nie** ładuje `.env` samo — proces musi dostać zmienne (patrz `.env.example`).
4. `pnpm dev` — Nuxt `:3000`, Express `:3001`.
5. Testy: `pnpm test` (workspace), `pnpm --filter @shop/api test`, `pnpm --filter @shop/web test`, `pnpm --filter @shop/web test:nuxt`.
6. Lint / build: `pnpm lint`, `pnpm format:check`, `pnpm build`.

Wymagane do logowania i refresh (wartości lokalne, nie w repo):

- `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY` (login + refresh Auth)
- `SESSION_TOKEN_KEY`, `RATE_LIMIT_HMAC_KEY` (32 bajty base64)
- `BFF_INTERNAL_SECRET`, `BFF_TRUSTED_PEERS` (lokalnie `127.0.0.1,::1`)
- `NUXT_BFF_INTERNAL_SECRET` (ten sam sekret po stronie Nuxt)
- `WEB_ORIGIN` / origin CSRF

Nie ujawniaj ani nie commituj prawdziwych sekretów.

Ostatnie raportowane liczby testów (Stage 3F.2, bez ponownego uruchomienia w DOCS.2): API **488**, Web Node **93**, Nuxt **21**. Szczegóły: `docs/TESTING.md`.

## E. Bezpieczeństwo i produkcja — blokery

- Jawna konfiguracja proxy i **`BFF_TRUSTED_PEERS`** (pusta = odrzucenie BFF).
- Rotacja i sejf dla `SESSION_TOKEN_KEY`, `RATE_LIMIT_HMAC_KEY`, `BFF_INTERNAL_SECRET`.
- Backup / restore i monitoring — nieopisane w repo.
- Ograniczone uprawnienia użytkownika DB zamiast uprzywilejowanego `pg`.
- Nierozstrzygnięte kwestie podatkowe i dokumenty sprzedaży.
- Produkcyjny checkout online wyłączony; stany P24 nierozstrzygnięte wymagają `docs/P24_RECONCILIATION.md`.
- Brak logout, middleware i E2E.
- CSP nie jest egzekwowane (`nuxt.config.js` bez CSP).

## F. Jak wznowić pracę po przerwie

### Dokumenty (kolejność)

1. Ten plik (`PROJECT_HANDOFF.md`)
2. `docs/AUTH-SESSION.md`
3. `docs/ROADMAP.md` (sekcja „Następny punkt wznowienia”)
4. `docs/API.md`, `docs/TESTING.md`
5. W razie potrzeby: `ARCHITECTURE.md`, `DATABASE.md`, `AGENTS.md`, `README.md`

### Kod do przejrzenia przed zmianami sesji

- `apps/api/src/account-session/` — zwłaszcza `inspect-and-extend-account-session.js`, `refresh-account-session.js`, `repository.js`
- `apps/api/src/auth/supabase-refresh.js`, `supabase-password-auth.js`
- `apps/web/app/pages/login.vue`, `apps/web/app/modules/account-login/`
- `apps/web/server/utils/read-account-session.js`, `admin-orders-bff.js`
- Testy: `apps/api/test/refresh-account-session.test.js`, `inspect-and-extend-account-session*.test.js`

### Pierwszy następny etap

1. Audyt aktualnego mechanizmu sesji po przerwie (kod + `AUTH-SESSION.md`).
2. Zaprojektowanie i implementacja **logout**.
3. Test wyścigu **logout × refresh**.
4. Aktualizacja dokumentacji i testów.
5. Dopiero potem decyzja o middleware i integracji `cart/merge` z Nuxt.

### Czego nie zmieniać bez ponownego audytu / zgody

- `requireAuth` / `requireAdmin` i model Bearer.
- Model pending / `refresh_generation` / absolute 12 h.
- Blokady `SELLER_TAX_STATUS_UNKNOWN`, `VAT_POLICY_NOT_CONFIRMED`, `STOCK_UNKNOWN`.
- Produkcyjny P24, `shop_profile.seller_tax_status`, migracje bez zakresu.
- Nie obchodzić rate limitów ani BFF peer/secret.

### Decyzje wymagające użytkownika

- Start logout (zakres tras, unieważnienie Supabase, cookie).
- Czy i kiedy middleware stron oraz `cart/merge` z frontu.
- Hosting, proxy, `BFF_TRUSTED_PEERS`, produkcyjne sekrety.
- Potwierdzenie księgowe VAT i dokumentów sprzedaży.
- Włączenie produkcyjnego checkoutu online (osobna zgoda).

## Zasady współpracy (skrót)

- Komunikacja po polsku; małe etapy po akceptacji.
- JavaScript only; bez nowych zależności bez uzasadnienia.
- Commit tylko na wyraźną prośbę.
- Nie rozszerzać zakresu bez zgody.
- Pełne zasady: `AGENTS.md`.

## Migracje Phase 2 (kolejność)

1. `20261117140000_identity_and_shop_profile.sql`
2. `20261117150000_catalog_categories_and_products.sql`
3. `20261117160000_carts_and_cart_items.sql`
4. `20261117170000_orders_and_status_history.sql`
5. `20261117180000_payments_and_payment_events.sql`
6. `20261117190000_idempotency_keys.sql`
7. `20261118100000_shop_profile_seller_identity.sql`
8. `20261118100100_order_seller_snapshot.sql`
9. `20261118100200_standard_vat_rates.sql`
10. `20261118100300_inventory_reservations.sql`
11. `20261119120000_payment_initialization.sql`
12. `20261120120000_order_guest_session.sql`
13. `20261120140000_account_sessions.sql`
14. `20261120160000_revoke_session_table_api_grants.sql`

Szczegóły: `docs/DATABASE.md`. Nie dodawaj migracji bez zakresu i akceptacji.

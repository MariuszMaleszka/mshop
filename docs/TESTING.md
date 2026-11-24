# Testy

**Stan na:** 24 listopada 2026.

Ten plik opisuje to, co da się uruchomić z repozytorium. Nie nadaje statusu „przetestowane produkcyjnie”.

## Runnery

| Zestaw | Polecenie | Runner | CI |
| --- | --- | --- | --- |
| Cały workspace | `pnpm test` | `pnpm -r test` | tak |
| API | `pnpm --filter @shop/api test` | `node --test` | tak, przez `pnpm test` |
| Web, logika bez Vue | `pnpm --filter @shop/web test` | `node --test test/*.test.js` | tak, przez `pnpm test` |
| Web, strony Nuxt | `pnpm --filter @shop/web test:nuxt` | Vitest 5 i `@nuxt/test-utils` 4, środowisko `nuxt`, DOM `happy-dom` | nie |
| Lint i format | `pnpm lint`, `pnpm format:check` | ESLint, Prettier | tak |
| Build | `pnpm build` | Nuxt oraz `node --check` w API | tak |

`node --test` bez wzorca w `apps/web` wciąga także `test/nuxt/` i przerywa pracę na imporcie `.vue`. Dlatego skrypt `test` ogranicza się do `test/*.test.js`. Vitest obejmuje tylko `apps/web/test/nuxt/**/*.test.js`.

Playwright, jsdom i testy przeglądarkowe nie są zależnościami. Nie ma testów E2E.

## Ostatnie raportowane liczby

Z raportu Stage 3F.2 (24 listopada 2026), bez ponownego uruchomienia w etapie DOCS.2:

| Zestaw | Wynik |
| --- | --- |
| API (`@shop/api`) | 488 pass |
| Web Node (`@shop/web` `pnpm test`) | 93 pass |
| Nuxt (`pnpm --filter @shop/web test:nuxt`) | 21 pass |

Traktuj te liczby jako ostatni raportowany wynik, nie jako świeżo zweryfikowany pomiar z tego etapu dokumentacji.

## Co jest pokryte

`node:test` woła funkcje i trasy z podstawionymi zależnościami. Część plików `*.integration.test.js` w `apps/api` łączy się z PostgreSQL na `127.0.0.1:54322` i używa blokady doradczej. Gdy baza nie działa, wynik zależy od danego pliku. Nie uruchamiaj `supabase db reset` ani `db push`, żeby te testy przeszły.

Pokryte obszary, bez listy każdego pliku:

- katalog, koszyk gościa i konta, scalanie, checkout, kwoty, rezerwacje i ich wygaszanie;
- webhook Przelewy24 i rekonsyliacja stanów nierozstrzygniętych w testach jednostkowych;
- JWT, `requireAuth`, `requireAdmin`;
- sesja gościa, CSRF, logowanie wewnętrzne i klienta BFF, strona `/login` w Vitest;
- odczyt sesji, przedłużenie bezczynności oraz odświeżenie access tokenu (`refreshAccountSession`, `refreshSupabaseSession`, `saveRefreshedSession`);
- równoległy refresh z barierą asynchroniczną, spóźniona odpowiedź po 15 s, niezgodna `refresh_generation`, brak INSERT, brak przedłużenia idle/absolute po nieudanym refresh, brak sekretów w odpowiedziach;
- odczyt administracyjny Expressa oraz BFF Nuxt, w tym izolacja dwóch równoległych sesji i mapowanie 429 `rate_limited`;
- mapowanie statusów widoku zamówień oraz zachowanie stron `/admin/orders` i `/admin/orders/:id` w Vitest.

Test integracyjny logowania bywa wrażliwy na zderzenie losowego adresu w oknie 15 minut. Jedno powtórzenie nie jest dowodem błędu produktu. Nie zmieniaj tego testu przy okazji innego zadania.

## Vitest

Testy Nuxt są w `apps/web/test/nuxt/`:

- `admin-orders-page.test.js` — prawdziwa `orders.vue`: ładowanie, sukces, 401/403/503, jedno żądanie po montowaniu, brak Bearer i sekretów;
- `admin-order-detail-page.test.js` — prawdziwa `orders/[id].vue`: ładowanie, sukces, 401/403/404/503, zły UUID bez wywołania BFF;
- `login-page.test.js` — prawdziwa `login.vue`: CSRF po mount, sukces i redirect, 401/403/429/503, awaria CSRF, blokada podwójnego submit, brak Bearer i sekretów w DOM/stanie komponentu.

`fetch` jest zastępowany lokalnie. Express nie jest potrzebny.

Te testy nie sprawdzają:

- HTML z SSR dokumentu `/admin/orders` ani jego `Cache-Control`;
- E2E w prawdziwej przeglądarce;
- wyścigu logout × refresh (logout nie istnieje).

## Luki przed uznaniem ścieżki za zamkniętą

- E2E: gość, checkout gotówkowy, logowanie, odczyt panelu, odmowa klienta bez roli `admin`.
- Wylogowanie oraz test wyścigu logout × refresh z `docs/AUTH-SESSION.md`.
- Middleware ochrony stron i frontendowe RBAC.
- Wywołanie `POST /api/v1/cart/merge` z Nuxt po zalogowaniu.
- Testy produkcyjnego Przelewy24. Sandbox nie jest dowodem produkcji. Produkcyjny checkout online pozostaje wyłączony.

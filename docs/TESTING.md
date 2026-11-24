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

## Co jest pokryte

`node:test` woła funkcje i trasy z podstawionymi zależnościami. Część plików `*.integration.test.js` w `apps/api` łączy się z PostgreSQL na `127.0.0.1:54322` i używa blokady doradczej. Gdy baza nie działa, wynik zależy od danego pliku. Nie uruchamiaj `supabase db reset` ani `db push`, żeby te testy przeszły.

Pokryte obszary, bez listy każdego pliku:

- katalog, koszyk gościa i konta, scalanie, checkout, kwoty, rezerwacje i ich wygaszanie;
- webhook Przelewy24 i rekonsyliacja stanów nierozstrzygniętych w testach jednostkowych;
- JWT, `requireAuth`, `requireAdmin`;
- sesja gościa, CSRF, logowanie wewnętrzne, odczyt sesji, przedłużenie bezczynności;
- odczyt administracyjny Expressa oraz BFF Nuxt, w tym izolacja dwóch równoległych sesji na poziomie loadera;
- mapowanie statusów widoku zamówień bez renderowania Vue.

Test integracyjny logowania bywa wrażliwy na zderzenie losowego adresu w oknie 15 minut. Jedno powtórzenie nie jest dowodem błędu produktu. Nie zmieniaj tego testu przy okazji innego zadania.

## Vitest

Jest jeden test: `apps/web/test/nuxt/admin-orders-page.test.js`. Montuje prawdziwy `orders.vue` przez `mountSuspended` i sprawdza, że setup przechodzi oraz że widać nagłówek „Zamówienia”. `fetch` jest zastąpiony lokalną odpowiedzią, więc Express nie jest potrzebny.

Ten test nie sprawdza:

- HTML z SSR i braku danych zamówienia w pierwszym dokumencie;
- braku żądania przed `onMounted` i dokładnie jednego żądania po montowaniu;
- niepoprawnego UUID na stronie szczegółów;
- komunikatów 401, 403, 404 i 503;
- przejścia z listy do szczegółów;
- `Cache-Control` dokumentu HTML. BFF ustawia `no-store` na JSON. Nagłówek dokumentu nie jest w kodzie ustawiony i nie został zmierzony.

## Luki przed uznaniem ścieżki za zamkniętą

- E2E: gość, checkout gotówkowy, logowanie, odczyt panelu, odmowa klienta bez roli `admin`.
- Odświeżenie i wylogowanie, gdy powstaną: test wyścigu opisany w `docs/AUTH-SESSION.md` nadal nie istnieje.
- Render strony szczegółów i nawigacja listy.
- Testy produkcyjnego Przelewy24. Sandbox nie jest dowodem produkcji. Produkcyjny checkout online pozostaje wyłączony.

# Shop Cursor Starter

Dokumentacja startowa dla modułowego sklepu internetowego:
- Frontend: Nuxt 4 + JavaScript
- Backend: Node.js + Express 5 + JavaScript
- Database/Auth/Storage: Supabase (PostgreSQL)
- Monorepo: pnpm workspaces

## Założenia MVP

1. Jeden sklep i jeden właściciel sklepu (nie marketplace).
2. Klient może kupić jako gość lub po zalogowaniu. Konto jest wymagane do historii zakupów, ale nie jest warunkiem zakupu.
3. Katalog obsługuje produkty fizyczne, cyfrowe i usługi.
4. Płatności: operator online (początkowo jeden) oraz gotówka jako metoda rozliczenia ręcznego.
5. W MVP nie ma rezerwacji terminów, dostaw, fakturowania ani wielosklepowości.
6. Ceny są kwotą należną, jako liczby całkowite w najmniejszej jednostce waluty (dla PLN: grosze), nigdy jako float. Schemat trzyma kod ISO 4217; na MVP Express przyjmuje tylko PLN. Model VAT jest w `docs/DATABASE.md`.
7. Backend Express jest właścicielem logiki biznesowej. Frontend nie zapisuje bezpośrednio zamówień, płatności ani ról do bazy.

## Uruchomienie lokalne

Wymagane narzędzia (zgodnie z repozytorium):

- Node.js: minimum `engines` w root `package.json` (`>=22.22.3`); CI i pin lokalny: `.nvmrc` (`22.23.5`)
- pnpm: dokładnie `packageManager` w root `package.json` (`pnpm@10.34.9`)

Nie wklejaj prawdziwych sekretów do dokumentacji i nie commituj pliku `.env`.

1. Zainstaluj zależności w katalogu głównym: `pnpm install`.
2. Uruchom lokalny Supabase (Docker): `pnpm exec supabase start`. Porty z `supabase/config.toml`: API Auth `127.0.0.1:54321`, PostgreSQL `127.0.0.1:54322`. Klucz anon i inne wartości lokalne: `pnpm exec supabase status -o env` (albo bez `-o env`).
3. Zastosuj migracje: `pnpm exec supabase migration up`. Nie używaj `db reset` ani `db push` bez jawnej zgody.
4. Przygotuj zmienne z `.env.example` (skopiuj do lokalnego `.env` tylko jako prywatną listę — plik jest w `.gitignore`). Uzupełnij co najmniej to, czego wymaga start API i logowanie: `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SESSION_TOKEN_KEY`, `RATE_LIMIT_HMAC_KEY`, `BFF_INTERNAL_SECRET`, `NUXT_BFF_INTERNAL_SECRET` (ta sama wartość co `BFF_INTERNAL_SECRET`) oraz lokalnie `BFF_TRUSTED_PEERS=127.0.0.1,::1`. Generowanie kluczy 32 B base64 jest opisane w `.env.example`.
5. Express **nie** ładuje pliku `.env`. Przed `pnpm dev` ustaw wymagane zmienne w środowisku procesu powłoki (PowerShell: `$env:NAME='...'`; bash: `export NAME=...`) albo w konfiguracji IDE, która startuje to samo `pnpm dev`. Oba procesy z `pnpm --parallel --filter './apps/*' dev` dziedziczą env rodzica. Projekt nie ma skryptu ani zależności do automatycznego wczytania `.env` do API.
6. Uruchom aplikację: `pnpm dev` — Nuxt `:3000`, Express `:3001` (`PORT` domyślnie 3001).
7. Sprawdzenie środowiska: `GET http://127.0.0.1:3001/api/v1/health` oraz `GET http://127.0.0.1:3001/api/v1/health/ready`; sklep na `http://127.0.0.1:3000`. Logowanie: strona `/login` (wymaga kompletnych zmiennych z punktu 4). Wylogowania i middleware ochrony stron jeszcze nie ma.

Dodatkowe sprawdzenia jakości: `pnpm test`, `pnpm lint`, `pnpm build`. Test stron Nuxt: `pnpm --filter @shop/web test:nuxt` (poza CI).

Produkcyjny hosting, proxy, backup i monitoring nie są opisane w repozytorium i blokują wdrożenie. Szczegóły sesji: `docs/AUTH-SESSION.md`. Wznowienie po przerwie: `docs/PROJECT_HANDOFF.md`.

## Jak używać dokumentacji

1. Przeczytaj `AGENTS.md`.
2. Przeczytaj `docs/ARCHITECTURE.md` i `docs/DEVELOPMENT-RULES.md`.
3. Przed zmianą bazy przeczytaj `docs/DATABASE.md`.
4. Przed zmianą API przeczytaj `docs/API.md`.
5. Wybierz jedno zadanie z `docs/ROADMAP.md`. Testy opisuje `docs/TESTING.md`.
6. Użyj `docs/TASK-TEMPLATE.md`, aby zlecić je agentowi.
7. Po zakończeniu zaktualizuj status zadania w roadmapie i dokumentację, jeśli zmieniły się kontrakty.

## Ważne decyzje bezpieczeństwa

- Supabase Auth obsługuje hasła i OAuth (Google, Apple). Nie przechowujemy haseł w swojej bazie.
- Express weryfikuje access token Supabase dla chronionych endpointów.
- Klucz `service_role` jest wyłącznie po stronie serwera i nie może trafić do Nuxt/client bundle.
- Webhook płatniczy jest źródłem potwierdzenia płatności, a nie powrót przeglądarki na stronę sukcesu.
- Każdy endpoint admina wykonuje autoryzację po stronie backendu.
- RLS jest włączone dla tabel dostępnych z klienta. Dostęp serwerowy z service role omija RLS, dlatego backend musi sam egzekwować autoryzację i zakres danych.

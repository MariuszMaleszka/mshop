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

Wymagane: Node.js `>=22.22.3` i pnpm `10.34.9`. Zmienne są w `.env.example`. Nie wklejaj tu prawdziwych sekretów i nie commituj pliku `.env`.

1. `pnpm install` w katalogu głównym.
2. Lokalny PostgreSQL Supabase nasłuchuje na `127.0.0.1:54322`. Nowe migracje: `pnpm exec supabase migration up`. Nie używaj `db reset` ani `db push`.
3. API nie czyta `.env` samo. Proces Express musi dostać zmienne, w tym `DATABASE_URL` i `SUPABASE_URL`.
4. `pnpm dev` uruchamia równolegle Nuxt na porcie 3000 i Express na porcie 3001.
5. Sprawdzenie: `pnpm test`, `pnpm lint`, `pnpm build`. Test stron Nuxt jest osobno: `pnpm --filter @shop/web test:nuxt`. CI go nie uruchamia.

Logowanie hasłem wymaga `SESSION_TOKEN_KEY`, `RATE_LIMIT_HMAC_KEY`, `BFF_INTERNAL_SECRET` i niepustego `BFF_TRUSTED_PEERS`. Lokalnie peer to `127.0.0.1,::1`. Ten sam sekret Nuxt czyta jako `NUXT_BFF_INTERNAL_SECRET`. Pusta lista peerów odrzuca wywołania wewnętrzne. Produkcyjny hosting, proxy, backup i monitoring nie są opisane w repozytorium i blokują wdrożenie. Szczegóły sesji są w `docs/AUTH-SESSION.md`.

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

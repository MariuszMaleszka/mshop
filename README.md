# Shop Cursor Starter

Dokumentacja startowa dla modułowego sklepu internetowego:
- Frontend: Nuxt 4 + JavaScript
- Backend: Node.js + Express + JavaScript
- Database/Auth/Storage: Supabase (PostgreSQL)
- Monorepo: pnpm workspaces

## Założenia MVP

1. Jeden sklep i jeden właściciel sklepu (nie marketplace).
2. Klient może kupić jako gość lub po zalogowaniu. Konto jest wymagane do historii zakupów, ale nie jest warunkiem zakupu.
3. Katalog obsługuje produkty fizyczne, cyfrowe i usługi.
4. Płatności: operator online (początkowo jeden) oraz gotówka jako metoda rozliczenia ręcznego.
5. W MVP nie ma rezerwacji terminów, dostaw, fakturowania ani wielosklepowości.
6. Ceny są przechowywane jako liczby całkowite w najmniejszej jednostce waluty (np. grosze), nigdy jako float.
7. Backend Express jest właścicielem logiki biznesowej. Frontend nie zapisuje bezpośrednio zamówień ani płatności do bazy.

## Jak używać dokumentacji

1. Przeczytaj `AGENTS.md`.
2. Przeczytaj `docs/ARCHITECTURE.md` i `docs/DEVELOPMENT-RULES.md`.
3. Przed zmianą bazy przeczytaj `docs/DATABASE.md`.
4. Przed zmianą API przeczytaj `docs/API.md`.
5. Wybierz jedno zadanie z `docs/ROADMAP.md`.
6. Użyj `docs/TASK-TEMPLATE.md`, aby zlecić je agentowi.
7. Po zakończeniu zaktualizuj status zadania w roadmapie i dokumentację, jeśli zmieniły się kontrakty.

## Ważne decyzje bezpieczeństwa

- Supabase Auth obsługuje hasła i OAuth (Google, Apple). Nie przechowujemy haseł w swojej bazie.
- Express weryfikuje access token Supabase dla chronionych endpointów.
- Klucz `service_role` jest wyłącznie po stronie serwera i nie może trafić do Nuxt/client bundle.
- Webhook płatniczy jest źródłem potwierdzenia płatności, a nie powrót przeglądarki na stronę sukcesu.
- Każdy endpoint admina wykonuje autoryzację po stronie backendu.
- RLS jest włączone dla tabel dostępnych z klienta. Dostęp serwerowy z service role omija RLS, dlatego backend musi sam egzekwować autoryzację i zakres danych.

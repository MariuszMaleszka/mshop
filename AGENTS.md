# Instrukcje dla agentów AI

## Cel projektu
Budujemy modułowy, pojedynczy sklep internetowy. Szczegóły i ograniczenia są opisane w `docs/`.

## Stack
- Nuxt 4, JavaScript (bez TypeScript)
- Node.js + Express, JavaScript ES modules
- Supabase: PostgreSQL, Auth, Storage
- pnpm workspaces
- Zod do walidacji danych
- REST API

## Zasady pracy
1. Zanim zaczniesz, przeczytaj dokumentację związaną z zadaniem.
2. Nie skanuj ani nie modyfikuj całego repozytorium bez potrzeby. Zacznij od wskazanych plików i ich bezpośrednich zależności.
3. Przed implementacją przedstaw krótki plan: zakres, pliki, zmiany w bazie/API, testy i ryzyka.
4. Jeśli zadanie jest niejednoznaczne lub wymaga decyzji architektonicznej, zatrzymaj się i zadaj jedno konkretne pytanie.
5. Nie implementuj funkcji spoza zakresu zadania.
6. Nie dodawaj zależności bez uzasadnienia i zgody.
7. Nie zmieniaj publicznych kontraktów API ani schematu bazy bez aktualizacji dokumentacji.
8. Nie twórz abstrakcji „na przyszłość”, jeśli nie ma obecnego przypadku użycia.
9. Zachowuj istniejący styl kodu i strukturę modułów.
10. Komentarze w kodzie pisz wyłącznie po angielsku.
11. Nie używaj `any` ani TypeScriptu — projekt jest JavaScript-only.
12. Nie zapisuj sekretów w kodzie, logach, testach ani dokumentacji.
13. Nie zwracaj klientowi szczegółów wewnętrznych błędów, stack trace ani danych wrażliwych.
14. Każdy input z zewnątrz waliduj po stronie backendu.
15. Operacje krytyczne (zamówienia, płatności, uprawnienia) muszą być wykonywane i sprawdzane po stronie backendu.

## Architektura
- `apps/web` odpowiada za UI i komunikację z API.
- `apps/api` odpowiada za logikę biznesową i dostęp do danych.
- `packages/shared` zawiera wyłącznie współdzielone, niezależne od runtime elementy, np. schematy Zod i stałe.
- `supabase/` zawiera migracje SQL, seed i konfigurację Supabase.
- Nie umieszczaj logiki biznesowej w komponentach Vue ani w `packages/shared`.

## Workflow
1. Analiza tylko właściwego zakresu.
2. Plan implementacji.
3. Oczekiwanie na akceptację planu, jeśli zadanie wymaga zmian w wielu obszarach lub ma ryzyko architektoniczne.
4. Implementacja.
5. Uruchomienie odpowiednich testów/lint/build.
6. Raport:
   - co zmieniono;
   - lista plików;
   - wykonane testy i wyniki;
   - znane ograniczenia;
   - wymagane decyzje.

## Definicja ukończenia
Zadanie jest ukończone, gdy:
- spełnia kryteria akceptacji;
- nie rozszerza nieuzgodnionego zakresu;
- ma walidację i obsługę błędów;
- odpowiednie testy przechodzą;
- dokumentacja jest aktualna;
- nie zawiera sekretów ani niezamierzonych zmian.

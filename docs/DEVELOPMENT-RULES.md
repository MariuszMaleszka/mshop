# Zasady rozwoju

## JavaScript
- Używaj ES modules.
- Nie wprowadzaj TypeScriptu.
- Preferuj prosty, czytelny kod.
- Unikaj nadmiernej abstrakcji i generycznych frameworków wewnętrznych.

## Frontend
- Komponenty Vue odpowiadają za prezentację i interakcje.
- Logikę wielokrotnego użycia umieszczaj w composables.
- Komunikację z backendem centralizuj w warstwie API/composables.
- Nie umieszczaj sekretów w `runtimeConfig.public`.
- Middleware Nuxt nie zastępuje autoryzacji backendu.
- Formularze waliduj UX-owo, ale backend zawsze waliduje ponownie.

## Backend
- Trzymaj kontrolery cienkie.
- Reguły biznesowe umieszczaj w service.
- Dostęp do danych oddzielaj, gdy ułatwia to testowanie i utrzymanie.
- Waliduj body, params i query.
- Stosuj centralny error handler.
- Nie zwracaj surowych błędów bazy.
- Dodawaj limity i bezpieczne wartości domyślne do list.

## Baza danych
- Każda zmiana schematu przez migrację SQL.
- Migracje muszą być możliwe do odtworzenia na czystej bazie.
- Dodawaj indeksy dla kluczy obcych i często filtrowanych kolumn, gdy uzasadnione.
- Nie usuwaj danych produkcyjnych w migracji bez jawnej decyzji.
- Seed zawiera wyłącznie dane demonstracyjne.

## Bezpieczeństwo
- Zasada najmniejszych uprawnień.
- Walidacja tokenów i ról po stronie backendu.
- Ochrona przed IDOR: sprawdzaj właściciela każdego zasobu.
- CORS ograniczony do znanych originów.
- Rate limiting dla logowania, checkoutu i endpointów wrażliwych.
- Bezpieczne nagłówki HTTP.
- Sekrety wyłącznie w zmiennych środowiskowych/secret managerze.
- Logi nie mogą zawierać tokenów, haseł ani pełnych danych płatniczych.
- Webhooki weryfikuj i obsługuj idempotentnie.

## Testy
- Unit: logika service i walidacje.
- Integration: endpointy i dostęp do bazy testowej.
- E2E: kluczowe ścieżki klienta i admina.
- Testuj scenariusze negatywne, nie tylko happy path.

## Git
- Małe commity o jednym zakresie.
- Nie commituj `.env`.
- Nie nadpisuj cudzych zmian.
- Przed commitem sprawdź `git diff`.

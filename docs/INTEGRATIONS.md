# Integracje zewnętrzne

Ten dokument jest projektem architektury. Nie opisuje zaimplementowanego modułu integracji.

Jedyną podłączoną integracją jest sandboxowe Przelewy24. Produkcyjny checkout online pozostaje wyłączony. Nie ma fakturowania, KSeF, kuriera, fiskalizacji, poczty transakcyjnej ani SMS. Nie ma tabeli outbox, workera integracji ani panelu „Integracje”.

Dostawcy poza Przelewy24 nie są wybrani. Kwestie podatkowe i księgowe z `docs/PROJECT_HANDOFF.md` pozostają odłożone do konsultacji z księgowym.

## 1. Podział odpowiedzialności

mshop jest źródłem prawdy dla:

- zamówień oraz statusu płatności i realizacji;
- koszyka i pozycji zamówienia;
- `stock_quantity` i `inventory_reservations`;
- procesu realizacji zamówienia;
- użytkowników, ról i uprawnień;
- konfiguracji sklepu, w tym `shop_profile`;
- powiązania zamówienia z operacją u dostawcy.

Dostawca odpowiada tylko za swoją specjalizację:

- operator płatności realizuje i potwierdza transakcję;
- system fakturowy wystawia dokumenty i prowadzi własne integracje podatkowe, w tym przyszły KSeF, jeśli księgowy tego zażąda;
- broker kurierski tworzy etykiety i przesyłki oraz rozmawia z przewoźnikami;
- system fiskalny fiskalizuje sprzedaż, jeżeli obowiązek zostanie potwierdzony;
- dostawca komunikacji wysyła e-mail albo SMS.

Logika sklepu zostaje w mshop. Dostawca nie decyduje o dostępności towaru, cenie, podatku zastosowanym na zamówieniu, właścicielu zamówienia ani o tym, że zamówienie jest zrealizowane. Obcy status jest mapowany na status mshop albo zostaje nierozstrzygnięty. Nie jest kopiowany jako nowy stan biznesowy bez reguły.

## 2. Co jest zaimplementowane

### Przelewy24

Adapter jest w `apps/api/src/p24`. Checkout online, wyłącznie sandbox, commituje zamówienie, płatność `pending` / `not_started` i rezerwację, a dopiero potem woła rejestrację. `payments.id` jest `sessionId`. `provider_transaction_id` jest identyfikatorem transakcji operatora. `redirect_token` jest tokenem rejestracji, nie identyfikatorem transakcji.

Przed wywołaniem `transaction/register` osobna transakcja oznacza inicjalizację jako `unknown`, jeśli nadal jest `not_started` (`markUnknown` w `apps/api/src/checkout/online-payment.js`). Wynik niejednoznaczny zostaje `unknown`. Z tego stanu kod nie wraca do `not_started` i nie woła rejestracji drugi raz. Odczyt po `sessionId` może nastąpić, ale jego wynik jest odrzucany i nie zapisuje tokenu ani statusu. Procedura ręczna jest w `docs/P24_RECONCILIATION.md`.

Webhook `POST /webhooks/payments/przelewy24` sprawdza podpis, identyfikatory, kwotę i walutę. Zamiar weryfikacji commituje jako `verification_requested` zanim wyjdzie `transaction/verify`. Lokalne `paid` powstaje tylko przy dokładnym `data.status` równym `success`, razem z `verification_accepted`, `paid_at` i historią. Inny status weryfikacji zostaje nierozstrzygnięty i nie zapisuje `verification_declined`. Drugiego `verifyTransaction` nie ma. Powtórzone powiadomienie po zapisanym zamiarze dostaje `unchanged`. Powrót przeglądarki nic nie potwierdza. Worker wygaszania rezerwacji nie jest workerem integracji i nie przywraca rezerwacji przy spóźnionym `paid`.

`idempotency_keys` dotyczy powtórzonego `POST /api/v1/checkout`, nie webhooka. `payment_events` jest historią webhooka tej płatności.

Sekrety P24 są w konfiguracji procesu API. Frontend ich nie widzi. Logi błędów HTTP nie zwracają klientowi body operatora.

### Czego ten przebieg nie jest

Nie ma wspólnego adaptera dla innych usług. Nie ma kolejki zleceń trwałej poza wierszem `payments` i `payment_events`. Nie ma automatycznego ponowienia rejestracji ani weryfikacji. Nie ma widoku administracyjnego tych operacji. `POST /payments/:id/retry` i `POST /admin/orders/:id/mark-paid` są planowane, niezaimplementowane.

## 3. Założenie architektoniczne

Każda przyszła integracja dostaje własny adapter za wspólnym kontraktem wewnętrznym. Adapter tłumaczy żądanie i odpowiedź. Nie zawiera reguł koszyka, magazynu ani realizacji.

Wspólne elementy, jeszcze niezaimplementowane jako moduł:

- lokalny identyfikator operacji, niezależny od identyfikatora dostawcy;
- identyfikator zewnętrzny zapisywany dopiero wtedy, gdy dostawca go zwróci i przejdzie walidację;
- powiązanie operacji z zamówieniem albo inną encją mshop;
- mapa statusów dostawcy na status wewnętrzny, z jawnym stanem nierozstrzygniętym;
- walidacja odpowiedzi i webhooka zanim jakikolwiek zapis uzna operację za zakończoną;
- sprawdzenie autentyczności komunikatu sekretem znanym tylko backendowi;
- zapis zdarzenia, który da się porównać przy duplikacie;
- rozdzielenie błędu pewnego od wyniku nieznanego;
- historia zdarzeń i ślad ręcznej zmiany.

Idempotencja ma dwa różne znaczenia i nie wolno ich zlewać. Klucz `Idempotency-Key` dotyczy powtórzenia żądania klienta do mshop. Dostawca ma własny identyfikator i własne powtórzenia. Webhook nie używa klucza idempotencji checkoutu.

## 4. Błędy i operacje niejednoznaczne

Wynik zewnętrzny ma trzy klasy:

- pewny sukces — lokalny stan wolno domknąć w tej samej transakcji co zdarzenie potwierdzające;
- pewny błąd — wywołanie nie zostało przyjęte; wolno zostawić operację niewykonaną albo, jeśli reguła na to pozwala, ponowić ją od stanu początkowego;
- wynik nieznany — timeout, zerwane połączenie, odpowiedź po zapisie u dostawcy, ale przed zapisem lokalnym, albo status spoza jawnej listy sukcesu. Operacja zostaje nierozstrzygnięta. Nie jest ponawiana automatycznie.

Płatności, wystawienie dokumentu i utworzenie przesyłki nie są bezpieczne do ślepego ponowienia. Przed kolejną próbą trzeba potwierdzić u dostawcy, czy poprzednia próba powstała. Brak takiego odczytu oznacza ręczną interwencję, nie drugie wywołanie tworzące.

Ponowienie jest dozwolone tylko dla operacji, której adapter deklaruje powtarzalność, na przykład wysyłki tego samego szablonu wiadomości z tym samym lokalnym identyfikatorem, albo odczytu statusu. Ponowienie z panelu ma być osobną, uprawnioną czynnością i ma zostać w historii. Nie jest automatycznym backoffem.

Istniejące ograniczenia P24 zostają:

- `unknown` nie uruchamia drugiego `transaction/register`;
- `verification_requested` bez `verification_accepted` nie uruchamia drugiego `transaction/verify`;
- status inny niż dokładne `success` nie jest odmową i nie jest sukcesem;
- host `https://sandbox.przelewy24.pl/trnRequest/{TOKEN}` nadal wymaga potwierdzenia w teście sandbox;
- produkcyjny checkout online pozostaje wyłączony.

## 5. Trwałe zlecenie i worker

Obecny checkout online nie używa outboxa. Zlecenie rejestracji nie powstaje w tej samej transakcji co zamówienie. Najpierw commit zamówienia, potem osobna transakcja `unknown`, potem wywołanie HTTP. Restart po `unknown` nie gubi faktu próby, ale też jej nie powtarza. To jest zamierzone.

Dla przyszłych integracji transakcyjny outbox jest właściwy, jeśli zlecenie ma przetrwać restart i nie może zniknąć razem z procesem. Zapis zlecenia ma iść w tej samej transakcji co lokalna zmiana, która je uzasadnia. Worker czyta zaległe zlecenia po starcie. Nieudane, powtarzalne próby dostają ograniczony backoff. Po wyczerpaniu prób albo po wyniku nieznanym zlecenie przechodzi do ręcznej weryfikacji. Panel administracyjny ma pokazać ten stan. Tego workera i tabeli nie ma.

Outbox nie oznacza, że każde zlecenie wolno wykonywać aż do skutku. Dla płatności, faktury i przesyłki worker po nieznanym wyniku przechodzi do uzgodnienia albo do interwencji. Nie tworzy drugiej operacji u dostawcy.

Worker wygaszania rezerwacji zostaje osobnym procesem. Nie wysyła płatności, dokumentów ani przesyłek.

## 6. Bezpieczeństwo

Sekrety dostawców zostają w konfiguracji API. Nie wchodzą do frontendu, logów, testów utrwalanych w repozytorium ani do odpowiedzi JSON.

Nie logować tokenów przekierowania, kluczy CRC i API, danych kart ani pełnych payloadów z danymi osobowymi. Zdarzenie płatności P24 trzyma tylko pola potrzebne do powiązania. Ten sam minimalny zakres obowiązuje przyszłe zdarzenia.

Webhook jest odrzucany przed zapisem, gdy podpis, identyfikator, kwota albo waluta nie pasują. Dla P24 ochrona przed duplikatem wynika ze stanu płatności i istniejącego zdarzenia, nie z jednorazowego nonce. Przyszły dostawca, który ma własny identyfikator zdarzenia, ma go zapisać i odrzucić powtórkę. Okno czasowe replayu nie jest zaimplementowane i nie wolno go domniemywać.

Operacje administracyjne przechodzą przez `requireAuth` i `requireAdmin`. Ręczna zmiana statusu, ponowienie albo uznanie uzgodnienia zapisuje kto i kiedy to zrobił. Samo obejrzenie błędu nie zmienia stanu.

Odpowiedź dostawcy wolno zachować tylko w zakresie potrzebnym do audytu i uzgodnienia. Tokenu, którego nie da się odtworzyć z odczytu, nie wolno rekonstruować. Dla P24 brak zapisanego tokenu pozostaje brakiem tokenu.

## 7. Panel „Integracje”

Przyszły moduł administracyjny, bez interfejsu i bez tras. Uprawniona osoba ma zobaczyć:

- czy konfiguracja danej integracji jest kompletna, bez pokazywania sekretu;
- ostatnie błędy i historię operacji;
- operacje oczekujące, zakończone i wymagające interwencji;
- powiązane zamówienie;
- ponowienie tylko wtedy, gdy reguła z sekcji 4 na to pozwala.

Ponowienie niedozwolone dla `unknown` i dla `verification_requested` P24 nie pojawia się jako bezpieczna akcja. Te stany prowadzą do `docs/P24_RECONCILIATION.md`.

## 8. Co jest wspólne, a co należy do operatora płatności

Wspólne dla przyszłych adapterów, dziś obecne tylko jako wzorzec P24:

- lokalny identyfikator operacji ustalony przed wywołaniem;
- osobny identyfikator dostawcy;
- walidacja kwoty, waluty i powiązania przed uznaniem sukcesu;
- zdarzenie zamiaru przed wywołaniem, którego wynik może nie wrócić;
- stan nieznany bez automatycznego ponowienia;
- blokada sesyjna przy równoległym webhooku i finalizacji;
- historia zdarzeń zamiast nadpisywania jedynego logu.

Specyficzne dla Przelewy24:

- `sessionId` równy `payments.id`;
- podpis CRC i `transaction/verify`;
- dokładny tekst `success` jako jedyny automatyczny sukces weryfikacji;
- token panelu i rozróżnienie sandbox oraz production;
- 15-minutowa rezerwacja online i jej wygaśnięcie bez zwrotu stanu.

Fakturowanie, KSeF, kurier, fiskalizacja i wiadomości nie dziedziczą tych identyfikatorów. Dostaną własne kolumny albo własne tabele dopiero w osobnym zadaniu, po wyborze dostawcy i po decyzjach księgowych, których dotyczą.

## 9. Decyzje nadal otwarte

- Czy obowiązek fiskalizacji w ogóle występuje.
- Jakie dokumenty sprzedaży i jaka ewidencja płatności są wymagane.
- Który dostawca faktur, KSeF, kuriera i wiadomości. Nie wybierać go przy okazji implementacji outboxa.
- Czy wspólna tabela zleceń obsłuży wszystkie typy operacji, czy płatności zostaną przy obecnym wierszu `payments`. Tego schematu nie ma i ten dokument go nie wprowadza.
- Czy przyszły worker integracji jest osobnym procesem, tak jak worker rezerwacji. To rekomendacja, nie istniejący proces.

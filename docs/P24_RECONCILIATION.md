# Ręczna rekonsyliacja Przelewy24

Ten dokument opisuje dwa stany, których bieżący kod nie domyka automatycznie. Nie jest instrukcją zmiany bazy ani ponownego wywołania operatora.

Kod nie ma bezpiecznej procedury automatycznego odzyskania żadnego z tych stanów. Ponowienie `transaction/register` i ponowienie `transaction/verify` są zabronione. Ręczne `UPDATE` nie jest zwykłą procedurą. Sam HTTP 200 oraz sam status z podglądu transakcji nie są zakończoną weryfikacją.

Lokalne `paid` powstaje tylko wtedy, gdy webhook zapisze w jednej transakcji `verification_accepted`, status płatności, status zamówienia, `provider_transaction_id`, `paid_at` i historię. Powrót przeglądarki na `urlReturn` nie ma endpointu i niczego nie potwierdza.

Identyfikatory i kwoty porównuj jako tekst. Nie zamieniaj ich na liczbę JavaScriptu. Kwoty w bazie są groszami.

## A. `initialization_status = unknown`

Ten stan oznacza, że checkout już zatwierdził zamówienie, a rejestracja została rozpoczęta lokalnie. Wynik `transaction/register` nie został zapisany jako token. Przyczyną może być timeout, błąd sieci, odrzucenie odpowiedzi albo awaria po odpowiedzi operatora, zanim token trafił do wiersza.

### Dane lokalne

Odczytaj, bez zmiany wierszy:

- `orders.id`, `orders.order_number`, `orders.payment_status`, `orders.created_at`;
- `payments.id` — to jest `sessionId` wysłany do Przelewy24;
- `payments.amount`, `payments.currency`, `payments.status`, `payments.initialization_status`, `payments.redirect_token`, `payments.provider_transaction_id`;
- liczbę rezerwacji i ich `status` oraz `expires_at`.

Dla tego przypadku oczekiwany układ to płatność `pending`, inicjalizacja `unknown`, pusty `redirect_token` i pusty `provider_transaction_id`. Inny układ nie należy do tej procedury.

### Sprawdzenie po stronie operatora

Specyfikacja Przelewy24 opisuje odczyt `GET /transaction/by/sessionId/{sessionId}`. Pole `sessionId` w odpowiedzi ma odpowiadać `payments.id`. Ta sama specyfikacja opisuje całkowity status transakcji: `0` brak płatności, `1` przedpłata, `2` płatność dokonana, `3` zwrot. Odpowiedź zawiera też `orderId`, kwotę i walutę.

Bieżący sklep przy powtórzeniu checkoutu może wykonać taki odczyt, ale wynik odrzuca. Nie zapisuje z niego tokenu, identyfikatora transakcji ani statusu. Nie ma w aplikacji osobnego narzędzia rekonsyliacji. Panelu operatorskiego specyfikacja użyta w projekcie nie opisuje na tyle, aby podawać ścieżkę kliknięć.

Rejestrację uznaj za przyjętą tylko wtedy, gdy odczyt po `sessionId` zwraca transakcję z tym samym `sessionId` oraz kwotą i walutą równymi lokalnej płatności. Brak transakcji oznacza, że lokalny `unknown` nie ma pary po stronie operatora.

### Zakaz ponownej rejestracji

`unknown` jest śladem, że wywołanie rejestracji mogło już dojść do operatora. Drugi `transaction/register` dla tego samego `sessionId` mógłby utworzyć drugą transakcję albo zostać odrzucony. Kod świadomie nie wraca z `unknown` do `not_started` i nie wywołuje rejestracji ponownie. Tej decyzji nie wolno obchodzić ręcznym powtórzeniem.

### Tokenu nie da się odzyskać

Udokumentowany odczyt transakcji po `sessionId` nie zwraca tokenu przekierowania. Specyfikacja nie opisuje innego odczytu tego tokenu. Gdy token nie został zapisany lokalnie, nie ma udokumentowanego sposobu jego odtworzenia.

Nie wywołuj `transaction/register`. Nie ustawiaj `registered` ani `redirect_token` ręcznie. Zostaw `unknown`. Poinformuj, że automatyczne przekierowanie nie powstanie. Brakującego tokenu nie składa się w adres. Zapisany token sandboxu używa wyłącznie stałego hosta `https://sandbox.przelewy24.pl/trnRequest/{TOKEN}`. Ten host wymaga końcowego potwierdzenia podczas testu sandbox, bo specyfikacja REST 1.0.18 podaje bezpośrednio tylko adres produkcyjny. Rezerwacja nadal wygasa po 15 minutach od utworzenia zamówienia. Nowy zakup wymaga nowego zamówienia, bo koszyk tego zamówienia jest już przekonwertowany. Takiej nowej próby ta procedura nie uruchamia.

Status `2` z podglądu nie zmienia lokalnej płatności na `paid` i nie zastępuje `transaction/verify`.

## B. `verification_requested` bez `verification_accepted`

Webhook zapisał zamiar weryfikacji i zatwierdził go przed HTTP. Wywołanie `transaction/verify` mogło nie wyjść, paść w drodze, wrócić niejednoznacznie albo wrócić sukcesem, który nie został zapisany. Kod nie ponawia weryfikacji. Kolejne powiadomienie dostaje HTTP 202 `unchanged` i nie finalizuje płatności.

Każdy `data.status` inny niż dokładne `success` jest obecnie nierozstrzygnięty. Nie powstaje z niego `verification_declined`. Lista definitywnych odmów nie jest zaimplementowana, bo specyfikacja jej nie podaje. Już istniejące `verification_declined` nadal zamyka automatyczną ścieżkę i nie jest brakiem `verification_accepted` do uzupełnienia.

### Dane do porównania

Odczytaj payload `verification_requested` jako tekst pól `sessionId`, `orderId`, `amount`, `originAmount`, `currency` i `methodId`. Porównaj:

- `sessionId` z `payments.id`;
- `amount` i `originAmount` z `payments.amount`; lokalna reguła wymaga ich równości;
- `currency` z walutą płatności;
- `orderId` z `payments.provider_transaction_id`, jeśli ten identyfikator już nie jest pusty;
- `payments.status` i `orders.payment_status`;
- czy istnieje `verification_accepted` albo `verification_declined`.

Różnica któregokolwiek z tych tekstów jest konfliktem. Nie wybieraj jednej ze stron i nie nadpisuj identyfikatora ani kwoty.

### Stan po stronie operatora

Użyj tego samego udokumentowanego odczytu `GET /transaction/by/sessionId/{sessionId}`. Porównaj `orderId`, kwotę i walutę z payloadem zdarzenia.

Specyfikacja weryfikacji mówi, że transakcja jest potwierdzona dopiero po `transaction/verify`. Jeśli klient zapłacił, a sprzedawca nie zweryfikował transakcji, kwota nie jest rozliczona sprzedawcy i zostaje przedpłatą klienta. Dlatego:

- status podglądu `0` traktuj jako brak płatności;
- status `1` traktuj jako przedpłatę, nie jako lokalne `paid`;
- status `2` oznacza w słowniku podglądu płatność dokonaną, ale bez zapisanego `verification_accepted` nadal nie jest lokalnym potwierdzeniem;
- status `3` oznacza zwrot w tym słowniku i też nie zmienia lokalnego wiersza.

Sam HTTP 200 z weryfikacji albo z podglądu nie jest sukcesem. Jednoznaczny sukces, którego kod nie zapisał, wymagałby jednocześnie HTTP 200, `responseCode` 0 i `data.status` równego dokładnie `success`. Tego wyniku w bazie nie ma, jeśli brakuje `verification_accepted`.

### P24 potwierdza wpłatę, a lokalnie jest `pending`

Nie wywołuj `verifyTransaction`. Nie wstawiaj `verification_accepted`. Nie ustawiaj `paid`, `paid_at` ani `provider_transaction_id` ręcznie. Zachowaj `verification_requested` i status `pending`.

Zapisz poza tą procedurą, w zgłoszeniu do operatora: `payments.id`, `orders.id`, `orders.order_number`, `orderId`, kwotę, walutę, czas `verification_requested.created_at` oraz status liczbowy z podglądu. Dalsza zmiana lokalnego statusu wymaga osobnej, zaakceptowanej ścieżki. Ta ścieżka w kodzie nie istnieje.

Rezerwacje wygasłe pozostają wygasłe. Rekonsyliacja finansowa nie zwraca stanu magazynowego ani nie uruchamia realizacji.

### Kiedy eskalować

Eskaluj do operatora, gdy podgląd pokazuje transakcję dla tego `sessionId`, a lokalnie nie ma `verification_accepted`, szczególnie przy statusie `1` albo `2`. Eskaluj także wtedy, gdy `orderId` albo kwota z podglądu różni się od payloadu zdarzenia. Nie eskaluj samego braku transakcji jako płatności: to jest brak wpłaty, a lokalne `pending` zostaje.

Gdy istnieje `verification_declined`, nie eskaluj tego jako braku finalizacji. To lokalne zamknięcie automatycznej weryfikacji. Bieżący webhook już go nie zapisuje dla nieznanego statusu. Taki status zostawia samo `verification_requested` i wymaga tej procedury. Znaczenie tekstów innych niż dokładne `success` nie jest w specyfikacji wyliczone.

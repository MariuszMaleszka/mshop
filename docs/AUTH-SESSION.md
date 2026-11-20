# Sesja konta, BFF i ochrona logowania

Ten dokument jest jedyną szczegółową specyfikacją sesji. Tabele `account_sessions`, `login_challenges` i `auth_attempt_counters` oraz szyfrowanie AES-256-GCM są w repozytorium. Logowanie, odświeżenie, wylogowanie, bootstrap CSRF i BFF nadal nie są zaimplementowane i wymagają osobnej zgody przed rozpoczęciem prac. Nie zmienia obecnego kontraktu `requireAuth` ani `requireAdmin`. Checkout i Przelewy24 są poza zakresem.

Supabase Auth zostaje źródłem tożsamości. Administrator nie dostaje osobnego konta. Rola jest czytana z `public.user_roles` przy każdym żądaniu Expressa. Przeglądarka nie zapisuje tokenów w `localStorage` ani `sessionStorage`. Proces Nuxt i proces Express nie trzymają sesji użytkowników w zmiennych globalnych.

## 1. Co jest dziś

Express weryfikuje access token z nagłówka `Authorization: Bearer` przez JWKS. Nie ma trasy logowania, odświeżenia ani wylogowania. `useApi()` sam nie dokłada Bearer. Panel `/admin/orders` woła API bez tego nagłówka.

Jedyna sesja aplikacji to gość: ciasteczko `shop_guest_session`. Nie jest sesją konta i nie staje się nią po tym projekcie.

Katalog publiczny zwraca pola tekstowe kategorii i produktu. Nie zwraca adresu zdjęcia. Szablony sklepu i panelu nie mają elementu `img`. Fonty Poppins i PrimeIcons są importowane w `apps/web/nuxt.config.js` z pakietów, nie z CDN. `nuxt.config.js` nie ustawia CSP, nonce ani `features.inlineStyles`.

## 2. Docelowy podział

Jedno konto ma jeden mechanizm uwierzytelnienia: sesję BFF. Uprawnienie jest osobnym sprawdzeniem w Expressie.

| Kto | Sesja | Pierwszy etap | Później |
| --- | --- | --- | --- |
| Niezalogowany klient | Dalej `shop_guest_session` wprost do Expressa | Bez zmian | Bez zmian, dopóki osobna decyzja nie ruszy koszyka gościa |
| Zalogowany klient | Ta sama sesja konta co administrator | Trasy konta nadal wymagają Bearer. Przeglądarka go nie ma, więc konto klienta zostaje niepodłączone | Te same trasy przechodzą przez Nuxt. Express dalej dostaje Bearer od serwera Nuxt |
| Administrator | Ta sama sesja konta. Brak wiersza `admin` daje 403 | Logowanie, odświeżenie, wylogowanie i odczyt `/admin/orders` oraz `/admin/orders/:id` | `mark-paid` i `cancel`, gdy panel ma je wołać |

Jedna przeglądarka ma jedno ciasteczko sesji konta. Logowanie w tej przeglądarce unieważnia poprzedni wiersz wskazany przez dotychczasowe ciasteczko i wydaje nowy identyfikator. Inne urządzenia mogą mieć własne wiersze. Nie powstaje drugie ciasteczko „administratora”.

`requireAuth` i `requireAdmin` zostają. Nuxt po stronie serwera dokłada Bearer do wywołania Expressa. Przeglądarka na trasach BFF tego nagłówka nie wysyła.

## 3. Gdzie leżą sekrety

Access token i refresh token leżą w wierszu PostgreSQL, zaszyfrowane AES-256-GCM kluczem procesu. Wektor jest losowany przy każdym zapisie. Identyfikator sesji w bazie występuje tylko jako SHA-256. Klucz ma 32 bajty i przychodzi ze zmiennej procesu `SESSION_TOKEN_KEY` jako standardowe base64. Pusta wartość jest dozwolona, dopóki logowanie nie jest podłączone. Sposób lokalnego wygenerowania jest w `.env.example`. Ta zmienna nie wchodzi do publicznej konfiguracji Nuxt.

Ciasteczko sesji konta niesie wyłącznie losowy identyfikator. Produkcyjna nazwa to `__Host-mshop_session`: `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, bez `Domain`. Lokalny HTTP nie spełnia warunków `__Host-` ani `Secure`. Tam nazwa to `mshop_session`, bez `Secure`.

Nuxt nie zapisuje tokenów między żądaniami. Przy SSR przekazuje identyfikator z ciasteczka do Expressa. Do HTML nie wchodzi access token, refresh token ani hasło.

Skrót tokenu CSRF sesji leży w tym samym wierszu. Surowa wartość wraca do przeglądarki w JSON i zostaje w pamięci strony do nagłówka. Nie chroni żądania, które tę sesję dopiero tworzy.

## 4. CSRF przed logowaniem

Token sesji zalogowanego użytkownika nie może chronić logowania. Przed hasłem istnieje osobne wyzwanie.

1. Niezalogowany użytkownik otwiera stronę logowania.
2. Strona wysyła `POST` bootstrapu na własny host Nuxt. To żądanie nie niesie tokenu CSRF, bo dopiero go tworzy.
3. Nuxt sprawdza `Origin`. Gdy `Origin` nie ma, wymaga `Referer` z tym samym originem. Brak obu albo inna wartość kończy się odmową, bez wiersza i bez wywołania Supabase.
4. Po limiterze Express losuje identyfikator wyzwania i sekret CSRF. Zapisuje tylko ich skróty. Ważność wiersza to 10 minut, bez przedłużania.
5. Nuxt ustawia osobne ciasteczko identyfikatora. Produkcyjnie `__Host-mshop_login`, z tymi samymi flagami co sesja konta. JSON zwraca sekret CSRF jeden raz.
6. Formularz wysyła hasło, ciasteczko wyzwania i nagłówek `X-CSRF-Token`.
7. Express w jednej krótkiej transakcji sprawdza skróty, czas i `consumed_at`. Przy zgodności ustawia `consumed_at` i commituje. Dopiero potem woła Supabase. Transakcja nie obejmuje wywołania sieciowego.
8. Zużyte, wygasłe albo powtórzone wyzwanie daje 403 i komunikat, że formularz wygasł. Supabase nie jest wołane. Błędne hasło nie przywraca wyzwania. Strona bierze nowe.
9. Po poprawnym haśle Express losuje nowy identyfikator sesji konta, inny niż identyfikator wyzwania. Ignoruje identyfikator przysłany przez klienta. Wiersz wyzwania jest kasowany, ciasteczko wyzwania wygasa, powstaje wiersz sesji i ciasteczko sesji.

Więcej niż jedna wartość ciasteczka wyzwania powoduje odmowę, tak jak przy zduplikowanym ciasteczku gościa. Wyzwanie nie jest zamieniane na sesję przez zmianę nazwy ciasteczka.

To nie daje atomowości z Supabase. Zużycie wyzwania przed odpowiedzią Auth oznacza, że przerwane logowanie też wymaga nowego formularza. Hasło nie zostaje przyjęte drugi raz na tym samym sekrecie.

## 5. Adres IP i limiter

Dziś `apps/api` nie wywołuje `trust proxy`. Express bierze adres z połączenia TCP. Nagłówek `X-Forwarded-For` nie wybiera adresu, bo aplikacja go nie czyta.

Logowanie i bootstrap idą z przeglądarki do Nuxt, a dopiero Nuxt woła Express. Express widzi więc adres procesu Nuxt, nie adres przeglądarki. Adres do licznika ustala Nuxt i przekazuje go w nagłówku `X-Mshop-Client-Ip`.

Nuxt ignoruje `X-Forwarded-For`, dopóki bezpośredni peer nie jest na jawnej liście zaufanych proxy. Lewy adres z tego nagłówka nie jest adresem klienta: dopisuje go nadawca, zanim żądanie dotrze do proxy. Przy jednym zaufanym proxy Nuxt bierze adres, który to proxy dopisało jako ostatni. Lista pusta oznacza, że adresem jest peer gniazda. `trust proxy = true` jest niedozwolone i w produkcji, i lokalnie.

Express przyjmuje `X-Mshop-Client-Ip` tylko razem z sekretem wewnętrznym i tylko wtedy, gdy peer TCP jest na liście `BFF_TRUSTED_PEERS`. Inaczej używa peer TCP i nagłówek pomija. Przeglądarka, która sama wyśle ten nagłówek albo `X-Forwarded-For` do Expressa, nie wybiera sobie kubełka limitera.

Lokalnie lista peerów to `127.0.0.1` i `::1`. W produkcji lista startuje pusta. Hostingu i load balancera to repozytorium nie nazywa. Logowanie za proxy nie rusza, dopóki operator nie wpisze adresów tego proxy. Bez tej listy wszyscy użytkownicy za jednym proxy wpadliby do jednego kubełka albo, przy naiwnym zaufaniu do nagłówka, klient sam wybierałby adres. Wiele instancji Nuxt i Express dzieli te same wiersze PostgreSQL. Kubełek zależy od adresu ustalonego tą regułą, nie od numeru instancji i nie od pamięci procesu.

## 6. Odświeżenie i przerwana rotacja

`FOR UPDATE` serializuje żądania jednego wiersza. Nie łączy zapisu PostgreSQL z rotacją w Supabase Auth. Trzymanie transakcji i blokady przez czas wywołania Auth jest odrzucone: pula `pg` ma domyślnie najwyżej 20 połączeń, a zawieszone żądanie trzymałoby połączenie i blokadę wiersza.

Gdy access token jest jeszcze ważny, żądanie go używa i nie woła Auth. W przeciwnym razie jedna krótka transakcja zapisuje `pending`, nowy `refresh_generation` i skrót refresh tokenu, który za chwilę wyśle. Commit jest przed siecią. Wywołanie Auth ma limit 8 sekund. Zapis nowej pary jest `UPDATE`, nie `INSERT`, i wymaga tej generacji, stanu `pending` oraz wieku poniżej 15 sekund.

Jedna reguła na każdy wynik. Starego refresh tokenu nie wysyła się drugi raz, gdy poprzednie wywołanie mogło już wykonać rotację. `supabase/config.toml` nie ustawia interwału ponownego użycia i projekt go nie zakłada. Nie ma stanu `closed`.

| Wynik | Wiersz | Tokeny w wierszu | Ponowienie refresh | To żądanie | Następne żądanie | Sprzątanie |
| --- | --- | --- | --- | --- | --- | --- |
| `pending` młodszy niż 15 sekund, inne żądanie | zostaje `pending` | zostają do rozstrzygnięcia wywołania | nie | 503 | jak w tym wierszu | nie tyka go |
| Pewna odmowa Auth w limicie czasu: token odrzucony albo wygasły, nowej pary nie ma | kasowany | brak | nie | 401 | 401, logowanie od nowa | nie ma czego kasować |
| Timeout albo brak odpowiedzi | `unknown`, tylko gdy generacja nadal jest `pending` | czyszczone tym samym zapisem | nie | 401 | 401, bez wywołania Auth | kasuje `unknown` |
| HTTP 5xx | `unknown`, ten sam warunek | czyszczone | nie | 401 | 401, bez wywołania Auth | kasuje `unknown` |
| Para po 15 sekundach | zapis pary ma zero wierszy; jeśli wiersz nadal jest `pending` z tą generacją, przechodzi w `unknown` | czyszczone albo już ich nie ma | nie | 401, para nie idzie do klienta | 401, bez wywołania Auth | kasuje `unknown` i `pending` starsze niż 15 sekund |

Timeout i HTTP 5xx są wynikiem nieznanym: nie wiadomo, czy Auth zdążył obrócić token. Pewna odmowa nim nie jest. Zapis `unknown` nie przechodzi, gdy wiersza nie ma albo stan nie jest już `pending`, więc nie nadpisuje logoutu ani nowszego logowania.

Gdy proces nadal ma nową parę w pamięci, a zapis jej nie przyjął, próbuje unieważnić ten nowy refresh token. Szczegół jest przy logoutcie. Gdy procesu już nie ma albo unieważnienie zostanie nieznane, para zostaje ważna po stronie Supabase. Nowe logowanie jej nie kasuje.

Poprawny zapis nowej pary, po którym spadnie tylko odpowiedź do przeglądarki, nie jest tym przypadkiem. Wiersz jest wtedy zgodny i kolejne żądanie używa nowego access tokenu.

## 7. Wyścig odświeżenia i wylogowania

Logout kasuje wiersz od razu, także w trakcie `pending`. Jeśli A zdąży zapisać parę, zanim B skasuje wiersz, `DELETE` i tak go usuwa. Końcowy stan to brak sesji.

Gdy A dostanie nową parę, a warunkowy zapis nie znajdzie wiersza, A nie robi `INSERT` i nie oddaje pary klientowi. W tym samym żądaniu próbuje unieważnić nowy refresh token, z limitem 8 sekund. Jawny sukces albo jawna odmowa kończy próbę. Wynik nieznany daje jedną ponowną próbę, też 8 sekund. Drugi wynik nieznany kończy próby. Token nie jest zapisywany do późniejszego unieważnienia, nie wraca do klienta i nie jest wysyłany ponownie jako refresh. Stary refresh token też nie jest wysyłany ponownie. Jeśli ta próba się nie uda, nowy refresh token zostaje ważny po stronie Supabase.

### Specyfikacja testu wyścigu

Testu jeszcze nie ma. Ma sprawdzić sam zapis, bez prawdziwego Supabase, przez podstawioną odpowiedź.

Przypadek skasowania w trakcie `pending`:

1. Żądanie A zapisuje `pending` i `refresh_generation`.
2. Żądanie B wykonuje logout i usuwa ten wiersz.
3. Podstawiona odpowiedź Supabase wraca do A z nową parą tokenów.
4. A wykonuje `UPDATE` nowej pary z warunkiem tej generacji, stanu `pending` i wieku poniżej 15 sekund.
5. Liczba zmienionych wierszy wynosi zero.
6. A nie wykonuje `INSERT`.
7. Odczyt sesji po obu żądaniach nie znajduje wiersza.

Przypadek odpowiedzi po czasie:

1. A zapisuje `pending` i generację.
2. Czas `refresh_started_at` jest starszy niż 15 sekund, zanim nadejdzie odpowiedź. W teście wolno przestawić znacznik czasu.
3. A wykonuje ten sam warunkowy `UPDATE`.
4. Liczba zmienionych wierszy wynosi zero i nie powstaje drugi wiersz.
5. Jeśli wiersz nadal jest `pending` z tą samą generacją, osobny `UPDATE` może ustawić `unknown` i wyczyścić tokeny. Jeśli logout zdążył wiersz usunąć, ten `UPDATE` też zmienia zero wierszy.
6. Spóźniona para nie wraca do tabeli i nie nadpisuje nowszego wiersza tej samej przeglądarki, gdy logout albo nowe logowanie zdążyło powstać pod innym identyfikatorem.

W obu przypadkach log i odpowiedź HTTP nie zawierają tokenów.

## 8. Wylogowanie

Express kasuje wiersz sesji, wygasza ciasteczko i woła unieważnienie refresh tokenu w Supabase tylko wtedy, gdy ten token został odczytany przed skasowaniem wiersza. Każde nowe żądanie szuka wiersza i bez niego dostaje 401.

Logout nie anuluje operacji, która już trwa. Nie przerywa rozpoczętej transakcji ani wywołania, które zdążyło przejść kontrolę sesji. Taka operacja może zakończyć się także zapisem danych. Sprawdzenie, że wiersz jeszcze istnieje, nie zamyka wyścigu: logout może usunąć go po sprawdzeniu, a przed commitem. Domknięcie tego wyścigu wymagałoby trzymania blokady wiersza sesji przez cały zapis biznesowy. Tego kosztu projekt nie przyjmuje i takiej gwarancji nie daje.

Tak samo przy wygaśnięciu. Żądanie, które na starcie zastało sesję ważną, może się dokończyć po upływie 30 minut albo 12 godzin, także zapisem. Nie wolno mu przedłużyć bezczynności poza 12 godzin ani rozpocząć nowej rotacji po terminie. Następne żądanie sesji już nie dostanie.

Access token skopiowany wcześniej działa do `exp`, jeżeli ktoś wywoła Express bezpośrednio. Tego okna ten projekt nie zamyka. Czasu `exp` nie ma w konfiguracji repozytorium.

## 9. Co liczy się jako odświeżenie

Próg 30 dotyczy wywołań Supabase na jedną sesję w oknie 15 minut. Licznik podnosi wyłącznie przejście wiersza do `pending`, czyli ta jedna rotacja, która zaraz wyśle refresh token.

Nie podnoszą licznika i nie wylogowują:

- żądanie, które używa access tokenu jeszcze ważnego i nie woła Supabase;
- równoległe żądanie, które zastaje `pending` młodsze niż 15 sekund i dostaje 503;
- odmowa wysłania starego refresh tokenu. Gdy stan jest już `unknown` albo `pending` przekroczył 15 sekund, sesja wymaga ponownego logowania z powodu wyniku nieznanego. Ten próg nie powstaje przez samą równoległość wewnątrz 15 sekund.

Trzydzieste pierwsze rzeczywiste wywołanie w oknie dostaje 429. Wiersz zostaje w stanie `ready`, tokeny zostają, użytkownik nie jest wylogowany. Po końcu okna kolejne odświeżenie znów może przejść do `pending`. Jeśli access token już wygasł, a próg jest osiągnięty, odpowiedź też jest 429, nie 401.

Ponowne wysłanie starego refresh tokenu nie jest drogą obsługi nadmiaru ani równoległości. Aplikacja nie wystawia refresh tokenu przeglądarce, więc klient nie ma czego użyć ponownie wobec Supabase.

## 10. Czasy

Sesja aplikacyjna, access token i refresh token to trzy osobne zegary.

Sesja aplikacyjna jest wierszem w PostgreSQL. Kończy ją 12 godzin od utworzenia albo 30 minut od ostatniej odpowiedzi 2xx, zależnie od tego, co wypadnie wcześniej. Dwanaście godzin zamyka porzucone ciasteczko w tym samym dniu pracy. Trzydzieści minut zamyka sesję przy odejściu od przeglądarki. Żaden z tych czasów nie przedłuża tokenu, którego Supabase już nie przyjmie.

Access token Supabase żyje do claimu `exp`. Tego `exp` nie ma w repozytorium ani w `supabase/config.toml`. Aplikacja używa tokenu, dopóki `exp` nie minął i sesja aplikacyjna trwa. Minął `exp` nie kasuje wiersza sesji. Kończy się tylko ten access token.

Refresh token Supabase żyje według reguł Auth. `supabase/config.toml` ich nie ustawia. Aplikacja nie traktuje go jako wiecznego i nie ustala mu własnego terminu. Gdy Auth go odrzuci, sesja aplikacyjna wymaga ponownego logowania. Stary refresh token nie jest wysyłany drugi raz.

| Licznik | Wartość | Zakres |
| --- | --- | --- |
| Bezwzględne życie sesji aplikacji | 12 godzin od utworzenia wiersza | tylko wiersz aplikacji |
| Bezczynność sesji aplikacji | 30 minut od ostatniej odpowiedzi 2xx | tylko wiersz aplikacji |
| Wyzwanie CSRF | 10 minut, bez przedłużania | formularz przed sesją; czas na wpisanie hasła |
| Wywołanie Supabase | 8 sekund | rotacja, unieważnienie i logowanie |
| `pending` | 15 sekund od `refresh_started_at` | dłużej niż wywołanie, żeby zdążyć zapisać odpowiedź |
| Liczniki logowania i bootstrapu | okno 15 minut | nie jest życiem sesji |
| Zdarzenia bezpieczeństwa | 30 dni | kody i skróty, bez haseł i tokenów |

Dziesięć minut wyzwania wystarcza na formularz i nie zostawia sekretu CSRF na długo. Piętnaście sekund `pending` jest dłuższe niż ośmiosekundowe wywołanie, więc poprawna, wolna odpowiedź jeszcze wchodzi do zapisu. Po piętnastu sekundach wynik jest nieznany i stary refresh token nie leci ponownie. Trzydzieści dni zdarzeń wystarcza do sprawdzenia nadużycia i nie trzyma ich bez końca.

Bezczynność przedłuża tylko odpowiedź 2xx obsłużona na sesji, która na starcie żądania była ważna. Dotyczy to odczytu, w tym listy zamówień, oraz odświeżenia, które zapisało nową parę. Nie przedłużają jej 401, 403, 429, 503, błędne hasło, odrzucone wyzwanie ani żądanie, które sesji nie znalazło. Równoległe 503 w trakcie `pending` też jej nie przedłuża.

Przedłużenie jest jednym `UPDATE`: nowy koniec bezczynności to wcześniejsza z wartości „teraz plus 30 minut” i „koniec 12 godzin”. Warunek wymaga, żeby oba terminy jeszcze nie minęły. Równoległe odpowiedzi piszą ten sam sufit. Żadna nie przesuwa sesji poza 12 godzin od utworzenia wiersza. Osobnego licznika aktywności nie ma.

Zdarzenie bezpieczeństwa to kod, czas i skróty identyfikatora sesji oraz adresu. Nie zawiera hasła, tokenu, ciasteczka ani surowego adresu IP.

Sprzątanie jest instrukcją `DELETE` z jawnym warunkiem czasu. Może ją wykonać dowolna instancja co 5 minut. Powtórzenie jest nieszkodliwe. Nie usuwa wiersza tylko dlatego, że access token ma minione `exp`.

- Sesja `ready` schodzi, gdy minęło 12 godzin albo 30 minut bezczynności. Wiersz `unknown` schodzi od razu. Wiersz `pending` schodzi dopiero po 15 sekundach. Młodszy `pending` zostaje.
- Wyzwanie schodzi, gdy minęło 10 minut. Niewygasłe zostaje.
- Okno licznika schodzi, gdy jest starsze niż 15 minut. Bieżące okno zostaje.
- Zdarzenie schodzi po 30 dniach.

Żądanie, które na starcie zastaje sesję po bezczynności albo po 12 godzinach, nie woła Supabase. Gdy wiersz nie jest młodym `pending`, kasuje go i zwraca 401. Dokończenie żądania rozpoczętego wcześniej opisuje sekcja o wylogowaniu. Zapis pary po terminie sesji nie przechodzi, bo wymaga obu terminów w przyszłości. Sprzątanie nie kasuje `pending` młodszego niż 15 sekund. Późniejsza para nie tworzy wiersza na nowo.

## 11. Uwierzytelnienie bez zapisu sesji

Nieudany `INSERT` nie unieważnia tokenów. Supabase mógł już przyjąć hasło i zwrócić access token oraz refresh token.

Gdy `INSERT` nie utworzy wiersza, Express nie ustawia ciasteczka sesji. Ciasteczko jest wysyłane dopiero po commicie wiersza. Hasło, access token, refresh token i treść odpowiedzi Auth nie wchodzą do logu, do JSON ani do komunikatu błędu. W pamięci procesu żyją tylko do końca tej obsługi.

Zaraz potem, w tym samym żądaniu, Express próbuje unieważnić otrzymany refresh token. Limit wywołania to 8 sekund. Jawny sukces albo jawna odmowa Auth kończy próbę. Wynik nieznany, czyli brak odpowiedzi, timeout, zerwanie albo odpowiedź 5xx, daje jedną ponowną próbę, też 8 sekund i też w tym samym żądaniu. Drugi wynik nieznany kończy próby. Tokenów nie zapisuje się po to, żeby unieważniać je później. Dalszego ponawiania nie ma.

Przeglądarka dostaje HTTP 503 i komunikat „Logowanie jest chwilowo niedostępne.” Bez ciasteczka sesji. Wyzwanie było zużyte, więc ponowne logowanie zaczyna się od nowego bootstrapu CSRF. Nowa sesja Auth nie kasuje pary, której aplikacja nie zapisała i której unieważnić się nie udało. Ta para zostaje ważna po stronie Supabase, dopóki dostawca sam jej nie wygaśnie albo nie unieważni.

Gdy `INSERT` się uda, a Nuxt nie ustawi ciasteczka, Nuxt woła skasowanie tego wiersza. Jeśli to kasowanie też padnie, wiersz wygasa najpóźniej po 30 minutach bezczynności albo po 12 godzinach. Przeglądarka nie dostała tokenów.

## 12. Limity

Publiczne logowanie i bootstrap CSRF nie powstają wcześniej niż limiter. W jednym wdrożeniu obie trasy są rejestrowane dopiero wtedy, gdy odczyt i zapis liczników działają. Test musi pokazać, że przy awarii limitera Supabase nie jest wołane.

Stan liczników jest w PostgreSQL, wspólny dla instancji. Klucze to skróty, bez adresu e-mail i bez IP w postaci jawnej.

| Licznik | Klucz | Próg projektu | Okno |
| --- | --- | --- | --- |
| Logowanie z jednego adresu | skrót IP i celu `login` | 30 | 15 minut |
| Logowanie pary adres i konto | skrót IP, znormalizowanego e-maila i celu `login` | 10 | 15 minut |
| Bootstrap CSRF | skrót IP i celu `csrf` | 60 | 15 minut |
| Odświeżenie jednej sesji | skrót identyfikatora sesji, tylko realne wywołanie Supabase | 30 | 15 minut |

Nie ma globalnej blokady samego e-maila. Taka blokada pozwoliłaby z jednego adresu odebrać logowanie właścicielowi będącemu gdzie indziej. Licznik pary podnosi się także wtedy, gdy konta nie ma, i zawsze przed wywołaniem Supabase.

Odpowiedzi:

- Błędne hasło i nieznane konto: HTTP 401, ten sam komunikat „Nie udało się zalogować.”
- Przekroczony próg IP albo pary: HTTP 429, ten sam komunikat „Spróbuj ponownie później.” Treść nie wskazuje, który licznik zadziałał.
- Odrzucone wyzwanie, origin albo referer: HTTP 403, komunikat „Formularz logowania wygasł.” Supabase nie jest wołane.
- Awaria bazy limitera albo zapis licznika się nie uda: HTTP 503, komunikat „Logowanie jest chwilowo niedostępne.” Hasło nie idzie dalej. Brak licznika nie oznacza zgody.

Udane logowanie kasuje licznik pary dla tego IP i e-maila. Licznik samego IP zostaje do końca okna. Stare okna są usuwane po czasie, nie trzymane w pamięci procesu.

## 13. CSRF po zalogowaniu

Logowanie, odświeżenie, wylogowanie i późniejsze operacje zmieniające dane wymagają ciasteczka sesji, zgodnego `X-CSRF-Token` i dokładnego `Origin`. Bez `Origin` wymagany jest `Referer` tego samego originu. Samo `SameSite=Lax` nie jest uznawane za kompletną ochronę. Odczyt panelu nie wymaga tokenu CSRF i nadal wymaga sesji oraz `requireAdmin`.

Token CSRF sesji zmienia się przy utworzeniu sesji i przy wylogowaniu. Nie zmienia się przy każdym odczycie.

## 14. CSP

Pomiar i egzekwowanie są rozdzielone. Pierwsza wdrożona polityka to `Content-Security-Policy-Report-Only`. Ma pokazać naruszenia, nie uciszyć ich przez `unsafe-inline` albo `unsafe-eval`.

Polityka pomiaru:

- `default-src 'self'`
- `base-uri 'none'`
- `object-src 'none'`
- `frame-ancestors 'none'`
- `form-action 'self'`
- `script-src 'self'`
- `script-src-attr 'none'`
- `style-src 'self'`
- `font-src 'self'`
- `img-src 'self'`
- `connect-src 'self'` oraz origin z publicznego `apiBase`

`connect-src` bez originu API zablokuje katalog, koszyk i checkout, bo `useApi()` woła Express z przeglądarki. W lokalnej konfiguracji ten origin to `http://localhost:3001`. Przeglądarka nie woła Supabase, więc jego adresu w `connect-src` nie ma.

`img-src` nie potrzebuje dziś obcego hosta. Zdjęć produktów i kategorii w odpowiedzi katalogu ani w szablonach nie ma. Gdy pojawią się pliki Storage, dyrektywa ma dostać konkretny host, nie `https:`.

`font-src 'self'` odpowiada obecnym plikom Poppins i PrimeIcons. Raport ma pokazać, czy bundler wstawi je jako `data:`. Dopiero wtedy rozważany jest `data:` dla fontów.

`script-src 'self'` zgłosi inline payload SSR Nuxt. To oczekiwany pomiar. Docelowe egzekwowanie używa nonce na żądanie, nie `unsafe-inline` i nie `unsafe-eval`. W kodzie aplikacji nie ma `eval`.

`style-src 'self'` zgłosi style, które Nuxt wstawia do HTML, oraz style dokładane przez PrimeVue 4.5.5. Konfiguracja nie wyłącza wbudowanego wstawiania stylów SSR i nie podaje `csp.nonce`, które dokumentacja PrimeVue 4 przewiduje dla dynamicznych elementów `style`. Komponenty panelu i sklepu mają bloki `<style scoped>`. Szablony nie używają atrybutu `style`, co nie znaczy, że wygenerowany HTML jest wolny od elementów `style`.

Docelowa polityka egzekwowana ma ten sam kształt, z nonce dla skryptów Nuxt i dla stylów Nuxt oraz PrimeVue. Nie wchodzi w życie razem z raportem. Wchodzi dopiero po przeglądzie naruszeń na katalogu, koszyku, checkoucie i `/admin/orders`. Do tego przeglądu nie wiadomo, czy nonce PrimeVue 4.5.5 obejmuje wszystkie wstawiane style. Włączenie egzekwowania wcześniej może zatrzymać wygląd panelu. To ograniczenie zostaje zapisane, a nie obchodzone przez `unsafe-inline`.

Trusted Types nie wchodzą do pomiaru ani do egzekwowania. PrimeVue 4 przy punktach przerwania paginacji przypisuje CSS przez `innerHTML`. Egzekwowanie Trusted Types zatrzymałoby ten kod. Własne szablony nie używają `v-html`. Nowe `v-html` i `innerHTML` w `apps/web` wymagają osobnej decyzji.

Moduł `nuxt-security` jest w katalogu Nuxt i obsługuje nonce, ale jego domyślny limiter jest w pamięci procesu, a domyślne CSP zostawia `unsafe-inline`. Pierwszy pomiar robi własny nagłówek, bez nowej zależności.

## 15. Kolejność wdrożenia

1. Tabele wyzwań, sesji i liczników. Brak publicznych tras.
2. Limiter w Expressie i testy awarii bazy. Nadal brak logowania. Test podmiany `X-Forwarded-For` oraz `X-Mshop-Client-Ip` bez zaufanego peera nie zmienia kubełka.
3. Bootstrap CSRF i logowanie w jednym wdrożeniu, oba za limiterem. Bez działającego limitera trasy nie są rejestrowane.
4. Odświeżenie ze stanem `pending` / `unknown`, zapis warunkowy po `refresh_generation` oraz wylogowanie. Test wyścigu nie odtwarza skasowanego wiersza.
5. Odczyt panelu zamówień przez Nuxt. Express nadal sprawdza Bearer, `requireAuth` i `requireAdmin`.
6. CSP Report-Only i przegląd naruszeń.
7. Przeniesienie tras konta klienta na tę samą sesję. Bez drugiego ciasteczka.
8. Przeniesienie `mark-paid` i `cancel`, gdy mają być wołane z panelu.
9. Egzekwowanie CSP albo nonce, po przeglądzie z punktu 6.

Punkt 10 roadmapy o ogólnym rate limitingu dotyczy innych tras. Nie zastępuje limitera logowania z punktu 2.

## 16. Czego ten projekt nie gwarantuje

- Pełnej atomowości między PostgreSQL a Supabase Auth.
- Unieważnienia refresh tokenu utraconego po rotacji albo po udanym haśle, którego sesji nie zapisano, gdy drugie wywołanie Auth też się nie uda.
- Unieważnienia już wydanego access tokenu przed `exp`, gdy Express jest osiągalny z internetu.
- Rozróżnienia użytkowników stojących za jednym NAT albo za jednym proxy, dopóki operator nie poda adresów tego proxy. Podanie złej listy albo włączenie zaufania do całego nagłówka cofa odporność na podmianę adresu.
- Ochrony przed użyciem zalogowanego BFF przez XSS na stronie Nuxt. `HttpOnly` zabrania odczytu ciasteczka, nie samego wywołania.
- Że `style-src` bez `unsafe-inline` przepuści PrimeVue 4.5.5, dopóki nonce nie zostanie zmierzone.
- Polityki rejestracji produkcyjnego projektu Supabase. Lokalne `enable_signup = true` nie jest tą polityką.

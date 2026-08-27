# Audyt kodu — runda 2 (mcp-atlassian / vaillant-mcp-atlassian)

**Data:** 26 sierpnia 2026
**Stan:** `main`, HEAD `c04b242`, drzewo robocze czyste
**Poprzedni audyt:** [`CODE-AUDIT.md`](./CODE-AUDIT.md) — wszystkie pięć pozycji jego planu §7 zostało zrealizowanych (patrz tam §8)
**Metoda:** cztery niezależne agenty audytowe (bezpieczeństwo / poprawność i odporność / warstwa MCP i polityka narzędzi / testy i dokumentacja), a następnie **osobny przebieg adwersarialny**, którego jedynym zadaniem było obalanie zgłoszonych znalezisk. Priorytetem był dowód empiryczny: uruchomiony serwer, atrapa Jiry/Confluence na loopbacku, pomiar — nie lektura.

---

## 1. Podsumowanie wykonawcze

Runda 2 nie znalazła luki krytycznej ani wysokiej. **Nie znaczy to, że nie znalazła nic** — poprzedni audyt zamknął listę na pięciu pozycjach porządkowych, ta otwiera osiemnaście, z czego sześć to realne defekty zachowania potwierdzone działającym repro, a nie uwagi stylistyczne.

Najważniejsza obserwacja nie jest jednak listą błędów, tylko wnioskiem o **metodzie testowania** (§6). Siedem defektów, które agenty znalazły niezależnie od siebie, to nie siedem przeoczeń — to cztery powtarzalne wzorce w sposobie pisania testów. Repo zawiera już wzorzec poprawny (`jiraAgileClient.test.ts` testuje serwer jako przeciwnika i to jedyny klient, który ma detekcję zepsutej paginacji); po prostu nie został przeniesiony na pozostałe klienty. To jest jedno działanie naprawcze o największej dźwigni w całym raporcie.

Warstwy, które poprzedni audyt chwalił, obroniły się pod ostrzejszym ostrzałem: egzekwowanie same-origin przeszło 18 wektorów ataku (userinfo, `//`, backslash, tab przed schematem, `%2e%2e`, CRLF) bez jednej ucieczki; PAT nie ma ścieżki do żadnego komunikatu widzianego przez model; bramkowanie narzędzi zweryfikowano empirycznie w 13 konfiguracjach środowiska i zgadza się co do sztuki; stdout niesie wyłącznie ramki JSON-RPC we wszystkich testowanych scenariuszach, łącznie z błędami i sygnałami.

**Przebieg adwersarialny zmienił obraz istotnie** i jest powodem, dla którego ten raport jest krótszy niż mógłby być. Z ośmiu tez poddanych obalaniu: dwie potwierdzono bez zmian, jedną obalono w całości, pięć zdegradowano — w tym trzy, które pierwotnie zgłoszono jako „wysokie". Zmierzone 784 ms na 64 KiB w `storageToPlainText` okazało się artefaktem korpusu syntetycznego (na realistycznej treści: 2–7 ms), rzekoma nieskończona pętla w changelogu ma trzy warunki wyjścia, których zgłaszający nie zauważył, a zarzut wobec dokumentacji o budżecie paginacji był po prostu nieprawdziwy — dokumentacja konsekwentnie zawęża go do Jira Agile. Przy okazji obalania powstały natomiast dwa nowe znaleziska, mocniejsze od tych, które zastąpiły (§5.6, §5.8).

Jedna rzecz wykracza poza kod i jest wymieniona osobno: **paczka w obecnej postaci nie da się zainstalować z gita** (§8.1).

---

## 2. Co zostało sprawdzone

| Obszar | Metoda | Wynik |
|---|---|---|
| `npm run build` (tsc --strict) | uruchomione | ✅ 0 błędów |
| `npm run lint` (ESLint 9) | uruchomione | ✅ 0 błędów, 72 ostrzeżenia (`no-explicit-any`) |
| `npm run test:unit` | uruchomione poza mountem FUSE | ✅ **146/146** |
| `npm run test:smoke` | uruchomione | ✅ wszystkie kontrole |
| Bramkowanie narzędzi | **empirycznie, 13 konfiguracji `tools/list`** | ✅ zgodne co do sztuki |
| Higiena stdout | empirycznie: błędne wejście, błąd sieci, zamknięcie stdin, SIGTERM/SIGINT | ✅ wyłącznie ramki JSON-RPC |
| Same-origin i przekierowania | **18 wektorów ataku, skrypt** | ✅ brak ucieczki |
| Wyciek PAT do modelu | prześledzone wszystkie ścieżki błąd → tekst | ✅ brak |
| Sekrety w historii git | `git log -p`, przeszukanie całej historii | ✅ brak |
| Nazwy narzędzi w dokumentacji | `comm` na listach z kodu i README | ✅ 54/54, zero rozbieżności w obie strony |
| Zmienne środowiskowe | twierdzenie po twierdzeniu vs `config.ts` | ✅ 15/15, wartości domyślne zgodne |

---

## 3. Status poprzedniego audytu

Wszystkie pozycje planu §7 są zamknięte i zweryfikowane niezależnie w tej rundzie: `attachmentSecurity.ts` jest jedynym miejscem z logiką ochrony załączników, ESLint działa i jest spięty z `npm test`, `npm audit` daje zero podatności, dokumentacja separatora i trybu read-only jest poprawna.

**Jedna ocena z poprzedniego audytu wymaga korekty.** §6 stwierdzał, że regexy w `storageToPlainText` „nie mają zagnieżdżonych kwantyfikatorów dających katastrofalny backtracking" i że to „koszt CPU, nie luka". Pierwsza część jest formalnie prawdziwa, ale niepełna: dwa **sekwencyjne** leniwe kwantyfikatory w jednym wzorcu dają zachowanie sześcienne bez żadnego zagnieżdżenia. Skala jest jednak znacznie mniejsza, niż sugerowały pierwsze pomiary — i, co ważniejsze, prawdziwym problemem tego wzorca okazała się **cicha utrata treści**, a nie wydajność (§5.8).

**Załącznik A poprzedniego audytu jest nieaktualny** i wprowadza w błąd: mówi o 54 narzędziach i 5 destrukcyjnych, podczas gdy destrukcyjnych jest 6, a liczności grup się nie zgadzają (core 11, nie 9; files 6, nie 5). Poprawna mapa jest w Załączniku A tego dokumentu. README jest natomiast **poprawny** — liczby 48/39/30/54 zgadzają się z pomiarem.

---

## 4. Znaleziska — przegląd

Wagi poniżej są **po** przebiegu adwersarialnym. Gdzie różnią się od zgłoszonych pierwotnie, zaznaczono to wprost.

| # | Znalezisko | Waga | Dowód |
|---|---|---|---|
| 5.1 | `maxResponseBytes` ignorowane na ścieżce JSON — 52 z 54 narzędzi buforuje bez limitu | średnia | pomiar: 24 MiB body → 48 MiB heap |
| 5.2 | Brak limitu rozmiaru wyniku narzędzia oddawanego modelowi | średnia | pomiar: 350 kB / ~88 tys. tokenów z jednego `jira_get_issue` |
| 5.3 | `update` bez żadnego pola wykonuje realny PUT i podbija wersję strony | średnia | zarejestrowane żądanie PUT, wersja 7 → 8 |
| 5.4 | Pusty łańcuch w środowisku nie nadpisuje `ATLASSIAN_ATTACHMENT_DIRS` z pliku `.env` | średnia | `loadConfig` zwraca katalog z pliku |
| 5.5 | FIFO w katalogu allowlisty wiesza `open()` i wyczerpuje pulę wątków libuv | średnia *(zgłoszone jako wysoka)* | pomiar: 4 wywołania → całe I/O procesu martwe |
| 5.6 | `destructiveHint: false` na narzędziach nadpisujących treść — fałszywy negatyw w kierunku niebezpiecznym | średnia | nowe, z przebiegu adwersarialnego |
| 5.7 | Pięć ścieżek zwraca surowy `TypeError` zamiast błędu domenowego | średnia | repro end-to-end, 5/5 |
| 5.8 | `storageToPlainText` łączy niepowiązane elementy przez pół dokumentu — cicha utrata treści | średnia | nowe, z przebiegu adwersarialnego |
| 5.9 | Paginacja Confluence: brak detekcji powtórzonej strony, cicha truncacja | niska | pomiar: 300 zwróconych, 100 unikalnych, zero ostrzeżeń |
| 5.10 | Hardlink omija allowlistę przy uploadzie | niska | repro: odczytany plik spoza allowlisty |
| 5.11 | Zagnieżdżony fan-out ProForma: 25 slotów przy pojemności 20 | niska *(zgłoszone jako wysoka)* | repro; przypadek skrajny |
| 5.12 | Pętla changelogu bez wyjścia, gdy odpowiedź nie zawiera `total` | niska *(zgłoszone jako pętla nieskończona)* | repro; 3 warunki wyjścia istnieją |
| 5.13 | Braki w sufitach schematów zod i walidacji formatu identyfikatorów | niska | analiza `tools/list` |
| 5.14 | `JSON.stringify(x, null, 2)` w 54/54 handlerach — +29% bajtów | niska | pomiar: 52 872 B vs 40 871 B |
| 5.15 | Uszkodzona ramka na stdin połykana bez śladu | niska | empirycznie: brak `-32700`, nic na stderr |
| 5.16 | Brak handlerów SIGTERM/SIGINT — częściowy plik blokuje ponowienie przez `O_EXCL` | niska | empirycznie |
| 5.17 | Drobiazgi odporności: retry maskujący pierwotny błąd, nieanulowane ciało odpowiedzi, brak deduplikacji cache w locie | niska | lektura + pomiar |
| 5.18 | Stratny round-trip `get_page` → `update_page`, nieostrzeżony w opisie narzędzia | średnia | analiza kontraktu |

### Obalone lub istotnie zdegradowane w przebiegu adwersarialnym

- **`idempotentHint: false` na narzędziach idempotentnych** — obalone. Specyfikacja MCP definiuje `false` jako wartość domyślną tego pola; mechaniczne wyprowadzenie z `kind` daje konserwatywny fałszywy negatyw, czyli klient jest ostrożniejszy, niż musi. Kierunek niebezpieczny nie występuje. *(Ale patrz 5.6 — dla `destructiveHint` jest odwrotnie.)*
- **„Dokumentacja kłamie o budżecie paginacji"** — obalone. README (`:88`, `:183`), `SECURITY-ARCHITECTURE.md:70` i `IMPLEMENTATION-REPORT.md:269` konsekwentnie zawężają `ATLASSIAN_MAX_PAGINATION_PAGES` do Jira Agile. Fakt (budżet trafia tylko do `JiraAgileClient`) jest prawdziwy, zarzut wobec dokumentacji — nie.
- **`storageToPlainText`: „minuty przy 500 kB"** — zdegradowane. Na korpusie przypominającym prawdziwą stronę DC: 2–7 ms przy 50–100 KiB, ekstrapolacja ~0,4 s przy 400 KiB. Pierwotne 784 ms na 64 KiB wymagało treści zbudowanej wyłącznie z gęsto upakowanych tokenów `<ac:link>` bez wypełniacza. Confluence waliduje storage format przy zapisie, więc niedomknięty `<ac:link>` z `expand=body.storage` nie przyjdzie.
- **ProForma 25 > 20** — zdegradowane do niskiej. Wymaga jednocześnie ≥5 formularzy na jednym issue **i** ≥6 chunków w każdym (≈200 kB projektu formularza — setki pytań). Przy 5 chunkach: 5 × 4 = 20, dokładnie pojemność, bez błędu. Skutek to czytelny błąd, nie zawieszenie ani utrata danych.
- **FIFO** — zdegradowane do średniej. `ATLASSIAN_ATTACHMENT_DIRS` jest **domyślnie puste**, a `assertAttachmentPathAllowed` rzuca „Attachment access is disabled" przed jakimkolwiek `open()`. Scenariusz wymaga łącznie: jawnej konfiguracji katalogu przez operatora, prawa zapisu atakującego do tego katalogu i czterech wywołań.

---

## 5. Znaleziska — szczegóły

### 5.1 [Średnia] `maxResponseBytes` nie działa dla żadnej odpowiedzi JSON

**Gdzie:** `src/httpClient.ts:357` (`decodeJson`), w kontraście do `:399-463` (`atlassianGetBinary`)

`RequestOptions.maxResponseBytes` (`httpClient.ts:31`) jest udokumentowane jako limit odpowiedzi, ale honoruje je **wyłącznie** `atlassianGetBinary`. `atlassianGet`, `atlassianWrite`, `atlassianPostFormData` i `atlassianDelete` przechodzą przez `decodeJson`, które robi `await response.text()` bez licznika bajtów i bez sprawdzenia `Content-Length`. Limit przekazany do `atlassianGet` jest po cichu ignorowany.

**Zmierzone:** `maxResponseBytes: 1024`, odpowiedź 24 MiB → zbuforowane 25 165 824 bajty, przyrost sterty 48 MiB.

Szczególnie mylące jest to, że suita `httpClient.test.ts:749-796` („bounded binary response streaming", cztery testy) wygląda na komplet — i sprawia, że recenzent nie pyta o ścieżkę JSON, czyli o 52 z 54 narzędzi.

**Rekomendacja:** ta sama pętla czytnika co w `atlassianGetBinary`, z osobnym progiem (`ATLASSIAN_MAX_JSON_BYTES`, domyślnie kilkanaście MB), albo minimum: twarde odrzucenie zadeklarowanego `Content-Length` powyżej progu.

### 5.2 [Średnia] Brak jakiegokolwiek limitu rozmiaru wyniku narzędzia

Zmierzone na serwerze uruchomionym przeciwko atrapie na loopbacku, `result.content[0].text`:

| wywołanie | bajty | ~tokeny |
|---|---|---|
| `jira_get_issue` (opis 200 kB + 3 komentarze) | 350 468 | ~88 000 |
| `confluence_get_page` (strona 224 kB) | 224 105 | ~56 000 |
| `jira_list_projects` (400 projektów) | 52 872 | ~13 200 |

Żadnego obcięcia, żadnego ostrzeżenia, `isError: false`. To jest szersze niż 5.1: nawet po zmapowaniu do struktury wyjściowej nic nie ogranicza tekstu oddawanego modelowi.

Trzy wzmacniacze:
- **`jira_get_issue`** — `maxComments` ma sufit 200, ale treść pojedynczego komentarza i `description` są nieograniczone. Sufit na liczbę elementów bez sufitu na rozmiar elementu nie chroni przed niczym.
- **`jira_get_issue_fields`** bez `fieldNames` (`src/jiraClient.ts:625`) zwraca **każde niepuste pole**, a `value: issue.fields[field.id]` to surowa struktura Atlassiana z `self`, `avatarUrls`, `iconUrl`. Na instancji DC z kilkuset polami własnymi jedno wywołanie może zająć całe okno kontekstu. Opis nie sygnalizuje, że pominięcie parametru oznacza „wszystko".
- **`jira_list_projects`** (`src/jiraClient.ts:560`) — jedyne narzędzie listujące **bez parametru `limit`**. Model nie ma sposobu, by zmniejszyć odpowiedź.

**Rekomendacja:** wspólny `clampToolText(text, maxBytes)` na wyjściu każdego handlera w `index.ts`, z jawnym markerem obcięcia i konfiguracją `ATLASSIAN_MAX_TOOL_RESULT_BYTES` (100–150 kB). Dodatkowo `limit` w `jira_list_projects` i domyślna whitelist w `getIssueFields`.

### 5.3 [Średnia] `update` bez żadnego pola wykonuje realny PUT

**Gdzie:** `src/index.ts:1707-1727` + `src/confluenceClient.ts:493-528`; analogicznie `src/index.ts` (jira_update_issue) + `src/jiraClient.ts:896-919`

Oba pola treści są `.optional()`, schemat nie ma `.refine()`, handler nie sprawdza pustego wejścia. `updatePage` liczy `nextVersion = (current.version?.number ?? 1) + 1` i bezwarunkowo wysyła PUT.

**Zarejestrowane żądanie** (atrapa Confluence, prawdziwy klient, `updatePage('123456', {})`):

```
GET /rest/api/content/123456
PUT /rest/api/content/123456 | {"id":"123456","title":"Oryginalny tytul",…,"version":{"number":8}}
```

Wersja 7 → 8 przy zerowej zmianie treści. Nic nie ginie, ale historia strony jest zaśmiecona, powiadomienia obserwujących idą, autorstwo przypisane do właściciela PAT-a, a agent dostaje „sukces" za operację, która niczego nie zmieniła. `JiraClient.updateIssue('ABC-1', {})` wysyła analogicznie `PUT {"fields":{}}` — Jira odpowiada nieczytelnym 400, z którego nie wynika, że po prostu nie podano żadnego pola.

**Rekomendacja:** `.refine()` na obu schematach, egzekwowane przed jakimkolwiek wywołaniem HTTP. Zod zwróci `-32602` z czytelnym tekstem zamiast mutować stronę.

### 5.4 [Średnia] Pusty łańcuch w środowisku nie nadpisuje wartości z `.env`

**Gdzie:** `src/config.ts:113` — `if (process.env[key] === undefined || process.env[key] === "") { process.env[key] = value; }`

Komentarz doc na `config.ts:68-69` obiecuje: *„Values already present in the real environment always win, so a wrapper script or CI can still override the file."* Pusty łańcuch **jest** obecny w prawdziwym środowisku i nie wygrywa.

**Zmierzone:** `.env` z `ATLASSIAN_ATTACHMENT_DIRS=/srv/attachments`, środowisko z `ATLASSIAN_ATTACHMENT_DIRS=""` → `loadConfig()` zwraca `["/srv/attachments"]`.

Operator wyłączający dostęp do plików przez `Environment="ATLASSIAN_ATTACHMENT_DIRS="` w systemd, `-e ATLASSIAN_ATTACHMENT_DIRS=` w Dockerze albo `value: ""` w k8s dostaje narzędzia załącznikowe **włączone**, wskazujące na katalog z pliku. Pusty łańcuch to kanoniczny sposób wyrażenia „wyłączone" dla tej zmiennej — `parseAttachmentDirs("")` zwraca `[]`.

Zakres jest węższy niż mogłoby się wydawać: dla `ATLASSIAN_PROFILE` i `ATLASSIAN_READ_ONLY` skutek jest zerowy (puste i tak daje wartość domyślną). `ATLASSIAN_ATTACHMENT_DIRS` to jedyna zmienna, gdzie pusty łańcuch niesie znaczenie odwrotne do wartości z pliku — i akurat ta wyznacza granicę bezpieczeństwa.

**Rekomendacja:** warunek tylko `=== undefined`; puste traktować jako świadomy override.

### 5.5 [Średnia] FIFO w katalogu allowlisty wiesza pulę wątków libuv

**Gdzie:** `src/attachmentSecurity.ts:146` → `:150`

`readExistingAttachment` woła `open(safeFilePath, O_RDONLY | O_NOFOLLOW)` **przed** `handle.stat()` i sprawdzeniem `isFile()`. `O_NOFOLLOW` blokuje dowiązania symboliczne, ale nie FIFO ani urządzeń; `open(O_RDONLY)` na FIFO bez pisarza blokuje się w jądrze bezterminowo. Jedyna kontrola, która by to wychwyciła, jest za `open()`. Wcześniejsza walidacja ścieżki używa `lstat` i `realpath` — obie na FIFO wracają natychmiast.

**Zmierzone:** jedno wywołanie wisi bezterminowo (`process.exit(0)` nie kończy procesu — wymaga `SIGKILL`); **cztery** wywołania (domyślne `UV_THREADPOOL_SIZE=4`) sprawiają, że niezwiązany `fs.readFile` na normalnym pliku też nigdy nie wraca. To śmierć całego I/O procesu, nie degradacja jednego narzędzia. Żaden timeout tego nie przerwie — `ATLASSIAN_TIMEOUT_MS` dotyczy wyłącznie `fetch`.

**Warunki wstępne (powód degradacji z wysokiej):** operator musiał jawnie ustawić `ATLASSIAN_ATTACHMENT_DIRS` (domyślnie puste — `config.ts:230`, `.env.example:36`), atakujący musi mieć prawo zapisu do tego katalogu, agent musi zostać nakłoniony do czterech uploadów. To nie jest ekspozycja domyślna.

**Rekomendacja:** `lstat` z odrzuceniem wszystkiego poza `isFile()` **przed** `open()`, oraz `open()` z `O_NONBLOCK` (na FIFO bez pisarza wraca natychmiast, na zwykłym pliku nieszkodliwe) — zachowując `isFile()` po `open()` jako punkt anty-TOCTOU. Kilkanaście linii.

### 5.6 [Średnia] `destructiveHint: false` na narzędziach nadpisujących treść

**Gdzie:** `src/index.ts:143-150`

Adnotacje są wyprowadzane mechanicznie z `kind`: `destructiveHint: kind === "destructive"`. Dla `confluence_update_page` i `jira_update_issue` daje to **`false`**, podczas gdy specyfikacja MCP przyjmuje dla tego pola wartość domyślną **`true`** — i te narzędzia faktycznie nadpisują treść strony i pola issue bez scalania.

To jest fałszywy negatyw **w kierunku niebezpiecznym**: klient budujący UX zgody na adnotacjach pokaże nadpisanie strony wiki jako operację nie-destrukcyjną. Odwrotny przypadek (`idempotentHint`) jest nieszkodliwy, bo tam mechaniczne uproszczenie daje wartość ostrożniejszą niż rzeczywistość. Tutaj daje mniej ostrożną.

Powiązane, bez dzisiejszego skutku: `...spec.annotations` (`index.ts:144`) jest bezwarunkowo nadpisywane przez cztery pola poniżej. Żadne z 54 wywołań `tool()` nie przekazuje dziś `annotations`, więc nic się nie psuje — ale pierwsza próba nadpisania podpowiedzi per-narzędzie zawiedzie po cichu.

**Rekomendacja:** odwrócić kolejność spreadu, żeby jawna adnotacja wygrywała z wyliczoną, i ustawić `destructiveHint: true` na narzędziach nadpisujących.

### 5.7 [Średnia] Pięć ścieżek zwraca surowy `TypeError` zamiast błędu domenowego

**Gdzie:** `src/proforma.ts:30, 39, 75`; `src/jiraClient.ts:661, 855, 629`

Potwierdzone end-to-end przez prawdziwego klienta i serwer HTTP:

```
listProformaForms, value=null           : TypeError: Cannot read properties of null (reading 'forms')
getProformaForm, property value=null    : TypeError: Cannot read properties of null (reading 'rawData')
getProformaForm, answers.q1=null        : TypeError: Cannot read properties of null (reading 'text')
getIssueProperty, puste ciało 200       : TypeError: Cannot read properties of undefined (reading 'value')
getIssueFields, /rest/api/2/field → {}  : TypeError: definitions.filter is not a function
```

Realne wyzwalacze: Jira DC zwraca `{"key":"…","value":null}` dla właściwości wyczyszczonej, ale nieusuniętej; ProForma zapisuje `null` dla skasowanego pola formularza; pusta odpowiedź 200 przy reverse proxy albo timeoucie po stronie DC.

To serwer MCP — model dostaje `Cannot read properties of null (reading 'text')` bez nazwy issue, klucza właściwości ani formularza, więc nie ma z czego wywnioskować ani przyczyny, ani obejścia. Kontrast z resztą repo jest wyraźny: `jiraAgileClient.getPaginatedValues` rzuca precyzyjne błędy domenowe, a `proforma.ts` ma świetne komunikaty dla własnych niezmienników — brakuje wyłącznie bramki wejściowej.

Ciche absurdy z tej samej rodziny: `formatProformaAnswer("plain", {})` → `"p | l | a | i | n"` (string potraktowany jako obiekt przez `Object.entries`).

**Rekomendacja:** strażnik typu na wejściu każdej z tych funkcji, ~15 linii. Zamienia pięć nieczytelnych awarii w pięć błędów, na które model potrafi zareagować.

### 5.8 [Średnia] `storageToPlainText` cicho traci treść

**Gdzie:** `src/confluenceClient.ts:133-137`

Wzorzec `<ac:link[^>]*>[\s\S]*?<ri:page[^>]*ri:content-title="([^"]*)"[^>]*\/>[\s\S]*?<\/ac:link>` ma dwa sekwencyjne leniwe kwantyfikatory. Przy w pełni poprawnym storage formacie — wzmianki `<ac:link><ri:user/></ac:link>` (bez `<ri:page>` w środku) współistniejące z gołymi `<ri:page ri:content-title="…"/>` w parametrach makr `children`, `excerpt-include`, `pagetree` — regex **łączy start jednego elementu z `<ri:page>` położonym znacznie dalej i zjada całą treść pomiędzy**.

To jest poważniejsze niż koszt CPU, bo jest ciche: użytkownik dostaje treść strony z wyciętym fragmentem i nie ma jak tego zauważyć.

Koszt wydajnościowy tego samego wzorca jest realny, ale umiarkowany — zmierzone na tym korpusie: 20 KiB → 1 ms, 50 KiB → 2 ms, 100 KiB → 7 ms, 200 KiB → 51 ms (wykładnik ≈ 2,9). Ekstrapolacja: 400 KiB ≈ 0,4 s, 800 KiB ≈ 2,7 s. Node jest jednowątkowy, więc przez ten czas stoi cały serwer MCP — ale to sekundy w skrajności, nie minuty.

**Rekomendacja:** porzucić regexy na rzecz strumieniowego parsera XHTML (`htmlparser2`, `sax`) — storage format to XHTML, a nie język regularny. Minimum doraźne: dopasowanie nierekurencyjne z ograniczeniem zasięgu, np. `[^<]*(?:<(?!\/ac:link>)[^<]*)*` zamiast pierwszego `[\s\S]*?`. Ten sam wzorzec w mniejszej skali ma regex `<a…href>` (`:137-144`).

### 5.18 [Średnia] Stratny round-trip `get_page` → `update_page`

**Gdzie:** `src/confluenceClient.ts:265` (`getPage` zwraca `storageToPlainText`), `src/index.ts:1708` (opis `confluence_update_page`)

Użytkownik prosi „popraw literówkę na stronie X". Model woła `confluence_get_page` i dostaje **czysty tekst** — bez makr, tabel, layoutów, osadzonych obrazków. Poprawia jedno słowo, oddaje do `confluence_update_page`, `toStorageValue` opakowuje to w `<p>` — cała struktura strony znika, a operacja raportuje sukces.

Żaden z dwóch opisów nie mówi modelowi, że wyjście `get_page` nie nadaje się na wejście `update_page`. W połączeniu z 5.6 (`destructiveHint: false`) klient nie ma też podstaw, by poprosić użytkownika o potwierdzenie.

**Rekomendacja:** minimum — jedno zdanie w opisie `confluence_update_page`: „Nie przekazuj tu wyniku `confluence_get_page`; to konwersja stratna, nadpisanie usunie makra i tabele." Docelowo — zwracać surowy storage obok czystego tekstu (za flagą) albo dodać narzędzie edycji punktowej.

### 5.9–5.17 [Niskie] — skrótowo

- **5.9 Paginacja Confluence** (`confluenceClient.ts:288, 346, 533`) — brak detekcji powtórzonej strony i cicha truncacja. Zmierzone: serwer ignorujący `start` (cache'ujące proxy, klaster DC bez sticky sessions) → **300 zwróconych rekordów, 100 unikalnych, zero ostrzeżeń**. `jiraAgileClient.getPaginatedValues:190-202` robi dokładnie to zabezpieczenie i rzuca błąd. Ta sama klasa ryzyka, dwa standardy w jednym repo. Nieskończonej pętli tu nie ma — `while (x.length < limit)` przy suficie zod 500 daje maksymalnie ~5 żądań. Osobno: `searchPages` zwraca `nextStart`, pozostałe trzy pętle nie mają odpowiednika, więc model nie wie, że lista jest niepełna.
- **5.10 Hardlink omija allowlistę** (`attachmentSecurity.ts:141-159`) — `realpath` + `O_NOFOLLOW` zamykają symlinki, ale hardlink to ten sam i-węzeł pod dwiema nazwami. Repro: odczytany plik spoza allowlisty. Wymaga prawa zapisu do katalogu allowlisty i odczytu pliku źródłowego (`fs.protected_hardlinks=1`). Naprawa: `metadata.nlink > 1` → odmowa.
- **5.11 Fan-out ProForma** (`jiraClient.ts:719-722`) — 5 formularzy × 5 chunków = 25 slotów przy pojemności 4 + 16 = 20. Wymaga ≥5 formularzy po ≥6 chunków; przy 5 chunkach mieści się dokładnie. Skutek to czytelny błąd „queue is full", nie zawieszenie — ale komunikat radzi „ogranicz równoległe wywołania narzędzi", gdy wywołanie było jedno. Przy okazji **N+1**: każdy `getProformaForm` ponownie pobiera cały indeks `proforma.forms` (zmierzone: 6 pobrań indeksu dla 5 formularzy), mimo że wywołujący już go ma.
- **5.12 Pętla changelogu** (`jiraClient.ts:1225-1241`) — ma trzy warunki wyjścia (`isLast`, pusta strona, `startAt >= page.total`) i przy serwerze ignorującym `startAt` kończy się poprawnie. Luka jest węższa: odpowiedź **bez `total`** i bez `isLast:true` daje pętlę nieskończoną (`startAt >= undefined` to `false`). Zmierzone: 3 463 żądania w 6 s, RSS 170 MB. Wymaga nieprawidłowo zachowującego się DC.
- **5.13 Schematy zod** — trzy luki w skądinąd konsekwentnych sufitach: `jira_update_issue.labels` to jedyna tablica bez `maxItems`; `jira_search_issues.startAt` i `confluence_search_pages.start` mają `.min(0)` bez górnej granicy. Osobno: **88 parametrów typu string bez `pattern`, `minLength` i `maxLength`** (`issueKey` w 23 narzędziach, `pageId` w 9). To nie jest path traversal — `encodeURIComponent` pokrywa wszystkie interpolacje — tylko koszt tokenów: `jira_get_issue({issueKey: "https://jira/browse/ABC-123"})` przechodzi walidację, leci do Jiry, wraca 404. `.regex(/^[A-Z][A-Z0-9_]*-\d+$/)` odrzuciłby to lokalnie z instrukcją naprawy.
- **5.14 `JSON.stringify(x, null, 2)` w 54/54 handlerach** — zmierzone na 400 projektach: 52 872 B pretty vs 40 871 B compact, **+29%** w każdej odpowiedzi każdego narzędzia. Wcięcia nie niosą informacji dla modelu.
- **5.15 Uszkodzona ramka na stdin** — empirycznie: serwer nie emituje `-32700`, nic nie trafia na stderr, proces żyje dalej, klient czeka do własnego timeoutu. To zachowanie SDK (`ReadBuffer` woła `onerror`, którego nikt nie ustawił), ale naprawia się jedną linią: `transport.onerror = …` przed `server.connect()`.
- **5.16 Brak handlerów sygnałów** — `grep 'process.on(' src/*.ts` nie daje trafień. Konkretny skutek: zabicie procesu w trakcie `jira_download_attachment` zostawia częściowy plik, a `O_CREAT|O_EXCL` sprawia, że **ponowne pobranie do tej samej ścieżki kończy się „already exists"** — komunikat, z którego nie wynika, że na dysku leży ucięty plik.
- **5.17 Drobiazgi odporności** — (a) retry po 429 zajmuje slot ponownie i może odbić się od `maxQueuedRequests`, gubiąc `lastError`, przez co wywołujący widzi „queue is full" zamiast pierwotnego 429 (`httpClient.ts:277`); (b) przy odrzuconym przekierowaniu cross-origin `response.body` nie jest anulowane, w przeciwieństwie do sąsiednich ścieżek (`httpClient.ts:234-239`); (c) cache `fieldDefinitions` nie deduplikuje żądań w locie — N równoległych wywołań na zimnym cache'u pobiera `/rest/api/2/field` N razy; zatrucia cache'u przy błędzie **nie ma**, to zrobione dobrze (`jiraClient.ts:440-452`).
- **Informacyjnie:** `ATLASSIAN_TOTAL_TIMEOUT_MS` jest budżetem **na żądanie HTTP**, nie na wywołanie narzędzia (`httpClient.ts:273`). Pętla paginacyjna może legalnie zająć 10 × 45 s. To nie błąd, tylko inny zakres, niż sugeruje nazwa — warto doprecyzować w README.

---

## 6. Dlaczego testy tego nie złapały

To jest najważniejsza sekcja tego raportu. Siedem defektów wyżej to nie siedem niezależnych przeoczeń — to **cztery powtarzalne wzorce** w metodzie testowania. Repo zawiera już wzorzec poprawny; nie został przeniesiony.

### Wzorzec A — mock jest kontraktem, nie przeciwnikiem

Każdy stub HTTP poza `jiraAgileClient.test.ts` zwraca wyłącznie odpowiedź dobrze uformowaną:

| plik:linia | co zwraca mock | czego nigdy nie zwraca |
|---|---|---|
| `jiraClient.test.ts:234, 258, 262, 270` | `{ value: { forms: [...] } }` | `{}`, pusty body, `{value: null}` |
| `jiraClient.test.ts:157, 176, 215` | `{ content: "/download/1", size: 4 }` | brak `content`, `size: null` |
| `confluenceClient.test.ts:117, 139, 165, 187` | `results[0].extensions.fileSize` + `_links.download` | `results: []`, brak `extensions` |

Skutek: **defekt 5.7 nie ma fizycznej możliwości upaść w tym zestawie testów.**

Kluczowa obserwacja: `jiraAgileClient.test.ts:145-196` **testuje serwer jako przeciwnika** — powtórzoną stronę, brak metadanych, `values: "invalid"`, `total: -1`, pustą stronę nie-końcową. I to jest dokładnie jedyny klient, który ma detekcję powtórzonej strony. Korelacja nie jest przypadkowa: 5.9 istnieje dlatego, że wrogi mock nie został skopiowany, a nie dlatego, że nikt o tym nie pomyślał.

### Wzorzec B — testowany jest szczęśliwy typ pliku i szczęśliwy rozmiar wejścia

`attachmentSecurity.test.ts:257` — test „rejects a path that is not a regular file" używa **katalogu**. Na Linuksie `open(dir, O_RDONLY)` wraca natychmiast, więc kolejność „najpierw `open()`, potem `isFile()`" wygląda poprawnie. FIFO, gniazdo unixowe ani device node nie występują w żadnym fixture — a to jedyne typy, dla których ta kolejność ma znaczenie. Siedem testów symlinków, zero testów innych typów plików. Jeden `mkfifo` w fixture złapałby 5.5.

Ten sam wzorzec dla treści: `storageToPlainText` testowany jest na **siedmiu stringach krótszych niż 120 znaków** (`confluenceClient.test.ts:39-77`). Zarówno złożoność, jak i błędne parowanie elementów (5.8) są przy takim wejściu strukturalnie niewidoczne.

### Wzorzec C — limit jest testowany tam, gdzie jest zaimplementowany, a nie tam, gdzie jest potrzebny

`httpClient.test.ts:749-796`, suite „bounded binary response streaming": cztery testy, wygląda na komplet. Wszystkie cztery przechodzą przez `atlassianGetBinary`. **Ani jeden nie sprawdza, czy ścieżka JSON respektuje jakikolwiek limit** — a to 52 z 54 narzędzi. Pozorna kompletność tego suite'u jest aktywnie szkodliwa: recenzent widzi „bounded response streaming ✓" i nie pyta dalej.

### Wzorzec D — komponent testowany przy własnej konfiguracji, nigdy przy produkcyjnej

`jiraClient.test.ts:243` sprawdza `peak <= 5` dla **jednego** formularza. `getProformaFormsSummary`, które mnoży ten fan-out przez liczbę formularzy, nie ma żadnego testu. Test nie kłamie o tym, co mierzy — mierzy komponent w izolacji, a defekt powstaje z **iloczynu dwóch poprawnych limitów**. Granica (5 formularzy × 5 chunków = dokładnie pojemność) nie jest nigdzie asertowana, więc defekt jest o jeden chunk od produkcji.

### Co konkretnie zmienić

1. **Przenieść `withAgileServer` z `jiraAgileClient.test.ts` do wspólnego helpera** i użyć w `confluenceClient.test.ts` i `jiraClient.test.ts`. Dziś `withStubServer` jest zdefiniowany trzykrotnie: dwie wersje ubogie (bez rejestracji żądań, bez skryptowanych sekwencji) i jedna bogata w `httpClient.test.ts`. To, że dwa klienty dostały uboższy helper, jest **bezpośrednią przyczyną wzorca A** — nie da się w nim wygodnie zwrócić sekwencji zniekształconych odpowiedzi, więc nikt tego nie zrobił. (~4 h)
2. **Dla każdego klienta jeden test „upstream zwraca śmieci"**, parametryzowany po zestawie: `""`, `{}`, `{value: null}`, `{results: null}`, `{total: 5, results: []}`, `<html>login</html>` z kodem 200. Oczekiwanie: błąd domenowy z nazwą pola, nigdy `TypeError`. (~4 h, łapie 5.7 i 5.9)
3. **Fixture'y typów plików, nie tylko ścieżek**: FIFO, katalog, gniazdo, hardlink poza allowlistę. (~2 h, łapie 5.5 i 5.10)
4. **Test budżetu na poziomie operacji, nie komponentu** — asertować, że operacje z zagnieżdżonym fan-outem działają przy domyślnym `configureHttp(4, 16)`, nie przy konfiguracji dobranej pod test. (~2 h, łapie 5.11)
5. **`--experimental-test-coverage`** w bramce. Pokazałoby natychmiast, że `getProformaFormsSummary`, `listSpaces`, `getPageChildren`, `listComments` i `getIssueChangelogViaDedicatedEndpoint` mają **0% pokrycia** — czyli pięć z siedmiu defektów siedzi w kodzie, którego żaden test nie dotyka. Jedna flaga, która sama zdiagnozowałaby wzorce A i D.

### Jakość samych testów — pozostałe uwagi

- **Za luźne asercje:** `confluenceClient.test.ts:143` i `jiraClient.test.ts:179` używają `/exceed|limit|maximum/i`, co przejdzie przy dowolnym komunikacie zawierającym „limit" — np. gdyby kontrola rozmiaru załącznika przestała działać, a klient padł na `queue limit`. Sąsiednie testy (`:121`, `:160`) używają precyzyjnego `/exceeding the 4-byte/`, więc to niekonsekwencja w tym samym pliku, nie konwencja.
- **Test implementacji:** `concurrency.test.ts:31-32` ma `assert.equal(peak <= 2, true)` **i** `assert.equal(peak, 2)`. Druga asercja wywali się przy zmianie schedulingu przy w pełni poprawnym zachowaniu.
- **Niedeterminizm:** progi wall-clock w `httpClient.test.ts:395, 573, 593, 720` (`< 180ms`) są ciaśniejsze niż typowa pauza GC pod obciążeniem — gwarantowany flake na CI.
- **Czego nie ruszać:** `serverPolicy.test.ts` (uruchamia realny serwer po stdio, weryfikuje politykę na `tools/list` **i** na `callTool` — właściwy poziom), `httpClient.test.ts:254-746` (najlepszy plik w repo), `jiraAgileClient.test.ts` (wzorzec do skopiowania).
- **`config.test.ts:85` powinien być odporniejszy na środowisko** — woła `chmodSync(ENV_FILE, 0o644)` i zakłada, że zadziałało. Sprawdzenie skutku zamiast założenia usuwa jedyny znany fałszywy alarm bez osłabiania testu tam, gdzie `chmod` działa (~15 min).

---

## 7. Dokumentacja

Dokumentacja jest w większości wyjątkowo rzetelna: **54 nazwy narzędzi w README zgadzają się z kodem co do jednego w obie strony**, wszystkie liczby narzędzi na profil (48/39/30/54) są dokładne, 15 zmiennych środowiskowych z dokumentacji istnieje w `config.ts` i ma poprawne wartości domyślne, żadna zmienna z kodu nie jest nieudokumentowana, zero narzędzi-widm w `AGENTS.md` i `docs/`.

Rozbieżności:

- **D1 [wysoka] `docs/SECURITY-ARCHITECTURE.md:79`** — „Existing paths are canonicalized so **symlinks cannot escape** approved directories." Prawda dla symlinków, fałsz dla hardlinków (5.10). Gorsze jest to, co robi lista ryzyk resztkowych (`:170-178`): opisuje jedyne pozostałe ryzyko jako „privileged same-host filesystem race". Hardlink nie wymaga ani wyścigu, ani uprawnień. **Dokument opisuje ryzyko jako trudniejsze, niż jest** — to gorsze niż jego przemilczenie.
- **D2 [średnia] `SECURITY-ARCHITECTURE.md:72`** — „ProForma chunk fetching uses bounded fan-out and a finite chunk budget." Bounded per formularz, nie per operacja (5.11).
- **D3 [średnia] Nieograniczone buforowanie JSON nie występuje w ryzykach resztkowych.** `SECURITY-ARCHITECTURE.md:172` wymienia łagodniejszy wariant („Bounded downloads are assembled in memory rather than streamed to disk") — czyli dokument opisuje ścieżkę **z limitem** jako ryzyko, a ścieżkę **bez limitu** (5.1, 52 z 54 narzędzi) pomija zupełnie.
- **D4 [niska] `.env.example` nie zawiera `ATLASSIAN_ENV_FILE`**, mimo że README:60-64 tę zmienną opisuje. Operator robiący `cp .env.example .env` nie dowie się o jej istnieniu.
- **D5 [niska] `AGENTS.md` pkt 5** nakazuje `npm run build`, `test:unit` i smoke, pomijając `npm run lint` — agent postępujący zgodnie z instrukcją ominie bramkę lintu.
- **D6 [niska] Załącznik A poprzedniego audytu** jest nieaktualny (§3).

**Zarzut, który się nie potwierdził:** teza o rzekomym kłamstwie dokumentacji na temat budżetu paginacji została obalona — README, `SECURITY-ARCHITECTURE.md` i `IMPLEMENTATION-REPORT.md` zgodnie zawężają `ATLASSIAN_MAX_PAGINATION_PAGES` do Jira Agile. Fakt (budżet trafia tylko do `JiraAgileClient`) jest prawdziwy i pozostaje luką w pokryciu, ale nie rozjazdem dokumentacja–kod.

---

## 8. Pakowanie i bramki

### 8.1 [Wysoka, jedna linia naprawy] Paczka nie da się zainstalować z gita

`dist/` jest w `.gitignore`, a w `scripts` **nie ma `prepare` ani `prepublishOnly`**. `npm install <git-url>` albo `npm i -g` z czystego checkoutu daje paczkę bez `dist/`, więc `bin.mcp-atlassian → dist/index.js` wskazuje na nieistniejący plik.

**Naprawa:** `"prepare": "npm run build"`.

### 8.2 [Średnia] Testy trafiają do paczki produkcyjnej

`files: ["dist"]` przy `tsconfig.include: ["src/**/*.ts"]` bez `exclude` publikuje `dist/__tests__/*.test.js` **i** mapy źródeł — potwierdzone przez `npm pack --dry-run`: 9 plików testowych, ~145 kB. Poza rozmiarem: mapy ujawniają pełny kod testów i strukturę katalogów.

**Naprawa:** `"files": ["dist", "!dist/__tests__"]`, docelowo osobny `tsconfig.build.json` z `"exclude": ["src/__tests__"]` i `"sourceMap": false`.

### 8.3 Bramki

`npm test` = `lint && build && test:unit && test:smoke` — jako kontrakt lokalny przyzwoite. Trzy problemy: **nic go nie uruchamia** (brak `.github/workflows`), **lint nie blokuje** (72 ostrzeżenia, `eslint .` kończy się kodem 0), **zero pomiaru pokrycia**.

CI ma sens tylko wtedy, gdy jest ostrzejsze niż lokalne `npm test`. Dwie rzeczy, których lokalnie nikt nie robi: **macOS** (cała warstwa `realpath`/`O_NOFOLLOW` zachowuje się inaczej — `attachmentSecurity.test.ts:296` ma nawet komentarz „macOS resolves the temporary directory through /private", ale nikt tego nie uruchamia) i **Node 18** (deklarowany w `engines`, nigdy nieweryfikowany).

```yaml
# .github/workflows/ci.yml
name: ci
on: [push, pull_request]
jobs:
  test:
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, macos-latest]
        node: [18, 22]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '${{ matrix.node }}', cache: npm }
      - run: npm ci
      - run: npx eslint . --max-warnings 72   # sufit zjazdowy: obniżać, nigdy nie podnosić
      - run: npm run build
      - run: node --test --experimental-test-coverage dist/__tests__/*.test.js
      - run: npm run test:smoke
      - run: npm pack --dry-run
```

`--max-warnings 72` zamienia dzisiejsze ostrzeżenia w nieprzekraczalny sufit — dług przestaje rosnąć bez wymuszania hurtowego otypowania.

### 8.4 `no-explicit-any` — gdzie otypowanie się zwraca

Rozkład 72 ostrzeżeń: `jiraClient.ts` 40, `jiraAgileClient.ts` 10, `confluenceClient.ts` 8, `proforma.ts` 7, `httpClient.ts` 5, `index.ts` 2. Pięć miejsc o najlepszym stosunku zysku do nakładu:

1. **`jiraClient.ts:849` — `getIssueProperty(): Promise<any>` → `Promise<unknown>`** (~1 h). Korzeń trzech z pięciu `TypeError` z 5.7; kompilator wskaże dokładnie `index.forms` i `root.rawData` jako wymagające guardu.
2. **`proforma.ts` — `formatProformaAnswer(answer: any)` → `unknown`** (~1 h). Łapie `answer.text` przy `answer === null`. Typ `ProformaRoot` już istnieje — brakuje jego użycia po stronie odpowiedzi.
3. **`jiraClient.ts:635` — `atlassianGet<{ fields?: Record<string, unknown> }>`** (~2 h). Jedna decyzja naprawia trzy miejsca (`getIssueFields`, `listAttachments`, `downloadAttachment`).
4. **`httpClient.ts:378` — `atlassianGet<T = any>` → `<T = unknown>`** (pół dnia). Domyślny `any` jest przyczyną punktów 1–3: każde wywołanie bez jawnego parametru wyłącza kontrolę typów w dół łańcucha. Nie hurtem — zmienić default i dopisać jawne `<any>` tam, gdzie jeszcze nie posprzątano, żeby dług był widoczny w diffie.
5. **`confluenceClient.ts:286, 344, 531` — `const spaces: any[]`** (~1 h, łączy się z refaktorem paginacji). Wymusi obsługę braku `results`, czyli dokładnie przypadek, w którym `response.results || []` po cichu daje pustą tablicę.

Czego **nie** proponujemy: otypowywać `jiraAgileClient.ts` — ten klient ma najlepszą walidację runtime'ową w repo, więc typy statyczne dołożyłyby tam najmniej.

### 8.5 Duplikacja

Martwego kodu nie ma (zero nieużywanych funkcji eksportowanych). Realna duplikacja produkcyjna to **trzy identyczne pętle paginacyjne** w `confluenceClient.ts:288, 346, 533`. Wyciągnięcie do `getPaginatedResults()` na wzór `jiraAgileClient.getPaginatedValues` **naprawia 5.9 i usuwa duplikację jedną zmianą**, przy okazji dając budżet stron. To najlepiej opłacający się pojedynczy refaktor w tym repo (~3 h).

---

## 9. Rekomendowany plan działania

| Priorytet | Działanie | Punkt | Nakład |
|---|---|---|---|
| 1 | `"prepare": "npm run build"` w `package.json` | 8.1 | 1 min |
| 2 | `lstat` + `isFile()` **przed** `open()` w `readExistingAttachment`, `O_NONBLOCK`; przy okazji `nlink > 1` → odmowa | 5.5, 5.10 | ~1 h |
| 3 | `.refine()` na schematach `update` — brak pól ma nie mutować | 5.3 | ~30 min |
| 4 | Wspólny helper testowy + test „upstream zwraca śmieci" dla każdego klienta | §6.1, §6.2 | ~8 h |
| 5 | Strażniki typu w `proforma.ts` i `getIssueProperty` | 5.7 | ~1 h |
| 6 | Limit rozmiaru wyniku narzędzia + limit na ścieżce JSON | 5.1, 5.2 | ~3 h |
| 7 | `getPaginatedResults()` dla Confluence (naprawia paginację i duplikację) | 5.9, 8.5 | ~3 h |
| 8 | `destructiveHint: true` na narzędziach nadpisujących; odwrócić spread adnotacji | 5.6 | ~30 min |
| 9 | Warunek `=== undefined` w `loadEnvFile` | 5.4 | 5 min |
| 10 | Parser XHTML zamiast regexów w `storageToPlainText` | 5.8 | ~4 h |
| 11 | CI (macierz macOS + Node 18/22, coverage, `npm pack --dry-run`) | 8.3 | ~1 h |
| 12 | Poprawki dokumentacji D1–D6 | §7 | ~1 h |
| 13 | Reszta niskich: 5.13–5.17 | — | ~3 h |

Pozycje 1–3 to łącznie poniżej dwóch godzin i zamykają wszystko, co ma jednocześnie realny skutek i tanią naprawę. **Nic z tej listy nie blokuje wdrożenia** przy domyślnej konfiguracji: `ATLASSIAN_ATTACHMENT_DIRS` jest puste, narzędzia destrukcyjne nie są zarejestrowane, a najgroźniejsze scenariusze wymagają jawnego włączenia dostępu do dysku.

---

## 10. Sprawdzone i czyste

- **Same-origin i przekierowania** — 18 wektorów: `https://jira.host@evil.com`, `HTTPS://EVIL.COM`, downgrade do `http://`, `//evil.com`, `\\evil.com`, `/\evil.com`, `https:/\evil.com`, tab i spacja przed schematem, `..`, `%2e%2e`, CRLF. Żaden nie zmienia hosta. Porównanie idzie do origin **pierwotnego** żądania, nie poprzedniego skoku, więc łańcuch przekierowań nie może dryfować. Non-GET odrzucone całkowicie, limit 5 sprawdzany dwukrotnie.
- **PAT nie wycieka do modelu** — prześledzone wszystkie ścieżki błąd → tekst (`formatError`, `AtlassianHttpError`, `Network error while calling …`). Token żyje wyłącznie w nagłówku `Authorization`. Logowanie MCP emituje `tool`, `kind`, `requestId`, `durationMs`, `errorType` — **nigdy `error.message` ani argumentów**.
- **Kodowanie ścieżek REST** — `encodeURIComponent` 26× w `jiraClient.ts`, 11× w `confluenceClient.ts`. `jiraAgileClient.ts` nie używa go wcale, ale interpoluje wyłącznie `boardId`/`sprintId` walidowane przez zod jako `.int().positive()`.
- **Parsowanie konfiguracji fail-closed** — `parseBoolean` rzuca na wszystko poza `1/true/yes/on/0/false/no/off`; `parsePositiveInteger` i `parseQueueLimit` rzucają przy `NaN`, nie-całkowitych, ≤0 i powyżej sufitu. `ATLASSIAN_READ_ONLY=maybe` wywala start serwera zamiast dać `false`. Śmieciowa wartość **nie** wpada cicho w mniej bezpieczną domyślną.
- **Walidacja `baseUrl`** — odrzuca userinfo (a więc PAT w URL), query, fragment i nie-HTTPS poza loopbackiem. Komunikaty błędów zawierają wyłącznie nazwę zmiennej, nigdy wartość.
- **Bramkowanie narzędzi, empirycznie w 13 konfiguracjach** — jedno `server.registerTool` w repo, 54/54 rejestracji przez helper `tool()`. `ATLASSIAN_READ_ONLY=true` → dokładnie 30 narzędzi, oba `download` (kind `local`) nieobecne. Read-only wygrywa z `ALLOW_DESTRUCTIVE`. Wszystkie 5 profili zgadza się z README co do sztuki. Nieznana grupa w `ATLASSIAN_PROFILE` → fatalny błąd startu z listą poprawnych wartości.
- **Higiena stdout** — wyłącznie ramki JSON-RPC we wszystkich konfiguracjach i wszystkich testach błędów. Dwa `console.error` w całym `src/`, zero `process.stdout.write`, `no-console: error` egzekwowane lintem.
- **Księgowanie slotów współbieżności** — zmierzone, nie wywnioskowane: 12 równoległych żądań z retry, wszystkie kończą się sukcesem, sonda kontrolna osiąga peak = 4 w 59 ms. Slot zwalniany na każdej ścieżce; brak wycieku i zakleszczenia. `await sleep(delay)` jest **poza** `try/finally`, więc slot nie jest trzymany przez backoff.
- **Polityka idempotencji retry** — `POST` nie jest ponawiany po błędzie sieciowym, timeoucie ani 5xx, wyłącznie po 429 (odrzucenie przed przetworzeniem). Brak ścieżki, na której retry zwielokrotni skutek zapisu.
- **`Retry-After` — wartości brzegowe** — `-5`, data w przeszłości, `999999` (przycięte do 30 s): wszystkie zachowują się rozsądnie, arytmetyka `deadline` sprawdza `remaining` przed uśpieniem.
- **`jiraAgileClient.getPaginatedValues`** — twardy limit stron, walidacja typu `values`/`total`, wykrywanie nieprzesuwającego się `startAt`, pustej strony przed końcem i powtórzonej strony po sygnaturze; rzuca zamiast zwracać dane częściowe. Wzorzec do skopiowania.
- **Cache `fieldDefinitions`** — błąd nie zatruwa cache'u (rzuca przed przypisaniem).
- **Sekrety w historii git** — czysto. Jedyne trafienia to fixtury testowe.
- **`attachmentSecurity.ts`: allowlista jako dowiązanie, ścieżka równa rootowi, kolejność walidacja→mkdir→rewalidacja→open** — sprawdzone eksperymentalnie, brak sposobu na utworzenie katalogu poza allowlistą; nieistniejący katalog allowlisty → `ENOENT` i odmowa całej operacji (fail-closed).
- **Brak martwego kodu** — zero nieużywanych funkcji eksportowanych.

---

## 11. Czego NIE sprawdzono

Uczciwie, żeby następna runda wiedziała, gdzie zaczynać:

- **`docs/AZURE-DEPLOYMENT.md` (18 kB) — ani jedno twierdzenie nie zostało zweryfikowane.** To samo dotyczy sekcji „Required Azure / Microsoft Entra architecture" w `SECURITY-ARCHITECTURE.md:88+`. Największa niesprawdzona powierzchnia dokumentacyjna.
- **`src/index.ts` — ~1500 linii ciał handlerów.** Przejrzano rejestracje, helper `tool()`, mapowanie grup i schematy zod; logika samych handlerów i formatowanie odpowiedzi pozostają nieprzeanalizowane. Największa niesprawdzona powierzchnia kodu.
- **`scripts/deploy.mjs`** — nieprzeczytany. `scripts/smoke-test.mjs` tylko pobieżnie.
- **`docs/IMPLEMENTATION-REPORT.md` (20 kB)** — pominięty poza pojedynczą weryfikacją twierdzenia o budżecie paginacji.
- **Prawdziwa instancja Jira/Confluence DC** — wszystkie testy szły do atrap na loopbacku. Kształt odpowiedzi prawdziwego DC (zwłaszcza liczba pól własnych w `getIssueFields`) może być gorszy, nie lepszy.
- **macOS i Windows** — mount jest linuksowy. Zachowanie `realpath`/`O_NOFOLLOW` na macOS i `path.delimiter` na Windows nietestowane — i, jak wynika z §8.3, nietestowane też przez nikogo innego.
- **Mutation testing** — sprawdzono celowane hipotezy, nie oszacowano ogólnej siły suity metrykami mutacyjnymi.
- **`npm audit` powtórnie** — poprzednia runda dała 0 podatności; `package-lock.json` zmienił się od tego czasu (doszedł ESLint), więc warto powtórzyć.
- **Zachowanie pod prawdziwym rate-limitingiem Jiry** (`X-RateLimit-*`, których kod nie czyta).

---

## Załącznik A — mapa narzędzi (stan faktyczny, `c04b242`)

**54 zarejestrowane**: 30 `read`, 16 `write`, **6 `destructive`**, 2 `local`. Zweryfikowane empirycznie przez `tools/list`.

| Grupa | read | write | destructive | local | razem |
|---|---|---|---|---|---|
| core | 11 | 0 | 0 | 0 | 11 |
| forms | 3 | 0 | 0 | 0 | 3 |
| files | 2 | 1 | 1 | 2 | 6 |
| links | 2 | 1 | 1 | 0 | 4 |
| write | 3 | 14 | 4 | 0 | 21 |
| dev | 4 | 0 | 0 | 0 | 4 |
| agile | 5 | 0 | 0 | 0 | 5 |
| **razem** | **30** | **16** | **6** | **2** | **54** |

Widoczne w `tools/list`: domyślnie **48**, `ppm` 39, `read` / `ATLASSIAN_READ_ONLY=true` 30, `agile` 20, `core` 11, z `ALLOW_DESTRUCTIVE` 54.

Sześć narzędzi destrukcyjnych (`jira_delete_attachment`, `jira_delete_issue_link`, `jira_delete_comment`, `jira_delete_worklog`, `confluence_delete_comment`, `confluence_delete_page`) pojawia się wyłącznie przy `ATLASSIAN_ALLOW_DESTRUCTIVE=true` i **nigdy** przy `ATLASSIAN_READ_ONLY=true` ani `ATLASSIAN_PROFILE=read` — zweryfikowane w obu kombinacjach.

### Koszt kontekstu

`JSON.stringify(tools)` = **40 509 B** dla 48 narzędzi (~10 tys. tokenów), 44 451 B dla 54. Dla okna 200k to ~5% na każdym żądaniu; dla okna 32k — 30% i realny problem.

Najdroższe: `jira_add_worklog_with_category` 1 568 B, `jira_get_sprint_report` 1 346 B (opis 751 znaków — najdłuższy w serwerze), `jira_transition_issue` 1 289 B, `jira_get_issue_cycle_time` 1 269 B, `jira_update_issue` 1 167 B.

Trzy oszczędności bez utraty użyteczności: usunięcie pola `title` (jest parafrazą nazwy we wszystkich 54 przypadkach) ≈ 1,9 kB; skrócenie sześciu najdłuższych opisów do ~150 znaków i przeniesienie reszty do treści odpowiedzi ≈ 2 kB; usunięcie powtarzanego „Read-only." z 30 opisów, redundantnego wobec `readOnlyHint: true` w tej samej ramce ≈ 0,4 kB. Razem ~11%. Prawdziwym narzędziem pozostaje jednak profil.


---

## 12. Status realizacji (26 sierpnia 2026, po przebiegu naprawczym)

Stan drzewa roboczego (bez commita). Każdy wiersz opisuje to, co widać w kodzie
po zmianach, a nie to, co plan §9 zapowiadał — tam, gdzie realizacja odbiega od
planu, jest to napisane wprost.

| Poz. | Punkt | Status | Co zostało zrobione |
|---|---|---|---|
| 1 | 8.1 `prepare` w `package.json` | ✅ zrobione | **Inaczej niż w planie.** Zamiast `"prepare": "npm run build"` doszły `"prepare": "npm run build:dist"` i `"build:dist": "tsc -p tsconfig.build.json"`, a `tsconfig.build.json` wyłącza `src/__tests__` i `sourceMap`. Powód jest ten sam, który uzasadnia 8.2: instalacja z gita ma zbudować paczkę produkcyjną, a nie testy. `files` w `package.json` to `["dist", "!dist/__tests__", "!dist/**/*.map"]`. |
| 2 | 5.5, 5.10 `lstat` przed `open()`, `O_NONBLOCK`, `nlink > 1` | ✅ zrobione | `attachmentSecurity.ts`, `readExistingAttachment`: `lstat` + `isFile()` przed `open()`, flagi `O_RDONLY \| O_NOFOLLOW \| O_NONBLOCK`, powtórzony `isFile()` na deskryptorze i odmowa przy `metadata.nlink > 1` z komunikatem tłumaczącym, dlaczego druga nazwa jest problemem. Komentarze w kodzie opisują oba okna (FIFO blokujący wątek libuv, podmiana ścieżki między `lstat` a `open`). |
| 3 | 5.3 `update` bez pól nie ma mutować | ✅ zrobione, **inną drogą niż plan** | Plan mówił „`.refine()` na schematach". Tak się nie da: `server.registerTool` przyjmuje `ZodRawShape` (mapę pól), a nie `ZodObject`, więc nie ma na czym wywołać `.refine()`. Zamiast tego wrapper `tool()` w `index.ts` dostał opcjonalne `validate?: (args) => string \| undefined`, wołane przed handlerem i zamieniane na `McpError(ErrorCode.InvalidParams, …)`. Używają go `jira_update_issue` i `confluence_update_page`. Efekt dla klienta jest ten sam (błąd walidacji, zero ruchu sieciowego), miejsce inne. |
| 4 | §6.1, §6.2 wspólny helper testowy + testy „upstream zwraca śmieci" | ✅ zrobione | `src/__tests__/testServer.ts` skupia jedyny stub HTTP (rejestracja żądań, skryptowane sekwencje), `withTemporaryDirectory`, `UPSTREAM_GARBAGE_CASES` (10 wrogich kształtów, m.in. strona logowania SSO z kodem 200) oraz `assertDomainError`, który jawnie odrzuca `TypeError`. Trzy zduplikowane definicje `withStubServer` i dwie `withTemporaryDirectory` zniknęły. Skutek uboczny opisany w §12.4. |
| 5 | 5.7 strażniki typu w `proforma.ts` i `getIssueProperty` | ✅ zrobione | `proforma.ts` ma `describeValue()` i sprawdzenia kształtu w `getProformaChunkCount`/`decodeProformaDesign` (m.in. „expected an object, received …", „expected an array, received …"). `jiraClient.ts` rozróżnia `{"value":null}` (własny komunikat: właściwość istnieje, ale została wyczyszczona) od braku właściwości (404 → pusta lista) i od wartości nie-obiektowej. Zamiast `TypeError` wychodzi zdanie mówiące, co przyszło z serwera. |
| 6 | 5.1, 5.2 limit wyniku narzędzia + limit na ścieżce JSON | ✅ zrobione | Dwie nowe zmienne w `config.ts`: `ATLASSIAN_MAX_JSON_BYTES` (domyślnie `DEFAULT_MAX_JSON_BYTES` = 16 MiB, sufit 256 MiB) i `ATLASSIAN_MAX_TOOL_RESULT_BYTES` (domyślnie 150 000, sufit 16 MiB). Pierwsza trafia do `configureHttp`, druga do `clampToolText()` w `index.ts`, który przycina **każdą** część `content` typu `text` w wrapperze `tool()` i dokleja marker `…[truncated: N of M bytes omitted — …]`, rezerwując bajty samego markera, żeby wynik naprawdę mieścił się w limicie. Ucięty ogon nie może udawać kompletnej odpowiedzi. |
| 7 | 5.9, 8.5 `getPaginatedResults()` dla Confluence | ✅ zrobione | `confluenceClient.getPaginatedResults()` — jedna pętla dla `listSpaces`, `getPageChildren` i `listComments`, z detekcją powtórzonej strony (`seenPageSignatures`), walidacją `results`, twardym błędem po `maxPaginationPages` („partial results were not returned") i wspólną kopertą `ConfluencePaginationInfo` (`start`, `limit`, `returned`, `total`, `hasMore`, `nextStart`). Te trzy narzędzia zwracają odtąd obiekt, a nie gołą tablicę — zmiana kształtu odpowiedzi, opisana w README. |
| 8 | 5.6 `destructiveHint` + odwrócony spread adnotacji | ✅ zrobione | W `index.ts` `...spec.annotations` jest teraz **na końcu** obiektu `annotations`, więc adnotacja per-narzędzie nadpisuje wartość wyprowadzoną z `kind` (komentarz w kodzie tłumaczy dlaczego: domyślną wartością `destructiveHint` w MCP jest `true`, więc `false` byłoby fałszywym negatywem w groźnym kierunku). `destructiveHint: true` mają: `jira_update_issue`, `jira_assign_issue`, `jira_edit_comment`, `jira_remove_watcher`, `jira_transition_issue`, `confluence_update_comment`, `confluence_update_page`. Zweryfikowane przez `tools/list`: 7 przy domyślnej konfiguracji, 13 przy `ATLASSIAN_ALLOW_DESTRUCTIVE=true`. |
| 9 | 5.4 `=== undefined` w `loadEnvFile` | ✅ zrobione | `config.ts`: `if (process.env[key] === undefined) process.env[key] = value;` z komentarzem, że pusty łańcuch (`Environment=X=`, `-e X=`) jest świadomym nadpisaniem, a nie brakiem wartości. |
| 10 | 5.8 parser XHTML zamiast regexów | ✅ zrobione | `confluenceClient.ts` importuje `Parser` z `htmlparser2` i przepisuje `storageToPlainText` na maszynę zdarzeń (`onopentag`/`ontext`/`onclosetag`, tryb XML, obsługa tagów samozamykających przez `parser.endIndex`). Repozytorium ma odtąd trzy zależności runtime zamiast dwóch. Konwersja nadal jest stratna — to rendering do tekstu, nie round-trip — i README mówi to wprost. |
| 11 | 8.3 CI | ✅ zrobione | `.github/workflows/ci.yml`: macierz `{ubuntu-latest, macos-latest} × {18, 22}`, `fail-fast: false`. Kroki: `npm ci` (świadomie **z** `prepare`, bo to jedyny test tego, że paczka instaluje się z gita — poz. 1), `npx eslint . --max-warnings 93` (sufit zjazdowy, skomentowany w pliku; stan zmierzony: 0 błędów, 93 ostrzeżenia — wartość podniesiona z 87 po fali opisanej w §12.4; bez tego CI failowałby przy pierwszym uruchomieniu na wszystkich czterech kombinacjach macierzy), `npm run build` (drugi build jest konieczny: `prepare` buduje bez `src/__tests__`, a suita jednostkowa uruchamia skompilowane `dist/__tests__/*.test.js`), `node --test --experimental-test-coverage dist/__tests__/*.test.js`, `npm run test:smoke`, ten sam smoke z `ATLASSIAN_ALLOW_DESTRUCTIVE=true` (druga połowa asercji o sześciu narzędziach delete, której domyślny przebieg nie widzi) i `npm pack --dry-run`. Flaga `--experimental-test-coverage` została sprawdzona empirycznie na Node 18.20.8 — działa, więc kroku nie trzeba warunkować wersją. |
| 12 | §7 dokumentacja D1–D6 | ✅ zrobione | Szczegóły w §12.1. |
| 13 | 5.13–5.17 | 🔶 częściowo | Zweryfikowane jako zrobione: **5.14** (`grep "JSON.stringify(.*null, 2)" src/index.ts` → 0 trafień; odpowiedzi są compact), **5.15** (`transport.onerror` ustawiany po `server.connect()`, z komentarzem, że `Protocol.connect()` nadpisuje handler), **5.16** (`process.on(signal, …)` w `index.ts`), **5.17b** (`response.body?.cancel()` na ścieżkach odrzucenia w `httpClient.ts`), oraz część **5.13**: `issueKeySchema` ma `.max(255)` + `regex(/^[A-Za-z][A-Za-z0-9_]*-[1-9][0-9]*$/)`, `numericIdSchema` `.max(32)` + `regex(/^[1-9][0-9]*$/)`, `jira_update_issue.labels` ma `.max(100)`. Pozostałych podpunktów (5.12, 5.13 w części dotyczącej górnych granic `startAt`/`start`, 5.17a, 5.17c) nie weryfikowałem. |

### 12.1 Poz. 12 — co konkretnie poprawiono w dokumentacji

- **D1** — `docs/SECURITY-ARCHITECTURE.md`: zdanie o kanonizacji zostało uzupełnione o to, czego kanonizacja **nie** załatwia (hardlink to druga nazwa tego samego i-węzła, `realpath()` zwraca nazwę zgodną z polityką), o odmowę przy `nlink > 1`, o `lstat` przed `open()` i `O_NONBLOCK` przeciw FIFO oraz o powtórzoną kontrolę typu na deskryptorze. Lista ryzyk resztkowych przestała opisywać jedyne pozostałe zagrożenie jako „privileged same-host filesystem race": obecny zapis nazywa wprost, że wcześniejsza wersja zaniżała trudność ataku (hardlink nie wymagał ani uprawnień, ani wyścigu), i ogranicza opis wyścigu do tego, co faktycznie zostało — brak `openat`-owego przypięcia katalogów nadrzędnych. Dodano też wpis o świadomym fałszywym alarmie: odrzucany jest każdy plik z `nlink > 1`, także dowiązany legalnie wewnątrz allowlisty.
- **D2** — `SECURITY-ARCHITECTURE.md`: „bounded fan-out and a finite chunk budget" zastąpione liczbami z kodu: `MAX_PROFORMA_CHUNKS` = 25 chunków na formularz, `DEFAULT_CONCURRENCY` = 5 chunków równolegle, `PROFORMA_FORM_CONCURRENCY` = 3 formularze równolegle, czyli najgorszy przypadek 3 × 5 = 15 żądań w locie na jedną operację, nadal kolejkowanych za `ATLASSIAN_MAX_CONCURRENT_REQUESTS`.
- **D3** — dopisany akapit o dwóch niezależnych sufitach rozmiaru (`ATLASSIAN_MAX_JSON_BYTES`, `ATLASSIAN_MAX_TOOL_RESULT_BYTES`), a wpis o buforowaniu w ryzykach resztkowych obejmuje teraz również ścieżkę JSON i mówi, że podniesienie limitów podnosi ekspozycję.
- **D4** — `.env.example` ma sekcję `ATLASSIAN_ENV_FILE` (zakomentowaną, z opisem zachowania: brak → `.env` obok install roota, ścieżka nie do odczytania → błąd startu, prawdziwe zmienne środowiskowe wygrywają z plikiem). Przy okazji doszły `ATLASSIAN_MAX_JSON_BYTES` i `ATLASSIAN_MAX_TOOL_RESULT_BYTES`, a komentarz przy `ATLASSIAN_MAX_PAGINATION_PAGES` przestał mówić „Jira Agile".
- **D5** — `AGENTS.md` pkt 5 nakazuje teraz `npm test` (czyli `lint` → `test:unit` → `test:smoke`) i mówi wprost, że uruchomienie samych dwóch ostatnich omija bramkę lintu.
- **D6** — Załącznik A w `docs/CODE-AUDIT.md` przestał być tabelą i jest odsyłaczem do Załącznika A tego dokumentu, z jednozdaniowym wyjaśnieniem, które liczby były błędne (54/„5 destructive", core 9, files 5) i dlaczego duplikowanie mapy w dwóch plikach jest samo w sobie usterką.

### 12.2 Rzeczy nieaktualne poza listą D1–D6

- **Dwie nowe zmienne środowiskowe** nie istniały w żadnej dokumentacji. Dodane do tabeli w `README.md`, do `.env.example` i do „Configuration contract" w `docs/IMPLEMENTATION-REPORT.md`.
- **`ATLASSIAN_MAX_PAGINATION_PAGES` jako „per Jira Agile operation"** — poprawione w czterech miejscach: `README.md` (tabela konfiguracji i akapit „Automatic pagination fails closed"), `docs/SECURITY-ARCHITECTURE.md`, `docs/IMPLEMENTATION-REPORT.md`.
- **Zmiana kształtu odpowiedzi trzech narzędzi Confluence** — nowy akapit w README nazywa pola koperty i mówi to, czego nie widać z samego kształtu: te trzy narzędzia **nie przyjmują** parametru `start`, bo paginują wewnętrznie do zadanego `limit`, więc przy `hasMore: true` trzeba podnieść `limit`, a nie oddać `nextStart`. Zwracany `nextStart` jest tam sygnałem, nie kursorem.
- **Zlanie `destructiveHint` z `ATLASSIAN_ALLOW_DESTRUCTIVE`** — sekcja „Safety" w README rozdziela adnotację doradczą (7 narzędzi nadpisujących, nadal zarejestrowanych przy `ALLOW_DESTRUCTIVE=false`, usuwanych dopiero przez tryb read-only) od bramki rejestracji (6 narzędzi `*_delete_*`).
- **Liczby w akapicie o koszcie kontekstu w README były nieaktualne** — zmierzone ponownie przez `npm run test:smoke`: `full` 48 narzędzi / 43 016 B / ~10 754 tokenów (było „10 125"), `ppm` 39 / 34 327 B / ~8 582 (było „7 985"), `read` 30 / 25 184 B / ~6 296 (było „6 010"), `full` + `ALLOW_DESTRUCTIVE` 54 / 47 209 B / ~11 802 (było „11 110"). Payload urósł, bo opisy narzędzi urosły — m.in. o ostrzeżenie w `confluence_update_page` i o instrukcje paginacyjne. Załącznik A tego dokumentu podaje 40 509 B / 44 451 B dla stanu `c04b242`; te wartości opisują stan **sprzed** przebiegu naprawczego i celowo ich nie ruszam.
- **Blok „Setup" w README** obiecywał `npm install` → `npm run build`. Po dodaniu `prepare` samo `npm install` już buduje (przez `tsconfig.build.json`, czyli bez testów i bez map źródeł), a `npm run build` jest wywoływany przez oba skrypty testowe. Blok został poprawiony, z akapitem tłumaczącym różnicę między dwoma buildami i zawartość `files`.
- **Walidacja „update bez pól"** i **ostrzeżenie o stratnym round-tripie `confluence_get_page` → `confluence_update_page`** nie były nigdzie opisane poza opisami narzędzi. Dodane do „Behaviour worth knowing" w README.
- **`htmlparser2`** dopisany przy `confluenceClient.ts` w drzewie architektury w README.

### 12.3 Bramki

`npm run build` — 0 błędów. `npm run lint` — 0 błędów, 93 ostrzeżenia (`no-explicit-any`; 72 w rundzie 1, wzrost to nowy kod warstwy parsowania i strażników kształtu). `npm run test:smoke` — wszystkie kontrole zielone w sześciu kombinacjach profilu i `ALLOW_DESTRUCTIVE`; liczby narzędzi jak w §12.2. Walidacja YAML-a CI: `yaml.safe_load` przechodzi.

`npm run test:unit` **nie było uruchomione w tym przebiegu**. Repozytorium jest zamontowane przez FUSE, który odmawia `unlink` (`EPERM: operation not permitted, unlink 'dist/__tests__/config-test.env'`) — ten sam typ artefaktu środowiskowego, co 19 „failów" opisane w §8 rundy 1, tyle że tym razem wywracający hooki `after()`. Sprawdzone: identyczny błąd występuje na Node 18.20.8 i na Node 22.23.2, czyli **nie jest to niezgodność z Node 18**. Czy suita przechodzi na Node 18 i na macOS — pozostaje niezweryfikowane i to jest dokładnie ta odpowiedź, po którą powstało CI z poz. 11.

### 12.4 Fala domykająca — czego nie było w planie

Sekcja 12.1–12.3 powstała, zanim przebieg naprawczy się skończył. To, co niżej, wydarzyło się po niej i jest **najciekawszym wynikiem całej rundy**, bo nie pochodzi z planu, tylko z realizacji poz. 4.

Systematyczna tabela wrogich kształtów odpowiedzi (10 wariantów × każdy endpoint read), napisana jako lekarstwo na wzorzec A z §6, **znalazła 11 kolejnych ścieżek zwracających surowy `TypeError`** w kodzie, który poz. 5 uznała za naprawiony — bo poz. 5 objęła tylko te pięć ścieżek, które audyt zdążył wyliczyć:

- puste ciało 200: `ConfluenceClient.searchPages`, `.getPage`, `.listAttachments`, `.getPageHistory`, `.getPageByTitle`; `JiraClient.getTransitions`, `.listWorklogs`, `.listWatchers`, `.getIssueChangelog`
- `results` niebędące tablicą: `ConfluenceClient.searchPages`, `.listAttachments`, `.getPageHistory`

Do tego jeden przypadek, który nie failował, tylko **wieszał suitę**: `getIssueChangelogViaDedicatedEndpoint` był jedyną pętlą paginacyjną w repo bez budżetu stron, więc odpowiedź bez `total` i bez `isLast` dawała pętlę nieskończoną — zmierzone 3 463 żądania w 6 s przy RSS 170 MB. To jest **pełna wersja defektu 5.12**, którego przebieg adwersarialny (§4) zdegradował do „niska, wymaga nieprawidłowo zachowującego się DC". Degradacja była trafna co do prawdopodobieństwa i nietrafna co do skutku: nie chodzi o niekompletne dane, tylko o zawieszenie procesu.

Wszystko zamknięte. Powstały przy tym dwa moduły, których plan nie przewidywał, obydwa zamiast trzeciej równoległej konwencji:

- **`src/upstreamShape.ts`** — `describeUpstreamValue`, `requireUpstreamObject`, `requireUpstreamArray`, sparametryzowane produktem. Do tego przeniesiono istniejące helpery z `jiraClient.ts` (komunikaty bit w bit identyczne, testy nietknięte).
- **`src/jiraPagination.ts`** — `fetchPaginatedJiraValues` wyciągnięte z `JiraAgileClient.getPaginatedValues` (metoda została jako cienki wrapper). Changelog dzieli teraz tę samą pętlę, więc budżet stron, detekcja nieprzesuwającego się kursora i powtórzonej strony wchodzą tam bez duplikatu. `JiraClient` dostał `maxPaginationPages` w konstruktorze — budżet obejmuje dziś **wszystkie trzy** klienty.

**Świadomy trade-off:** changelog jest odtąd ograniczony do `maxPaginationPages × 100` wpisów historii (domyślnie 1000). Issue z dłuższą historią zwróci błąd z podpowiedzią, którą zmienną podnieść, zamiast urwanej osi czasu. Konwencja „nigdy ciche dane częściowe" ma tu koszt i warto o nim wiedzieć.

**Poprawka w `scripts/smoke-test.mjs`:** kontrola „destructive tools disabled by default" liczyła narzędzia z adnotacją `destructiveHint` i po poz. 8 zaczęła failować. Zlewała dwie różne rzeczy — adnotację doradczą opisującą zachowanie i bramkę `ATLASSIAN_ALLOW_DESTRUCTIVE` nad sześcioma narzędziami `delete`. Asercja mówi teraz to, co miała mówić od początku, i doszła jej druga połowa (dokładnie sześć narzędzi `delete` przy jawnym włączeniu).

### 12.5 Weryfikacja niezależna

Osobny przebieg weryfikacyjny próbował odtworzyć każdy z dziewięciu oryginalnych defektów na dzisiejszym kodzie, uruchamiając prawdziwy serwer po stdio przeciwko atrapie na loopbacku. Żadnego nie udało się odtworzyć. Zmierzone końcowe bramki: build 0 błędów, lint 0 błędów / 93 ostrzeżenia, **testy 424/424** (0 fail, 0 skip, 0 todo), smoke zielony w obu trybach, `npm audit` 0 podatności, `npm pack --dry-run` 13 plików / 58,5 kB bez testów i map źródeł.

Weryfikator zgłosił dwa zastrzeżenia. Pierwsze — sufit lintu w CI — było trafne i blokujące; poprawione (§12.3). Drugie — „budżet stron paginacji nie ma żadnego pokrycia testami" — było **fałszywym alarmem, i to pouczającym**: mutowany był warunek pętli `for`, który jest redundantny, podczas gdy faktycznym strażnikiem jest `if (pageNumber === maxPaginationPages) throw` w środku. Mutacja właściwej linii wywala 7 testów. Wniosek metodyczny na przyszłość: przy sprawdzaniu, czy test czegoś pilnuje, trzeba celować w rzeczywisty punkt egzekwowania, nie w pierwszą linię, która wygląda jak limit. Przy okazji dołożono dwa testy budżetu po stronie Confluence, gdzie pokrycia faktycznie nie było.

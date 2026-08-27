# Audyt kodu — mcp-atlassian (vaillant-mcp-atlassian)

**Data audytu:** 25 sierpnia 2026
**Zakres:** cały bieżący stan roboczy repozytorium (`main`, HEAD `0a6ec65` + niezacommitowane zmiany), 7715 linii TS/JS w `src/`, `scripts/`, `docs/`
**Metoda:** pełny przegląd kodu źródłowego linia po linii (`config.ts`, `httpClient.ts`, `jiraClient.ts`, `jiraAgileClient.ts`, `confluenceClient.ts`, `proforma.ts`, `concurrency.ts`, `index.ts`), uruchomienie `npm run build`, `npm run test:unit`, przegląd `AGENTS.md` i `docs/SECURITY-ARCHITECTURE.md`, skan pod kątem sekretów w historii i working tree.

---

## 1. Podsumowanie wykonawcze

To jest jeden z solidniej napisanych, mniejszych serwerów MCP, jakie widziałem — poziom staranności wokół bezpieczeństwa (SSRF, path traversal, TOCTOU, DoS) jest wyraźnie wyższy niż typowo w projektach tej skali. Build przechodzi czysto (`tsc --strict`, zero błędów), a testy jednostkowe w większości przechodzą — 19 „failów” w tym środowisku audytowym to artefakt sandboxa (patrz §4), nie błąd w kodzie.

Nie znalazłem żadnej krytycznej ani wysokiej luki bezpieczeństwa. Największe realne ryzyko to **duplikacja logiki bezpieczeństwa załączników** między dwoma klientami (§3.1) — dziś identyczna, ale przy przyszłej poprawce w jednym miejscu łatwo zapomnieć o drugim. Reszta uwag to porządki (lint, audyt zależności, drobne nieścisłości w dokumentacji).

Working tree zawiera nieduże, ale nietrywialne niezacommitowane zmiany (13 zmodyfikowanych plików, +1898/−207 linii, plus 6 nowych plików: `AGENTS.md`, `docs/AZURE-DEPLOYMENT.md`, `docs/SECURITY-ARCHITECTURE.md`, `src/__tests__/httpClient.test.ts`, `src/__tests__/jiraAgileClient.test.ts`, `src/__tests__/serverPolicy.test.ts`). Audyt objął ten stan roboczy, nie tylko ostatni commit.

---

## 2. Co zostało sprawdzone

| Obszar | Status |
|---|---|
| `npm run build` (tsc --strict) | ✅ przechodzi bez błędów |
| `npm run test:unit` | ⚠️ 106/125 OK, 19 failów — wszystkie w `config.test.ts`, przyczyna środowiskowa (§4) |
| `npm audit` | ❌ nie udało się uruchomić — ten sandbox blokuje dostęp do endpointu audytu npm (`403 blocked-by-allowlist`). **Zalecenie: uruchom `npm audit` lokalnie/w CI** — nie zweryfikowałem podatności w zależnościach. |
| Sekrety w repo/historii | ✅ brak — `.env` poprawnie w `.gitignore`, brak `.env` w historii git, brak twardo zakodowanych tokenów (jedyne trafienia to `synthetic-jira-token` / `synthetic-confluence-token` w testach) |
| Cały `src/*.ts` (7 plików, ~5000 linii) | ✅ przeczytane w całości |
| `index.ts` (1760 linii, 54 rejestracje narzędzi MCP) | ✅ przeczytany w całości, zmapowane `group`/`kind` każdego narzędzia |
| `scripts/deploy.mjs`, `scripts/smoke-test.mjs` | ✅ przeczytane |
| `AGENTS.md`, `docs/SECURITY-ARCHITECTURE.md` | ✅ przeczytane |

---

## 3. Mocne strony (dla kontekstu — to nie jest lista „do zrobienia”)

Warto to nazwać wprost, bo to nietypowo wysoki standard:

- **SSRF / przekierowania:** `buildUrl()` i `fetchOnce()` w `httpClient.ts` twardo wymuszają ten sam origin co skonfigurowany `baseUrl` — zarówno dla ścieżek, jak i dla przekierowań HTTP (max 5, tylko same-origin, tylko dla GET). Token PAT nigdy nie poleci do innego hosta, nawet jeśli odpowiedź z Jiry/Confluence zwróci spreparowany URL.
- **Path traversal / symlink / TOCTOU przy załącznikach** (`jiraClient.ts`, `confluenceClient.ts`): kanonizacja przez `realpath` po segmentach, `lstat` odrzucający symlinki, finalny `open()` z `O_CREAT|O_EXCL|O_NOFOLLOW` (zapis) lub `O_RDONLY|O_NOFOLLOW` (odczyt) jako atomowy punkt egzekwowania — klasyczna klasa błędów TOCTOU jest tu realnie zamknięta, nie tylko „sprawdzona i zapomniana”.
- **Walidacja `.env`:** wymóg trybu `0600` (odrzucenie, jeśli grupa/inni mają jakikolwiek dostęp), brak fallbacku na wartości domyślne dla wymaganych zmiennych, priorytet realnego środowiska nad plikiem.
- **Polityka narzędzi MCP:** rejestracja narzędzi destrukcyjnych jest całkowicie warunkowa (`ATLASSIAN_ALLOW_DESTRUCTIVE`) — narzędzie, którego nie ma w `tools/list`, nie może zostać wywołane przez model, niezależnie od promptu. Adnotacje MCP (`destructiveHint` itp.) są jawnie traktowane jako informacyjne, nie jako kontrola dostępu — to poprawne podejście, bo klient MCP nie musi tych adnotacji respektować.
- **Budżety odpornościowe:** globalny limit współbieżności + kolejka z deadline'em, całościowy timeout (`ATLASSIAN_TOTAL_TIMEOUT_MS`) liczony przez queueing+retry+backoff, retry tylko dla metod idempotentnych (poza 429), honorowanie `Retry-After`.
- **Integralność paginacji** (`jiraAgileClient.ts`): wykrywanie zawieszonej/powtarzającej się/niekompletnej paginacji i twarde rzucenie błędu zamiast cichego zwrócenia częściowych danych — bardzo łatwo to pominąć, a tu jest przetestowane i celowe.
- **Logowanie:** jawna zasada „nigdy argumentów narzędzia” w logach MCP — tylko czas trwania, nazwa narzędzia, wynik. Konsekwentnie przestrzegana w całym `index.ts`.
- **Dokumentacja bezpieczeństwa** (`docs/SECURITY-ARCHITECTURE.md`) jest rzadko spotykana pod względem szczerości — wprost wylicza, co NIE jest jeszcze zaimplementowane (Azure/Entra multi-user), i opisuje realne resztkowe ryzyka (np. brak `openat`-pinningu katalogów nadrzędnych) zamiast je przemilczeć.

---

## 4. Testy: 19 „failów” — analiza przyczyny

Wszystkie 19 nieudanych testów pochodzi z `src/__tests__/config.test.ts` i mają identyczny ślad błędu:

```
error: "EPERM: operation not permitted, unlink '.../dist/__tests__/config-test.env'"
```

Testy tworzą tymczasowy plik `.env` i próbują go usunąć w hooku `afterEach`. W środowisku, w którym wykonywałem audyt, katalog repozytorium jest zamontowany z ograniczeniem: `unlink`/`rm` na plikach w tym mouncie jest domyślnie zablokowany (to ograniczenie mojego dostępu do Twojej maszyny, nie coś w Twoim kodzie). To pełny false positive — build przeszedł bezbłędnie, a pozostałe 21 suit (106 testów) przeszło w całości, w tym cała suita `serverPolicy.test.ts` weryfikująca politykę rejestracji narzędzi.

**Zalecenie:** uruchom `npm test` lokalnie w normalnym terminalu (poza tym sandboxem), żeby potwierdzić 125/125 — powinno przejść czysto.

---

## 5. Znalezione problemy

### 5.1 [Średni] Zduplikowana logika bezpieczeństwa załączników — ryzyko rozjazdu

**Gdzie:** `src/jiraClient.ts` (`assertAttachmentPathAllowed`, `assertAttachmentSize`, `writeNewAttachment`, ok. linie 449–540) i `src/confluenceClient.ts` (te same metody, linie 237–321).

Obie implementacje są niemal bajt w bajt identyczne (różnią się tylko parametrami `label`/`mustExist`, których Confluence-owa wersja nie potrzebuje). To jest dokładnie ten kod, który chroni przed path traversal, symlink escape i TOCTOU — czyli najbardziej wrażliwy fragment całego projektu pod względem bezpieczeństwa.

**Dlaczego to problem:** dziś nie ma błędu — obie kopie są poprawne. Ryzykiem jest przyszłość: ktoś (człowiek albo agent AI) poprawi lukę lub doda funkcjonalność w jednej kopii, zapomni o drugiej, i druga zostanie z cichą regresją bezpieczeństwa, której żaden test nie wychwyci (bo testy też są odrębne dla każdego klienta).

**Rekomendacja:** wydzielić wspólny moduł, np. `src/attachmentSecurity.ts`, eksportujący `assertAttachmentPathAllowed`, `assertAttachmentSize`, `writeNewAttachment` (i ewentualnie odczyt pliku przy uploadzie), używany przez oba klienty. Jeden zestaw testów zamiast dwóch.

### 5.2 [Niski] Brak lintera/formattera w repo

Nie ma `.eslintrc*` ani `eslint.config.*`, mimo że `index.ts` zawiera komentarz `// eslint-disable-next-line no-console` sugerujący, że linter był kiedyś w planach (albo skopiowany z innego projektu). Jedyną automatyczną bramką jakości jest `tsc --strict` (co samo w sobie jest niezłe — `noUnusedLocals`, `noUnusedParameters` są włączone), ale nie ma kontroli spójności stylu, martwego kodu czy typowych pułapek JS, których `tsc` nie łapie.

**Rekomendacja:** dodać ESLint (`typescript-eslint`) z regułą `no-console` egzekwowaną narzędziowo zamiast komentarzem, spiąć z `npm test`/CI.

### 5.3 [Niski/Informacyjny] `npm audit` niezweryfikowany

Nie mogłem uruchomić `npm audit` w tym środowisku (blokada sieciowa sandboxa). Zależności to tylko `@modelcontextprotocol/sdk ^1.29.0` i `zod ^3.24.1` w runtime — mała powierzchnia — ale status CVE nie został formalnie sprawdzony w ramach tego audytu.

**Rekomendacja:** uruchom `npm audit` (lub `npm audit --production`) lokalnie albo w CI przed najbliższym deployem.

### 5.4 [Niski, dokumentacja] `ATLASSIAN_ATTACHMENT_DIRS` — „colon-separated” nie zawsze prawdziwe

`.env.example` opisuje `ATLASSIAN_ATTACHMENT_DIRS` jako rozdzielane dwukropkiem, a implementacja (`config.ts`, `parseAttachmentDirs`) używa `node:path`'s `delimiter`, czyli faktycznie średnika (`;`) na Windows. Dla wdrożenia na Data Center/Linux to bez znaczenia, ale jeśli ktoś kiedyś uruchomi to na Windows, komentarz w `.env.example` go zmyli.

**Rekomendacja:** doprecyzować komentarz w `.env.example` („dwukropek na Linux/macOS, średnik na Windows — patrz `path.delimiter`”) albo świadomie wymusić `:` niezależnie od platformy.

### 5.5 [Niski, dokumentacja] Tryb read-only wyłącza też lokalne pobieranie załączników — niewyjaśnione w README

`jira_download_attachment` i `confluence_download_attachment` mają `kind: "local"`, a `tool()` w `index.ts` traktuje `kind !== "read"` tak samo jak write/destructive pod `ATLASSIAN_READ_ONLY` — czyli **read-only wyłącza też pobieranie załączników**, mimo że pobranie niczego nie zmienia w Jirze/Confluence. To rozsądna, konserwatywna decyzja projektowa (skoro dotyka lokalnego dysku), ale README opisuje `ATLASSIAN_READ_ONLY` wyłącznie w kontekście „refuse mutating tools” — operator może się spodziewać, że pobieranie plików nadal zadziała w trybie read-only, i się zdziwić.

**Rekomendacja:** jedno zdanie w README/`.env.example` przy `ATLASSIAN_READ_ONLY`, że obejmuje też narzędzia lokalne (`kind: "local"`), nie tylko zapis do Atlassiana.

---

## 6. Rzeczy sprawdzone i celowo NIE zgłoszone jako problem

Żeby uniknąć szumu — kilka rzeczy, które na pierwszy rzut oka mogłyby wyglądać podejrzanie, ale po analizie są poprawne:

- **Podwójna walidacja ścieżki w `downloadAttachment`** (raz w handlerze, raz wewnątrz `writeNewAttachment`) — nadmiarowe, ale nieszkodliwe; finalny `open()` z `O_EXCL|O_NOFOLLOW` i tak jest jedynym realnym punktem egzekwowania.
- **JQL/CQL przekazywane wprost od użytkownika** (`jira_search_issues`, `confluence_search_pages`) — to zamierzona funkcjonalność narzędzia wyszukującego, nie injection; uprawnienia i tak są egzekwowane po stronie Jiry/Confluence przez PAT.
- **Regexy w `storageToPlainText`** (parsowanie Confluence storage format) — używają leniwych `[\s\S]*?`, teoretycznie O(n) do O(n·m), nie ma tam zagnieżdżonych kwantyfikatorów dających katastrofalny backtracking. Przy bardzo dużych stronach to koszt CPU/pamięci, nie luka bezpieczeństwa typu ReDoS.
- **`getSprintReport`/greenhopper endpoint** — nieudokumentowany endpoint Jiry jest opakowany w `try/catch` zwracający `null` zamiast rzucać, z jasnym `scopeNote` tłumaczącym degradację — poprawna obsługa niepewnego API.

---

## 7. Rekomendowany plan działania

| Priorytet | Działanie | Nakład |
|---|---|---|
| 1 | Wydziel wspólny moduł `attachmentSecurity.ts` z `jiraClient.ts`/`confluenceClient.ts` (§5.1) | ~1–2h |
| 2 | Uruchom `npm audit` lokalnie/w CI, zweryfikuj wynik (§5.3) | ~15 min |
| 3 | Potwierdź `npm test` = 125/125 poza tym sandboxem (§4) | ~5 min |
| 4 | Dodaj ESLint + spięcie z CI (§5.2) | ~1h |
| 5 | Doprecyzuj README/`.env.example` w dwóch miejscach (§5.4, §5.5) | ~15 min |

Żadna z powyższych pozycji nie blokuje deploya na dzisiejszy stan — to porządkowanie długu, nie łatanie dziur.

---

## Załącznik A — Mapa narzędzi MCP (grupa / rodzaj)

**Nieaktualne — patrz Załącznik A w [`CODE-AUDIT-2.md`](CODE-AUDIT-2.md).**

Liczności podane tu pierwotnie (54 narzędzia, „5 destructive”, core 9, files 5,
write 5/10/3) nie zgadzały się z kodem już w chwili pisania: narzędzi
destrukcyjnych jest 6, grupa `core` liczy 11 pozycji, `files` 6. Rozbieżność
została wykryta w rundzie 2 audytu (pozycja D6 planu §9) i poprawiona wyłącznie
w Załączniku A tamtego dokumentu, gdzie mapa jest zweryfikowana empirycznie
przez `tools/list` w każdej kombinacji profilu i `ATLASSIAN_ALLOW_DESTRUCTIVE`.
Duplikowanie jej tutaj oznaczałoby dwa źródła prawdy i drugą okazję do
rozjechania się, więc ta sekcja jest teraz odsyłaczem, nie tabelą.

## Załącznik B — Statystyki repozytorium

```
src/concurrency.ts          35
src/config.ts               306
src/confluenceClient.ts     703
src/httpClient.ts           541
src/index.ts                1760
src/jiraAgileClient.ts      502
src/jiraClient.ts           1494
src/proforma.ts             107
__tests__/*.ts (8 plików)   2016
scripts/*.mjs                251
------------------------------
razem                       7715 linii
```

---

## 8. Status realizacji (25 sierpnia 2026, po audycie)

Wszystkie pięć pozycji z planu §7 zostało wykonanych w drzewie roboczym (bez commita).

| Poz. | Punkt | Status | Co zostało zrobione |
|---|---|---|---|
| 1 | §5.1 duplikacja logiki załączników | ✅ zrobione | Nowy moduł `src/attachmentSecurity.ts` (`assertAttachmentPathAllowed`, `assertAttachmentSize`, `writeNewAttachment`, `readExistingAttachment`, `DEFAULT_MAX_ATTACHMENT_BYTES`). Oba klienty wołają go bezpośrednio; `grep "O_NOFOLLOW\|realpath\|lstat" src/*.ts` daje trafienia wyłącznie w tym module. Wspólna suita `src/__tests__/attachmentSecurity.test.ts` (23 testy). |
| 2 | §5.3 `npm audit` | ✅ zrobione | `npm audit` → **0 vulnerabilities** (uruchomione lokalnie, poza sandboxem audytu). |
| 3 | §4 potwierdzenie `npm test` | ✅ zrobione | **146/146 przechodzi** na normalnym systemie plików. 19 „failów" z audytu potwierdzone jako artefakt środowiska: mount FUSE wymusza tryb `0600`, więc `chmodSync(ENV_FILE, 0o644)` w `config.test.ts` jest no-opem i test „refuses an environment file readable by other users" nie ma czego wykryć. Zero zmian w kodzie było potrzebne. |
| 4 | §5.2 ESLint | ✅ zrobione | `eslint.config.js` (flat config, ESLint 9 + typescript-eslint). `no-console: error` dla `src/**` egzekwowane narzędziowo; wyłączone tylko dla `scripts/*.mjs` (CLI operatorskie). `npm run lint` spięty z `npm test`. Wynik: 0 błędów, 72 ostrzeżenia (`no-explicit-any` w warstwie parsowania odpowiedzi Data Center — świadomy dług, celowo `warn`, nie `error`). |
| 5 | §5.4 + §5.5 dokumentacja | ✅ zrobione | `.env.example` i `README.md`: separator `ATLASSIAN_ATTACHMENT_DIRS` opisany jako `path.delimiter` (`:` na Linux/macOS, `;` na Windows); `ATLASSIAN_READ_ONLY` opisany jako obejmujący także narzędzia `kind: "local"`, tzn. `jira_download_attachment` i `confluence_download_attachment`. |

### 8.1 Zmiany wykraczające poza literalny zakres audytu

Trzy rzeczy wyszły przy okazji i zostały naprawione:

- **`no-useless-catch` w `src/httpClient.ts`** — w `execute()` była klauzula `catch (err) { throw err }` wewnątrz `try/catch/finally`. Usunięta; `finally` nadal zwalnia slot współbieżności na każdej ścieżce (return, throw, retry), a `await sleep(delay)` pozostaje poza `try/finally`, więc slot jest zwalniany przed backoffem. Zachowanie niezmienione.
- **Komunikat „colon-separated list of directories"** — ten sam nieprawdziwy na Windows opis, co w §5.4, żył też w treści błędu rzucanego przy pustym `ATLASSIAN_ATTACHMENT_DIRS`. Po konsolidacji z §5.1 istnieje w jednym miejscu i został poprawiony na opis zależny od platformy. Żaden test nie asercjonował starej treści.
- **`writeNewAttachment`: walidacja przed `mkdir`** — w wersji sprzed refaktoru `mkdir(dirname, {recursive:true, mode:0o700})` wykonywał się **przed** walidacją allowlisty. Było to nieszkodliwe, dopóki funkcja była prywatna i osiągalna wyłącznie ze zwalidowanej ścieżki w `downloadAttachment`; jako eksportowane API modułu oznaczałoby to, że wywołanie ze ścieżką spoza allowlisty tworzy po drodze katalogi (plik i tak by nie powstał). Dodano walidację **przed** `mkdir`, zachowując drugie, oryginalne wywołanie po `mkdir` — to ono pozostaje punktem egzekwowania, bo dopiero wtedy `realpath` rozwiązuje pełny łańcuch przodków i różnica `verifiedPath !== outputPath` wykrywa dowiązanie symboliczne w środku ścieżki. Kolejność jest więc: walidacja → `mkdir` → rewalidacja → `open(O_CREAT|O_EXCL|O_NOFOLLOW)`. Nowy test regresyjny: „creates no directories at all for a destination outside the allowlist".

Dodatkowo parametr `label` w `assertAttachmentPathAllowed` jest wymagany (a nie domyślny), tak jak w oryginalnej wersji z `jiraClient.ts` — komunikat błędu nie może cicho powiedzieć „outputPath" o pliku wejściowym.

### 8.2 Weryfikacja

Refaktor §5.1 przeszedł niezależny przegląd pod kątem równoważności semantycznej (znormalizowany diff funkcja po funkcji względem stanu sprzed refaktoru, nie oględziny). Potwierdzono zachowanie 1:1: kolejność sprawdzeń, pętla kanonizacji, obsługa `ENOENT`, subtelność `mustExist === true` (pominięcie bloku symlink/„already exists" i przepuszczenie `ENOENT` z `realpath`), flagi `open()`, tryby `0o600`/`0o700`, kontrola `verifiedPath !== outputPath`, logika `relative()`/`startsWith("..")`. Wszystkie komunikaty błędów niezmienione poza jednym opisanym w §8.1.

Bramki po zmianach: `npm run build` 0 błędów · `npm run lint` 0 błędów / 72 ostrzeżenia · `npm run test:unit` 146/146 · `npm run test:smoke` wszystkie kontrole zielone (48 narzędzi, 0 destrukcyjnych przy domyślnej konfiguracji).

### 8.3 Pozostawione świadomie

- **72 ostrzeżenia `no-explicit-any`** w warstwie parsowania odpowiedzi Jira/Confluence Data Center. Odpowiedzi DC są duże, zależne od wersji i tylko częściowo udokumentowane; wymuszenie typów tutaj to osobne zadanie, nie sprzątanie po audycie. Ostrzeżenie utrzymuje dług policzalny i widoczny, `error` zablokowałoby bramkę albo sprowokowało hurtowe `eslint-disable` na poziomie pliku.
- **`kind: "local"` bez osobnej flagi.** Operator chcący trybu analitycznego z pobieraniem załączników nie ma opcji pośredniej między `ATLASSIAN_READ_ONLY=false` a utratą obu narzędzi download. Obecne zachowanie jest teraz udokumentowane (§5.5); wprowadzenie trzeciego stanu to zmiana funkcjonalna do osobnej decyzji.

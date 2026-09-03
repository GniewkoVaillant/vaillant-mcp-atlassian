# Implementation report

**Project:** Vaillant MCP Atlassian — MCP server bridging GitHub Copilot to on-prem Jira Data Center and Confluence Data Center
**Repository:** `GniewkoVaillant/vaillant-mcp-atlassian` (private)
**Date:** 2026-08-25

**Reading note:** Sections 1-7 preserve the original historical report and its
measurements. The subsequent security-hardening phase supersedes historical
claims about deletion exposure, HTTP guarantees, tool counts and outstanding
features. Current controls and future Azure boundaries are documented in
`SECURITY-ARCHITECTURE.md`.

---

## 1. Where this started

The server already existed and worked. It was installed at `~/.copilot/mcp-servers/atlassian` and registered globally in `~/.copilot/mcp-config.json`, exposing 38 tools to GitHub Copilot over stdio.

Two things made it fragile:

1. **Only `dist/` existed.** No `src/`, no `tsconfig.json`, no git history, no README, no tests. `package.json` referenced a `scripts/smoke-test.mjs` and a `.env.example` that were never there. Every future change meant editing compiled JavaScript.
2. **It had grown outward, never inward.** Three waves of work had added capability, but nothing had addressed timeouts, retries, credential handling, context cost, or the read/write distinction.

---

## 2. What existed before this session

Recorded here because it is the reason the tool surface is shaped the way it is.

### Wave 1 — ProForma forms and PPM custom fields

| Tool | Purpose |
|---|---|
| `jira_list_proforma_forms` | List forms attached to an issue |
| `jira_get_proforma_form` | Decode one form into readable Q&A |
| `jira_get_proforma_forms_summary` | Decode every form on an issue |
| `jira_get_issue_fields` | Read named standard and custom fields |

**Why.** PPM project data lives in ProForma forms and custom fields, not in the issue description. Without these, an audit of a PPM ticket could not see the information that actually mattered — effort estimates, business value, scope descriptions.

**The interesting part.** The official ProForma API (`/rest/proforma/1.0/issue/{key}/forms`) returned `permissionViolation` for the available PAT. The implementation instead reads Jira **issue properties** (`proforma.forms`, `proforma.forms.i{id}`), which an ordinary PAT can access. Form designs are stored there as base64 split across numbered chunks, so `proforma.ts` reassembles them before decoding. This is why forms work at all without extra permissions.

### Wave 2 — Attachments, issue links, Confluence comments

| Area | Tools |
|---|---|
| Jira attachments | list, download, upload, delete |
| Jira issue links | list types, read, create, delete |
| Confluence comments | list, add, edit, delete |

**Why.** The PPM audit workflow needed supporting files, dependency relationships between tickets, and the ability to read and respond to discussions — all without leaving Copilot.

### Wave 3 — Agile, dev status, worklogs

Boards, sprints, velocity, story points, changelog, cycle time, GitHub dev-status, and a worklog tool targeting the `vaillant-timetracking` plugin.

Net effect across all three waves: **26 → 38 tools**.

---

## 3. Audit findings

Measured against the running server before any changes:

| # | Finding | Impact |
|---|---|---|
| 1 | No `src/`, no git | Unmaintainable |
| 2 | PATs plaintext in `mcp-config.json` | Credential exposure |
| 3 | No request timeouts | A hung connection blocked the server indefinitely |
| 4 | Attachment tools accepted any absolute path | Arbitrary local file read/write |
| 5 | No MCP annotations; no read-only mode | Client could not distinguish a lookup from a deletion |
| 6 | Searches capped at 100, no cursor or `total` | Truncated results looked complete |
| 7 | Field catalogue refetched on every call | Slow, wasteful |
| 8 | N+1 in `getBoardVelocity` | ~10 redundant round-trips for 5 sprints |
| 9 | Closed sprints assumed oldest-first | Wrong sprints selected if ordering differs |
| 10 | `committedPoints` measured current scope | Scope creep invisible |
| 11 | `Promise.all` unbounded in batch tools | 100+ concurrent requests possible |
| 12 | No retry on 429/5xx | Transient failures surfaced as hard errors |

Protocol handshake confirmed the client sees **tools only** — no `resources`, `prompts`, or `logging` capability — and that the full tool list costs **27 215 B (~6 800 tokens)** on every model request, with **0 of 38** tools annotated.

Usage analysis of the prior session showed roughly **9 of 38 tools** were ever actually called.

---

## 4. What changed

### 4.1 Source recovery (commit `ce077af`)

`src/*.ts` was reconstructed from the compiled output under `strict: true`.

**Verification.** Each recovered module was compiled back and compared against the original build. All five are byte-identical modulo whitespace and source-map comments — the recovery introduced no behavioural change. This mattered because the code was in production use; a silent regression during recovery would have been very hard to attribute later.

Two modules were rewritten deliberately rather than recovered verbatim:

- **`config.ts`** — added read-only mode, tool profiles, attachment allowlist, configurable timeout.
- **`httpClient.ts`** — four near-duplicate request paths (`atlassianGet`, `atlassianWrite`, `atlassianDelete`, `atlassianGetBinary`) collapsed into one `execute()`, then extended with abort-based timeouts and retry/backoff.

Also added: `tsconfig.json`, `.gitignore`, `.env.example`, `README.md`, a deploy script that backs up the previous build, and a smoke test.

**Retry design.** Retries honour `Retry-After` and fall back to exponential backoff. Idempotent methods (GET/PUT/DELETE) retry on 429 and 5xx. **POST retries only on 429**, because a 429 means the request was rejected before processing, whereas a timed-out or 502'd POST may already have created an issue. Replaying it would duplicate the write.

### 4.2 Annotations, profiles, allowlist (commit `8dc5f2c`)

**Annotations.** All 38 tools now carry `readOnlyHint`, `destructiveHint`, `idempotentHint` and `openWorldHint`. Previously "Read-only" existed only as prose in the description — a client had no machine-readable way to tell `jira_get_issue` from `jira_delete_attachment`, and therefore could not prompt before something destructive ran. Four tools are marked destructive.

This matters more here than in a typical MCP server: the established workflow involves reading **Jira comments written by other people**. That is untrusted input reaching a model that holds write credentials.

**Read-only mode.** `ATLASSIAN_READ_ONLY=true` refuses to *register* mutating tools at all, rather than failing at call time. A tool that does not exist cannot be talked into running.

**Attachment allowlist.** `ATLASSIAN_ATTACHMENT_DIRS` gates both upload and download. Paths are resolved before checking, so `..` cannot escape an allowed directory. **The allowlist is empty by default**, disabling filesystem access outright — the safe default, since the previous behaviour would have let a crafted ticket ask the agent to upload a private key.

**Profiles.** `ATLASSIAN_PROFILE` selects which tool groups are exposed, cutting the per-request context cost.

**Startup diagnostics.** The resolved surface is logged to stderr on boot. Without it, a profile typo silently hides tools and looks like a client bug.

### 4.3 Secrets, pagination, correctness (commit `2d7a4f2`)

**Secrets in `.env`.** The server reads a gitignored `.env` next to the install (or `ATLASSIAN_ENV_FILE`). `mcp-config.json` now holds `"env": {}`. Real environment variables still take precedence, so wrappers and CI can override. Only `.env.example` is committed.

The deployed `.env` is mode `600`. Tokens remain plaintext on disk — a Keychain-backed wrapper is the logical next step, and was explicitly accepted as out of scope for now.

**Search pagination.** Both search tools return `total`, `hasMore` and a cursor. Verified live: a search that previously returned a bare array of 2 issues now reports `total: 376, hasMore: true, nextStartAt: 2`. The old shape let the model summarise 20 of 376 matches and present it as the full picture.

**Sprint commitment.** `committedPoints` only ever described *current* scope. Work added on day 8 was indistinguishable from work committed on day 1, which makes the number actively misleading for retrospectives. The report now also pulls Jira's own greenhopper sprint report to expose `scope.initialCommittedPoints`, `scope.addedDuringSprintKeys` and `scope.removedKeys`. That endpoint is undocumented and restricted on some instances, so failure is caught and reported through `scopeNote` rather than thrown — and the tool description instructs the model to say so rather than pass current scope off as the commitment.

**Bounded concurrency.** `concurrency.ts` caps batch tools at 5 requests in flight. Tools accept up to 50 issue keys, each fanning out into several calls.

**Field cache.** Jira's instance-wide field catalogue is cached for 5 minutes.

**Velocity fixes.** The sprint list and estimation field are fetched once and passed down, instead of being refetched per sprint. Closed sprints are now sorted by end date rather than trusting API ordering.

### 4.4 Discovery tools, transitions, observability, tests (commit pending)

**Discovery gap closed.** Three tools required a board ID and nothing could produce one; a project key or space key had to be known before any query could be written. Added `jira_list_projects`, `jira_list_boards`, `confluence_list_spaces`, `confluence_get_page_by_title` (people cite pages by title, not ID) and `confluence_get_page_children` (walk a doc tree without guessing CQL).

**Transitions that explain themselves.** `jira_transition_issue` previously sent only a transition ID, so any workflow whose screen required a field — most commonly `resolution` — failed with a raw 400. It now accepts `fields`, and pre-checks the transition's required fields to fail with a message naming each missing field and its allowed values. `jira_get_transitions` exposes the same metadata up front. Matching also changed: destination status is tried first, then transition name, since a transition is often named differently from the status it leads to.

**Assignment.** `jira_assign_issue` added; reassignment previously meant hand-crafting an `update_issue` payload.

**Comment flooding.** `jira_get_issue` returned every comment inline. It now returns the most recent 30 by default and reports `commentTotal` and `commentsTruncated`, so bounding the response does not quietly hide the tail.

**Storage-format fidelity.** `storageToPlainText` flattened tables into run-on lines and discarded link targets, which made a Confluence decision table close to useless as a reference. Tables are now pipe-delimited per row, anchors render as `Label (url)`, `<ac:link>` page references become `[Title]`, and macros leave a `[macro: name]` marker.

`toStorageValue` decided "is this already markup?" with `/<[a-z][\s\S]*>/i`, which matches ordinary prose like `a < b and c > d`. Such text was passed through unescaped, producing invalid XHTML and a 400 on write. The check now requires a recognised tag name (including the `ac:`/`ri:` namespaces).

**Observability.** The server now declares the MCP `logging` capability and wraps every handler to emit `tool.start` / `tool.finish` with duration and outcome. Arguments are deliberately never logged — they routinely carry issue content. This was the gap that made the earlier usage analysis guesswork.

**Unit tests.** 43 tests using `node:test`, covering the logic where a regression would be quietest: ProForma chunk reassembly (including out-of-order chunks and every error path), cycle-time computation (including the reopen case, where the span must run from first start to last finish), storage-format conversion, `mapWithConcurrency` ordering and cap, and config/profile parsing. Cycle-time logic was extracted into a pure `computeCycleTime` so it could be tested without a Jira instance.

The regression tests that matter most are the two prose strings the old HTML heuristic misclassified.

---

## 5. Measured results

### Context cost per model request

| Profile | Tools | Payload | Tokens |
|---|---:|---:|---:|
| **Before (no profiles, 38 tools)** | 38 | 27 215 B | ~6 800 |
| `full` | 45 | 37 949 B | ~9 487 |
| `ppm` *(deployed)* | 36 | 29 388 B | ~7 347 |
| `core,forms,write` | 28 | 24 290 B | ~6 073 |
| `read` | 26 | 21 480 B | ~5 370 |
| `full` + read-only | 26 | 21 360 B | ~5 340 |
| `agile` | 19 | 16 715 B | ~4 179 |
| `core,forms` | 13 | 10 437 B | ~2 609 |
| `core` | 10 | 8 154 B | ~2 039 |

Seven new tools and richer descriptions pushed the full surface past the original baseline, which is the honest trade: more capability costs more context. Profiles are what make that affordable — the same server can present 2k or 9.5k tokens depending on the job.

**A note on the deployed profile.** `ppm` now costs ~7 347 tokens, above the original 6 800 baseline. `core,forms,write` would cover the workflow actually exercised so far (search, issue detail, custom fields, ProForma, commenting, Confluence read) at ~6 073, dropping only attachments and issue links. Those were added deliberately for PPM audits, so they were left enabled rather than quietly removed — but switching is a one-line change in `.env`.

### Other

| Metric | Before | After |
|---|---|---|
| Annotated tools | 0 / 38 | 38 / 38 |
| Request timeout | none | 30 s, configurable |
| Retry on 429/5xx | none | 3 attempts, `Retry-After` aware |
| Max concurrent batch requests | unbounded (100+) | 5 |
| Field catalogue fetches | 1 per call | 1 per 5 min |
| Velocity round-trips (5 sprints) | ~10 redundant | 0 redundant |
| Secrets in client config | 2 PATs | none |
| Tools | 38 | 45 |
| Unit tests | 0 | 43 |
| MCP capabilities | tools | tools + logging |
| Comments per issue response | all | 30 most recent, count reported |
| TypeScript sources | none | `strict`, 0 errors |

---

## 6. Verification

**Type safety.** `tsc --strict` reports 0 errors.

**Recovery fidelity.** All five recovered modules compile to semantically identical JavaScript.

**Smoke test** (`npm test`) — boots the built server, asserts tool count, asserts 100% annotation coverage, and performs live read-only calls against both Jira and Confluence. Passing.

**Security guards**, exercised against the running server:

| Attempt | Result |
|---|---|
| Upload `/etc/hosts`, allowlist empty | `Attachment access is disabled.` |
| Upload `/etc/hosts`, allowlist `/tmp/safe` | `outside the allowed directories` |
| Traversal `/tmp/safe/../../etc/hosts` | `outside the allowed directories` |
| `jira_add_comment` under `ATLASSIAN_READ_ONLY=true` | `Tool not found` |

**Pagination**, live against Jira: `{ startAt: 0, returned: 2, total: 376, hasMore: true, nextStartAt: 2 }`.

**Deployment.** Build deployed to `~/.copilot/mcp-servers/atlassian/dist` with the previous build retained as a timestamped backup. Server confirmed booting from `.env` with no environment variables set.

---

## 7. What remains

**Security.** Tokens are plaintext in `.env` (mode 600). A Keychain-backed wrapper script would remove that.

**Missing tools.** No bulk operations (`bulk_update`), no worklog listing or deletion, no watcher management, no Confluence attachment or page-history access, no `delete_page`.

**Known weak spots.**
- `jira_add_worklog_with_category` cannot move a worklog from `TRACKED` to `SUBMITTED`; the plugin exposes no REST endpoint for it.
- `storageToPlainText` is regex-based. It now preserves links, tables and macro names, but it is not a parser and will mishandle deeply nested or unusual markup.
- Sprint scope depends on the undocumented greenhopper endpoint. Where it is blocked, only current scope is available — reported explicitly, but still a gap.
- `jira_get_issue_fields` with no `fieldNames` still fetches every non-bulky field on the issue, which can be a large response on PPM tickets.

**Dead code.** Writing the ProForma tests surfaced that the "Missing chunk N/M" branch in `decodeProformaDesign` is unreachable: a gap in the chunk set is always caught earlier by the incomplete-set check. Harmless, but it is not the safety net it appears to be.

**Historical testing at that phase.** The early suite contained 43 unit tests.
The current suite also covers the HTTP retry/deadline layer, bounded queues,
redirect policy, binary response limits, pagination and server policy. Current
verification results are recorded below rather than inferred from that early
snapshot.

**Security.** Tokens are plaintext in `.env` (mode 600) — see above.

---

## 8. Security-hardening phase and multi-agent handoff

### Decisions

- Destructive tools are disabled by default and require the explicit
  `ATLASSIAN_ALLOW_DESTRUCTIVE=true` operator override. Read-only mode and the
  named `read` profile always take precedence.
- Upstream availability protection applies to the whole Jira/Confluence
  process: finite concurrency, finite waiting queue, one end-to-end deadline,
  bounded retry delay, bounded ProForma fan-out and capped Agile pagination.
- Attachment operations are deny-by-default, canonical-path constrained,
  symlink-aware, size-limited and protected against accidental overwrite.
- Local credentials require HTTPS upstream URLs and a private Unix `.env`.
  Correlated invocation telemetry excludes PATs, arguments and content.
- Azure/Entra deployment requires one verified Jira PAT and one verified
  Confluence PAT per authenticated user; a shared service PAT cannot satisfy
  per-user upstream permissions or audit attribution.

### Configuration contract

| Setting | Default | Control |
|---|---:|---|
| `ATLASSIAN_ALLOW_DESTRUCTIVE` | `false` | Delete tools are not registered |
| `ATLASSIAN_TIMEOUT_MS` | `30000` | One upstream HTTP attempt |
| `ATLASSIAN_TOTAL_TIMEOUT_MS` | `45000` | Queueing, retry and total request budget |
| `ATLASSIAN_MAX_CONCURRENT_REQUESTS` | `4` | Shared upstream concurrency |
| `ATLASSIAN_MAX_QUEUED_REQUESTS` | `16` | Finite waiting queue |
| `ATLASSIAN_MAX_ATTACHMENT_BYTES` | `10485760` | Attachment maximum size |
| `ATLASSIAN_MAX_PAGINATION_PAGES` | `10` | Automatic pagination budget: Jira Agile, Jira changelog and Confluence |
| `ATLASSIAN_MAX_JSON_BYTES` | `16777216` | Largest buffered upstream JSON response |
| `ATLASSIAN_MAX_TOOL_RESULT_BYTES` | `150000` | Tool result ceiling; excess is truncated with a marker |
| `ATLASSIAN_SMOKE_LIVE` | `false` | Explicit opt-in for authenticated live smoke checks |

### Verification boundaries

The default unit suite must exercise destructive-tool exclusion, the enforced
read-only profile, configuration validation, protected local environment
files, bounded HTTP behavior, safe attachment paths and bounded pagination.
The stdio smoke test validates MCP discovery without making upstream calls.
Authenticated, read-only Jira/Confluence checks require the explicit
`ATLASSIAN_SMOKE_LIVE=true` opt-in.
No write, delete or deployment operation is required to validate this phase.

### Verified results

| Check | Result |
|---|---|
| Strict TypeScript check | `npx tsc -p tsconfig.json --noEmit` passed |
| Complete local suite | `npm test`: 125 tests passed; 0 failures |
| HTTP resilience regressions | 40 tests passed, including queue, deadlines, redirect and binary-size cases |
| Default MCP surface | 48 tools; 18 non-read tools; 0 destructive tools; approximately 10,125 tokens |
| Existing installation configuration | 39 tools; 0 destructive tools; approximately 7,985 tokens |
| Named `read` profile | 30 tools; 0 mutations; 0 destructive tools; approximately 6,010 tokens |
| Explicit destructive opt-in | 54 tools; 6 destructive tools; approximately 11,110 tokens |
| Read-only plus destructive opt-in | 30 tools; 0 mutations; 0 destructive tools |
| Existing installation `.env` compatibility | Startup and MCP handshake passed; token values were never displayed |
| Live Jira/Confluence traffic | Not performed; intentionally disabled without explicit opt-in |
| Deployment to an active MCP installation | Not performed; requires a separately authorized deployment |

### Remaining work

Azure hosting, Streamable HTTP, Entra authentication, personal PAT enrollment,
Key Vault isolation, distributed rate limiting and durable attributed audit
storage remain future work. The executable implementation sequence, identity
and network design, acceptance tests, release gates and rollback procedure are
recorded in `AZURE-DEPLOYMENT.md`. Trust boundaries remain in
`SECURITY-ARCHITECTURE.md`; repository collaboration rules are recorded in the
project-root `AGENTS.md`.

## 9. API coverage expansion

### The gap

The server covered issue reading, ProForma, agile reporting and Confluence
content well, and almost nothing else Jira and Confluence publish. Three
consequences mattered:

1. **The write tools operated blind.** `jira_create_issue` and
   `jira_update_issue` accepted a project, an issue type and a field bag with no
   way to discover what that screen actually requires. Jira answers a bare 400
   naming a custom field ID, which an agent cannot act on.
2. **Every person-shaped argument was unresolvable.** `jira_assign_issue`,
   `jira_add_watcher` and filter sharing all take a Data Center *username*,
   which rarely matches the display name anyone knows. Nothing could translate
   one into the other.
3. **Whole product areas were invisible.** Saved filters, Service Management
   queues and SLAs, backlog and sprint planning, Confluence labels, spaces,
   version history and trash had no representation at all.

### What was added

Seven registration modules under `src/tools/`, backed by four new clients and
extensions to three existing ones. The tool count went from 48 to 133 (150 with
the destructive opt-in).

| Area | Client | Notable capability |
|---|---|---|
| Metadata and project configuration | `jiraMetaClient.ts` | `createmeta`/`editmeta`, field catalogue, dictionaries, JQL autocomplete, version and component CRUD |
| User and group directory | `jiraDirectoryClient.ts` | user search, assignable-user search, group members, effective permissions — read-only |
| Saved filters and dashboards | `jiraFilterClient.ts` | filter CRUD, share permissions, favourites, dashboards |
| Agile planning | `jiraAgileClient.ts` (extended) | backlog, board issues, epics, sprint CRUD, sprint/backlog moves, ranking |
| Service Management | `jiraServiceDeskClient.ts` | service desks, request types and their fields, queues, SLAs, approvals, request creation and comments |
| Issue extras | `jiraClient.ts` (extended) | bulk create, remote links, notifications, votes, worklog edits, issue properties |
| Confluence | `confluenceClient.ts` (extended) | global search, page hierarchy, export, version read and restore, move, spaces, labels, restrictions (read), content properties, watches, trash, uploads |

`index.ts` keeps the policy gate and the original tool set; each new module
receives the same registrar, so the decision about what is exposed still lives in
exactly one place.

### Endpoints verified rather than assumed

Data Center diverges from Cloud in ways that are easy to get wrong, so the
endpoint set was checked against Atlassian's Data Center references (Jira
platform 9.12, Jira Software agile, JSM 5.12, Confluence 8.5) before
implementation. Four findings changed the design:

- **`/rest/api/2/filter/search` does not exist on Jira DC 9.x.**
  `jira_search_filters` therefore degrades to filtering the caller's favourites
  and reports `source` so a short answer is not mistaken for "no such filter".
- **The v2 filter resource has no favourite sub-resource.** Atlassian's own
  documentation redirects to `/rest/api/1.0/filters/{id}/favourite`, which is
  what `jira_set_filter_favourite` uses.
- **Confluence DC documents no restriction *write* endpoint** — only
  `restriction/byOperation` reads — and no endpoint that lists a page's
  watchers. Both are exposed read-only or not at all rather than implemented
  against a Cloud path that would fail. Page templates are likewise Cloud-only.
- **Jira 9 removed the global `createmeta`.** `jira_get_create_meta` tries the
  legacy endpoint, falls back to the per-project pair on 404/410, and reports
  which answered.

### Rich Filters: deliberately not implemented

The request that started this work named `jira_create_rich_filter` and
`jira_get_rich_filter`. Those are not Jira APIs. They belong to the Marketplace
app *Rich Filters for Jira Dashboards* (`com.qotilabs.jira.rich-filters-plugin`,
originally Digital Toucan / Qoti Labs, now published by Appfire).

The app publishes **no public REST API**. A Marketplace metadata check found no
API documentation module, the vendor's old documentation host no longer
resolves, and a GitHub-wide code search for a plausible `rest/rf/1.0` base path
returned nothing. Implementing against a guessed namespace would produce tools
that fail on every instance, or worse, silently hit an internal endpoint with no
compatibility guarantee. The correct next step, if this is still wanted, is to
read the installed app's `atlassian-plugin.xml` for its `<rest>` module and ask
Appfire whether that namespace is supported.

### Defect found while testing

`confluence_restore_page_version` initially compared the historical version
against the *next* version number rather than the current one, so restoring the
live version would have been accepted: a no-op PUT that burns a page version and
notifies every watcher. The regression test now pins the correct comparison.

### Testing the tool surface, not just the clients

The unit tests exercise the clients directly, which left the layer the model
actually touches untested: MCP registration, the Zod schemas, the cross-field
`validate` preconditions, the mapping of a client result into a tool result, and
the error path. A tool can be correct at the client level and still be
unreachable, wired to the wrong method, or hidden by its profile.

`toolSurface.test.ts` therefore boots the **built server over stdio**, points it
at a stub that answers like a Data Center instance, and drives 28 checks through
the MCP protocol — the same path a model takes. It covers a representative slice
of every new area, and asserts the things that are invisible from the client
layer: that a malformed issue key is refused by the schema *before* any request
reaches the network, that `jira_notify_issue` cannot send mail without a
recipient, that `jsm_add_request_comment` will not default the customer-visibility
decision, that the JSM experimental header travels with the request without
displacing the configured identity, that an upstream 404 becomes a readable
error result rather than a crash, and that a malformed payload names the
resource instead of raising a `TypeError`.

**The suite was then checked for teeth.** Three deliberate defects were
introduced one at a time and each was caught by exactly the test that should
have caught it:

| Injected defect | Detected by |
|---|---|
| `createmeta` allowed-value cap raised from 50 to 500 | `jira_get_create_meta` payload-cap assertion |
| JSM `X-ExperimentalApi` header dropped | `jsm_add_request_comment` header assertion |
| Historical storage markup re-escaped on version restore | `confluence_restore_page_version` macro-survival assertion |

All three files were restored and verified byte-identical to the committed
version afterwards.



The suite could not honestly gate anything on Windows, and part of it could not
gate anything anywhere.

`serverPolicy.test.ts` failed to boot the server at all — it passed
`URL.pathname` to `spawn`, which yields `/C:/…`. Every one of its eleven
security-policy assertions was therefore reporting `Connection closed` rather
than checking a policy. Fixed with `fileURLToPath`.

Two attachment-safety assertions interpolated a filesystem path straight into a
`RegExp`. On Windows the backslashes became regex escapes, so the test failed
against an error message that was in fact correct — a false negative in the
worst direction, because it reports a defect where there is none and buries a
real one in noise. Both now escape the path.

The `httpClient` timeout tests were **non-deterministic**: identical code
produced 0, 0, 2, 1, 0 failures across five consecutive runs, and `main`
behaved the same way. The cause was a 20 ms per-attempt timeout that forced a
race — an *answered* request had to complete a loopback round trip inside the
same budget that an unanswered one had to exceed. They were rewritten so the
timeout fires because the stub stays silent rather than because the clock won,
and so assertions about "no retry happened" wait for the attempt and then give
a retry room to appear instead of sampling immediately. Eight consecutive runs
now pass.

The remaining POSIX-only tests (FIFO, unix domain socket, character device,
symlinks, mode bits) are gated on runtime capability probes in
`testServer.ts` rather than weakened or deleted. On Linux and CI every one of
them still runs; where the primitive cannot exist, the test reports why it was
skipped. The `ATLASSIAN_ATTACHMENT_DIRS` test no longer hard-codes `:` — it
builds its input from `path.delimiter`, which is the contract the loader
actually implements and the reason it must not split on a colon: `C:\data`
contains one.

Result: the full gate now passes with **zero failures** on Windows as well as
CI, and nothing was skipped that a supported platform can run.

### Versioning

Released as **1.2.0**. The change is large but strictly additive: no tool was
removed, no input schema narrowed, and no existing tool's behaviour changed, so
a minor bump is correct rather than a major one. Two caveats an upgrader should
know:

- `ATLASSIAN_PROFILE=ppm` and `=agile` now resolve to more groups than before
  (`meta` and `users` were added to both), so an unchanged configuration gets a
  larger tools/list payload after the upgrade. `ATLASSIAN_PROFILE=classic`
  reproduces the previous surface exactly.
- The default `full` profile roughly triples in size. This is the single change
  most likely to be felt, and it is a context-cost change, not a behavioural one.

The version was also drifting: `package.json` said 1.1.1 while the MCP handshake
still announced 1.1.0, so every client logged a version matching no release.
`serverPolicy.test.ts` now asserts the two agree.

### Verified results

| Check | Result |
|---|---|
| Strict TypeScript check | `tsc -p tsconfig.json --noEmit` passed |
| Lint | `npx eslint . --max-warnings 91`: 0 errors, 91 warnings — two *below* the pre-existing CI ceiling, which was lowered to match |
| Unit tests | 510 tests; 495 passed; **0 failed**; 15 skipped, each with a recorded capability reason |
| End-to-end tool surface | 28 checks driving the built server over stdio through MCP against a stub Data Center; all pass |
| Mutation check | 3 deliberate defects injected one at a time, each caught by the intended assertion; all files restored byte-identical |
| Determinism | The `httpClient` timeout suite was intermittently red — 2 failures across 5 runs, on `main` as well. After the rewrite it passed 8 consecutive runs, then three consecutive full-gate runs |
| New tests | 65 added across `jiraExtendedClients.test.ts`, `confluenceExtended.test.ts`, `toolSurface.test.ts`, `config.test.ts`, `httpClient.test.ts` and `serverPolicy.test.ts` |
| Default MCP surface | 133 tools; approximately 30,200 tokens |
| `classic` profile | 86 tools; approximately 20,100 tokens |
| `ppm` profile | 94 tools; approximately 21,100 tokens |
| `agile` profile | 66 tools; approximately 14,200 tokens |
| `service` profile | 42 tools; approximately 9,100 tokens |
| `read` profile | 85 tools; 0 mutations; approximately 17,100 tokens |
| `core` profile | 24 tools; approximately 4,900 tokens |
| Explicit destructive opt-in | 150 tools; 17 destructive tools; approximately 33,500 tokens |
| Read-only plus destructive opt-in | 85 tools; 0 destructive tools — read-only still wins |
| Live Jira/Confluence traffic | **Not performed.** No endpoint added here has been exercised against a real Data Center instance |
| Deployment | Not performed |

### Residual risk

Every new endpoint is verified against documentation and synthetic servers, not
against a live instance. Data Center versions differ, apps alter behaviour, and
permissions vary per project and space. Before relying on the write tools in
anger, run `ATLASSIAN_SMOKE_LIVE=true npm run test:smoke` against the target
instance and exercise the specific tools you intend to use on a scratch project
and a scratch space — particularly `jira_bulk_create_issues`, the sprint writes
and anything touching Confluence spaces.

Context cost is the other live risk. At 133 tools the default profile spends
roughly 30k tokens on tool definitions before any question is asked. Choose a
profile.

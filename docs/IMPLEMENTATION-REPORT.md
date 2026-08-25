# Implementation report

**Project:** Vaillant MCP Atlassian — MCP server bridging GitHub Copilot to on-prem Jira Data Center and Confluence Data Center
**Repository:** `GniewkoVaillant/vaillant-mcp-atlassian` (private)
**Date:** 2026-08-25

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

---

## 5. Measured results

### Context cost per model request

| Profile | Tools | Payload | Tokens |
|---|---:|---:|---:|
| **Before (no profiles)** | 38 | 27 215 B | ~6 800 |
| `full` | 38 | 32 232 B | ~8 058 |
| `ppm` *(deployed)* | 30 | 24 403 B | ~6 101 |
| `read` | 21 | 17 692 B | ~4 423 |
| `agile` | 14 | 12 927 B | ~3 232 |
| `core` | 6 | 5 098 B | ~1 275 |
| `full` + read-only | 20 | 16 795 B | ~4 199 |

Annotations added ~1 250 tokens to the full surface. Profiles more than repay it: the deployed `ppm` profile is below the original baseline while carrying strictly more metadata, and `agile` or `core` cut the cost by 2.5–5×.

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
| TypeScript sources | none | 3 758 lines, `strict`, 0 errors |

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

**Missing tools.** There is no `list_boards` or `list_projects`, yet three tools require a board ID — it has to be known up front. Also absent: `get_transitions` (preview before transitioning), `assign_issue`, `list_spaces`, `get_page_by_title`, `get_page_children`.

**Known weak spots.**
- `jira_transition_issue` cannot supply fields required by a transition screen, so any workflow demanding `resolution` fails.
- `toStorageValue` decides "is this HTML?" with a loose regex; plain text containing `<` or `>` can slip through unescaped.
- `storageToPlainText` flattens tables, macros and link targets.
- `jira_get_issue` returns all comments inline with no paging.

**Observability.** The server does not declare the MCP `logging` capability, so tool invocations leave no trace in client logs. Adding it would make usage measurable rather than inferred.

**Tests.** The smoke test covers startup, surface and connectivity. There are no unit tests for the trickier pure logic — ProForma chunk reassembly, cycle-time computation, storage-format conversion — which is where regressions would be quietest.

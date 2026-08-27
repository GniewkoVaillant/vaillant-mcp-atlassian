# Vaillant MCP Atlassian

MCP server that connects GitHub Copilot (or any MCP client) to an **on-prem Jira Data Center** and **Confluence Data Center** instance using Personal Access Tokens.

Transport is stdio; the server is launched directly by the MCP client.

## Why this exists

This server talks exclusively to organization-managed Jira Data Center and
Confluence Data Center REST APIs and adds a few things the plain APIs make
awkward:

- **ProForma forms** are read through issue properties (`proforma.forms*`), including the chunked base64 design blobs. This works with an ordinary PAT, whereas `/rest/proforma/1.0/` returns `permissionViolation` for most users.
- **Story points** are resolved from the board's configured estimation field, so reports work on Kanban boards too.
- **Dev status** (branches, PRs, commits) comes from Jira's own development panel rather than text-matching issue keys against commit messages. Commit messages are returned in full so `Co-authored-by:` trailers stay visible.
- **Cycle time** is computed from real status-transition history instead of the misleading `created`/`updated` pair.

## Setup

```bash
npm install            # the `prepare` script builds dist/ as part of the install
cp .env.example .env   # fill in URLs and tokens
chmod 600 .env         # required for local credential protection
npm test               # offline lint, unit and MCP-protocol checks
```

`.env` is gitignored; only `.env.example` is committed.

`npm install` (and `npm install <git-url>`) runs `prepare`, which builds via
`tsconfig.build.json`: `dist/` without `dist/__tests__` and without source maps.
`npm run build` uses the full `tsconfig.json` and is what the test scripts call,
because the unit suite runs against the compiled `dist/__tests__/*.test.js`. The
published `files` list ships `dist` but excludes `dist/__tests__` and `*.map`.

On macOS and Linux, the server rejects a `.env` readable by another user. Set
`chmod 600 .env` before the first start. Jira and Confluence base URLs must use
HTTPS; plain HTTP is accepted only for local loopback development servers.

`npm test` builds the server, runs unit tests and checks the local MCP protocol
without contacting Jira or Confluence. Authenticated, read-only upstream checks
require explicit opt-in: `ATLASSIAN_SMOKE_LIVE=true npm run test:smoke`.

### Registering with GitHub Copilot

Add to `~/.copilot/mcp-config.json`:

```jsonc
{
  "mcpServers": {
    "atlassian": {
      "type": "local",
      "command": "node",
      "args": ["/absolute/path/to/dist/index.js"],
      "tools": ["*"],
      "env": {}
    }
  }
}
```

Then restart the Copilot app (not just the session).

`npm run deploy` builds and copies the result into `~/.copilot/mcp-servers/atlassian/dist`, backing up the previous build first.

### Where secrets live

The client config holds **no credentials**. On startup the server reads a `.env` sitting next to the install (`<install root>/.env`, i.e. one level above `dist/`), or the path in `ATLASSIAN_ENV_FILE`. Keep that file at mode `600`.

Real environment variables always win over the file, so a wrapper script or CI can override any value.

This keeps tokens out of `mcp-config.json`, which is otherwise easy to share,
sync or accidentally commit. Tokens remain plaintext on disk, so `.env` is
appropriate only for local single-user development, never shared Azure hosting.

## Configuration

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `JIRA_BASE_URL` | yes | — | Jira DC base URL |
| `JIRA_PAT` | yes | — | Jira personal access token |
| `CONFLUENCE_BASE_URL` | yes | — | Confluence DC base URL |
| `CONFLUENCE_PAT` | yes | — | Confluence personal access token |
| `ATLASSIAN_ENV_FILE` | no | `<install root>/.env` | Where to read the above from |
| `ATLASSIAN_READ_ONLY` | no | `false` | Refuse every mutating tool, and every local-filesystem tool (attachment downloads) |
| `ATLASSIAN_ALLOW_DESTRUCTIVE` | no | `false` | Explicitly expose delete tools; read-only mode still overrides this |
| `ATLASSIAN_PROFILE` | no | `full` | Which tool groups to expose |
| `ATLASSIAN_ATTACHMENT_DIRS` | no | *(empty)* | Absolute, non-root directories available for attachments; separated by `path.delimiter` (`:` on Linux/macOS, `;` on Windows) |
| `ATLASSIAN_MAX_ATTACHMENT_BYTES` | no | `10485760` | Reject attachments larger than 10 MiB |
| `ATLASSIAN_TIMEOUT_MS` | no | `30000` | Maximum duration of one HTTP attempt |
| `ATLASSIAN_TOTAL_TIMEOUT_MS` | no | `45000` | Entire request deadline, including queueing, attempts and retry delays |
| `ATLASSIAN_MAX_CONCURRENT_REQUESTS` | no | `4` | Process-wide limit on simultaneous Jira/Confluence requests |
| `ATLASSIAN_MAX_QUEUED_REQUESTS` | no | `16` | Maximum waiting requests; use `0` to reject immediately under contention |
| `ATLASSIAN_MAX_PAGINATION_PAGES` | no | `10` | Maximum automatically fetched pages per auto-paginating operation: Jira Agile (boards, sprints, sprint issues), Jira changelog (`jira_get_issue_changelog`, `jira_get_issue_cycle_time`) and Confluence (`confluence_list_spaces`, `confluence_get_page_children`, `confluence_list_comments`). The default of 10 pages is ~1000 rows, which is roughly where Data Center stops serving anyway (page size is 100 across the REST API, and many collections cannot be read past ~1k), so exhausting the budget is normally a signal that the upstream is not reporting the end of the collection |
| `ATLASSIAN_MAX_JSON_BYTES` | no | `16777216` | Reject a Jira/Confluence JSON response body larger than 16 MiB instead of buffering it |
| `ATLASSIAN_MAX_TOOL_RESULT_BYTES` | no | `150000` | Truncate a tool's text result above this size, with an explicit in-band truncation marker |
| `ATLASSIAN_SMOKE_LIVE` | no | `false` | Explicitly enable authenticated, read-only upstream smoke checks |

### Tool profiles

Every exposed tool costs context on **every** model request. Narrow the surface
to what you actually use; `npm run test:smoke` reports the current tool count
and an approximate context cost.

| Profile | Groups | Use case |
|---|---|---|
| `full` | everything | default |
| `ppm` | core, forms, write, files, links | PPM/project audits |
| `agile` | core, agile, dev | sprint and velocity reporting |
| `read` | all groups, read-only tools only | enforced read-only analysis including worklogs and attachment listings |
| `core` | core | issue and page lookup only |

You can also pass a raw comma-separated group list, e.g. `ATLASSIAN_PROFILE=core,agile`. The `core` group is always included.

Verified current discovery payloads are approximately 10,754 tokens for the
default `full` profile (48 tools), 8,582 for `ppm` (39 tools), and 6,296 for
`read` (30 read-only tools). Explicit destructive opt-in raises `full` to 54
tools and approximately 11,802 tokens.

### Safety

MCP annotations describe a tool to the client; **they are not authorization**.
Jira descriptions, comments and Confluence pages are untrusted input and may
contain prompt-injection attempts. Actual safeguards are enforced server-side:

- Delete tools are absent unless `ATLASSIAN_ALLOW_DESTRUCTIVE=true` is explicitly configured.
  That flag is the gate, and it governs exactly the six `*_delete_*` tools. It is
  not the same thing as the `destructiveHint` annotation: seven overwriting tools
  (`jira_update_issue`, `jira_assign_issue`, `jira_edit_comment`,
  `jira_remove_watcher`, `jira_transition_issue`, `confluence_update_comment`,
  `confluence_update_page`) also carry `destructiveHint: true`, because they
  replace existing data in place. The hint describes behaviour to the client; it
  withholds nothing. Those seven remain registered with
  `ATLASSIAN_ALLOW_DESTRUCTIVE=false` and are removed only by
  `ATLASSIAN_READ_ONLY=true` or `ATLASSIAN_PROFILE=read`.
- `ATLASSIAN_READ_ONLY=true` removes all mutating and local-filesystem tools;
  `ATLASSIAN_PROFILE=read` also forces read-only mode. Local-filesystem tools
  means `jira_download_attachment` and `confluence_download_attachment` are
  withheld as well: read-only mode deliberately covers writes to the local disk,
  not only writes to Jira and Confluence.
- Attachment access is disabled unless `ATLASSIAN_ATTACHMENT_DIRS` contains
  explicitly approved absolute directories. Canonical paths, symlink rejection,
  no-overwrite downloads and size limits protect those directories.
- A shared concurrency limiter, bounded queue, complete request deadline and
  pagination budget protect both the MCP process and the upstream DC servers.
- Response and result sizes are bounded in two places: `ATLASSIAN_MAX_JSON_BYTES`
  refuses an oversized upstream JSON body before it is buffered, and
  `ATLASSIAN_MAX_TOOL_RESULT_BYTES` caps what any tool hands back to the model.
- Credentials require HTTPS, remain bound to the configured origin, and never
  appear in tool invocation logs.

Explicitly enabling destructive tools is an operator-controlled escape hatch,
not independently verified human approval. Leave them disabled during normal
work; MCP-client confirmation behavior is not a security boundary.

For trust boundaries, operational controls and residual risks, see
[docs/SECURITY-ARCHITECTURE.md](docs/SECURITY-ARCHITECTURE.md). The detailed,
production-gated Azure/Entra deployment design is in
[docs/AZURE-DEPLOYMENT.md](docs/AZURE-DEPLOYMENT.md).

## Tool groups

| Group | Tools |
|---|---|
| `core` | `jira_list_projects`, `jira_search_issues`, `jira_get_issue`, `jira_get_issue_fields`, `confluence_list_spaces`, `confluence_search_pages`, `confluence_get_page`, `confluence_get_page_by_title`, `confluence_get_page_children`, `confluence_list_comments`, `confluence_get_page_history` |
| `forms` | `jira_list_proforma_forms`, `jira_get_proforma_form`, `jira_get_proforma_forms_summary` |
| `write` | `jira_create_issue`, `jira_update_issue`, `jira_assign_issue`, `jira_get_transitions`, `jira_add_comment`, `jira_edit_comment`, `jira_delete_comment`, `jira_transition_issue`, `jira_list_worklogs`, `jira_delete_worklog`, `jira_list_watchers`, `jira_add_watcher`, `jira_remove_watcher`, `jira_add_worklog`, `jira_add_worklog_with_category`, `confluence_create_page`, `confluence_update_page`, `confluence_add_comment`, `confluence_update_comment`, `confluence_delete_comment`, `confluence_delete_page` |
| `files` | `jira_list_attachments`, `jira_download_attachment`, `jira_upload_attachment`, `jira_delete_attachment`, `confluence_list_attachments`, `confluence_download_attachment` |
| `links` | `jira_list_issue_link_types`, `jira_get_issue_links`, `jira_create_issue_link`, `jira_delete_issue_link` |
| `agile` | `jira_list_boards`, `jira_get_board_sprints`, `jira_get_sprint_report`, `jira_get_board_velocity`, `jira_get_issues_story_points` |
| `dev` | `jira_get_issue_changelog`, `jira_get_issue_cycle_time`, `jira_get_issue_dev_status`, `jira_get_issues_dev_status` |

Every `*_delete_*` tool listed above is excluded from the actual MCP tool surface
unless destructive tools are explicitly enabled.

## Architecture

```
src/
  config.ts            .env loading, profiles, read-only, allowlist
  httpClient.ts        auth, timeouts, retry/backoff, same-origin guard, response budgets
  jiraClient.ts        issues, fields, ProForma, attachments, links, worklogs
  jiraAgileClient.ts   boards, sprints, velocity
  confluenceClient.ts  pages, comments, storage-format conversion (htmlparser2)
  proforma.ts          chunked base64 form-design decoding
  concurrency.ts       bounded parallelism for batch tools
  attachmentSecurity.ts  the only place that touches the local filesystem: path
                         canonicalization, symlink/hard-link/FIFO refusal, atomic create
  upstreamShape.ts     shape guards for Data Center responses: a malformed payload
                       raises a domain error naming the resource, never a TypeError
  jiraPagination.ts    the shared Jira paging walk: page budget, stalled-cursor and
                       repeated-page detection; raises rather than returning partial data
  index.ts             MCP tool registration, per-tool validation, result size clamp
```

`httpClient.ts` refuses to send credentials to any origin other than the configured base URL, which stops a malicious `content` URL in an API response from exfiltrating the PAT.

## Behaviour worth knowing

**Searches report truncation.** `jira_search_issues` and `confluence_search_pages` return `total`, `hasMore` and a `nextStartAt`/`nextStart` cursor alongside the results. Without that, a capped page is indistinguishable from a complete answer, and conclusions get drawn from partial data.

**Confluence list tools return an object, not a bare array.** `confluence_list_spaces`, `confluence_get_page_children` and `confluence_list_comments` return `{ start, limit, returned, total, hasMore, nextStart, … }` with the items under `spaces`, `children` and `comments` respectively — the same pagination envelope `confluence_search_pages` already used. These three auto-paginate internally up to the `limit` you ask for, so they take no `start` argument: when `hasMore` is true, raise `limit` rather than passing `nextStart` back in.

**Sprint reports separate commitment from scope creep.** `committedPoints` is the sprint's scope *right now*, so it quietly absorbs anything added mid-sprint. When Jira's own sprint report is reachable, `scope.initialCommittedPoints` gives the real commitment and `scope.addedDuringSprintKeys` lists what arrived later. That endpoint is undocumented and restricted on some instances, so `scope` may be `null`; `scopeNote` always says which case you are in.

**Request pressure is bounded globally.** Batch operations use bounded worker
pools, and every Jira/Confluence HTTP request also shares the process-wide
upstream concurrency and queue limits. ProForma chunk fan-out is bounded too.

**Automatic pagination fails closed.** Boards, sprints and sprint issues on the
Jira Agile side, issue changelogs on the Jira side, and spaces, child pages and
comments on the Confluence side, all
stop after `ATLASSIAN_MAX_PAGINATION_PAGES`; repeated or non-advancing pages are
rejected rather than returned as misleading, apparently complete results. Hitting
the page budget raises an error — partial results are never presented as whole.

**An update with no fields is refused.** `jira_update_issue` and
`confluence_update_page` reject a call that supplies nothing to change, before
any HTTP request. An empty PUT is not a no-op: it burns a version, an audit
entry and a watcher notification.

**`confluence_get_page` output must not be written back.** That tool renders the
page to lossy plain text. Feeding it to `confluence_update_page` as `body`
destroys macros, tables and layouts; the tool's own description says so. Edit the
storage-format HTML you intend to keep instead.

**Field definitions are cached.** Jira's instance-wide field catalogue is fetched at most once every 5 minutes instead of on every `jira_get_issue_fields` call.

**Transitions explain what they need.** `jira_get_transitions` lists the transitions available on an issue together with the fields each screen requires and their allowed values. `jira_transition_issue` accepts those via `fields`, and when one is missing it names the field and its options instead of surfacing a bare 400.

**Tool invocations are logged.** The server declares the MCP `logging`
capability and emits correlated `tool.start` / `tool.finish` events with a
request ID, duration and outcome. Arguments, PATs, response bodies and raw
error messages never appear in these diagnostic events.

**Requests time out and retry within one deadline.** `ATLASSIAN_TIMEOUT_MS`
limits one attempt; `ATLASSIAN_TOTAL_TIMEOUT_MS` also includes queue wait,
retries and `Retry-After` backoff. Non-idempotent methods are replayed only on
429, where the request was rejected before being processed.

## Known limitations

- `jira_add_worklog_with_category` targets the `vaillant-timetracking` plugin and always creates worklogs with status `TRACKED`. There is no REST endpoint to submit them; that still needs the Jira UI.
- Confluence storage-format conversion is still lossy for complex or nested
  XHTML, although common tables, links and macro markers are preserved.
- `jira_get_issue` returns only the most recent comments; `commentTotal` reports the real number.
- Current stdio deployment is single-user and uses one Jira PAT plus one
  Confluence PAT per server process. Shared Azure hosting, Entra authentication
  and per-user token isolation are designed but not yet implemented. Do not
  expose the current entrypoint as a shared network service; follow the release
  gates in [docs/AZURE-DEPLOYMENT.md](docs/AZURE-DEPLOYMENT.md).

## License

MIT

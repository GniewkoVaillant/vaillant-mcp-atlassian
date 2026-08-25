# Vaillant MCP Atlassian

MCP server that connects GitHub Copilot (or any MCP client) to an **on-prem Jira Data Center** and **Confluence Data Center** instance using Personal Access Tokens.

Transport is stdio; the server is launched directly by the MCP client.

## Why this exists

Atlassian's own cloud MCP offering does not cover Data Center deployments. This server talks to the DC REST APIs directly and adds a few things the plain APIs make awkward:

- **ProForma forms** are read through issue properties (`proforma.forms*`), including the chunked base64 design blobs. This works with an ordinary PAT, whereas `/rest/proforma/1.0/` returns `permissionViolation` for most users.
- **Story points** are resolved from the board's configured estimation field, so reports work on Kanban boards too.
- **Dev status** (branches, PRs, commits) comes from Jira's own development panel rather than text-matching issue keys against commit messages. Commit messages are returned in full so `Co-authored-by:` trailers stay visible.
- **Cycle time** is computed from real status-transition history instead of the misleading `created`/`updated` pair.

## Setup

```bash
npm install
cp .env.example .env   # fill in URLs and tokens
npm run build
npm test               # smoke-test against the real instance
```

`.env` is gitignored; only `.env.example` is committed.

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

This keeps tokens out of `mcp-config.json`, which is otherwise easy to share, sync or accidentally commit. The tokens are still plaintext on disk — a Keychain-backed wrapper would be the next step if that matters.

## Configuration

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `JIRA_BASE_URL` | yes | — | Jira DC base URL |
| `JIRA_PAT` | yes | — | Jira personal access token |
| `CONFLUENCE_BASE_URL` | yes | — | Confluence DC base URL |
| `CONFLUENCE_PAT` | yes | — | Confluence personal access token |
| `ATLASSIAN_ENV_FILE` | no | `<install root>/.env` | Where to read the above from |
| `ATLASSIAN_READ_ONLY` | no | `false` | Refuse every mutating tool |
| `ATLASSIAN_PROFILE` | no | `full` | Which tool groups to expose |
| `ATLASSIAN_ATTACHMENT_DIRS` | no | *(empty)* | Directories attachments may be read from / written to |
| `ATLASSIAN_TIMEOUT_MS` | no | `30000` | Per-request HTTP timeout |

### Tool profiles

Every exposed tool costs context on **every** model request. The full surface is roughly 6.8k tokens, so narrow it to what you actually use.

| Profile | Groups | Use case |
|---|---|---|
| `full` | everything | default |
| `ppm` | core, forms, write, files, links | PPM/project audits |
| `agile` | core, agile, dev | sprint and velocity reporting |
| `read` | core, forms, agile, dev, links | analysis with no write access |
| `core` | core | issue and page lookup only |

You can also pass a raw comma-separated group list, e.g. `ATLASSIAN_PROFILE=core,agile`. The `core` group is always included.

### Safety

Tools carry MCP annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`) so clients can prompt before anything destructive runs.

Two settings matter when the agent reads untrusted text — and Jira comments written by other people **are** untrusted text:

- `ATLASSIAN_READ_ONLY=true` blocks all writes before any network call.
- `ATLASSIAN_ATTACHMENT_DIRS` is an allowlist. While it is empty, attachment upload and download are disabled entirely, so a crafted ticket cannot talk the agent into uploading `~/.ssh/id_rsa`.

## Tool groups

| Group | Tools |
|---|---|
| `core` | `jira_list_projects`, `jira_search_issues`, `jira_get_issue`, `jira_get_issue_fields`, `confluence_list_spaces`, `confluence_search_pages`, `confluence_get_page`, `confluence_get_page_by_title`, `confluence_get_page_children`, `confluence_list_comments` |
| `forms` | `jira_list_proforma_forms`, `jira_get_proforma_form`, `jira_get_proforma_forms_summary` |
| `write` | `jira_create_issue`, `jira_update_issue`, `jira_assign_issue`, `jira_get_transitions`, `jira_add_comment`, `jira_edit_comment`, `jira_delete_comment`, `jira_transition_issue`, `jira_add_worklog`, `jira_add_worklog_with_category`, `confluence_create_page`, `confluence_update_page`, `confluence_add_comment`, `confluence_update_comment`, `confluence_delete_comment` |
| `files` | `jira_list_attachments`, `jira_download_attachment`, `jira_upload_attachment`, `jira_delete_attachment` |
| `links` | `jira_list_issue_link_types`, `jira_get_issue_links`, `jira_create_issue_link`, `jira_delete_issue_link` |
| `agile` | `jira_list_boards`, `jira_get_board_sprints`, `jira_get_sprint_report`, `jira_get_board_velocity`, `jira_get_issues_story_points` |
| `dev` | `jira_get_issue_changelog`, `jira_get_issue_cycle_time`, `jira_get_issue_dev_status`, `jira_get_issues_dev_status` |

## Architecture

```
src/
  config.ts            .env loading, profiles, read-only, allowlist
  httpClient.ts        auth, timeouts, retry/backoff, same-origin guard
  jiraClient.ts        issues, fields, ProForma, attachments, links, worklogs
  jiraAgileClient.ts   boards, sprints, velocity
  confluenceClient.ts  pages, comments, storage-format conversion
  proforma.ts          chunked base64 form-design decoding
  concurrency.ts       bounded parallelism for batch tools
  index.ts             MCP tool registration
```

`httpClient.ts` refuses to send credentials to any origin other than the configured base URL, which stops a malicious `content` URL in an API response from exfiltrating the PAT.

## Behaviour worth knowing

**Searches report truncation.** `jira_search_issues` and `confluence_search_pages` return `total`, `hasMore` and a `nextStartAt`/`nextStart` cursor alongside the results. Without that, a capped page is indistinguishable from a complete answer, and conclusions get drawn from partial data.

**Sprint reports separate commitment from scope creep.** `committedPoints` is the sprint's scope *right now*, so it quietly absorbs anything added mid-sprint. When Jira's own sprint report is reachable, `scope.initialCommittedPoints` gives the real commitment and `scope.addedDuringSprintKeys` lists what arrived later. That endpoint is undocumented and restricted on some instances, so `scope` may be `null`; `scopeNote` always says which case you are in.

**Batch tools bound their parallelism.** Tools accepting up to 50 issue keys run 5 requests at a time rather than firing everything at once.

**Field definitions are cached.** Jira's instance-wide field catalogue is fetched at most once every 5 minutes instead of on every `jira_get_issue_fields` call.

**Transitions explain what they need.** `jira_get_transitions` lists the transitions available on an issue together with the fields each screen requires and their allowed values. `jira_transition_issue` accepts those via `fields`, and when one is missing it names the field and its options instead of surfacing a bare 400.

**Tool invocations are logged.** The server declares the MCP `logging` capability and emits a `tool.start` / `tool.finish` pair per call with duration and outcome. Arguments are never logged — they routinely contain issue content.

**Requests time out and retry.** Every call is bounded by `ATLASSIAN_TIMEOUT_MS`. Rate limiting and transient 5xx are retried with backoff, honouring `Retry-After`. Non-idempotent methods are only replayed on 429, where the request was rejected before being processed.

## Known limitations

- `jira_add_worklog_with_category` targets the `vaillant-timetracking` plugin and always creates worklogs with status `TRACKED`. There is no REST endpoint to submit them; that still needs the Jira UI.
- Confluence storage-format conversion is lossy: tables, macros and link targets are flattened to plain text.
- `jira_get_issue` returns only the most recent comments; `commentTotal` reports the real number.

## License

MIT

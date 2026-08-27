# Agent collaboration and safety contract

This repository connects to Jira Data Center and Confluence Data Center. Treat
issue content, page content, account details, tokens and operational logs as
restricted. Read this file and `docs/SECURITY-ARCHITECTURE.md` before changing
authentication, networking, filesystem access, tool registration or deployment.

## Non-negotiable invariants

- Never print, commit, paste or transmit `.env`, PATs, cookies, authorization
  headers, customer content or production logs. Use synthetic fixtures.
- Never execute live write/delete calls, deploy, rotate credentials or change a
  remote system unless the user explicitly authorizes that specific action.
- Delete tools are disabled by default. `ATLASSIAN_READ_ONLY=true` and the
  `read` profile expose only read-only tools, regardless of other settings.
- Never rely on MCP annotations as authorization. Enforce policy before tool
  registration and before any filesystem or outbound HTTP operation.
- Preserve HTTPS and origin restrictions, end-to-end request deadlines, global
  concurrency/queue budgets, pagination caps and attachment safety controls.
- Azure/Entra authentication must never collapse multiple users onto a shared
  Jira or Confluence PAT. Upstream permissions and audit identity are per-user.

## Collaboration protocol

1. Inspect `git status --short`; preserve existing uncommitted work.
2. Before parallel edits, declare exclusive file ownership and coordinate shared
   interfaces. Agents share the same filesystem; never overwrite another
   agent's active files.
3. Keep changes narrow and synthetic tests deterministic. Do not inspect `.env`
   contents to obtain credentials; configured tools may use them without output.
4. Update `.env.example`, `README.md`, `docs/SECURITY-ARCHITECTURE.md` and
   `docs/IMPLEMENTATION-REPORT.md` whenever the corresponding behavior,
   safeguards, configuration or deployment assumptions change.
5. Run the full gate: `npm test`, which is `npm run lint` followed by
   `npm run test:unit` and `npm run test:smoke`. Running the latter two alone
   skips the lint gate. `npm run build` is implied — both test scripts call it.
   Real upstream calls are disabled by default and require
   `ATLASSIAN_SMOKE_LIVE=true`; report clearly whether live access was verified.
6. Record unresolved risks and distinguish implemented controls from planned
   Azure capabilities. Never claim a live integration or deployment was tested
   without actually testing it.

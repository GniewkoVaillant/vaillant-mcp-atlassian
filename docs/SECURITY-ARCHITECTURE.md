# Security architecture and agent handoff

Status: local stdio hardening is implemented in this repository; Azure,
Microsoft Entra ID and per-user credential isolation are target architecture,
not deployed or implemented identity features.

## Scope and trust boundaries

The current server is a single-user stdio MCP process. It calls two explicitly
configured Data Center origins using one Jira PAT and one Confluence PAT loaded
from a protected local environment file or inherited environment variables.

Treat MCP arguments, Jira issue fields/comments, Confluence pages/comments,
attachment filenames, upstream URLs and response metadata as untrusted. A model
can read prompt-injection instructions embedded in normal enterprise content;
server-side policy must remain effective even when the model follows them.

Sensitive boundaries:

1. MCP client to local server: tool discovery, tool arguments and responses.
2. Local process to Jira/Confluence DC: TLS, origin restrictions and bearer PATs.
3. Attachment tools to local filesystem: approved directory, symlink and size checks.
4. Future Entra-authenticated client to shared Azure service: user/session isolation.
5. Future Azure service to credential vault and DC networks: delegated identity,
   least-privilege retrieval, controlled egress and attributed audit events.

## Enforced local controls

### Tool exposure and mutation policy

`ATLASSIAN_ALLOW_DESTRUCTIVE=false` is the default. Delete tools are not
registered, so no model prompt can invoke them. Explicitly enabling destructive
tools is an operator decision and should be limited to a dedicated maintenance
process. `ATLASSIAN_READ_ONLY=true` removes all non-read tools. The named `read`
profile always enforces the same rule, including mutation tools belonging to a
nominally mixed group such as `links`.

MCP `readOnlyHint`, `destructiveHint` and related annotations are informational;
they do not replace registration-time enforcement. Non-destructive create,
update, assignment, transition and comment tools remain available in writable
profiles, so least-privilege PATs and explicit read-only deployments still
matter.

Explicit destructive opt-in does not verify human approval. A future approval
mechanism must independently bind one authenticated actor to one exact action,
one exact target, a short expiry and one-time use; an LLM-supplied confirmation
boolean cannot provide that guarantee.

### Credential, transport and log hygiene

Only HTTPS base URLs are accepted, except plain HTTP to a local loopback host for
development tests. Base URLs containing embedded credentials, query strings or
fragments are rejected. HTTP helpers refuse credential delivery to an origin
other than the configured upstream origin. A Unix `.env` readable by other users
is rejected; keep it mode `0600` and outside version control.

Startup diagnostics contain operational settings but never PAT values. MCP tool
events contain a request correlation ID, tool name, operation kind, outcome and
duration, but never tool arguments, issue/page bodies or credentials.

### Upstream availability controls

`ATLASSIAN_TIMEOUT_MS` bounds one attempt; `ATLASSIAN_TOTAL_TIMEOUT_MS` bounds
the entire operation, including queue wait, retries and retry delay. All Jira
and Confluence traffic shares `ATLASSIAN_MAX_CONCURRENT_REQUESTS`; excess work
waits only within `ATLASSIAN_MAX_QUEUED_REQUESTS` and otherwise fails closed.

Retryable upstream rate limits and transient failures use bounded backoff.
Potentially non-idempotent writes must not be replayed after ambiguous network
failures. `ATLASSIAN_MAX_PAGINATION_PAGES` caps every automatic pagination walk: the
Jira Agile paths (boards, sprints, sprint issues), the Jira changelog walk
(`jira_get_issue_changelog`, `jira_get_issue_cycle_time`) and the Confluence
ones (`confluence_list_spaces`, `confluence_get_page_children`,
`confluence_list_comments`); repeated, stalled and malformed pagination is
rejected instead of returning partial results as complete.

ProForma chunk fetching is bounded at both levels, not only the inner one. A
single form decodes at most `MAX_PROFORMA_CHUNKS` (25) chunks, fetched
`DEFAULT_CONCURRENCY` (5) at a time; the summary tool that walks several forms
at once fans out over `PROFORMA_FORM_CONCURRENCY` (3) forms, so the worst-case
in-flight fan-out for one operation is 3 x 5 = 15 requests, all of which still
queue behind the process-wide `ATLASSIAN_MAX_CONCURRENT_REQUESTS` budget.

Response size is capped in two independent places. `ATLASSIAN_MAX_JSON_BYTES`
(default 16 MiB) refuses an oversized Jira/Confluence JSON body before it is
buffered, so an unbounded upstream response cannot be assembled in memory.
`ATLASSIAN_MAX_TOOL_RESULT_BYTES` (default 150000) caps the text any tool hands
back to the MCP client, appending an explicit truncation marker that names the
dropped byte count, so the model cannot mistake a fragment for a whole answer.

### Attachment boundary

Attachment upload/download is disabled until `ATLASSIAN_ATTACHMENT_DIRS`
contains explicit, absolute, non-root directories. Existing paths are
canonicalized so symlinks cannot escape approved directories. Download targets
must not overwrite existing files or traverse symlink destinations.
`ATLASSIAN_MAX_ATTACHMENT_BYTES` limits accepted attachment sizes.

Canonicalization addresses symlinks; it does not address hard links, because a
hard link is a second name for the same inode and `realpath()` returns the
in-policy name it was given. Uploads therefore inspect the opened file
descriptor and refuse any file whose `nlink` is greater than 1: the bytes may
belong to a file created outside the allowed directories, and there is no
portable way to enumerate the other names. Uploads also `lstat()` the path
before `open()` and pass `O_NONBLOCK` alongside `O_NOFOLLOW`, so a FIFO planted
in an allowed directory returns immediately instead of pinning a libuv
threadpool thread; the type check is repeated on the descriptor that was
actually opened, which is what closes the swap window between the two calls.

This local attachment mechanism is not a safe shared-cloud feature. Azure
deployment should disable local filesystem tools or replace them with
per-request, short-lived, authorization-checked object-storage transfers.

## Required Azure / Microsoft Entra architecture

The component-level deployment procedure, identity settings, PAT enrollment
lifecycle, infrastructure inventory, verification matrix and rollback sequence
are specified in [`AZURE-DEPLOYMENT.md`](AZURE-DEPLOYMENT.md). That document is a
release contract, not evidence that the missing HTTP and identity features are
already implemented.

### Identity does not equal Atlassian authorization

An Entra ID or SSO login authenticates the user to the MCP service. It does not
mint a Jira DC or Confluence DC PAT, establish Atlassian project/space access,
or make upstream audit records reflect that user's identity. A shared technical
PAT would bypass the requested permission and audit model and is prohibited.

Each authorized user must explicitly supply **their own Jira PAT and their own
Confluence PAT** through a separate secure enrollment flow. Validate each PAT
against the relevant current-user endpoint and bind the verified Atlassian
account identities to a stable Entra tenant/object ID. Reject mismatched or
unapproved account mappings.

### Request path and credential lifecycle

```text
MCP client
  -> Entra-protected HTTPS MCP endpoint
  -> validate issuer, audience, tenant, expiry and authorized group/role
  -> resolve stable Entra user identity and request correlation ID
  -> retrieve that user's Jira PAT or Confluence PAT from a protected vault
  -> call the configured DC origin using only that user's own PAT
  -> emit a sanitized, attributed audit event
  -> return only data permitted by the upstream Atlassian account
```

Recommended deployment components:

- Azure-hosted Streamable HTTP MCP endpoint behind TLS and an authenticated
  ingress; use the standalone Container Apps Entra model, not a pool-level API
  key. The current stdio entrypoint is not itself a shared web service.
- Microsoft Entra app registration with explicit tenant, audience and
  application-role/group checks; deny unauthenticated or unauthorized callers.
- Managed Identity plus Azure Key Vault or an equivalent isolated encrypted
  secret store. PAT enrollment must not write tokens to logs, URLs, shared
  environment variables, browser storage or application telemetry.
- Per-user/per-product secret mapping with least-privilege retrieval,
  encryption, expiry, rotation, revocation and account offboarding. Cache only
  if identity-scoped, bounded and invalidated on revocation.
- Private networking or explicitly approved outbound routes to the two DC
  origins; no caller-controlled upstream host, arbitrary fetch or shared PAT.
- Identity-scoped clients and request context. Current process-wide credential
  construction must be refactored before concurrent multi-user hosting.
- Global and per-user rate/concurrency budgets so one tenant cannot monopolize
  DC capacity; distributed limits are required when multiple Azure replicas run.
- Sanitized audit records with request ID, stable internal actor reference,
  product, tool/action, operation kind, result, duration and carefully
  classified target reference. Define access controls and retention before
  enabling production audit storage.

A broker Managed Identity capable of reading every user's secret is itself a
high-value trust boundary. Enforce the authenticated-user-to-secret-reference
mapping inside the broker, minimize workload permissions and isolation domains,
and monitor unexpected secret access. Microsoft OAuth On-Behalf-Of does not
automatically convert an Entra token into a Jira or Confluence Data Center PAT.

### Rollout gates

1. Threat-model token enrollment, prompt injection, cross-user access, SSRF,
   session fixation, replay, CSRF/origin policy, audit disclosure and DoS.
2. Prove two Entra users with different Jira/Confluence roles cannot access each
   other's data, PATs, cached responses, tool sessions or audit identities.
3. Prove a revoked PAT, expired session, disabled Entra account and removed
   group membership all fail closed without falling back to a service account.
4. Load-test queue rejection, request deadlines, per-user fairness and aggregate
   DC pressure across multiple service replicas.
5. Validate Key Vault access, secret rotation, private egress, sanitized logging,
   restore/retention procedures and operator access separately.
6. Disable destructive tools and local attachments in production unless a
   separately approved maintenance design justifies them.

## Residual risks and implementation boundaries

- A writable local profile can still create or modify data; accidental deletion
  prevention does not make it read-only.
- PATs in a protected `.env` remain plaintext at rest and inherit every
  permission granted to their owners.
- Bounded downloads and bounded JSON responses are assembled in memory rather
  than streamed directly to disk; Jira multipart uploads may temporarily hold
  multiple bounded copies. The ceilings (`ATLASSIAN_MAX_ATTACHMENT_BYTES`,
  `ATLASSIAN_MAX_JSON_BYTES`) bound how much memory that can be, but an operator
  who raises them raises the exposure with them.
- Canonical-parent revalidation, non-following exclusive file creation, the
  `nlink > 1` refusal and the pre-`open()` type check stop the tested symlink,
  hard-link and FIFO escapes. What remains is narrower and genuinely does need a
  race: Node.js does not pin every parent directory with an `openat`-style
  descriptor, so a local attacker who can write inside an allowed directory
  could in principle swap a component between the canonicalization and the
  `open()`. That residual case is outside the current local single-user threat
  model. Note what this list said before hard links were refused: it described
  the only remaining exposure as a privileged same-host race, when in fact a
  plain hard link needed neither privilege nor a race. A residual-risk list that
  understates the attack is worse than no list at all.
- The upload guard refuses any file with more than one link, including one that
  is hard-linked entirely inside an allowed directory for legitimate reasons.
  This is a deliberate false positive: the alternative is accepting a name whose
  siblings cannot be enumerated.
- Local stdio has no Entra identity, centralized authorization or durable audit
  sink; MCP logging notifications depend on client support.
- Process-local concurrency budgets do not coordinate multiple Azure replicas.
- Atlassian permissions, PAT revocation and Data Center API compatibility must
  be checked against the real deployment before production rollout.
- A timeout is not proof that an upstream write was never applied; do not retry
  ambiguous non-idempotent writes without an upstream idempotency strategy.

## Verification and handoff

Run `npm run build`, `npm run test:unit`, and the stdio smoke test. Unit tests
cover synthetic HTTP retry/timeout behavior, queue/concurrency budgets, URL and
configuration validation, attachment traversal/symlink/size protections,
pagination safety and MCP tool exposure. Never place real PATs in fixtures.

Ordinary `npm run test:smoke` and `npm test` never contact upstream products.
Run `ATLASSIAN_SMOKE_LIVE=true npm run test:smoke` only after explicitly
authorizing its two authenticated read-only checks.

When continuing with multiple agents, assign exclusive file ownership, preserve
existing uncommitted changes, document interface changes before implementation,
and update this document whenever a listed control or residual risk changes.

# Azure deployment runbook

Status: **target architecture — not production-ready yet**.

This repository currently provides a single-user `stdio` MCP server. The Jira
Data Center and Confluence Data Center clients and their local safety controls
are implemented, but shared HTTP transport, Microsoft Entra authentication,
per-user credential brokering, distributed limits and durable audit storage are
not. Do not expose the current entrypoint as a shared network service.

This runbook defines the required production design and the gates that must pass
before deployment. It deliberately excludes Atlassian-hosted connectors: every
upstream call goes only to the two organization-managed Data Center origins.

## 1. Required decisions

Record these values in the infrastructure repository or deployment change; do
not put real identifiers, hostnames or credentials in this repository.

| Decision | Recommended value | Placeholder |
|---|---|---|
| Entra tenancy | single tenant | `[TENANT_ID]` |
| Azure region | region approved for internal data | `[AZURE_REGION]` |
| Runtime | standalone Azure Container App | `[CONTAINER_APP]` |
| Ingress | private endpoint reachable through corporate network | `[PRIVATE_FQDN]` |
| DC connectivity | private routing through VPN or ExpressRoute | `[DC_ROUTE]` |
| Secrets | Key Vault with RBAC and private endpoint | `[KEY_VAULT]` |
| Image registry | private Azure Container Registry | `[ACR]` |
| Distributed limits | organization-approved Redis-compatible store | `[RATE_LIMIT_STORE]` |
| Audit destination | Log Analytics or approved SIEM | `[AUDIT_SINK]` |
| Initial production profile | read-only | `ATLASSIAN_READ_ONLY=true` |

Use a standalone Container App rather than Azure Container Apps dynamic
sessions. Microsoft's documented standalone MCP model supports Microsoft Entra
OAuth; the dynamic-session model uses a pool-level API key and therefore cannot
provide the required end-user identity boundary.

## 2. Reference architecture

```text
MCP client
  -> corporate network / private DNS
  -> Container Apps private ingress and TLS
  -> Microsoft Entra authentication
  -> MCP authorization: tenant + audience + client + role
  -> request context: tenant ID, object ID, role, correlation ID
  -> per-user credential broker
       -> encrypted identity-to-secret mapping
       -> Key Vault secret version for that user and product
  -> per-user Jira or Confluence client
  -> distributed per-user and global request budgets
  -> private DNS and VPN/ExpressRoute route
  -> organization-managed Jira DC / Confluence DC

Every request
  -> sanitized attributed audit event
  -> approved audit sink
```

Trust boundaries and residual risks are described in
[`SECURITY-ARCHITECTURE.md`](SECURITY-ARCHITECTURE.md).

## 3. Work required in this repository

The following implementation must exist before provisioning a production
endpoint:

1. Keep `StdioServerTransport` for local development, but extract tool
   registration into a transport-independent server factory.
2. Add a separate Streamable HTTP entrypoint. It must reject unauthenticated
   requests before MCP parsing and set finite header/body/request timeouts.
3. Create an immutable request identity from validated Entra claims. Never take
   tenant ID, object ID, role or upstream username from MCP arguments.
4. Replace process-global Jira/Confluence clients with an identity-scoped client
   factory. A cache key must include tenant ID, object ID, product and credential
   version; cache entries need short expiry and revocation invalidation.
5. Implement a credential broker interface. Tool handlers receive clients, not
   PAT strings, and no tool response or exception may contain a PAT.
6. Enforce authorization both when listing tools and immediately before every
   handler. `Mcp.Reader` receives read tools; `Mcp.Writer` may additionally
   receive non-destructive writes. Production never registers delete tools.
7. Disable local attachment upload/download in Azure. Replace them later with
   identity-scoped, short-lived object-storage transfers after a separate threat
   model and approval.
8. Replace process-only global limits with distributed per-user and aggregate
   limits. Keep the existing process limits as a second line of defense.
9. Send structured audit events to a durable sink without arguments, content,
   authorization headers, URLs containing identifiers or raw upstream errors.
10. Add health endpoints that test only process readiness and dependency
    reachability. They must never make privileged data queries or reveal DC
    hostnames.

Until all ten items and the tests in section 11 pass, Azure status remains
**designed, not implemented**.

## 4. Microsoft Entra configuration

Create a single-tenant app registration for the MCP API. Use infrastructure as
code and a separately approved client registration rather than portal-only
configuration.

Required API configuration:

- Application ID URI: `api://[MCP_API_CLIENT_ID]`.
- Delegated scope: `Mcp.Access`.
- App roles assigned through controlled Entra groups:
  - `Mcp.Reader` — read-only tool surface;
  - `Mcp.Writer` — read plus non-destructive mutations;
  - `Mcp.Operator` — operational endpoints, never ordinary Jira/Confluence data.
- No multi-tenant sign-in.
- Admin consent for every approved MCP client application.
- Conditional Access, MFA and device/network conditions according to corporate
  policy.

For every request, validate or obtain from trusted Container Apps
authentication:

- signature and signing-key validity;
- issuer and exact tenant ID (`tid`);
- API audience (`aud`);
- expiry and not-before (`exp`, `nbf`);
- stable user object ID (`oid`);
- approved client/actor (`azp` or equivalent);
- required `roles` and delegated scope.

Tenant membership alone is insufficient authorization. Deny missing or
overage-only group claims unless a server-side group lookup is deliberately
implemented and bounded. Do not use email, display name or user-provided text as
an authorization key.

Configure Container Apps authentication to require authentication for every
route. The application must still perform role authorization. Prevent direct
container access that could bypass the authenticated ingress.

## 5. Personal PAT enrollment and lifecycle

Microsoft Entra proves who may use the MCP service; it does not grant Jira DC or
Confluence DC permissions. Each person enrolls two independent PATs. Never use a
shared service PAT as fallback.

Provide a separate Entra-protected credential page or API outside the MCP tool
surface:

1. Authenticate the user and build the stable key `(tid, oid, product)`.
2. Accept a PAT only in a TLS-protected request body with a small explicit body
   limit. Reject query-string, URL-fragment and log-based submission.
3. Validate the Jira PAT using the Jira DC current-user endpoint and validate
   the Confluence PAT using `GET /rest/api/user/current` on the configured
   Confluence DC origin. Verify the exact endpoints against the deployed DC
   versions during integration testing.
4. Reject inactive/anonymous accounts and record the verified upstream account
   identity. Treat the returned profile as restricted data.
5. Create a random credential-record ID. Store the PAT as a new Key Vault secret
   version named from that opaque ID; never use email, username or Entra object
   ID in the secret name.
6. Store only the encrypted mapping `(tid, oid, product) -> secret URI/version`
   plus minimum verified-account and lifecycle metadata. Apply a unique
   constraint so one user cannot collide with another user's record.
7. Return only enrollment state and expiry metadata. Do not return the PAT or a
   reversible representation.

Rotation is validate-new, atomically switch the mapping, invalidate all client
caches, then retire the old secret version. The user must also revoke the old
PAT in the corresponding Data Center product. Revocation, disabled Entra
accounts, removed roles and offboarding must fail closed without a service
account fallback.

The workload Managed Identity can potentially retrieve many users' secrets. It
is therefore a high-value broker identity. Grant only `secrets/get` for the
required vault scope, deny listing where the chosen design permits it, use Key
Vault RBAC, private networking, diagnostic logs, soft delete and purge
protection, and alert on unusual secret access.

## 6. Network design

Recommended internal topology:

1. Use a workload-profile Container Apps environment integrated with a
   dedicated subnet.
2. Disable public network access and create a private endpoint plus the required
   private DNS zone for Container Apps.
3. Resolve Jira DC and Confluence DC names through approved private DNS. Route
   traffic over VPN or ExpressRoute; do not add a public fallback route.
4. Allow outbound HTTPS only to the exact DC origins and required Azure control
   plane/data services. The caller never supplies an upstream host.
5. Use private endpoints for Key Vault, registry and the selected state stores.
6. Import the corporate CA chain into the container trust store when the DC
   endpoints use an enterprise CA. Never disable TLS certificate verification.
7. Confirm return routes, MTU, proxy rules and DNS behavior from a disposable
   test revision before enabling production traffic.

If private ingress cannot serve the approved MCP clients, document the exception
and use an authenticated external ingress with an approved edge/WAF. This does
not change the private egress requirement to the Data Center products.

## 7. Container and supply-chain controls

- Pin a supported Node.js LTS base image by immutable digest.
- Build with `npm ci`; do not copy `.env`, source credentials, test output or
  developer directories into the image.
- Run as a non-root user with a read-only root filesystem and a minimal writable
  temporary directory where the runtime permits it.
- Generate an SBOM, scan dependencies and the image, sign the image and deploy
  only an approved digest from the private registry.
- Set CPU/memory requests and limits. Terminate gracefully within the Container
  Apps shutdown window and stop accepting new MCP requests before exit.
- Use separate managed identities and resources for development, test and
  production. Never copy production PATs into lower environments.

Production configuration contains only non-secret settings and Key Vault
references. Do not mount a shared `.env`. Initial settings must include:

```text
ATLASSIAN_READ_ONLY=true
ATLASSIAN_ALLOW_DESTRUCTIVE=false
ATLASSIAN_PROFILE=read
ATLASSIAN_ATTACHMENT_DIRS=
```

Jira and Confluence base URLs are operator-controlled configuration. PATs are
resolved per request and therefore must not use the current process-global
`JIRA_PAT` or `CONFLUENCE_PAT` variables.

## 8. Capacity and availability

Use four layers of protection:

1. per-user concurrent request and queue limits;
2. per-user rate/burst budgets in a distributed store;
3. aggregate Jira and Confluence budgets shared by all replicas;
4. the existing per-process concurrency, queue, pagination, response-size and
   total-deadline controls.

Scale on measured concurrency and latency, not only CPU. Set a finite maximum
replica count calculated from the approved aggregate DC concurrency. A higher
replica count must not multiply pressure beyond the Jira/Confluence budget.

Do not automatically retry ambiguous non-idempotent writes. Read retries remain
bounded by the total request deadline. Return overload and deadline errors
without exposing topology or raw upstream bodies.

## 9. Audit and monitoring

Every request and PAT lifecycle event needs a correlation ID and an attributed
actor. Recommended event fields:

```text
timestamp, correlation_id, environment, revision, tenant_subject_hash,
entra_role, approved_client_id, product, tool, operation_kind, outcome,
duration_ms, upstream_status_class, rate_limit_outcome, credential_version_id
```

Exclude PATs, authorization headers, MCP arguments, issue/page bodies,
attachment names, personal display data, query text, raw URLs and raw upstream
errors. Hashing does not make unrestricted personal data public; restrict audit
access and define retention with governance owners.

Alert on repeated authentication failures, cross-user mapping denials, secret
access anomalies, queue rejection, deadline growth, upstream 401/403/429/5xx,
unexpected write attempts and any request for a destructive tool.

Health probes, metrics and logs must distinguish MCP availability from DC
availability. A DC outage should degrade the service without restarting all
replicas in a loop.

## 10. Infrastructure-as-code inventory

The deployment module should create and output only identifiers, never secret
values:

- resource group and approved tags;
- workload-profile Container Apps environment and subnet integration;
- private endpoint and private DNS records;
- Container App, ingress, Entra authentication and revision policy;
- user-assigned Managed Identity;
- private registry and image pull role;
- Key Vault with RBAC, private endpoint, soft delete and purge protection;
- encrypted credential-mapping store;
- distributed rate-limit store;
- Log Analytics/SIEM diagnostic settings and alerts;
- least-privilege role assignments;
- budget, availability and secret-expiry alerts.

Use placeholders in examples and parameter files. Keep production values in the
approved deployment system, not in Git history.

## 11. Release gates

### Automated

- `npm run build`, `npm run test:unit` and isolated stdio smoke test pass.
- Streamable HTTP protocol tests cover initialize, session handling,
  cancellation, concurrent calls, disconnects and bounded bodies.
- Authentication tests reject wrong issuer, tenant, audience, client, role,
  expired/not-yet-valid token and missing stable object ID.
- Authorization tests prove a reader cannot discover or invoke writes and no
  production user can discover or invoke deletes.
- Credential tests prove no cross-user or cross-product lookup, including cache
  keys, concurrent rotation and revocation.
- Log-capture tests prove PATs and synthetic restricted content never appear.
- Distributed load tests prove per-user fairness and the aggregate DC cap across
  at least two replicas.

### Integration

Use two synthetic Entra users with different Jira and Confluence permissions:

1. Enroll separate Jira and Confluence PATs for each user.
2. Verify each current-user response maps to the expected account.
3. Verify each user sees only upstream-permitted projects, issues, spaces and
   pages.
4. Attempt cross-user session, mapping, cache and credential-version access; all
   must fail without fallback.
5. Revoke one PAT and verify only that user/product fails.
6. Remove one Entra role and disable one account; existing sessions must stop
   authorizing within the documented maximum lifetime.
7. Run read-only load tests and confirm queue/deadline behavior against agreed DC
   thresholds.

Writes require a separately approved test project/space and explicit change
authorization. Deletes remain disabled.

### Operational approval

Security, Data Center owners, Entra administrators, network owners and service
operations must approve the threat model, data classification, retention,
capacity budget, rollback and on-call ownership. Production is blocked until
all gates have stored evidence.

## 12. Deployment and rollback sequence

1. Deploy infrastructure and an unauthenticated **disabled** placeholder
   revision with no DC route or credentials.
2. Validate private DNS, identity, Key Vault and audit connectivity.
3. Deploy the signed application digest with ingress authentication required and
   zero production traffic.
4. Run protocol/authentication tests, then synthetic-user read-only integration
   tests.
5. Shift a small traffic percentage to the new revision; watch authentication,
   queue, latency, secret-access and DC health signals.
6. Increase traffic only within the agreed observation window and stop on any
   audit-attribution or isolation failure.
7. After acceptance, deactivate old revisions that still reference obsolete
   configuration or secrets.

Rollback shifts traffic to the last approved digest, disables the faulty
revision and invalidates its sessions. Do not roll back credential mappings or
secret versions blindly: preserve audit evidence and revalidate that the target
version is not revoked. A suspected credential disclosure requires immediate
PAT revocation by the affected user or Data Center administrator.

## 13. Routine operations

- Review Entra group/app-role assignments and approved client applications.
- Alert before PAT expiry; users rotate through the enrollment flow.
- Revalidate stored account binding after rotation and periodically according to
  policy.
- Patch the base image and dependencies through a signed canary revision.
- Test restore of mapping/audit stores without restoring revoked PAT versions.
- Recalculate aggregate concurrency before increasing replica limits.
- Review denied cross-user lookups and unexpected write attempts.
- Keep destructive tools and local filesystem attachments disabled.

## 14. Primary references

- [Secure MCP servers on Azure Container Apps](https://learn.microsoft.com/azure/container-apps/mcp-authentication)
- [Microsoft Entra authentication for Azure Container Apps](https://learn.microsoft.com/azure/container-apps/authentication-entra)
- [Manage secrets in Azure Container Apps](https://learn.microsoft.com/azure/container-apps/manage-secrets)
- [Container Apps private endpoints and DNS](https://learn.microsoft.com/azure/container-apps/private-endpoints-with-dns)
- [Validate Microsoft Entra claims](https://learn.microsoft.com/entra/identity-platform/claims-validation)
- [Atlassian Data Center personal access tokens](https://confluence.atlassian.com/enterprise/using-personal-access-tokens-1026032365.html)
- [Confluence Data Center current-user REST resource](https://developer.atlassian.com/server/confluence/rest/v932/api-group-user/)

Recheck service documentation and organization policy during implementation;
Azure capabilities and supported Data Center versions can change.

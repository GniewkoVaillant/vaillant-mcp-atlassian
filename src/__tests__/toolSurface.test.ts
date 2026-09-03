/**
 * End-to-end tests of the tool surface.
 *
 * The unit tests exercise the clients directly, which leaves the layer that
 * actually faces the model untested: MCP registration, the Zod schemas, the
 * cross-field `validate` preconditions, the mapping of a client result into a
 * tool result, and the error path. A tool can be perfectly correct at the
 * client level and still be unreachable, mis-wired to the wrong client method,
 * or registered under a profile that hides it.
 *
 * So these boot the real built server over stdio, point it at a stub that
 * answers like a Data Center instance, and drive it through the MCP protocol —
 * the same path a model takes.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SERVER_ENTRYPOINT = fileURLToPath(new URL("../index.js", import.meta.url));

interface StubRequest {
    method: string;
    path: string;
    query: URLSearchParams;
    headers: IncomingMessage["headers"];
    body: string;
}

/** Requests the stub received, in order, so a test can assert what was sent. */
const received: StubRequest[] = [];

/**
 * Routes by method and path prefix. Registered per test file rather than per
 * test so one server serves both products: Jira lives under `/rest/api/2` and
 * `/rest/agile`, Confluence under `/rest/api/content` and `/rest/api/space`,
 * so a single origin can stand in for both.
 */
type Responder = (request: StubRequest) => { status?: number; body: unknown };

const routes: { method: string; match: RegExp; respond: Responder }[] = [];

function route(method: string, match: RegExp, respond: Responder): void {
    routes.push({ method, match, respond });
}

async function readBody(request: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("utf8");
}

function handle(request: IncomingMessage, response: ServerResponse): void {
    void (async () => {
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        const record: StubRequest = {
            method: request.method ?? "",
            path: url.pathname,
            query: url.searchParams,
            headers: request.headers,
            body: await readBody(request),
        };
        received.push(record);

        const matched = routes.find(
            (candidate) => candidate.method === record.method && candidate.match.test(record.path),
        );
        response.setHeader("content-type", "application/json");
        if (!matched) {
            response.statusCode = 404;
            response.end(JSON.stringify({ errorMessages: [`no stub route for ${record.method} ${record.path}`] }));
            return;
        }
        const { status = 200, body } = matched.respond(record);
        response.statusCode = status;
        response.end(typeof body === "string" ? body : JSON.stringify(body));
    })();
}

let server: Server;
let baseUrl: string;
let attachmentDir: string;
let client: Client;

/** Calls a tool and returns its parsed JSON payload, failing on an error result. */
async function callTool(name: string, args: Record<string, unknown>): Promise<any> {
    const result = await client.callTool({ name, arguments: args });
    const text = ((result.content as { type: string; text?: string }[]) ?? [])
        .map((part) => part.text ?? "")
        .join("\n");
    assert.equal(result.isError, undefined, `${name} returned an error result: ${text}`);
    return JSON.parse(text);
}

/** Calls a tool expecting failure, and returns the message the model would see. */
async function callToolExpectingFailure(name: string, args: Record<string, unknown>): Promise<string> {
    try {
        const result = await client.callTool({ name, arguments: args });
        const text = ((result.content as { type: string; text?: string }[]) ?? [])
            .map((part) => part.text ?? "")
            .join("\n");
        assert.equal(result.isError, true, `${name} unexpectedly succeeded: ${text}`);
        return text;
    } catch (error) {
        // A schema or precondition rejection surfaces as a protocol error
        // rather than an error result; both are failures the model can read.
        return error instanceof Error ? error.message : String(error);
    }
}

before(async () => {
    registerRoutes();
    server = createServer(handle);
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
    attachmentDir = await mkdtemp(join(tmpdir(), "mcp-atlassian-e2e-"));

    const inherited = Object.fromEntries(
        Object.entries(process.env).filter(
            ([key, value]) => value !== undefined && !key.startsWith("ATLASSIAN_"),
        ),
    ) as Record<string, string>;

    const transport = new StdioClientTransport({
        command: process.execPath,
        args: [SERVER_ENTRYPOINT],
        env: {
            ...inherited,
            JIRA_BASE_URL: baseUrl,
            CONFLUENCE_BASE_URL: baseUrl,
            JIRA_PAT: "synthetic-jira-token",
            CONFLUENCE_PAT: "synthetic-confluence-token",
            // The whole surface, so every new tool is reachable from here.
            ATLASSIAN_ALLOW_DESTRUCTIVE: "true",
            ATLASSIAN_ATTACHMENT_DIRS: attachmentDir,
        },
        stderr: "pipe",
    });
    client = new Client({ name: "tool-surface-test", version: "1.0.0" });
    await client.connect(transport);
});

after(async () => {
    await client?.close();
    if (server) {
        const closed = new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
        });
        server.closeAllConnections();
        await closed;
    }
    if (attachmentDir) await rm(attachmentDir, { recursive: true, force: true });
});

describe("tool surface: Jira metadata", () => {
    test("jira_get_create_meta reaches the legacy endpoint and reports its field rules", async () => {
        const meta = await callTool("jira_get_create_meta", { projectKeys: ["ABC"] });

        assert.equal(meta.source, "createmeta");
        const issueType = meta.projects[0].issueTypes[0];
        assert.equal(issueType.name, "Bug");
        const summary = issueType.fields.find((field: any) => field.id === "summary");
        assert.equal(summary.required, true);
        const components = issueType.fields.find((field: any) => field.id === "components");
        // 120 options upstream, capped at 50 with the truncation flagged.
        assert.equal(components.allowedValues.length, 50);
        assert.equal(components.allowedValuesTruncated, true);

        const sent = received.find((request) => request.path === "/rest/api/2/issue/createmeta");
        assert.equal(sent?.query.get("expand"), "projects.issuetypes.fields");
    });

    test("jira_get_edit_meta names the fields an update may set", async () => {
        const fields = await callTool("jira_get_edit_meta", { issueKey: "ABC-1" });

        const priority = fields.find((field: any) => field.id === "priority");
        assert.deepEqual(priority.allowedValues, ["High", "Low"]);
        assert.deepEqual(priority.operations, ["set"]);
    });

    test("jira_list_fields filters by clause name, not just by field name", async () => {
        const all = await callTool("jira_list_fields", {});
        const filtered = await callTool("jira_list_fields", { query: "story points" });

        assert.ok(all.length > filtered.length);
        assert.deepEqual(filtered.map((field: any) => field.id), ["customfield_10001"]);
    });

    test("jira_get_myself resolves the account behind the token", async () => {
        const me = await callTool("jira_get_myself", {});

        assert.equal(me.name, "jkowalski");
        assert.deepEqual(me.groups, ["jira-users"]);
    });

    test("a malformed issue key is refused by the schema before any request", async () => {
        const before = received.length;
        const message = await callToolExpectingFailure("jira_get_edit_meta", {
            issueKey: "https://jira.example/browse/ABC-1",
        });

        assert.match(message, /bare Jira issue key/);
        assert.equal(received.length, before, "a schema rejection must not reach the network");
    });
});

describe("tool surface: Jira directory", () => {
    test("jira_search_users returns the username a write tool needs", async () => {
        const users = await callTool("jira_search_users", { query: "kowalska" });

        assert.equal(users[0].name, "akowalska");
        assert.equal(users[0].displayName, "Anna Kowalska");
    });

    test("jira_find_assignable_users refuses an unscoped search before the network", async () => {
        const before = received.length;
        const message = await callToolExpectingFailure("jira_find_assignable_users", { query: "anna" });

        assert.match(message, /issueKey or projectKey/);
        assert.equal(received.length, before);
    });

    test("jira_get_my_permissions reports only what is granted", async () => {
        const permissions = await callTool("jira_get_my_permissions", { projectKey: "ABC" });

        assert.deepEqual(permissions.map((permission: any) => permission.key), ["EDIT_ISSUES"]);
    });
});

describe("tool surface: Jira filters", () => {
    test("jira_create_filter creates the filter private", async () => {
        const filter = await callTool("jira_create_filter", {
            name: "Open bugs",
            jql: "type = Bug AND resolution = Unresolved",
        });

        assert.equal(filter.id, "10100");
        assert.deepEqual(filter.sharedWith, [], "a new filter must not be shared with anyone");

        const sent = received.find(
            (request) => request.method === "POST" && request.path === "/rest/api/2/filter",
        );
        assert.equal(JSON.parse(sent!.body).favourite, false);
    });

    test("jira_add_filter_permission shares view-only and renders the audience in plain language", async () => {
        const permissions = await callTool("jira_add_filter_permission", {
            filterId: "10100",
            type: "group",
            groupName: "jira-users",
        });

        assert.deepEqual(permissions.map((permission: any) => permission.target), ["group:jira-users"]);
        const sent = received.find(
            (request) => request.method === "POST" && request.path === "/rest/api/2/filter/10100/permission",
        );
        assert.equal(JSON.parse(sent!.body).edit, false);
    });

    test("jira_search_filters degrades to favourites where Data Center has no search endpoint", async () => {
        const result = await callTool("jira_search_filters", { name: "open" });

        assert.equal(result.source, "favourites");
        assert.deepEqual(result.filters.map((filter: any) => filter.name), ["Open bugs"]);
    });
});

describe("tool surface: Jira issue writes", () => {
    test("jira_bulk_create_issues reports created and failed rows separately", async () => {
        const result = await callTool("jira_bulk_create_issues", {
            issues: [
                { projectKey: "ABC", issueType: "Bug", summary: "First" },
                { projectKey: "ABC", issueType: "Bug", summary: "Second" },
            ],
        });

        assert.equal(result.requested, 2);
        assert.deepEqual(result.created.map((issue: any) => issue.key), ["ABC-101"]);
        assert.equal(result.failed[0].index, 1);
        assert.match(result.failed[0].message, /summary: Summary is required/);
    });

    test("jira_notify_issue refuses to send mail with no recipients", async () => {
        const before = received.length;
        const message = await callToolExpectingFailure("jira_notify_issue", {
            issueKey: "ABC-1",
            subject: "Hello",
            body: "Text",
        });

        assert.match(message, /no recipients/);
        assert.equal(received.length, before, "no recipient means no mail leaves the building");
    });

    test("jira_set_issue_property is only reachable with the destructive opt-in", async () => {
        const stored = await callTool("jira_set_issue_property", {
            issueKey: "ABC-1",
            propertyKey: "my-key",
            value: { a: 1 },
        });

        assert.equal(stored.stored, true);
    });
});

describe("tool surface: Jira agile writes", () => {
    test("jira_get_board_backlog returns triage-ready issue summaries", async () => {
        const backlog = await callTool("jira_get_board_backlog", { boardId: 42 });

        assert.deepEqual(backlog.map((issue: any) => issue.key), ["ABC-9"]);
        assert.equal(backlog[0].assignee, "Anna Kowalska");
        assert.equal(backlog[0].status, "To Do");
    });

    test("jira_update_sprint sends a partial update, not a wholesale replacement", async () => {
        const sprint = await callTool("jira_update_sprint", { sprintId: 7, state: "active" });

        assert.equal(sprint.state, "active");
        const sent = received.find(
            (request) => request.method === "POST" && request.path === "/rest/agile/1.0/sprint/7",
        );
        assert.deepEqual(JSON.parse(sent!.body), { state: "active" });
    });

    test("jira_rank_issues refuses an ambiguous or absent anchor", async () => {
        const before = received.length;
        const none = await callToolExpectingFailure("jira_rank_issues", { issueKeys: ["ABC-1"] });
        const both = await callToolExpectingFailure("jira_rank_issues", {
            issueKeys: ["ABC-1"],
            rankBeforeIssue: "ABC-2",
            rankAfterIssue: "ABC-3",
        });

        assert.match(none, /exactly one/);
        assert.match(both, /mutually exclusive/);
        assert.equal(received.length, before);
    });

    test("an oversized batch is refused by the schema with the limit named", async () => {
        const before = received.length;
        const message = await callToolExpectingFailure("jira_move_issues_to_sprint", {
            sprintId: 7,
            issueKeys: Array.from({ length: 51 }, (_unused, index) => `ABC-${index + 1}`),
        });

        assert.match(message, /50/);
        assert.equal(received.length, before);
    });
});

describe("tool surface: Jira Service Management", () => {
    test("jsm_get_request_sla surfaces breach state, which exists nowhere else", async () => {
        const slas = await callTool("jsm_get_request_sla", { issueKey: "SUP-1" });

        assert.equal(slas[0].name, "Time to resolution");
        assert.equal(slas[0].breached, true);
        assert.equal(slas[0].remainingTime, "-2h");
    });

    test("jsm_add_request_comment requires an explicit visibility decision", async () => {
        const message = await callToolExpectingFailure("jsm_add_request_comment", {
            issueKey: "SUP-1",
            body: "Internal note",
        });
        assert.match(message, /isPublic|required/i);

        const comment = await callTool("jsm_add_request_comment", {
            issueKey: "SUP-1",
            body: "Internal note",
            isPublic: false,
        });
        assert.equal(comment.public, false);

        const sent = received.find(
            (request) => request.method === "POST" && request.path === "/rest/servicedeskapi/request/SUP-1/comment",
        );
        assert.equal(JSON.parse(sent!.body).public, false);
        // The experimental opt-in has to travel with the request or Data Center
        // refuses the resource outright — and it must not have displaced the
        // configured identity on the way.
        assert.equal(sent!.headers["x-experimentalapi"], "opt-in");
        assert.equal(sent!.headers.authorization, "Bearer synthetic-jira-token");
    });
});

describe("tool surface: Confluence", () => {
    test("confluence_search returns entities of every type, not only pages", async () => {
        const found = await callTool("confluence_search", { cql: "siteSearch ~ 'runbook'" });

        assert.deepEqual(found.results.map((hit: any) => hit.type), ["page", "user"]);
        assert.equal(found.total, 2);
    });

    test("confluence_get_restrictions reports restricted operations only", async () => {
        const restrictions = await callTool("confluence_get_restrictions", { pageId: "123" });

        assert.equal(restrictions.length, 1);
        assert.equal(restrictions[0].operation, "read");
        assert.deepEqual(restrictions[0].groups, ["hr"]);
    });

    test("confluence_add_labels rejects a label containing whitespace", async () => {
        const before = received.length;
        const message = await callToolExpectingFailure("confluence_add_labels", {
            pageId: "123",
            labels: ["two words"],
        });

        assert.match(message, /whitespace/);
        assert.equal(received.length, before);

        const labels = await callTool("confluence_add_labels", { pageId: "123", labels: ["runbook"] });
        assert.deepEqual(labels.map((label: any) => label.name), ["runbook"]);
    });

    test("confluence_restore_page_version republishes the old markup as a new version", async () => {
        const restored = await callTool("confluence_restore_page_version", { pageId: "123", versionNumber: 3 });

        assert.equal(restored.version, 8);
        const sent = received.find(
            (request) => request.method === "PUT" && request.path === "/rest/api/content/123",
        );
        const body = JSON.parse(sent!.body);
        // The macro must survive verbatim; escaping it would destroy the page.
        assert.match(body.body.storage.value, /<ac:structured-macro/);
        assert.match(body.version.message, /version 3/);
    });

    test("confluence_upload_attachment refuses a path outside the allowlist", async () => {
        const before = received.length;
        const message = await callToolExpectingFailure("confluence_upload_attachment", {
            pageId: "123",
            filePath: join(tmpdir(), "definitely-outside-the-allowlist.txt"),
        });

        assert.match(message, /outside the allowed directories|Attachment/i);
        assert.equal(received.length, before, "a rejected path must not reach Confluence");
    });

    test("confluence_upload_attachment uploads a file from inside the allowlist", async () => {
        const filePath = join(attachmentDir, "report.txt");
        await writeFile(filePath, "hello");

        const uploaded = await callTool("confluence_upload_attachment", {
            pageId: "123",
            filePath,
            mimeType: "text/plain",
        });

        assert.equal(uploaded[0].title, "report.txt");
        assert.equal(uploaded[0].fileSize, 5);
    });
});

describe("tool surface: failure reporting", () => {
    test("an upstream 404 is returned as a readable error result, not a crash", async () => {
        const message = await callToolExpectingFailure("jira_get_filter", { filterId: "999999" });

        assert.match(message, /jira_get_filter failed/);
        assert.match(message, /404/);
    });

    test("a malformed upstream payload names the resource instead of raising a TypeError", async () => {
        const message = await callToolExpectingFailure("jira_list_project_roles", { projectKey: "BROKEN" });

        assert.match(message, /jira_list_project_roles failed/);
        assert.doesNotMatch(message, /Cannot read propert|undefined is not/i);
    });
});

/* ------------------------------------------------------------------ */
/* Stub Data Center                                                   */
/* ------------------------------------------------------------------ */

function registerRoutes(): void {
    const componentOptions = Array.from({ length: 120 }, (_unused, index) => ({ name: `component-${index}` }));

    route("GET", /^\/rest\/api\/2\/issue\/createmeta$/, () => ({
        body: {
            projects: [{
                id: "1", key: "ABC", name: "Alpha",
                issuetypes: [{
                    id: "10", name: "Bug", subtask: false,
                    fields: {
                        summary: { name: "Summary", required: true, schema: { type: "string" }, operations: ["set"] },
                        components: {
                            name: "Component/s",
                            required: false,
                            schema: { type: "array", items: "component" },
                            operations: ["add", "set", "remove"],
                            allowedValues: componentOptions,
                        },
                    },
                }],
            }],
        },
    }));

    route("GET", /^\/rest\/api\/2\/issue\/[^/]+\/editmeta$/, () => ({
        body: {
            fields: {
                priority: {
                    name: "Priority",
                    required: false,
                    schema: { type: "priority" },
                    operations: ["set"],
                    allowedValues: [{ name: "High" }, { name: "Low" }],
                },
            },
        },
    }));

    route("GET", /^\/rest\/api\/2\/field$/, () => ({
        body: [
            { id: "summary", name: "Summary", custom: false, schema: { type: "string" }, clauseNames: ["summary"] },
            {
                id: "customfield_10001",
                name: "Estimate",
                custom: true,
                schema: { type: "number" },
                clauseNames: ["cf[10001]", "Story Points"],
            },
        ],
    }));

    route("GET", /^\/rest\/api\/2\/myself$/, () => ({
        body: {
            name: "jkowalski",
            displayName: "Jan Kowalski",
            emailAddress: "jan.kowalski@example.test",
            timeZone: "Europe/Warsaw",
            groups: { items: [{ name: "jira-users" }] },
        },
    }));

    route("GET", /^\/rest\/api\/2\/user\/search$/, () => ({
        body: [{ name: "akowalska", displayName: "Anna Kowalska", emailAddress: "anna@example.test", active: true }],
    }));

    route("GET", /^\/rest\/api\/2\/mypermissions$/, () => ({
        body: {
            permissions: {
                EDIT_ISSUES: { name: "Edit Issues", havePermission: true },
                DELETE_ISSUES: { name: "Delete Issues", havePermission: false },
            },
        },
    }));

    // `/project/{key}/role` answers with a map of role name to self URL. The
    // BROKEN project returns an array instead, which is the shape guard's job.
    route("GET", /^\/rest\/api\/2\/project\/BROKEN\/role$/, () => ({ body: ["not", "a", "map"] }));

    const filter = {
        id: "10100",
        name: "Open bugs",
        description: "",
        jql: "type = Bug AND resolution = Unresolved",
        favourite: false,
        owner: { displayName: "Jan Kowalski", name: "jkowalski" },
        sharePermissions: [],
    };
    route("POST", /^\/rest\/api\/2\/filter$/, () => ({ body: filter }));
    route("GET", /^\/rest\/api\/2\/filter\/10100$/, () => ({ body: filter }));
    route("GET", /^\/rest\/api\/2\/filter\/999999$/, () => ({
        status: 404,
        body: { errorMessages: ["The filter with id '999999' does not exist"] },
    }));
    route("POST", /^\/rest\/api\/2\/filter\/10100\/permission$/, () => ({
        body: [{ id: "1", type: "group", group: { name: "jira-users" } }],
    }));
    // Data Center 9.x has no filter search; the fallback path depends on this.
    route("GET", /^\/rest\/api\/2\/filter\/search$/, () => ({
        status: 404,
        body: { errorMessages: ["not found"] },
    }));
    route("GET", /^\/rest\/api\/2\/filter\/favourite$/, () => ({ body: [filter] }));

    route("POST", /^\/rest\/api\/2\/issue\/bulk$/, () => ({
        body: {
            issues: [{ id: "101", key: "ABC-101" }],
            errors: [{
                failedElementNumber: 1,
                elementErrors: { errorMessages: [], errors: { summary: "Summary is required" } },
            }],
        },
    }));

    route("PUT", /^\/rest\/api\/2\/issue\/[^/]+\/properties\/[^/]+$/, () => ({ status: 200, body: "" }));

    route("GET", /^\/rest\/agile\/1\.0\/board\/42\/backlog$/, () => ({
        body: {
            startAt: 0,
            total: 1,
            isLast: true,
            issues: [{
                id: "9",
                key: "ABC-9",
                fields: {
                    summary: "Fix the thing",
                    status: { name: "To Do" },
                    issuetype: { name: "Bug" },
                    assignee: { displayName: "Anna Kowalska", name: "akowalska" },
                    priority: { name: "High" },
                },
            }],
        },
    }));

    route("POST", /^\/rest\/agile\/1\.0\/sprint\/7$/, () => ({
        body: { id: 7, name: "Sprint 7", state: "active" },
    }));

    route("GET", /^\/rest\/servicedeskapi\/request\/SUP-1\/sla$/, () => ({
        body: {
            values: [{
                name: "Time to resolution",
                ongoingCycle: {
                    breached: true,
                    remainingTime: { friendly: "-2h" },
                    goalDuration: { friendly: "8h" },
                },
                completedCycles: [],
            }],
        },
    }));

    route("POST", /^\/rest\/servicedeskapi\/request\/SUP-1\/comment$/, () => ({
        body: {
            id: "5",
            body: "Internal note",
            public: false,
            author: { displayName: "Jan Kowalski" },
            created: { jiraRestDateTimeFormat: "2026-09-03T10:00:00.000+0200" },
        },
    }));

    route("GET", /^\/rest\/api\/search$/, () => ({
        body: {
            totalSize: 2,
            results: [
                {
                    entityType: "content",
                    content: { id: "123", type: "page", space: { key: "ENG" } },
                    title: "Runbook",
                    url: "/display/ENG/Runbook",
                    lastModified: "2026-09-01T09:00:00.000Z",
                },
                { entityType: "user", title: "Jan Kowalski", url: "/display/~jkowalski" },
            ],
        },
    }));

    route("GET", /^\/rest\/api\/content\/123\/restriction\/byOperation$/, () => ({
        body: {
            read: {
                operation: "read",
                restrictions: { user: { results: [] }, group: { results: [{ name: "hr" }] } },
            },
            update: { operation: "update", restrictions: { user: { results: [] }, group: { results: [] } } },
        },
    }));

    route("POST", /^\/rest\/api\/content\/123\/label$/, () => ({
        body: { results: [{ id: "1", name: "runbook", prefix: "global" }] },
    }));

    route("GET", /^\/rest\/api\/content\/123$/, (request) => {
        if (request.query.get("version") === "3") {
            return {
                body: {
                    id: "123",
                    title: "Runbook",
                    version: { number: 3 },
                    space: { key: "ENG" },
                    body: { storage: { value: '<p>Old text</p><ac:structured-macro ac:name="info"/>' } },
                },
            };
        }
        return {
            body: {
                id: "123",
                title: "Runbook",
                version: { number: 7 },
                space: { key: "ENG" },
                _links: { webui: "/display/ENG/Runbook" },
            },
        };
    });

    route("PUT", /^\/rest\/api\/content\/123$/, () => ({
        body: { id: "123", title: "Runbook", _links: { webui: "/display/ENG/Runbook" } },
    }));

    route("POST", /^\/rest\/api\/content\/123\/child\/attachment$/, () => ({
        body: {
            results: [{
                id: "att1",
                title: "report.txt",
                metadata: { mediaType: "text/plain" },
                extensions: { fileSize: 5 },
                version: { by: { displayName: "Jan Kowalski" }, when: "2026-09-03T10:00:00.000Z" },
                _links: { download: "/download/attachments/123/report.txt" },
            }],
        },
    }));
}

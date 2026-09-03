/**
 * Tests for the metadata, directory, filter, agile-write and service-desk
 * clients.
 *
 * The behaviours worth pinning here are the ones that are not obvious from the
 * REST calls themselves: the version-dependent fallbacks (Jira DC 9 removed the
 * global `createmeta` and never had `/filter/search`), the read-then-merge
 * writes that stop an omitted field from being cleared, and the batch limits
 * that exist so an agent gets an actionable message instead of an opaque 400.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { JiraAgileClient } from "../jiraAgileClient.js";
import { JiraClient } from "../jiraClient.js";
import { JiraDirectoryClient } from "../jiraDirectoryClient.js";
import { JiraFilterClient } from "../jiraFilterClient.js";
import { JiraMetaClient } from "../jiraMetaClient.js";
import { JiraServiceDeskClient } from "../jiraServiceDeskClient.js";
import {
    domainError,
    recordRequest,
    sendResponse,
    withStubServer,
    type RequestRecord,
} from "./testServer.js";

/** Routes a request to the first matching `[predicate, response]` pair. */
type Route = [test: (url: URL, method: string) => boolean, body: unknown, status?: number];

function routedServer(routes: Route[]) {
    return async (req: any, res: any, requests: RequestRecord[]) => {
        const record = await recordRequest(req, requests);
        const url = new URL(record.url, "http://127.0.0.1");
        const match = routes.find(([predicate]) => predicate(url, record.method));
        if (!match) {
            sendResponse(res, { status: 404, body: JSON.stringify({ errorMessages: ["no route"] }) });
            return;
        }
        const [, body, status] = match;
        sendResponse(res, {
            status: status ?? 200,
            headers: { "content-type": "application/json" },
            body: typeof body === "string" ? body : JSON.stringify(body),
        });
    };
}

function bodyOf(record: RequestRecord | undefined): any {
    return JSON.parse(record?.body.toString("utf8") || "null");
}

describe("JiraMetaClient create metadata", () => {
    test("uses the legacy endpoint and caps a field's allowed values", async () => {
        const manyOptions = Array.from({ length: 120 }, (_, index) => ({ name: `option-${index}` }));
        await withStubServer(
            routedServer([[
                (url) => url.pathname === "/rest/api/2/issue/createmeta",
                {
                    projects: [{
                        id: "1", key: "ABC", name: "Alpha",
                        issuetypes: [{
                            id: "10", name: "Bug", subtask: false,
                            fields: {
                                components: {
                                    name: "Component/s", required: true,
                                    schema: { type: "array", items: "component" },
                                    operations: ["add", "set", "remove"],
                                    allowedValues: manyOptions,
                                },
                            },
                        }],
                    }],
                },
            ]]),
            async (baseUrl, requests) => {
                const client = new JiraMetaClient({ baseUrl, pat: "test-pat" });
                const meta = await client.getCreateMeta({ projectKeys: ["ABC"] });

                assert.equal(meta.source, "createmeta");
                const field = meta.projects[0]?.issueTypes[0]?.fields[0];
                assert.equal(field?.id, "components");
                assert.equal(field?.required, true);
                assert.deepEqual(field?.operations, ["add", "set", "remove"]);
                // A create screen with hundreds of components must not be able
                // to spend the model's whole context on one field.
                assert.equal(field?.allowedValues.length, 50);
                assert.equal(field?.allowedValuesTruncated, true);

                const url = new URL(requests[0]!.url, "http://127.0.0.1");
                assert.equal(url.searchParams.get("projectKeys"), "ABC");
                assert.equal(url.searchParams.get("expand"), "projects.issuetypes.fields");
            },
        );
    });

    test("falls back to the per-project endpoints when the legacy one is gone", async () => {
        await withStubServer(
            routedServer([
                [(url) => url.pathname === "/rest/api/2/issue/createmeta", { errorMessages: ["gone"] }, 404],
                [
                    (url) => url.pathname === "/rest/api/2/issue/createmeta/ABC/issuetypes",
                    { values: [{ id: "10", name: "Bug", subtask: false }, { id: "11", name: "Task" }] },
                ],
                [
                    (url) => url.pathname === "/rest/api/2/issue/createmeta/ABC/issuetypes/10",
                    { values: [{ fieldId: "summary", name: "Summary", required: true, schema: { type: "string" } }] },
                ],
            ]),
            async (baseUrl, requests) => {
                const client = new JiraMetaClient({ baseUrl, pat: "test-pat" });
                const meta = await client.getCreateMeta({ projectKeys: ["ABC"], issueTypeNames: ["Bug"] });

                assert.equal(meta.source, "createmeta-split");
                assert.equal(meta.projects[0]?.issueTypes.length, 1, "issueTypeNames must narrow the split walk too");
                assert.equal(meta.projects[0]?.issueTypes[0]?.fields[0]?.id, "summary");
                // Only the requested issue type's fields are fetched: one
                // issuetypes call plus one field call, not one per type.
                assert.equal(requests.length, 3);
            },
        );
    });

    test("refuses the split fallback without project keys instead of returning nothing", async () => {
        await withStubServer(
            routedServer([[(url) => url.pathname === "/rest/api/2/issue/createmeta", {}, 404]]),
            async (baseUrl) => {
                const client = new JiraMetaClient({ baseUrl, pat: "test-pat" });
                await assert.rejects(
                    () => client.getCreateMeta({}),
                    domainError(/projectKeys/),
                );
            },
        );
    });

    test("derives project role IDs from the self URLs Jira returns as a map", async () => {
        await withStubServer(
            routedServer([[
                (url) => url.pathname === "/rest/api/2/project/ABC/role",
                { Developers: "https://jira.example/rest/api/2/project/ABC/role/10100" },
            ]]),
            async (baseUrl) => {
                const client = new JiraMetaClient({ baseUrl, pat: "test-pat" });
                const roles = await client.listProjectRoles("ABC");
                assert.deepEqual(roles, [{ name: "Developers", id: "10100" }]);
            },
        );
    });

    test("reports only the groups the current user actually belongs to", async () => {
        await withStubServer(
            routedServer([[
                (url) => url.pathname === "/rest/api/2/myself",
                { name: "jkowalski", displayName: "Jan Kowalski", groups: { items: [{ name: "jira-users" }] } },
            ]]),
            async (baseUrl) => {
                const client = new JiraMetaClient({ baseUrl, pat: "test-pat" });
                const me = await client.getMyself();
                assert.equal(me.name, "jkowalski");
                assert.deepEqual(me.groups, ["jira-users"]);
            },
        );
    });
});

describe("JiraDirectoryClient", () => {
    test("caps directory results so a search cannot dump the staff list", async () => {
        await withStubServer(
            routedServer([[(url) => url.pathname === "/rest/api/2/user/search", []]]),
            async (baseUrl, requests) => {
                const client = new JiraDirectoryClient({ baseUrl, pat: "test-pat" });
                await client.searchUsers("a", 5_000);

                const url = new URL(requests[0]!.url, "http://127.0.0.1");
                assert.equal(url.searchParams.get("maxResults"), "50");
                assert.equal(url.searchParams.get("includeInactive"), "false");
                // Data Center is username-based; `query` is the Cloud parameter
                // and silently returns everything here.
                assert.equal(url.searchParams.get("username"), "a");
            },
        );
    });

    test("refuses an unscoped assignable-user search before contacting Jira", async () => {
        await withStubServer(
            routedServer([[() => true, []]]),
            async (baseUrl, requests) => {
                const client = new JiraDirectoryClient({ baseUrl, pat: "test-pat" });
                await assert.rejects(
                    () => client.findAssignableUsers({ query: "jan" }),
                    domainError(/issueKey or projectKey/),
                );
                assert.equal(requests.length, 0, "an unusable request must not reach the network");
            },
        );
    });

    test("returns only granted permissions", async () => {
        await withStubServer(
            routedServer([[
                (url) => url.pathname === "/rest/api/2/mypermissions",
                {
                    permissions: {
                        EDIT_ISSUES: { name: "Edit Issues", havePermission: true },
                        DELETE_ISSUES: { name: "Delete Issues", havePermission: false },
                    },
                },
            ]]),
            async (baseUrl) => {
                const client = new JiraDirectoryClient({ baseUrl, pat: "test-pat" });
                const permissions = await client.getMyPermissions({ projectKey: "ABC" });
                assert.deepEqual(permissions.map((permission) => permission.key), ["EDIT_ISSUES"]);
            },
        );
    });
});

describe("JiraFilterClient", () => {
    const FILTER = {
        id: "10100",
        name: "Open bugs",
        description: "Bugs still open",
        jql: "type = Bug AND resolution = Unresolved",
        favourite: true,
        owner: { displayName: "Jan Kowalski", name: "jkowalski" },
        sharePermissions: [
            { id: "1", type: "group", group: { name: "jira-users" } },
            { id: "2", type: "global" },
        ],
    };

    test("renders share permissions as something a person can read", async () => {
        await withStubServer(
            routedServer([[(url) => url.pathname === "/rest/api/2/filter/10100", FILTER]]),
            async (baseUrl) => {
                const client = new JiraFilterClient({ baseUrl, pat: "test-pat" });
                const filter = await client.getFilter("10100");
                assert.deepEqual(filter.sharedWith, ["group:jira-users", "global (anyone who can log in)"]);
                assert.match(filter.url, /\?filter=10100$/);
            },
        );
    });

    test("falls back to favourites where Data Center has no filter search", async () => {
        await withStubServer(
            routedServer([
                [(url) => url.pathname === "/rest/api/2/filter/search", { errorMessages: ["not found"] }, 404],
                [(url) => url.pathname === "/rest/api/2/filter/favourite", [FILTER, { ...FILTER, id: "2", name: "Other" }]],
            ]),
            async (baseUrl) => {
                const client = new JiraFilterClient({ baseUrl, pat: "test-pat" });
                const result = await client.searchFilters({ name: "open" });

                // The narrower source must be reported, or "one match" reads as
                // "only one such filter exists on the instance".
                assert.equal(result.source, "favourites");
                assert.deepEqual(result.filters.map((filter) => filter.name), ["Open bugs"]);
            },
        );
    });

    test("merges an update with the stored definition so omitted fields survive", async () => {
        await withStubServer(
            routedServer([
                [(url, method) => url.pathname === "/rest/api/2/filter/10100" && method === "GET", FILTER],
                [(url, method) => url.pathname === "/rest/api/2/filter/10100" && method === "PUT", FILTER],
            ]),
            async (baseUrl, requests) => {
                const client = new JiraFilterClient({ baseUrl, pat: "test-pat" });
                await client.updateFilter("10100", { name: "Renamed" });

                const put = bodyOf(requests.find((record) => record.method === "PUT"));
                assert.equal(put.name, "Renamed");
                // Jira replaces the filter on PUT; an unsent JQL would blank the
                // query for everyone it is shared with.
                assert.equal(put.jql, FILTER.jql);
                assert.equal(put.description, FILTER.description);
            },
        );
    });

    test("shares view-only and refuses a share with no target", async () => {
        await withStubServer(
            routedServer([[
                (url, method) => url.pathname === "/rest/api/2/filter/10100/permission" && method === "POST",
                [{ id: "3", type: "group", group: { name: "jira-users" } }],
            ]]),
            async (baseUrl, requests) => {
                const client = new JiraFilterClient({ baseUrl, pat: "test-pat" });

                await assert.rejects(
                    () => client.addFilterPermission("10100", { type: "group" }),
                    domainError(/groupName/),
                );
                assert.equal(requests.length, 0);

                await client.addFilterPermission("10100", { type: "group", groupName: "jira-users" });
                const posted = bodyOf(requests[0]);
                assert.equal(posted.groupname, "jira-users");
                assert.equal(posted.view, true);
                assert.equal(posted.edit, false, "sharing must not hand out edit rights on the query");
            },
        );
    });

    test("toggles favourites through the v1 path Data Center actually serves", async () => {
        await withStubServer(
            routedServer([
                [(url) => url.pathname === "/rest/api/1.0/filters/10100/favourite", {}],
                [(url) => url.pathname === "/rest/api/2/filter/10100", FILTER],
            ]),
            async (baseUrl, requests) => {
                const client = new JiraFilterClient({ baseUrl, pat: "test-pat" });
                await client.setFilterFavourite("10100", false);

                assert.equal(requests[0]?.method, "DELETE");
                assert.match(requests[0]!.url, /^\/rest\/api\/1\.0\/filters\/10100\/favourite/);
            },
        );
    });
});

describe("JiraAgileClient writes", () => {
    test("partially updates a sprint with POST rather than replacing it with PUT", async () => {
        await withStubServer(
            routedServer([[
                (url, method) => url.pathname === "/rest/agile/1.0/sprint/7" && method === "POST",
                { id: 7, name: "Sprint 7", state: "active" },
            ]]),
            async (baseUrl, requests) => {
                const client = new JiraAgileClient({ baseUrl, pat: "test-pat" });
                const sprint = await client.updateSprint(7, { state: "active" });

                assert.equal(sprint.state, "active");
                assert.equal(requests[0]?.method, "POST");
                // A PUT here would blank the sprint's name, goal and dates.
                assert.deepEqual(bodyOf(requests[0]), { state: "active" });
            },
        );
    });

    test("refuses an oversized batch with a message that says what to do", async () => {
        await withStubServer(
            routedServer([[() => true, {}]]),
            async (baseUrl, requests) => {
                const client = new JiraAgileClient({ baseUrl, pat: "test-pat" });
                const keys = Array.from({ length: 51 }, (_, index) => `ABC-${index + 1}`);

                await assert.rejects(
                    () => client.moveIssuesToSprint(7, keys),
                    domainError(/at most 50 issues/, /Split the batch/),
                );
                assert.equal(requests.length, 0);
            },
        );
    });

    test("requires exactly one rank anchor", async () => {
        await withStubServer(
            routedServer([[() => true, {}]]),
            async (baseUrl, requests) => {
                const client = new JiraAgileClient({ baseUrl, pat: "test-pat" });

                await assert.rejects(
                    () => client.rankIssues({ issueKeys: ["ABC-1"] }),
                    domainError(/exactly one/),
                );
                await assert.rejects(
                    () => client.rankIssues({
                        issueKeys: ["ABC-1"],
                        rankBeforeIssue: "ABC-2",
                        rankAfterIssue: "ABC-3",
                    }),
                    domainError(/exactly one/),
                );
                assert.equal(requests.length, 0);
            },
        );
    });
});

describe("JiraClient issue extras", () => {
    test("reports bulk create failures alongside the issues that were created", async () => {
        await withStubServer(
            routedServer([[
                (url, method) => url.pathname === "/rest/api/2/issue/bulk" && method === "POST",
                {
                    issues: [{ id: "1", key: "ABC-1" }],
                    errors: [{
                        failedElementNumber: 1,
                        elementErrors: { errorMessages: [], errors: { summary: "Summary is required" } },
                    }],
                },
            ]]),
            async (baseUrl) => {
                const client = new JiraClient({ baseUrl, pat: "test-pat" });
                const result = await client.bulkCreateIssues([
                    { projectKey: "ABC", issueType: "Bug", summary: "One" },
                    { projectKey: "ABC", issueType: "Bug", summary: "" },
                ]);

                // Partial success is the normal case; hiding the failures would
                // let a caller conclude the whole batch landed.
                assert.equal(result.requested, 2);
                assert.deepEqual(result.created.map((issue) => issue.key), ["ABC-1"]);
                assert.equal(result.failed[0]?.index, 1);
                assert.match(result.failed[0]?.message ?? "", /summary: Summary is required/);
            },
        );
    });

    test("refuses a notification with no recipients before sending mail", async () => {
        await withStubServer(
            routedServer([[() => true, {}]]),
            async (baseUrl, requests) => {
                const client = new JiraClient({ baseUrl, pat: "test-pat" });
                await assert.rejects(
                    () => client.notifyIssue("ABC-1", { subject: "Hi", body: "Text" }),
                    domainError(/at least one recipient/),
                );
                assert.equal(requests.length, 0);
            },
        );
    });

    test("keeps a worklog's untouched fields when editing one of them", async () => {
        await withStubServer(
            routedServer([
                [
                    (url, method) => url.pathname === "/rest/api/2/issue/ABC-1/worklog" && method === "GET",
                    { worklogs: [{ id: "900", timeSpent: "2h", comment: "Original note", timeSpentSeconds: 7200 }] },
                ],
                [
                    (url, method) => url.pathname === "/rest/api/2/issue/ABC-1/worklog/900" && method === "PUT",
                    { id: "900", timeSpent: "3h", comment: "Original note" },
                ],
            ]),
            async (baseUrl, requests) => {
                const client = new JiraClient({ baseUrl, pat: "test-pat" });
                await client.updateWorklog("ABC-1", "900", { timeSpent: "3h" });

                const put = bodyOf(requests.find((record) => record.method === "PUT"));
                assert.equal(put.timeSpent, "3h");
                assert.equal(put.comment, "Original note", "an omitted comment must not be blanked");
            },
        );
    });

    test("names a worklog that does not exist instead of failing on a property access", async () => {
        await withStubServer(
            routedServer([[(url) => url.pathname === "/rest/api/2/issue/ABC-1/worklog", { worklogs: [] }]]),
            async (baseUrl) => {
                const client = new JiraClient({ baseUrl, pat: "test-pat" });
                await assert.rejects(
                    () => client.updateWorklog("ABC-1", "900", { timeSpent: "3h" }),
                    domainError(/Worklog 900 was not found/),
                );
            },
        );
    });
});

describe("JiraServiceDeskClient", () => {
    test("opts into the experimental API without letting the header displace auth", async () => {
        await withStubServer(
            routedServer([[
                (url) => url.pathname === "/rest/servicedeskapi/request/SUP-1/sla",
                {
                    values: [{
                        name: "Time to resolution",
                        ongoingCycle: { breached: true, remainingTime: { friendly: "-2h" }, goalDuration: { friendly: "8h" } },
                    }],
                },
            ]]),
            async (baseUrl, requests) => {
                const client = new JiraServiceDeskClient({ baseUrl, pat: "test-pat" });
                const slas = await client.getRequestSla("SUP-1");

                assert.equal(slas[0]?.breached, true);
                assert.equal(slas[0]?.ongoing, true);
                assert.equal(requests[0]?.headers["x-experimentalapi"], "opt-in");
                assert.equal(requests[0]?.headers.authorization, "Bearer test-pat");
            },
        );
    });

    test("sends the caller's public/internal choice through unchanged", async () => {
        await withStubServer(
            routedServer([[
                (url, method) => url.pathname === "/rest/servicedeskapi/request/SUP-1/comment" && method === "POST",
                { id: "5", body: "Internal note", public: false, author: { displayName: "Jan" } },
            ]]),
            async (baseUrl, requests) => {
                const client = new JiraServiceDeskClient({ baseUrl, pat: "test-pat" });
                const comment = await client.addRequestComment("SUP-1", "Internal note", false);

                assert.equal(comment.public, false);
                // Defaulting this either way silently makes a disclosure choice.
                assert.equal(bodyOf(requests[0]).public, false);
            },
        );
    });
});

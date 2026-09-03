/**
 * Tests for the extended Confluence surface.
 *
 * The behaviours pinned here are the ones where a plausible-looking
 * implementation quietly destroys content: a version restore that re-escapes
 * storage markup, a move that resends the body, a property write that blindly
 * creates over an app's existing state, and an upload that reads a file from
 * outside the configured allowlist.
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, test } from "node:test";
import { ConfluenceClient } from "../confluenceClient.js";
import {
    domainError,
    recordRequest,
    sendResponse,
    withStubServer,
    withTemporaryDirectory,
    type RequestRecord,
} from "./testServer.js";

type Route = [test: (url: URL, method: string) => boolean, body: unknown, status?: number];

function routedServer(routes: Route[]) {
    return async (req: any, res: any, requests: RequestRecord[]) => {
        const record = await recordRequest(req, requests);
        const url = new URL(record.url, "http://127.0.0.1");
        const match = routes.find(([predicate]) => predicate(url, record.method));
        if (!match) {
            sendResponse(res, { status: 404, body: JSON.stringify({ message: "no route" }) });
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

const HISTORICAL_STORAGE = '<p>Old text</p><ac:structured-macro ac:name="info"/>';

describe("ConfluenceClient version restore", () => {
    test("asks for the historical status first, and falls back when it is rejected", async () => {
        const attempts: string[] = [];
        await withStubServer(
            async (req: any, res: any, requests: RequestRecord[]) => {
                const record = await recordRequest(req, requests);
                const url = new URL(record.url, "http://127.0.0.1");
                if (url.pathname === "/rest/api/content/123" && record.method === "GET"
                    && url.searchParams.get("version") === "3") {
                    const status = url.searchParams.get("status");
                    attempts.push(status ?? "(none)");
                    // A real Data Center 8.x instance rejects `status=any` with
                    // a 400 while accepting `status=historical`.
                    if (status === "any") {
                        sendResponse(res, { status: 400, body: '{"message":"invalid status"}' });
                        return;
                    }
                    sendResponse(res, {
                        headers: { "content-type": "application/json" },
                        body: JSON.stringify({
                            id: "123", title: "Runbook", version: { number: 3 },
                            body: { storage: { value: HISTORICAL_STORAGE } },
                        }),
                    });
                    return;
                }
                sendResponse(res, { status: 404, body: '{"message":"no route"}' });
            },
            async (baseUrl) => {
                const client = new ConfluenceClient({ baseUrl, pat: "test-pat" });
                const version = await client.getPageVersion("123", 3);

                assert.equal(version.storage, HISTORICAL_STORAGE);
                assert.deepEqual(attempts, ["historical"], "the working form must be tried first");
            },
        );
    });

    test("falls back to a bare version request when historical is refused", async () => {
        const attempts: string[] = [];
        await withStubServer(
            async (req: any, res: any, requests: RequestRecord[]) => {
                const record = await recordRequest(req, requests);
                const url = new URL(record.url, "http://127.0.0.1");
                const status = url.searchParams.get("status");
                attempts.push(status ?? "(none)");
                if (status === "historical") {
                    sendResponse(res, { status: 400, body: '{"message":"unknown status"}' });
                    return;
                }
                sendResponse(res, {
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({
                        id: "123", title: "Runbook", version: { number: 3 },
                        body: { storage: { value: HISTORICAL_STORAGE } },
                    }),
                });
            },
            async (baseUrl) => {
                const client = new ConfluenceClient({ baseUrl, pat: "test-pat" });
                const version = await client.getPageVersion("123", 3);

                assert.equal(version.version, 3);
                assert.deepEqual(attempts, ["historical", "(none)"]);
            },
        );
    });

    test("refuses a response that is not the version that was asked for", async () => {
        await withStubServer(
            routedServer([[
                (url, method) => url.pathname === "/rest/api/content/123" && method === "GET",
                // The live page, as a server that ignored `version` would send.
                { id: "123", title: "Runbook", version: { number: 7 }, body: { storage: { value: "<p>Live</p>" } } },
            ]]),
            async (baseUrl) => {
                const client = new ConfluenceClient({ baseUrl, pat: "test-pat" });
                await assert.rejects(
                    () => client.getPageVersion("123", 3),
                    domainError(/returned version 7.*version 3 was requested/),
                );
            },
        );
    });

    test("republishes the historical storage markup verbatim", async () => {
        await withStubServer(
            routedServer([
                [
                    (url, method) => url.pathname === "/rest/api/content/123" && method === "GET" &&
                        url.searchParams.get("version") === "3",
                    { id: "123", title: "Runbook", version: { number: 3 }, body: { storage: { value: HISTORICAL_STORAGE } } },
                ],
                [
                    (url, method) => url.pathname === "/rest/api/content/123" && method === "GET",
                    { id: "123", title: "Runbook", version: { number: 7 }, space: { key: "ENG" } },
                ],
                [
                    (url, method) => url.pathname === "/rest/api/content/123" && method === "PUT",
                    { id: "123", title: "Runbook", _links: { webui: "/display/ENG/Runbook" } },
                ],
            ]),
            async (baseUrl, requests) => {
                const client = new ConfluenceClient({ baseUrl, pat: "test-pat" });
                const restored = await client.restorePageVersion("123", 3);

                assert.equal(restored.version, 8, "a restore must be a new version, not a rewrite of the old one");

                const put = bodyOf(requests.find((record) => record.method === "PUT"));
                // Passing the historical body through the plain-text wrapper
                // would escape the macro into literal text and destroy it.
                assert.equal(put.body.storage.value, HISTORICAL_STORAGE);
                assert.equal(put.version.number, 8);
                assert.match(put.version.message, /version 3/);
            },
        );
    });

    test("refuses to 'restore' a version that is not older than the current one", async () => {
        await withStubServer(
            routedServer([
                [
                    (url, method) => url.pathname === "/rest/api/content/123" && method === "GET" &&
                        url.searchParams.get("version") === "7",
                    { id: "123", title: "Runbook", version: { number: 7 }, body: { storage: { value: "<p>x</p>" } } },
                ],
                [
                    (url, method) => url.pathname === "/rest/api/content/123" && method === "GET",
                    { id: "123", title: "Runbook", version: { number: 7 } },
                ],
            ]),
            async (baseUrl, requests) => {
                const client = new ConfluenceClient({ baseUrl, pat: "test-pat" });
                await assert.rejects(
                    () => client.restorePageVersion("123", 7),
                    domainError(/nothing to restore/),
                );
                assert.equal(requests.some((record) => record.method === "PUT"), false);
            },
        );
    });

    test("rejects a non-positive version number before contacting Confluence", async () => {
        await withStubServer(
            routedServer([[() => true, {}]]),
            async (baseUrl, requests) => {
                const client = new ConfluenceClient({ baseUrl, pat: "test-pat" });
                await assert.rejects(
                    () => client.getPageVersion("123", 0),
                    domainError(/positive integer/),
                );
                assert.equal(requests.length, 0);
            },
        );
    });
});

describe("ConfluenceClient move", () => {
    test("changes only the parent, never the body", async () => {
        await withStubServer(
            routedServer([
                [
                    (url, method) => url.pathname === "/rest/api/content/123" && method === "GET",
                    { id: "123", title: "Runbook", version: { number: 4 }, space: { key: "ENG" } },
                ],
                [
                    (url, method) => url.pathname === "/rest/api/content/123" && method === "PUT",
                    { id: "123", title: "Runbook", _links: { webui: "/display/ENG/Runbook" } },
                ],
            ]),
            async (baseUrl, requests) => {
                const client = new ConfluenceClient({ baseUrl, pat: "test-pat" });
                await client.movePage("123", "456");

                const put = bodyOf(requests.find((record) => record.method === "PUT"));
                assert.deepEqual(put.ancestors, [{ id: "456" }]);
                // Sending a body here would overwrite the page with whatever
                // the move request happened to carry.
                assert.equal(put.body, undefined);
            },
        );
    });

    test("refuses to make a page its own parent", async () => {
        await withStubServer(
            routedServer([[
                (url, method) => url.pathname === "/rest/api/content/123" && method === "GET",
                { id: "123", title: "Runbook", version: { number: 4 } },
            ]]),
            async (baseUrl) => {
                const client = new ConfluenceClient({ baseUrl, pat: "test-pat" });
                await assert.rejects(
                    () => client.movePage("123", "123"),
                    domainError(/its own parent/),
                );
            },
        );
    });
});

describe("ConfluenceClient restrictions", () => {
    test("reports restricted operations and omits the unrestricted ones", async () => {
        await withStubServer(
            routedServer([[
                (url) => url.pathname === "/rest/api/content/123/restriction/byOperation",
                {
                    read: {
                        operation: "read",
                        restrictions: {
                            user: { results: [{ username: "jkowalski", displayName: "Jan Kowalski" }] },
                            group: { results: [{ name: "hr" }] },
                        },
                    },
                    update: { operation: "update", restrictions: { user: { results: [] }, group: { results: [] } } },
                    _links: { base: "https://confluence.example" },
                },
            ]]),
            async (baseUrl) => {
                const client = new ConfluenceClient({ baseUrl, pat: "test-pat" });
                const restrictions = await client.getRestrictions("123");

                // An operation with no users and no groups is the default
                // (inherit from the space), not a restriction worth reporting.
                assert.equal(restrictions.length, 1);
                assert.equal(restrictions[0]?.operation, "read");
                assert.deepEqual(restrictions[0]?.users, ["jkowalski"]);
                assert.deepEqual(restrictions[0]?.groups, ["hr"]);
            },
        );
    });
});

describe("ConfluenceClient content properties", () => {
    test("creates a property that does not exist yet", async () => {
        await withStubServer(
            routedServer([
                [
                    (url, method) => url.pathname === "/rest/api/content/123/property/my-key" && method === "GET",
                    { message: "no property" },
                    404,
                ],
                [
                    (url, method) => url.pathname === "/rest/api/content/123/property" && method === "POST",
                    { key: "my-key", version: { number: 1 } },
                ],
            ]),
            async (baseUrl, requests) => {
                const client = new ConfluenceClient({ baseUrl, pat: "test-pat" });
                const result = await client.setContentProperty("123", "my-key", { a: 1 });

                assert.equal(result.version, 1);
                assert.equal(requests.some((record) => record.method === "POST"), true);
                assert.equal(requests.some((record) => record.method === "PUT"), false);
            },
        );
    });

    test("bumps the version when overwriting an existing property", async () => {
        await withStubServer(
            routedServer([
                [
                    (url, method) => url.pathname === "/rest/api/content/123/property/my-key" && method === "GET",
                    { key: "my-key", value: { a: 1 }, version: { number: 4 } },
                ],
                [
                    (url, method) => url.pathname === "/rest/api/content/123/property/my-key" && method === "PUT",
                    { key: "my-key", version: { number: 5 } },
                ],
            ]),
            async (baseUrl, requests) => {
                const client = new ConfluenceClient({ baseUrl, pat: "test-pat" });
                const result = await client.setContentProperty("123", "my-key", { a: 2 });

                assert.equal(result.version, 5);
                assert.equal(bodyOf(requests.find((record) => record.method === "PUT")).version.number, 5);
            },
        );
    });

    test("does not silently create over a property whose read failed for another reason", async () => {
        await withStubServer(
            routedServer([[
                (url, method) => url.pathname === "/rest/api/content/123/property/my-key" && method === "GET",
                { message: "forbidden" },
                403,
            ]]),
            async (baseUrl, requests) => {
                const client = new ConfluenceClient({ baseUrl, pat: "test-pat" });
                await assert.rejects(() => client.setContentProperty("123", "my-key", { a: 2 }));
                assert.equal(requests.some((record) => record.method === "POST"), false);
            },
        );
    });
});

describe("ConfluenceClient trash and watches", () => {
    test("restores a trashed page by setting status back to current", async () => {
        await withStubServer(
            routedServer([
                [
                    (url, method) => url.pathname === "/rest/api/content/123" && method === "GET",
                    { id: "123", version: { number: 2 } },
                ],
                [(url, method) => url.pathname === "/rest/api/content/123" && method === "PUT", { id: "123" }],
            ]),
            async (baseUrl, requests) => {
                const client = new ConfluenceClient({ baseUrl, pat: "test-pat" });
                const result = await client.restoreFromTrash("123");

                assert.equal(result.version, 3);
                const put = bodyOf(requests.find((record) => record.method === "PUT"));
                assert.equal(put.status, "current");
                assert.equal(put.version.number, 3);
                // Confluence documents restore as a status change and nothing
                // else; sending a body would rewrite the page as a side effect.
                assert.equal(put.body, undefined);
            },
        );
    });

    test("purges only content that is already trashed", async () => {
        await withStubServer(
            routedServer([[(url, method) => url.pathname === "/rest/api/content/123" && method === "DELETE", {}]]),
            async (baseUrl, requests) => {
                const client = new ConfluenceClient({ baseUrl, pat: "test-pat" });
                await client.purgeFromTrash("123");

                const url = new URL(requests[0]!.url, "http://127.0.0.1");
                // Without status=trashed this same call would trash a live page
                // instead of purging a dead one.
                assert.equal(url.searchParams.get("status"), "trashed");
            },
        );
    });

    test("watches a page with POST and unwatches with DELETE", async () => {
        await withStubServer(
            routedServer([[(url) => url.pathname === "/rest/api/user/watch/content/123", {}]]),
            async (baseUrl, requests) => {
                const client = new ConfluenceClient({ baseUrl, pat: "test-pat" });
                await client.setPageWatch("123", true);
                await client.setPageWatch("123", false);

                assert.deepEqual(requests.map((record) => record.method), ["POST", "DELETE"]);
            },
        );
    });
});

describe("ConfluenceClient attachment upload", () => {
    test("refuses a path outside the configured allowlist", async () => {
        await withTemporaryDirectory(async (allowed) => {
            await withTemporaryDirectory(async (forbidden) => {
                const outside = join(forbidden, "secret.txt");
                await writeFile(outside, "classified");

                await withStubServer(
                    routedServer([[() => true, { results: [] }]]),
                    async (baseUrl, requests) => {
                        const client = new ConfluenceClient({
                            baseUrl,
                            pat: "test-pat",
                            attachmentDirs: [allowed],
                        });

                        await assert.rejects(() => client.uploadAttachment("123", outside));
                        // Page content is written by other people; a crafted page
                        // must not be able to exfiltrate an arbitrary local file.
                        assert.equal(requests.length, 0);
                    },
                );
            });
        });
    });

    test("uploads a file from an allowed directory as multipart form data", async () => {
        await withTemporaryDirectory(async (allowed) => {
            const filePath = join(allowed, "report.txt");
            await writeFile(filePath, "hello");

            await withStubServer(
                routedServer([[
                    (url, method) => url.pathname === "/rest/api/content/123/child/attachment" && method === "POST",
                    { results: [{ id: "att1", title: "report.txt", extensions: { fileSize: 5 } }] },
                ]]),
                async (baseUrl, requests) => {
                    const client = new ConfluenceClient({
                        baseUrl,
                        pat: "test-pat",
                        attachmentDirs: [allowed],
                    });
                    const uploaded = await client.uploadAttachment("123", filePath, {
                        mimeType: "text/plain",
                        comment: "First upload",
                    });

                    assert.equal(uploaded[0]?.id, "att1");
                    assert.equal(uploaded[0]?.fileSize, 5);

                    const record = requests[0]!;
                    assert.match(String(record.headers["content-type"]), /multipart\/form-data/);
                    // Confluence rejects the upload outright without this header.
                    assert.equal(record.headers["x-atlassian-token"], "no-check");
                    const raw = record.body.toString("utf8");
                    assert.match(raw, /name="file"/);
                    assert.match(raw, /name="comment"/);
                    assert.match(raw, /name="minorEdit"/);
                },
            );
        });
    });
});

describe("ConfluenceClient global search", () => {
    test("returns entities of any type, not just pages", async () => {
        await withStubServer(
            routedServer([[
                (url) => url.pathname === "/rest/api/search",
                {
                    totalSize: 2,
                    results: [
                        { entityType: "content", content: { id: "1", type: "page" }, title: "Runbook", url: "/display/ENG/Runbook" },
                        { entityType: "user", title: "Jan Kowalski", url: "/display/~jkowalski" },
                    ],
                },
            ]]),
            async (baseUrl, requests) => {
                const client = new ConfluenceClient({ baseUrl, pat: "test-pat" });
                const found = await client.search("siteSearch ~ 'runbook'", 10);

                assert.deepEqual(found.results.map((hit) => hit.type), ["page", "user"]);
                assert.equal(found.total, 2);
                const url = new URL(requests[0]!.url, "http://127.0.0.1");
                // Highlighted excerpts are markup noise nothing here renders.
                assert.equal(url.searchParams.get("excerpt"), "none");
            },
        );
    });
});

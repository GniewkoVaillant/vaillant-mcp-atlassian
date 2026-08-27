import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, test } from "node:test";
import { JiraAgileClient } from "../jiraAgileClient.js";
import { DEFAULT_MAX_JSON_BYTES, configureHttp } from "../httpClient.js";
import { assertNoQueueOverflow } from "./testServer.js";

type Page = Record<string, unknown>;
type PageHandler = (url: URL, requestNumber: number) => Page;

async function withAgileServer(
  handler: PageHandler,
  run: (baseUrl: string, requests: URL[]) => Promise<void>,
): Promise<void> {
  const requests: URL[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    requests.push(url);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(handler(url, requests.length)));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  try {
    const { port } = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${port}`, requests);
  } finally {
    const closed = new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    server.closeAllConnections();
    await closed;
  }
}

describe("JiraAgileClient bounded pagination", () => {
  test("fetches all board pages and preserves filters and board summaries", async () => {
    await withAgileServer((url, requestNumber) => ({
      startAt: Number(url.searchParams.get("startAt")),
      total: 2,
      isLast: requestNumber === 2,
      values: [{
        id: requestNumber,
        name: `Board ${requestNumber}`,
        type: "scrum",
        location: { projectKey: "SAFE", projectName: "Safe project" },
      }],
    }), async (baseUrl, requests) => {
      const client = new JiraAgileClient({ baseUrl, pat: "test-pat", maxPaginationPages: 2 });

      const boards = await client.listBoards({ name: "Board", projectKeyOrId: "SAFE" });

      assert.deepEqual(boards.map((board) => board.id), [1, 2]);
      assert.equal(boards[0]?.projectKey, "SAFE");
      assert.deepEqual(requests.map((request) => request.searchParams.get("startAt")), ["0", "1"]);
      assert.equal(requests[0]?.searchParams.get("maxResults"), "50");
      assert.equal(requests[0]?.searchParams.get("name"), "Board");
      assert.equal(requests[0]?.searchParams.get("projectKeyOrId"), "SAFE");
    });
  });

  test("fetches every sprint page while retaining the state filter", async () => {
    await withAgileServer((url, requestNumber) => ({
      startAt: Number(url.searchParams.get("startAt")),
      total: 2,
      values: [{ id: requestNumber, name: `Sprint ${requestNumber}`, state: "closed" }],
    }), async (baseUrl, requests) => {
      const client = new JiraAgileClient({ baseUrl, pat: "test-pat", maxPaginationPages: 2 });

      const sprints = await client.getBoardSprints(42, "closed");

      assert.deepEqual(sprints.map((sprint) => sprint.id), [1, 2]);
      assert.equal(sprints[0]?.startDate, null);
      assert.equal(requests[0]?.pathname, "/rest/agile/1.0/board/42/sprint");
      assert.equal(requests[0]?.searchParams.get("state"), "closed");
    });
  });

  test("fetches every sprint issue page and requests the configured story-points field", async () => {
    await withAgileServer((url, requestNumber) => ({
      startAt: Number(url.searchParams.get("startAt")),
      total: 2,
      issues: [{ id: String(requestNumber), key: `SAFE-${requestNumber}` }],
    }), async (baseUrl, requests) => {
      const client = new JiraAgileClient({ baseUrl, pat: "test-pat", maxPaginationPages: 2 });

      const issues = await client.getSprintIssues(24, "customfield_10001");

      assert.deepEqual(issues.map((issue) => issue.key), ["SAFE-1", "SAFE-2"]);
      assert.equal(requests[0]?.pathname, "/rest/agile/1.0/sprint/24/issue");
      assert.equal(requests[0]?.searchParams.get("maxResults"), "100");
      assert.match(requests[0]?.searchParams.get("fields") ?? "", /customfield_10001/);
    });
  });

  test("keeps paging when Jira omits metadata and silently applies a smaller page size", async () => {
    await withAgileServer((_url, requestNumber) => ({
      values: requestNumber <= 2 ? [{ id: requestNumber, name: `Board ${requestNumber}` }] : [],
    }), async (baseUrl, requests) => {
      const client = new JiraAgileClient({ baseUrl, pat: "test-pat", maxPaginationPages: 3 });

      const boards = await client.listBoards();

      assert.deepEqual(boards.map((board) => board.id), [1, 2]);
      assert.equal(requests.length, 3);
    });
  });

  for (const operation of ["boards", "sprints", "issues"] as const) {
    test(`fails explicitly without fetching more than the configured budget for ${operation}`, async () => {
      await withAgileServer((url, requestNumber) => ({
        startAt: Number(url.searchParams.get("startAt")),
        total: 100,
        [operation === "issues" ? "issues" : "values"]: [{ id: requestNumber }],
      }), async (baseUrl, requests) => {
        const client = new JiraAgileClient({ baseUrl, pat: "test-pat", maxPaginationPages: 2 });
        const run = operation === "boards"
          ? () => client.listBoards()
          : operation === "sprints"
            ? () => client.getBoardSprints(42)
            : () => client.getSprintIssues(24, null);

        await assert.rejects(run, /limit of 2 pages.*2 of 100 results fetched.*ATLASSIAN_MAX_PAGINATION_PAGES/s);
        assert.equal(requests.length, 2);
      });
    });
  }

  test("defaults to a strict ten-page upstream budget", async () => {
    await withAgileServer((url, requestNumber) => ({
      startAt: Number(url.searchParams.get("startAt")),
      total: 100,
      issues: [{ id: requestNumber, key: `SAFE-${requestNumber}` }],
    }), async (baseUrl, requests) => {
      const client = new JiraAgileClient({ baseUrl, pat: "test-pat" });

      await assert.rejects(() => client.getSprintIssues(24, null), /limit of 10 pages/);
      assert.equal(requests.length, 10);
    });
  });

  test("rejects a server that reports the same startAt after the cursor advances", async () => {
    await withAgileServer((_url, requestNumber) => ({
      startAt: 0,
      total: 3,
      values: [{ id: requestNumber }],
    }), async (baseUrl, requests) => {
      const client = new JiraAgileClient({ baseUrl, pat: "test-pat" });

      await assert.rejects(() => client.listBoards(), /did not advance.*requested startAt=1.*returned startAt=0/s);
      assert.equal(requests.length, 2);
    });
  });

  test("rejects repeated result pages even when Jira omits its startAt metadata", async () => {
    await withAgileServer(() => ({
      total: 3,
      values: [{ id: 7, name: "Repeated board" }],
    }), async (baseUrl, requests) => {
      const client = new JiraAgileClient({ baseUrl, pat: "test-pat" });

      await assert.rejects(() => client.listBoards(), /repeated page.*startAt=1/s);
      assert.equal(requests.length, 2);
    });
  });

  test("rejects an empty non-final page instead of returning partial sprint data", async () => {
    await withAgileServer((url, requestNumber) => ({
      startAt: Number(url.searchParams.get("startAt")),
      total: 3,
      isLast: false,
      values: requestNumber === 1 ? [{ id: 1, name: "First sprint" }] : [],
    }), async (baseUrl, requests) => {
      const client = new JiraAgileClient({ baseUrl, pat: "test-pat" });

      await assert.rejects(() => client.getBoardSprints(42), /empty page.*before all results were retrieved/s);
      assert.equal(requests.length, 2);
    });
  });

  test("rejects malformed page values and totals", async () => {
    await withAgileServer(() => ({ values: "invalid" }), async (baseUrl) => {
      const client = new JiraAgileClient({ baseUrl, pat: "test-pat" });

      await assert.rejects(() => client.listBoards(), /invalid values page/);
    });

    await withAgileServer(() => ({ total: -1, values: [{ id: 1 }] }), async (baseUrl) => {
      const client = new JiraAgileClient({ baseUrl, pat: "test-pat" });

      await assert.rejects(() => client.listBoards(), /invalid total/);
    });
  });

  test("rejects invalid page budgets before making any upstream requests", () => {
    for (const maxPaginationPages of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(
        () => new JiraAgileClient({ baseUrl: "http://127.0.0.1", pat: "test-pat", maxPaginationPages }),
        /positive safe integer/,
      );
    }
  });
});

/**
 * getBoardVelocity is the other nested fan-out in this codebase: an outer
 * mapWithConcurrency over sprints, each of which pages a sprint report. Like
 * the ProForma summary it was only ever exercised at whatever budget the test
 * happened to set, so the interaction with the shipped admission queue went
 * untested.
 */
describe("JiraAgileClient nested fan-out under the shipped request budget", () => {
  const PRODUCTION_HTTP_DEFAULTS = {
    timeoutMs: 30_000,
    totalTimeoutMs: 45_000,
    maxConcurrentRequests: 4,
    maxQueuedRequests: 16,
    maxAttempts: 3,
    maxJsonBytes: DEFAULT_MAX_JSON_BYTES,
  } as const;

  afterEach(() => {
    configureHttp({ ...PRODUCTION_HTTP_DEFAULTS });
  });

  test("getBoardVelocity never overflows the default 4 active / 16 queued budget", async () => {
    configureHttp({ ...PRODUCTION_HTTP_DEFAULTS });

    const sprints = Array.from({ length: 24 }, (_unused, index) => ({
      id: index + 1,
      name: `Sprint ${index + 1}`,
      state: "closed",
      startDate: `2024-01-${String((index % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
      endDate: `2024-02-${String((index % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
      originBoardId: 1,
    }));

    await withAgileServer(
      (url) => {
        if (url.pathname.endsWith("/sprint")) {
          return { values: sprints, isLast: true, startAt: 0, maxResults: 50, total: sprints.length };
        }
        if (url.pathname.endsWith("/configuration")) {
          return { estimation: { field: { fieldId: "customfield_10004", displayName: "Story Points" } } };
        }
        if (url.pathname.includes("sprintreport")) {
          return {
            contents: {
              completedIssues: [],
              issuesNotCompletedInCurrentSprint: [],
              puntedIssues: [],
              completedIssuesEstimateSum: { value: 0 },
              issuesNotCompletedEstimateSum: { value: 0 },
            },
            sprint: { id: 1, name: "Sprint 1", startDate: "01/Jan/24", endDate: "01/Feb/24" },
          };
        }
        return { values: [], issues: [], isLast: true, startAt: 0, maxResults: 50, total: 0 };
      },
      async (baseUrl) => {
        const client = new JiraAgileClient({ baseUrl, pat: "synthetic-token" });
        await assertNoQueueOverflow(() => client.getBoardVelocity(1, 20));
      },
    );
  });
});

import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import {
  AtlassianHttpError,
  DEFAULT_MAX_JSON_BYTES,
  atlassianDelete,
  atlassianGet,
  atlassianGetBinary,
  atlassianPost,
  atlassianPostFormData,
  atlassianPut,
  configureHttp,
} from "../httpClient.js";
import { recordRequest, scriptedHandler, sendResponse, withStubServer } from "./testServer.js";

const pat = "test-pat";

function resetHttpDefaults(): void {
  configureHttp({
    timeoutMs: 30_000,
    totalTimeoutMs: 45_000,
    maxConcurrentRequests: 4,
    maxQueuedRequests: 16,
    maxAttempts: 3,
    maxJsonBytes: DEFAULT_MAX_JSON_BYTES,
  });
}

afterEach(() => {
  resetHttpDefaults();
});

async function assertAtlassianHttpError(
  action: () => Promise<unknown>,
): Promise<AtlassianHttpError> {
  try {
    await action();
  } catch (err) {
    assert.ok(err instanceof AtlassianHttpError);
    return err;
  }
  assert.fail("Expected AtlassianHttpError");
}

function assertElapsedUnder(started: number, limitMs: number): void {
  const elapsed = performance.now() - started;
  assert.ok(elapsed < limitMs, `operation took ${elapsed.toFixed(1)} ms, expected under ${limitMs} ms`);
}

async function assertError(action: () => Promise<unknown>): Promise<Error> {
  try {
    await action();
  } catch (err) {
    assert.ok(err instanceof Error);
    return err;
  }
  assert.fail("Expected Error");
}

describe("httpClient success paths", () => {
  test("GET returns parsed JSON", async () => {
    await withStubServer(scriptedHandler([{ body: '{"ok":true}' }]), async (baseUrl) => {
      const result = await atlassianGet<{ ok: boolean }>({ baseUrl, pat, path: "/rest/api/2/myself" });

      assert.deepEqual(result, { ok: true });
    });
  });

  test("GET returns undefined for an empty response body", async () => {
    await withStubServer(scriptedHandler([{ body: "" }]), async (baseUrl) => {
      const result = await atlassianGet({ baseUrl, pat, path: "/rest/api/2/empty" });

      assert.equal(result, undefined);
    });
  });

  test("GET reports a clear error when a successful response body is not JSON", async () => {
    await withStubServer(scriptedHandler([{ body: "not json" }]), async (baseUrl) => {
      const err = await assertError(() => atlassianGet({ baseUrl, pat, path: "/rest/api/2/bad-json" }));

      assert.match(err.message, /Failed to parse JSON response/);
      assert.match(err.message, /not json/);
    });
  });

  test("GET sends Bearer authorization and application JSON accept headers", async () => {
    await withStubServer(scriptedHandler([{ body: "{}" }]), async (baseUrl, requests) => {
      await atlassianGet({ baseUrl, pat, path: "/rest/api/2/myself" });

      assert.equal(requests[0]?.headers.authorization, `Bearer ${pat}`);
      assert.equal(requests[0]?.headers.accept, "application/json");
    });
  });

  test("GET appends query parameters and omits undefined values entirely", async () => {
    await withStubServer(scriptedHandler([{ body: "{}" }]), async (baseUrl, requests) => {
      await atlassianGet({
        baseUrl,
        pat,
        path: "/rest/api/2/search",
        query: { jql: "project = ABC", maxResults: 50, validateQuery: false, omitted: undefined },
      });

      const url = new URL(requests[0]?.url ?? "", baseUrl);
      assert.equal(url.searchParams.get("jql"), "project = ABC");
      assert.equal(url.searchParams.get("maxResults"), "50");
      assert.equal(url.searchParams.get("validateQuery"), "false");
      assert.equal(url.searchParams.has("omitted"), false);
    });
  });

  test("POST sends a JSON body and application JSON content type", async () => {
    await withStubServer(scriptedHandler([{ body: '{"created":true}' }]), async (baseUrl, requests) => {
      const result = await atlassianPost<{ created: boolean }>({
        baseUrl,
        pat,
        path: "/rest/api/2/issue",
        body: { fields: { summary: "Test" } },
      });

      assert.deepEqual(result, { created: true });
      assert.equal(requests[0]?.method, "POST");
      assert.equal(requests[0]?.headers["content-type"], "application/json");
      assert.deepEqual(JSON.parse(requests[0]?.body.toString("utf8") ?? ""), { fields: { summary: "Test" } });
    });
  });

  test("PUT sends a JSON body and application JSON content type", async () => {
    await withStubServer(scriptedHandler([{ body: "{}" }]), async (baseUrl, requests) => {
      await atlassianPut({
        baseUrl,
        pat,
        path: "/rest/api/2/issue/ABC-1",
        body: { fields: { priority: { name: "High" } } },
      });

      assert.equal(requests[0]?.method, "PUT");
      assert.equal(requests[0]?.headers["content-type"], "application/json");
      assert.deepEqual(JSON.parse(requests[0]?.body.toString("utf8") ?? ""), {
        fields: { priority: { name: "High" } },
      });
    });
  });

  test("atlassianPostFormData sends X-Atlassian-Token no-check and does not force JSON content type", async () => {
    await withStubServer(scriptedHandler([{ body: "{}" }]), async (baseUrl, requests) => {
      const formData = new FormData();
      formData.set("file", new Blob(["hello"]), "hello.txt");

      await atlassianPostFormData({ baseUrl, pat, path: "/rest/api/2/issue/ABC-1/attachments", body: formData });

      assert.equal(requests[0]?.headers["x-atlassian-token"], "no-check");
      assert.notEqual(requests[0]?.headers["content-type"], "application/json");
      assert.match(String(requests[0]?.headers["content-type"]), /^multipart\/form-data; boundary=/);
    });
  });

  test("atlassianGetBinary returns a Buffer with content type", async () => {
    await withStubServer(
      scriptedHandler([{ headers: { "Content-Type": "application/pdf" }, body: Buffer.from([1, 2, 3]) }]),
      async (baseUrl) => {
        const result = await atlassianGetBinary({ baseUrl, pat, path: "/download/1" });

        assert.deepEqual(result.data, Buffer.from([1, 2, 3]));
        assert.equal(result.contentType, "application/pdf");
      },
    );
  });
});

describe("httpClient same-origin guard", () => {
  test("GET allows an absolute URL on the same origin as the base URL", async () => {
    await withStubServer(scriptedHandler([{ body: '{"sameOrigin":true}' }]), async (baseUrl) => {
      const result = await atlassianGet<{ sameOrigin: boolean }>({
        baseUrl,
        pat,
        path: `${baseUrl}/rest/api/2/content`,
      });

      assert.deepEqual(result, { sameOrigin: true });
    });
  });

  test("GET refuses an absolute URL on a different origin before sending credentials", async () => {
    await withStubServer(scriptedHandler([{ body: "{}" }]), async (baseUrl, requests) => {
      const err = await assertError(() =>
        atlassianGet({ baseUrl, pat, path: "http://example.invalid/rest/api/2/content" }),
      );

      assert.match(err.message, /Refusing to send Atlassian credentials to a different origin/);
      assert.equal(requests.length, 0);
    });
  });

  test("GET follows a same-origin redirect without dropping its authorization", async () => {
    await withStubServer(
      async (req, res, requests) => {
        await recordRequest(req, requests);
        if (requests.length === 1) {
          sendResponse(res, { status: 302, headers: { Location: "/rest/api/2/final" } });
          return;
        }
        sendResponse(res, { body: '{"redirected":true}' });
      },
      async (baseUrl, requests) => {
        const result = await atlassianGet<{ redirected: boolean }>({ baseUrl, pat, path: "/redirect" });

        assert.deepEqual(result, { redirected: true });
        assert.equal(requests.length, 2);
        assert.equal(requests[1]?.headers.authorization, `Bearer ${pat}`);
      },
    );
  });

  test("GET rejects a cross-origin redirect before contacting its target or exposing a PAT", async () => {
    await withStubServer(scriptedHandler([{ body: "{}" }]), async (otherOrigin, targetRequests) => {
      await withStubServer(
        scriptedHandler([{ status: 302, headers: { Location: `${otherOrigin}/capture` } }]),
        async (baseUrl, sourceRequests) => {
          await assert.rejects(
            () => atlassianGet({ baseUrl, pat, path: "/redirect" }),
            /Refusing to follow Atlassian redirect to a different origin/,
          );

          assert.equal(sourceRequests.length, 1);
          assert.equal(targetRequests.length, 0);
        },
      );
    });
  });
});

describe("httpClient error handling", () => {
  test("GET throws AtlassianHttpError with status statusText and body snippet for non-retryable 404 without retrying", async () => {
    await withStubServer(
      scriptedHandler([{ status: 404, statusMessage: "Not Found", body: "missing issue" }]),
      async (baseUrl, requests) => {
        const err = await assertAtlassianHttpError(() => atlassianGet({ baseUrl, pat, path: "/rest/api/2/issue/NOPE-1" }));

        assert.equal(err.status, 404);
        assert.equal(err.statusText, "Not Found");
        assert.equal(err.bodySnippet, "missing issue");
        assert.equal(requests.length, 1);
      },
    );
  });

  test("GET truncates AtlassianHttpError body snippets to 500 characters", async () => {
    const longBody = "x".repeat(600);
    await withStubServer(scriptedHandler([{ status: 400, body: longBody }]), async (baseUrl) => {
      const err = await assertAtlassianHttpError(() => atlassianGet({ baseUrl, pat, path: "/rest/api/2/bad" }));

      assert.equal(err.bodySnippet.length, 500);
      assert.equal(err.bodySnippet, "x".repeat(500));
    });
  });
});

describe("httpClient retry behaviour", () => {
  test("GET retries on 429 and eventually succeeds", async () => {
    configureHttp({ maxAttempts: 3 });
    await withStubServer(
      scriptedHandler([
        { status: 429, headers: { "Retry-After": "0" }, body: "rate limited" },
        { status: 429, headers: { "Retry-After": "0" }, body: "rate limited again" },
        { body: '{"ok":true}' },
      ]),
      async (baseUrl, requests) => {
        const result = await atlassianGet<{ ok: boolean }>({ baseUrl, pat, path: "/rest/api/2/search" });

        assert.deepEqual(result, { ok: true });
        assert.equal(requests.length, 3);
      },
    );
  });

  test("GET retries on 502 503 and 504 before succeeding", async () => {
    configureHttp({ maxAttempts: 4 });
    await withStubServer(
      scriptedHandler([
        { status: 502, headers: { "Retry-After": "0" }, body: "bad gateway" },
        { status: 503, headers: { "Retry-After": "0" }, body: "unavailable" },
        { status: 504, headers: { "Retry-After": "0" }, body: "timeout" },
        { body: '{"ok":true}' },
      ]),
      async (baseUrl, requests) => {
        const result = await atlassianGet<{ ok: boolean }>({ baseUrl, pat, path: "/rest/api/2/search" });

        assert.deepEqual(result, { ok: true });
        assert.equal(requests.length, 4);
      },
    );
  });

  test("GET returns the final AtlassianHttpError when retries are exhausted after maxAttempts", async () => {
    configureHttp({ maxAttempts: 2 });
    await withStubServer(
      scriptedHandler([
        { status: 503, headers: { "Retry-After": "0" }, body: "first" },
        { status: 503, body: "final" },
      ]),
      async (baseUrl, requests) => {
        const err = await assertAtlassianHttpError(() => atlassianGet({ baseUrl, pat, path: "/rest/api/2/search" }));

        assert.equal(err.status, 503);
        assert.equal(err.bodySnippet, "final");
        assert.equal(requests.length, 2);
      },
    );
  });

  test("GET honours numeric Retry-After seconds before retrying", async () => {
    configureHttp({ maxAttempts: 2 });
    await withStubServer(
      scriptedHandler([
        { status: 429, headers: { "Retry-After": "0.05" }, body: "rate limited" },
        { body: '{"ok":true}' },
      ]),
      async (baseUrl) => {
        const started = Date.now();
        const result = await atlassianGet<{ ok: boolean }>({ baseUrl, pat, path: "/rest/api/2/search" });

        assert.deepEqual(result, { ok: true });
        assert.ok(Date.now() - started >= 40);
      },
    );
  });

  test("GET honours HTTP-date Retry-After before retrying", async () => {
    configureHttp({ maxAttempts: 2 });
    const retryAt = new Date(Date.now() + 10_000).toUTCString();
    const parsedRetryAt = Date.parse(retryAt);
    const realDateNow = Date.now;
    Date.now = () => parsedRetryAt - 50;
    try {
      await withStubServer(
        scriptedHandler([
          { status: 429, headers: { "Retry-After": retryAt }, body: "rate limited" },
          { body: '{"ok":true}' },
        ]),
        async (baseUrl) => {
          const started = performance.now();
          const result = await atlassianGet<{ ok: boolean }>({ baseUrl, pat, path: "/rest/api/2/search" });

          assert.deepEqual(result, { ok: true });
          assert.ok(performance.now() - started >= 40);
        },
      );
    } finally {
      Date.now = realDateNow;
    }
  });

  test("POST is retried on 429 because rate limiting rejects the write before processing", async () => {
    configureHttp({ maxAttempts: 2 });
    await withStubServer(
      scriptedHandler([
        { status: 429, headers: { "Retry-After": "0" }, body: "rate limited" },
        { body: '{"created":true}' },
      ]),
      async (baseUrl, requests) => {
        const result = await atlassianPost<{ created: boolean }>({ baseUrl, pat, path: "/rest/api/2/issue", body: { fields: {} } });

        assert.deepEqual(result, { created: true });
        assert.equal(requests.length, 2);
      },
    );
  });

  test("POST is not retried on 502 because replaying a maybe-applied write could duplicate it", async () => {
    configureHttp({ maxAttempts: 3 });
    await withStubServer(scriptedHandler([{ status: 502, body: "bad gateway" }]), async (baseUrl, requests) => {
      const err = await assertAtlassianHttpError(() =>
        atlassianPost({ baseUrl, pat, path: "/rest/api/2/issue", body: { fields: {} } }),
      );

      assert.equal(err.status, 502);
      assert.equal(requests.length, 1);
    });
  });

  test("POST is not retried on 503 because replaying a maybe-applied write could duplicate it", async () => {
    configureHttp({ maxAttempts: 3 });
    await withStubServer(scriptedHandler([{ status: 503, body: "unavailable" }]), async (baseUrl, requests) => {
      const err = await assertAtlassianHttpError(() =>
        atlassianPost({ baseUrl, pat, path: "/rest/api/2/issue", body: { fields: {} } }),
      );

      assert.equal(err.status, 503);
      assert.equal(requests.length, 1);
    });
  });

  test("POST is not retried on 504 because replaying a maybe-applied write could duplicate it", async () => {
    configureHttp({ maxAttempts: 3 });
    await withStubServer(scriptedHandler([{ status: 504, body: "gateway timeout" }]), async (baseUrl, requests) => {
      const err = await assertAtlassianHttpError(() =>
        atlassianPost({ baseUrl, pat, path: "/rest/api/2/issue", body: { fields: {} } }),
      );

      assert.equal(err.status, 504);
      assert.equal(requests.length, 1);
    });
  });

  test("PUT is retried on 5xx because it is idempotent", async () => {
    configureHttp({ maxAttempts: 2 });
    await withStubServer(
      scriptedHandler([
        { status: 503, headers: { "Retry-After": "0" }, body: "unavailable" },
        { body: "{}" },
      ]),
      async (baseUrl, requests) => {
        await atlassianPut({ baseUrl, pat, path: "/rest/api/2/issue/ABC-1", body: { fields: {} } });

        assert.equal(requests.length, 2);
      },
    );
  });

  test("DELETE is retried on 5xx because it is idempotent", async () => {
    configureHttp({ maxAttempts: 2 });
    await withStubServer(
      scriptedHandler([
        { status: 504, headers: { "Retry-After": "0" }, body: "timeout" },
        { body: "{}" },
      ]),
      async (baseUrl, requests) => {
        await atlassianDelete({ baseUrl, pat, path: "/rest/api/2/comment/1" });

        assert.equal(requests.length, 2);
      },
    );
  });
});

describe("httpClient timeouts", () => {
  test("GET reports a timeout error mentioning the configured timeout and ATLASSIAN_TIMEOUT_MS", async () => {
    configureHttp({ timeoutMs: 20, maxAttempts: 1 });
    await withStubServer(
      async (req, _res, requests) => {
        await recordRequest(req, requests);
      },
      async (baseUrl) => {
        const err = await assertError(() => atlassianGet({ baseUrl, pat, path: "/rest/api/2/slow" }));

        assert.match(err.message, /timed out after 20ms/);
        assert.match(err.message, /ATLASSIAN_TIMEOUT_MS/);
      },
    );
  });

  test("GET retries after timing out because it is idempotent", async () => {
    configureHttp({ timeoutMs: 20, maxAttempts: 2 });
    await withStubServer(
      async (req, res, requests) => {
        await recordRequest(req, requests);
        if (requests.length === 2) {
          sendResponse(res, { body: '{"ok":true}' });
        }
      },
      async (baseUrl, requests) => {
        const result = await atlassianGet<{ ok: boolean }>({ baseUrl, pat, path: "/rest/api/2/slow-once" });

        assert.deepEqual(result, { ok: true });
        assert.equal(requests.length, 2);
      },
    );
  });

  test("POST is not retried after timing out because a timed-out write may already have been applied", async () => {
    configureHttp({ timeoutMs: 20, maxAttempts: 3 });
    await withStubServer(
      async (req, _res, requests) => {
        await recordRequest(req, requests);
      },
      async (baseUrl, requests) => {
        const err = await assertError(() =>
          atlassianPost({ baseUrl, pat, path: "/rest/api/2/issue", body: { fields: {} } }),
        );

        assert.match(err.message, /timed out after 20ms/);
        assert.equal(requests.length, 1);
      },
    );
  });
});

describe("httpClient end-to-end deadlines and admission control", () => {
  test("an entire retried operation never waits beyond its total deadline", async () => {
    configureHttp({ timeoutMs: 25, totalTimeoutMs: 90, maxAttempts: 3 });
    await withStubServer(
      async (req, _res, requests) => {
        await recordRequest(req, requests);
      },
      async (baseUrl, requests) => {
        const started = performance.now();

        await assert.rejects(
          () => atlassianGet({ baseUrl, pat, path: "/slow-retry" }),
          /total timeout of 90ms.*ATLASSIAN_TOTAL_TIMEOUT_MS/s,
        );

        // Upper bound only has to stay well under the retry sleep it is proving we
        // skipped; a GC pause on a loaded CI box must not read as a failure.
        assertElapsedUnder(started, 900);
        assert.equal(requests.length, 1);
      },
    );
  });

  test("a Retry-After exceeding the remaining request budget fails without sleeping", async () => {
    configureHttp({ timeoutMs: 1_000, totalTimeoutMs: 100, maxAttempts: 3 });
    await withStubServer(
      scriptedHandler([{ status: 429, headers: { "Retry-After": "30" }, body: "limited" }]),
      async (baseUrl, requests) => {
        const started = performance.now();

        await assert.rejects(
          () => atlassianGet({ baseUrl, pat, path: "/rate-limited" }),
          /total timeout of 100ms.*ATLASSIAN_TOTAL_TIMEOUT_MS/s,
        );

        assertElapsedUnder(started, 1_200);
        assert.equal(requests.length, 1);
      },
    );
  });

  test("the shared request budget caps simultaneous upstream calls", async () => {
    configureHttp({
      timeoutMs: 1_000,
      totalTimeoutMs: 2_000,
      maxConcurrentRequests: 2,
      maxQueuedRequests: 8,
      maxAttempts: 1,
    });
    let current = 0;
    let maximumObserved = 0;
    await withStubServer(
      async (req, res, requests) => {
        await recordRequest(req, requests);
        current += 1;
        maximumObserved = Math.max(maximumObserved, current);
        await new Promise<void>((resolve) => setTimeout(resolve, 35));
        current -= 1;
        sendResponse(res, { body: '{"ok":true}' });
      },
      async (baseUrl, requests) => {
        const results = await Promise.all(
          Array.from({ length: 6 }, (_, index) =>
            atlassianGet<{ ok: boolean }>({ baseUrl, pat, path: `/limited/${index}` }),
          ),
        );

        assert.equal(results.length, 6);
        assert.equal(requests.length, 6);
        assert.equal(maximumObserved, 2);
      },
    );
  });

  test("a full queue rejects excess operations before they reach Jira", async () => {
    configureHttp({
      timeoutMs: 1_000,
      totalTimeoutMs: 2_000,
      maxConcurrentRequests: 1,
      maxQueuedRequests: 1,
      maxAttempts: 1,
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let firstStarted!: () => void;
    const started = new Promise<void>((resolve) => { firstStarted = resolve; });

    await withStubServer(
      async (req, res, requests) => {
        await recordRequest(req, requests);
        if (requests.length === 1) {
          firstStarted();
          await gate;
        }
        sendResponse(res, { body: '{"ok":true}' });
      },
      async (baseUrl, requests) => {
        const active = atlassianGet({ baseUrl, pat, path: "/active" });
        await started;
        const queued = atlassianGet({ baseUrl, pat, path: "/queued" });

        await assert.rejects(
          () => atlassianGet({ baseUrl, pat, path: "/rejected" }),
          /queue is full.*ATLASSIAN_MAX_QUEUED_REQUESTS/s,
        );

        release();
        await Promise.all([active, queued]);
        assert.equal(requests.length, 2);
      },
    );
  });

  test("queued requests expire within their own total deadline without reaching the upstream", async () => {
    configureHttp({
      timeoutMs: 1_000,
      totalTimeoutMs: 1_000,
      maxConcurrentRequests: 1,
      maxQueuedRequests: 2,
      maxAttempts: 1,
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let firstStarted!: () => void;
    const started = new Promise<void>((resolve) => { firstStarted = resolve; });

    await withStubServer(
      async (req, res, requests) => {
        await recordRequest(req, requests);
        firstStarted();
        await gate;
        sendResponse(res, { body: '{"ok":true}' });
      },
      async (baseUrl, requests) => {
        const active = atlassianGet({ baseUrl, pat, path: "/active" });
        await started;
        configureHttp({ totalTimeoutMs: 35 });

        await assert.rejects(
          () => atlassianGet({ baseUrl, pat, path: "/expired-in-queue" }),
          /total timeout of 35ms.*ATLASSIAN_TOTAL_TIMEOUT_MS/s,
        );

        release();
        await active;
        assert.equal(requests.length, 1);
      },
    );
  });

  test("the total deadline includes a response body that never finishes", async () => {
    configureHttp({ timeoutMs: 1_000, totalTimeoutMs: 45, maxAttempts: 1 });
    await withStubServer(
      async (req, res, requests) => {
        await recordRequest(req, requests);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.write('{"pending":');
      },
      async (baseUrl) => {
        const started = performance.now();

        await assert.rejects(
          () => atlassianGet({ baseUrl, pat, path: "/unfinished-body" }),
          /total timeout of 45ms.*ATLASSIAN_TOTAL_TIMEOUT_MS/s,
        );

        // Upper bound only has to stay well under the retry sleep it is proving we
        // skipped; a GC pause on a loaded CI box must not read as a failure.
        assertElapsedUnder(started, 900);
      },
    );
  });

  test("invalid request budgets fail closed", () => {
    assert.throws(() => configureHttp({ maxConcurrentRequests: 0 }), /Invalid HTTP option/);
    assert.throws(() => configureHttp({ maxQueuedRequests: -1 }), /Invalid HTTP option/);
    assert.throws(() => configureHttp({ totalTimeoutMs: 1.5 }), /Invalid HTTP option/);
    assert.doesNotThrow(() => configureHttp({ maxQueuedRequests: 0 }));
  });
});

describe("httpClient bounded binary response streaming", () => {
  test("rejects an oversized Content-Length before buffering the response", async () => {
    await withStubServer(
      scriptedHandler([{ headers: { "Content-Length": "8" }, body: "12345678" }]),
      async (baseUrl) => {
        await assert.rejects(
          () => atlassianGetBinary({ baseUrl, pat, path: "/large-header", maxResponseBytes: 4 }),
          /8 bytes exceeds the maximum of 4 bytes.*ATLASSIAN_MAX_ATTACHMENT_BYTES/s,
        );
      },
    );
  });

  test("stops a chunked attachment as soon as actual bytes exceed its budget", async () => {
    await withStubServer(
      async (req, res, requests) => {
        await recordRequest(req, requests);
        res.write("1234");
        res.write("5678");
        res.end();
      },
      async (baseUrl) => {
        await assert.rejects(
          () => atlassianGetBinary({ baseUrl, pat, path: "/large-chunked", maxResponseBytes: 5 }),
          /exceeds the maximum of 5 bytes.*ATLASSIAN_MAX_ATTACHMENT_BYTES/s,
        );
      },
    );
  });

  test("accepts an attachment exactly equal to its configured limit", async () => {
    await withStubServer(scriptedHandler([{ body: "1234" }]), async (baseUrl) => {
      const response = await atlassianGetBinary({ baseUrl, pat, path: "/exact", maxResponseBytes: 4 });

      assert.deepEqual(response.data, Buffer.from("1234"));
    });
  });

  test("rejects invalid attachment size budgets before making network calls", async () => {
    await withStubServer(scriptedHandler([{ body: "1234" }]), async (baseUrl, requests) => {
      await assert.rejects(
        () => atlassianGetBinary({ baseUrl, pat, path: "/invalid-limit", maxResponseBytes: 0 }),
        /maxResponseBytes must be a positive safe integer/,
      );

      assert.equal(requests.length, 0);
    });
  });
});


describe("httpClient bounded JSON response streaming", () => {
  test("rejects an oversized Content-Length before buffering the response", async () => {
    await withStubServer(
      scriptedHandler([{ headers: { "Content-Length": "24" }, body: '{"padding":"0123456789"}' }]),
      async (baseUrl) => {
        await assert.rejects(
          () => atlassianGet({ baseUrl, pat, path: "/big-header", maxResponseBytes: 8 }),
          /JSON response from .*size 24 bytes exceeds the maximum of 8 bytes \(over by 16 bytes\).*ATLASSIAN_MAX_JSON_BYTES/s,
        );
      },
    );
  });

  test("stops a chunked JSON response as soon as actual bytes exceed the budget", async () => {
    await withStubServer(
      async (req, res, requests) => {
        await recordRequest(req, requests);
        res.write('{"a":"1234567890"');
        res.write(',"b":"1234567890"}');
        res.end();
      },
      async (baseUrl) => {
        const err = await assertError(() =>
          atlassianGet({ baseUrl, pat, path: "/big-chunked", maxResponseBytes: 20 }),
        );

        assert.match(err.message, /exceeds the maximum of 20 bytes/);
        assert.match(err.message, /ATLASSIAN_MAX_JSON_BYTES/);
        // The message has to tell the model how to shrink the request, not just that it failed.
        assert.match(err.message, /fewer results/);
      },
    );
  });

  test("accepts a JSON body exactly equal to its configured limit", async () => {
    await withStubServer(scriptedHandler([{ body: '{"ok":true}' }]), async (baseUrl) => {
      const result = await atlassianGet({ baseUrl, pat, path: "/exact-json", maxResponseBytes: 11 });

      assert.deepEqual(result, { ok: true });
    });
  });

  test("falls back to the configured ATLASSIAN_MAX_JSON_BYTES budget when no explicit limit is given", async () => {
    configureHttp({ maxJsonBytes: 8 });

    await withStubServer(scriptedHandler([{ body: '{"padding":"0123456789"}' }]), async (baseUrl) => {
      await assert.rejects(
        () => atlassianGet({ baseUrl, pat, path: "/default-budget" }),
        /exceeds the maximum of 8 bytes.*ATLASSIAN_MAX_JSON_BYTES/s,
      );
    });
  });

  test("applies the JSON budget to writes, form uploads and deletes, not just GET", async () => {
    configureHttp({ maxJsonBytes: 8 });

    await withStubServer(scriptedHandler([{ body: '{"padding":"0123456789"}' }]), async (baseUrl) => {
      const form = new FormData();
      form.set("file", new Blob(["x"]), "x.txt");

      for (const call of [
        () => atlassianPost({ baseUrl, pat, path: "/write-post", body: {} }),
        () => atlassianPut({ baseUrl, pat, path: "/write-put", body: {} }),
        () => atlassianPostFormData({ baseUrl, pat, path: "/write-form", body: form }),
        () => atlassianDelete({ baseUrl, pat, path: "/write-delete" }),
      ]) {
        await assert.rejects(call, /exceeds the maximum of 8 bytes.*ATLASSIAN_MAX_JSON_BYTES/s);
      }
    });
  });

  test("rejects invalid JSON size budgets before making network calls", async () => {
    await withStubServer(scriptedHandler([{ body: "{}" }]), async (baseUrl, requests) => {
      await assert.rejects(
        () => atlassianGet({ baseUrl, pat, path: "/invalid-json-limit", maxResponseBytes: 0 }),
        /maxResponseBytes must be a positive safe integer/,
      );

      assert.equal(requests.length, 0);
    });
  });

  test("an empty JSON body still resolves to undefined under a budget", async () => {
    await withStubServer(scriptedHandler([{ body: "" }]), async (baseUrl) => {
      const result = await atlassianGet({ baseUrl, pat, path: "/empty-json", maxResponseBytes: 8 });

      assert.equal(result, undefined);
    });
  });
});

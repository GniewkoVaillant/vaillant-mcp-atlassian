import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { mkdir, readFile, stat, symlink } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { ConfluenceClient, looksLikeStorageMarkup, storageToPlainText } from "../confluenceClient.js";
import {
  UPSTREAM_GARBAGE_CASES,
  assertGarbageHandled,
  constantHandler,
  domainError,
  withStubServer,
  withTemporaryDirectory as withTemporaryDirectoryIn,
} from "./testServer.js";

const withTemporaryDirectory = (action: (directory: string) => Promise<void>): Promise<void> =>
  withTemporaryDirectoryIn(action, "confluence-mcp-attachment-test-");

describe("storageToPlainText", () => {
  test("converts paragraphs, line breaks, headings and list items", () => {
    const storage = "<h2>Title</h2><p>First<br/>Second</p><ul><li>One</li><li>Two</li></ul>";

    assert.equal(storageToPlainText(storage), "Title\n\nFirst\nSecond\n\n- One\n- Two");
  });

  test("unescapes HTML entities", () => {
    assert.equal(storageToPlainText("<p>A&nbsp;&amp;&nbsp;B &lt; C &gt; D &quot;quote&quot; &#39;apos&#39;</p>"), "A & B < C > D \"quote\" 'apos'");
  });

  test("renders anchors as label and URL and collapses duplicate or empty labels", () => {
    const storage = '<p><a href="https://example.test">Example</a> <a href="https://same.test">https://same.test</a> <a href="https://empty.test"></a></p>';

    assert.equal(storageToPlainText(storage), "Example (https://example.test) https://same.test https://empty.test");
  });

  test("renders Confluence page links as bracketed titles", () => {
    const storage = '<ac:link><ri:page ri:content-title="Runbook" /></ac:link>';

    assert.equal(storageToPlainText(storage), "[Runbook]");
  });

  test("renders self-closing and open structured macros as macro markers", () => {
    const storage = '<ac:structured-macro ac:name="toc"/><ac:structured-macro ac:name="info"><p>Body</p></ac:structured-macro>';

    assert.equal(storageToPlainText(storage), "[macro: toc]\n[macro: info]\nBody");
  });

  test("renders tables as pipe-delimited rows on separate lines", () => {
    const storage = "<table><tr><th>Name</th><th>Value</th></tr><tr><td>Alpha</td><td>1</td></tr></table>";

    assert.equal(storageToPlainText(storage), "| Name | Value |\n| Alpha | 1 |");
  });

  test("collapses excess blank lines and trims the result", () => {
    assert.equal(storageToPlainText("  <p>One</p><p></p><p>Two</p>  "), "One\n\nTwo");
  });

  // The regex converter paired `<ac:link>` with the first `<ri:page>` found
  // anywhere after it and deleted everything in between. Both constructs are
  // valid storage format and routinely co-occur: user mentions are links
  // without a page reference, and `children`/`excerpt-include`/`pagetree`
  // macros carry bare page references.
  test("keeps the text between a user mention and a later page reference", () => {
    const storage = [
      "<p>Intro paragraph.</p>",
      '<p>Reported by <ac:link><ri:user ri:userkey="0a1b2c"/></ac:link> on Monday.</p>',
      "<p>This paragraph must survive.</p>",
      '<ac:structured-macro ac:name="children">'
      + '<ac:parameter ac:name="page"><ri:page ri:content-title="Runbooks"/></ac:parameter>'
      + "</ac:structured-macro>",
      "<p>Closing paragraph.</p>",
    ].join("");

    const text = storageToPlainText(storage);

    assert.ok(text.includes("This paragraph must survive."), text);
    assert.ok(text.includes("on Monday."), text);
    assert.equal(
      text,
      "Intro paragraph.\n\nReported by  on Monday.\n\nThis paragraph must survive."
      + "\n\n[macro: children]\n\nClosing paragraph.",
    );
  });

  test("renders a page link that follows an unrelated mention in the same document", () => {
    const storage = '<p><ac:link><ri:user ri:userkey="0a1b2c"/></ac:link></p>'
      + '<p>See <ac:link><ri:page ri:content-title="Runbook"/></ac:link>.</p>';

    assert.equal(storageToPlainText(storage), "See [Runbook].");
  });

  test("reads code macro bodies out of CDATA instead of mangling them", () => {
    const storage = '<ac:structured-macro ac:name="code"><ac:plain-text-body>'
      + '<![CDATA[if (a > b) { return "<x>"; }]]>'
      + "</ac:plain-text-body></ac:structured-macro>";

    assert.equal(storageToPlainText(storage), '[macro: code]\nif (a > b) { return "<x>"; }');
  });

  // The regex converter was cubic in document length on exactly this shape
  // (~51 ms at 200 KiB, and far worse once mentions are interleaved), and it
  // blocked the whole single-threaded server while it ran.
  test("converts a 200 KiB document well inside a hard time budget", () => {
    const block = [
      "<p>Paragraph with enough words to be worth measuring at all.</p>",
      '<p>Mentioned <ac:link><ri:user ri:userkey="0a1b2c"/></ac:link> here.</p>',
      '<ac:structured-macro ac:name="excerpt-include">'
      + '<ac:parameter ac:name="page"><ri:page ri:content-title="Target Page"/></ac:parameter>'
      + "</ac:structured-macro>",
      "<table><tr><th>Key</th><th>Value</th></tr><tr><td>alpha</td><td>1</td></tr></table>",
    ].join("");
    let corpus = "";
    while (Buffer.byteLength(corpus, "utf8") < 200 * 1024) corpus += block;

    const startedAt = process.hrtime.bigint();
    const text = storageToPlainText(corpus);
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

    assert.ok(text.includes("[Target Page]") === false, "bare page references stay dropped");
    assert.ok(text.includes("| Key | Value |"), "tables still render");
    assert.ok(elapsedMs < 500, `conversion took ${elapsedMs.toFixed(1)} ms, expected under 500 ms`);
  });
});

describe("looksLikeStorageMarkup", () => {
  test("recognizes real storage markup", () => {
    assert.equal(looksLikeStorageMarkup("<p>Text</p>"), true);
    assert.equal(looksLikeStorageMarkup("<strong>Text</strong>"), true);
    assert.equal(looksLikeStorageMarkup('<ac:structured-macro ac:name="toc"/>'), true);
    assert.equal(looksLikeStorageMarkup("Text</p>"), true);
  });

  // Pattern B: the classifier was only ever shown inputs a few characters
  // long, so neither its cost nor its behaviour at page scale was known.
  test("classifies a 200 KiB page without scanning it quadratically", () => {
    const prose = `${"Ordinary prose with a < b and c > d. ".repeat(6000)}`;
    const markup = `<p>${"Body text. ".repeat(20000)}</p>`;
    const started = performance.now();

    assert.equal(looksLikeStorageMarkup(prose), false);
    assert.equal(looksLikeStorageMarkup(markup), true);

    const elapsedMs = performance.now() - started;
    assert.ok(elapsedMs < 500, `classification took ${elapsedMs.toFixed(1)} ms, expected under 500 ms`);
  });

  test("does not misclassify ordinary prose with angle brackets as storage markup", () => {
    assert.equal(looksLikeStorageMarkup("a < b and c > d"), false);
    assert.equal(looksLikeStorageMarkup("use <placeholder> here"), false);
  });
});

describe("Confluence attachment filesystem safety", () => {
  // The path-validation rules themselves live in attachmentSecurity.test.ts.
  // What follows checks that the client actually routes through them.
  test("rejects downloads through a directory symlink that escapes the allowlist", async () => {
    await withTemporaryDirectory(async (directory) => {
      const allowed = join(directory, "allowed");
      const outside = join(directory, "outside");
      await mkdir(allowed);
      await mkdir(outside);
      await symlink(outside, join(allowed, "escape"), "dir");

      const client = new ConfluenceClient({ baseUrl: "http://127.0.0.1:1", pat: "synthetic-token", attachmentDirs: [allowed] });
      await assert.rejects(client.downloadAttachment("10", "20", join(allowed, "escape", "capture.txt")), /outside the allowed directories/);
      await assert.rejects(stat(join(outside, "capture.txt")), { code: "ENOENT" });
    });
  });

  test("rejects declared oversized downloads without requesting the binary body", async () => {
    await withTemporaryDirectory(async (directory) => {
      const requests: string[] = [];
      await withStubServer((request, response) => {
        requests.push(request.url || "");
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          results: [{ id: "20", title: "fixture.txt", extensions: { fileSize: 9 }, _links: { download: "/download/20" } }],
        }));
      }, async (baseUrl) => {
        const client = new ConfluenceClient({ baseUrl, pat: "synthetic-token", attachmentDirs: [directory], maxAttachmentBytes: 4 });
        await assert.rejects(client.downloadAttachment("10", "20", join(directory, "file.txt")), /exceeding the 4-byte/);
        assert.equal(requests.length, 1);
        assert.match(requests[0], /^\/rest\/api\/content\/10\/child\/attachment\?/);
      });
    });
  });

  test("rejects binary bodies exceeding the configured attachment size", async () => {
    await withTemporaryDirectory(async (directory) => {
      const outputPath = join(directory, "file.txt");
      await withStubServer((request, response) => {
        if (request.url === "/download/20") {
          response.setHeader("content-type", "application/octet-stream");
          response.end("12345");
          return;
        }
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          results: [{ id: "20", title: "fixture.txt", extensions: { fileSize: 1 }, _links: { download: "/download/20" } }],
        }));
      }, async (baseUrl) => {
        const client = new ConfluenceClient({ baseUrl, pat: "synthetic-token", attachmentDirs: [directory], maxAttachmentBytes: 4 });
        await assert.rejects(
          client.downloadAttachment("10", "20", outputPath),
          /Attachment response size 5 bytes exceeds the maximum of 4 bytes \(over by 1 bytes\) configured by ATLASSIAN_MAX_ATTACHMENT_BYTES/,
        );
        await assert.rejects(stat(outputPath), { code: "ENOENT" });
      });
    });
  });

  test("revalidates a directory symlink introduced after the initial allowlist check", async () => {
    await withTemporaryDirectory(async (directory) => {
      const allowed = join(directory, "allowed");
      const outside = join(directory, "outside");
      const outputPath = join(allowed, "pivot", "capture.txt");
      await mkdir(allowed);
      await mkdir(outside);

      await withStubServer((request, response) => {
        if (request.url === "/download/20") {
          response.end("safe");
          return;
        }
        void symlink(outside, join(allowed, "pivot"), "dir").then(() => {
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify({
            results: [{ id: "20", title: "fixture.txt", extensions: { fileSize: 4 }, _links: { download: "/download/20" } }],
          }));
        });
      }, async (baseUrl) => {
        const client = new ConfluenceClient({ baseUrl, pat: "synthetic-token", attachmentDirs: [allowed] });
        await assert.rejects(client.downloadAttachment("10", "20", outputPath), /outside the allowed directories/);
        await assert.rejects(stat(join(outside, "capture.txt")), { code: "ENOENT" });
      });
    });
  });

  test("creates a new private attachment file within an allowed nested directory", async () => {
    await withTemporaryDirectory(async (directory) => {
      const outputPath = join(directory, "nested", "file.txt");
      await withStubServer((request, response) => {
        if (request.url === "/download/20") {
          response.setHeader("content-type", "text/plain");
          response.end("safe");
          return;
        }
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          results: [{ id: "20", title: "fixture.txt", extensions: { fileSize: 4 }, _links: { download: "/download/20" } }],
        }));
      }, async (baseUrl) => {
        const client = new ConfluenceClient({ baseUrl, pat: "synthetic-token", attachmentDirs: [directory], maxAttachmentBytes: 4 });
        const result = await client.downloadAttachment("10", "20", outputPath);
        assert.equal(result.bytesWritten, 4);
        assert.equal(await readFile(outputPath, "utf8"), "safe");
        assert.equal((await stat(outputPath)).mode & 0o777, 0o600);
      });
    });
  });
});

function spaceFixtures(count: number, offset = 0): unknown[] {
  return Array.from({ length: count }, (_unused, index) => ({
    key: `SP${offset + index}`,
    name: `Space ${offset + index}`,
    type: "global",
    _links: { webui: `/display/SP${offset + index}` },
  }));
}

function childFixtures(count: number, offset = 0): unknown[] {
  return Array.from({ length: count }, (_unused, index) => ({
    id: String(1000 + offset + index),
    title: `Child ${offset + index}`,
    space: { key: "SP" },
    _links: { webui: `/pages/${1000 + offset + index}` },
  }));
}

function jsonServer(body: (request: IncomingMessage) => unknown) {
  return (request: IncomingMessage, response: ServerResponse) => {
    response.setHeader("content-type", "application/json");
    const payload = body(request);
    response.end(payload === undefined ? "" : JSON.stringify(payload));
  };
}

describe("Confluence pagination", () => {
  // A caching proxy, or a Data Center cluster without sticky sessions, can
  // serve the same offset forever. The old loop happily returned the same 100
  // records three times as if they were 300.
  test("rejects a server that ignores start and replays the same page", async () => {
    let requests = 0;
    await withStubServer(jsonServer(() => {
      requests += 1;
      return { results: spaceFixtures(100), _links: { next: "/rest/api/space?start=100" } };
    }), async (baseUrl) => {
      const client = new ConfluenceClient({ baseUrl, pat: "synthetic-token" });
      await assert.rejects(client.listSpaces(500), /repeated page/);
      assert.equal(requests, 2);
    });
  });

  // The page budget is the only thing standing between a well-behaved-looking
  // upstream and an unbounded walk. Without a test that makes the cap the
  // stopping condition, the whole guard can be deleted and the suite stays
  // green -- which is exactly how the unbounded loops in this repo survived.
  test("stops at the configured page budget instead of walking forever", async () => {
    let requests = 0;
    await withStubServer(jsonServer(() => {
      const offset = requests * 100;
      requests += 1;
      // Every page is well formed and genuinely advances, so none of the other
      // guards (repeated page, stalled start, short page) can fire. Only the
      // budget can stop this.
      return { start: offset, size: 100, results: spaceFixtures(100, offset), _links: { next: "/next" } };
    }), async (baseUrl) => {
      const client = new ConfluenceClient({ baseUrl, pat: "synthetic-token", maxPaginationPages: 2 });
      await assert.rejects(
        client.listSpaces(500),
        /pagination stopped after the configured limit of 2 pages.*partial results were not returned/s,
      );
      assert.equal(requests, 2, "must not fetch beyond the budget");
    });
  });

  test("applies the shipped default page budget when none is configured", async () => {
    let requests = 0;
    await withStubServer(jsonServer(() => {
      const offset = requests * 100;
      requests += 1;
      return { start: offset, size: 100, results: childFixtures(100, offset), _links: { next: "/next" } };
    }), async (baseUrl) => {
      const client = new ConfluenceClient({ baseUrl, pat: "synthetic-token" });
      // limit 5000 would need 50 pages; the default budget of 10 must cut it off.
      await assert.rejects(client.getPageChildren("10", 5000), /configured limit of 10 pages/);
      assert.equal(requests, 10, "default budget must be 10 pages, not unbounded");
    });
  });

  test("rejects a server whose reported start does not advance", async () => {
    let requests = 0;
    await withStubServer(jsonServer(() => {
      const offset = requests * 100;
      requests += 1;
      return { start: 0, size: 100, results: childFixtures(100, offset), _links: { next: "/next" } };
    }), async (baseUrl) => {
      const client = new ConfluenceClient({ baseUrl, pat: "synthetic-token" });
      await assert.rejects(client.getPageChildren("10", 500), /did not advance/);
      assert.equal(requests, 2);
    });
  });

  test("reports truncation when the server knows of more results than were returned", async () => {
    await withStubServer(jsonServer(() => ({
      start: 0,
      size: 3,
      totalSize: 10,
      results: spaceFixtures(3),
    })), async (baseUrl) => {
      const client = new ConfluenceClient({ baseUrl, pat: "synthetic-token" });
      const result = await client.listSpaces(3);

      assert.equal(result.returned, 3);
      assert.equal(result.spaces.length, 3);
      assert.equal(result.total, 10);
      assert.equal(result.hasMore, true);
      assert.equal(result.nextStart, 3);
    });
  });

  test("reports truncation from a next link when no total is available", async () => {
    await withStubServer(jsonServer(() => ({
      start: 0,
      size: 2,
      results: childFixtures(2),
      _links: { next: "/rest/api/content/10/child/page?start=2" },
    })), async (baseUrl) => {
      const client = new ConfluenceClient({ baseUrl, pat: "synthetic-token" });
      const result = await client.getPageChildren("10", 2);

      assert.equal(result.children.length, 2);
      assert.equal(result.hasMore, true);
      assert.equal(result.nextStart, 2);
    });
  });

  test("walks every page and reports completion when the collection ends", async () => {
    const starts: string[] = [];
    await withStubServer(jsonServer((request) => {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      const start = Number(url.searchParams.get("start"));
      starts.push(url.searchParams.get("start") || "");
      return start === 0
        ? { start: 0, size: 100, results: spaceFixtures(100), _links: { next: "/rest/api/space?start=100" } }
        : { start: 100, size: 30, results: spaceFixtures(30, 100) };
    }), async (baseUrl) => {
      const client = new ConfluenceClient({ baseUrl, pat: "synthetic-token" });
      const result = await client.listSpaces(150);

      assert.deepEqual(starts, ["0", "100"]);
      assert.equal(result.spaces.length, 130);
      assert.equal(result.returned, 130);
      assert.equal(result.total, 130);
      assert.equal(result.hasMore, false);
      assert.equal(result.nextStart, null);
      assert.equal(result.spaces[129].key, "SP129");
    });
  });

  test("maps comments and reports truncation on the comment endpoint", async () => {
    await withStubServer(jsonServer(() => ({
      start: 0,
      size: 1,
      results: [{
        id: "5001",
        title: "Re: Page",
        body: { storage: { value: "<p>Body</p>" } },
        version: { number: 2 },
        history: { createdBy: { displayName: "Ada" } },
        _links: { webui: "/pages/5001" },
      }],
      _links: { next: "/rest/api/content/10/child/comment?start=1" },
    })), async (baseUrl) => {
      const client = new ConfluenceClient({ baseUrl, pat: "synthetic-token" });
      const result = await client.listComments("10", 1);

      assert.equal(result.comments.length, 1);
      assert.equal(result.comments[0].id, "5001");
      assert.equal(result.hasMore, true);
      assert.equal(result.nextStart, 1);
    });
  });

  test("treats a response without results as an empty, complete collection", async () => {
    await withStubServer(jsonServer(() => ({})), async (baseUrl) => {
      const client = new ConfluenceClient({ baseUrl, pat: "synthetic-token" });
      const result = await client.listSpaces(50);

      assert.deepEqual(result.spaces, []);
      assert.equal(result.returned, 0);
      assert.equal(result.total, 0);
      assert.equal(result.hasMore, false);
      assert.equal(result.nextStart, null);
    });
  });

  test("treats an empty response body as an empty, complete collection", async () => {
    await withStubServer(jsonServer(() => undefined), async (baseUrl) => {
      const client = new ConfluenceClient({ baseUrl, pat: "synthetic-token" });
      const result = await client.listSpaces(50);

      assert.deepEqual(result.spaces, []);
      assert.equal(result.hasMore, false);
    });
  });

  /**
   * One table instead of three near-identical tests: the shape goes in, the
   * domain error that must name it comes out. Adding a new hostile shape is a
   * one-line change, which is the point - the old layout made each new case
   * feel like new work, so none were written.
   */
  const malformedCollections: Array<{ name: string; body: unknown; call: (client: ConfluenceClient) => Promise<unknown>; expected: RegExp }> = [
    { name: "a results field that is not an array", body: { results: null }, call: (client) => client.listSpaces(50), expected: /invalid results page/ },
    { name: "a results field holding a string", body: { results: "invalid" }, call: (client) => client.listSpaces(50), expected: /invalid results page/ },
    { name: "an empty page returned before the reported total is reached", body: { results: [], total: 5 }, call: (client) => client.listComments("10", 50), expected: /empty page/ },
    { name: "a negative total", body: { results: spaceFixtures(1), totalSize: -3 }, call: (client) => client.listSpaces(50), expected: /invalid total/ },
    { name: "a non-numeric total", body: { results: spaceFixtures(1), totalSize: "many" }, call: (client) => client.listSpaces(50), expected: /invalid total/ },
  ];

  for (const scenario of malformedCollections) {
    test(`rejects ${scenario.name}`, async () => {
      await withStubServer(jsonServer(() => scenario.body), async (baseUrl) => {
        const client = new ConfluenceClient({ baseUrl, pat: "synthetic-token" });
        await assert.rejects(scenario.call(client), domainError(scenario.expected));
      });
    });
  }
});

/**
 * Pattern A from the audit: outside jiraAgileClient.test.ts every stub in this
 * directory answered with a well-formed body, so no Confluence entry point was
 * ever pointed at a server behaving like a real one. The table below drives
 * every read endpoint against every shape an on-prem deployment actually
 * produces. The invariant is deliberately shape-independent: whatever the
 * client decides to do, it may never surface a raw TypeError, and any error it
 * raises has to name the field or the resource at fault.
 */
describe("Confluence reads survive a hostile upstream", () => {
  const endpoints: Array<{ name: string; call: (client: ConfluenceClient) => Promise<unknown> }> = [
    { name: "listSpaces", call: (client) => client.listSpaces(50) },
    { name: "searchPages", call: (client) => client.searchPages("type = page", 20) },
    { name: "getPage", call: (client) => client.getPage("10") },
    { name: "getPageByTitle", call: (client) => client.getPageByTitle("SP", "Runbook") },
    { name: "getPageChildren", call: (client) => client.getPageChildren("10", 50) },
    { name: "listAttachments", call: (client) => client.listAttachments("10") },
    { name: "listComments", call: (client) => client.listComments("10", 50) },
    { name: "getPageHistory", call: (client) => client.getPageHistory("10", 50) },
  ];

  /**
   * Every combination is a hard pass. searchPages, getPage, listAttachments
   * and getPageHistory used to be marked TODO here for the shapes that made
   * them index into an absent body or map over a non-array `results`; they
   * now go through the shared envelope and list guards, so the markers are
   * gone and a regression fails the suite instead of being reported as a
   * known gap.
   */
  for (const endpoint of endpoints) {
    for (const testCase of UPSTREAM_GARBAGE_CASES) {
      test(`${endpoint.name} answers ${testCase.name} with a domain error, never a TypeError`, { timeout: 10_000 }, async () => {
        await withStubServer(constantHandler(testCase.response), async (baseUrl) => {
          const client = new ConfluenceClient({ baseUrl, pat: "synthetic-token" });
          await assertGarbageHandled(testCase, () => endpoint.call(client));
        });
      });
    }
  }

  /**
   * The classic on-prem failure: an expired PAT behind SSO/WebSEAL never
   * reaches Jira or Confluence at all - the reverse proxy answers HTTP 200
   * with its own login form. The operator must be able to recognise that from
   * the error text alone, so the body snippet has to survive into the message.
   */
  test("an SSO login page served with HTTP 200 keeps enough of the body to be recognisable", async () => {
    await withStubServer(
      constantHandler({ status: 200, headers: { "content-type": "text/html" }, body: "<html><body><form action=\"/login\"><input name=\"os_username\"></form></body></html>" }),
      async (baseUrl) => {
        const client = new ConfluenceClient({ baseUrl, pat: "expired-token" });
        await assert.rejects(client.listSpaces(50), domainError(/Failed to parse JSON response/, /os_username/));
      },
    );
  });
});

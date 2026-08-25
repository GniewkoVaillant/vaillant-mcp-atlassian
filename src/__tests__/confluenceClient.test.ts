import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfluenceClient, looksLikeStorageMarkup, storageToPlainText } from "../confluenceClient.js";

async function withTemporaryDirectory(action: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "confluence-mcp-attachment-test-"));
  try {
    await action(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function withStubServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  action: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Stub server did not receive a TCP address.");
  }
  try {
    await action(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

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
});

describe("looksLikeStorageMarkup", () => {
  test("recognizes real storage markup", () => {
    assert.equal(looksLikeStorageMarkup("<p>Text</p>"), true);
    assert.equal(looksLikeStorageMarkup("<strong>Text</strong>"), true);
    assert.equal(looksLikeStorageMarkup('<ac:structured-macro ac:name="toc"/>'), true);
    assert.equal(looksLikeStorageMarkup("Text</p>"), true);
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
        await assert.rejects(client.downloadAttachment("10", "20", outputPath), /exceed|limit|maximum/i);
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

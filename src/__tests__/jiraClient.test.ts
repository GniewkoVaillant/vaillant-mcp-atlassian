import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeCycleTime, JiraClient, type JiraStatusTransition } from "../jiraClient.js";

async function withTemporaryDirectory(action: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "jira-mcp-attachment-test-"));
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

function transition(to: string, at: string, from = "Backlog"): JiraStatusTransition {
  return { from, to, at, author: "Tester" };
}

describe("computeCycleTime", () => {
  test("computes a simple forward cycle time rounded to one decimal day", () => {
    const result = computeCycleTime(
      "ABC-1",
      [transition("In Progress", "2024-01-01T00:00:00.000Z"), transition("Done", "2024-01-03T12:00:00.000Z", "In Progress")],
      "In Progress",
      "Done",
    );

    assert.equal(result.cycleTimeDays, 2.5);
    assert.equal(result.fromStatusEnteredAt, "2024-01-01T00:00:00.000Z");
    assert.equal(result.toStatusEnteredAt, "2024-01-03T12:00:00.000Z");
  });

  test("matches statuses case-insensitively", () => {
    const result = computeCycleTime(
      "ABC-2",
      [transition("in progress", "2024-01-01T00:00:00.000Z"), transition("DONE", "2024-01-02T00:00:00.000Z", "in progress")],
      "In Progress",
      "Done",
    );

    assert.equal(result.cycleTimeDays, 1);
  });

  test("uses the first entry into the start status and last entry into the done status after reopen", () => {
    const result = computeCycleTime(
      "ABC-3",
      [
        transition("In Progress", "2024-01-01T00:00:00.000Z"),
        transition("Done", "2024-01-02T00:00:00.000Z", "In Progress"),
        transition("In Progress", "2024-01-05T00:00:00.000Z", "Done"),
        transition("Done", "2024-01-07T12:00:00.000Z", "In Progress"),
      ],
      "In Progress",
      "Done",
    );

    assert.equal(result.fromStatusEnteredAt, "2024-01-01T00:00:00.000Z");
    assert.equal(result.toStatusEnteredAt, "2024-01-07T12:00:00.000Z");
    assert.equal(result.cycleTimeDays, 6.5);
  });

  test("returns null cycle time with a note when the start status was never entered", () => {
    const result = computeCycleTime("ABC-4", [transition("Done", "2024-01-02T00:00:00.000Z")], "In Progress", "Done");

    assert.equal(result.cycleTimeDays, null);
    assert.equal(result.note, 'Issue never transitioned to "In Progress".');
    assert.equal(result.fromStatusEnteredAt, null);
    assert.equal(result.toStatusEnteredAt, "2024-01-02T00:00:00.000Z");
  });

  test("returns null cycle time with a note when the target status was never entered", () => {
    const result = computeCycleTime("ABC-5", [transition("In Progress", "2024-01-01T00:00:00.000Z")], "In Progress", "Done");

    assert.equal(result.cycleTimeDays, null);
    assert.equal(result.note, 'Issue never transitioned to "Done".');
    assert.equal(result.fromStatusEnteredAt, "2024-01-01T00:00:00.000Z");
    assert.equal(result.toStatusEnteredAt, null);
  });
});

describe("Jira attachment filesystem safety", () => {
  // The path-validation rules themselves live in attachmentSecurity.test.ts.
  // What follows checks that the client actually routes through them.
  test("rejects uploads whose allowed-directory symlink resolves outside the allowlist", async () => {
    await withTemporaryDirectory(async (directory) => {
      const allowed = join(directory, "allowed");
      const outside = join(directory, "outside");
      await mkdir(allowed);
      await mkdir(outside);
      await writeFile(join(outside, "synthetic.txt"), "synthetic fixture");
      await symlink(join(outside, "synthetic.txt"), join(allowed, "escape.txt"));

      const client = new JiraClient({ baseUrl: "http://127.0.0.1:1", pat: "synthetic-token", attachmentDirs: [allowed] });
      await assert.rejects(client.uploadAttachment("TEST-1", join(allowed, "escape.txt")), /outside the allowed directories/);
    });
  });

  test("rejects downloads through a directory symlink that escapes the allowlist", async () => {
    await withTemporaryDirectory(async (directory) => {
      const allowed = join(directory, "allowed");
      const outside = join(directory, "outside");
      await mkdir(allowed);
      await mkdir(outside);
      await symlink(outside, join(allowed, "escape"), "dir");

      const client = new JiraClient({ baseUrl: "http://127.0.0.1:1", pat: "synthetic-token", attachmentDirs: [allowed] });
      await assert.rejects(client.downloadAttachment("1", join(allowed, "escape", "capture.txt")), /outside the allowed directories/);
      await assert.rejects(stat(join(outside, "capture.txt")), { code: "ENOENT" });
    });
  });

  test("rejects oversized local uploads before making an HTTP request", async () => {
    await withTemporaryDirectory(async (directory) => {
      const file = join(directory, "oversized.txt");
      await writeFile(file, "12345");

      const client = new JiraClient({
        baseUrl: "http://127.0.0.1:1",
        pat: "synthetic-token",
        attachmentDirs: [directory],
        maxAttachmentBytes: 4,
      });
      await assert.rejects(client.uploadAttachment("TEST-1", file), /exceeding the 4-byte/);
    });
  });

  test("rejects declared oversized downloads without requesting the binary body", async () => {
    await withTemporaryDirectory(async (directory) => {
      const requests: string[] = [];
      await withStubServer((request, response) => {
        requests.push(request.url || "");
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ content: "/download/1", size: 9 }));
      }, async (baseUrl) => {
        const client = new JiraClient({ baseUrl, pat: "synthetic-token", attachmentDirs: [directory], maxAttachmentBytes: 4 });
        await assert.rejects(client.downloadAttachment("1", join(directory, "file.txt")), /exceeding the 4-byte/);
        assert.deepEqual(requests, ["/rest/api/2/attachment/1"]);
      });
    });
  });

  test("rejects binary bodies exceeding the configured attachment size", async () => {
    await withTemporaryDirectory(async (directory) => {
      const outputPath = join(directory, "file.txt");
      await withStubServer((request, response) => {
        if (request.url === "/download/1") {
          response.setHeader("content-type", "application/octet-stream");
          response.end("12345");
          return;
        }
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ content: "/download/1", size: 1 }));
      }, async (baseUrl) => {
        const client = new JiraClient({ baseUrl, pat: "synthetic-token", attachmentDirs: [directory], maxAttachmentBytes: 4 });
        await assert.rejects(client.downloadAttachment("1", outputPath), /exceed|limit|maximum/i);
        await assert.rejects(stat(outputPath), { code: "ENOENT" });
      });
    });
  });

  test("preserves a destination created after the initial allowlist check", async () => {
    await withTemporaryDirectory(async (directory) => {
      const outputPath = join(directory, "race.txt");
      await withStubServer((request, response) => {
        if (request.url === "/download/1") {
          response.end("safe");
          return;
        }
        void writeFile(outputPath, "concurrent fixture").then(() => {
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify({ content: "/download/1", size: 4 }));
        });
      }, async (baseUrl) => {
        const client = new JiraClient({ baseUrl, pat: "synthetic-token", attachmentDirs: [directory] });
        await assert.rejects(client.downloadAttachment("1", outputPath), /already exists; refusing to overwrite/);
        assert.equal(await readFile(outputPath, "utf8"), "concurrent fixture");
      });
    });
  });

  test("creates a new private attachment file within an allowed nested directory", async () => {
    await withTemporaryDirectory(async (directory) => {
      const outputPath = join(directory, "nested", "file.txt");
      await withStubServer((request, response) => {
        if (request.url === "/download/1") {
          response.setHeader("content-type", "text/plain");
          response.end("safe");
          return;
        }
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ content: "/download/1", size: 4 }));
      }, async (baseUrl) => {
        const client = new JiraClient({ baseUrl, pat: "synthetic-token", attachmentDirs: [directory], maxAttachmentBytes: 4 });
        const result = await client.downloadAttachment("1", outputPath);
        assert.equal(result.bytesWritten, 4);
        assert.equal(await readFile(outputPath, "utf8"), "safe");
        assert.equal((await stat(outputPath)).mode & 0o777, 0o600);
      });
    });
  });
});

describe("ProForma request budgets", () => {
  test("rejects excessive declared chunk counts before requesting additional chunks", async () => {
    const requests: string[] = [];
    await withStubServer((request, response) => {
      requests.push(request.url || "");
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(request.url?.endsWith("proforma.forms")
        ? { value: { forms: [{ id: 7, name: "Synthetic form" }] } }
        : { value: { rawData: { part: "1/26", data: "" } } }));
    }, async (baseUrl) => {
      const client = new JiraClient({ baseUrl, pat: "synthetic-token" });
      await assert.rejects(client.getProformaForm("TEST-1", 7), /exceeding the 25-chunk safety limit/);
      assert.equal(requests.length, 2);
    });
  });

  test("limits concurrent ProForma chunk requests to the existing batch cap", async () => {
    const total = 9;
    const encoded = Buffer.from(JSON.stringify({ questions: {} }), "utf8").toString("base64");
    const chunkSize = Math.ceil(encoded.length / total);
    const chunks = Array.from({ length: total }, (_, index) => ({
      part: `${index + 1}/${total}`,
      data: encoded.slice(index * chunkSize, (index + 1) * chunkSize),
    }));
    let active = 0;
    let peak = 0;

    await withStubServer((request, response) => {
      response.setHeader("content-type", "application/json");
      const property = decodeURIComponent((request.url || "").split("/").pop() || "");
      if (property === "proforma.forms") {
        response.end(JSON.stringify({ value: { forms: [{ id: 7, name: "Synthetic form" }] } }));
        return;
      }
      if (property === "proforma.forms.i7") {
        response.end(JSON.stringify({ value: { rawData: chunks[0], state: { answers: {} } } }));
        return;
      }
      const index = Number(property.split(".").pop());
      active += 1;
      peak = Math.max(peak, active);
      setTimeout(() => {
        active -= 1;
        response.end(JSON.stringify({ value: chunks[index] }));
      }, 15);
    }, async (baseUrl) => {
      const client = new JiraClient({ baseUrl, pat: "synthetic-token" });
      const result = await client.getProformaForm("TEST-1", 7);
      assert.equal(result.id, 7);
      assert.ok(peak <= 5, `expected at most 5 concurrent chunk requests, observed ${peak}`);
      assert.ok(peak >= 2, "expected chunk retrieval to remain concurrent");
    });
  });
});

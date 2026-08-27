import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { computeCycleTime, JiraClient, type JiraStatusTransition } from "../jiraClient.js";
import { DEFAULT_MAX_JSON_BYTES, configureHttp } from "../httpClient.js";
import { formatProformaAnswer } from "../proforma.js";
import {
  UPSTREAM_GARBAGE_CASES,
  assertGarbageHandled,
  constantHandler,
  domainError,
  sendResponse,
  withStubServer,
  withTemporaryDirectory as withTemporaryDirectoryIn,
  type ScriptedResponse,
} from "./testServer.js";

const withTemporaryDirectory = (action: (directory: string) => Promise<void>): Promise<void> =>
  withTemporaryDirectoryIn(action, "jira-mcp-attachment-test-");

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
        await assert.rejects(
          client.downloadAttachment("1", outputPath),
          /Attachment response size 5 bytes exceeds the maximum of 4 bytes \(over by 1 bytes\) configured by ATLASSIAN_MAX_ATTACHMENT_BYTES/,
        );
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

/**
 * Every other stub in this file answers with a well-formed payload, which is
 * exactly why the guard-less property access in the client went unnoticed. The
 * suites below feed the shapes a real Data Center instance produces when a
 * property was cleared, a reverse proxy swallowed the body, or an endpoint
 * answered with an error envelope: the requirement is a domain error naming the
 * issue, property or form - never a bare TypeError.
 */
const EMPTY_BODY = " empty-200-body";

function propertyStub(
  bodies: Record<string, unknown>,
  seen?: string[],
): (request: IncomingMessage, response: ServerResponse) => void {
  return (request, response) => {
    const property = decodeURIComponent((request.url || "").split("/").pop() || "");
    seen?.push(property);
    response.setHeader("content-type", "application/json");
    if (!Object.prototype.hasOwnProperty.call(bodies, property)) {
      response.statusCode = 404;
      response.end(JSON.stringify({ errorMessages: ["Property not found"] }));
      return;
    }
    const body = bodies[property];
    response.end(body === EMPTY_BODY ? "" : JSON.stringify(body));
  };
}

describe("malformed ProForma responses", () => {
  test("listProformaForms names the cleared property instead of throwing a TypeError", async () => {
    await withStubServer(propertyStub({ "proforma.forms": { value: null } }), async (baseUrl) => {
      const client = new JiraClient({ baseUrl, pat: "synthetic-token" });
      await assert.rejects(
        client.listProformaForms("TEST-1"),
        domainError(/proforma\.forms/, /TEST-1/, /cleared/),
      );
    });
  });

  test("listProformaForms treats an index without a forms list as empty", async () => {
    await withStubServer(propertyStub({ "proforma.forms": { value: {} } }), async (baseUrl) => {
      const client = new JiraClient({ baseUrl, pat: "synthetic-token" });
      assert.deepEqual(await client.listProformaForms("TEST-1"), []);
    });
  });

  test("listProformaForms rejects a non-array forms member", async () => {
    await withStubServer(propertyStub({ "proforma.forms": { value: { forms: {} } } }), async (baseUrl) => {
      const client = new JiraClient({ baseUrl, pat: "synthetic-token" });
      await assert.rejects(
        client.listProformaForms("TEST-1"),
        domainError(/ProForma form index on issue TEST-1/, /expected an array/),
      );
    });
  });

  test("getIssueProperty names the property when the body is an empty 200", async () => {
    await withStubServer(propertyStub({ "proforma.forms": EMPTY_BODY }), async (baseUrl) => {
      const client = new JiraClient({ baseUrl, pat: "synthetic-token" });
      await assert.rejects(
        client.getIssueProperty("TEST-1", "proforma.forms"),
        domainError(/issue property "proforma\.forms" on TEST-1/, /no value/),
      );
    });
  });

  test("getIssueProperty names the property when the envelope carries no value", async () => {
    await withStubServer(propertyStub({ "proforma.forms": { results: null } }), async (baseUrl) => {
      const client = new JiraClient({ baseUrl, pat: "synthetic-token" });
      await assert.rejects(
        client.getIssueProperty("TEST-1", "proforma.forms"),
        domainError(/issue property "proforma\.forms" on TEST-1/, /no "value" field/),
      );
    });
  });

  test("getProformaForm names issue, form and property when the form data is null", async () => {
    await withStubServer(propertyStub({
      "proforma.forms": { value: { forms: [{ id: 7, name: "Change request" }] } },
      "proforma.forms.i7": { value: null },
    }), async (baseUrl) => {
      const client = new JiraClient({ baseUrl, pat: "synthetic-token" });
      await assert.rejects(
        client.getProformaForm("TEST-1", 7),
        domainError(/ProForma form 7 \("Change request"\)/, /issue TEST-1/, /proforma\.forms\.i7/, /null/),
      );
    });
  });

  test("getProformaForm rejects an answers container that is not an object", async () => {
    await withStubServer(propertyStub({
      "proforma.forms": { value: { forms: [{ id: 7, name: "Change request" }] } },
      "proforma.forms.i7": { value: { state: { answers: "broken" } } },
    }), async (baseUrl) => {
      const client = new JiraClient({ baseUrl, pat: "synthetic-token" });
      await assert.rejects(
        client.getProformaForm("TEST-1", 7),
        domainError(/ProForma form 7 \("Change request"\)/, /issue TEST-1/, /invalid/, /answers/),
      );
    });
  });

  test("getProformaForm keeps reading a form whose deleted field stored a null answer", async () => {
    const bodies = {
      "proforma.forms": { value: { forms: [{ id: 7, name: "Change request" }] } },
      "proforma.forms.i7": {
        value: {
          design: { questions: { q1: { label: "Impact", type: "ts" }, q2: { label: "Owner", type: "ts" } } },
          state: { status: "o", answers: { q1: null, q2: { text: "Team A" } } },
        },
      },
    };
    await withStubServer(propertyStub(bodies), async (baseUrl) => {
      const client = new JiraClient({ baseUrl, pat: "synthetic-token" });
      const form = await client.getProformaForm("TEST-1", 7);
      assert.equal(form.status, "open");
      assert.deepEqual(form.answers.map((answer) => answer.answer), ["Team A"]);
      assert.equal(form.answeredQuestions, 1);
      assert.equal(form.totalQuestions, 2);

      const withEmpty = await client.getProformaForm("TEST-1", 7, true);
      assert.deepEqual(withEmpty.answers.map((answer) => answer.answer), ["", "Team A"]);
      assert.equal(withEmpty.answers[0].label, "Impact");
    });
  });

  test("getProformaFormsSummary reads the form index once instead of once per form", async () => {
    const seen: string[] = [];
    const forms = [1, 2, 3].map((id) => ({ id, name: `Form ${id}` }));
    const bodies: Record<string, unknown> = { "proforma.forms": { value: { forms } } };
    for (const form of forms) {
      bodies[`proforma.forms.i${form.id}`] = {
        value: { design: { questions: { q1: { label: "Q" } } }, state: { status: "s", answers: { q1: { text: "yes" } } } },
      };
    }

    await withStubServer(propertyStub(bodies, seen), async (baseUrl) => {
      const client = new JiraClient({ baseUrl, pat: "synthetic-token" });
      const summaries = await client.getProformaFormsSummary("TEST-1");

      assert.equal(summaries.length, 3);
      assert.deepEqual(summaries.map((form) => form.id), [1, 2, 3]);
      assert.equal(
        seen.filter((property) => property === "proforma.forms").length,
        1,
        `expected exactly one form-index request, observed ${seen.filter((p) => p === "proforma.forms").length}`,
      );
      assert.equal(seen.length, 4, `expected 1 index + 3 form requests, observed ${seen.join(", ")}`);
    });
  });
});

/**
 * `design.questions[id].jiraField` maps a form question to a persisted Jira
 * custom field. `getProformaForm` resolves that field only for questions the
 * form state does not meaningfully answer, merging the result in without
 * touching anything the form state already answers (REQ-004..REQ-009).
 */
function formAndFieldStub(options: {
  properties: Record<string, unknown>;
  fieldCatalogue?: Array<{ id: string; name: string; custom?: boolean }>;
  issueFields?: Record<string, unknown>;
  issueRequestUrls?: string[];
  issueResponse?: ScriptedResponse;
}): (request: IncomingMessage, response: ServerResponse) => void {
  return (request, response) => {
    const url = request.url || "";
    if (url.startsWith("/rest/api/2/field")) {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(options.fieldCatalogue ?? []));
      return;
    }
    if (url.includes("/properties/")) {
      const property = decodeURIComponent(url.split("/properties/")[1] || "");
      response.setHeader("content-type", "application/json");
      if (!Object.prototype.hasOwnProperty.call(options.properties, property)) {
        response.statusCode = 404;
        response.end(JSON.stringify({ errorMessages: ["Property not found"] }));
        return;
      }
      response.end(JSON.stringify(options.properties[property]));
      return;
    }
    if (url.startsWith("/rest/api/2/issue/")) {
      options.issueRequestUrls?.push(url);
      if (options.issueResponse) {
        sendResponse(response, options.issueResponse);
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ key: "TEST-1", fields: options.issueFields ?? {} }));
      return;
    }
    response.statusCode = 404;
    response.end("{}");
  };
}

describe("ProForma jira-field fallback", () => {
  test("resolves a persisted Jira value for a question absent from form state", async () => {
    const properties = {
      "proforma.forms": { value: { forms: [{ id: 7, name: "Scope form" }] } },
      "proforma.forms.i7": {
        value: {
          design: { questions: { q1: { label: "Job size", type: "ts", jiraField: "customfield_100" } } },
          state: { status: "o", answers: {} },
        },
      },
    };
    await withStubServer(formAndFieldStub({
      properties,
      fieldCatalogue: [{ id: "customfield_100", name: "Job size", custom: true }],
      issueFields: { customfield_100: "Large project" },
    }), async (baseUrl) => {
      const client = new JiraClient({ baseUrl, pat: "synthetic-token" });
      const form = await client.getProformaForm("TEST-1", 7);
      assert.deepEqual(form.answers, [{
        questionId: "q1",
        label: "Job size",
        type: "ts",
        answer: "Large project",
        rawAnswer: "Large project",
        source: "jira-field",
      }]);
      assert.equal(form.answeredQuestions, 1);
      assert.equal(form.totalQuestions, 1);
    });
  });

  test("a meaningful form-state answer wins over a linked Jira field, without fetching it", async () => {
    const properties = {
      "proforma.forms": { value: { forms: [{ id: 7, name: "Scope form" }] } },
      "proforma.forms.i7": {
        value: {
          design: { questions: { q1: { label: "Owner", type: "ts", jiraField: "customfield_200" } } },
          state: { status: "s", answers: { q1: { text: "Alice" } } },
        },
      },
    };
    const issueRequestUrls: string[] = [];
    await withStubServer(formAndFieldStub({
      properties,
      fieldCatalogue: [{ id: "customfield_200", name: "Owner", custom: true }],
      issueFields: { customfield_200: "Bob" },
      issueRequestUrls,
    }), async (baseUrl) => {
      const client = new JiraClient({ baseUrl, pat: "synthetic-token" });
      const form = await client.getProformaForm("TEST-1", 7);
      assert.deepEqual(form.answers, [{
        questionId: "q1",
        label: "Owner",
        type: "ts",
        answer: "Alice",
        rawAnswer: { text: "Alice" },
        source: "form-state",
      }]);
      assert.equal(issueRequestUrls.length, 0, "a meaningfully answered question must never trigger a field lookup");
    });
  });

  test("deduplicates a Jira field shared by more than one mapped question into one request", async () => {
    const properties = {
      "proforma.forms": { value: { forms: [{ id: 7, name: "Shared field form" }] } },
      "proforma.forms.i7": {
        value: {
          design: {
            questions: {
              q1: { label: "Q1", type: "ts", jiraField: "customfield_300" },
              q2: { label: "Q2", type: "ts", jiraField: "customfield_300" },
            },
          },
          state: { status: "o", answers: {} },
        },
      },
    };
    const issueRequestUrls: string[] = [];
    await withStubServer(formAndFieldStub({
      properties,
      fieldCatalogue: [{ id: "customfield_300", name: "Shared", custom: true }],
      issueFields: { customfield_300: "Shared value" },
      issueRequestUrls,
    }), async (baseUrl) => {
      const client = new JiraClient({ baseUrl, pat: "synthetic-token" });
      const form = await client.getProformaForm("TEST-1", 7);
      assert.deepEqual(form.answers.map((answer) => [answer.questionId, answer.answer, answer.source]), [
        ["q1", "Shared value", "jira-field"],
        ["q2", "Shared value", "jira-field"],
      ]);
      assert.equal(issueRequestUrls.length, 1, `expected one deduplicated field request, observed ${issueRequestUrls.length}`);
    });
  });

  test("includeEmpty applies after merging, once neither source has a value", async () => {
    const properties = {
      "proforma.forms": { value: { forms: [{ id: 7, name: "Empty field form" }] } },
      "proforma.forms.i7": {
        value: {
          design: { questions: { q1: { label: "Empty field", type: "ts", jiraField: "customfield_400" } } },
          state: { status: "o", answers: {} },
        },
      },
    };
    await withStubServer(formAndFieldStub({
      properties,
      fieldCatalogue: [{ id: "customfield_400", name: "Empty field", custom: true }],
      issueFields: { customfield_400: null },
    }), async (baseUrl) => {
      const client = new JiraClient({ baseUrl, pat: "synthetic-token" });
      const withoutEmpty = await client.getProformaForm("TEST-1", 7);
      assert.deepEqual(withoutEmpty.answers, []);

      const withEmpty = await client.getProformaForm("TEST-1", 7, true);
      assert.equal(withEmpty.answers.length, 1);
      assert.equal(withEmpty.answers[0].questionId, "q1");
      assert.equal(withEmpty.answers[0].answer, "");
    });
  });

  test("open forms always carry the unsaved-browser-edit warning", async () => {
    const properties = {
      "proforma.forms": { value: { forms: [{ id: 7, name: "Open form" }] } },
      "proforma.forms.i7": {
        value: { design: { questions: {} }, state: { status: "o", answers: {} } },
      },
    };
    await withStubServer(formAndFieldStub({ properties }), async (baseUrl) => {
      const client = new JiraClient({ baseUrl, pat: "synthetic-token" });
      const form = await client.getProformaForm("TEST-1", 7);
      assert.deepEqual(form.warnings, [
        "Open form: unsaved browser-only changes are not visible through Jira server APIs.",
      ]);
    });
  });

  test("submitted forms carry no warning", async () => {
    const properties = {
      "proforma.forms": { value: { forms: [{ id: 7, name: "Submitted form" }] } },
      "proforma.forms.i7": {
        value: { design: { questions: {} }, state: { status: "s", answers: {} } },
      },
    };
    await withStubServer(formAndFieldStub({ properties }), async (baseUrl) => {
      const client = new JiraClient({ baseUrl, pat: "synthetic-token" });
      const form = await client.getProformaForm("TEST-1", 7);
      assert.deepEqual(form.warnings, []);
    });
  });

  test("propagates a failed linked-field lookup with issue, form and field context", async () => {
    const properties = {
      "proforma.forms": { value: { forms: [{ id: 7, name: "Broken lookup form" }] } },
      "proforma.forms.i7": {
        value: {
          design: { questions: { q1: { label: "Scope", type: "ts", jiraField: "customfield_500" } } },
          state: { status: "o", answers: {} },
        },
      },
    };
    await withStubServer(formAndFieldStub({
      properties,
      fieldCatalogue: [{ id: "customfield_500", name: "Scope", custom: true }],
      issueResponse: { status: 500, body: JSON.stringify({ errorMessages: ["upstream failure"] }) },
    }), async (baseUrl) => {
      const client = new JiraClient({ baseUrl, pat: "synthetic-token" });
      await assert.rejects(
        client.getProformaForm("TEST-1", 7),
        domainError(/ProForma form 7 \("Broken lookup form"\)/, /issue TEST-1/, /customfield_500/),
      );
    });
  });
});

describe("formatProformaAnswer type discrimination", () => {
  test("returns a bare string answer instead of splitting it into characters", () => {
    assert.equal(formatProformaAnswer("plain", {}), "plain");
    assert.equal(formatProformaAnswer("  padded  ", undefined), "padded");
  });

  test("formats list answers by element instead of by index key", () => {
    assert.equal(formatProformaAnswer(["alpha", "beta"], undefined), "alpha, beta");
    assert.equal(formatProformaAnswer([{ a: 1 }], undefined), '{"a":1}');
  });

  test("treats a deleted field's null answer as empty", () => {
    assert.equal(formatProformaAnswer(null, undefined), "");
    assert.equal(formatProformaAnswer(undefined, undefined), "");
  });

  test("formats scalar answers", () => {
    assert.equal(formatProformaAnswer(42, undefined), "42");
    assert.equal(formatProformaAnswer(false, undefined), "false");
  });
});

describe("malformed Jira field and issue responses", () => {
  test("getIssueFields reports a field catalogue that is not an array", async () => {
    await withStubServer((request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify((request.url || "").startsWith("/rest/api/2/field") ? {} : { fields: {} }));
    }, async (baseUrl) => {
      const client = new JiraClient({ baseUrl, pat: "synthetic-token" });
      await assert.rejects(
        client.getIssueFields("TEST-1"),
        domainError(/field catalogue/, /\/rest\/api\/2\/field/, /expected an array/),
      );
    });
  });

  test("getIssueFields reports an issue response without a fields object", async () => {
    await withStubServer((request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify((request.url || "").startsWith("/rest/api/2/field")
        ? [{ id: "summary", name: "Summary" }]
        : { key: "TEST-1" }));
    }, async (baseUrl) => {
      const client = new JiraClient({ baseUrl, pat: "synthetic-token" });
      await assert.rejects(
        client.getIssueFields("TEST-1"),
        domainError(/Jira issue TEST-1/, /"fields" object/),
      );
    });
  });

  test("getIssue reports an issue response without a fields object", async () => {
    await withStubServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ key: "TEST-1" }));
    }, async (baseUrl) => {
      const client = new JiraClient({ baseUrl, pat: "synthetic-token" });
      await assert.rejects(client.getIssue("TEST-1"), domainError(/Jira issue TEST-1/, /"fields" object/));
    });
  });

  test("searchIssues reports a non-array issues page", async () => {
    await withStubServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ issues: {}, total: 0 }));
    }, async (baseUrl) => {
      const client = new JiraClient({ baseUrl, pat: "synthetic-token" });
      await assert.rejects(
        client.searchIssues("project = TEST"),
        domainError(/search result page/, /expected an array/),
      );
    });
  });
});

describe("field definition cache", () => {
  test("deduplicates concurrent catalogue fetches on a cold cache", async () => {
    let catalogueRequests = 0;
    await withStubServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if ((request.url || "").startsWith("/rest/api/2/field")) {
        catalogueRequests += 1;
        setTimeout(() => response.end(JSON.stringify([{ id: "summary", name: "Summary" }])), 15);
        return;
      }
      response.end(JSON.stringify({ key: "TEST-1", fields: { summary: "Synthetic" } }));
    }, async (baseUrl) => {
      const client = new JiraClient({ baseUrl, pat: "synthetic-token" });
      const results = await Promise.all([
        client.getIssueFields("TEST-1"),
        client.getIssueFields("TEST-1"),
        client.getIssueFields("TEST-1"),
      ]);

      assert.equal(catalogueRequests, 1, `expected one catalogue fetch, observed ${catalogueRequests}`);
      for (const fields of results) {
        assert.deepEqual(fields.map((field) => field.id), ["summary"]);
      }
    });
  });

  test("does not cache a failed catalogue fetch", async () => {
    let catalogueRequests = 0;
    await withStubServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if ((request.url || "").startsWith("/rest/api/2/field")) {
        catalogueRequests += 1;
        response.end(JSON.stringify(catalogueRequests === 1 ? {} : [{ id: "summary", name: "Summary" }]));
        return;
      }
      response.end(JSON.stringify({ key: "TEST-1", fields: { summary: "Synthetic" } }));
    }, async (baseUrl) => {
      const client = new JiraClient({ baseUrl, pat: "synthetic-token" });
      await assert.rejects(client.getIssueFields("TEST-1"), domainError(/field catalogue/));

      const fields = await client.getIssueFields("TEST-1");
      assert.deepEqual(fields.map((field) => field.id), ["summary"]);
      assert.equal(catalogueRequests, 2, "the rejected catalogue promise must not stay in the cache");
    });
  });
});

describe("getIssueFields field selection", () => {
  test("keeps the default issue request at constant length regardless of catalogue size", async () => {
    const bigCatalogue = Array.from({ length: 2000 }, (_, index) => ({
      id: `customfield_${index}`,
      name: `Field ${index}`,
      custom: true,
    }));
    let issueRequestUrl: string | undefined;
    await withStubServer((request, response) => {
      const url = request.url || "";
      response.setHeader("content-type", "application/json");
      if (url.startsWith("/rest/api/2/field")) {
        response.end(JSON.stringify(bigCatalogue));
        return;
      }
      issueRequestUrl = url;
      response.end(JSON.stringify({
        key: "TEST-1",
        fields: {
          customfield_1: "A value",
          customfield_2: "",
          attachment: [{ id: "1" }],
          comment: { comments: [] },
          worklog: { worklogs: [] },
        },
      }));
    }, async (baseUrl) => {
      const client = new JiraClient({ baseUrl, pat: "synthetic-token" });
      const fields = await client.getIssueFields("TEST-1");

      assert.ok(issueRequestUrl, "expected an issue request");
      assert.equal(issueRequestUrl, "/rest/api/2/issue/TEST-1?fields=*all%2C-attachment%2C-comment%2C-worklog");
      assert.ok(
        (issueRequestUrl as string).length < 256,
        `expected a bounded request URL, observed ${(issueRequestUrl as string).length} characters`,
      );
      assert.deepEqual(fields.map((field) => field.id), ["customfield_1"]);
    });
  });

  test("default retrieval excludes attachment, comment and worklog and filters empty values unless includeEmpty", async () => {
    const catalogue = [
      { id: "customfield_1", name: "Populated", custom: true },
      { id: "customfield_2", name: "Empty", custom: true },
    ];
    await withStubServer((request, response) => {
      const url = request.url || "";
      response.setHeader("content-type", "application/json");
      if (url.startsWith("/rest/api/2/field")) {
        response.end(JSON.stringify(catalogue));
        return;
      }
      response.end(JSON.stringify({
        key: "TEST-1",
        fields: {
          customfield_1: "A value",
          customfield_2: "",
          attachment: [{ id: "1" }],
          comment: { comments: [] },
          worklog: { worklogs: [] },
        },
      }));
    }, async (baseUrl) => {
      const client = new JiraClient({ baseUrl, pat: "synthetic-token" });
      const fields = await client.getIssueFields("TEST-1");
      assert.deepEqual(fields.map((field) => field.id), ["customfield_1"]);

      const withEmpty = await client.getIssueFields("TEST-1", [], true);
      assert.deepEqual(withEmpty.map((field) => field.id).sort(), ["customfield_1", "customfield_2"]);
    });
  });

  test("exact field-name and field-ID filtering stays case-insensitive and never uses the wildcard selector", async () => {
    const catalogue = [
      { id: "summary", name: "Summary", custom: false },
      { id: "customfield_10", name: "Story Points", custom: true },
      { id: "customfield_20", name: "Epic Link", custom: true },
    ];
    let issueRequestUrl: string | undefined;
    await withStubServer((request, response) => {
      const url = request.url || "";
      response.setHeader("content-type", "application/json");
      if (url.startsWith("/rest/api/2/field")) {
        response.end(JSON.stringify(catalogue));
        return;
      }
      issueRequestUrl = url;
      response.end(JSON.stringify({
        key: "TEST-1",
        fields: { summary: "Ticket title", customfield_10: 5 },
      }));
    }, async (baseUrl) => {
      const client = new JiraClient({ baseUrl, pat: "synthetic-token" });
      const fields = await client.getIssueFields("TEST-1", ["SUMMARY", "story points"]);

      assert.ok(issueRequestUrl?.includes("fields=summary%2Ccustomfield_10"));
      assert.ok(!issueRequestUrl?.includes("*all"), "named-field lookups must not fall back to the wildcard selector");
      assert.deepEqual(
        fields.map((field) => [field.id, field.value]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
        [["customfield_10", 5], ["summary", "Ticket title"]],
      );
    });
  });

  test("throws when no requested field name or ID matches the catalogue", async () => {
    const catalogue = [{ id: "summary", name: "Summary", custom: false }];
    await withStubServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if ((request.url || "").startsWith("/rest/api/2/field")) {
        response.end(JSON.stringify(catalogue));
        return;
      }
      response.end(JSON.stringify({ key: "TEST-1", fields: {} }));
    }, async (baseUrl) => {
      const client = new JiraClient({ baseUrl, pat: "synthetic-token" });
      await assert.rejects(
        client.getIssueFields("TEST-1", ["does-not-exist"]),
        /No Jira fields matched: does-not-exist/,
      );
    });
  });
});

describe("listProjects", () => {
  const projects = [
    { id: "1", key: "ALPHA", name: "Alpha" },
    { id: "2", key: "BETA", name: "Beta" },
    { id: "3", key: "GAMMA", name: "Gamma" },
  ];

  test("caps the result set when a limit is given", async () => {
    await withStubServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(projects));
    }, async (baseUrl) => {
      const client = new JiraClient({ baseUrl, pat: "synthetic-token" });
      assert.deepEqual((await client.listProjects(undefined, 2)).map((project) => project.key), ["ALPHA", "BETA"]);
      assert.deepEqual((await client.listProjects()).map((project) => project.key), ["ALPHA", "BETA", "GAMMA"]);
      assert.deepEqual((await client.listProjects("ta", 1)).map((project) => project.key), ["BETA"]);
    });
  });

  test("reports a project list that is not an array", async () => {
    await withStubServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ errorMessages: ["nope"] }));
    }, async (baseUrl) => {
      const client = new JiraClient({ baseUrl, pat: "synthetic-token" });
      await assert.rejects(client.listProjects(), domainError(/project list/, /expected an array/));
    });
  });
});

/* ------------------------------------------------------------------ */
/* Pattern C: the changelog walk has a page budget                     */
/* ------------------------------------------------------------------ */

/**
 * getIssueChangelog was the only pagination loop in the repo without one. Its
 * three exit conditions all needed metadata the server may omit: a page with
 * rows, no `isLast` and no `total` compared `startAt >= undefined`, which is
 * always false, so it kept asking - measured at 3463 requests in six seconds
 * against a stub, still climbing.
 *
 * The hostile-shape table above does not pin this down: the shapes it feeds in
 * are rejected by the envelope and total guards before the loop can run away,
 * so removing the budget again would leave every one of those tests green.
 * These cases feed the shape that actually loops - well-formed, distinct rows
 * with no completion signal at all - and assert on the request count, which is
 * what a budget is.
 */
describe("changelog pagination is bounded", () => {
  /** Rows a real DC instance returns: distinct ids, no `total`, no `isLast`. */
  function endlessChangelogServer(requests: { count: number }) {
    return (_request: IncomingMessage, response: ServerResponse) => {
      requests.count += 1;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        values: [{
          id: String(requests.count),
          created: "2024-01-01T00:00:00.000+0000",
          author: { displayName: "Ada" },
          items: [{ field: "status", fromString: "To Do", toString: "Done" }],
        }],
      }));
    };
  }

  test("stops at the configured page budget instead of paging forever", { timeout: 10_000 }, async () => {
    const requests = { count: 0 };
    await withStubServer(endlessChangelogServer(requests), async (baseUrl) => {
      const client = new JiraClient({ baseUrl, pat: "synthetic-token", maxPaginationPages: 3 });

      await assert.rejects(
        client.getIssueChangelog("TEST-1"),
        domainError(/issue TEST-1 changelog/, /limit of 3 pages/, /ATLASSIAN_MAX_PAGINATION_PAGES/),
      );
      assert.equal(requests.count, 3);
    });
  });

  test("applies the shipped default budget when none is configured", { timeout: 10_000 }, async () => {
    const requests = { count: 0 };
    await withStubServer(endlessChangelogServer(requests), async (baseUrl) => {
      const client = new JiraClient({ baseUrl, pat: "synthetic-token" });

      await assert.rejects(client.getIssueChangelog("TEST-1"), domainError(/limit of 10 pages/));
      assert.equal(requests.count, 10);
    });
  });

  // Partial history is the tempting shortcut here and the wrong one: a status
  // timeline missing its middle is indistinguishable from a complete one once
  // it is returned, so truncation has to be an error, as it already is for
  // boards, sprints and Confluence collections.
  test("refuses to return the pages it did fetch", { timeout: 10_000 }, async () => {
    const requests = { count: 0 };
    await withStubServer(endlessChangelogServer(requests), async (baseUrl) => {
      const client = new JiraClient({ baseUrl, pat: "synthetic-token", maxPaginationPages: 2 });

      await assert.rejects(
        client.getIssueChangelog("TEST-1"),
        domainError(/Partial results were not returned/),
      );
    });
  });

  test("rejects a server whose reported startAt never advances", { timeout: 10_000 }, async () => {
    const requests = { count: 0 };
    await withStubServer((_request, response) => {
      requests.count += 1;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ startAt: 0, values: [{ id: String(requests.count), items: [] }] }));
    }, async (baseUrl) => {
      const client = new JiraClient({ baseUrl, pat: "synthetic-token" });

      await assert.rejects(
        client.getIssueChangelog("TEST-1"),
        domainError(/did not advance/, /requested startAt=1/),
      );
      assert.equal(requests.count, 2);
    });
  });

  test("rejects a server that replays the same page", { timeout: 10_000 }, async () => {
    const requests = { count: 0 };
    await withStubServer((_request, response) => {
      requests.count += 1;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ values: [{ id: "same", items: [] }] }));
    }, async (baseUrl) => {
      const client = new JiraClient({ baseUrl, pat: "synthetic-token" });

      await assert.rejects(client.getIssueChangelog("TEST-1"), domainError(/repeated page/));
      assert.equal(requests.count, 2);
    });
  });

  test("still walks a well-formed multi-page changelog to the end", async () => {
    const requests: string[] = [];
    await withStubServer((request, response) => {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      requests.push(url.searchParams.get("startAt") || "");
      const page = requests.length;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        startAt: Number(url.searchParams.get("startAt")),
        total: 2,
        isLast: page === 2,
        values: [{
          id: String(page),
          created: `2024-01-0${page}T00:00:00.000+0000`,
          author: { displayName: "Ada" },
          items: [{ field: "status", fromString: "To Do", toString: "Done" }],
        }],
      }));
    }, async (baseUrl) => {
      const client = new JiraClient({ baseUrl, pat: "synthetic-token" });

      const changelog = await client.getIssueChangelog("TEST-1");

      assert.deepEqual(requests, ["0", "1"]);
      assert.equal(changelog.transitions.length, 2);
      assert.equal(changelog.transitions[0].at, "2024-01-01T00:00:00.000+0000");
      assert.equal(changelog.transitions[1].at, "2024-01-02T00:00:00.000+0000");
    });
  });

  test("rejects a page budget that is not a positive integer before any request", () => {
    assert.throws(
      () => new JiraClient({ baseUrl: "http://127.0.0.1:1", pat: "synthetic-token", maxPaginationPages: 0 }),
      /maxPaginationPages must be a positive safe integer/,
    );
  });
});

/* ------------------------------------------------------------------ */
/* Pattern A: every read endpoint, every hostile shape                 */
/* ------------------------------------------------------------------ */

/**
 * The suites above grew case by case as individual defects were found. This
 * one is the systematic version: the product of every Jira read entry point
 * and every body shape a real Data Center deployment produces. The invariant
 * is deliberately shape-independent - whatever the client decides to do with a
 * given shape, it may never surface a raw TypeError, and any error it raises
 * has to name the field or resource at fault.
 */
describe("Jira reads survive a hostile upstream", () => {
  const endpoints: Array<{ name: string; call: (client: JiraClient) => Promise<unknown> }> = [
    { name: "searchIssues", call: (client) => client.searchIssues("project = TEST", 20) },
    { name: "getIssue", call: (client) => client.getIssue("TEST-1") },
    { name: "getIssueFields", call: (client) => client.getIssueFields("TEST-1") },
    { name: "listProjects", call: (client) => client.listProjects() },
    { name: "getTransitions", call: (client) => client.getTransitions("TEST-1") },
    { name: "listProformaForms", call: (client) => client.listProformaForms("TEST-1") },
    { name: "getProformaFormsSummary", call: (client) => client.getProformaFormsSummary("TEST-1") },
    { name: "listAttachments", call: (client) => client.listAttachments("TEST-1") },
    { name: "getIssueLinks", call: (client) => client.getIssueLinks("TEST-1") },
    { name: "listWorklogs", call: (client) => client.listWorklogs("TEST-1") },
    { name: "listWatchers", call: (client) => client.listWatchers("TEST-1") },
    { name: "getIssueChangelog", call: (client) => client.getIssueChangelog("TEST-1") },
  ];

  /**
   * Every combination is a hard pass. The four entry points that used to be
   * marked TODO here (getTransitions, listWorklogs, listWatchers,
   * getIssueChangelog) reached into an absent body; the two that used to be
   * skipped never returned at all, because getIssueChangelog paged the
   * dedicated endpoint with no page budget and a response without a usable
   * `total` satisfied none of its exit conditions. Both classes are fixed, so
   * neither marker is left in the table: a regression must fail the suite, not
   * be reported as a known gap.
   *
   * The timeout is the backstop for the second class. It is generous compared
   * with the real cost of these cases (a page budget of ten requests against a
   * loopback stub), and small enough that a reintroduced unbounded loop fails
   * the run instead of hanging it.
   */
  for (const endpoint of endpoints) {
    for (const testCase of UPSTREAM_GARBAGE_CASES) {
      test(`${endpoint.name} answers ${testCase.name} with a domain error, never a TypeError`, { timeout: 10_000 }, async () => {
        await withStubServer(constantHandler(testCase.response), async (baseUrl) => {
          const client = new JiraClient({ baseUrl, pat: "synthetic-token" });
          await assertGarbageHandled(testCase, () => endpoint.call(client));
        });
      });
    }
  }

  /**
   * The classic on-prem failure: an expired PAT behind SSO/WebSEAL never
   * reaches Jira at all - the reverse proxy answers HTTP 200 with its own
   * login form. The operator has to be able to recognise that from the error
   * text alone, so the body snippet must survive into the message.
   */
  test("an SSO login page served with HTTP 200 keeps enough of the body to be recognisable", async () => {
    await withStubServer(
      constantHandler({
        status: 200,
        headers: { "content-type": "text/html" },
        body: "<html><body><form action=\"/login\"><input name=\"os_username\"></form></body></html>",
      }),
      async (baseUrl) => {
        const client = new JiraClient({ baseUrl, pat: "expired-token" });
        await assert.rejects(
          client.searchIssues("project = TEST", 20),
          domainError(/Failed to parse JSON response/, /os_username/),
        );
      },
    );
  });
});

/* ------------------------------------------------------------------ */
/* Pattern D: nested fan-out under the PRODUCTION request budget       */
/* ------------------------------------------------------------------ */

/**
 * The ProForma queue overflow was not produced by either limit being wrong. It
 * was produced by their product under the shipped defaults, which no test ever
 * used: the fan-out tests picked a budget that suited the test. Everything
 * below runs at exactly the configuration an operator gets out of the box.
 */
const PRODUCTION_HTTP_DEFAULTS = {
  timeoutMs: 30_000,
  totalTimeoutMs: 45_000,
  maxConcurrentRequests: 4,
  maxQueuedRequests: 16,
  maxAttempts: 3,
  maxJsonBytes: DEFAULT_MAX_JSON_BYTES,
} as const;

describe("nested fan-out stays inside the shipped request budget", () => {
  afterEach(() => {
    configureHttp({ ...PRODUCTION_HTTP_DEFAULTS });
  });

  test("getProformaFormsSummary completes at the default 4 active / 16 queued budget", async () => {
    configureHttp({ ...PRODUCTION_HTTP_DEFAULTS });

    const formIds = [1, 2, 3, 4, 5, 6, 7, 8];
    const chunkCount = 9;
    const encoded = Buffer.from(JSON.stringify({ questions: {} }), "utf8").toString("base64");
    const chunkSize = Math.ceil(encoded.length / chunkCount);
    const chunks = Array.from({ length: chunkCount }, (_unused, index) => ({
      part: `${index + 1}/${chunkCount}`,
      data: encoded.slice(index * chunkSize, (index + 1) * chunkSize),
    }));

    await withStubServer((request, response) => {
      const property = decodeURIComponent((request.url || "").split("/").pop() || "");
      response.setHeader("content-type", "application/json");
      if (property === "proforma.forms") {
        response.end(JSON.stringify({
          value: { forms: formIds.map((id) => ({ id, name: `Form ${id}` })) },
        }));
        return;
      }
      const trailing = property.split(".").pop() ?? "";
      const chunkIndex = /^\d+$/.test(trailing) ? Number(trailing) : 0;
      // A real instance is slow enough that requests overlap; without the
      // delay the fan-out serialises by accident and the budget is never
      // exercised.
      setTimeout(() => {
        response.end(JSON.stringify(chunkIndex === 0
          ? { value: { rawData: chunks[0], state: { answers: {} } } }
          : { value: chunks[chunkIndex] }));
      }, 10);
    }, async (baseUrl) => {
      const client = new JiraClient({ baseUrl, pat: "synthetic-token" });
      const forms = await client.getProformaFormsSummary("TEST-1");

      assert.equal(forms.length, formIds.length);
    });
  });

  test("getIssuesDevStatus completes at the default 4 active / 16 queued budget", async () => {
    configureHttp({ ...PRODUCTION_HTTP_DEFAULTS });

    const issueKeys = Array.from({ length: 20 }, (_unused, index) => `TEST-${index + 1}`);

    await withStubServer((request, response) => {
      response.setHeader("content-type", "application/json");
      setTimeout(() => {
        response.end((request.url || "").includes("/rest/dev-status/")
          ? JSON.stringify({ detail: [] })
          : JSON.stringify({ id: "10000", key: "TEST-1", fields: { summary: "Synthetic" } }));
      }, 5);
    }, async (baseUrl) => {
      const client = new JiraClient({ baseUrl, pat: "synthetic-token" });
      const statuses = await client.getIssuesDevStatus(issueKeys);

      assert.equal(statuses.length, issueKeys.length);
      // getIssuesDevStatus swallows per-issue failures into `note`, so a queue
      // overflow would otherwise be reported as a successful empty result.
      const overflowed = statuses.filter((status) => /queue is full/i.test(status.note ?? ""));
      assert.deepEqual(overflowed, [], "a queue overflow was reported as a per-issue note");
    });
  });

  test("getIssuesCycleTime completes at the default 4 active / 16 queued budget", async () => {
    configureHttp({ ...PRODUCTION_HTTP_DEFAULTS });

    const issueKeys = Array.from({ length: 20 }, (_unused, index) => `TEST-${index + 1}`);

    await withStubServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      setTimeout(() => {
        response.end(JSON.stringify({
          id: "10000",
          key: "TEST-1",
          fields: { summary: "Synthetic", created: "2024-01-01T00:00:00.000+0000" },
          values: [],
          histories: [],
          isLast: true,
          total: 0,
          maxResults: 0,
          startAt: 0,
          changelog: { histories: [] },
        }));
      }, 5);
    }, async (baseUrl) => {
      const client = new JiraClient({ baseUrl, pat: "synthetic-token" });
      const cycleTimes = await client.getIssuesCycleTime(issueKeys, "In Progress", "Done");

      assert.equal(cycleTimes.length, issueKeys.length);
      for (const entry of cycleTimes) {
        assert.doesNotMatch(entry.note ?? "", /queue is full/i);
      }
    });
  });
});

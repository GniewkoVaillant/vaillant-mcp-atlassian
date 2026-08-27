/**
 * Shared test infrastructure.
 *
 * Three copies of `withStubServer` used to live in this directory: a rich one
 * in httpClient.test.ts and two impoverished ones in confluenceClient.test.ts
 * and jiraClient.test.ts. The poor versions could not record requests and had
 * no way to script a sequence of responses, so the two clients that used them
 * were only ever tested against well-formed replies - which is precisely the
 * class of bug that shipped. One rich helper, used everywhere, removes the
 * incentive to write only happy-path stubs.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type RequestRecord = {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: Buffer;
};

export type StubHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  requests: RequestRecord[],
) => Promise<void> | void;

export type ScriptedResponse = {
  status?: number;
  statusMessage?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
};

export async function readRequestBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function recordRequest(
  req: IncomingMessage,
  requests: RequestRecord[],
): Promise<RequestRecord> {
  const record = {
    method: req.method ?? "",
    url: req.url ?? "",
    headers: req.headers,
    body: await readRequestBody(req),
  };
  requests.push(record);
  return record;
}

export function sendResponse(res: ServerResponse, response: ScriptedResponse): void {
  res.statusCode = response.status ?? 200;
  if (response.statusMessage) {
    res.statusMessage = response.statusMessage;
  }
  for (const [name, value] of Object.entries(response.headers ?? {})) {
    res.setHeader(name, value);
  }
  res.end(response.body);
}

/**
 * Answers request N with `responses[N]`, holding the last entry once the
 * script runs out. This is the piece the impoverished helpers lacked, and the
 * reason nobody wrote a "the server misbehaves on the second page" test.
 */
export function scriptedHandler(responses: ScriptedResponse[]): StubHandler {
  return async (req, res, requests) => {
    await recordRequest(req, requests);
    sendResponse(res, responses[Math.min(requests.length - 1, responses.length - 1)] ?? {});
  };
}

/** Answers every request with the same scripted response. */
export function constantHandler(response: ScriptedResponse): StubHandler {
  return async (req, res, requests) => {
    await recordRequest(req, requests);
    sendResponse(res, response);
  };
}

export async function withStubServer(
  handler: StubHandler,
  run: (baseUrl: string, requests: RequestRecord[]) => Promise<void>,
): Promise<void> {
  const requests: RequestRecord[] = [];
  const server = createServer((req, res) => {
    void Promise.resolve(handler(req, res, requests)).catch((err: unknown) => {
      res.statusCode = 500;
      res.end(err instanceof Error ? err.message : String(err));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`, requests);
  } finally {
    const closePromise = new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    server.closeAllConnections();
    await closePromise;
  }
}

export async function withTemporaryDirectory(
  action: (directory: string) => Promise<void>,
  prefix = "mcp-atlassian-test-",
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  try {
    await action(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ */
/* Hostile-upstream corpus                                            */
/* ------------------------------------------------------------------ */

const HTML_LOGIN_PAGE =
  "<html><head><title>Sign in</title></head><body><form action=\"/login\">" +
  "<input name=\"os_username\"><input name=\"os_password\" type=\"password\">" +
  "</form></body></html>";

/**
 * The shapes an on-prem Data Center deployment actually produces when
 * something upstream is wrong. Every one of these arrives with HTTP 200, which
 * is exactly why they slipped past stubs that only ever returned well-formed
 * bodies.
 */
export type UpstreamGarbageCase = {
  /** Stable name used in test titles. */
  readonly name: string;
  readonly response: ScriptedResponse;
};

/**
 * Deliberately shape-only: what a given endpoint should *do* with each shape
 * differs (an empty object is a complete empty collection for one endpoint and
 * a missing resource for another), so the shared invariant is the one that
 * holds everywhere - never a TypeError, always a message that names the field
 * or the resource. Endpoint-specific expectations live next to the endpoint.
 */
export const UPSTREAM_GARBAGE_CASES: readonly UpstreamGarbageCase[] = [
  { name: "an empty 200 body", response: { body: "" } },
  { name: "an empty JSON object", response: { body: "{}" } },
  { name: "a cleared property envelope", response: { body: '{"value":null}' } },
  { name: "a null results member", response: { body: '{"results":null,"issues":null,"values":null}' } },
  {
    name: "a total that promises rows the page does not contain",
    response: { body: '{"total":5,"totalSize":5,"size":0,"results":[],"issues":[],"values":[]}' },
  },
  {
    name: "an SSO login page served with HTTP 200",
    response: { status: 200, headers: { "content-type": "text/html" }, body: HTML_LOGIN_PAGE },
  },
  {
    name: "an error envelope served with HTTP 200",
    response: { status: 200, body: '{"errorMessages":["Issue does not exist"],"errors":{}}' },
  },
  {
    name: "a text/html content type on an otherwise valid 200",
    response: { status: 200, headers: { "content-type": "text/html" }, body: '{"results":[],"issues":[],"values":[]}' },
  },
  {
    name: "a total inconsistent with the number of elements returned",
    response: { body: '{"total":-1,"totalSize":-1,"size":2,"results":[{"id":"1"}],"issues":[{"id":"1"}],"values":[{"id":1}]}' },
  },
  {
    name: "a non-array collection member",
    response: { body: '{"values":"invalid","results":"invalid","issues":"invalid","forms":"invalid","fields":"invalid"}' },
  },
];

const RAW_PROPERTY_ACCESS = /Cannot read propert|is not a function|is not iterable|undefined is not|of undefined|of null/i;

/**
 * The assertion the whole exercise turns on: a hostile upstream must produce a
 * domain error that names the field or resource at fault. A `TypeError` from a
 * guard-less property access is always a bug, never an acceptable outcome, and
 * this helper rejects it explicitly rather than settling for "it threw".
 */
export function assertDomainError(error: unknown, ...patterns: RegExp[]): true {
  assert.ok(error instanceof Error, `expected an Error, received ${String(error)}`);
  assert.ok(
    !(error instanceof TypeError),
    `expected a domain error, received a raw TypeError: ${error.message}`,
  );
  assert.doesNotMatch(
    error.message,
    RAW_PROPERTY_ACCESS,
    `expected a domain error, received a raw property-access failure: ${error.message}`,
  );
  assert.ok(
    error.message.trim().length >= 20,
    `expected an error message that names the field or resource, received: ${error.message}`,
  );
  for (const pattern of patterns) {
    assert.match(error.message, pattern);
  }
  return true;
}

/** Predicate form, for `assert.rejects(..., domainError(/pattern/))`. */
export function domainError(...patterns: RegExp[]): (error: unknown) => boolean {
  return (error: unknown) => assertDomainError(error, ...patterns);
}

/**
 * Runs one hostile-upstream case against one client entry point and asserts
 * the universal invariant. Returns what actually happened so a caller can add
 * endpoint-specific expectations on top.
 */
export async function assertGarbageHandled(
  testCase: UpstreamGarbageCase,
  action: () => Promise<unknown>,
): Promise<{ outcome: "resolved" | "rejected"; error?: Error }> {
  try {
    await action();
    return { outcome: "resolved" };
  } catch (error) {
    try {
      assertDomainError(error);
    } catch (failure) {
      if (failure instanceof Error) failure.message = `[${testCase.name}] ${failure.message}`;
      throw failure;
    }
    return { outcome: "rejected", error: error as Error };
  }
}

/**
 * Pattern D from the audit: a nested fan-out overflows the shared admission
 * queue only under the product of two limits, so the check that matters is
 * "does this operation survive the shipped configuration", not "does it
 * survive a configuration chosen to make it pass". Any other failure is left
 * to the caller; only a queue overflow is a budget defect.
 */
export async function assertNoQueueOverflow(action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert.doesNotMatch(
      message,
      /queue is full|ATLASSIAN_MAX_QUEUED_REQUESTS/i,
      `nested fan-out overflowed the shipped request budget: ${message}`,
    );
  }
}

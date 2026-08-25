/**
 * Shared HTTP helper for calling Atlassian Data Center REST APIs using a
 * Personal Access Token (PAT). Uses the built-in Node 18+ fetch.
 *
 * Exposes GET, POST, PUT, DELETE and multipart helpers with identical auth,
 * timeout, retry and error handling so both read-only and write (mutating)
 * tools share the same behavior.
 */

export class AtlassianHttpError extends Error {
  constructor(
    public readonly url: string,
    public readonly status: number,
    public readonly statusText: string,
    public readonly bodySnippet: string,
  ) {
    super(
      `Request to ${url} failed with ${status} ${statusText}: ${bodySnippet || "(empty body)"}`,
    );
    this.name = "AtlassianHttpError";
  }
}

export interface RequestOptions {
  baseUrl: string;
  pat: string;
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** Maximum accepted binary response size, checked before and during streaming. */
  maxResponseBytes?: number;
}

interface HttpDefaults {
  timeoutMs: number;
  totalTimeoutMs: number;
  maxConcurrentRequests: number;
  maxQueuedRequests: number;
  maxAttempts: number;
}

const defaults: HttpDefaults = {
  timeoutMs: 30_000,
  totalTimeoutMs: 45_000,
  maxConcurrentRequests: 4,
  maxQueuedRequests: 16,
  maxAttempts: 3,
};

interface QueuedRequest {
  resolve: () => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  deadline: number;
  url: string;
  totalTimeoutMs: number;
}

let activeRequests = 0;
const requestQueue: QueuedRequest[] = [];

/** Applies process-wide HTTP defaults, called once at startup from the config. */
export function configureHttp(options: Partial<HttpDefaults>): void {
  for (const [name, value] of Object.entries(options)) {
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < (name === "maxQueuedRequests" ? 0 : 1)
    ) {
      throw new Error(`Invalid HTTP option ${name}; expected a valid non-negative integer.`);
    }
  }
  if (options.timeoutMs !== undefined) defaults.timeoutMs = options.timeoutMs;
  if (options.totalTimeoutMs !== undefined) defaults.totalTimeoutMs = options.totalTimeoutMs;
  if (options.maxConcurrentRequests !== undefined) defaults.maxConcurrentRequests = options.maxConcurrentRequests;
  if (options.maxQueuedRequests !== undefined) defaults.maxQueuedRequests = options.maxQueuedRequests;
  if (options.maxAttempts !== undefined) defaults.maxAttempts = options.maxAttempts;
  drainQueue();
}

function totalTimeoutError(url: string, totalTimeoutMs: number): Error {
  return new Error(
    `Request to ${url} exceeded the total timeout of ${totalTimeoutMs}ms, including ` +
      "queueing and retries. Adjust ATLASSIAN_TOTAL_TIMEOUT_MS if appropriate.",
  );
}

function drainQueue(): void {
  while (activeRequests < defaults.maxConcurrentRequests && requestQueue.length > 0) {
    const entry = requestQueue.shift()!;
    clearTimeout(entry.timeout);
    if (performance.now() >= entry.deadline) {
      entry.reject(totalTimeoutError(entry.url, entry.totalTimeoutMs));
      continue;
    }
    activeRequests += 1;
    entry.resolve();
  }
}

async function acquireRequestSlot(url: string, deadline: number, totalTimeoutMs: number): Promise<void> {
  const remaining = deadline - performance.now();
  if (remaining <= 0) throw totalTimeoutError(url, totalTimeoutMs);

  if (activeRequests < defaults.maxConcurrentRequests && requestQueue.length === 0) {
    activeRequests += 1;
    return;
  }
  if (requestQueue.length >= defaults.maxQueuedRequests) {
    throw new Error(
      `Atlassian request queue is full (${defaults.maxQueuedRequests} waiting requests). ` +
        "Reduce concurrent tool calls or cautiously adjust ATLASSIAN_MAX_QUEUED_REQUESTS.",
    );
  }

  await new Promise<void>((resolve, reject) => {
    const entry: QueuedRequest = {
      resolve,
      reject,
      deadline,
      url,
      totalTimeoutMs,
      timeout: setTimeout(() => {
        const index = requestQueue.indexOf(entry);
        if (index >= 0) requestQueue.splice(index, 1);
        reject(totalTimeoutError(url, totalTimeoutMs));
      }, Math.max(1, Math.ceil(remaining))),
    };
    requestQueue.push(entry);
  });
}

function releaseRequestSlot(): void {
  activeRequests -= 1;
  drainQueue();
}

function buildUrl(
  baseUrl: string,
  path: string,
  query?: Record<string, string | number | boolean | undefined>,
): string {
  const base = new URL(baseUrl);
  const url = /^https?:\/\//i.test(path)
    ? new URL(path)
    : new URL(`${baseUrl}${path.startsWith("/") ? path : `/${path}`}`);

  if (url.origin !== base.origin) {
    throw new Error(
      `Refusing to send Atlassian credentials to a different origin: ${url.origin}`,
    );
  }

  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
  }
  return url.toString();
}

/** HTTP methods that are safe to replay after a transient failure. */
const IDEMPOTENT_METHODS = new Set(["GET", "PUT", "DELETE"]);

/** Statuses worth retrying: rate limiting and transient upstream failures. */
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);

function shouldRetry(method: string, status: number): boolean {
  if (!RETRYABLE_STATUSES.has(status)) return false;
  // A 429 means the request was rejected before being processed, so replaying
  // it cannot duplicate a write. Other 5xx may have been partially applied, so
  // only replay them for idempotent methods.
  if (status === 429) return true;
  return IDEMPOTENT_METHODS.has(method);
}

/** Honours a Retry-After header when present, otherwise exponential backoff. */
function retryDelayMs(response: Response | undefined, attempt: number): number {
  const header = response?.headers.get("retry-after");
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, 30_000);
    }
    const date = Date.parse(header);
    if (!Number.isNaN(date)) {
      return Math.min(Math.max(date - Date.now(), 0), 30_000);
    }
  }
  return Math.min(2 ** attempt * 500, 8_000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface FetchAttemptOptions {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string | FormData;
}

/**
 * Performs a single fetch with an abort-based timeout, translating both
 * network failures and timeouts into readable errors.
 */
async function fetchOnce(
  options: FetchAttemptOptions,
  deadline: number,
  totalTimeoutMs: number,
): Promise<Response> {
  const remaining = deadline - performance.now();
  if (remaining <= 0) throw totalTimeoutError(options.url, totalTimeoutMs);
  const timeoutMs = Math.max(1, Math.min(defaults.timeoutMs, Math.ceil(remaining)));
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    let url = options.url;
    for (let redirects = 0; redirects <= 5; redirects += 1) {
      const response = await fetch(url, {
        method: options.method,
        headers: options.headers,
        body: options.body,
        signal,
        redirect: "manual",
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;

      const location = response.headers.get("location");
      if (!location) return response;
      const next = new URL(location, url);
      if (next.origin !== new URL(options.url).origin) {
        throw new Error(`Refusing to follow Atlassian redirect to a different origin: ${next.origin}`);
      }
      if (options.method !== "GET") {
        throw new Error(`Refusing to replay a ${options.method} request after an Atlassian redirect.`);
      }
      if (redirects === 5) {
        throw new Error(`Request to ${options.url} exceeded the maximum of 5 same-origin redirects.`);
      }
      void response.body?.cancel().catch(() => undefined);
      url = next.toString();
    }
    throw new Error(`Request to ${options.url} exceeded the maximum of 5 same-origin redirects.`);
  } catch (err) {
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
      if (timeoutMs < defaults.timeoutMs || performance.now() >= deadline) {
        throw totalTimeoutError(options.url, totalTimeoutMs);
      }
      throw new Error(
        `Request to ${options.url} timed out after ${defaults.timeoutMs}ms. ` +
          `Increase ATLASSIAN_TIMEOUT_MS if the instance is simply slow.`,
      );
    }
    if (err instanceof Error && err.message.startsWith("Refusing to ")) throw err;
    const cause = err instanceof Error ? err.message : String(err);
    throw new Error(`Network error while calling ${options.url}: ${cause}`);
  }
}

/**
 * Executes a request with retry/backoff on rate limiting and transient
 * upstream errors, then returns the raw Response for the caller to decode.
 * Throws AtlassianHttpError on any non-2xx response that isn't retryable
 * (or once retries are exhausted).
 */
async function execute<T>(
  options: FetchAttemptOptions,
  consume: (response: Response) => Promise<T>,
): Promise<T> {
  const totalTimeoutMs = defaults.totalTimeoutMs;
  const deadline = performance.now() + totalTimeoutMs;
  let lastError: unknown;

  for (let attempt = 0; attempt < defaults.maxAttempts; attempt += 1) {
    await acquireRequestSlot(options.url, deadline, totalTimeoutMs);
    let response: Response | undefined;
    let delay: number | undefined;
    try {
      try {
        response = await fetchOnce(options, deadline, totalTimeoutMs);
      } catch (err) {
        lastError = err;
        // Network errors and timeouts are only replayed for idempotent methods,
        // since a timed-out POST may still have been applied server-side.
        if (
          !IDEMPOTENT_METHODS.has(options.method) ||
          attempt === defaults.maxAttempts - 1 ||
          (err instanceof Error && err.message.includes("ATLASSIAN_TOTAL_TIMEOUT_MS")) ||
          (err instanceof Error && err.message.startsWith("Refusing to "))
        ) {
          throw err;
        }
        delay = retryDelayMs(undefined, attempt);
      }

      if (response?.ok) {
        try {
          return await consume(response);
        } catch (err) {
          if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
            if (performance.now() >= deadline) throw totalTimeoutError(options.url, totalTimeoutMs);
            throw new Error(
              `Request to ${options.url} timed out after ${defaults.timeoutMs}ms. ` +
                "Increase ATLASSIAN_TIMEOUT_MS if the instance is simply slow.",
            );
          }
          throw err;
        }
      }

      if (response && shouldRetry(options.method, response.status) && attempt < defaults.maxAttempts - 1) {
        delay = retryDelayMs(response, attempt);
        void response.body?.cancel().catch(() => undefined);
      } else if (response) {
        let bodyText = "";
        try {
          bodyText = await response.text();
        } catch (err) {
          if (performance.now() >= deadline) throw totalTimeoutError(options.url, totalTimeoutMs);
          if (!(err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError"))) {
            bodyText = "";
          } else {
            throw new Error(
              `Request to ${options.url} timed out after ${defaults.timeoutMs}ms. ` +
                "Increase ATLASSIAN_TIMEOUT_MS if the instance is simply slow.",
            );
          }
        }
        throw new AtlassianHttpError(
          options.url,
          response.status,
          response.statusText,
          bodyText.slice(0, 500),
        );
      }
    } finally {
      releaseRequestSlot();
    }

    if (delay !== undefined) {
      const remaining = deadline - performance.now();
      if (remaining <= 0 || delay >= remaining) {
        throw totalTimeoutError(options.url, totalTimeoutMs);
      }
      await sleep(delay);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Request to ${options.url} failed after ${defaults.maxAttempts} attempts`);
}

async function decodeJson<T>(response: Response, url: string): Promise<T> {
  const text = await response.text();
  if (!text) {
    return undefined as T;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Failed to parse JSON response from ${url}: ${text.slice(0, 500)}`);
  }
}

function authHeaders(pat: string, accept: string): Record<string, string> {
  return {
    Authorization: `Bearer ${pat}`,
    Accept: accept,
  };
}

/**
 * Performs a GET request against an Atlassian Data Center REST endpoint,
 * authenticating with the given Personal Access Token.
 * Throws AtlassianHttpError on any non-2xx response.
 */
export async function atlassianGet<T = any>(options: RequestOptions): Promise<T> {
  const url = buildUrl(options.baseUrl, options.path, options.query);
  return execute(
    {
      method: "GET",
      url,
      headers: authHeaders(options.pat, "application/json"),
    },
    (response) => decodeJson<T>(response, url),
  );
}

export interface BinaryResponse {
  data: Buffer;
  contentType: string;
  contentDisposition: string;
}

export async function atlassianGetBinary(options: RequestOptions): Promise<BinaryResponse> {
  const url = buildUrl(options.baseUrl, options.path, options.query);
  const maximum = options.maxResponseBytes;
  if (maximum !== undefined && (!Number.isSafeInteger(maximum) || maximum <= 0)) {
    throw new Error("maxResponseBytes must be a positive safe integer.");
  }

  return execute(
    {
      method: "GET",
      url,
      headers: authHeaders(options.pat, "*/*"),
    },
    async (response) => {
      const contentLength = response.headers.get("content-length");
      if (maximum !== undefined && contentLength !== null) {
        const declared = Number(contentLength);
        if (!Number.isSafeInteger(declared) || declared < 0) {
          void response.body?.cancel().catch(() => undefined);
          throw new Error("Attachment response declared an invalid Content-Length.");
        }
        if (declared > maximum) {
          void response.body?.cancel().catch(() => undefined);
          throw new Error(
            `Attachment response size ${declared} bytes exceeds the maximum of ${maximum} bytes ` +
              "configured by ATLASSIAN_MAX_ATTACHMENT_BYTES.",
          );
        }
      }

      let data: Buffer;
      if (!response.body) {
        data = Buffer.alloc(0);
      } else {
        const reader = response.body.getReader();
        const chunks: Buffer[] = [];
        let size = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (maximum !== undefined && size > maximum) {
              await reader.cancel().catch(() => undefined);
              throw new Error(
                `Attachment response size exceeds the maximum of ${maximum} bytes ` +
                  "configured by ATLASSIAN_MAX_ATTACHMENT_BYTES.",
              );
            }
            chunks.push(Buffer.from(value));
          }
        } finally {
          reader.releaseLock();
        }
        data = Buffer.concat(chunks, size);
      }

      return {
        data,
        contentType: response.headers.get("content-type") || "application/octet-stream",
        contentDisposition: response.headers.get("content-disposition") || "",
      };
    },
  );
}

async function atlassianWrite<T>(method: "POST" | "PUT", options: RequestOptions): Promise<T> {
  const url = buildUrl(options.baseUrl, options.path, options.query);
  return execute(
    {
      method,
      url,
      headers: {
        ...authHeaders(options.pat, "application/json"),
        "Content-Type": "application/json",
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    },
    (response) => decodeJson<T>(response, url),
  );
}

/**
 * Performs a POST request against an Atlassian Data Center REST endpoint,
 * authenticating with the given Personal Access Token. Used for creating
 * resources (issues, comments, pages) and other mutating actions.
 * Throws AtlassianHttpError on any non-2xx response.
 */
export async function atlassianPost<T = any>(options: RequestOptions): Promise<T> {
  return atlassianWrite<T>("POST", options);
}

export interface FormDataRequestOptions extends Omit<RequestOptions, "body"> {
  body: FormData;
}

export async function atlassianPostFormData<T = any>(
  options: FormDataRequestOptions,
): Promise<T> {
  const url = buildUrl(options.baseUrl, options.path, options.query);
  return execute(
    {
      method: "POST",
      url,
      headers: {
        ...authHeaders(options.pat, "application/json"),
        "X-Atlassian-Token": "no-check",
      },
      body: options.body,
    },
    (response) => decodeJson<T>(response, url),
  );
}

/**
 * Performs a PUT request against an Atlassian Data Center REST endpoint,
 * authenticating with the given Personal Access Token. Used for updating
 * existing resources (issues, pages) and other mutating actions.
 * Throws AtlassianHttpError on any non-2xx response.
 */
export async function atlassianPut<T = any>(options: RequestOptions): Promise<T> {
  return atlassianWrite<T>("PUT", options);
}

/**
 * Performs a DELETE request against an Atlassian Data Center REST endpoint,
 * authenticating with the given Personal Access Token. Used for permanently
 * removing existing resources (comments, etc.) and other mutating actions.
 * Throws AtlassianHttpError on any non-2xx response.
 */
export async function atlassianDelete<T = any>(options: RequestOptions): Promise<T> {
  const url = buildUrl(options.baseUrl, options.path, options.query);
  return execute(
    {
      method: "DELETE",
      url,
      headers: authHeaders(options.pat, "application/json"),
    },
    (response) => decodeJson<T>(response, url),
  );
}

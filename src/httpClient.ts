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
}

interface HttpDefaults {
  timeoutMs: number;
  maxAttempts: number;
}

const defaults: HttpDefaults = {
  timeoutMs: 30_000,
  maxAttempts: 3,
};

/** Applies process-wide HTTP defaults, called once at startup from the config. */
export function configureHttp(options: Partial<HttpDefaults>): void {
  if (options.timeoutMs !== undefined) defaults.timeoutMs = options.timeoutMs;
  if (options.maxAttempts !== undefined) defaults.maxAttempts = options.maxAttempts;
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
async function fetchOnce(options: FetchAttemptOptions): Promise<Response> {
  try {
    return await fetch(options.url, {
      method: options.method,
      headers: options.headers,
      body: options.body,
      signal: AbortSignal.timeout(defaults.timeoutMs),
    });
  } catch (err) {
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
      throw new Error(
        `Request to ${options.url} timed out after ${defaults.timeoutMs}ms. ` +
          `Increase ATLASSIAN_TIMEOUT_MS if the instance is simply slow.`,
      );
    }
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
async function execute(options: FetchAttemptOptions): Promise<Response> {
  let lastError: unknown;

  for (let attempt = 0; attempt < defaults.maxAttempts; attempt += 1) {
    let response: Response;
    try {
      response = await fetchOnce(options);
    } catch (err) {
      lastError = err;
      // Network errors and timeouts are only replayed for idempotent methods,
      // since a timed-out POST may still have been applied server-side.
      if (!IDEMPOTENT_METHODS.has(options.method) || attempt === defaults.maxAttempts - 1) {
        throw err;
      }
      await sleep(retryDelayMs(undefined, attempt));
      continue;
    }

    if (response.ok) return response;

    if (shouldRetry(options.method, response.status) && attempt < defaults.maxAttempts - 1) {
      await sleep(retryDelayMs(response, attempt));
      continue;
    }

    const bodyText = await response.text().catch(() => "");
    throw new AtlassianHttpError(
      options.url,
      response.status,
      response.statusText,
      bodyText.slice(0, 500),
    );
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
  const response = await execute({
    method: "GET",
    url,
    headers: authHeaders(options.pat, "application/json"),
  });
  return decodeJson<T>(response, url);
}

export interface BinaryResponse {
  data: Buffer;
  contentType: string;
  contentDisposition: string;
}

export async function atlassianGetBinary(options: RequestOptions): Promise<BinaryResponse> {
  const url = buildUrl(options.baseUrl, options.path, options.query);
  const response = await execute({
    method: "GET",
    url,
    headers: authHeaders(options.pat, "*/*"),
  });
  return {
    data: Buffer.from(await response.arrayBuffer()),
    contentType: response.headers.get("content-type") || "application/octet-stream",
    contentDisposition: response.headers.get("content-disposition") || "",
  };
}

async function atlassianWrite<T>(method: "POST" | "PUT", options: RequestOptions): Promise<T> {
  const url = buildUrl(options.baseUrl, options.path, options.query);
  const response = await execute({
    method,
    url,
    headers: {
      ...authHeaders(options.pat, "application/json"),
      "Content-Type": "application/json",
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  return decodeJson<T>(response, url);
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
  const response = await execute({
    method: "POST",
    url,
    headers: {
      ...authHeaders(options.pat, "application/json"),
      "X-Atlassian-Token": "no-check",
    },
    body: options.body,
  });
  return decodeJson<T>(response, url);
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
  const response = await execute({
    method: "DELETE",
    url,
    headers: authHeaders(options.pat, "application/json"),
  });
  return decodeJson<T>(response, url);
}

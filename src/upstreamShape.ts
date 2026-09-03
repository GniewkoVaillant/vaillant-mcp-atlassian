/**
 * Guards for the JSON an on-prem Atlassian deployment actually returns.
 *
 * A Data Center instance behind a reverse proxy answers HTTP 200 with an empty
 * body when the proxy times out, with an SSO login page when the PAT expired,
 * and with an error envelope when the issue does not exist. Every one of those
 * decodes to something the mapping code below is not expecting, and indexing
 * straight into it produces `Cannot read properties of undefined` — a message
 * that names neither the request nor the field, so nothing downstream can tell
 * a broken upstream from an empty collection or work out what to do next.
 *
 * The convention these helpers exist to enforce, and which
 * `JiraAgileClient.getPaginatedValues` established: a domain error naming the
 * resource and the field, never a raw `TypeError`.
 */

/** Which API the message should blame; only ever these two in this repo. */
export type UpstreamProduct = "Jira" | "Confluence";

/** Short, safe description of an unexpected upstream value, for error messages. */
export function describeUpstreamValue(value: unknown): string {
    if (value === null)
        return "null";
    if (value === undefined)
        return "no value";
    if (Array.isArray(value))
        return "an array";
    return `a value of type ${typeof value}`;
}

/**
 * Gate for a response envelope. `decodeJson` yields `undefined` for an empty
 * 200 body, so callers that destructure or index the result must run it
 * through here first: an absent body is a broken response, never an empty
 * collection.
 */
export function requireUpstreamObject(
    product: UpstreamProduct,
    value: unknown,
    description: string,
    // Atlassian DC payloads are version-dependent and only partly documented,
    // so what comes back out is parsed through deliberate `any`, as elsewhere
    // in the client layer.
): Record<string, any> {
    if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${product} returned an invalid ${description}: expected a JSON object, ` +
            `received ${describeUpstreamValue(value)}.`);
    }
    return value as Record<string, any>;
}

/**
 * Gate for a list the API is expected to return. A missing list is treated as
 * empty — a collection endpoint legitimately omits it when there is nothing to
 * report — but a present non-list is a broken response and is reported as one.
 */
export function requireUpstreamArray(
    product: UpstreamProduct,
    value: unknown,
    description: string,
): any[] {
    if (value === undefined || value === null)
        return [];
    if (!Array.isArray(value)) {
        throw new Error(`${product} returned an invalid ${description}: expected an array, ` +
            `received ${describeUpstreamValue(value)}.`);
    }
    return value;
}

/* ------------------------------------------------------------------ */
/* Typed readers                                                      */
/* ------------------------------------------------------------------ */

/**
 * Accessors for walking an upstream payload without `any`.
 *
 * The older clients in this repository parse Data Center responses through
 * deliberate `any`, which works but gives up every guarantee at the first
 * property access: a renamed field reads as `undefined` and a shape change
 * reads as a `TypeError` somewhere else entirely. These readers keep the
 * tolerance — an absent field is still just an absent field — while letting the
 * parsing code be written against `unknown`, so the compiler still checks what
 * is done with the value once it has been narrowed.
 *
 * Each takes a property path so a nested lookup stays one call:
 * `readString(issue, "fields", "status", "name")`.
 */

/** Narrows a value to a plain object, or undefined when it is anything else. */
export function asObject(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

/** Follows a property path, returning undefined as soon as it leaves an object. */
export function readPath(source: unknown, ...path: string[]): unknown {
    let current: unknown = source;
    for (const key of path) {
        const object = asObject(current);
        if (object === undefined) return undefined;
        current = object[key];
    }
    return current;
}

/** Reads a string, or "" when the field is absent or another type. */
export function readString(source: unknown, ...path: string[]): string {
    const value = readPath(source, ...path);
    return typeof value === "string" ? value : "";
}

/**
 * Reads an identifier as a string. Atlassian is inconsistent about whether an
 * ID arrives as a number or a string — sometimes within one payload — and a
 * caller that has to handle both is a caller that will get it wrong once.
 */
export function readId(source: unknown, ...path: string[]): string {
    const value = readPath(source, ...path);
    if (typeof value === "string") return value;
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    return "";
}

/** Reads a finite number, or null when the field is absent or another type. */
export function readNumber(source: unknown, ...path: string[]): number | null {
    const value = readPath(source, ...path);
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Reads a boolean strictly: only a literal `true` counts as true. */
export function readBoolean(source: unknown, ...path: string[]): boolean {
    return readPath(source, ...path) === true;
}

/** Reads an array, or [] when the field is absent or another type. */
export function readArray(source: unknown, ...path: string[]): unknown[] {
    const value = readPath(source, ...path);
    return Array.isArray(value) ? value : [];
}

/** First non-empty string among several candidate paths on the same source. */
export function readFirstString(source: unknown, paths: string[][]): string {
    for (const path of paths) {
        const value = readString(source, ...path);
        if (value !== "") return value;
    }
    return "";
}

/** Entries of an object-keyed map, or [] when the value is not an object. */
export function readEntries(source: unknown, ...path: string[]): [string, unknown][] {
    const object = asObject(readPath(source, ...path));
    return object === undefined ? [] : Object.entries(object);
}

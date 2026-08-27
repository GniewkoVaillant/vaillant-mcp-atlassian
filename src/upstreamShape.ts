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

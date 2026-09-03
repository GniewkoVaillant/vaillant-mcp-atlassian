/**
 * Bounded offset pagination for the Jira REST and Agile APIs.
 *
 * Both APIs answer with the same `{ startAt, maxResults, total, isLast, … }`
 * envelope, and Data Center deployments disagree about which of those fields
 * they actually send. The loop below was written for `JiraAgileClient`; the
 * changelog walk in `JiraClient` needs exactly the same guards, and the
 * unbounded copy it used instead issued thousands of requests against a server
 * that reported no `total`. One implementation, used by both.
 */
import { atlassianGet } from "./httpClient.js";
import { describeUpstreamValue } from "./upstreamShape.js";

export const DEFAULT_MAX_PAGINATION_PAGES = 10;

export type PaginationQuery = Record<string, string | number | boolean | undefined>;

/** Shared validation of the `maxPaginationPages` client option. */
export function resolveMaxPaginationPages(configured: number | undefined): number {
    const maxPaginationPages = configured ?? DEFAULT_MAX_PAGINATION_PAGES;
    if (!Number.isSafeInteger(maxPaginationPages) || maxPaginationPages <= 0) {
        throw new Error("maxPaginationPages must be a positive safe integer.");
    }
    return maxPaginationPages;
}

export interface JiraPaginationOptions {
    baseUrl: string;
    pat: string;
    /** Hard cap on upstream requests. A page budget, not a result budget. */
    maxPaginationPages: number;
    path: string;
    /** Which member of the envelope carries the rows. */
    itemProperty: "values" | "issues";
    maxResults: number;
    query?: PaginationQuery;
    /** Names the collection in every error message, e.g. `issue ABC-1 changelog`. */
    resourceName: string;
    /**
     * Stop once this many rows have been collected, and say so, instead of
     * walking to the end of the collection.
     *
     * Without it, a discovery call on a large instance is a walk over every row
     * that exists: a real deployment answered `jira_list_boards` with 2346
     * boards, which blew the page budget and turned a lookup into a hard error.
     * Stopping early is only safe because `hasMore` distinguishes "this is the
     * whole collection" from "this is the first N of it".
     */
    maxItems?: number;
}

export interface JiraPaginationResult {
    values: any[];
    /** True when rows remain: either the walk hit `maxItems` or the server said so. */
    hasMore: boolean;
    /** The server's own count, when it reported one. */
    total: number | null;
}

/**
 * Walks an offset-paginated Jira collection to its end — or to `maxItems` — or
 * fails saying why it could not. Caps upstream calls, rejects stalled,
 * empty-too-early and repeated pages, and never passes an incomplete collection
 * off as a complete one: a truncated board list or changelog is
 * indistinguishable from a real one once it is returned, so partial data is
 * either flagged through `hasMore` or reported as an error, never returned
 * silently.
 */
export async function fetchPaginatedJiraValues(
    options: JiraPaginationOptions,
): Promise<JiraPaginationResult> {
    const { itemProperty, maxPaginationPages, resourceName, maxItems } = options;
    const results: any[] = [];
    const seenPageSignatures = new Set<string>();
    let startAt = 0;
    let reportedTotal: number | null = null;

    for (let pageNumber = 1; pageNumber <= maxPaginationPages; pageNumber += 1) {
        const page = await atlassianGet({
            baseUrl: options.baseUrl,
            pat: options.pat,
            path: options.path,
            query: { startAt, maxResults: options.maxResults, ...options.query },
        });

        // An empty 200 body decodes to `undefined`, which every check below
        // would read as "no metadata, no rows, keep going".
        if (page === undefined || page === null || typeof page !== "object" || Array.isArray(page)) {
            throw new Error(
                `Jira ${resourceName} pagination returned an invalid page at startAt=${startAt}: ` +
                `expected an object with "${itemProperty}", received ${describeUpstreamValue(page)}.`,
            );
        }

        const rawValues = page[itemProperty];
        if (rawValues !== undefined && !Array.isArray(rawValues)) {
            throw new Error(
                `Jira ${resourceName} pagination returned an invalid ${itemProperty} page.`,
            );
        }
        const values: any[] = rawValues ?? [];

        if (page.startAt !== undefined && page.startAt !== startAt) {
            throw new Error(
                `Jira ${resourceName} pagination did not advance: requested startAt=${startAt}, ` +
                `but the server returned startAt=${String(page.startAt)}.`,
            );
        }

        const total = page.total;
        if (
            total !== undefined &&
            (!Number.isSafeInteger(total) || total < 0)
        ) {
            throw new Error(
                `Jira ${resourceName} pagination returned an invalid total.`,
            );
        }
        if (typeof total === "number") reportedTotal = total;

        if (values.length === 0) {
            if (page.isLast === false || (total !== undefined && startAt < total)) {
                throw new Error(
                    `Jira ${resourceName} pagination did not advance: an empty page was ` +
                    `returned at startAt=${startAt} before all results were retrieved.`,
                );
            }
            return { values: results, hasMore: false, total: reportedTotal };
        }

        const identifiers = values.map((value) => value?.id ?? value?.key);
        if (identifiers.every((identifier) =>
            typeof identifier === "string" || typeof identifier === "number"
        )) {
            const signature = JSON.stringify(identifiers);
            if (seenPageSignatures.has(signature)) {
                throw new Error(
                    `Jira ${resourceName} pagination returned a repeated page at ` +
                    `startAt=${startAt}; refusing to return duplicated or incomplete data.`,
                );
            }
            seenPageSignatures.add(signature);
        }

        results.push(...values);
        startAt += values.length;

        if (
            page.isLast === true ||
            (total !== undefined && startAt >= total)
        ) {
            return { values: results, hasMore: false, total: reportedTotal };
        }

        // Deliberate early stop: the caller asked for a window, not the whole
        // collection, and `hasMore` tells it which one it got.
        if (maxItems !== undefined && results.length >= maxItems) {
            return { values: results.slice(0, maxItems), hasMore: true, total: reportedTotal };
        }

        if (pageNumber === maxPaginationPages) {
            const totalHint = total === undefined ? "" : ` of ${total}`;
            throw new Error(
                `Jira ${resourceName} pagination stopped after the configured limit of ` +
                `${maxPaginationPages} pages (${results.length}${totalHint} results fetched). ` +
                `Data Center itself caps most collections near a thousand rows, so hitting ` +
                `this budget usually means the upstream is not signalling the end of the ` +
                `collection rather than that the data is genuinely longer. Narrow the query; ` +
                `raise ATLASSIAN_MAX_PAGINATION_PAGES only if you have confirmed the ` +
                `collection really is that long. Partial results were not returned.`,
            );
        }
    }

    // `resolveMaxPaginationPages` guarantees a positive page budget, so this
    // can only be reached if future changes break the pagination invariant.
    throw new Error(`Jira ${resourceName} pagination ended unexpectedly.`);
}

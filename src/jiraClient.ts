/**
 * Client for Jira Data Center REST API (v2), authenticating with a
 * Personal Access Token. Supports both read-only lookups and write
 * (mutating) operations such as creating/updating issues, commenting,
 * and transitioning issues between statuses.
 */
import { basename } from "node:path";
import {
    assertAttachmentPathAllowed,
    assertAttachmentSize,
    DEFAULT_MAX_ATTACHMENT_BYTES,
    readExistingAttachment,
    writeNewAttachment,
} from "./attachmentSecurity.js";
import { atlassianDelete, atlassianGet, atlassianGetBinary, atlassianPost, atlassianPostFormData, atlassianPut, AtlassianHttpError, } from "./httpClient.js";
import { decodeProformaDesign, formatProformaAnswer, getProformaChunkCount, getProformaJiraFieldId, } from "./proforma.js";
import { DEFAULT_CONCURRENCY, mapWithConcurrency } from "./concurrency.js";
import { fetchPaginatedJiraValues, resolveMaxPaginationPages } from "./jiraPagination.js";
import { describeUpstreamValue, requireUpstreamArray, requireUpstreamObject } from "./upstreamShape.js";

export interface ClientOptions {
    baseUrl: string;
    pat: string;
    /**
     * Absolute directories that attachment download/upload may touch. An empty
     * or omitted list disables filesystem access entirely, which is the safe
     * default: issue content is written by other people, so a crafted ticket
     * must not be able to talk the agent into reading arbitrary local files.
     */
    attachmentDirs?: string[];
    /** Maximum number of bytes accepted for attachment uploads and downloads. */
    maxAttachmentBytes?: number;
    /** Maximum number of pages fetched by any one automatically paginated call. */
    maxPaginationPages?: number;
}

const MAX_PROFORMA_CHUNKS = 25;

/**
 * How many ProForma forms getProformaFormsSummary reads in parallel.
 *
 * Each form can fan out into DEFAULT_CONCURRENCY (5) parallel chunk requests,
 * so the real in-flight count is this number times 5. The HTTP client accepts
 * 4 active plus 16 queued requests before it rejects with "queue is full", and
 * other tools share that pool, so 3 x 5 = 15 keeps the whole fan-out inside the
 * default budget with headroom instead of overrunning it at 5 x 5 = 25.
 */
const PROFORMA_FORM_CONCURRENCY = 3;

/**
 * Gate for the `fields` object Jira returns on an issue. The mapping code
 * indexes into it directly, so when a reverse proxy truncates the body or the
 * instance answers with an error envelope the resulting TypeError names neither
 * the issue nor the request - useless to an agent deciding what to do next.
 */
function requireIssueFields(issue: any, issueKey: string): Record<string, any> {
    const fields = issue?.fields;
    if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
        throw new Error(`Jira issue ${issueKey} response did not contain a "fields" object ` +
            `(received ${describeUpstreamValue(fields)}).`);
    }
    return fields;
}

/**
 * Gate for a list Jira is expected to return. A missing list is treated as
 * empty - matching how the Agile client tolerates an absent page - but a
 * present non-list is a broken response and is reported as one.
 */
function requireOptionalArray(value: unknown, description: string): any[] {
    return requireUpstreamArray("Jira", value, description);
}

/**
 * Gate for a response envelope Jira is expected to return. An empty 200 body -
 * what a reverse proxy, a DC-side timeout or an SSO login redirect produces -
 * decodes to `undefined`, and destructuring or indexing that yields a
 * TypeError naming neither the issue nor the request.
 */
function requireResponseObject(value: unknown, description: string): Record<string, any> {
    return requireUpstreamObject("Jira", value, description);
}

export interface JiraIssueSummary {
    key: string;
    summary: string;
    status: string;
    assignee: string;
    issueType: string;
    priority: string;
}

/** A page of search results, with enough metadata to detect truncation. */
export interface JiraIssueSearchResult {
    startAt: number;
    maxResults: number;
    returned: number;
    total: number;
    hasMore: boolean;
    nextStartAt: number | null;
    issues: JiraIssueSummary[];
}

export interface JiraIssueStoryPoints {
    key: string;
    summary: string;
    status: string;
    storyPoints: number | null;
}

export interface JiraCommentSummary {
    author: string;
    body: string;
    created: string;
    id?: string;
}

export interface JiraIssueDetails {
    key: string;
    summary: string;
    description: string;
    status: string;
    assignee: string;
    reporter: string;
    created: string;
    updated: string;
    /** Total comments on the issue, before any truncation. */
    commentTotal: number;
    /** True when older comments were omitted to bound the response size. */
    commentsTruncated: boolean;
    comments: JiraCommentSummary[];
}

export interface JiraProjectSummary {
    id: string;
    key: string;
    name: string;
    projectTypeKey: string;
    lead: string;
}

export interface JiraTransitionRequiredField {
    id: string;
    name: string;
    allowedValues: string[];
}

/** A transition available on an issue, plus what its screen demands. */
export interface JiraTransitionOption {
    id: string;
    name: string;
    toStatus: string;
    requiredFields: JiraTransitionRequiredField[];
}

export interface JiraAssignResult {
    issueKey: string;
    assignee: string | null;
}

export interface JiraIssueFieldValue {
    id: string;
    name: string;
    custom: boolean;
    value: any;
}

interface JiraFieldDefinition {
    id: string;
    name?: unknown;
    custom?: boolean;
}

export interface JiraProformaFormSummary {
    id: number;
    templateId: number | null;
    name: string;
    submitted: boolean;
    created: string;
    updated: string;
}

export interface JiraProformaAnswer {
    questionId: string;
    label: string;
    type: string;
    answer: string;
    rawAnswer: any;
    /**
     * Where this answer came from: the browser-only form state, or a Jira
     * field linked via the question's `jiraField` mapping. A meaningful
     * form-state answer always wins over a linked field (REQ-005).
     */
    source: "form-state" | "jira-field";
}

export interface JiraProformaForm extends JiraProformaFormSummary {
    status: string;
    answeredQuestions: number;
    totalQuestions: number;
    answers: JiraProformaAnswer[];
    /**
     * Caller-facing caveats about this read - currently just the open-form
     * notice that unsaved browser-only edits are invisible to the server API.
     * Empty for submitted forms.
     */
    warnings: string[];
}

export interface JiraAttachmentSummary {
    id: string;
    filename: string;
    author: string;
    created: string;
    size: number;
    mimeType: string;
    contentUrl: string;
    thumbnailUrl: string;
}

export interface JiraAttachmentDownloadResult {
    id: string;
    outputPath: string;
    bytesWritten: number;
    contentType: string;
}

export interface JiraDeleteAttachmentResult {
    id: string;
    deleted: boolean;
}

export interface JiraIssueLinkSummary {
    id: string;
    type: string;
    direction: string;
    description: string;
    issueKey: string;
    summary: string;
    status: string;
}

export interface JiraCreateIssueLinkResult {
    type: string;
    inwardIssueKey: string;
    outwardIssueKey: string;
}

export interface JiraDeleteIssueLinkResult {
    id: string;
    deleted: boolean;
}

export interface JiraCreateIssueOptions {
    projectKey: string;
    issueType: string;
    summary: string;
    description?: string;
    parentKey?: string;
    assignee?: string;
    priority?: string;
}

export interface JiraCreateIssueResult {
    key: string;
    id: string;
    url: string;
}

export interface JiraUpdateIssueOptions {
    summary?: string;
    description?: string;
    assignee?: string;
    priority?: string;
    labels?: string[];
    fields?: Record<string, any>;
}

export interface JiraUpdateIssueResult {
    key: string;
}

export interface JiraDeleteCommentResult {
    issueKey: string;
    commentId: string;
    deleted: boolean;
}

export interface JiraAddWorklogOptions {
    timeSpent: string;
    comment?: string;
    started?: string;
}

export interface JiraWorklogResult {
    id: string;
    issueKey: string;
    author: string;
    timeSpent: string;
    started: string;
    comment: string;
}

export interface JiraWorklogEntry extends JiraWorklogResult {
    timeSpentSeconds: number;
    created: string;
}

export interface JiraDeleteResult {
    id: string;
    deleted: boolean;
}

export interface JiraWatcher {
    name: string;
    displayName: string;
    active: boolean;
}

export interface JiraWatcherResult {
    issueKey: string;
    username: string;
    watching: boolean;
}

export interface JiraAddWorklogWithCategoryOptions {
    timeSpent: string;
    category: string;
    comment?: string;
    started?: string;
}

export interface JiraWorklogWithCategoryResult {
    status: string;
    message: string;
    issueKey: string;
    category: string;
    timeSpent: string;
}

export interface JiraTransitionResult {
    issueKey: string;
    transitionedTo: string;
}

export interface JiraStatusTransition {
    from: string;
    to: string;
    at: string;
    author: string;
}

export interface JiraIssueChangelog {
    key: string;
    transitions: JiraStatusTransition[];
}

export interface JiraIssueCycleTime {
    key: string;
    fromStatus: string;
    toStatus: string;
    fromStatusEnteredAt: string | null;
    toStatusEnteredAt: string | null;
    cycleTimeDays: number | null;
    note?: string;
}

export interface JiraDevBranch {
    name: string;
    url: string;
    repository: string;
}

export interface JiraDevPullRequest {
    id: string;
    name: string;
    status: string;
    url: string;
    author: string;
    commentCount: number;
    sourceBranch: string;
    destinationBranch: string;
    lastUpdate: string;
}

export interface JiraDevCommit {
    id: string;
    displayId: string;
    message: string;
    author: string;
    authorTimestamp: string;
    url: string;
    fileCount: number;
    coAuthors: string[];
}

export interface JiraIssueDevStatus {
    key: string;
    branches: JiraDevBranch[];
    pullRequests: JiraDevPullRequest[];
    commits: JiraDevCommit[];
    note?: string;
}
/**
 * Converts an ISO 8601 timestamp into the format Jira's worklog "started"
 * field requires: yyyy-MM-dd'T'HH:mm:ss.SSSZ with a timezone offset that has
 * no colon (e.g. "2024-01-01T10:00:00.000+0000").
 */
function toJiraWorklogStarted(isoTimestamp: string): string {
    const date = new Date(isoTimestamp);
    if (Number.isNaN(date.getTime())) {
        throw new Error(`Invalid started timestamp: ${isoTimestamp}`);
    }
    return date.toISOString().replace("Z", "+0000");
}
function userLabel(user: any): string {
    if (!user)
        return "Unassigned";
    return user.displayName || user.name || user.emailAddress || "Unknown";
}
function hasFieldValue(value: any): boolean {
    if (value === null || value === undefined || value === "")
        return false;
    if (Array.isArray(value))
        return value.length > 0;
    if (typeof value === "object")
        return Object.keys(value).length > 0;
    return true;
}
/** Extracts "Co-authored-by: Name <email>" trailers from a commit message body. */
function extractCoAuthors(message: string): string[] {
    const matches = message.matchAll(/^Co-authored-by:\s*(.+)$/gim);
    return Array.from(matches, (m: RegExpMatchArray) => m[1].trim());
}
/** Extracts status-field transitions from a list of changelog histories, appending them to `out`. */
function collectStatusTransitions(histories: any[], out: JiraStatusTransition[]): void {
    for (const history of histories) {
        // A history entry that is not an object is upstream noise, not a
        // transition; skipping it beats a TypeError from inside the mapper.
        const items = Array.isArray(history?.items) ? history.items : [];
        for (const item of items) {
            if (item?.field !== "status")
                continue;
            out.push({
                from: item.fromString || "",
                to: item.toString || "",
                at: history.created || "",
                author: userLabel(history.author),
            });
        }
    }
}
/**
 * Computes cycle time from a status-transition history.
 *
 * Takes the FIRST entry into `fromStatus` and the LAST entry into `toStatus`,
 * which is what you want when an issue is reopened and redone: the work spans
 * from when it first started to when it was finally finished.
 *
 * Split out from the client so it can be tested without a Jira instance.
 */
export function computeCycleTime(
    issueKey: string,
    transitions: JiraStatusTransition[],
    fromStatus: string,
    toStatus: string,
): JiraIssueCycleTime {
    const normalizedFrom = fromStatus.toLowerCase();
    const normalizedTo = toStatus.toLowerCase();
    const fromTransition = transitions.find((t) => t.to.toLowerCase() === normalizedFrom);
    const toTransitions = transitions.filter((t) => t.to.toLowerCase() === normalizedTo);
    const toTransition = toTransitions.length > 0 ? toTransitions[toTransitions.length - 1] : undefined;
    if (!fromTransition || !toTransition) {
        const missing = !fromTransition ? fromStatus : toStatus;
        return {
            key: issueKey,
            fromStatus,
            toStatus,
            fromStatusEnteredAt: fromTransition?.at || null,
            toStatusEnteredAt: toTransition?.at || null,
            cycleTimeDays: null,
            note: `Issue never transitioned to "${missing}".`,
        };
    }
    const fromMs = new Date(fromTransition.at).getTime();
    const toMs = new Date(toTransition.at).getTime();
    const cycleTimeDays = Math.round(((toMs - fromMs) / 86400000) * 10) / 10;
    return {
        key: issueKey,
        fromStatus,
        toStatus,
        fromStatusEnteredAt: fromTransition.at,
        toStatusEnteredAt: toTransition.at,
        cycleTimeDays,
    };
}

export class JiraClient {
    private readonly options: ClientOptions;
    /**
     * Jira's field catalogue is instance-wide, large, and changes only when an
     * admin edits a custom field — but get_issue_fields needs it on every call.
     * Cache it for the lifetime of a short TTL instead of refetching per call.
     */
    private fieldDefinitions: { fetchedAt: number; fields: Promise<unknown[]> } | null = null;
    private static readonly FIELD_CACHE_TTL_MS = 5 * 60 * 1000;
    /**
     * Page budget for the one collection this client walks itself, the
     * dedicated changelog endpoint. Same option, same default and same
     * validation as JiraAgileClient and ConfluenceClient.
     */
    private readonly maxPaginationPages: number;
    constructor(options: ClientOptions) {
        this.options = options;
        this.maxPaginationPages = resolveMaxPaginationPages(options.maxPaginationPages);
    }
    private async getFieldDefinitions(): Promise<unknown[]> {
        const cached = this.fieldDefinitions;
        if (cached && Date.now() - cached.fetchedAt < JiraClient.FIELD_CACHE_TTL_MS) {
            return cached.fields;
        }
        // Cache the in-flight promise rather than the result: the catalogue is
        // a few hundred kilobytes on a real instance, and N concurrent callers
        // on a cold cache would otherwise each fetch their own copy.
        const pending = (async (): Promise<unknown[]> => {
            const fields = await atlassianGet({
                baseUrl: this.options.baseUrl,
                pat: this.options.pat,
                path: "/rest/api/2/field",
            });
            if (fields === undefined || fields === null) {
                return [];
            }
            if (!Array.isArray(fields)) {
                throw new Error("Jira field catalogue (/rest/api/2/field) returned an invalid response: " +
                    `expected an array of field definitions, received ${describeUpstreamValue(fields)}.`);
            }
            return fields;
        })();
        const entry = { fetchedAt: Date.now(), fields: pending };
        this.fieldDefinitions = entry;
        // A failed fetch must not be cached: drop the entry so the next call
        // retries instead of replaying the same rejection for the whole TTL.
        pending.catch(() => {
            if (this.fieldDefinitions === entry) {
                this.fieldDefinitions = null;
            }
        });
        return pending;
    }
    async searchIssues(jql: string, maxResults = 20, startAt = 0): Promise<JiraIssueSearchResult> {
        const data = await atlassianGet({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path: "/rest/api/2/search",
            query: {
                jql,
                maxResults,
                startAt,
                fields: "summary,status,assignee,issuetype,priority",
            },
        });
        const issues: JiraIssueSummary[] = requireOptionalArray(data?.issues, "search result page")
            .map((issue: any) => {
            const fields = issue?.fields ?? {};
            return {
                key: issue?.key ?? "",
                summary: fields.summary || "",
                status: fields.status?.name || "Unknown",
                assignee: userLabel(fields.assignee),
                issueType: fields.issuetype?.name || "Unknown",
                priority: fields.priority?.name || "Unknown",
            };
        });
        const total = typeof data?.total === "number" ? data.total : startAt + issues.length;
        const nextStartAt = startAt + issues.length;
        const hasMore = issues.length > 0 && nextStartAt < total;
        // Reporting `total` and `hasMore` matters: without them a truncated
        // result set is indistinguishable from a complete one, and conclusions
        // get drawn from a partial answer.
        return {
            startAt,
            maxResults,
            returned: issues.length,
            total,
            hasMore,
            nextStartAt: hasMore ? nextStartAt : null,
            issues,
        };
    }
    /**
     * Fetches story points for a set of issues by key, given a specific
     * custom field ID (e.g. discovered via JiraAgileClient.getBoardStoryPointsField).
     * Works for both Kanban and Scrum boards, since it queries issues directly
     * via JQL rather than a sprint-scoped endpoint. Issue keys are quoted/escaped
     * for the JQL `key in (...)` clause.
     */
    async getIssuesStoryPoints(issueKeys: string[], storyPointsField: string): Promise<JiraIssueStoryPoints[]> {
        if (issueKeys.length === 0)
            return [];
        const jql = `key in (${issueKeys.map((key) => JSON.stringify(key)).join(",")})`;
        const data = await atlassianGet({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path: "/rest/api/2/search",
            query: {
                jql,
                maxResults: issueKeys.length,
                fields: `summary,status,${storyPointsField}`,
            },
        });
        return requireOptionalArray(data?.issues, "search result page").map((issue: any) => {
            const fields = issue?.fields ?? {};
            const raw = fields[storyPointsField];
            return {
                key: issue?.key ?? "",
                summary: fields.summary || "",
                status: fields.status?.name || "Unknown",
                storyPoints: typeof raw === "number" ? raw : null,
            };
        });
    }
    async getIssue(issueKey: string, maxComments = 30): Promise<JiraIssueDetails> {
        const issue = await atlassianGet({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path: `/rest/api/2/issue/${encodeURIComponent(issueKey)}`,
            query: {
                fields: "summary,description,status,assignee,reporter,created,updated,comment",
            },
        });
        const issueFields = requireIssueFields(issue, issueKey);
        const allComments = requireOptionalArray(issueFields.comment?.comments, `comment list on issue ${issueKey}`);
        // Long-lived issues can carry hundreds of comments. Return the most
        // recent ones and say how many were held back, rather than flooding
        // the context or silently pretending the tail does not exist.
        const kept = maxComments >= 0 && allComments.length > maxComments
            ? allComments.slice(-maxComments)
            : allComments;
        const comments = kept.map((c: any) => ({
            author: userLabel(c.author),
            body: c.body || "",
            created: c.created || "",
        }));
        return {
            key: issue.key || issueKey,
            summary: issueFields.summary || "",
            description: issueFields.description || "",
            status: issueFields.status?.name || "Unknown",
            assignee: userLabel(issueFields.assignee),
            reporter: userLabel(issueFields.reporter),
            created: issueFields.created || "",
            updated: issueFields.updated || "",
            commentTotal: allComments.length,
            commentsTruncated: allComments.length > comments.length,
            comments,
        };
    }
    /**
     * Lists the projects the PAT's owner can see. Without this there is no way
     * to discover a project key from inside the agent — it has to be known
     * up front.
     */
    async listProjects(query?: string, limit?: number): Promise<JiraProjectSummary[]> {
        const projects = await atlassianGet({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path: "/rest/api/2/project",
        });
        const normalized = query?.trim().toLowerCase();
        const matched = requireOptionalArray(projects, "project list")
            .map((project: any) => ({
                id: project?.id,
                key: typeof project?.key === "string" ? project.key : "",
                name: project?.name || "",
                projectTypeKey: project?.projectTypeKey || "",
                lead: project?.lead?.displayName || project?.lead?.name || "",
            }))
            .filter((project: JiraProjectSummary) =>
                !normalized ||
                project.key.toLowerCase().includes(normalized) ||
                project.name.toLowerCase().includes(normalized));
        // A Data Center instance routinely carries hundreds of projects, and
        // this is the only listing tool without a ceiling: without a limit the
        // caller has no way to ask for a smaller answer.
        return typeof limit === "number" && Number.isFinite(limit) && limit >= 0
            ? matched.slice(0, Math.floor(limit))
            : matched;
    }
    /**
     * Lists the transitions currently available on an issue, including which
     * fields each transition screen requires. Calling this before
     * transitionIssue is the difference between a clean transition and a
     * "Field 'resolution' is required" failure.
     */
    async getTransitions(issueKey: string): Promise<JiraTransitionOption[]> {
        const response = requireResponseObject(await atlassianGet({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path: `/rest/api/2/issue/${encodeURIComponent(issueKey)}/transitions`,
            query: { expand: "transitions.fields" },
        }), `transition list response for issue ${issueKey}`);
        const transitions = requireOptionalArray(response.transitions, `transition list on issue ${issueKey}`);
        return transitions.map((transition: any) => {
            const fields = transition.fields || {};
            return {
                id: transition.id,
                name: transition.name || "",
                toStatus: transition.to?.name || "",
                requiredFields: Object.entries(fields)
                    .filter(([, meta]: [string, any]) => meta?.required === true)
                    .map(([fieldId, meta]: [string, any]) => ({
                        id: fieldId,
                        name: meta?.name || fieldId,
                        allowedValues: Array.isArray(meta?.allowedValues)
                            ? meta.allowedValues
                                .map((value: any) => value?.name || value?.value || value?.id)
                                .filter((value: any) => typeof value === "string")
                            : [],
                    })),
            };
        });
    }
    /**
     * Assigns an issue to a user, or unassigns it when `assignee` is null.
     */
    async assignIssue(issueKey: string, assignee: string | null): Promise<JiraAssignResult> {
        await atlassianPut({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path: `/rest/api/2/issue/${encodeURIComponent(issueKey)}/assignee`,
            body: { name: assignee },
        });
        return { issueKey, assignee };
    }
    async getIssueFields(issueKey: string, fieldNames: string[] = [], includeEmpty = false): Promise<JiraIssueFieldValue[]> {
        const definitions = await this.getFieldDefinitions();
        // Field entries without a usable id cannot be requested or read back,
        // and a missing `name` must not take the whole lookup down with it.
        const usable = definitions.filter(
            (field): field is JiraFieldDefinition =>
                typeof field === "object" && field !== null && "id" in field && typeof field.id === "string",
        );
        const byId = new Map(usable.map((field) => [field.id, field]));
        const requested = new Set(fieldNames.map((name) => name.toLocaleLowerCase()));

        // `selectedIds` is only set for the named-field path, where the query
        // string stays short. When no names are given we ask Jira for every
        // field via the constant-length negative selector below instead of
        // concatenating the whole instance-wide catalogue into the URL - some
        // Data Center instances carry thousands of custom fields, and that
        // concatenation produced request URLs long enough to be rejected
        // upstream.
        let selectedIds: string[] | null = null;
        if (requested.size > 0) {
            const matched = usable.filter((field) => requested.has(field.id.toLocaleLowerCase()) ||
                requested.has(String(field.name ?? "").toLocaleLowerCase()));
            if (matched.length === 0) {
                throw new Error(`No Jira fields matched: ${fieldNames.join(", ")}`);
            }
            selectedIds = matched.map((field) => field.id);
        }

        const issue = await atlassianGet({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path: `/rest/api/2/issue/${encodeURIComponent(issueKey)}`,
            query: { fields: selectedIds ? selectedIds.join(",") : "*all,-attachment,-comment,-worklog" },
        });
        const issueFields = requireIssueFields(issue, issueKey);
        // For the *all path, the candidate list comes from what Jira actually
        // returned rather than from the local catalogue, so a field missing
        // from `getFieldDefinitions()` (a lag between the two endpoints)
        // still surfaces instead of silently vanishing; the exclusion is
        // reasserted defensively in case a Data Center version ignores the
        // negative selector.
        const candidateIds = selectedIds ??
            Object.keys(issueFields).filter((id) => id !== "attachment" && id !== "comment" && id !== "worklog");
        return candidateIds
            .map((id) => byId.get(id) ?? { id, name: id, custom: false })
            .filter((field: any) => includeEmpty || hasFieldValue(issueFields[field.id]))
            .map((field: any) => ({
            id: field.id,
            name: typeof field.name === "string" && field.name ? field.name : field.id,
            custom: field.custom === true,
            value: issueFields[field.id],
        }))
            .sort((left: JiraIssueFieldValue, right: JiraIssueFieldValue) => left.name.localeCompare(right.name));
    }
    async listProformaForms(issueKey: string): Promise<JiraProformaFormSummary[]> {
        let index;
        try {
            index = await this.getIssueProperty(issueKey, "proforma.forms");
        }
        catch (error) {
            if (error instanceof AtlassianHttpError && error.status === 404)
                return [];
            throw error;
        }
        // Data Center returns {"key":…,"value":null} for a property that was
        // cleared but not deleted, so a null index is a real answer here - it
        // just is not a form index, and saying so beats a bare TypeError.
        if (index === undefined || index === null) {
            throw new Error(`Issue property "proforma.forms" on ${issueKey} holds no value ` +
                `(received ${describeUpstreamValue(index)}); the property exists but was cleared.`);
        }
        if (typeof index !== "object" || Array.isArray(index)) {
            throw new Error(`Issue property "proforma.forms" on ${issueKey} is not a ProForma form index ` +
                `(received ${describeUpstreamValue(index)}).`);
        }
        return requireOptionalArray(index.forms, `ProForma form index on issue ${issueKey}`)
            .map((form: any) => ({
            id: form?.id,
            templateId: form?.templateId ?? null,
            name: form?.name?.trim() || `Form ${form?.id}`,
            submitted: form?.submitted === true,
            created: form?.created || "",
            updated: form?.updated || "",
        }));
    }
    /**
     * Reads one ProForma form. `knownMetadata` lets a caller that already holds
     * the form index - see getProformaFormsSummary - skip re-fetching it; the
     * three-argument call used by the jira_get_proforma_form tool is unchanged.
     */
    async getProformaForm(
        issueKey: string,
        formId: number,
        includeEmpty = false,
        knownMetadata?: JiraProformaFormSummary,
    ): Promise<JiraProformaForm> {
        const metadata = knownMetadata && knownMetadata.id === formId
            ? knownMetadata
            : (await this.listProformaForms(issueKey)).find((form: JiraProformaFormSummary) => form.id === formId);
        if (!metadata) {
            throw new Error(`ProForma form ${formId} was not found on issue ${issueKey}`);
        }
        const propertyKey = `proforma.forms.i${formId}`;
        const root = await this.getIssueProperty(issueKey, propertyKey);
        if (!root || typeof root !== "object" || Array.isArray(root)) {
            throw new Error(`ProForma form ${formId} ("${metadata.name}") on issue ${issueKey} stores no usable ` +
                `data in issue property "${propertyKey}" (received ${describeUpstreamValue(root)}).`);
        }
        const chunkCount = getProformaChunkCount(root);
        if (chunkCount > MAX_PROFORMA_CHUNKS) {
            throw new Error(
                `ProForma form ${formId} declares ${chunkCount} chunks, exceeding the ` +
                    `${MAX_PROFORMA_CHUNKS}-chunk safety limit.`,
            );
        }
        const additionalChunks = await mapWithConcurrency(
            Array.from({ length: Math.max(0, chunkCount - 1) }, (_, index) => index + 1),
            DEFAULT_CONCURRENCY,
            (index) => this.getIssueProperty(issueKey, `${propertyKey}.${index}`),
        );
        const design = decodeProformaDesign(root, additionalChunks);
        const questions: Record<string, any> = design?.questions && typeof design.questions === "object" && !Array.isArray(design.questions)
            ? design.questions
            : {};
        const stateAnswers = root.state?.answers ?? {};
        if (typeof stateAnswers !== "object" || Array.isArray(stateAnswers)) {
            throw new Error(`ProForma form ${formId} ("${metadata.name}") on issue ${issueKey} returned invalid ` +
                `answers in "${propertyKey}": expected an object, received ${describeUpstreamValue(stateAnswers)}.`);
        }
        const rawStatus = root.state?.status;
        const status = rawStatus === "s"
            ? "submitted"
            : rawStatus === "o"
                ? "open"
                : rawStatus || (metadata.submitted ? "submitted" : "open");

        const hasMeaningfulStateAnswer = (questionId: string): boolean =>
            Object.prototype.hasOwnProperty.call(stateAnswers, questionId) &&
            formatProformaAnswer(stateAnswers[questionId], questions[questionId]) !== "";

        // Questions mapped to a Jira field (`design.questions[id].jiraField`)
        // can carry a value already persisted on the issue even when the
        // browser-only form state has no meaningful answer for them yet, or
        // omits the question entirely. Never resolve a question the form
        // state already answers meaningfully (REQ-005).
        const jiraFieldByQuestion = new Map<string, string>();
        for (const [questionId, question] of Object.entries(questions)) {
            if (hasMeaningfulStateAnswer(questionId))
                continue;
            const fieldId = getProformaJiraFieldId(question);
            if (fieldId)
                jiraFieldByQuestion.set(questionId, fieldId);
        }

        let linkedFieldValues = new Map<string, any>();
        if (jiraFieldByQuestion.size > 0) {
            const uniqueFieldIds = Array.from(new Set(jiraFieldByQuestion.values()));
            let linkedFields: JiraIssueFieldValue[];
            try {
                linkedFields = await this.getIssueFields(issueKey, uniqueFieldIds, true);
            }
            catch (error) {
                const cause = error instanceof Error ? error.message : String(error);
                throw new Error(`ProForma form ${formId} ("${metadata.name}") on issue ${issueKey} could not ` +
                    `resolve linked Jira field(s) ${uniqueFieldIds.join(", ")}: ${cause}`);
            }
            linkedFieldValues = new Map(linkedFields.map((field) => [field.id, field.value]));
        }

        // The merged question set is every question the form state answers
        // plus every question resolved above - a superset of `stateAnswers`'
        // keys whenever a Jira-backed question is absent from form state
        // entirely (REQ-004). `totalQuestions` below follows this set rather
        // than `stateAnswers` alone so the count stays accurate once linked
        // answers are merged in.
        const questionIds = new Set<string>([...Object.keys(stateAnswers), ...jiraFieldByQuestion.keys()]);
        const answers = Array.from(questionIds)
            .map((questionId) => {
            const question = questions[questionId];
            const label = question?.label?.trim() || `Question ${questionId}`;
            const type = question?.type || "unknown";
            const fieldId = jiraFieldByQuestion.get(questionId);
            if (fieldId !== undefined) {
                const fieldValue = linkedFieldValues.get(fieldId);
                if (hasFieldValue(fieldValue)) {
                    return {
                        questionId,
                        label,
                        type,
                        answer: formatProformaAnswer(fieldValue, question),
                        rawAnswer: fieldValue,
                        source: "jira-field" as const,
                    };
                }
            }
            const rawAnswer = stateAnswers[questionId];
            return {
                questionId,
                label,
                type,
                answer: formatProformaAnswer(rawAnswer, question),
                rawAnswer,
                source: "form-state" as const,
            };
        })
            .filter((answer) => includeEmpty || answer.answer !== "");
        // Open forms can still change in the browser before the person saves;
        // a server-side read can never see those unsaved edits (CON-002), so
        // every open-form read carries that caveat explicitly instead of
        // silently looking complete.
        const warnings: string[] = status === "open"
            ? ["Open form: unsaved browser-only changes are not visible through Jira server APIs."]
            : [];
        return {
            ...metadata,
            status,
            answeredQuestions: answers.filter((answer) => answer.answer !== "").length,
            totalQuestions: questionIds.size > 0 ? questionIds.size : Object.keys(questions).length,
            answers,
            warnings,
        };
    }
    async getProformaFormsSummary(issueKey: string, includeEmpty = false): Promise<JiraProformaForm[]> {
        const forms = await this.listProformaForms(issueKey);
        // Hand each worker the metadata we already hold: getProformaForm would
        // otherwise re-read the whole proforma.forms index once per form (N+1).
        // The reduced outer width keeps the nested chunk fan-out inside the
        // shared HTTP budget - see PROFORMA_FORM_CONCURRENCY.
        return mapWithConcurrency(
            forms,
            PROFORMA_FORM_CONCURRENCY,
            (form: JiraProformaFormSummary) => this.getProformaForm(issueKey, form.id, includeEmpty, form),
        );
    }
    async listAttachments(issueKey: string): Promise<JiraAttachmentSummary[]> {
        const issue = await atlassianGet({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path: `/rest/api/2/issue/${encodeURIComponent(issueKey)}`,
            query: { fields: "attachment" },
        });
        const issueFields = requireIssueFields(issue, issueKey);
        return requireOptionalArray(issueFields.attachment, `attachment list on issue ${issueKey}`)
            .map((attachment: any) => ({
            id: attachment.id,
            filename: attachment.filename || `attachment-${attachment.id}`,
            author: userLabel(attachment.author),
            created: attachment.created || "",
            size: attachment.size || 0,
            mimeType: attachment.mimeType || "application/octet-stream",
            contentUrl: attachment.content || "",
            thumbnailUrl: attachment.thumbnail || "",
        }));
    }
    async downloadAttachment(attachmentId: string, outputPath: string): Promise<JiraAttachmentDownloadResult> {
        const safeOutputPath = await assertAttachmentPathAllowed(this.options, outputPath, "outputPath");
        const metadata = await atlassianGet({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path: `/rest/api/2/attachment/${encodeURIComponent(attachmentId)}`,
        });
        if (!metadata.content) {
            throw new Error(`Jira attachment ${attachmentId} has no content URL`);
        }
        if (typeof metadata.size === "number") {
            assertAttachmentSize(this.options, metadata.size, "declared size");
        }
        const response = await atlassianGetBinary({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path: metadata.content,
            maxResponseBytes: this.options.maxAttachmentBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES,
        });
        assertAttachmentSize(this.options, response.data.byteLength, "download size");
        await writeNewAttachment(this.options, safeOutputPath, response.data);
        return {
            id: attachmentId,
            outputPath: safeOutputPath,
            bytesWritten: response.data.byteLength,
            contentType: response.contentType,
        };
    }
    async uploadAttachment(issueKey: string, filePath: string, mimeType = "application/octet-stream"): Promise<JiraAttachmentSummary[]> {
        const { path: safeFilePath, data } = await readExistingAttachment(this.options, filePath);
        const form = new FormData();
        form.append("file", new Blob([data], { type: mimeType }), basename(safeFilePath));
        const uploaded = await atlassianPostFormData({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path: `/rest/api/2/issue/${encodeURIComponent(issueKey)}/attachments`,
            body: form,
        });
        return uploaded.map((attachment: any) => ({
            id: attachment.id,
            filename: attachment.filename || basename(safeFilePath),
            author: userLabel(attachment.author),
            created: attachment.created || "",
            size: attachment.size || data.byteLength,
            mimeType: attachment.mimeType || mimeType,
            contentUrl: attachment.content || "",
            thumbnailUrl: attachment.thumbnail || "",
        }));
    }
    async deleteAttachment(attachmentId: string): Promise<JiraDeleteAttachmentResult> {
        await atlassianDelete({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path: `/rest/api/2/attachment/${encodeURIComponent(attachmentId)}`,
        });
        return { id: attachmentId, deleted: true };
    }
    async listIssueLinkTypes(): Promise<any[]> {
        const response = await atlassianGet({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path: "/rest/api/2/issueLinkType",
        });
        return requireOptionalArray(response?.issueLinkTypes, "issue link type list");
    }
    async getIssueLinks(issueKey: string): Promise<JiraIssueLinkSummary[]> {
        const issue = await atlassianGet({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path: `/rest/api/2/issue/${encodeURIComponent(issueKey)}`,
            query: { fields: "issuelinks" },
        });
        const issueFields = requireIssueFields(issue, issueKey);
        return requireOptionalArray(issueFields.issuelinks, `issue link list on issue ${issueKey}`)
            .map((link: any) => {
            const direction = link?.outwardIssue ? "outward" : "inward";
            const linkedIssue = link?.outwardIssue || link?.inwardIssue;
            return {
                id: link?.id,
                type: link?.type?.name || "",
                direction,
                description: (direction === "outward" ? link?.type?.outward : link?.type?.inward) || "",
                issueKey: linkedIssue?.key || "",
                summary: linkedIssue?.fields?.summary || "",
                status: linkedIssue?.fields?.status?.name || "Unknown",
            };
        });
    }
    async createIssueLink(linkType: string, inwardIssueKey: string, outwardIssueKey: string, comment?: string): Promise<JiraCreateIssueLinkResult> {
        await atlassianPost({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path: "/rest/api/2/issueLink",
            body: {
                type: { name: linkType },
                inwardIssue: { key: inwardIssueKey },
                outwardIssue: { key: outwardIssueKey },
                comment: comment ? { body: comment } : undefined,
            },
        });
        return { type: linkType, inwardIssueKey, outwardIssueKey };
    }
    async deleteIssueLink(linkId: string): Promise<JiraDeleteIssueLinkResult> {
        await atlassianDelete({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path: `/rest/api/2/issueLink/${encodeURIComponent(linkId)}`,
        });
        return { id: linkId, deleted: true };
    }
    async getIssueProperty(issueKey: string, propertyKey: string): Promise<any> {
        const property = await atlassianGet({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path: `/rest/api/2/issue/${encodeURIComponent(issueKey)}/properties/${encodeURIComponent(propertyKey)}`,
        });
        // Jira answers with {"key":…,"value":…}. An empty 200 body - a reverse
        // proxy dropping the payload, or a DC-side timeout - has to be named as
        // such instead of surfacing as "Cannot read properties of undefined".
        if (!property || typeof property !== "object" || Array.isArray(property)) {
            throw new Error(`Jira returned an unusable response for issue property "${propertyKey}" on ` +
                `${issueKey}: expected an object with a "value", received ${describeUpstreamValue(property)}.`);
        }
        if (!("value" in property)) {
            throw new Error(`Jira response for issue property "${propertyKey}" on ${issueKey} contains ` +
                `no "value" field.`);
        }
        return property.value;
    }
    /**
     * Creates a new Jira issue (or sub-task, when `parentKey` is given).
     * Mutates data: POST /rest/api/2/issue.
     */
    async createIssue(options: JiraCreateIssueOptions): Promise<JiraCreateIssueResult> {
        const fields: Record<string, any> = {
            project: { key: options.projectKey },
            issuetype: { name: options.issueType },
            summary: options.summary,
        };
        if (options.description !== undefined) {
            fields.description = options.description;
        }
        if (options.parentKey) {
            fields.parent = { key: options.parentKey };
        }
        if (options.assignee) {
            fields.assignee = { name: options.assignee };
        }
        if (options.priority) {
            fields.priority = { name: options.priority };
        }
        const created = await atlassianPost({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path: "/rest/api/2/issue",
            body: { fields },
        });
        return {
            key: created.key,
            id: created.id,
            url: `${this.options.baseUrl}/browse/${created.key}`,
        };
    }
    /**
     * Updates fields on an existing Jira issue. Named params cover the common
     * fields; pass `fields` for anything else. Mutates data: PUT
     * /rest/api/2/issue/{issueKey}.
     */
    async updateIssue(issueKey: string, options: JiraUpdateIssueOptions): Promise<JiraUpdateIssueResult> {
        const fields = { ...(options.fields || {}) };
        if (options.summary !== undefined) {
            fields.summary = options.summary;
        }
        if (options.description !== undefined) {
            fields.description = options.description;
        }
        if (options.assignee !== undefined) {
            fields.assignee = { name: options.assignee };
        }
        if (options.priority !== undefined) {
            fields.priority = { name: options.priority };
        }
        if (options.labels !== undefined) {
            fields.labels = options.labels;
        }
        await atlassianPut({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path: `/rest/api/2/issue/${encodeURIComponent(issueKey)}`,
            body: { fields },
        });
        return { key: issueKey };
    }
    /**
     * Adds a comment to an existing Jira issue. Mutates data: POST
     * /rest/api/2/issue/{issueKey}/comment.
     */
    async addComment(issueKey: string, body: string): Promise<JiraCommentSummary> {
        const comment = await atlassianPost({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path: `/rest/api/2/issue/${encodeURIComponent(issueKey)}/comment`,
            body: { body },
        });
        return {
            id: comment.id,
            author: userLabel(comment.author),
            body: comment.body || "",
            created: comment.created || "",
        };
    }
    /**
     * Edits an existing comment on a Jira issue. Mutates data: PUT
     * /rest/api/2/issue/{issueKey}/comment/{commentId}.
     *
     * Note: Jira typically only allows editing your own comments unless you
     * hold administrator/project-admin permissions to edit others' comments.
     */
    async editComment(issueKey: string, commentId: string, body: string): Promise<JiraCommentSummary> {
        const comment = await atlassianPut({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path: `/rest/api/2/issue/${encodeURIComponent(issueKey)}/comment/${encodeURIComponent(commentId)}`,
            body: { body },
        });
        return {
            id: comment.id,
            author: userLabel(comment.author),
            body: comment.body || "",
            created: comment.created || "",
        };
    }
    /**
     * Deletes an existing comment from a Jira issue. Mutates data: DELETE
     * /rest/api/2/issue/{issueKey}/comment/{commentId}. This cannot be undone.
     *
     * Note: Jira typically only allows deleting your own comments unless you
     * hold administrator/project-admin permissions to delete others' comments.
     */
    async deleteComment(issueKey: string, commentId: string): Promise<JiraDeleteCommentResult> {
        await atlassianDelete({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path: `/rest/api/2/issue/${encodeURIComponent(issueKey)}/comment/${encodeURIComponent(commentId)}`,
        });
        return { issueKey, commentId, deleted: true };
    }
    /**
     * Logs work against an existing Jira issue. Mutates data: POST
     * /rest/api/2/issue/{issueKey}/worklog.
     */
    /**
     * Lists worklogs on an issue. Needed to see what has already been logged
     * before adding more, and to find the id of an entry to delete.
     */
    async listWorklogs(issueKey: string): Promise<JiraWorklogEntry[]> {
        const response = requireResponseObject(await atlassianGet({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path: `/rest/api/2/issue/${encodeURIComponent(issueKey)}/worklog`,
        }), `worklog list response for issue ${issueKey}`);
        return requireOptionalArray(response.worklogs, `worklog list on issue ${issueKey}`)
            .map((worklog: any) => ({
            id: worklog.id,
            issueKey,
            author: userLabel(worklog.author),
            timeSpent: worklog.timeSpent || "",
            timeSpentSeconds: worklog.timeSpentSeconds ?? 0,
            started: worklog.started || "",
            created: worklog.created || "",
            comment: worklog.comment || "",
        }));
    }
    /**
     * Permanently deletes a worklog entry. Jira normally restricts this to
     * your own worklogs unless you hold project-admin rights.
     */
    async deleteWorklog(issueKey: string, worklogId: string): Promise<JiraDeleteResult> {
        await atlassianDelete({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path: `/rest/api/2/issue/${encodeURIComponent(issueKey)}/worklog/${encodeURIComponent(worklogId)}`,
        });
        return { id: worklogId, deleted: true };
    }
    /** Lists the users watching an issue. */
    async listWatchers(issueKey: string): Promise<JiraWatcher[]> {
        const response = requireResponseObject(await atlassianGet({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path: `/rest/api/2/issue/${encodeURIComponent(issueKey)}/watchers`,
        }), `watcher list response for issue ${issueKey}`);
        return requireOptionalArray(response.watchers, `watcher list on issue ${issueKey}`)
            .map((watcher: any) => ({
            name: watcher.name || "",
            displayName: watcher.displayName || watcher.name || "Unknown",
            active: watcher.active !== false,
        }));
    }
    /**
     * Adds a watcher. Jira expects the bare username as a JSON string body
     * here, not an object — an unusual shape for this API.
     */
    async addWatcher(issueKey: string, username: string): Promise<JiraWatcherResult> {
        await atlassianPost({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path: `/rest/api/2/issue/${encodeURIComponent(issueKey)}/watchers`,
            body: username,
        });
        return { issueKey, username, watching: true };
    }
    async removeWatcher(issueKey: string, username: string): Promise<JiraWatcherResult> {
        await atlassianDelete({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path: `/rest/api/2/issue/${encodeURIComponent(issueKey)}/watchers`,
            query: { username },
        });
        return { issueKey, username, watching: false };
    }
    async addWorklog(issueKey: string, options: JiraAddWorklogOptions): Promise<JiraWorklogResult> {
        const body: Record<string, any> = { timeSpent: options.timeSpent };
        if (options.comment !== undefined) {
            body.comment = options.comment;
        }
        if (options.started !== undefined) {
            body.started = toJiraWorklogStarted(options.started);
        }
        const worklog = await atlassianPost({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path: `/rest/api/2/issue/${encodeURIComponent(issueKey)}/worklog`,
            body,
        });
        return {
            id: worklog.id,
            issueKey,
            author: userLabel(worklog.author),
            timeSpent: worklog.timeSpent || options.timeSpent,
            started: worklog.started || "",
            comment: worklog.comment || options.comment || "",
        };
    }
    /**
     * Logs work against an existing Jira issue through the vaillant-timetracking
     * plugin's own REST endpoint (POST /rest/timetracking/1.0/worklog/create)
     * instead of Jira's built-in worklog API. Unlike addWorklog(), this creates a
     * WorklogExtension record with a work category (e.g. "cat1", "cat2") so the
     * entry appears correctly in the plugin's timesheet/approval workflow.
     *
     * Note: this always creates the worklog with internal status "TRACKED". The
     * plugin exposes no REST endpoint to transition it to "SUBMITTED" — that step
     * still requires the Jira UI (the underlying servlet action relies on a
     * browser session/CSRF token, not PAT auth).
     */
    async addWorklogWithCategory(issueKey: string, options: JiraAddWorklogWithCategoryOptions): Promise<JiraWorklogWithCategoryResult> {
        const userName = await this.getCurrentUsername();
        const body: Record<string, any> = {
            userName,
            issueKey,
            timeSpent: options.timeSpent,
            category: options.category,
        };
        if (options.comment !== undefined) {
            body.description = options.comment;
        }
        if (options.started !== undefined) {
            body.startTime = new Date(options.started).getTime();
        }
        const result = await atlassianPost({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path: "/rest/timetracking/1.0/worklog/create",
            body,
        });
        return {
            status: result.status,
            message: result.message,
            issueKey,
            category: options.category,
            timeSpent: options.timeSpent,
        };
    }
    /**
     * Resolves the username of the PAT's owning account via
     * GET /rest/api/2/myself, used to populate the vaillant-timetracking
     * plugin's worklog "userName" field.
     */
    async getCurrentUsername(): Promise<string> {
        const me = await atlassianGet({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path: "/rest/api/2/myself",
        });
        if (!me.name) {
            throw new Error("Could not resolve current user's username from /rest/api/2/myself");
        }
        return me.name;
    }
    /**
     * Transitions an issue to a new status by name (case-insensitive match
     * against the issue's available transitions). Mutates data: GET
     * /rest/api/2/issue/{issueKey}/transitions to discover the transition id,
     * then POST the chosen transition.
     */
    async transitionIssue(
        issueKey: string,
        targetStatusName: string,
        extraFields?: Record<string, unknown>,
    ): Promise<JiraTransitionResult> {
        const { transitions } = await atlassianGet({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path: `/rest/api/2/issue/${encodeURIComponent(issueKey)}/transitions`,
            query: { expand: "transitions.fields" },
        });
        const normalizedTarget = targetStatusName.trim().toLowerCase();
        const available = transitions || [];
        // Prefer the destination status, then the transition's own name. Doing
        // it in that order matters when a transition is named differently from
        // the status it leads to ("Start Progress" -> "In Progress").
        const match =
            available.find((t: any) => (t.to?.name || "").toLowerCase() === normalizedTarget) ??
            available.find((t: any) => (t.name || "").toLowerCase() === normalizedTarget);
        if (!match) {
            const options = available
                .map((t: any) => `"${t.name}" -> "${t.to?.name || "?"}"`)
                .join(", ") || "(none)";
            throw new Error(`No transition to status "${targetStatusName}" is available for ${issueKey}. ` +
                `Available transitions: ${options}`);
        }

        const fields: Record<string, unknown> = { ...(extraFields || {}) };

        // Transition screens frequently mark resolution as required, and Jira
        // rejects the whole transition if it is missing. Surface that as a
        // precise, actionable error instead of a raw 400.
        const requiredFieldIds = Object.entries(match.fields || {})
            .filter(([, meta]: [string, any]) => meta?.required === true)
            .map(([fieldId]) => fieldId);
        const missing = requiredFieldIds.filter((fieldId) => !(fieldId in fields));
        if (missing.length > 0) {
            const detail = missing
                .map((fieldId) => {
                    const meta: any = match.fields[fieldId];
                    const allowed = Array.isArray(meta?.allowedValues)
                        ? meta.allowedValues
                            .map((value: any) => value?.name || value?.value || value?.id)
                            .filter((value: any) => typeof value === "string")
                        : [];
                    const name = meta?.name || fieldId;
                    return allowed.length > 0
                        ? `${fieldId} (${name}; one of: ${allowed.join(", ")})`
                        : `${fieldId} (${name})`;
                })
                .join(", ");
            throw new Error(
                `Transition "${match.name}" on ${issueKey} requires field(s) that were not supplied: ${detail}. ` +
                    `Pass them via the "fields" argument, e.g. {"resolution":{"name":"Done"}}.`,
            );
        }

        await atlassianPost({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path: `/rest/api/2/issue/${encodeURIComponent(issueKey)}/transitions`,
            body: Object.keys(fields).length > 0
                ? { transition: { id: match.id }, fields }
                : { transition: { id: match.id } },
        });
        return { issueKey, transitionedTo: match.to?.name || match.name };
    }
    /**
     * Fetches an issue's full status-change history. Prefers the dedicated,
     * paginated changelog endpoint (GET /rest/api/2/issue/{key}/changelog),
     * which pages through the complete history so issues with long histories
     * are handled correctly. Some Jira Data Center versions don't expose that
     * endpoint (it 404s); in that case, falls back to the `expand=changelog`
     * param on the regular get-issue endpoint, which is universally supported
     * but caps the embedded history at ~100 entries (a known limitation of
     * the fallback path only). Returns only the status-field transitions,
     * sorted ascending by timestamp.
     */
    async getIssueChangelog(issueKey: string): Promise<JiraIssueChangelog> {
        try {
            return await this.getIssueChangelogViaDedicatedEndpoint(issueKey);
        }
        catch (error) {
            if (error instanceof AtlassianHttpError && error.status === 404) {
                return await this.getIssueChangelogViaExpand(issueKey);
            }
            throw error;
        }
    }
    /**
     * Walks the dedicated changelog endpoint through the shared, bounded Jira
     * pagination helper.
     *
     * This loop used to be hand-rolled and `while (true)`: its three exit
     * conditions all depended on metadata the server may simply omit, so a
     * page with rows, no `isLast` and no `total` compared `startAt >= undefined`
     * (always false) and it hammered the instance until the process died. The
     * helper caps the number of upstream requests, rejects a `startAt` that
     * does not advance and a page that repeats, and refuses to hand back a
     * partial history - an issue's status timeline missing its middle is worse
     * than an error, because nothing downstream can tell it is incomplete.
     */
    async getIssueChangelogViaDedicatedEndpoint(issueKey: string): Promise<JiraIssueChangelog> {
        const histories = await fetchPaginatedJiraValues({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            maxPaginationPages: this.maxPaginationPages,
            path: `/rest/api/2/issue/${encodeURIComponent(issueKey)}/changelog`,
            itemProperty: "values",
            maxResults: 100,
            resourceName: `issue ${issueKey} changelog`,
        });
        const transitions: JiraStatusTransition[] = [];
        collectStatusTransitions(histories, transitions);
        transitions.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
        return { key: issueKey, transitions };
    }
    /**
     * Fallback used when the dedicated changelog endpoint isn't available on
     * this Jira Data Center version. Uses `expand=changelog` on the regular
     * get-issue endpoint. Note: this embeds only the changelog's first page
     * (~100 histories), so very long-lived issues may be missing older
     * transitions.
     */
    async getIssueChangelogViaExpand(issueKey: string): Promise<JiraIssueChangelog> {
        const issue = await atlassianGet({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path: `/rest/api/2/issue/${encodeURIComponent(issueKey)}`,
            query: { expand: "changelog", fields: "summary" },
        });
        const transitions: JiraStatusTransition[] = [];
        collectStatusTransitions(
            requireOptionalArray(issue?.changelog?.histories, `changelog history on issue ${issueKey}`),
            transitions,
        );
        transitions.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
        return { key: issueKey, transitions };
    }
    /**
     * Computes the number of days between an issue first entering `fromStatus`
     * and its last entry into `toStatus` (case-insensitive), using real
     * status-transition history rather than created/updated proxy dates. If
     * either status was never entered, returns `cycleTimeDays: null` with an
     * explanatory `note` instead of throwing.
     */
    async getIssueCycleTime(issueKey: string, fromStatus: string, toStatus: string): Promise<JiraIssueCycleTime> {
        const { transitions } = await this.getIssueChangelog(issueKey);
        return computeCycleTime(issueKey, transitions, fromStatus, toStatus);
    }
    /**
     * Batch-friendly wrapper for computing cycle time across many issues in
     * one MCP round-trip. Individual failures (e.g. issue not found) are
     * caught and reported as a null-result entry rather than failing the
     * whole batch.
     */
    async getIssuesCycleTime(issueKeys: string[], fromStatus: string, toStatus: string): Promise<JiraIssueCycleTime[]> {
        return mapWithConcurrency(issueKeys, DEFAULT_CONCURRENCY, async (issueKey: string) => {
            try {
                return await this.getIssueCycleTime(issueKey, fromStatus, toStatus);
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                return {
                    key: issueKey,
                    fromStatus,
                    toStatus,
                    fromStatusEnteredAt: null,
                    toStatusEnteredAt: null,
                    cycleTimeDays: null,
                    note: message,
                };
            }
        });
    }
    /**
     * Fetches an issue's Jira "Development" panel data: linked GitHub branches,
     * pull requests, and commits (with full messages, so callers can detect
     * `Co-authored-by:` trailers, e.g. from GitHub Copilot). This is a more
     * reliable link between a Jira issue and its code changes than text-matching
     * ticket keys against commit messages, since it's Jira's own smart-commit /
     * branch-naming integration rather than a heuristic.
     *
     * Uses GET /rest/dev-status/latest/issue/detail, which requires the issue's
     * internal numeric id (not its key), so this first resolves that id via a
     * lightweight get-issue call. Issues with no linked dev activity return
     * empty arrays rather than an error.
     */
    async getIssueDevStatus(issueKey: string): Promise<JiraIssueDevStatus> {
        const issue = await atlassianGet({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path: `/rest/api/2/issue/${encodeURIComponent(issueKey)}`,
            query: { fields: "summary" },
        });
        const [pullRequestResponse, repositoryResponse] = await Promise.all([
            atlassianGet({
                baseUrl: this.options.baseUrl,
                pat: this.options.pat,
                path: "/rest/dev-status/latest/issue/detail",
                query: { issueId: issue.id, applicationType: "github", dataType: "pullrequest" },
            }),
            atlassianGet({
                baseUrl: this.options.baseUrl,
                pat: this.options.pat,
                path: "/rest/dev-status/latest/issue/detail",
                query: { issueId: issue.id, applicationType: "github", dataType: "repository" },
            }),
        ]);
        const branches: JiraDevBranch[] = [];
        const pullRequests: JiraDevPullRequest[] = [];
        const commits: JiraDevCommit[] = [];
        for (const detail of pullRequestResponse.detail || []) {
            for (const branch of detail.branches || []) {
                branches.push({
                    name: branch.name || "",
                    url: branch.url || "",
                    repository: branch.repository?.name || "",
                });
            }
            for (const pr of detail.pullRequests || []) {
                pullRequests.push({
                    id: pr.id || "",
                    name: pr.name || "",
                    status: pr.status || "",
                    url: pr.url || "",
                    author: pr.author?.name || "",
                    commentCount: pr.commentCount ?? 0,
                    sourceBranch: pr.source?.branch || "",
                    destinationBranch: pr.destination?.branch || "",
                    lastUpdate: pr.lastUpdate || "",
                });
            }
        }
        for (const detail of repositoryResponse.detail || []) {
            for (const repo of detail.repositories || []) {
                for (const commit of repo.commits || []) {
                    const message = commit.message || "";
                    commits.push({
                        id: commit.id || "",
                        displayId: commit.displayId || "",
                        message,
                        author: commit.author?.name || "",
                        authorTimestamp: commit.authorTimestamp || "",
                        url: commit.url || "",
                        fileCount: commit.fileCount ?? 0,
                        coAuthors: extractCoAuthors(message),
                    });
                }
            }
        }
        return { key: issueKey, branches, pullRequests, commits };
    }
    /**
     * Batch-friendly wrapper for fetching dev status across many issues in one
     * MCP round-trip. Individual failures (e.g. issue not found) are caught
     * and reported as an empty-result entry with a `note`, rather than failing
     * the whole batch.
     */
    async getIssuesDevStatus(issueKeys: string[]): Promise<JiraIssueDevStatus[]> {
        return mapWithConcurrency(issueKeys, DEFAULT_CONCURRENCY, async (issueKey: string) => {
            try {
                return await this.getIssueDevStatus(issueKey);
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                return { key: issueKey, branches: [], pullRequests: [], commits: [], note: message };
            }
        });
    }
}

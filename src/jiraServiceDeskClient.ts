/**
 * Client for Jira Service Management Data Center (`/rest/servicedeskapi`).
 *
 * A service desk request is a Jira issue, so the existing tools could already
 * read one — but only as an issue. The customer-facing half (request type,
 * queue, SLA clock, approval decision) lives behind this separate API and was
 * entirely invisible: "is this ticket breaching" and "who still has to approve"
 * could not be answered at all.
 *
 * Several of these endpoints are marked experimental on Data Center and refuse
 * the request without an opt-in header, so every call here carries it. The
 * header only opts into the API surface; it grants no additional permission.
 */
import { atlassianGet, atlassianPost } from "./httpClient.js";
import { requireUpstreamArray, requireUpstreamObject } from "./upstreamShape.js";

export interface JiraServiceDeskClientOptions {
    baseUrl: string;
    pat: string;
}

/** Data Center refuses experimental servicedeskapi resources without this. */
const EXPERIMENTAL_HEADERS = { "X-ExperimentalApi": "opt-in" };

const MAX_SERVICE_DESK_RESULTS = 50;

function clampLimit(limit: number | undefined, fallback = 25): number {
    if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) return fallback;
    return Math.min(Math.floor(limit), MAX_SERVICE_DESK_RESULTS);
}

function requireArray(value: unknown, description: string): any[] {
    return requireUpstreamArray("Jira", value, description);
}

function requireObject(value: unknown, description: string): Record<string, any> {
    return requireUpstreamObject("Jira", value, description);
}

export interface ServiceDeskSummary {
    id: string;
    projectKey: string;
    projectName: string;
}

export interface ServiceDeskRequestType {
    id: string;
    name: string;
    description: string;
    /** Group headings the portal shows this type under. */
    groupIds: string[];
}

export interface ServiceDeskRequestSummary {
    issueKey: string;
    requestTypeName: string;
    serviceDeskId: string;
    status: string;
    reporter: string;
    createdDate: string;
    url: string;
}

export interface ServiceDeskQueue {
    id: string;
    name: string;
    issueCount: number | null;
}

export interface ServiceDeskSla {
    name: string;
    /** True while the clock is running. */
    ongoing: boolean;
    breached: boolean;
    remainingTime: string;
    goalDuration: string;
}

export interface ServiceDeskApproval {
    id: string;
    name: string;
    state: string;
    canAnswer: boolean;
    approvers: { name: string; decision: string }[];
}

export interface ServiceDeskComment {
    id: string;
    author: string;
    body: string;
    public: boolean;
    created: string;
}

export class JiraServiceDeskClient {
    private readonly options: JiraServiceDeskClientOptions;

    constructor(options: JiraServiceDeskClientOptions) {
        this.options = options;
    }

    private get<T = any>(path: string, query?: Record<string, string | number | boolean | undefined>): Promise<T> {
        return atlassianGet<T>({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path,
            query,
            headers: EXPERIMENTAL_HEADERS,
        });
    }

    private post<T = any>(path: string, body: unknown): Promise<T> {
        return atlassianPost<T>({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path,
            body,
            headers: EXPERIMENTAL_HEADERS,
        });
    }

    /** Service desks the caller can see, with the Jira project each belongs to. */
    async listServiceDesks(limit?: number): Promise<ServiceDeskSummary[]> {
        const response = requireObject(
            await this.get("/rest/servicedeskapi/servicedesk", { limit: clampLimit(limit) }),
            "service desk list response",
        );
        return requireArray(response.values, "service desk list").map((desk: any) => ({
            id: String(desk?.id ?? ""),
            projectKey: desk?.projectKey || "",
            projectName: desk?.projectName || "",
        }));
    }

    /**
     * Request types available on a service desk. Creating a request is
     * impossible without one of these IDs, and they are per-desk, so this is a
     * mandatory lookup rather than a convenience.
     */
    async listRequestTypes(serviceDeskId: string, limit?: number): Promise<ServiceDeskRequestType[]> {
        const response = requireObject(
            await this.get(
                `/rest/servicedeskapi/servicedesk/${encodeURIComponent(serviceDeskId)}/requesttype`,
                { limit: clampLimit(limit) },
            ),
            `request type list response for service desk ${serviceDeskId}`,
        );
        return requireArray(response.values, `request type list for service desk ${serviceDeskId}`)
            .map((type: any) => ({
                id: String(type?.id ?? ""),
                name: type?.name || "",
                description: type?.description || "",
                groupIds: requireArray(type?.groupIds, "request type group list").map(String),
            }));
    }

    /** The fields one request type requires, so a create call can be composed correctly. */
    async getRequestTypeFields(serviceDeskId: string, requestTypeId: string): Promise<{
        fieldId: string;
        name: string;
        required: boolean;
        jiraSchemaType: string;
        validValues: string[];
    }[]> {
        const response = requireObject(
            await this.get(
                `/rest/servicedeskapi/servicedesk/${encodeURIComponent(serviceDeskId)}` +
                `/requesttype/${encodeURIComponent(requestTypeId)}/field`,
            ),
            `request type field response for ${serviceDeskId}/${requestTypeId}`,
        );
        return requireArray(response.requestTypeFields, "request type field list").map((field: any) => ({
            fieldId: field?.fieldId || "",
            name: field?.name || "",
            required: field?.required === true,
            jiraSchemaType: field?.jiraSchema?.type || "",
            validValues: requireArray(field?.validValues, "request type field value list")
                .map((value: any) => value?.label || value?.value || "")
                .filter((label: string) => label !== ""),
        }));
    }

    async listRequests(options: {
        serviceDeskId?: string;
        requestStatus?: "OPEN_REQUESTS" | "CLOSED_REQUESTS" | "ALL_REQUESTS";
        requestOwnership?: "OWNED_REQUESTS" | "PARTICIPATED_REQUESTS" | "ALL_REQUESTS";
        limit?: number;
    } = {}): Promise<ServiceDeskRequestSummary[]> {
        const response = requireObject(
            await this.get("/rest/servicedeskapi/request", {
                serviceDeskId: options.serviceDeskId,
                requestStatus: options.requestStatus,
                requestOwnership: options.requestOwnership,
                limit: clampLimit(options.limit),
                expand: "status",
            }),
            "request list response",
        );
        return requireArray(response.values, "request list").map((request) => this.toRequestSummary(request));
    }

    async getRequest(issueKey: string): Promise<ServiceDeskRequestSummary> {
        const request = requireObject(
            await this.get(`/rest/servicedeskapi/request/${encodeURIComponent(issueKey)}`, { expand: "status" }),
            `request response for ${issueKey}`,
        );
        return this.toRequestSummary(request);
    }

    /** Agent queues on a service desk, with the backlog size each represents. */
    async listQueues(serviceDeskId: string, limit?: number): Promise<ServiceDeskQueue[]> {
        const response = requireObject(
            await this.get(
                `/rest/servicedeskapi/servicedesk/${encodeURIComponent(serviceDeskId)}/queue`,
                { includeCount: true, limit: clampLimit(limit) },
            ),
            `queue list response for service desk ${serviceDeskId}`,
        );
        return requireArray(response.values, `queue list for service desk ${serviceDeskId}`).map((queue: any) => ({
            id: String(queue?.id ?? ""),
            name: queue?.name || "",
            issueCount: typeof queue?.issueCount === "number" ? queue.issueCount : null,
        }));
    }

    /**
     * SLA clocks on a request. This is the only place the breach state lives —
     * it is not a Jira field, so no JQL query or issue read can surface it.
     */
    async getRequestSla(issueKey: string): Promise<ServiceDeskSla[]> {
        const response = requireObject(
            await this.get(`/rest/servicedeskapi/request/${encodeURIComponent(issueKey)}/sla`),
            `SLA response for request ${issueKey}`,
        );
        return requireArray(response.values, `SLA list for request ${issueKey}`).map((sla: any) => {
            const ongoing = sla?.ongoingCycle;
            const completed = requireArray(sla?.completedCycles, "completed SLA cycle list");
            const latest = completed[completed.length - 1];
            return {
                name: sla?.name || "",
                ongoing: Boolean(ongoing),
                breached: (ongoing?.breached ?? latest?.breached) === true,
                remainingTime: ongoing?.remainingTime?.friendly || "",
                goalDuration: (ongoing?.goalDuration ?? latest?.goalDuration)?.friendly || "",
            };
        });
    }

    async listApprovals(issueKey: string): Promise<ServiceDeskApproval[]> {
        const response = requireObject(
            await this.get(`/rest/servicedeskapi/request/${encodeURIComponent(issueKey)}/approval`),
            `approval response for request ${issueKey}`,
        );
        return requireArray(response.values, `approval list for request ${issueKey}`).map((approval: any) => ({
            id: String(approval?.id ?? ""),
            name: approval?.name || "",
            state: approval?.finalDecision || "pending",
            canAnswer: approval?.canAnswerApproval === true,
            approvers: requireArray(approval?.approvers, "approver list").map((approver: any) => ({
                name: approver?.approver?.name || approver?.approver?.displayName || "",
                decision: approver?.approverDecision || "pending",
            })),
        }));
    }

    async listRequestComments(issueKey: string, options: { publicOnly?: boolean; limit?: number } = {}): Promise<ServiceDeskComment[]> {
        const response = requireObject(
            await this.get(`/rest/servicedeskapi/request/${encodeURIComponent(issueKey)}/comment`, {
                public: options.publicOnly === true ? true : undefined,
                internal: options.publicOnly === true ? false : undefined,
                limit: clampLimit(options.limit),
            }),
            `comment response for request ${issueKey}`,
        );
        return requireArray(response.values, `comment list for request ${issueKey}`).map((comment: any) => ({
            id: String(comment?.id ?? ""),
            author: comment?.author?.displayName || comment?.author?.name || "",
            body: comment?.body || "",
            public: comment?.public === true,
            created: comment?.created?.jiraRestDateTimeFormat || comment?.created?.iso8601 || "",
        }));
    }

    /**
     * Raises a customer request. Mutates data: POST /rest/servicedeskapi/request.
     * `requestFieldValues` is passed through unmodified because required fields
     * are per request type — call `getRequestTypeFields` first rather than
     * guessing at the shape.
     */
    async createRequest(options: {
        serviceDeskId: string;
        requestTypeId: string;
        summary: string;
        description?: string;
        requestFieldValues?: Record<string, unknown>;
        raiseOnBehalfOf?: string;
    }): Promise<ServiceDeskRequestSummary> {
        const created = requireObject(
            await this.post("/rest/servicedeskapi/request", {
                serviceDeskId: options.serviceDeskId,
                requestTypeId: options.requestTypeId,
                raiseOnBehalfOf: options.raiseOnBehalfOf,
                requestFieldValues: {
                    summary: options.summary,
                    ...(options.description !== undefined ? { description: options.description } : {}),
                    ...(options.requestFieldValues || {}),
                },
            }),
            "request creation response",
        );
        return this.toRequestSummary(created);
    }

    /**
     * Adds a comment to a request. `isPublic` is required rather than defaulted:
     * a public comment is emailed to the customer and an internal one is not,
     * and defaulting either way silently makes a disclosure decision.
     */
    async addRequestComment(issueKey: string, body: string, isPublic: boolean): Promise<ServiceDeskComment> {
        const created = requireObject(
            await this.post(`/rest/servicedeskapi/request/${encodeURIComponent(issueKey)}/comment`, {
                body,
                public: isPublic,
            }),
            `comment creation response for request ${issueKey}`,
        );
        return {
            id: String(created.id ?? ""),
            author: created.author?.displayName || created.author?.name || "",
            body: created.body || body,
            public: created.public === true,
            created: created.created?.jiraRestDateTimeFormat || created.created?.iso8601 || "",
        };
    }

    /** Records an approve/decline decision on a request's pending approval. */
    async answerApproval(issueKey: string, approvalId: string, decision: "approve" | "decline"): Promise<{
        issueKey: string;
        approvalId: string;
        decision: string;
        state: string;
    }> {
        const answered = requireObject(
            await this.post(
                `/rest/servicedeskapi/request/${encodeURIComponent(issueKey)}` +
                `/approval/${encodeURIComponent(approvalId)}`,
                { decision },
            ),
            `approval response for request ${issueKey}`,
        );
        return {
            issueKey,
            approvalId,
            decision,
            state: answered.finalDecision || "",
        };
    }

    private toRequestSummary(request: any): ServiceDeskRequestSummary {
        const issueKey = request?.issueKey || "";
        return {
            issueKey,
            requestTypeName: request?.requestType?.name || "",
            serviceDeskId: String(request?.serviceDeskId ?? request?.serviceDesk?.id ?? ""),
            status: request?.currentStatus?.status || "",
            reporter: request?.reporter?.displayName || request?.reporter?.name || "",
            createdDate: request?.createdDate?.jiraRestDateTimeFormat || request?.createdDate?.iso8601 || "",
            url: issueKey ? `${this.options.baseUrl}/browse/${issueKey}` : "",
        };
    }
}

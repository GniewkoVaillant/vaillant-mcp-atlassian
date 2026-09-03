/**
 * Registers the Jira Service Management tools.
 *
 * A service desk request is a Jira issue, so the core tools could already read
 * one — but only as an issue. Request type, queue, SLA clock and approval state
 * live behind the separate servicedeskapi and were invisible, which made "is
 * this breaching" and "who still has to approve" unanswerable.
 *
 * The customer-visibility boundary is the thing to get right here: a public
 * comment is emailed to the reporter, an internal one is not.
 */
import { z } from "zod";
import type { JiraServiceDeskClient } from "../jiraServiceDeskClient.js";
import {
    issueKeySchema,
    jiraIdSchema,
    runTool,
    textFieldSchema,
    titleFieldSchema,
    type ToolRegistrar,
} from "./shared.js";

export function registerJiraServiceDeskTools(tool: ToolRegistrar, client: JiraServiceDeskClient): void {
    tool("servicedesk", "read", "jsm_list_service_desks", {
        title: "List Jira service desks",
        description: "List the Jira Service Management service desks visible to the current user, with " +
            "the Jira project each belongs to. The service desk ID is required by almost every other " +
            "jsm_* tool. Read-only.",
        inputSchema: {
            limit: z.number().int().positive().max(50).optional()
                .describe("Maximum service desks to return (default 25, hard cap 50)"),
        },
    }, async ({ limit }) => runTool("jsm_list_service_desks", () => client.listServiceDesks(limit)));

    tool("servicedesk", "read", "jsm_list_request_types", {
        title: "List service desk request types",
        description: "List the request types a service desk offers. A request type ID is mandatory for " +
            "jsm_create_request and the types are per-desk, so this is a required lookup rather than a " +
            "convenience. Read-only.",
        inputSchema: {
            serviceDeskId: jiraIdSchema.describe("Service desk ID from jsm_list_service_desks"),
            limit: z.number().int().positive().max(50).optional()
                .describe("Maximum request types to return (default 25, hard cap 50)"),
        },
    }, async ({ serviceDeskId, limit }) =>
        runTool("jsm_list_request_types", () => client.listRequestTypes(serviceDeskId, limit)));

    tool("servicedesk", "read", "jsm_get_request_type_fields", {
        title: "Get service desk request type fields",
        description: "Get the fields one request type requires, with their valid values. Call this " +
            "before jsm_create_request: required fields vary per request type, and a missing one is " +
            "rejected with a message that names the field ID rather than what to send. Read-only.",
        inputSchema: {
            serviceDeskId: jiraIdSchema.describe("Service desk ID from jsm_list_service_desks"),
            requestTypeId: jiraIdSchema.describe("Request type ID from jsm_list_request_types"),
        },
    }, async ({ serviceDeskId, requestTypeId }) =>
        runTool("jsm_get_request_type_fields", () =>
            client.getRequestTypeFields(serviceDeskId, requestTypeId)));

    tool("servicedesk", "read", "jsm_list_requests", {
        title: "List service desk requests",
        description: "List customer requests, optionally scoped to one service desk and filtered by open/" +
            "closed state or by whether the current user raised or participates in them. Read-only.",
        inputSchema: {
            serviceDeskId: jiraIdSchema.optional().describe("Limit to one service desk"),
            requestStatus: z.enum(["OPEN_REQUESTS", "CLOSED_REQUESTS", "ALL_REQUESTS"]).optional()
                .describe("Filter by request state"),
            requestOwnership: z.enum(["OWNED_REQUESTS", "PARTICIPATED_REQUESTS", "ALL_REQUESTS"]).optional()
                .describe("Filter by the current user's relationship to the request"),
            limit: z.number().int().positive().max(50).optional()
                .describe("Maximum requests to return (default 25, hard cap 50)"),
        },
    }, async (args) => runTool("jsm_list_requests", () => client.listRequests(args)));

    tool("servicedesk", "read", "jsm_get_request", {
        title: "Get a service desk request",
        description: "Get one customer request by its issue key, with its request type, reporter and " +
            "current portal status. Use jira_get_issue for the underlying Jira fields. Read-only.",
        inputSchema: {
            issueKey: issueKeySchema.describe("Request's issue key, e.g. 'SUP-123'"),
        },
    }, async ({ issueKey }) => runTool("jsm_get_request", () => client.getRequest(issueKey)));

    tool("servicedesk", "read", "jsm_list_queues", {
        title: "List service desk queues",
        description: "List a service desk's agent queues with the number of issues waiting in each. " +
            "Read-only.",
        inputSchema: {
            serviceDeskId: jiraIdSchema.describe("Service desk ID from jsm_list_service_desks"),
            limit: z.number().int().positive().max(50).optional()
                .describe("Maximum queues to return (default 25, hard cap 50)"),
        },
    }, async ({ serviceDeskId, limit }) =>
        runTool("jsm_list_queues", () => client.listQueues(serviceDeskId, limit)));

    tool("servicedesk", "read", "jsm_get_request_sla", {
        title: "Get service desk request SLAs",
        description:
            "Get the SLA clocks on a request: whether each is running, whether it has breached, the " +
            "time remaining and the goal. This is the only place breach state exists — it is not a Jira " +
            "field, so no JQL query or jira_get_issue call can surface it. Read-only.",
        inputSchema: {
            issueKey: issueKeySchema.describe("Request's issue key, e.g. 'SUP-123'"),
        },
    }, async ({ issueKey }) => runTool("jsm_get_request_sla", () => client.getRequestSla(issueKey)));

    tool("servicedesk", "read", "jsm_list_approvals", {
        title: "List service desk approvals",
        description: "List a request's approvals, each approver's decision, and whether the current user " +
            "may answer. Read-only.",
        inputSchema: {
            issueKey: issueKeySchema.describe("Request's issue key, e.g. 'SUP-123'"),
        },
    }, async ({ issueKey }) => runTool("jsm_list_approvals", () => client.listApprovals(issueKey)));

    tool("servicedesk", "read", "jsm_list_request_comments", {
        title: "List service desk request comments",
        description: "List a request's comments, each marked public (visible to the customer in the " +
            "portal) or internal (agents only). Read-only.",
        inputSchema: {
            issueKey: issueKeySchema.describe("Request's issue key, e.g. 'SUP-123'"),
            publicOnly: z.boolean().optional()
                .describe("Return only customer-visible comments, excluding internal agent notes"),
            limit: z.number().int().positive().max(50).optional()
                .describe("Maximum comments to return (default 25, hard cap 50)"),
        },
    }, async ({ issueKey, publicOnly, limit }) =>
        runTool("jsm_list_request_comments", () => client.listRequestComments(issueKey, { publicOnly, limit })));

    tool("servicedesk", "write", "jsm_create_request", {
        title: "Raise a service desk request",
        description:
            "Raise a customer request on a service desk. Mutates data: creates a real ticket, starts its " +
            "SLA clocks and normally sends the reporter a confirmation email. Call " +
            "jsm_get_request_type_fields first — required fields differ per request type. " +
            "`raiseOnBehalfOf` files the request as another person, so use it only when that is " +
            "explicitly intended.",
        inputSchema: {
            serviceDeskId: jiraIdSchema.describe("Service desk ID from jsm_list_service_desks"),
            requestTypeId: jiraIdSchema.describe("Request type ID from jsm_list_request_types"),
            summary: titleFieldSchema.describe("Request summary"),
            description: textFieldSchema.optional().describe("Request description"),
            requestFieldValues: z.record(z.string(), z.unknown()).optional()
                .describe("Additional field values keyed by field ID, per jsm_get_request_type_fields"),
            raiseOnBehalfOf: z.string().max(255).optional()
                .describe("Username to raise the request for, instead of the token's own account"),
        },
    }, async (args) => runTool("jsm_create_request", () => client.createRequest(args)));

    tool("servicedesk", "write", "jsm_add_request_comment", {
        title: "Comment on a service desk request",
        description:
            "Add a comment to a customer request. Mutates data. `isPublic` is required and has no " +
            "default on purpose: a public comment appears in the customer portal and is normally emailed " +
            "to the reporter, while an internal one stays between agents. Choosing wrongly either leaks " +
            "an internal note to a customer or hides an answer they were waiting for, and a posted " +
            "comment cannot be unsent.",
        inputSchema: {
            issueKey: issueKeySchema.describe("Request's issue key, e.g. 'SUP-123'"),
            body: textFieldSchema.describe("Comment text"),
            isPublic: z.boolean()
                .describe("True = visible to the customer and usually emailed; false = internal agent note"),
        },
    }, async ({ issueKey, body, isPublic }) =>
        runTool("jsm_add_request_comment", () => client.addRequestComment(issueKey, body, isPublic)));

    tool("servicedesk", "write", "jsm_answer_approval", {
        title: "Answer a service desk approval",
        description:
            "Approve or decline a pending approval on a request. Mutates data and records a decision " +
            "attributed to the account behind the configured token — this is that person's approval, " +
            "and it usually advances the request's workflow. It cannot be retracted through this API. " +
            "Check jsm_list_approvals for `canAnswer` first.",
        inputSchema: {
            issueKey: issueKeySchema.describe("Request's issue key, e.g. 'SUP-123'"),
            approvalId: jiraIdSchema.describe("Approval ID from jsm_list_approvals"),
            decision: z.enum(["approve", "decline"]).describe("The decision to record"),
        },
    }, async ({ issueKey, approvalId, decision }) =>
        runTool("jsm_answer_approval", () => client.answerApproval(issueKey, approvalId, decision)));
}

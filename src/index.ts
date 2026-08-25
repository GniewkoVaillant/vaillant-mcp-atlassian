#!/usr/bin/env node
/**
 * MCP server that connects Copilot (or any MCP client) to an on-prem Jira
 * Data Center and Confluence Data Center instance, using Personal Access
 * Tokens for authentication. Supports both read-only lookups (search, get)
 * and write operations that mutate data (create/update issues, comment,
 * transition issues, create/update Confluence pages) — write tools are
 * clearly marked as mutating in their descriptions.
 *
 * Transport: stdio.
 */
import { McpServer, type ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { loadConfig, type ToolGroup } from "./config.js";
import { JiraClient } from "./jiraClient.js";
import { JiraAgileClient } from "./jiraAgileClient.js";
import { ConfluenceClient } from "./confluenceClient.js";
import { AtlassianHttpError, configureHttp } from "./httpClient.js";
/** Formats any thrown error into a concise, user-facing message string. */
function formatError(error: unknown): string {
    if (error instanceof AtlassianHttpError) {
        return error.message;
    }
    if (error instanceof Error) {
        return error.message;
    }
    return String(error);
}
/**
 * How a tool affects the world, used to derive MCP annotations:
 *  - "read"        never modifies anything
 *  - "write"       creates or updates, and is reversible
 *  - "destructive" removes data or is otherwise hard to undo
 * "local" additionally marks tools that touch the local filesystem rather
 * than (or as well as) the remote Atlassian instance.
 */
type ToolKind = "read" | "write" | "destructive" | "local";
async function main() {
    const config = loadConfig();
    configureHttp({ timeoutMs: config.timeoutMs });
    const jiraClient = new JiraClient({
        baseUrl: config.jiraBaseUrl,
        pat: config.jiraPat,
        attachmentDirs: config.attachmentDirs,
    });
    const jiraAgileClient = new JiraAgileClient({ baseUrl: config.jiraBaseUrl, pat: config.jiraPat });
    const confluenceClient = new ConfluenceClient({
        baseUrl: config.confluenceBaseUrl,
        pat: config.confluencePat,
    });
    const server = new McpServer({
        name: "mcp-atlassian",
        version: "1.1.0",
    });
    const registered: string[] = [];
    /**
     * Registers a tool, but only when its group is enabled by the active
     * profile and — for mutating tools — when the server is not in read-only
     * mode. Attaches MCP annotations so clients can tell a lookup apart from a
     * deletion without parsing the prose description.
     */
    function tool<InputArgs extends z.ZodRawShape>(
        group: ToolGroup,
        kind: ToolKind,
        name: string,
        spec: {
            title?: string;
            description?: string;
            inputSchema?: InputArgs;
            annotations?: ToolAnnotations;
        },
        handler: ToolCallback<InputArgs>,
    ): void {
        if (!config.enabledGroups.has(group)) return;
        if (config.readOnly && kind !== "read") return;
        server.registerTool<z.ZodRawShape, InputArgs>(
            name,
            {
                ...spec,
                annotations: {
                    ...spec.annotations,
                    readOnlyHint: kind === "read",
                    destructiveHint: kind === "destructive",
                    // Re-running a read or a delete converges on the same state;
                    // re-running a create does not.
                    idempotentHint: kind === "read" || kind === "destructive",
                    openWorldHint: kind !== "local",
                },
            },
            handler,
        );
        registered.push(name);
    }
    tool("core", "read", "jira_search_issues", {
        title: "Search Jira issues",
        description: "Search Jira Data Center issues using JQL (Jira Query Language). " +
            "Returns key, summary, status, assignee, issue type, and priority for each matching issue, " +
            "plus pagination metadata: `total` is the full match count, and when `hasMore` is true you " +
            "must call again with `startAt: nextStartAt` to see the rest — do not treat a truncated " +
            "page as the complete answer. Read-only.",
        inputSchema: {
            jql: z.string().describe("JQL query string, e.g. 'project = ABC AND status = Open'"),
            maxResults: z
                .number()
                .int()
                .positive()
                .max(100)
                .optional()
                .describe("Maximum number of results per page (default 20, max 100)"),
            startAt: z
                .number()
                .int()
                .min(0)
                .optional()
                .describe("Zero-based index of the first result to return; pass `nextStartAt` from a previous call"),
        },
    }, async ({ jql, maxResults, startAt }) => {
        try {
            const results = await jiraClient.searchIssues(jql, maxResults ?? 20, startAt ?? 0);
            return {
                content: [
                    {
                        type: "text",
                        text: results.total === 0
                            ? "No issues found."
                            : JSON.stringify(results, null, 2),
                    },
                ],
            };
        }
        catch (error) {
            return {
                isError: true,
                content: [{ type: "text", text: `jira_search_issues failed: ${formatError(error)}` }],
            };
        }
    });
    tool("core", "read", "jira_get_issue", {
        title: "Get Jira issue",
        description: "Get full details of a single Jira Data Center issue by key, including summary, description, " +
            "status, assignee, reporter, comments, and created/updated dates. Read-only.",
        inputSchema: {
            issueKey: z.string().describe("Jira issue key, e.g. 'ABC-123'"),
        },
    }, async ({ issueKey }) => {
        try {
            const issue = await jiraClient.getIssue(issueKey);
            return {
                content: [{ type: "text", text: JSON.stringify(issue, null, 2) }],
            };
        }
        catch (error) {
            return {
                isError: true,
                content: [{ type: "text", text: `jira_get_issue failed: ${formatError(error)}` }],
            };
        }
    });
    tool("core", "read", "jira_get_issue_fields", {
        title: "Get named Jira issue fields",
        description: "Get named standard and custom field values for a Jira Data Center issue. Useful for PPM " +
            "and other projects whose important data lives in custom fields. By default returns all " +
            "non-empty fields except bulky comments, attachments, and worklogs. Read-only.",
        inputSchema: {
            issueKey: z.string().describe("Jira issue key, e.g. 'PPM-21345'"),
            fieldNames: z
                .array(z.string())
                .max(100)
                .optional()
                .describe("Optional exact field names or field IDs to return"),
            includeEmpty: z
                .boolean()
                .optional()
                .describe("Include fields with empty values (default false)"),
        },
    }, async ({ issueKey, fieldNames, includeEmpty }) => {
        try {
            const fields = await jiraClient.getIssueFields(issueKey, fieldNames ?? ([] as string[]), includeEmpty ?? false);
            return { content: [{ type: "text", text: JSON.stringify(fields, null, 2) }] };
        }
        catch (error) {
            return {
                isError: true,
                content: [{ type: "text", text: `jira_get_issue_fields failed: ${formatError(error)}` }],
            };
        }
    });
    tool("forms", "read", "jira_list_proforma_forms", {
        title: "List Jira ProForma forms",
        description: "List Forms (ProForma) attached to a Jira Data Center issue, including IDs, names, " +
            "submission state, and timestamps. Reads standard Jira issue properties; no separate " +
            "ProForma API permission is required. Read-only.",
        inputSchema: {
            issueKey: z.string().describe("Jira issue key, e.g. 'PPM-21345'"),
        },
    }, async ({ issueKey }) => {
        try {
            const forms = await jiraClient.listProformaForms(issueKey);
            return {
                content: [
                    {
                        type: "text",
                        text: forms.length === 0 ? "No ProForma forms found." : JSON.stringify(forms, null, 2),
                    },
                ],
            };
        }
        catch (error) {
            return {
                isError: true,
                content: [
                    { type: "text", text: `jira_list_proforma_forms failed: ${formatError(error)}` },
                ],
            };
        }
    });
    tool("forms", "read", "jira_get_proforma_form", {
        title: "Get Jira ProForma form",
        description: "Decode one Forms (ProForma) form attached to a Jira issue and return readable question " +
            "labels, selected choice labels, answers, and completion counts. Read-only.",
        inputSchema: {
            issueKey: z.string().describe("Jira issue key, e.g. 'PPM-21345'"),
            formId: z.number().int().positive().describe("Form ID returned by jira_list_proforma_forms"),
            includeEmpty: z
                .boolean()
                .optional()
                .describe("Include unanswered questions represented in the form state (default false)"),
        },
    }, async ({ issueKey, formId, includeEmpty }) => {
        try {
            const form = await jiraClient.getProformaForm(issueKey, formId, includeEmpty ?? false);
            return { content: [{ type: "text", text: JSON.stringify(form, null, 2) }] };
        }
        catch (error) {
            return {
                isError: true,
                content: [
                    { type: "text", text: `jira_get_proforma_form failed: ${formatError(error)}` },
                ],
            };
        }
    });
    tool("forms", "read", "jira_get_proforma_forms_summary", {
        title: "Get all Jira ProForma forms",
        description: "Decode all Forms (ProForma) forms attached to a Jira issue into readable question and " +
            "answer data. Best for completeness audits of PPM requests. Read-only.",
        inputSchema: {
            issueKey: z.string().describe("Jira issue key, e.g. 'PPM-21345'"),
            includeEmpty: z
                .boolean()
                .optional()
                .describe("Include unanswered questions represented in form state (default false)"),
        },
    }, async ({ issueKey, includeEmpty }) => {
        try {
            const forms = await jiraClient.getProformaFormsSummary(issueKey, includeEmpty ?? false);
            return {
                content: [
                    {
                        type: "text",
                        text: forms.length === 0 ? "No ProForma forms found." : JSON.stringify(forms, null, 2),
                    },
                ],
            };
        }
        catch (error) {
            return {
                isError: true,
                content: [
                    {
                        type: "text",
                        text: `jira_get_proforma_forms_summary failed: ${formatError(error)}`,
                    },
                ],
            };
        }
    });
    tool("files", "read", "jira_list_attachments", {
        title: "List Jira attachments",
        description: "List attachment metadata for a Jira issue, including IDs, filenames, authors, sizes, MIME " +
            "types, and download URLs. Read-only.",
        inputSchema: {
            issueKey: z.string().describe("Jira issue key, e.g. 'PPM-21345'"),
        },
    }, async ({ issueKey }) => {
        try {
            const attachments = await jiraClient.listAttachments(issueKey);
            return {
                content: [
                    {
                        type: "text",
                        text: attachments.length === 0
                            ? "No attachments found."
                            : JSON.stringify(attachments, null, 2),
                    },
                ],
            };
        }
        catch (error) {
            return {
                isError: true,
                content: [{ type: "text", text: `jira_list_attachments failed: ${formatError(error)}` }],
            };
        }
    });
    tool("files", "local", "jira_download_attachment", {
        title: "Download Jira attachment",
        description: "Download a Jira attachment to an explicit absolute path on the local machine. Writes a " +
            "local file but does not modify Jira.",
        inputSchema: {
            attachmentId: z.string().describe("Attachment ID returned by jira_list_attachments"),
            outputPath: z.string().describe("Absolute local destination path, including filename"),
        },
    }, async ({ attachmentId, outputPath }) => {
        try {
            const result = await jiraClient.downloadAttachment(attachmentId, outputPath);
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        }
        catch (error) {
            return {
                isError: true,
                content: [
                    { type: "text", text: `jira_download_attachment failed: ${formatError(error)}` },
                ],
            };
        }
    });
    tool("files", "local", "jira_upload_attachment", {
        title: "Upload Jira attachment",
        description: "Upload a local file as an attachment to a Jira issue. Mutates data: creates a real " +
            "attachment on the issue.",
        inputSchema: {
            issueKey: z.string().describe("Jira issue key, e.g. 'PPM-21345'"),
            filePath: z.string().describe("Absolute path to the local file to upload"),
            mimeType: z
                .string()
                .optional()
                .describe("MIME type (default application/octet-stream)"),
        },
    }, async ({ issueKey, filePath, mimeType }) => {
        try {
            const result = await jiraClient.uploadAttachment(issueKey, filePath, mimeType);
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        }
        catch (error) {
            return {
                isError: true,
                content: [{ type: "text", text: `jira_upload_attachment failed: ${formatError(error)}` }],
            };
        }
    });
    tool("files", "destructive", "jira_delete_attachment", {
        title: "Delete Jira attachment",
        description: "Permanently delete a Jira attachment by ID. Mutates data and cannot be undone.",
        inputSchema: {
            attachmentId: z.string().describe("Attachment ID returned by jira_list_attachments"),
        },
    }, async ({ attachmentId }) => {
        try {
            const result = await jiraClient.deleteAttachment(attachmentId);
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        }
        catch (error) {
            return {
                isError: true,
                content: [{ type: "text", text: `jira_delete_attachment failed: ${formatError(error)}` }],
            };
        }
    });
    tool("links", "read", "jira_list_issue_link_types", {
        title: "List Jira issue link types",
        description: "List the configured Jira issue-link types and their inward/outward descriptions. Read-only.",
        inputSchema: {},
    }, async () => {
        try {
            const result = await jiraClient.listIssueLinkTypes();
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        }
        catch (error) {
            return {
                isError: true,
                content: [
                    { type: "text", text: `jira_list_issue_link_types failed: ${formatError(error)}` },
                ],
            };
        }
    });
    tool("links", "read", "jira_get_issue_links", {
        title: "Get Jira issue links",
        description: "Get all inward and outward issue links for a Jira issue, including relationship, linked " +
            "issue summary, and status. Read-only.",
        inputSchema: {
            issueKey: z.string().describe("Jira issue key, e.g. 'PPM-21345'"),
        },
    }, async ({ issueKey }) => {
        try {
            const links = await jiraClient.getIssueLinks(issueKey);
            return {
                content: [
                    {
                        type: "text",
                        text: links.length === 0 ? "No issue links found." : JSON.stringify(links, null, 2),
                    },
                ],
            };
        }
        catch (error) {
            return {
                isError: true,
                content: [{ type: "text", text: `jira_get_issue_links failed: ${formatError(error)}` }],
            };
        }
    });
    tool("links", "write", "jira_create_issue_link", {
        title: "Create Jira issue link",
        description: "Create a relationship between two Jira issues using a configured link type. Mutates data " +
            "and optionally adds a comment.",
        inputSchema: {
            linkType: z
                .string()
                .describe("Link type name returned by jira_list_issue_link_types, e.g. 'Blocks'"),
            inwardIssueKey: z.string().describe("Issue key on the inward side of the relationship"),
            outwardIssueKey: z.string().describe("Issue key on the outward side of the relationship"),
            comment: z.string().optional().describe("Optional comment added while creating the link"),
        },
    }, async ({ linkType, inwardIssueKey, outwardIssueKey, comment }) => {
        try {
            const result = await jiraClient.createIssueLink(linkType, inwardIssueKey, outwardIssueKey, comment);
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        }
        catch (error) {
            return {
                isError: true,
                content: [{ type: "text", text: `jira_create_issue_link failed: ${formatError(error)}` }],
            };
        }
    });
    tool("links", "destructive", "jira_delete_issue_link", {
        title: "Delete Jira issue link",
        description: "Delete a Jira issue link by its link ID. Mutates data and cannot be undone.",
        inputSchema: {
            linkId: z.string().describe("Link ID returned by jira_get_issue_links"),
        },
    }, async ({ linkId }) => {
        try {
            const result = await jiraClient.deleteIssueLink(linkId);
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        }
        catch (error) {
            return {
                isError: true,
                content: [{ type: "text", text: `jira_delete_issue_link failed: ${formatError(error)}` }],
            };
        }
    });
    tool("write", "write", "jira_create_issue", {
        title: "Create Jira issue",
        description: "Create a new Jira Data Center issue or sub-task. Mutates data: sends a POST request that " +
            "creates a real issue in the target project.",
        inputSchema: {
            projectKey: z.string().describe("Project key, e.g. 'ABC'"),
            issueType: z
                .string()
                .describe("Issue type name, e.g. 'Story', 'Task', 'Sub-task', 'Bug'"),
            summary: z.string().describe("Issue summary/title"),
            description: z.string().optional().describe("Issue description"),
            parentKey: z
                .string()
                .optional()
                .describe("Parent issue key, required when creating a sub-task"),
            assignee: z.string().optional().describe("Assignee username/name"),
            priority: z.string().optional().describe("Priority name, e.g. 'High'"),
        },
    }, async ({ projectKey, issueType, summary, description, parentKey, assignee, priority }) => {
        try {
            const result = await jiraClient.createIssue({
                projectKey,
                issueType,
                summary,
                description,
                parentKey,
                assignee,
                priority,
            });
            return {
                content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            };
        }
        catch (error) {
            return {
                isError: true,
                content: [{ type: "text", text: `jira_create_issue failed: ${formatError(error)}` }],
            };
        }
    });
    tool("write", "write", "jira_update_issue", {
        title: "Update Jira issue",
        description: "Update fields on an existing Jira Data Center issue by key. Mutates data: sends a PUT request " +
            "that changes the real issue. Supports common named fields plus a flexible 'fields' object " +
            "for anything else.",
        inputSchema: {
            issueKey: z.string().describe("Jira issue key, e.g. 'ABC-123'"),
            summary: z.string().optional().describe("New summary/title"),
            description: z.string().optional().describe("New description"),
            assignee: z.string().optional().describe("New assignee username/name"),
            priority: z.string().optional().describe("New priority name, e.g. 'High'"),
            labels: z.array(z.string()).optional().describe("New set of labels (replaces existing)"),
            fields: z
                .record(z.string(), z.unknown())
                .optional()
                .describe("Escape hatch: raw Jira 'fields' object for anything not covered above"),
        },
    }, async ({ issueKey, summary, description, assignee, priority, labels, fields }) => {
        try {
            const result = await jiraClient.updateIssue(issueKey, {
                summary,
                description,
                assignee,
                priority,
                labels,
                fields: fields,
            });
            return {
                content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            };
        }
        catch (error) {
            return {
                isError: true,
                content: [{ type: "text", text: `jira_update_issue failed: ${formatError(error)}` }],
            };
        }
    });
    tool("write", "write", "jira_add_comment", {
        title: "Add Jira comment",
        description: "Add a comment to an existing Jira Data Center issue by key. Mutates data: sends a POST " +
            "request that adds a real comment.",
        inputSchema: {
            issueKey: z.string().describe("Jira issue key, e.g. 'ABC-123'"),
            body: z.string().describe("Comment text"),
        },
    }, async ({ issueKey, body }) => {
        try {
            const result = await jiraClient.addComment(issueKey, body);
            return {
                content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            };
        }
        catch (error) {
            return {
                isError: true,
                content: [{ type: "text", text: `jira_add_comment failed: ${formatError(error)}` }],
            };
        }
    });
    tool("write", "write", "jira_edit_comment", {
        title: "Edit Jira comment",
        description: "Edit an existing comment on a Jira Data Center issue. Mutates data: sends a PUT " +
            "request that edits a real comment. Note: Jira typically only allows editing your " +
            "own comments unless you hold administrator/project-admin permissions to edit " +
            "others' comments.",
        inputSchema: {
            issueKey: z.string().describe("Jira issue key, e.g. 'ABC-123'"),
            commentId: z.string().describe("ID of the comment to edit"),
            body: z.string().describe("New comment text"),
        },
    }, async ({ issueKey, commentId, body }) => {
        try {
            const result = await jiraClient.editComment(issueKey, commentId, body);
            return {
                content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            };
        }
        catch (error) {
            return {
                isError: true,
                content: [{ type: "text", text: `jira_edit_comment failed: ${formatError(error)}` }],
            };
        }
    });
    tool("write", "destructive", "jira_delete_comment", {
        title: "Delete Jira comment",
        description: "Delete an existing comment from a Jira Data Center issue. Mutates data: sends a " +
            "DELETE request that permanently removes a real comment. This cannot be undone. " +
            "Note: Jira typically only allows deleting your own comments unless you hold " +
            "administrator/project-admin permissions to delete others' comments.",
        inputSchema: {
            issueKey: z.string().describe("Jira issue key, e.g. 'ABC-123'"),
            commentId: z.string().describe("ID of the comment to delete"),
        },
    }, async ({ issueKey, commentId }) => {
        try {
            const result = await jiraClient.deleteComment(issueKey, commentId);
            return {
                content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            };
        }
        catch (error) {
            return {
                isError: true,
                content: [{ type: "text", text: `jira_delete_comment failed: ${formatError(error)}` }],
            };
        }
    });
    tool("write", "write", "jira_add_worklog", {
        title: "Log work on a Jira issue",
        description: "Log work (a worklog entry) against an existing Jira Data Center issue by key. Mutates data: " +
            "sends a POST request that adds a real worklog entry, including the time spent and an " +
            "optional comment and start time.",
        inputSchema: {
            issueKey: z.string().describe("Jira issue key, e.g. 'ABC-123'"),
            timeSpent: z
                .string()
                .describe("Time spent in Jira duration format, e.g. '1h 30m', '3h', '45m'"),
            comment: z.string().optional().describe("Optional worklog comment"),
            started: z
                .string()
                .optional()
                .describe("Optional ISO 8601 timestamp for when the work started, e.g. '2024-01-01T10:00:00Z'. Defaults to now."),
        },
    }, async ({ issueKey, timeSpent, comment, started }) => {
        try {
            const result = await jiraClient.addWorklog(issueKey, { timeSpent, comment, started });
            return {
                content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            };
        }
        catch (error) {
            return {
                isError: true,
                content: [{ type: "text", text: `jira_add_worklog failed: ${formatError(error)}` }],
            };
        }
    });
    tool("write", "write", "jira_add_worklog_with_category", {
        title: "Log work on a Jira issue with a work category (vaillant-timetracking plugin)",
        description: "Log work against an existing Jira Data Center issue through the vaillant-timetracking " +
            "plugin's own REST endpoint, including a work category (e.g. 'cat1', 'cat2'). Unlike " +
            "jira_add_worklog (which uses Jira's built-in worklog API and bypasses the plugin), this " +
            "creates a proper WorklogExtension record so the entry shows up correctly in the plugin's " +
            "timesheet/approval workflow. Mutates data: sends a real POST request. Note: the worklog is " +
            "always created with internal status 'TRACKED' — there is no REST endpoint to submit it " +
            "(status 'SUBMITTED'); that step still requires the Jira UI.",
        inputSchema: {
            issueKey: z.string().describe("Jira issue key, e.g. 'ABC-123'"),
            timeSpent: z
                .string()
                .describe("Time spent in Jira duration format, e.g. '1h 30m', '3h', '45m'"),
            category: z
                .string()
                .describe("Work category as configured by the plugin, e.g. 'cat1', 'cat2'"),
            comment: z.string().optional().describe("Optional worklog comment/description"),
            started: z
                .string()
                .optional()
                .describe("Optional ISO 8601 timestamp for when the work started, e.g. '2024-01-01T10:00:00Z'. Defaults to now."),
        },
    }, async ({ issueKey, timeSpent, category, comment, started }) => {
        try {
            const result = await jiraClient.addWorklogWithCategory(issueKey, {
                timeSpent,
                category,
                comment,
                started,
            });
            return {
                content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            };
        }
        catch (error) {
            return {
                isError: true,
                content: [
                    { type: "text", text: `jira_add_worklog_with_category failed: ${formatError(error)}` },
                ],
            };
        }
    });
    tool("write", "write", "jira_transition_issue", {
        title: "Transition Jira issue status",
        description: "Transition a Jira Data Center issue to a new status by name (case-insensitive). Mutates data: " +
            "looks up available transitions, then sends a POST request that changes the real issue's " +
            "status. Returns an error listing available transition names if the requested status isn't " +
            "reachable from the issue's current status.",
        inputSchema: {
            issueKey: z.string().describe("Jira issue key, e.g. 'ABC-123'"),
            targetStatus: z
                .string()
                .describe("Target status name to transition to, e.g. 'In Progress', 'Done'"),
        },
    }, async ({ issueKey, targetStatus }) => {
        try {
            const result = await jiraClient.transitionIssue(issueKey, targetStatus);
            return {
                content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            };
        }
        catch (error) {
            return {
                isError: true,
                content: [
                    { type: "text", text: `jira_transition_issue failed: ${formatError(error)}` },
                ],
            };
        }
    });
    tool("dev", "read", "jira_get_issue_changelog", {
        title: "Get Jira issue status changelog",
        description: "Get the full status transition history (from/to/when/who) for a single Jira Data Center " +
            "issue, fetched from the dedicated paginated changelog endpoint (not capped like the " +
            "expand=changelog param). Useful for auditing exact workflow timing. Read-only.",
        inputSchema: {
            issueKey: z.string().describe("Jira issue key, e.g. 'ABC-123'"),
        },
    }, async ({ issueKey }) => {
        try {
            const changelog = await jiraClient.getIssueChangelog(issueKey);
            return {
                content: [{ type: "text", text: JSON.stringify(changelog, null, 2) }],
            };
        }
        catch (error) {
            return {
                isError: true,
                content: [
                    { type: "text", text: `jira_get_issue_changelog failed: ${formatError(error)}` },
                ],
            };
        }
    });
    tool("dev", "read", "jira_get_issue_cycle_time", {
        title: "Get Jira issue cycle time",
        description: "Compute cycle time in days for one or more Jira Data Center issues, based on real " +
            "status-transition history (not the created/updated proxy dates, which are misleading " +
            "since issues often sit in a backlog before work starts). For each issue, finds when it " +
            "first entered fromStatus and when it last entered toStatus (handling reopen/redo " +
            "cycles), and returns the number of days between them. Entries where the issue never " +
            "reached one of the statuses will have cycleTimeDays: null with a note explaining why. " +
            "Read-only.",
        inputSchema: {
            issueKeys: z
                .array(z.string())
                .min(1)
                .max(50)
                .describe("List of Jira issue keys to analyze, e.g. ['ABC-123', 'ABC-124']"),
            fromStatus: z
                .string()
                .optional()
                .describe("Status marking the start of the cycle (default 'In Progress')"),
            toStatus: z
                .string()
                .optional()
                .describe("Status marking the end of the cycle (default 'Done')"),
        },
    }, async ({ issueKeys, fromStatus, toStatus }) => {
        try {
            const results = await jiraClient.getIssuesCycleTime(issueKeys, fromStatus ?? "In Progress", toStatus ?? "Done");
            return {
                content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
            };
        }
        catch (error) {
            return {
                isError: true,
                content: [
                    { type: "text", text: `jira_get_issue_cycle_time failed: ${formatError(error)}` },
                ],
            };
        }
    });
    tool("dev", "read", "jira_get_issue_dev_status", {
        title: "Get Jira issue development status",
        description: "Get a single Jira Data Center issue's linked GitHub development activity (from Jira's " +
            "'Development' panel): branches, pull requests, and commits, including full commit " +
            "messages so callers can detect 'Co-authored-by:' trailers (e.g. from GitHub Copilot). " +
            "This is a more reliable link between a Jira issue and its code changes than text-matching " +
            "ticket keys against commit messages. Read-only.",
        inputSchema: {
            issueKey: z.string().describe("Jira issue key, e.g. 'ABC-123'"),
        },
    }, async ({ issueKey }) => {
        try {
            const devStatus = await jiraClient.getIssueDevStatus(issueKey);
            return {
                content: [{ type: "text", text: JSON.stringify(devStatus, null, 2) }],
            };
        }
        catch (error) {
            return {
                isError: true,
                content: [
                    { type: "text", text: `jira_get_issue_dev_status failed: ${formatError(error)}` },
                ],
            };
        }
    });
    tool("dev", "read", "jira_get_issues_dev_status", {
        title: "Get Jira issues development status (batch)",
        description: "Batch version of jira_get_issue_dev_status: get linked GitHub branches, pull requests, " +
            "and commits (with full messages, for 'Co-authored-by:' detection) for multiple Jira Data " +
            "Center issues in one call. Individual issue failures are reported as an empty result with " +
            "a note rather than failing the whole batch. Read-only.",
        inputSchema: {
            issueKeys: z
                .array(z.string())
                .min(1)
                .max(50)
                .describe("List of Jira issue keys to analyze, e.g. ['ABC-123', 'ABC-124']"),
        },
    }, async ({ issueKeys }) => {
        try {
            const results = await jiraClient.getIssuesDevStatus(issueKeys);
            return {
                content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
            };
        }
        catch (error) {
            return {
                isError: true,
                content: [
                    { type: "text", text: `jira_get_issues_dev_status failed: ${formatError(error)}` },
                ],
            };
        }
    });
    tool("agile", "read", "jira_get_issues_story_points", {
        title: "Get story points for Jira issues",
        description: "Get story points for a list of Jira issues by key, on either Scrum or Kanban boards " +
            "(Data Center). Discovers the board's configured estimation field via its board " +
            "configuration (which works on Kanban boards too, unlike sprint-based reports that " +
            "require the board to support sprints), then fetches summary, status, and story points " +
            "for each issue. Read-only.",
        inputSchema: {
            boardId: z
                .number()
                .int()
                .positive()
                .describe("Jira Agile board ID used to discover the story points field, e.g. 3258"),
            issueKeys: z
                .array(z.string())
                .min(1)
                .max(100)
                .describe("Issue keys to fetch story points for, e.g. ['ABC-123', 'ABC-124']"),
        },
    }, async ({ boardId, issueKeys }) => {
        try {
            const { fieldId, fieldName } = await jiraAgileClient.getBoardStoryPointsField(boardId);
            if (!fieldId) {
                return {
                    isError: true,
                    content: [
                        {
                            type: "text",
                            text: `jira_get_issues_story_points failed: Board ${boardId} has no configured story points estimation field.`,
                        },
                    ],
                };
            }
            const issues = await jiraClient.getIssuesStoryPoints(issueKeys, fieldId);
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({ storyPointsField: fieldId, storyPointsFieldName: fieldName, issues }, null, 2),
                    },
                ],
            };
        }
        catch (error) {
            return {
                isError: true,
                content: [
                    { type: "text", text: `jira_get_issues_story_points failed: ${formatError(error)}` },
                ],
            };
        }
    });
    tool("agile", "read", "jira_get_board_sprints", {
        title: "List sprints for a Jira board",
        description: "List sprints for a Jira Agile board (Data Center). Returns sprint id, name, state, " +
            "startDate, endDate, and goal for each sprint. Read-only.",
        inputSchema: {
            boardId: z.number().int().positive().describe("Jira Agile board ID, e.g. 3228"),
            state: z
                .enum(["active", "closed", "future"])
                .optional()
                .describe("Filter sprints by state. Omit to return sprints in all states."),
        },
    }, async ({ boardId, state }) => {
        try {
            const sprints = await jiraAgileClient.getBoardSprints(boardId, state);
            return {
                content: [
                    {
                        type: "text",
                        text: sprints.length === 0 ? "No sprints found." : JSON.stringify(sprints, null, 2),
                    },
                ],
            };
        }
        catch (error) {
            return {
                isError: true,
                content: [
                    { type: "text", text: `jira_get_board_sprints failed: ${formatError(error)}` },
                ],
            };
        }
    });
    tool("agile", "read", "jira_get_sprint_report", {
        title: "Get Jira sprint completion/velocity report",
        description: "Get a velocity/completion report for a single sprint on a Jira Agile board " +
            "(Data Center). Dynamically discovers the board's configured story points field via its " +
            "board configuration, then sums story points for issues in the sprint, split into " +
            "completed (status category 'Done') vs total committed. Also returns an issue count " +
            "breakdown by status. " +
            "`committedPoints` is the sprint's CURRENT scope, so it silently includes work added " +
            "mid-sprint. When `scope` is present it comes from Jira's own sprint report: use " +
            "`scope.initialCommittedPoints` for the real commitment and `scope.addedDuringSprintKeys` " +
            "to see scope creep. When `scope` is null that breakdown was unavailable — say so rather " +
            "than presenting `committedPoints` as the commitment. Read-only.",
        inputSchema: {
            boardId: z.number().int().positive().describe("Jira Agile board ID, e.g. 3228"),
            sprintId: z.number().int().positive().describe("Sprint ID to report on"),
        },
    }, async ({ boardId, sprintId }) => {
        try {
            const report = await jiraAgileClient.getSprintReport(boardId, sprintId);
            return {
                content: [{ type: "text", text: JSON.stringify(report, null, 2) }],
            };
        }
        catch (error) {
            return {
                isError: true,
                content: [
                    { type: "text", text: `jira_get_sprint_report failed: ${formatError(error)}` },
                ],
            };
        }
    });
    tool("agile", "read", "jira_get_board_velocity", {
        title: "Get Jira board velocity report",
        description: "Get a velocity summary across the most recently closed sprints on a Jira Agile board " +
            "(Data Center): sprint name, dates, committed points, completed points, and completion " +
            "percentage for each sprint, plus averages. Combines jira_get_board_sprints and " +
            "jira_get_sprint_report internally. Read-only.",
        inputSchema: {
            boardId: z.number().int().positive().describe("Jira Agile board ID, e.g. 3228"),
            numSprints: z
                .number()
                .int()
                .positive()
                .max(50)
                .optional()
                .describe("Number of most recently closed sprints to include (default 3)"),
        },
    }, async ({ boardId, numSprints }) => {
        try {
            const report = await jiraAgileClient.getBoardVelocity(boardId, numSprints ?? 3);
            return {
                content: [{ type: "text", text: JSON.stringify(report, null, 2) }],
            };
        }
        catch (error) {
            return {
                isError: true,
                content: [
                    { type: "text", text: `jira_get_board_velocity failed: ${formatError(error)}` },
                ],
            };
        }
    });
    tool("core", "read", "confluence_search_pages", {
        title: "Search Confluence pages",
        description: "Search Confluence Data Center content using CQL (Confluence Query Language). " +
            "Returns id, title, space, and URL for each matching page, plus pagination metadata: " +
            "`total` is the full match count, and when `hasMore` is true you must call again with " +
            "`start: nextStart` to see the rest — do not treat a truncated page as the complete " +
            "answer. Read-only.",
        inputSchema: {
            cql: z
                .string()
                .describe("CQL query string, e.g. 'space = ABC AND title ~ \"Release Notes\"'"),
            limit: z
                .number()
                .int()
                .positive()
                .max(100)
                .optional()
                .describe("Maximum number of results per page (default 20, max 100)"),
            start: z
                .number()
                .int()
                .min(0)
                .optional()
                .describe("Zero-based index of the first result to return; pass `nextStart` from a previous call"),
        },
    }, async ({ cql, limit, start }) => {
        try {
            const results = await confluenceClient.searchPages(cql, limit ?? 20, start ?? 0);
            return {
                content: [
                    {
                        type: "text",
                        text: results.total === 0
                            ? "No pages found."
                            : JSON.stringify(results, null, 2),
                    },
                ],
            };
        }
        catch (error) {
            return {
                isError: true,
                content: [
                    { type: "text", text: `confluence_search_pages failed: ${formatError(error)}` },
                ],
            };
        }
    });
    tool("core", "read", "confluence_get_page", {
        title: "Get Confluence page",
        description: "Get a Confluence Data Center page's content by its page ID. Storage-format HTML is converted " +
            "to plain text where reasonably possible. Read-only.",
        inputSchema: {
            pageId: z.string().describe("Confluence page ID, e.g. '123456'"),
        },
    }, async ({ pageId }) => {
        try {
            const page = await confluenceClient.getPage(pageId);
            return {
                content: [{ type: "text", text: JSON.stringify(page, null, 2) }],
            };
        }
        catch (error) {
            return {
                isError: true,
                content: [{ type: "text", text: `confluence_get_page failed: ${formatError(error)}` }],
            };
        }
    });
    tool("core", "read", "confluence_list_comments", {
        title: "List Confluence comments",
        description: "List comments on a Confluence Data Center page, including comment IDs, authors, creation " +
            "dates, versions, and readable bodies. Read-only.",
        inputSchema: {
            pageId: z.string().describe("Confluence page ID, e.g. '601156620'"),
            limit: z
                .number()
                .int()
                .positive()
                .max(500)
                .optional()
                .describe("Maximum comments to return (default 100, max 500)"),
        },
    }, async ({ pageId, limit }) => {
        try {
            const comments = await confluenceClient.listComments(pageId, limit ?? 100);
            return {
                content: [
                    {
                        type: "text",
                        text: comments.length === 0 ? "No comments found." : JSON.stringify(comments, null, 2),
                    },
                ],
            };
        }
        catch (error) {
            return {
                isError: true,
                content: [
                    { type: "text", text: `confluence_list_comments failed: ${formatError(error)}` },
                ],
            };
        }
    });
    tool("write", "write", "confluence_add_comment", {
        title: "Add Confluence comment",
        description: "Add a comment to a Confluence Data Center page. Mutates data by creating a real comment. " +
            "Body may be plain text or simple storage-compatible HTML.",
        inputSchema: {
            pageId: z.string().describe("Confluence page ID, e.g. '601156620'"),
            body: z.string().describe("Comment body as plain text or simple HTML"),
        },
    }, async ({ pageId, body }) => {
        try {
            const result = await confluenceClient.addComment(pageId, body);
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        }
        catch (error) {
            return {
                isError: true,
                content: [{ type: "text", text: `confluence_add_comment failed: ${formatError(error)}` }],
            };
        }
    });
    tool("write", "write", "confluence_update_comment", {
        title: "Update Confluence comment",
        description: "Update an existing Confluence comment by ID. Mutates data and increments the comment's " +
            "content version.",
        inputSchema: {
            commentId: z.string().describe("Comment ID returned by confluence_list_comments"),
            body: z.string().describe("Replacement comment body as plain text or simple HTML"),
        },
    }, async ({ commentId, body }) => {
        try {
            const result = await confluenceClient.updateComment(commentId, body);
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        }
        catch (error) {
            return {
                isError: true,
                content: [
                    { type: "text", text: `confluence_update_comment failed: ${formatError(error)}` },
                ],
            };
        }
    });
    tool("write", "destructive", "confluence_delete_comment", {
        title: "Delete Confluence comment",
        description: "Permanently delete a Confluence comment by ID. Mutates data and cannot be undone.",
        inputSchema: {
            commentId: z.string().describe("Comment ID returned by confluence_list_comments"),
        },
    }, async ({ commentId }) => {
        try {
            const result = await confluenceClient.deleteComment(commentId);
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        }
        catch (error) {
            return {
                isError: true,
                content: [
                    { type: "text", text: `confluence_delete_comment failed: ${formatError(error)}` },
                ],
            };
        }
    });
    tool("write", "write", "confluence_create_page", {
        title: "Create Confluence page",
        description: "Create a new Confluence Data Center page. Mutates data: sends a POST request that creates a " +
            "real page. Body may be plain text or simple HTML; plain text is automatically wrapped into " +
            "storage-format paragraphs.",
        inputSchema: {
            spaceKey: z.string().describe("Space key, e.g. 'ENG'"),
            title: z.string().describe("Page title"),
            body: z
                .string()
                .describe("Page content, as plain text or simple HTML"),
            parentId: z
                .string()
                .optional()
                .describe("Parent page ID, to create this page as a child of an existing page"),
        },
    }, async ({ spaceKey, title, body, parentId }) => {
        try {
            const result = await confluenceClient.createPage({ spaceKey, title, body, parentId });
            return {
                content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            };
        }
        catch (error) {
            return {
                isError: true,
                content: [
                    { type: "text", text: `confluence_create_page failed: ${formatError(error)}` },
                ],
            };
        }
    });
    tool("write", "write", "confluence_update_page", {
        title: "Update Confluence page",
        description: "Update an existing Confluence Data Center page's title and/or content by page ID. Mutates " +
            "data: fetches the current page to read its version number, then sends a PUT request with " +
            "the version incremented, updating the real page. Body may be plain text or simple HTML; " +
            "plain text is automatically wrapped into storage-format paragraphs. Omit a field to leave " +
            "it unchanged.",
        inputSchema: {
            pageId: z.string().describe("Confluence page ID, e.g. '123456'"),
            title: z.string().optional().describe("New page title (omit to keep the current title)"),
            body: z
                .string()
                .optional()
                .describe("New page content, as plain text or simple HTML (omit to keep the current content)"),
        },
    }, async ({ pageId, title, body }) => {
        try {
            const result = await confluenceClient.updatePage(pageId, { title, body });
            return {
                content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            };
        }
        catch (error) {
            return {
                isError: true,
                content: [
                    { type: "text", text: `confluence_update_page failed: ${formatError(error)}` },
                ],
            };
        }
    });
    const transport = new StdioServerTransport();
    await server.connect(transport);
    // stdout carries the JSON-RPC stream, so all diagnostics go to stderr.
    // Report the resolved surface: without it, a profile typo silently hides
    // tools and looks like a client bug.
    const profile = process.env.ATLASSIAN_PROFILE?.trim() || "full";
    const groups = [...config.enabledGroups].sort().join(", ");
    console.error(
        `mcp-atlassian started (stdio). profile=${profile} groups=[${groups}] ` +
            `tools=${registered.length}${config.readOnly ? " READ-ONLY" : ""} ` +
            `attachments=${config.attachmentDirs.length > 0 ? config.attachmentDirs.join(":") : "disabled"} ` +
            `timeout=${config.timeoutMs}ms`,
    );
}
main().catch((error) => {
    // Startup errors (e.g. missing env vars) should be clear and fatal.
    // eslint-disable-next-line no-console
    console.error(`mcp-atlassian failed to start: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
});

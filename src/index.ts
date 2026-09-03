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
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { loadConfig, type ToolGroup } from "./config.js";
import { JiraClient } from "./jiraClient.js";
import { JiraAgileClient } from "./jiraAgileClient.js";
import { JiraDirectoryClient } from "./jiraDirectoryClient.js";
import { JiraFilterClient } from "./jiraFilterClient.js";
import { JiraMetaClient } from "./jiraMetaClient.js";
import { JiraServiceDeskClient } from "./jiraServiceDeskClient.js";
import { ConfluenceClient } from "./confluenceClient.js";
import { configureHttp } from "./httpClient.js";
import { registerConfluenceExtraTools } from "./tools/confluenceExtraTools.js";
import { registerJiraAgileWriteTools } from "./tools/jiraAgileWriteTools.js";
import { registerJiraDirectoryTools } from "./tools/jiraDirectoryTools.js";
import { registerJiraFilterTools } from "./tools/jiraFilterTools.js";
import { registerJiraIssueExtraTools } from "./tools/jiraIssueExtraTools.js";
import { registerJiraMetaTools } from "./tools/jiraMetaTools.js";
import { registerJiraServiceDeskTools } from "./tools/jiraServiceDeskTools.js";
import {
    formatError,
    issueKeySchema,
    numericIdSchema,
    textFieldSchema,
    titleFieldSchema,
    type ToolKind,
    type ToolRegistrar,
} from "./tools/shared.js";

/**
 * Caps a tool result so a single call cannot swallow the model's context. A
 * `jira_get_issue` on a busy issue measured 350 kB (~88k tokens) with no
 * truncation and no warning. Truncation is announced in-band so the model can
 * tell a fragment from a complete answer, and knows what to do about it.
 */
function clampToolText(text: string, maxBytes: number): string {
    const buf = Buffer.from(text, "utf8");
    if (buf.length <= maxBytes) return text;
    const marker = (dropped: number) =>
        `\n…[truncated: ${dropped} of ${buf.length} bytes omitted — narrow the query ` +
        "(smaller limit/maxResults, more specific JQL/CQL) and retry]";
    // Reserve the marker's own bytes so the result really fits the ceiling.
    // Only a pathologically small ceiling (under ~140 bytes) overshoots, and
    // then the marker alone is more useful than a silently empty answer.
    const reserve = Buffer.byteLength(marker(buf.length), "utf8");
    let head = buf.subarray(0, Math.max(0, maxBytes - reserve)).toString("utf8");
    // Slicing bytes can cut a multi-byte code point in half; drop the remnant.
    if (head.endsWith("\uFFFD")) head = head.slice(0, -1);
    return head + marker(buf.length - Buffer.byteLength(head, "utf8"));
}
async function main() {
    const config = loadConfig();
    configureHttp({
        timeoutMs: config.timeoutMs,
        totalTimeoutMs: config.totalTimeoutMs,
        maxConcurrentRequests: config.maxConcurrentRequests,
        maxQueuedRequests: config.maxQueuedRequests,
        maxJsonBytes: config.maxJsonBytes,
    });
    const jiraClient = new JiraClient({
        baseUrl: config.jiraBaseUrl,
        pat: config.jiraPat,
        attachmentDirs: config.attachmentDirs,
        maxAttachmentBytes: config.maxAttachmentBytes,
        maxPaginationPages: config.maxPaginationPages,
    });
    const jiraAgileClient = new JiraAgileClient({
        baseUrl: config.jiraBaseUrl,
        pat: config.jiraPat,
        maxPaginationPages: config.maxPaginationPages,
    });
    const jiraMetaClient = new JiraMetaClient({
        baseUrl: config.jiraBaseUrl,
        pat: config.jiraPat,
    });
    const jiraDirectoryClient = new JiraDirectoryClient({
        baseUrl: config.jiraBaseUrl,
        pat: config.jiraPat,
    });
    const jiraFilterClient = new JiraFilterClient({
        baseUrl: config.jiraBaseUrl,
        pat: config.jiraPat,
    });
    const jiraServiceDeskClient = new JiraServiceDeskClient({
        baseUrl: config.jiraBaseUrl,
        pat: config.jiraPat,
    });
    const confluenceClient = new ConfluenceClient({
        baseUrl: config.confluenceBaseUrl,
        pat: config.confluencePat,
        attachmentDirs: config.attachmentDirs,
        maxAttachmentBytes: config.maxAttachmentBytes,
        maxPaginationPages: config.maxPaginationPages,
    });
    const server = new McpServer(
        {
            name: "mcp-atlassian",
            version: "1.2.0",
        },
        {
            // Declaring the logging capability lets tool invocations show up in
            // the client's logs. Without it there is no record of which tools
            // are actually used, and usage can only be inferred.
            capabilities: { logging: {} },
        },
    );
    const registered: string[] = [];
    /**
     * Emits an MCP log notification, ignoring failures. Clients that never set
     * a logging level reject these, and a diagnostic must never break the tool
     * call it is describing.
     */
    function log(level: "debug" | "info" | "error", data: Record<string, unknown>): void {
        void server.server
            .sendLoggingMessage({ level, logger: "mcp-atlassian", data })
            .catch(() => undefined);
    }
    /**
     * Registers a tool, but only when its group is enabled by the active
     * profile and server-side safety policy permit it. Destructive tools are
     * absent unless an operator explicitly enabled them; client annotations
     * remain informative and are never treated as authorization controls.
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
            /**
             * Cross-field precondition, checked before the handler runs and so
             * before any HTTP request. Returns a message naming what is missing,
             * or undefined when the arguments are usable. Zod's raw-shape schemas
             * cannot express "at least one of these", and an update with no
             * fields is not a no-op: it still burns a version, an audit entry and
             * a watcher notification.
             */
            validate?: (args: any) => string | undefined;
        },
        handler: ToolCallback<InputArgs>,
    ): void {
        if (!config.enabledGroups.has(group)) return;
        if (config.readOnly && kind !== "read") return;
        if (kind === "destructive" && !config.allowDestructive) return;
        // Wrap the handler so every invocation is observable: duration and
        // outcome, never arguments — those routinely contain issue content.
        const instrumented = (async (...args: Parameters<typeof handler>) => {
            const startedAt = Date.now();
            const requestId = randomUUID();
            log("debug", { event: "tool.start", requestId, tool: name, kind });
            try {
                const problem = spec.validate?.((args as any[])[0]);
                if (problem !== undefined) {
                    throw new McpError(
                        ErrorCode.InvalidParams,
                        `Input validation error: Invalid arguments for tool ${name}: ${problem}`,
                    );
                }
                const result: any = await (handler as any)(...args);
                // Every handler's text output goes through the same ceiling.
                if (Array.isArray(result?.content)) {
                    for (const part of result.content) {
                        if (part?.type === "text" && typeof part.text === "string") {
                            part.text = clampToolText(part.text, config.maxToolResultBytes);
                        }
                    }
                }
                log(result?.isError ? "error" : "info", {
                    event: "tool.finish",
                    requestId,
                    tool: name,
                    kind,
                    ok: !result?.isError,
                    durationMs: Date.now() - startedAt,
                });
                return result;
            } catch (error) {
                log("error", {
                    event: "tool.throw",
                    requestId,
                    tool: name,
                    kind,
                    durationMs: Date.now() - startedAt,
                    errorType: error instanceof Error ? error.name : "UnknownError",
                });
                throw error;
            }
        }) as typeof handler;
        server.registerTool<z.ZodRawShape, InputArgs>(
            name,
            {
                ...spec,
                annotations: {
                    readOnlyHint: kind === "read",
                    destructiveHint: kind === "destructive",
                    // Re-running a read or a delete converges on the same state;
                    // re-running a create does not.
                    idempotentHint: kind === "read" || kind === "destructive",
                    // Even attachment tools contact a remote Atlassian host.
                    openWorldHint: true,
                    // Deliberately last: a per-tool annotation overrides the value
                    // derived from `kind`. Several "write" tools overwrite content
                    // in place rather than adding to it, and the MCP default for
                    // destructiveHint is true — claiming false there is a false
                    // negative in the dangerous direction.
                    ...spec.annotations,
                },
            },
            instrumented,
        );
        registered.push(name);
    }
    // Feature areas beyond the original tool set register themselves, so the
    // policy decision above stays in one place while this file stays readable.
    const registerTool = tool as ToolRegistrar;
    registerJiraMetaTools(registerTool, jiraMetaClient);
    registerJiraDirectoryTools(registerTool, jiraDirectoryClient);
    registerJiraFilterTools(registerTool, jiraFilterClient);
    registerJiraIssueExtraTools(registerTool, jiraClient);
    registerJiraAgileWriteTools(registerTool, jiraAgileClient);
    registerJiraServiceDeskTools(registerTool, jiraServiceDeskClient);
    registerConfluenceExtraTools(registerTool, confluenceClient);
    tool("core", "read", "jira_list_projects", {
        title: "List Jira projects",
        description: "List the Jira Data Center projects visible to the current user, with key, name, type " +
            "and lead. Use this to discover a project key before building a JQL query. Read-only.",
        inputSchema: {
            query: z
                .string()
                .optional()
                .describe("Optional case-insensitive filter matched against project key and name"),
            limit: z.number().int().min(1).max(500).optional()
                .describe("Maximum number of projects to return (applied after the query filter)"),
        },
    }, async ({ query, limit }) => {
        try {
            const projects = await jiraClient.listProjects(query, limit);
            return {
                content: [
                    {
                        type: "text",
                        text: projects.length === 0
                            ? "No projects found."
                            : JSON.stringify(projects),
                    },
                ],
            };
        }
        catch (error) {
            return {
                isError: true,
                content: [{ type: "text", text: `jira_list_projects failed: ${formatError(error)}` }],
            };
        }
    });
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
                .max(10000)
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
                            : JSON.stringify(results),
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
            "status, assignee, reporter, comments, and created/updated dates. Only the most recent " +
            "comments are returned; `commentTotal` is the real count and `commentsTruncated` says " +
            "whether older ones were held back. Read-only.",
        inputSchema: {
            issueKey: issueKeySchema.describe("Jira issue key, e.g. 'ABC-123'"),
            maxComments: z
                .number()
                .int()
                .min(0)
                .max(200)
                .optional()
                .describe("How many of the most recent comments to include (default 30, 0 for none)"),
        },
    }, async ({ issueKey, maxComments }) => {
        try {
            const issue = await jiraClient.getIssue(issueKey, maxComments ?? 30);
            return {
                content: [{ type: "text", text: JSON.stringify(issue) }],
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
            issueKey: issueKeySchema.describe("Jira issue key, e.g. 'PPM-21345'"),
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
            return { content: [{ type: "text", text: JSON.stringify(fields) }] };
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
            issueKey: issueKeySchema.describe("Jira issue key, e.g. 'PPM-21345'"),
        },
    }, async ({ issueKey }) => {
        try {
            const forms = await jiraClient.listProformaForms(issueKey);
            return {
                content: [
                    {
                        type: "text",
                        text: forms.length === 0 ? "No ProForma forms found." : JSON.stringify(forms),
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
            "labels, selected choice labels, answers, and completion counts. Each answer's \"source\" is " +
            "\"form-state\" or \"jira-field\": a question mapped to a Jira field is resolved from that " +
            "persisted field when the form state has no meaningful answer for it. Unsaved browser-only edits on " +
            "an open form are never visible through this API; open-form reads carry a warning saying so. " +
            "Read-only.",
        inputSchema: {
            issueKey: issueKeySchema.describe("Jira issue key, e.g. 'PPM-21345'"),
            formId: z.number().int().positive().describe("Form ID returned by jira_list_proforma_forms"),
            includeEmpty: z
                .boolean()
                .optional()
                .describe("Include unanswered questions represented in the form state (default false)"),
        },
    }, async ({ issueKey, formId, includeEmpty }) => {
        try {
            const form = await jiraClient.getProformaForm(issueKey, formId, includeEmpty ?? false);
            return { content: [{ type: "text", text: JSON.stringify(form) }] };
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
            "answer data. Best for completeness audits of PPM requests. Each answer's \"source\" is " +
            "\"form-state\" or \"jira-field\": a question mapped to a Jira field is resolved from that " +
            "persisted field when the form state has no meaningful answer for it. Unsaved browser-only edits on " +
            "an open form are never visible through this API; open-form reads carry a warning saying so. " +
            "Read-only.",
        inputSchema: {
            issueKey: issueKeySchema.describe("Jira issue key, e.g. 'PPM-21345'"),
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
                        text: forms.length === 0 ? "No ProForma forms found." : JSON.stringify(forms),
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
            issueKey: issueKeySchema.describe("Jira issue key, e.g. 'PPM-21345'"),
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
                            : JSON.stringify(attachments),
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
            return { content: [{ type: "text", text: JSON.stringify(result) }] };
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
    tool("files", "write", "jira_upload_attachment", {
        title: "Upload Jira attachment",
        description: "Upload a local file as an attachment to a Jira issue. Mutates data: creates a real " +
            "attachment on the issue.",
        inputSchema: {
            issueKey: issueKeySchema.describe("Jira issue key, e.g. 'PPM-21345'"),
            filePath: z.string().describe("Absolute path to the local file to upload"),
            mimeType: z
                .string()
                .optional()
                .describe("MIME type (default application/octet-stream)"),
        },
    }, async ({ issueKey, filePath, mimeType }) => {
        try {
            const result = await jiraClient.uploadAttachment(issueKey, filePath, mimeType);
            return { content: [{ type: "text", text: JSON.stringify(result) }] };
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
            return { content: [{ type: "text", text: JSON.stringify(result) }] };
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
            return { content: [{ type: "text", text: JSON.stringify(result) }] };
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
            issueKey: issueKeySchema.describe("Jira issue key, e.g. 'PPM-21345'"),
        },
    }, async ({ issueKey }) => {
        try {
            const links = await jiraClient.getIssueLinks(issueKey);
            return {
                content: [
                    {
                        type: "text",
                        text: links.length === 0 ? "No issue links found." : JSON.stringify(links),
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
            return { content: [{ type: "text", text: JSON.stringify(result) }] };
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
            return { content: [{ type: "text", text: JSON.stringify(result) }] };
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
            summary: titleFieldSchema.describe("Issue summary/title"),
            description: textFieldSchema.optional().describe("Issue description"),
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
                content: [{ type: "text", text: JSON.stringify(result) }],
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
            issueKey: issueKeySchema.describe("Jira issue key, e.g. 'ABC-123'"),
            summary: titleFieldSchema.optional().describe("New summary/title"),
            description: textFieldSchema.optional().describe("New description"),
            assignee: z.string().optional().describe("New assignee username/name"),
            priority: z.string().optional().describe("New priority name, e.g. 'High'"),
            labels: z.array(z.string().max(255)).max(100).optional()
                .describe("New set of labels (replaces existing, max 100)"),
            fields: z
                .record(z.string(), z.unknown())
                .optional()
                .describe("Escape hatch: raw Jira 'fields' object for anything not covered above"),
        },
        // Overwrites the named fields in place; `labels` replaces the whole set.
        annotations: { destructiveHint: true },
        validate: ({ summary, description, assignee, priority, labels, fields }) =>
            summary === undefined && description === undefined && assignee === undefined &&
            priority === undefined && labels === undefined && fields === undefined
                ? "nothing to update — supply at least one of: summary, description, assignee, " +
                  "priority, labels, fields. Sending an empty change makes Jira reject the request " +
                  "with an opaque 400."
                : undefined,
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
                content: [{ type: "text", text: JSON.stringify(result) }],
            };
        }
        catch (error) {
            return {
                isError: true,
                content: [{ type: "text", text: `jira_update_issue failed: ${formatError(error)}` }],
            };
        }
    });
    tool("write", "write", "jira_assign_issue", {
        // Overwrites the current assignee; the previous one is not merged or kept.
        annotations: { destructiveHint: true },
        title: "Assign Jira issue",
        description: "Assign a Jira Data Center issue to a user, or unassign it by passing null. Mutates data: " +
            "sends a PUT request to the issue's assignee endpoint. Use the account's username (the " +
            "`name` field), not the display name.",
        inputSchema: {
            issueKey: issueKeySchema.describe("Jira issue key, e.g. 'ABC-123'"),
            assignee: z
                .string()
                .nullable()
                .describe("Username to assign to, or null to unassign"),
        },
    }, async ({ issueKey, assignee }) => {
        try {
            const result = await jiraClient.assignIssue(issueKey, assignee);
            return {
                content: [{ type: "text", text: JSON.stringify(result) }],
            };
        }
        catch (error) {
            return {
                isError: true,
                content: [{ type: "text", text: `jira_assign_issue failed: ${formatError(error)}` }],
            };
        }
    });
    tool("write", "write", "jira_add_comment", {
        title: "Add Jira comment",
        description: "Add a comment to an existing Jira Data Center issue by key. Mutates data: sends a POST " +
            "request that adds a real comment.",
        inputSchema: {
            issueKey: issueKeySchema.describe("Jira issue key, e.g. 'ABC-123'"),
            body: textFieldSchema.describe("Comment text"),
        },
    }, async ({ issueKey, body }) => {
        try {
            const result = await jiraClient.addComment(issueKey, body);
            return {
                content: [{ type: "text", text: JSON.stringify(result) }],
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
            issueKey: issueKeySchema.describe("Jira issue key, e.g. 'ABC-123'"),
            commentId: numericIdSchema.describe("ID of the comment to edit"),
            body: textFieldSchema.describe("New comment text"),
        },
        // Replaces the existing comment text; the previous wording is gone.
        annotations: { destructiveHint: true },
    }, async ({ issueKey, commentId, body }) => {
        try {
            const result = await jiraClient.editComment(issueKey, commentId, body);
            return {
                content: [{ type: "text", text: JSON.stringify(result) }],
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
            issueKey: issueKeySchema.describe("Jira issue key, e.g. 'ABC-123'"),
            commentId: numericIdSchema.describe("ID of the comment to delete"),
        },
    }, async ({ issueKey, commentId }) => {
        try {
            const result = await jiraClient.deleteComment(issueKey, commentId);
            return {
                content: [{ type: "text", text: JSON.stringify(result) }],
            };
        }
        catch (error) {
            return {
                isError: true,
                content: [{ type: "text", text: `jira_delete_comment failed: ${formatError(error)}` }],
            };
        }
    });
    tool("write", "read", "jira_list_worklogs", {
        title: "List Jira worklogs",
        description: "List the worklog entries on a Jira Data Center issue, with id, author, time spent, " +
            "start time and comment. Use it to see what has already been logged before adding more, " +
            "or to find the id of an entry to delete. Read-only.",
        inputSchema: {
            issueKey: issueKeySchema.describe("Jira issue key, e.g. 'ABC-123'"),
        },
    }, async ({ issueKey }) => {
        try {
            const worklogs = await jiraClient.listWorklogs(issueKey);
            return {
                content: [
                    {
                        type: "text",
                        text: worklogs.length === 0
                            ? `No work has been logged on ${issueKey}.`
                            : JSON.stringify(worklogs),
                    },
                ],
            };
        }
        catch (error) {
            return {
                isError: true,
                content: [{ type: "text", text: `jira_list_worklogs failed: ${formatError(error)}` }],
            };
        }
    });
    tool("write", "destructive", "jira_delete_worklog", {
        title: "Delete Jira worklog",
        description: "Permanently delete a worklog entry from a Jira Data Center issue. Mutates data and cannot " +
            "be undone. Jira normally only allows deleting your own worklogs unless you hold " +
            "project-admin permissions.",
        inputSchema: {
            issueKey: issueKeySchema.describe("Jira issue key, e.g. 'ABC-123'"),
            worklogId: z.string().describe("Worklog ID returned by jira_list_worklogs"),
        },
    }, async ({ issueKey, worklogId }) => {
        try {
            const result = await jiraClient.deleteWorklog(issueKey, worklogId);
            return { content: [{ type: "text", text: JSON.stringify(result) }] };
        }
        catch (error) {
            return {
                isError: true,
                content: [{ type: "text", text: `jira_delete_worklog failed: ${formatError(error)}` }],
            };
        }
    });
    tool("write", "read", "jira_list_watchers", {
        title: "List Jira issue watchers",
        description: "List the users watching a Jira Data Center issue. Read-only.",
        inputSchema: {
            issueKey: issueKeySchema.describe("Jira issue key, e.g. 'ABC-123'"),
        },
    }, async ({ issueKey }) => {
        try {
            const watchers = await jiraClient.listWatchers(issueKey);
            return {
                content: [
                    {
                        type: "text",
                        text: watchers.length === 0
                            ? `Nobody is watching ${issueKey}.`
                            : JSON.stringify(watchers),
                    },
                ],
            };
        }
        catch (error) {
            return {
                isError: true,
                content: [{ type: "text", text: `jira_list_watchers failed: ${formatError(error)}` }],
            };
        }
    });
    tool("write", "write", "jira_add_watcher", {
        title: "Add Jira issue watcher",
        description: "Add a user as a watcher on a Jira Data Center issue, so they are notified of changes. " +
            "Mutates data. Use the account's username (the `name` field), not the display name.",
        inputSchema: {
            issueKey: issueKeySchema.describe("Jira issue key, e.g. 'ABC-123'"),
            username: z.string().describe("Username to add as a watcher"),
        },
    }, async ({ issueKey, username }) => {
        try {
            const result = await jiraClient.addWatcher(issueKey, username);
            return { content: [{ type: "text", text: JSON.stringify(result) }] };
        }
        catch (error) {
            return {
                isError: true,
                content: [{ type: "text", text: `jira_add_watcher failed: ${formatError(error)}` }],
            };
        }
    });
    tool("write", "write", "jira_remove_watcher", {
        // Removes an existing watcher — a deletion, not an additive update.
        annotations: { destructiveHint: true },
        title: "Remove Jira issue watcher",
        description: "Remove a user from a Jira Data Center issue's watcher list. Mutates data, but is " +
            "reversible by adding them back.",
        inputSchema: {
            issueKey: issueKeySchema.describe("Jira issue key, e.g. 'ABC-123'"),
            username: z.string().describe("Username to remove from the watcher list"),
        },
    }, async ({ issueKey, username }) => {
        try {
            const result = await jiraClient.removeWatcher(issueKey, username);
            return { content: [{ type: "text", text: JSON.stringify(result) }] };
        }
        catch (error) {
            return {
                isError: true,
                content: [{ type: "text", text: `jira_remove_watcher failed: ${formatError(error)}` }],
            };
        }
    });
    tool("write", "write", "jira_add_worklog", {
        title: "Log work on a Jira issue",
        description: "Log work (a worklog entry) against an existing Jira Data Center issue by key. Mutates data: " +
            "sends a POST request that adds a real worklog entry, including the time spent and an " +
            "optional comment and start time.",
        inputSchema: {
            issueKey: issueKeySchema.describe("Jira issue key, e.g. 'ABC-123'"),
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
                content: [{ type: "text", text: JSON.stringify(result) }],
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
            issueKey: issueKeySchema.describe("Jira issue key, e.g. 'ABC-123'"),
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
                content: [{ type: "text", text: JSON.stringify(result) }],
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
    tool("write", "read", "jira_get_transitions", {
        title: "List available Jira transitions",
        description: "List the transitions currently available on a Jira Data Center issue, including the " +
            "destination status of each and any fields its transition screen requires (with allowed " +
            "values where Jira publishes them). Call this before jira_transition_issue when a workflow " +
            "might demand a resolution or similar field. Read-only.",
        inputSchema: {
            issueKey: issueKeySchema.describe("Jira issue key, e.g. 'ABC-123'"),
        },
    }, async ({ issueKey }) => {
        try {
            const transitions = await jiraClient.getTransitions(issueKey);
            return {
                content: [
                    {
                        type: "text",
                        text: transitions.length === 0
                            ? `No transitions are available on ${issueKey} for this user.`
                            : JSON.stringify(transitions),
                    },
                ],
            };
        }
        catch (error) {
            return {
                isError: true,
                content: [{ type: "text", text: `jira_get_transitions failed: ${formatError(error)}` }],
            };
        }
    });
    tool("write", "write", "jira_transition_issue", {
        // Moves the issue to another workflow state; some transitions are one-way.
        annotations: { destructiveHint: true },
        title: "Transition Jira issue status",
        description: "Transition a Jira Data Center issue to a new status by name (case-insensitive). Mutates data: " +
            "looks up available transitions, then sends a POST request that changes the real issue's " +
            "status. Matches on destination status first, then on transition name. Returns an error " +
            "listing available transitions if the requested status isn't reachable. If the transition " +
            "screen requires fields (commonly `resolution`), supply them via `fields` — the error " +
            "message names the missing fields and their allowed values, and jira_get_transitions shows " +
            "them up front.",
        inputSchema: {
            issueKey: issueKeySchema.describe("Jira issue key, e.g. 'ABC-123'"),
            targetStatus: z
                .string()
                .describe("Target status name to transition to, e.g. 'In Progress', 'Done'"),
            fields: z
                .record(z.any())
                .optional()
                .describe("Fields required by the transition screen, e.g. {\"resolution\":{\"name\":\"Done\"}}"),
        },
    }, async ({ issueKey, targetStatus, fields }) => {
        try {
            const result = await jiraClient.transitionIssue(issueKey, targetStatus, fields);
            return {
                content: [{ type: "text", text: JSON.stringify(result) }],
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
            issueKey: issueKeySchema.describe("Jira issue key, e.g. 'ABC-123'"),
        },
    }, async ({ issueKey }) => {
        try {
            const changelog = await jiraClient.getIssueChangelog(issueKey);
            return {
                content: [{ type: "text", text: JSON.stringify(changelog) }],
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
                content: [{ type: "text", text: JSON.stringify(results) }],
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
            issueKey: issueKeySchema.describe("Jira issue key, e.g. 'ABC-123'"),
        },
    }, async ({ issueKey }) => {
        try {
            const devStatus = await jiraClient.getIssueDevStatus(issueKey);
            return {
                content: [{ type: "text", text: JSON.stringify(devStatus) }],
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
                content: [{ type: "text", text: JSON.stringify(results) }],
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
                        text: JSON.stringify({ storyPointsField: fieldId, storyPointsFieldName: fieldName, issues }),
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
    tool("agile", "read", "jira_list_boards", {
        title: "List Jira Agile boards",
        description:
            "List Jira Agile boards (Data Center) visible to the current user, with id, name, type " +
            "and owning project. Every board-scoped tool here needs a board ID, so start with this. " +
            "A large instance carries thousands of boards, so this returns a bounded window: check " +
            "`hasMore` and `total`, and narrow with `name` or `projectKeyOrId` rather than raising " +
            "`limit`. Read-only.",
        inputSchema: {
            name: z
                .string()
                .optional()
                .describe("Optional filter matched against the board name"),
            projectKeyOrId: z
                .string()
                .optional()
                .describe("Optional project key or id to restrict boards to, e.g. 'ABC'"),
            limit: z
                .number()
                .int()
                .positive()
                .max(200)
                .optional()
                .describe("Maximum boards to return (default 50, hard cap 200)"),
        },
    }, async ({ name, projectKeyOrId, limit }) => {
        try {
            const result = await jiraAgileClient.listBoards({ name, projectKeyOrId, limit });
            return {
                content: [
                    {
                        type: "text",
                        text: result.returned === 0
                            ? "No boards found."
                            : JSON.stringify(result),
                    },
                ],
            };
        }
        catch (error) {
            return {
                isError: true,
                content: [{ type: "text", text: `jira_list_boards failed: ${formatError(error)}` }],
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
                        text: sprints.length === 0 ? "No sprints found." : JSON.stringify(sprints),
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
                content: [{ type: "text", text: JSON.stringify(report) }],
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
                content: [{ type: "text", text: JSON.stringify(report) }],
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
                .max(10000)
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
                            : JSON.stringify(results),
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
            pageId: numericIdSchema.describe("Confluence page ID, e.g. '123456'"),
        },
    }, async ({ pageId }) => {
        try {
            const page = await confluenceClient.getPage(pageId);
            return {
                content: [{ type: "text", text: JSON.stringify(page) }],
            };
        }
        catch (error) {
            return {
                isError: true,
                content: [{ type: "text", text: `confluence_get_page failed: ${formatError(error)}` }],
            };
        }
    });
    tool("core", "read", "confluence_list_spaces", {
        title: "List Confluence spaces",
        description: "List the Confluence Data Center spaces visible to the current user, with key, name, " +
            "type and URL. Use this to discover a space key before writing a CQL query. Read-only.",
        inputSchema: {
            limit: z
                .number()
                .int()
                .positive()
                .max(500)
                .optional()
                .describe("Maximum spaces to return (default 100)"),
        },
    }, async ({ limit }) => {
        try {
            const spaces = await confluenceClient.listSpaces(limit ?? 100);
            return {
                content: [
                    {
                        type: "text",
                        text: spaces.spaces.length === 0 ? "No spaces found." : JSON.stringify(spaces),
                    },
                ],
            };
        }
        catch (error) {
            return {
                isError: true,
                content: [{ type: "text", text: `confluence_list_spaces failed: ${formatError(error)}` }],
            };
        }
    });
    tool("core", "read", "confluence_get_page_by_title", {
        title: "Get Confluence page by title",
        description: "Get a Confluence Data Center page by its space key and exact title, returning the same " +
            "content as confluence_get_page. Useful because people refer to pages by title, while page " +
            "IDs generally only appear in URLs. Read-only.",
        inputSchema: {
            spaceKey: z.string().describe("Space key, e.g. 'ENG'"),
            title: z.string().describe("Exact page title"),
        },
    }, async ({ spaceKey, title }) => {
        try {
            const page = await confluenceClient.getPageByTitle(spaceKey, title);
            return {
                content: [{ type: "text", text: JSON.stringify(page) }],
            };
        }
        catch (error) {
            return {
                isError: true,
                content: [
                    { type: "text", text: `confluence_get_page_by_title failed: ${formatError(error)}` },
                ],
            };
        }
    });
    tool("core", "read", "confluence_get_page_children", {
        title: "List Confluence child pages",
        description: "List the direct child pages of a Confluence Data Center page, with id, title, space and " +
            "URL. Use it to walk a documentation tree without guessing at CQL. Read-only.",
        inputSchema: {
            pageId: numericIdSchema.describe("Confluence page ID, e.g. '601156620'"),
            limit: z
                .number()
                .int()
                .positive()
                .max(500)
                .optional()
                .describe("Maximum children to return (default 100)"),
        },
    }, async ({ pageId, limit }) => {
        try {
            const children = await confluenceClient.getPageChildren(pageId, limit ?? 100);
            return {
                content: [
                    {
                        type: "text",
                        text: children.children.length === 0
                            ? "This page has no child pages."
                            : JSON.stringify(children),
                    },
                ],
            };
        }
        catch (error) {
            return {
                isError: true,
                content: [
                    { type: "text", text: `confluence_get_page_children failed: ${formatError(error)}` },
                ],
            };
        }
    });
    tool("core", "read", "confluence_list_comments", {
        title: "List Confluence comments",
        description: "List comments on a Confluence Data Center page, including comment IDs, authors, creation " +
            "dates, versions, and readable bodies. Read-only.",
        inputSchema: {
            pageId: numericIdSchema.describe("Confluence page ID, e.g. '601156620'"),
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
                        text: comments.comments.length === 0 ? "No comments found." : JSON.stringify(comments),
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
            pageId: numericIdSchema.describe("Confluence page ID, e.g. '601156620'"),
            body: textFieldSchema.describe("Comment body as plain text or simple HTML"),
        },
    }, async ({ pageId, body }) => {
        try {
            const result = await confluenceClient.addComment(pageId, body);
            return { content: [{ type: "text", text: JSON.stringify(result) }] };
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
            commentId: numericIdSchema.describe("Comment ID returned by confluence_list_comments"),
            body: textFieldSchema.describe("Replacement comment body as plain text or simple HTML"),
        },
        // Replaces the existing comment body; the previous wording is gone.
        annotations: { destructiveHint: true },
    }, async ({ commentId, body }) => {
        try {
            const result = await confluenceClient.updateComment(commentId, body);
            return { content: [{ type: "text", text: JSON.stringify(result) }] };
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
            commentId: numericIdSchema.describe("Comment ID returned by confluence_list_comments"),
        },
    }, async ({ commentId }) => {
        try {
            const result = await confluenceClient.deleteComment(commentId);
            return { content: [{ type: "text", text: JSON.stringify(result) }] };
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
    tool("files", "read", "confluence_list_attachments", {
        title: "List Confluence page attachments",
        description: "List files attached to a Confluence Data Center page, with id, title, media type, size, " +
            "author and creation date. Read-only.",
        inputSchema: {
            pageId: numericIdSchema.describe("Confluence page ID, e.g. '601156620'"),
            limit: z
                .number()
                .int()
                .positive()
                .max(500)
                .optional()
                .describe("Maximum attachments to return (default 100)"),
        },
    }, async ({ pageId, limit }) => {
        try {
            const attachments = await confluenceClient.listAttachments(pageId, limit ?? 100);
            return {
                content: [
                    {
                        type: "text",
                        text: attachments.length === 0
                            ? "This page has no attachments."
                            : JSON.stringify(attachments),
                    },
                ],
            };
        }
        catch (error) {
            return {
                isError: true,
                content: [
                    { type: "text", text: `confluence_list_attachments failed: ${formatError(error)}` },
                ],
            };
        }
    });
    tool("files", "local", "confluence_download_attachment", {
        title: "Download a Confluence attachment",
        description: "Download a Confluence Data Center page attachment to an explicit absolute path on the " +
            "local machine. The path must sit inside ATLASSIAN_ATTACHMENT_DIRS, which is empty by " +
            "default, so this is disabled until deliberately enabled. Writes a local file but does not " +
            "modify Confluence.",
        inputSchema: {
            pageId: numericIdSchema.describe("Confluence page ID the attachment belongs to"),
            attachmentId: z.string().describe("Attachment ID returned by confluence_list_attachments"),
            outputPath: z.string().describe("Absolute local destination path, including filename"),
        },
    }, async ({ pageId, attachmentId, outputPath }) => {
        try {
            const result = await confluenceClient.downloadAttachment(pageId, attachmentId, outputPath);
            return { content: [{ type: "text", text: JSON.stringify(result) }] };
        }
        catch (error) {
            return {
                isError: true,
                content: [
                    { type: "text", text: `confluence_download_attachment failed: ${formatError(error)}` },
                ],
            };
        }
    });
    tool("core", "read", "confluence_get_page_history", {
        title: "Get Confluence page history",
        description: "Get a Confluence Data Center page's version history: version number, author, timestamp, " +
            "edit message and whether it was a minor edit. Useful for judging whether a page is still " +
            "current. Read-only.",
        inputSchema: {
            pageId: numericIdSchema.describe("Confluence page ID, e.g. '601156620'"),
            limit: z
                .number()
                .int()
                .positive()
                .max(200)
                .optional()
                .describe("Maximum versions to return (default 50)"),
        },
    }, async ({ pageId, limit }) => {
        try {
            const history = await confluenceClient.getPageHistory(pageId, limit ?? 50);
            return {
                content: [
                    {
                        type: "text",
                        text: history.length === 0
                            ? "No version history was returned for this page."
                            : JSON.stringify(history),
                    },
                ],
            };
        }
        catch (error) {
            return {
                isError: true,
                content: [
                    { type: "text", text: `confluence_get_page_history failed: ${formatError(error)}` },
                ],
            };
        }
    });
    tool("write", "destructive", "confluence_delete_page", {
        title: "Delete a Confluence page",
        description: "Delete a Confluence Data Center page. Mutates data: Confluence moves the page to the " +
            "space's trash rather than erasing it, so an admin can restore it, but treat this as " +
            "destructive. Child pages are affected too — check confluence_get_page_children first.",
        inputSchema: {
            pageId: numericIdSchema.describe("Confluence page ID to delete"),
        },
    }, async ({ pageId }) => {
        try {
            const result = await confluenceClient.deletePage(pageId);
            return { content: [{ type: "text", text: JSON.stringify(result) }] };
        }
        catch (error) {
            return {
                isError: true,
                content: [
                    { type: "text", text: `confluence_delete_page failed: ${formatError(error)}` },
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
            title: titleFieldSchema.describe("Page title"),
            body: textFieldSchema
                .describe("Page content, as plain text or simple HTML"),
            parentId: numericIdSchema
                .optional()
                .describe("Parent page ID, to create this page as a child of an existing page"),
        },
    }, async ({ spaceKey, title, body, parentId }) => {
        try {
            const result = await confluenceClient.createPage({ spaceKey, title, body, parentId });
            return {
                content: [{ type: "text", text: JSON.stringify(result) }],
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
            "it unchanged. Never pass the output of confluence_get_page back in as `body`: that tool " +
            "returns a lossy plain-text rendering, and writing it back destroys the page's macros, " +
            "tables and layouts — edit the storage-format HTML you intend to keep instead.",
        inputSchema: {
            pageId: numericIdSchema.describe("Confluence page ID, e.g. '123456'"),
            title: titleFieldSchema.optional().describe("New page title (omit to keep the current title)"),
            body: textFieldSchema
                .optional()
                .describe("New page content, as plain text or simple HTML (omit to keep the current content)"),
        },
        // Replaces the page body wholesale — no merge with what is already there.
        annotations: { destructiveHint: true },
        validate: ({ title, body }) =>
            title === undefined && body === undefined
                ? "nothing to update — supply at least one of: title, body. An update with neither " +
                  "still issues a PUT that burns a page version and notifies every watcher."
                : undefined,
    }, async ({ pageId, title, body }) => {
        try {
            const result = await confluenceClient.updatePage(pageId, { title, body });
            return {
                content: [{ type: "text", text: JSON.stringify(result) }],
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
    // 5.15: a malformed frame on stdin is otherwise swallowed whole. The SDK's
    // ReadBuffer reports the parse failure through the protocol's `onerror`
    // hook; with nobody listening, nothing reaches stderr and the client sits
    // there until its own timeout. Note this is set on the protocol rather than
    // on the transport, because Protocol.connect() overwrites transport.onerror.
    server.server.onerror = (error: unknown) => {
        // eslint-disable-next-line no-console
        console.error(
            `mcp-atlassian protocol error: ${error instanceof Error ? error.message : String(error)}`,
        );
    };
    await server.connect(transport);

    // 5.16: without these, a SIGTERM mid-download leaves a partial file behind,
    // and because attachments are written with O_CREAT|O_EXCL every retry then
    // fails with "already exists".
    let shuttingDown = false;
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
        process.on(signal, () => {
            if (shuttingDown) return;
            shuttingDown = true;
            // eslint-disable-next-line no-console
            console.error(`mcp-atlassian received ${signal}, closing down`);
            void server
                .close()
                .catch(() => undefined)
                .finally(() => process.exit(0));
        });
    }
    // stdout carries the JSON-RPC stream, so all diagnostics go to stderr.
    // Report the resolved surface: without it, a profile typo silently hides
    // tools and looks like a client bug.
    const profile = process.env.ATLASSIAN_PROFILE?.trim() || "full";
    const groups = [...config.enabledGroups].sort().join(", ");
    // Startup banner goes to stderr on purpose (see comment above).
    // eslint-disable-next-line no-console
    console.error(
        `mcp-atlassian started (stdio). profile=${profile} groups=[${groups}] ` +
            `tools=${registered.length}${config.readOnly ? " READ-ONLY" : ""} ` +
            `destructive=${config.allowDestructive && !config.readOnly ? "ENABLED" : "disabled"} ` +
            `attachments=${config.attachmentDirs.length > 0 ? "enabled" : "disabled"} ` +
            `timeout=${config.timeoutMs}ms totalTimeout=${config.totalTimeoutMs}ms ` +
            `concurrency=${config.maxConcurrentRequests} queue=${config.maxQueuedRequests}`,
    );
}
main().catch((error) => {
    // Startup errors (e.g. missing env vars) should be clear and fatal.
    // eslint-disable-next-line no-console
    console.error(`mcp-atlassian failed to start: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
});

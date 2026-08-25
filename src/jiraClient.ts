/**
 * Client for Jira Data Center REST API (v2), authenticating with a
 * Personal Access Token. Supports both read-only lookups and write
 * (mutating) operations such as creating/updating issues, commenting,
 * and transitioning issues between statuses.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { atlassianDelete, atlassianGet, atlassianGetBinary, atlassianPost, atlassianPostFormData, atlassianPut, AtlassianHttpError, } from "./httpClient.js";
import { decodeProformaDesign, formatProformaAnswer, getProformaChunkCount, } from "./proforma.js";

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
}

export interface JiraIssueSummary {
    key: string;
    summary: string;
    status: string;
    assignee: string;
    issueType: string;
    priority: string;
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
    comments: JiraCommentSummary[];
}

export interface JiraIssueFieldValue {
    id: string;
    name: string;
    custom: boolean;
    value: any;
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
}

export interface JiraProformaForm extends JiraProformaFormSummary {
    status: string;
    answeredQuestions: number;
    totalQuestions: number;
    answers: JiraProformaAnswer[];
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
        for (const item of history.items || []) {
            if (item.field !== "status")
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
export class JiraClient {
    private readonly options: ClientOptions;
    constructor(options: ClientOptions) {
        this.options = options;
    }
    /**
     * Rejects any attachment path outside the configured allowlist. Paths are
     * resolved first so that `..` segments and symlink-style traversal cannot
     * escape an allowed directory.
     */
    private assertAttachmentPathAllowed(candidate: string, label: string): string {
        if (!isAbsolute(candidate)) {
            throw new Error(`Attachment ${label} must be an absolute path`);
        }
        const allowed = this.options.attachmentDirs ?? [];
        if (allowed.length === 0) {
            throw new Error(
                "Attachment access is disabled. Set ATLASSIAN_ATTACHMENT_DIRS to a " +
                    "colon-separated list of directories to enable it.",
            );
        }
        const resolved = resolve(candidate);
        const permitted = allowed.some((dir) => {
            const root = resolve(dir);
            const rel = relative(root, resolved);
            return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
        });
        if (!permitted) {
            throw new Error(
                `Attachment ${label} "${resolved}" is outside the allowed directories ` +
                    `(${allowed.join(", ")}).`,
            );
        }
        return resolved;
    }
    async searchIssues(jql: string, maxResults = 20): Promise<JiraIssueSummary[]> {
        const data = await atlassianGet({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path: "/rest/api/2/search",
            query: {
                jql,
                maxResults,
                fields: "summary,status,assignee,issuetype,priority",
            },
        });
        return (data.issues || []).map((issue: any) => ({
            key: issue.key,
            summary: issue.fields.summary || "",
            status: issue.fields.status?.name || "Unknown",
            assignee: userLabel(issue.fields.assignee),
            issueType: issue.fields.issuetype?.name || "Unknown",
            priority: issue.fields.priority?.name || "Unknown",
        }));
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
        return (data.issues || []).map((issue: any) => {
            const raw = issue.fields[storyPointsField];
            return {
                key: issue.key,
                summary: issue.fields.summary || "",
                status: issue.fields.status?.name || "Unknown",
                storyPoints: typeof raw === "number" ? raw : null,
            };
        });
    }
    async getIssue(issueKey: string): Promise<JiraIssueDetails> {
        const issue = await atlassianGet({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path: `/rest/api/2/issue/${encodeURIComponent(issueKey)}`,
            query: {
                fields: "summary,description,status,assignee,reporter,created,updated,comment",
            },
        });
        const comments = (issue.fields.comment?.comments || []).map((c: any) => ({
            author: userLabel(c.author),
            body: c.body || "",
            created: c.created || "",
        }));
        return {
            key: issue.key,
            summary: issue.fields.summary || "",
            description: issue.fields.description || "",
            status: issue.fields.status?.name || "Unknown",
            assignee: userLabel(issue.fields.assignee),
            reporter: userLabel(issue.fields.reporter),
            created: issue.fields.created || "",
            updated: issue.fields.updated || "",
            comments,
        };
    }
    async getIssueFields(issueKey: string, fieldNames: string[] = [], includeEmpty = false): Promise<JiraIssueFieldValue[]> {
        const definitions = await atlassianGet({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path: "/rest/api/2/field",
        });
        const requested = new Set(fieldNames.map((name) => name.toLocaleLowerCase()));
        const selected = requested.size === 0
            ? definitions.filter((field: any) => !["attachment", "comment", "worklog"].includes(field.id))
            : definitions.filter((field: any) => requested.has(field.id.toLocaleLowerCase()) ||
                requested.has(field.name.toLocaleLowerCase()));
        if (requested.size > 0 && selected.length === 0) {
            throw new Error(`No Jira fields matched: ${fieldNames.join(", ")}`);
        }
        const issue = await atlassianGet({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path: `/rest/api/2/issue/${encodeURIComponent(issueKey)}`,
            query: { fields: selected.map((field: any) => field.id).join(",") },
        });
        return selected
            .filter((field: any) => includeEmpty || hasFieldValue(issue.fields[field.id]))
            .map((field: any) => ({
            id: field.id,
            name: field.name,
            custom: field.custom === true,
            value: issue.fields[field.id],
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
        return (index.forms || []).map((form: any) => ({
            id: form.id,
            templateId: form.templateId ?? null,
            name: form.name?.trim() || `Form ${form.id}`,
            submitted: form.submitted === true,
            created: form.created || "",
            updated: form.updated || "",
        }));
    }
    async getProformaForm(issueKey: string, formId: number, includeEmpty = false): Promise<JiraProformaForm> {
        const metadata = (await this.listProformaForms(issueKey)).find((form: JiraProformaFormSummary) => form.id === formId);
        if (!metadata) {
            throw new Error(`ProForma form ${formId} was not found on issue ${issueKey}`);
        }
        const propertyKey = `proforma.forms.i${formId}`;
        const root = await this.getIssueProperty(issueKey, propertyKey);
        const chunkCount = getProformaChunkCount(root);
        const additionalChunks = await Promise.all(Array.from({ length: Math.max(0, chunkCount - 1) }, (_, index) => this.getIssueProperty(issueKey, `${propertyKey}.${index + 1}`)));
        const design = decodeProformaDesign(root, additionalChunks);
        const questions = design.questions || {};
        const stateAnswers = root.state?.answers || {};
        const rawStatus = root.state?.status;
        const answers = Object.entries(stateAnswers)
            .map(([questionId, rawAnswer]) => {
            const question = questions[questionId];
            return {
                questionId,
                label: question?.label?.trim() || `Question ${questionId}`,
                type: question?.type || "unknown",
                answer: formatProformaAnswer(rawAnswer, question),
                rawAnswer,
            };
        })
            .filter((answer) => includeEmpty || answer.answer !== "");
        return {
            ...metadata,
            status: rawStatus === "s"
                ? "submitted"
                : rawStatus === "o"
                    ? "open"
                    : rawStatus || (metadata.submitted ? "submitted" : "open"),
            answeredQuestions: answers.filter((answer) => answer.answer !== "").length,
            totalQuestions: Object.keys(stateAnswers).length > 0
                ? Object.keys(stateAnswers).length
                : Object.keys(questions).length,
            answers,
        };
    }
    async getProformaFormsSummary(issueKey: string, includeEmpty = false): Promise<JiraProformaForm[]> {
        const forms = await this.listProformaForms(issueKey);
        return Promise.all(forms.map((form: JiraProformaFormSummary) => this.getProformaForm(issueKey, form.id, includeEmpty)));
    }
    async listAttachments(issueKey: string): Promise<JiraAttachmentSummary[]> {
        const issue = await atlassianGet({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path: `/rest/api/2/issue/${encodeURIComponent(issueKey)}`,
            query: { fields: "attachment" },
        });
        return (issue.fields.attachment || []).map((attachment: any) => ({
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
        const safeOutputPath = this.assertAttachmentPathAllowed(outputPath, "outputPath");
        const metadata = await atlassianGet({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path: `/rest/api/2/attachment/${encodeURIComponent(attachmentId)}`,
        });
        if (!metadata.content) {
            throw new Error(`Jira attachment ${attachmentId} has no content URL`);
        }
        const response = await atlassianGetBinary({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path: metadata.content,
        });
        await mkdir(dirname(safeOutputPath), { recursive: true });
        await writeFile(safeOutputPath, response.data);
        return {
            id: attachmentId,
            outputPath: safeOutputPath,
            bytesWritten: response.data.byteLength,
            contentType: response.contentType,
        };
    }
    async uploadAttachment(issueKey: string, filePath: string, mimeType = "application/octet-stream"): Promise<JiraAttachmentSummary[]> {
        const safeFilePath = this.assertAttachmentPathAllowed(filePath, "filePath");
        const data = await readFile(safeFilePath);
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
        return response.issueLinkTypes || [];
    }
    async getIssueLinks(issueKey: string): Promise<JiraIssueLinkSummary[]> {
        const issue = await atlassianGet({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path: `/rest/api/2/issue/${encodeURIComponent(issueKey)}`,
            query: { fields: "issuelinks" },
        });
        return (issue.fields.issuelinks || []).map((link: any) => {
            const direction = link.outwardIssue ? "outward" : "inward";
            const linkedIssue = link.outwardIssue || link.inwardIssue;
            return {
                id: link.id,
                type: link.type.name,
                direction,
                description: direction === "outward" ? link.type.outward : link.type.inward,
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
    async transitionIssue(issueKey: string, targetStatusName: string): Promise<JiraTransitionResult> {
        const { transitions } = await atlassianGet({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path: `/rest/api/2/issue/${encodeURIComponent(issueKey)}/transitions`,
        });
        const normalizedTarget = targetStatusName.trim().toLowerCase();
        const match = (transitions || []).find((t: any) => {
            const name = (t.to?.name || t.name || "").toLowerCase();
            return name === normalizedTarget;
        });
        if (!match) {
            const available = (transitions || []).map((t: any) => t.to?.name || t.name).join(", ") || "(none)";
            throw new Error(`No transition to status "${targetStatusName}" is available for ${issueKey}. ` +
                `Available transitions: ${available}`);
        }
        await atlassianPost({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path: `/rest/api/2/issue/${encodeURIComponent(issueKey)}/transitions`,
            body: { transition: { id: match.id } },
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
    async getIssueChangelogViaDedicatedEndpoint(issueKey: string): Promise<JiraIssueChangelog> {
        const transitions: JiraStatusTransition[] = [];
        const maxResults = 100;
        let startAt = 0;
        while (true) {
            const page = await atlassianGet({
                baseUrl: this.options.baseUrl,
                pat: this.options.pat,
                path: `/rest/api/2/issue/${encodeURIComponent(issueKey)}/changelog`,
                query: { startAt, maxResults },
            });
            const values = page.values || [];
            collectStatusTransitions(values, transitions);
            startAt += values.length;
            const isLast = page.isLast !== undefined ? page.isLast : values.length === 0;
            if (isLast || values.length === 0 || startAt >= page.total) {
                break;
            }
        }
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
        collectStatusTransitions(issue.changelog?.histories || [], transitions);
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
    /**
     * Batch-friendly wrapper for computing cycle time across many issues in
     * one MCP round-trip. Individual failures (e.g. issue not found) are
     * caught and reported as a null-result entry rather than failing the
     * whole batch.
     */
    async getIssuesCycleTime(issueKeys: string[], fromStatus: string, toStatus: string): Promise<JiraIssueCycleTime[]> {
        return Promise.all(issueKeys.map(async (issueKey: string) => {
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
        }));
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
        return Promise.all(issueKeys.map(async (issueKey: string) => {
            try {
                return await this.getIssueDevStatus(issueKey);
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                return { key: issueKey, branches: [], pullRequests: [], commits: [], note: message };
            }
        }));
    }
}

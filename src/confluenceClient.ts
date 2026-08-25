/**
 * Client for Confluence Data Center REST API, authenticating with a
 * Personal Access Token. Supports both read-only lookups and write
 * (mutating) operations such as creating and updating pages.
 */
import {
    assertAttachmentPathAllowed,
    assertAttachmentSize,
    DEFAULT_MAX_ATTACHMENT_BYTES,
    writeNewAttachment,
} from "./attachmentSecurity.js";
import {
    atlassianDelete,
    atlassianGet,
    atlassianGetBinary,
    atlassianPost,
    atlassianPut,
} from "./httpClient.js";

export interface ClientOptions {
    baseUrl: string;
    pat: string;
    /** Absolute directories attachment downloads may write to. Empty disables them. */
    attachmentDirs?: string[];
    /** Maximum number of bytes accepted for attachment downloads. */
    maxAttachmentBytes?: number;
}

export interface ConfluenceAttachment {
    id: string;
    title: string;
    mediaType: string;
    fileSize: number;
    author: string;
    created: string;
    downloadPath: string;
}

export interface ConfluenceAttachmentDownload {
    id: string;
    title: string;
    outputPath: string;
    bytesWritten: number;
    contentType: string;
}

export interface ConfluencePageVersion {
    number: number;
    by: string;
    when: string;
    message: string;
    minorEdit: boolean;
}

export interface ConfluenceDeleteResult {
    id: string;
    deleted: boolean;
}

export interface ConfluencePageSummary {
    id: string;
    title: string;
    space: string;
    url: string;
}

export interface ConfluenceSpaceSummary {
    key: string;
    name: string;
    type: string;
    url: string;
}

/** A page of CQL search results, with enough metadata to detect truncation. */
export interface ConfluenceSearchResult {
    start: number;
    limit: number;
    returned: number;
    total: number;
    hasMore: boolean;
    nextStart: number | null;
    pages: ConfluencePageSummary[];
}

export interface ConfluencePage extends ConfluencePageSummary {
    body: string;
}

export interface CreateConfluencePageOptions {
    spaceKey: string;
    title: string;
    body: string;
    parentId?: string;
}

export interface UpdateConfluencePageOptions {
    title?: string;
    body?: string;
}

export interface ConfluenceCreatedPage {
    id: string;
    title: string;
    url: string;
}

export interface ConfluenceUpdatedPage extends ConfluenceCreatedPage {
    version: number;
}

export interface ConfluenceComment {
    id: string;
    author: string;
    created: string;
    body: string;
    version: number;
    url: string;
}

export interface DeleteConfluenceCommentResult {
    id: string;
    deleted: boolean;
}
/**
 * Very small, dependency-free converter from Confluence "storage format"
 * (an XHTML-based format) to plain text. Strips tags and unescapes basic
 * HTML entities. Not a full HTML parser, but good enough for readable output.
 */
export function storageToPlainText(storage: string): string {
    let text = storage
        // Confluence links: keep the target, not just the label. A page whose
        // links are stripped loses most of its usefulness as a reference.
        .replace(
            /<ac:link[^>]*>[\s\S]*?<ri:page[^>]*ri:content-title="([^"]*)"[^>]*\/>[\s\S]*?<\/ac:link>/gi,
            (_match, title: string) => `[${title}]`,
        )
        .replace(
            /<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi,
            (_match, href: string, label: string) => {
                const cleanLabel = label.replace(/<[^>]+>/g, "").trim();
                if (!cleanLabel) return href;
                return cleanLabel === href ? href : `${cleanLabel} (${href})`;
            },
        )
        // Structured macros carry a name worth keeping as a marker.
        .replace(
            /<ac:structured-macro[^>]*ac:name="([^"]*)"[^>]*\/>/gi,
            (_match, name: string) => `[macro: ${name}]`,
        )
        .replace(
            /<ac:structured-macro[^>]*ac:name="([^"]*)"[^>]*>/gi,
            (_match, name: string) => `\n[macro: ${name}]\n`,
        )
        .replace(/<\/ac:structured-macro>/gi, "\n");

    // Tables become pipe-delimited rows so columns stay aligned with headers
    // instead of collapsing into one run-on line.
    text = text
        .replace(/<\/t[hd]>\s*<t[hd][^>]*>/gi, " | ")
        .replace(/<t[hd][^>]*>/gi, "| ")
        .replace(/<\/t[hd]>/gi, " |")
        .replace(/<\/tr>/gi, "\n")
        .replace(/<\/table>/gi, "\n\n");

    text = text
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/p>/gi, "\n\n")
        .replace(/<\/li>/gi, "\n")
        .replace(/<li[^>]*>/gi, "- ")
        .replace(/<\/h[1-6]>/gi, "\n\n")
        .replace(/<[^>]+>/g, "");

    const unescaped = text
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");
    return unescaped
        .split("\n")
        .map((line: string) => line.trim())
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}
function buildPageUrl(baseUrl: string, webui: string | undefined): string {
    if (!webui)
        return baseUrl;
    return `${baseUrl}${webui.startsWith("/") ? webui : `/${webui}`}`;
}
function escapeHtml(text: string): string {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}
/**
 * Converts plain text or simple HTML into Confluence "storage format".
 * If the input already looks like it contains HTML tags, it's passed
 * through as-is (assumed to already be storage/XHTML-compatible markup).
 * Otherwise, it's escaped and wrapped into `<p>` paragraphs, splitting on
 * blank lines, with single newlines within a paragraph turned into `<br/>`.
 */
/**
 * Recognised block/inline tags plus the Confluence-specific `ac:`/`ri:`
 * namespaces. Matching a real tag name — rather than any `<...>` — stops
 * ordinary prose like "a < b and c > d" or "use <placeholder> here" from
 * being mistaken for markup and passed through unescaped, which produces
 * invalid XHTML and a 400 from Confluence.
 */
const HTML_TAG_PATTERN =
    /<\/?(?:p|br|div|span|h[1-6]|ul|ol|li|table|thead|tbody|tr|t[hd]|a|b|i|u|strong|em|code|pre|blockquote|hr|img|ac:[a-z-]+|ri:[a-z-]+)\b[^>]*>/i;

export function looksLikeStorageMarkup(input: string): boolean {
    return HTML_TAG_PATTERN.test(input);
}

function toStorageValue(input: string): string {
    if (looksLikeStorageMarkup(input)) {
        return input;
    }
    const paragraphs = input
        .split(/\n{2,}/)
        .map((paragraph) => paragraph.trim())
        .filter((paragraph) => paragraph.length > 0)
        .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, "<br/>")}</p>`);
    return paragraphs.join("") || "<p></p>";
}
export class ConfluenceClient {
    private readonly options: ClientOptions;
    constructor(options: ClientOptions) {
        this.options = options;
    }
    async searchPages(cql: string, limit = 20, start = 0): Promise<ConfluenceSearchResult> {
        const data = await atlassianGet({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path: "/rest/api/content/search",
            query: { cql, limit, start },
        });
        const pages: ConfluencePageSummary[] = (data.results || []).map((item: any) => ({
            id: item.id,
            title: item.title,
            space: item.space?.key || item.space?.name || "Unknown",
            url: buildPageUrl(this.options.baseUrl, item._links?.webui),
        }));
        // Confluence reports `totalSize` on search; fall back to what we can
        // infer so callers always get a usable `hasMore` signal.
        const total = typeof data.totalSize === "number" ? data.totalSize : start + pages.length;
        const nextStart = start + pages.length;
        const hasMore = pages.length > 0 && (Boolean(data._links?.next) || nextStart < total);
        return {
            start,
            limit,
            returned: pages.length,
            total,
            hasMore,
            nextStart: hasMore ? nextStart : null,
            pages,
        };
    }
    async getPage(pageId: string): Promise<ConfluencePage> {
        const page = await atlassianGet({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path: `/rest/api/content/${encodeURIComponent(pageId)}`,
            query: { expand: "body.storage,space" },
        });
        const storage = page.body?.storage?.value || "";
        return {
            id: page.id,
            title: page.title,
            space: page.space?.key || page.space?.name || "Unknown",
            url: buildPageUrl(this.options.baseUrl, page._links?.webui),
            body: storage ? storageToPlainText(storage) : "(no content)",
        };
    }
    /**
     * Lists spaces the PAT's owner can see. Without this, a CQL query has to
     * guess space keys.
     */
    async listSpaces(limit = 100): Promise<ConfluenceSpaceSummary[]> {
        const spaces: any[] = [];
        let start = 0;
        while (spaces.length < limit) {
            const pageSize = Math.min(100, limit - spaces.length);
            const response = await atlassianGet({
                baseUrl: this.options.baseUrl,
                pat: this.options.pat,
                path: "/rest/api/space",
                query: { start, limit: pageSize },
            });
            const results = response.results || [];
            spaces.push(...results);
            if (results.length < pageSize) break;
            start += results.length;
        }
        return spaces.slice(0, limit).map((space) => ({
            key: space.key,
            name: space.name || "",
            type: space.type || "",
            url: buildPageUrl(this.options.baseUrl, space._links?.webui),
        }));
    }
    /**
     * Resolves a page by space key and exact title, which is how people
     * actually refer to Confluence pages — page IDs rarely appear outside
     * URLs.
     */
    async getPageByTitle(spaceKey: string, title: string): Promise<ConfluencePage> {
        const response = await atlassianGet({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path: "/rest/api/content",
            query: {
                spaceKey,
                title,
                type: "page",
                expand: "body.storage,space",
                limit: 1,
            },
        });
        const page = (response.results || [])[0];
        if (!page) {
            throw new Error(`No page titled "${title}" was found in space ${spaceKey}.`);
        }
        const storage = page.body?.storage?.value || "";
        return {
            id: page.id,
            title: page.title,
            space: page.space?.key || page.space?.name || spaceKey,
            url: buildPageUrl(this.options.baseUrl, page._links?.webui),
            body: storage ? storageToPlainText(storage) : "(no content)",
        };
    }
    /**
     * Lists the direct child pages of a page, so a documentation tree can be
     * walked without guessing at CQL.
     */
    async getPageChildren(pageId: string, limit = 100): Promise<ConfluencePageSummary[]> {
        const children: any[] = [];
        let start = 0;
        while (children.length < limit) {
            const pageSize = Math.min(100, limit - children.length);
            const response = await atlassianGet({
                baseUrl: this.options.baseUrl,
                pat: this.options.pat,
                path: `/rest/api/content/${encodeURIComponent(pageId)}/child/page`,
                query: { start, limit: pageSize, expand: "space" },
            });
            const results = response.results || [];
            children.push(...results);
            if (results.length < pageSize) break;
            start += results.length;
        }
        return children.slice(0, limit).map((child) => ({
            id: child.id,
            title: child.title,
            space: child.space?.key || child.space?.name || "Unknown",
            url: buildPageUrl(this.options.baseUrl, child._links?.webui),
        }));
    }
    /** Lists files attached to a page. */
    async listAttachments(pageId: string, limit = 100): Promise<ConfluenceAttachment[]> {
        const response = await atlassianGet({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path: `/rest/api/content/${encodeURIComponent(pageId)}/child/attachment`,
            query: { limit, expand: "version,history" },
        });
        return (response.results || []).map((attachment: any) => ({
            id: attachment.id,
            title: attachment.title || "",
            mediaType: attachment.metadata?.mediaType || "application/octet-stream",
            fileSize: attachment.extensions?.fileSize ?? 0,
            author: attachment.history?.createdBy?.displayName
                || attachment.history?.createdBy?.username
                || "Unknown",
            created: attachment.history?.createdDate || "",
            downloadPath: attachment._links?.download || "",
        }));
    }
    /**
     * Downloads a page attachment to an absolute path inside the allowlist.
     * Same reasoning as the Jira side: page content is authored by other
     * people, so an unrestricted write target is a liability.
     */
    async downloadAttachment(
        pageId: string,
        attachmentId: string,
        outputPath: string,
    ): Promise<ConfluenceAttachmentDownload> {
        const safeOutputPath = await assertAttachmentPathAllowed(this.options, outputPath, "outputPath");
        const attachments = await this.listAttachments(pageId);
        const attachment = attachments.find((item) => item.id === attachmentId);
        if (!attachment) {
            throw new Error(`Attachment ${attachmentId} was not found on page ${pageId}.`);
        }
        if (!attachment.downloadPath) {
            throw new Error(`Attachment ${attachmentId} has no download link.`);
        }
        assertAttachmentSize(this.options, attachment.fileSize, "declared size");
        const response = await atlassianGetBinary({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path: attachment.downloadPath,
            maxResponseBytes: this.options.maxAttachmentBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES,
        });
        assertAttachmentSize(this.options, response.data.byteLength, "download size");
        await writeNewAttachment(this.options, safeOutputPath, response.data);
        return {
            id: attachmentId,
            title: attachment.title,
            outputPath: safeOutputPath,
            bytesWritten: response.data.byteLength,
            contentType: response.contentType,
        };
    }
    /**
     * Returns a page's version history: who changed it, when, and with what
     * message. Useful for judging whether a page is still current.
     */
    async getPageHistory(pageId: string, limit = 50): Promise<ConfluencePageVersion[]> {
        const response = await atlassianGet({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path: `/rest/experimental/content/${encodeURIComponent(pageId)}/version`,
            query: { limit },
        });
        return (response.results || []).map((version: any) => ({
            number: version.number,
            by: version.by?.displayName || version.by?.username || "Unknown",
            when: version.when || "",
            message: version.message || "",
            minorEdit: version.minorEdit === true,
        }));
    }
    /**
     * Deletes a page. Confluence moves it to the space's trash rather than
     * erasing it, so this is recoverable by an admin — but treat it as
     * destructive.
     */
    async deletePage(pageId: string): Promise<ConfluenceDeleteResult> {
        await atlassianDelete({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path: `/rest/api/content/${encodeURIComponent(pageId)}`,
        });
        return { id: pageId, deleted: true };
    }
    /**
     * Creates a new Confluence page. `body` may be plain text or simple HTML;
     * plain text is wrapped into storage-format paragraphs automatically.
     * Mutates data: POST /rest/api/content.
     */
    async createPage(options: CreateConfluencePageOptions): Promise<ConfluenceCreatedPage> {
        const requestBody: Record<string, any> = {
            type: "page",
            title: options.title,
            space: { key: options.spaceKey },
            body: {
                storage: {
                    value: toStorageValue(options.body),
                    representation: "storage",
                },
            },
        };
        if (options.parentId) {
            requestBody.ancestors = [{ id: options.parentId }];
        }
        const created = await atlassianPost({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path: "/rest/api/content",
            body: requestBody,
        });
        return {
            id: created.id,
            title: created.title,
            url: buildPageUrl(this.options.baseUrl, created._links?.webui),
        };
    }
    /**
     * Updates an existing Confluence page's title and/or content. Confluence's
     * content API requires the current `version.number` to be incremented on
     * every update, so this fetches the current page first and then issues
     * the PUT with `version.number + 1` — callers just pass the new title
     * and/or body. Mutates data: GET then PUT /rest/api/content/{id}.
     */
    async updatePage(pageId: string, options: UpdateConfluencePageOptions): Promise<ConfluenceUpdatedPage> {
        const current = await atlassianGet({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path: `/rest/api/content/${encodeURIComponent(pageId)}`,
            query: { expand: "version,space,body.storage" },
        });
        const nextVersion = (current.version?.number ?? 1) + 1;
        const newTitle = options.title ?? current.title;
        const newStorageValue = options.body !== undefined
            ? toStorageValue(options.body)
            : current.body?.storage?.value || "";
        const updated = await atlassianPut({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path: `/rest/api/content/${encodeURIComponent(pageId)}`,
            body: {
                id: pageId,
                type: "page",
                title: newTitle,
                space: current.space ? { key: current.space.key } : undefined,
                body: {
                    storage: {
                        value: newStorageValue,
                        representation: "storage",
                    },
                },
                version: { number: nextVersion },
            },
        });
        return {
            id: updated.id,
            title: updated.title,
            url: buildPageUrl(this.options.baseUrl, updated._links?.webui),
            version: nextVersion,
        };
    }
    async listComments(pageId: string, limit = 100): Promise<ConfluenceComment[]> {
        const comments: any[] = [];
        let start = 0;
        while (comments.length < limit) {
            const pageSize = Math.min(100, limit - comments.length);
            const response = await atlassianGet({
                baseUrl: this.options.baseUrl,
                pat: this.options.pat,
                path: `/rest/api/content/${encodeURIComponent(pageId)}/child/comment`,
                query: {
                    expand: "body.storage,version,history.createdBy",
                    start,
                    limit: pageSize,
                },
            });
            const results = response.results || [];
            comments.push(...results);
            if (results.length < pageSize || !response._links?.next)
                break;
            start += results.length;
        }
        return comments.slice(0, limit).map((comment) => this.mapComment(comment));
    }
    async addComment(pageId: string, body: string): Promise<ConfluenceComment> {
        const created = await atlassianPost({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path: "/rest/api/content",
            body: {
                type: "comment",
                container: { id: pageId, type: "page" },
                body: {
                    storage: {
                        value: toStorageValue(body),
                        representation: "storage",
                    },
                },
            },
        });
        return this.mapComment(created);
    }
    async updateComment(commentId: string, body: string): Promise<ConfluenceComment> {
        const current = await atlassianGet({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path: `/rest/api/content/${encodeURIComponent(commentId)}`,
            query: { expand: "body.storage,version,history.createdBy" },
        });
        const nextVersion = (current.version?.number ?? 1) + 1;
        const updated = await atlassianPut({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path: `/rest/api/content/${encodeURIComponent(commentId)}`,
            body: {
                id: commentId,
                type: "comment",
                title: current.title,
                body: {
                    storage: {
                        value: toStorageValue(body),
                        representation: "storage",
                    },
                },
                version: { number: nextVersion },
            },
        });
        return this.mapComment({ ...updated, version: { number: nextVersion } });
    }
    async deleteComment(commentId: string): Promise<DeleteConfluenceCommentResult> {
        await atlassianDelete({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path: `/rest/api/content/${encodeURIComponent(commentId)}`,
        });
        return { id: commentId, deleted: true };
    }
    mapComment(comment: any): ConfluenceComment {
        const author = comment.history?.createdBy;
        const storage = comment.body?.storage?.value || "";
        return {
            id: comment.id,
            author: author?.displayName || author?.username || "Unknown",
            created: comment.history?.createdDate || "",
            body: storage ? storageToPlainText(storage) : "",
            version: comment.version?.number || 1,
            url: buildPageUrl(this.options.baseUrl, comment._links?.webui),
        };
    }
}

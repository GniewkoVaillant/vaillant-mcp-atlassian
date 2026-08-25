/**
 * Client for Confluence Data Center REST API, authenticating with a
 * Personal Access Token. Supports both read-only lookups and write
 * (mutating) operations such as creating and updating pages.
 */
import { atlassianDelete, atlassianGet, atlassianPost, atlassianPut } from "./httpClient.js";

export interface ClientOptions {
    baseUrl: string;
    pat: string;
}

export interface ConfluencePageSummary {
    id: string;
    title: string;
    space: string;
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
function storageToPlainText(storage: string): string {
    const withoutTags = storage
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/p>/gi, "\n\n")
        .replace(/<\/li>/gi, "\n")
        .replace(/<li[^>]*>/gi, "- ")
        .replace(/<\/h[1-6]>/gi, "\n\n")
        .replace(/<[^>]+>/g, "");
    const unescaped = withoutTags
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
function toStorageValue(input: string): string {
    if (/<[a-z][\s\S]*>/i.test(input)) {
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

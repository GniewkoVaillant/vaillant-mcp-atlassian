/**
 * Client for Confluence Data Center REST API, authenticating with a
 * Personal Access Token. Supports both read-only lookups and write
 * (mutating) operations such as creating and updating pages.
 */
import { Parser } from "htmlparser2";

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
import { requireUpstreamArray, requireUpstreamObject } from "./upstreamShape.js";

/** Gate for a Confluence response envelope; an empty 200 body decodes to `undefined`. */
function requireResponseObject(value: unknown, description: string): Record<string, any> {
    return requireUpstreamObject("Confluence", value, description);
}

/** Gate for a list Confluence is expected to return; absent means empty, present-but-not-a-list is broken. */
function requireOptionalArray(value: unknown, description: string): any[] {
    return requireUpstreamArray("Confluence", value, description);
}

export interface ClientOptions {
    baseUrl: string;
    pat: string;
    /** Absolute directories attachment downloads may write to. Empty disables them. */
    attachmentDirs?: string[];
    /** Maximum number of bytes accepted for attachment downloads. */
    maxAttachmentBytes?: number;
    /** Maximum number of pages fetched by any one automatically paginated call. */
    maxPaginationPages?: number;
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

/** Offset-pagination metadata shared by every paginated Confluence result. */
export interface ConfluencePaginationInfo {
    /** Offset the returned window starts at. */
    start: number;
    /** Maximum number of items the caller asked for. */
    limit: number;
    /** Number of items actually returned. */
    returned: number;
    /** Total the server reported, or the number fetched when it reports none. */
    total: number;
    /** True when the collection continues past the returned window. */
    hasMore: boolean;
    /** Offset to pass as `start` to fetch the next window, or null at the end. */
    nextStart: number | null;
}

/** A page of CQL search results, with enough metadata to detect truncation. */
export interface ConfluenceSearchResult extends ConfluencePaginationInfo {
    pages: ConfluencePageSummary[];
}

/** A page of spaces, with enough metadata to detect truncation. */
export interface ConfluenceSpaceListResult extends ConfluencePaginationInfo {
    spaces: ConfluenceSpaceSummary[];
}

/** A page of child pages, with enough metadata to detect truncation. */
export interface ConfluencePageChildrenResult extends ConfluencePaginationInfo {
    children: ConfluencePageSummary[];
}

/** A page of comments, with enough metadata to detect truncation. */
export interface ConfluenceCommentListResult extends ConfluencePaginationInfo {
    comments: ConfluenceComment[];
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
 * Converter from Confluence "storage format" (an XHTML dialect) to plain
 * text. Storage format is XML, so it is parsed with `htmlparser2` in a
 * single linear pass instead of being scanned with regexes: every marker
 * below is scoped to the element that produced it. The regex version paired
 * an `<ac:link>` with any `<ri:page>` that appeared later in the document
 * and silently dropped everything in between, and its two sequential lazy
 * quantifiers made whole-document matching roughly cubic. A parser can do
 * neither. Output is deliberately identical to the old converter for
 * well-formed input, down to decoding the same six entities at the very end.
 */
const CELL_TAGS = new Set(["th", "td"]);
const HEADING_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);
/** Whitespace directly inside these is table layout, never content. */
const TABLE_LAYOUT_TAGS = new Set(["table", "thead", "tbody", "tfoot", "tr"]);

interface OpenElement {
    name: string;
    selfClosing: boolean;
}

/**
 * `<a>` and `<ac:link>` render from their whole subtree, so their content is
 * captured rather than written straight out.
 */
interface CaptureFrame {
    tag: string;
    depth: number;
    text: string[];
    href: string | null;
    pageTitle: string | null;
}

/** Attribute lookup that tolerates the casing a hand-written page may use. */
function attributeValue(
    attributes: Record<string, string>,
    name: string,
): string | undefined {
    const direct = attributes[name];
    if (direct !== undefined)
        return direct;
    for (const [key, value] of Object.entries(attributes)) {
        if (key.toLowerCase() === name)
            return value;
    }
    return undefined;
}

export function storageToPlainText(storage: string): string {
    const out: string[] = [];
    const open: OpenElement[] = [];
    const captures: CaptureFrame[] = [];
    let pendingCellClose = false;

    const emitText = (value: string): void => {
        const frame = captures[captures.length - 1];
        if (frame)
            frame.text.push(value);
        else
            out.push(value);
    };
    // Structural markers used to be applied only after link labels had been
    // extracted, so they never leaked into a label. Keep that behaviour.
    const emitMarker = (value: string): void => {
        if (captures.length === 0)
            out.push(value);
    };
    const closeRow = (): void => {
        if (pendingCellClose) {
            emitMarker(" |");
            pendingCellClose = false;
        }
    };
    const resolveFrame = (frame: CaptureFrame): string => {
        if (frame.tag === "ac:link") {
            return frame.pageTitle === null ? frame.text.join("") : `[${frame.pageTitle}]`;
        }
        const href = frame.href ?? "";
        const label = frame.text.join("").trim();
        if (!label || label === href)
            return href;
        return `${label} (${href})`;
    };

    const parser: Parser = new Parser({
        onopentag(name, attributes) {
            const tag = name.toLowerCase();
            // In XML mode a self-closing tag is reported as an open/close
            // pair, and only the source tells the two apart.
            const selfClosing = storage[parser.endIndex - 1] === "/";
            open.push({ name: tag, selfClosing });
            switch (tag) {
                case "a": {
                    const href = attributeValue(attributes, "href");
                    if (href !== undefined) {
                        captures.push({ tag, depth: open.length - 1, text: [], href, pageTitle: null });
                    }
                    break;
                }
                case "ac:link":
                    captures.push({ tag, depth: open.length - 1, text: [], href: null, pageTitle: null });
                    break;
                case "ri:page": {
                    // Only a page reference *inside* a link becomes a link
                    // title; a bare one (macro parameters use them) is
                    // dropped, exactly as before.
                    const title = attributeValue(attributes, "ri:content-title");
                    if (title === undefined)
                        break;
                    for (let index = captures.length - 1; index >= 0; index -= 1) {
                        const frame = captures[index];
                        if (frame.tag !== "ac:link")
                            continue;
                        if (frame.pageTitle === null)
                            frame.pageTitle = title;
                        break;
                    }
                    break;
                }
                case "ac:structured-macro": {
                    const macroName = attributeValue(attributes, "ac:name");
                    if (macroName === undefined)
                        break;
                    emitMarker(selfClosing ? `[macro: ${macroName}]` : `\n[macro: ${macroName}]\n`);
                    break;
                }
                case "br":
                    emitMarker("\n");
                    break;
                case "li":
                    emitMarker("- ");
                    break;
                default:
                    if (CELL_TAGS.has(tag) && captures.length === 0) {
                        emitMarker(pendingCellClose ? " | " : "| ");
                        pendingCellClose = false;
                    }
                    break;
            }
        },
        onclosetag(name) {
            const tag = name.toLowerCase();
            const element = open.pop();
            const frame = captures[captures.length - 1];
            if (frame && frame.tag === tag && frame.depth === open.length) {
                captures.pop();
                emitText(resolveFrame(frame));
                return;
            }
            switch (tag) {
                case "p":
                    emitMarker("\n\n");
                    break;
                case "li":
                    emitMarker("\n");
                    break;
                case "tr":
                    closeRow();
                    emitMarker("\n");
                    break;
                case "table":
                    closeRow();
                    emitMarker("\n\n");
                    break;
                case "ac:structured-macro":
                    if (!element?.selfClosing)
                        emitMarker("\n");
                    break;
                default:
                    if (HEADING_TAGS.has(tag))
                        emitMarker("\n\n");
                    else if (CELL_TAGS.has(tag) && captures.length === 0)
                        pendingCellClose = true;
                    break;
            }
        },
        ontext(value) {
            if (captures.length === 0) {
                const parent = open[open.length - 1]?.name;
                if (parent !== undefined && TABLE_LAYOUT_TAGS.has(parent) && value.trim() === "")
                    return;
            }
            emitText(value);
        },
    }, {
        // XML mode keeps the `ac:`/`ri:` namespaces intact, honours
        // self-closing tags and reads CDATA (code macros) as text instead of
        // discarding it as a bogus comment. Entities stay encoded here so the
        // same six of them are decoded at the end, as they always were.
        xmlMode: true,
        decodeEntities: false,
    });
    parser.write(storage);
    parser.end();

    const unescaped = out
        .join("")
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
const DEFAULT_MAX_PAGINATION_PAGES = 10;
/** Confluence DC caps a single page of results at 100 regardless of `limit`. */
const MAX_CONFLUENCE_PAGE_SIZE = 100;

type PaginationQuery = Record<string, string | number | boolean | undefined>;

/** Internal shape of one automatically paginated fetch. */
interface PaginatedFetch extends ConfluencePaginationInfo {
    items: any[];
}

export class ConfluenceClient {
    private readonly options: ClientOptions;
    private readonly maxPaginationPages: number;
    constructor(options: ClientOptions) {
        this.options = options;
        this.maxPaginationPages = options.maxPaginationPages ?? DEFAULT_MAX_PAGINATION_PAGES;
        if (!Number.isSafeInteger(this.maxPaginationPages) || this.maxPaginationPages <= 0) {
            throw new Error("maxPaginationPages must be a positive safe integer.");
        }
    }

    /**
     * Confluence DC deployments disagree about which pagination metadata they
     * return, and a caching proxy or a cluster without sticky sessions can
     * serve the same offset over and over. Cap upstream calls, reject stalled,
     * empty-too-early and repeated pages instead of silently returning
     * duplicates, and report truncation rather than passing a partial list off
     * as the whole collection. Modelled on
     * `JiraAgileClient.getPaginatedValues`, which solves the same problem.
     */
    private async getPaginatedResults(
        path: string,
        limit: number,
        query: PaginationQuery,
        resourceName: string,
    ): Promise<PaginatedFetch> {
        if (!Number.isSafeInteger(limit) || limit <= 0) {
            throw new Error(`Confluence ${resourceName} pagination requires a positive limit.`);
        }
        const items: any[] = [];
        const seenPageSignatures = new Set<string>();
        let start = 0;
        let total: number | undefined;
        let hasMore = false;

        for (let pageNumber = 1; pageNumber <= this.maxPaginationPages; pageNumber += 1) {
            const pageSize = Math.min(MAX_CONFLUENCE_PAGE_SIZE, limit - items.length);
            const response = await atlassianGet({
                baseUrl: this.options.baseUrl,
                pat: this.options.pat,
                path,
                query: { start, limit: pageSize, ...query },
            });
            const rawResults = response?.results;
            if (rawResults !== undefined && !Array.isArray(rawResults)) {
                throw new Error(
                    `Confluence ${resourceName} pagination returned an invalid results page.`,
                );
            }
            const results: any[] = rawResults ?? [];

            const reportedStart = response?.start;
            if (reportedStart !== undefined && reportedStart !== start) {
                throw new Error(
                    `Confluence ${resourceName} pagination did not advance: requested start=${start}, ` +
                    `but the server returned start=${String(reportedStart)}.`,
                );
            }

            // `size` is this page's length, not the collection's, so it is not
            // a total. Only `totalSize` (search) and `total` are.
            const reportedTotal = response?.totalSize ?? response?.total;
            if (reportedTotal !== undefined) {
                if (!Number.isSafeInteger(reportedTotal) || reportedTotal < 0) {
                    throw new Error(
                        `Confluence ${resourceName} pagination returned an invalid total.`,
                    );
                }
                total = reportedTotal;
            }
            const hasNextLink = Boolean(response?._links?.next);

            if (results.length === 0) {
                if (hasNextLink || (total !== undefined && start < total)) {
                    throw new Error(
                        `Confluence ${resourceName} pagination did not advance: an empty page was ` +
                        `returned at start=${start} before all results were retrieved.`,
                    );
                }
                hasMore = false;
                break;
            }

            const identifiers = results.map((value) => value?.id ?? value?.key);
            if (identifiers.every((identifier) =>
                typeof identifier === "string" || typeof identifier === "number"
            )) {
                const signature = JSON.stringify(identifiers);
                if (seenPageSignatures.has(signature)) {
                    throw new Error(
                        `Confluence ${resourceName} pagination returned a repeated page at ` +
                        `start=${start}; refusing to return duplicated or incomplete data.`,
                    );
                }
                seenPageSignatures.add(signature);
            }

            items.push(...results);
            start += results.length;

            // A short page ends the collection on every Confluence version we
            // have seen; `_links.next` and a reported total are the explicit
            // signals when the server bothers to send them.
            const moreAvailable = hasNextLink
                || (total !== undefined ? start < total : results.length >= pageSize);
            if (!moreAvailable) {
                hasMore = false;
                break;
            }
            hasMore = true;
            if (items.length >= limit)
                break;
            if (pageNumber === this.maxPaginationPages) {
                const totalHint = total === undefined ? "" : ` of ${total}`;
                throw new Error(
                    `Confluence ${resourceName} pagination stopped after the configured limit of ` +
                    `${this.maxPaginationPages} pages (${items.length}${totalHint} results fetched). ` +
                    `Narrow the query or cautiously increase ATLASSIAN_MAX_PAGINATION_PAGES; ` +
                    `partial results were not returned.`,
                );
            }
        }

        // A server that ignores `limit` can overshoot it; never hand back more
        // than was asked for, and say that the rest was cut off.
        const returned = items.length > limit ? items.slice(0, limit) : items;
        if (items.length > limit)
            hasMore = true;
        return {
            items: returned,
            start: 0,
            limit,
            returned: returned.length,
            total: total ?? returned.length,
            hasMore,
            nextStart: hasMore ? returned.length : null,
        };
    }
    async searchPages(cql: string, limit = 20, start = 0): Promise<ConfluenceSearchResult> {
        const data = requireResponseObject(await atlassianGet({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path: "/rest/api/content/search",
            query: { cql, limit, start },
        }), "page search response");
        const pages: ConfluencePageSummary[] = requireOptionalArray(data.results, "page search result list")
            .map((item: any) => ({
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
        const page = requireResponseObject(await atlassianGet({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path: `/rest/api/content/${encodeURIComponent(pageId)}`,
            query: { expand: "body.storage,space" },
        }), `page ${pageId} response`);
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
    async listSpaces(limit = 100): Promise<ConfluenceSpaceListResult> {
        const { items, ...pagination } = await this.getPaginatedResults(
            "/rest/api/space",
            limit,
            {},
            "space",
        );
        return {
            ...pagination,
            spaces: items.map((space: any) => ({
                key: space.key,
                name: space.name || "",
                type: space.type || "",
                url: buildPageUrl(this.options.baseUrl, space._links?.webui),
            })),
        };
    }
    /**
     * Resolves a page by space key and exact title, which is how people
     * actually refer to Confluence pages — page IDs rarely appear outside
     * URLs.
     */
    async getPageByTitle(spaceKey: string, title: string): Promise<ConfluencePage> {
        const response = requireResponseObject(await atlassianGet({
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
        }), `title lookup response for "${title}" in space ${spaceKey}`);
        const page = requireOptionalArray(response.results, `title lookup result list for space ${spaceKey}`)[0];
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
    async getPageChildren(pageId: string, limit = 100): Promise<ConfluencePageChildrenResult> {
        const { items, ...pagination } = await this.getPaginatedResults(
            `/rest/api/content/${encodeURIComponent(pageId)}/child/page`,
            limit,
            { expand: "space" },
            "page children",
        );
        return {
            ...pagination,
            children: items.map((child: any) => ({
                id: child.id,
                title: child.title,
                space: child.space?.key || child.space?.name || "Unknown",
                url: buildPageUrl(this.options.baseUrl, child._links?.webui),
            })),
        };
    }
    /** Lists files attached to a page. */
    async listAttachments(pageId: string, limit = 100): Promise<ConfluenceAttachment[]> {
        const response = requireResponseObject(await atlassianGet({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path: `/rest/api/content/${encodeURIComponent(pageId)}/child/attachment`,
            query: { limit, expand: "version,history" },
        }), `attachment list response for page ${pageId}`);
        return requireOptionalArray(response.results, `attachment list on page ${pageId}`)
            .map((attachment: any) => ({
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
        const response = requireResponseObject(await atlassianGet({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path: `/rest/experimental/content/${encodeURIComponent(pageId)}/version`,
            query: { limit },
        }), `version history response for page ${pageId}`);
        return requireOptionalArray(response.results, `version history on page ${pageId}`)
            .map((version: any) => ({
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
    async listComments(pageId: string, limit = 100): Promise<ConfluenceCommentListResult> {
        const { items, ...pagination } = await this.getPaginatedResults(
            `/rest/api/content/${encodeURIComponent(pageId)}/child/comment`,
            limit,
            { expand: "body.storage,version,history.createdBy" },
            "comment",
        );
        return {
            ...pagination,
            comments: items.map((comment: any) => this.mapComment(comment)),
        };
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

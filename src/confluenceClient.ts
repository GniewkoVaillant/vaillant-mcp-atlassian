/**
 * Client for Confluence Data Center REST API, authenticating with a
 * Personal Access Token. Supports both read-only lookups and write
 * (mutating) operations such as creating and updating pages.
 */
import { Parser } from "htmlparser2";
import { basename } from "node:path";

import {
    assertAttachmentPathAllowed,
    assertAttachmentSize,
    DEFAULT_MAX_ATTACHMENT_BYTES,
    readExistingAttachment,
    writeNewAttachment,
} from "./attachmentSecurity.js";
import {
    atlassianDelete,
    atlassianGet,
    atlassianGetBinary,
    atlassianPost,
    atlassianPostFormData,
    atlassianPut,
    AtlassianHttpError,
} from "./httpClient.js";
import { requireUpstreamArray, requireUpstreamObject, readArray, readId, readNumber, readString } from "./upstreamShape.js";

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

/** One hit from a global (all-entity-type) CQL search. */
export interface ConfluenceSearchHit {
    /** "page", "blogpost", "space", "user", "attachment"… */
    type: string;
    id: string;
    title: string;
    space: string;
    url: string;
    lastModified: string;
}

export interface ConfluenceGlobalSearchResult extends ConfluencePaginationInfo {
    results: ConfluenceSearchHit[];
}

export interface ConfluenceExportedPage {
    id: string;
    title: string;
    space: string;
    version: number;
    format: string;
    /** Rendered HTML, not the lossy plain text `getPage` returns. */
    html: string;
    url: string;
}

export interface ConfluencePageVersionContent {
    id: string;
    title: string;
    space: string;
    version: number;
    /** Raw storage-format markup, safe to write straight back. */
    storage: string;
    /** Plain-text rendering of the same content, for reading. */
    body: string;
}

export interface ConfluenceSpaceDetails {
    key: string;
    name: string;
    type: string;
    description: string;
    homepageId: string;
    homepageTitle: string;
    url: string;
}

export interface ConfluenceLabel {
    name: string;
    prefix: string;
    id: string;
}

export interface ConfluenceRestriction {
    /** "read" or "update". */
    operation: string;
    users: string[];
    groups: string[];
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

    /**
     * Searches every entity type Confluence indexes — pages, blog posts,
     * spaces, users, attachments — rather than content alone.
     *
     * `searchPages` uses `/rest/api/content/search`, which by construction can
     * only ever return content. "Which space is X in" and "who is Y" were
     * therefore unanswerable, even though CQL expresses both.
     */
    async search(cql: string, limit = 20, start = 0): Promise<ConfluenceGlobalSearchResult> {
        const data = requireResponseObject(await atlassianGet({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path: "/rest/api/search",
            // `excerpt=none` keeps the highlighted-snippet HTML out of the
            // payload; it is markup noise that no caller here renders.
            query: { cql, limit, start, excerpt: "none" },
        }), "global search response");
        const results: ConfluenceSearchHit[] = requireOptionalArray(data.results, "global search result list")
            .map((item: unknown) => ({
                type: readString(item, "content", "type") || readString(item, "entityType") || "unknown",
                id: readId(item, "content", "id"),
                title: readString(item, "title") || readString(item, "content", "title"),
                space: readString(item, "resultGlobalContainer", "title")
                    || readString(item, "content", "space", "key"),
                url: buildPageUrl(
                    this.options.baseUrl,
                    readString(item, "url") || readString(item, "content", "_links", "webui"),
                ),
                lastModified: readString(item, "lastModified"),
            }));
        const total = typeof data.totalSize === "number" ? data.totalSize : start + results.length;
        const nextStart = start + results.length;
        const hasMore = results.length > 0 && nextStart < total;
        return {
            start,
            limit,
            returned: results.length,
            total,
            hasMore,
            nextStart: hasMore ? nextStart : null,
            results,
        };
    }

    /** The chain of parent pages above a page, outermost first. */
    async getPageAncestors(pageId: string): Promise<ConfluencePageSummary[]> {
        const page = requireResponseObject(await atlassianGet({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path: `/rest/api/content/${encodeURIComponent(pageId)}`,
            query: { expand: "ancestors,space" },
        }), `ancestor response for page ${pageId}`);
        return requireOptionalArray(page.ancestors, `ancestor list on page ${pageId}`).map((ancestor: unknown) => ({
            id: readId(ancestor, "id"),
            title: readString(ancestor, "title"),
            space: readString(ancestor, "space", "key") || readString(page, "space", "key"),
            url: buildPageUrl(this.options.baseUrl, readString(ancestor, "_links", "webui")),
        }));
    }

    /**
     * Every page beneath a page, at any depth.
     *
     * Deliberately implemented as a CQL `ancestor = …` search rather than the
     * `/descendant/page` sub-path: that sub-path is not in the Data Center REST
     * reference, whereas `ancestor` is a documented CQL field, so this works on
     * instances where the shortcut does not exist.
     */
    async getPageDescendants(pageId: string, limit = 100): Promise<ConfluenceSearchResult> {
        return this.searchPages(`ancestor = ${JSON.stringify(pageId)} and type = page`, limit);
    }

    /**
     * Returns a page rendered for export: fully expanded macros and resolved
     * links, as HTML. `getPage` returns a lossy plain-text rendering that is
     * fine for reading and unusable for reproducing the page elsewhere.
     */
    async exportPage(pageId: string, format: "export_view" | "styled_view" | "view" = "export_view"): Promise<ConfluenceExportedPage> {
        const page = requireResponseObject(await atlassianGet({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path: `/rest/api/content/${encodeURIComponent(pageId)}`,
            query: { expand: `body.${format},space,version` },
        }), `export response for page ${pageId}`);
        return {
            id: page.id,
            title: page.title,
            space: page.space?.key || "",
            version: page.version?.number ?? 1,
            format,
            html: page.body?.[format]?.value || "",
            url: buildPageUrl(this.options.baseUrl, page._links?.webui),
        };
    }

    /**
     * Reads the storage-format body of a specific historical version, so an
     * edit can be reviewed or reverted.
     *
     * Two request shapes, because Data Center disagrees with its own reference
     * here. The documented status values are `any/current/draft/trashed`, and
     * `any` looked like the safe choice — but a real 8.x instance rejects
     * `status=any` outright with a 400, while the undocumented
     * `status=historical` works. So the explicit intent is tried first and the
     * bare `version=N` form, which also resolves an older version, is the
     * fallback.
     */
    async getPageVersion(pageId: string, versionNumber: number): Promise<ConfluencePageVersionContent> {
        if (!Number.isSafeInteger(versionNumber) || versionNumber <= 0) {
            throw new Error("versionNumber must be a positive integer.");
        }
        const expand = "body.storage,version,space";
        let page: Record<string, any>;
        try {
            page = requireResponseObject(await atlassianGet({
                baseUrl: this.options.baseUrl,
                pat: this.options.pat,
                path: `/rest/api/content/${encodeURIComponent(pageId)}`,
                query: { status: "historical", version: versionNumber, expand },
            }), `version ${versionNumber} response for page ${pageId}`);
        } catch (error) {
            // Only a rejected *request shape* is worth retrying differently; a
            // 404 means the version does not exist and retrying would mask it.
            if (!(error instanceof AtlassianHttpError) || error.status !== 400) throw error;
            page = requireResponseObject(await atlassianGet({
                baseUrl: this.options.baseUrl,
                pat: this.options.pat,
                path: `/rest/api/content/${encodeURIComponent(pageId)}`,
                query: { version: versionNumber, expand },
            }), `version ${versionNumber} response for page ${pageId}`);
        }
        const storage = page.body?.storage?.value || "";
        const returnedVersion = page.version?.number;
        // A server that ignores the version parameter would hand back the live
        // page, and restoring "version 3" would then republish version 7.
        if (typeof returnedVersion === "number" && returnedVersion !== versionNumber) {
            throw new Error(
                `Confluence returned version ${returnedVersion} of page ${pageId} when version ` +
                `${versionNumber} was requested; refusing to treat it as the requested version.`,
            );
        }
        return {
            id: page.id || pageId,
            title: page.title || "",
            space: page.space?.key || "",
            version: returnedVersion ?? versionNumber,
            storage,
            body: storage ? storageToPlainText(storage) : "(no content)",
        };
    }

    /**
     * Reverts a page to an earlier version by re-publishing that version's
     * storage body as a new version.
     *
     * Confluence Data Center has no native restore-version operation, so this
     * is read-then-write. It is additive: the intervening versions stay in the
     * history and the revert itself is another version, which is why it can be
     * undone the same way.
     */
    async restorePageVersion(pageId: string, versionNumber: number): Promise<ConfluenceUpdatedPage> {
        const historical = await this.getPageVersion(pageId, versionNumber);
        const current = requireResponseObject(await atlassianGet({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path: `/rest/api/content/${encodeURIComponent(pageId)}`,
            query: { expand: "version,space" },
        }), `current version response for page ${pageId}`);
        const nextVersion = (current.version?.number ?? 1) + 1;
        const currentVersion = current.version?.number ?? 1;
        // Guard against restoring the live version, which would burn a version
        // and notify every watcher for a no-op change.
        if (versionNumber >= currentVersion) {
            throw new Error(
                `Version ${versionNumber} of page ${pageId} is not older than the current version ` +
                `${currentVersion}; there is nothing to restore.`,
            );
        }
        const updated = await atlassianPut({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path: `/rest/api/content/${encodeURIComponent(pageId)}`,
            body: {
                id: pageId,
                type: "page",
                title: historical.title || current.title,
                space: current.space ? { key: current.space.key } : undefined,
                // The historical body is already storage format; passing it
                // through toStorageValue would re-escape valid markup.
                body: { storage: { value: historical.storage, representation: "storage" } },
                version: {
                    number: nextVersion,
                    message: `Restored content of version ${versionNumber}`,
                },
            },
        });
        return {
            id: updated.id,
            title: updated.title,
            url: buildPageUrl(this.options.baseUrl, updated._links?.webui),
            version: nextVersion,
        };
    }

    /**
     * Re-parents a page. Mutates data: PUT /rest/api/content/{id} with a new
     * `ancestors` list, which is the documented way to move a page in the tree.
     * The body is deliberately not sent, so the page content is untouched.
     */
    async movePage(pageId: string, newParentId: string): Promise<ConfluenceUpdatedPage> {
        const current = requireResponseObject(await atlassianGet({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path: `/rest/api/content/${encodeURIComponent(pageId)}`,
            query: { expand: "version,space" },
        }), `move source response for page ${pageId}`);
        if (pageId === newParentId) {
            throw new Error("A page cannot be made its own parent.");
        }
        const nextVersion = (current.version?.number ?? 1) + 1;
        const updated = await atlassianPut({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path: `/rest/api/content/${encodeURIComponent(pageId)}`,
            body: {
                id: pageId,
                type: "page",
                title: current.title,
                ancestors: [{ id: newParentId }],
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

    async getSpace(spaceKey: string): Promise<ConfluenceSpaceDetails> {
        const space = requireResponseObject(await atlassianGet({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path: `/rest/api/space/${encodeURIComponent(spaceKey)}`,
            query: { expand: "description.plain,homepage" },
        }), `space ${spaceKey} response`);
        return {
            key: space.key || spaceKey,
            name: space.name || "",
            type: space.type || "",
            description: space.description?.plain?.value || "",
            homepageId: space.homepage?.id || "",
            homepageTitle: space.homepage?.title || "",
            url: buildPageUrl(this.options.baseUrl, space._links?.webui),
        };
    }

    /** Every page in a space, so a documentation set can be enumerated. */
    async listSpaceContent(spaceKey: string, limit = 50): Promise<ConfluenceSearchResult> {
        // A plain `space = … and type = page` CQL query is the one formulation
        // that is valid on every Data Center version. The `/space/{key}/content`
        // sub-resource and CQL predicates such as `ancestor is empty` would be
        // narrower but are not documented consistently across releases.
        return this.searchPages(`space = ${JSON.stringify(spaceKey)} and type = page`, limit);
    }

    /**
     * Creates a space. Mutates data: POST /rest/api/space, or
     * /rest/api/space/_private for one visible only to its creator.
     */
    async createSpace(options: {
        key: string;
        name: string;
        description?: string;
        isPrivate?: boolean;
    }): Promise<ConfluenceSpaceDetails> {
        const created = await atlassianPost({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path: options.isPrivate ? "/rest/api/space/_private" : "/rest/api/space",
            body: {
                key: options.key,
                name: options.name,
                description: options.description
                    ? { plain: { value: options.description, representation: "plain" } }
                    : undefined,
            },
        });
        return {
            key: created?.key || options.key,
            name: created?.name || options.name,
            type: created?.type || "",
            description: created?.description?.plain?.value || options.description || "",
            homepageId: created?.homepage?.id || "",
            homepageTitle: created?.homepage?.title || "",
            url: buildPageUrl(this.options.baseUrl, created?._links?.webui),
        };
    }

    async updateSpace(spaceKey: string, options: { name?: string; description?: string }): Promise<ConfluenceSpaceDetails> {
        const current = await this.getSpace(spaceKey);
        await atlassianPut({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path: `/rest/api/space/${encodeURIComponent(spaceKey)}`,
            body: {
                key: spaceKey,
                name: options.name ?? current.name,
                description: {
                    plain: {
                        value: options.description ?? current.description,
                        representation: "plain",
                    },
                },
            },
        });
        return this.getSpace(spaceKey);
    }

    /**
     * Deletes a space. Confluence answers 202 and runs the deletion as a
     * long-running task, so success here means "accepted", not "finished" —
     * and unlike a page, a deleted space does not land in a recoverable trash.
     */
    async deleteSpace(spaceKey: string): Promise<{ key: string; accepted: true; note: string }> {
        await atlassianDelete({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path: `/rest/api/space/${encodeURIComponent(spaceKey)}`,
        });
        return {
            key: spaceKey,
            accepted: true,
            note: "Confluence accepted the deletion and runs it as a background task; " +
                "the space and all its content disappear once that task completes.",
        };
    }

    async listLabels(pageId: string): Promise<ConfluenceLabel[]> {
        const response = requireResponseObject(await atlassianGet({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path: `/rest/api/content/${encodeURIComponent(pageId)}/label`,
        }), `label list response for page ${pageId}`);
        return requireOptionalArray(response.results, `label list on page ${pageId}`).map(toLabel);
    }

    /** Adds labels to a page. Additive: existing labels are kept. */
    async addLabels(pageId: string, labels: string[]): Promise<ConfluenceLabel[]> {
        if (labels.length === 0) {
            throw new Error("At least one label is required.");
        }
        const response = requireResponseObject(await atlassianPost({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path: `/rest/api/content/${encodeURIComponent(pageId)}/label`,
            body: labels.map((name) => ({ prefix: "global", name })),
        }), `label creation response for page ${pageId}`);
        return requireOptionalArray(response.results, `label list on page ${pageId}`).map(toLabel);
    }

    async removeLabel(pageId: string, label: string): Promise<{ pageId: string; label: string; removed: true }> {
        await atlassianDelete({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path: `/rest/api/content/${encodeURIComponent(pageId)}/label`,
            query: { name: label },
        });
        return { pageId, label, removed: true };
    }

    /**
     * Reads a page's view/edit restrictions.
     *
     * Read-only on purpose: Confluence Data Center's REST reference documents
     * only the `byOperation` read endpoints, with no supported way to add or
     * remove a restriction. Guessing at a write path here would be guessing at
     * an access-control API, which is exactly the wrong place to guess.
     */
    async getRestrictions(pageId: string): Promise<ConfluenceRestriction[]> {
        const response = requireResponseObject(await atlassianGet({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path: `/rest/api/content/${encodeURIComponent(pageId)}/restriction/byOperation`,
            query: {
                expand: "read.restrictions.user,read.restrictions.group," +
                    "update.restrictions.user,update.restrictions.group",
            },
        }), `restriction response for page ${pageId}`);
        return Object.entries(response)
            // The map is keyed by operation; `_links`/`_expandable` ride along.
            .filter(([key]) => !key.startsWith("_"))
            .map(([operation, restriction]: [string, unknown]) => ({
                operation,
                users: readArray(restriction, "restrictions", "user", "results")
                    .map((user: unknown) => readString(user, "username") || readString(user, "displayName"))
                    .filter((name: string) => name !== ""),
                groups: readArray(restriction, "restrictions", "group", "results")
                    .map((group: unknown) => readString(group, "name"))
                    .filter((name: string) => name !== ""),
            }))
            // An operation with no users and no groups is unrestricted, which is
            // the default state and not worth reporting.
            .filter((restriction) => restriction.users.length > 0 || restriction.groups.length > 0);
    }

    async listContentProperties(pageId: string): Promise<{ key: string; version: number }[]> {
        const response = requireResponseObject(await atlassianGet({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path: `/rest/api/content/${encodeURIComponent(pageId)}/property`,
            query: { expand: "version" },
        }), `property list response for page ${pageId}`);
        return requireOptionalArray(response.results, `property list on page ${pageId}`).map((property: unknown) => ({
            key: readString(property, "key"),
            version: readNumber(property, "version", "number") ?? 1,
        }));
    }

    async getContentProperty(pageId: string, propertyKey: string): Promise<{ key: string; value: unknown; version: number }> {
        const property = requireResponseObject(await atlassianGet({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path: `/rest/api/content/${encodeURIComponent(pageId)}/property/${encodeURIComponent(propertyKey)}`,
        }), `property "${propertyKey}" response for page ${pageId}`);
        return {
            key: property.key || propertyKey,
            value: property.value,
            version: property.version?.number ?? 1,
        };
    }

    /**
     * Writes a content property, creating it or bumping its version.
     *
     * Content properties are app storage, so overwriting one can corrupt an
     * installed app's state — hence the destructive classification on the tool
     * that exposes this.
     */
    async setContentProperty(pageId: string, propertyKey: string, value: unknown): Promise<{ key: string; version: number }> {
        let nextVersion = 1;
        let exists = false;
        try {
            const existing = await this.getContentProperty(pageId, propertyKey);
            nextVersion = existing.version + 1;
            exists = true;
        } catch (error) {
            // A missing property is the create case; anything else is a real
            // failure and must not be swallowed into a blind create.
            if (!(error instanceof AtlassianHttpError) || error.status !== 404) throw error;
        }
        if (exists) {
            await atlassianPut({
                baseUrl: this.options.baseUrl,
                pat: this.options.pat,
                path: `/rest/api/content/${encodeURIComponent(pageId)}/property/${encodeURIComponent(propertyKey)}`,
                body: { key: propertyKey, value, version: { number: nextVersion } },
            });
        } else {
            await atlassianPost({
                baseUrl: this.options.baseUrl,
                pat: this.options.pat,
                path: `/rest/api/content/${encodeURIComponent(pageId)}/property`,
                body: { key: propertyKey, value },
            });
        }
        return { key: propertyKey, version: nextVersion };
    }

    /** Whether the PAT's owner is watching the page. */
    async isWatchingPage(pageId: string): Promise<{ pageId: string; watching: boolean }> {
        const response = requireResponseObject(await atlassianGet({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path: `/rest/api/user/watch/content/${encodeURIComponent(pageId)}`,
        }), `watch state response for page ${pageId}`);
        return { pageId, watching: response.watching === true };
    }

    /**
     * Starts or stops watching a page as the PAT's owner.
     *
     * Only the caller's own subscription can be changed here. Confluence Data
     * Center publishes no endpoint that lists a page's watchers, so "who else
     * is watching this" is deliberately not offered rather than approximated.
     */
    async setPageWatch(pageId: string, watching: boolean): Promise<{ pageId: string; watching: boolean }> {
        const request = watching ? atlassianPost : atlassianDelete;
        await request({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path: `/rest/api/user/watch/content/${encodeURIComponent(pageId)}`,
        });
        return { pageId, watching };
    }

    /**
     * Pages sitting in a space's trash: deleted, but still restorable.
     *
     * Uses the content list endpoint's documented `status` parameter rather
     * than a CQL predicate — CQL has no status field, so a query written that
     * way would silently return live pages instead of trashed ones.
     */
    async listTrashedPages(spaceKey: string, limit = 50): Promise<ConfluencePageSummary[]> {
        const response = requireResponseObject(await atlassianGet({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path: "/rest/api/content",
            query: { spaceKey, type: "page", status: "trashed", limit, expand: "space" },
        }), `trash listing response for space ${spaceKey}`);
        return requireOptionalArray(response.results, `trash listing for space ${spaceKey}`)
            .map((page: unknown) => ({
                id: readId(page, "id"),
                title: readString(page, "title"),
                space: readString(page, "space", "key") || spaceKey,
                url: buildPageUrl(this.options.baseUrl, readString(page, "_links", "webui")),
            }));
    }

    /**
     * Restores a trashed page. Confluence's documented mechanism is a normal
     * content update that sets `status` back to `current` with an incremented
     * version and changes nothing else.
     */
    async restoreFromTrash(pageId: string): Promise<{ id: string; restored: true; version: number }> {
        const current = requireResponseObject(await atlassianGet({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path: `/rest/api/content/${encodeURIComponent(pageId)}`,
            query: { status: "trashed", expand: "version" },
        }), `trashed page ${pageId} response`);
        const nextVersion = (current.version?.number ?? 1) + 1;
        await atlassianPut({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path: `/rest/api/content/${encodeURIComponent(pageId)}`,
            body: { id: pageId, status: "current", version: { number: nextVersion } },
        });
        return { id: pageId, restored: true, version: nextVersion };
    }

    /** Permanently purges an already-trashed page. There is no recovery from this. */
    async purgeFromTrash(pageId: string): Promise<ConfluenceDeleteResult> {
        await atlassianDelete({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path: `/rest/api/content/${encodeURIComponent(pageId)}`,
            query: { status: "trashed" },
        });
        return { id: pageId, deleted: true };
    }

    /**
     * Uploads a local file as a page attachment. Mutates data: POST
     * /rest/api/content/{id}/child/attachment.
     *
     * The path goes through the same allowlist as every other filesystem read
     * in this server: page content is authored by other people, so a crafted
     * page must not be able to talk an agent into uploading an arbitrary local
     * file to a space that other people can read.
     */
    async uploadAttachment(pageId: string, filePath: string, options: {
        mimeType?: string;
        comment?: string;
        minorEdit?: boolean;
    } = {}): Promise<ConfluenceAttachment[]> {
        const { path: safeFilePath, data } = await readExistingAttachment(this.options, filePath);
        const mimeType = options.mimeType || "application/octet-stream";
        const form = new FormData();
        form.append("file", new Blob([data], { type: mimeType }), basename(safeFilePath));
        if (options.comment) form.append("comment", options.comment);
        form.append("minorEdit", options.minorEdit === false ? "false" : "true");
        const response = requireResponseObject(await atlassianPostFormData({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path: `/rest/api/content/${encodeURIComponent(pageId)}/child/attachment`,
            body: form,
        }), `attachment upload response for page ${pageId}`);
        return requireOptionalArray(response.results, `uploaded attachment list for page ${pageId}`)
            .map((attachment: unknown) =>
                toUploadedAttachment(attachment, basename(safeFilePath), mimeType, data.byteLength));
    }

    /**
     * Replaces an existing attachment's binary content with a new version.
     * The attachment ID, its links and its comment thread survive; only the
     * bytes change, which is what "upload a corrected file" actually means.
     */
    async updateAttachmentData(pageId: string, attachmentId: string, filePath: string, options: {
        mimeType?: string;
        comment?: string;
        minorEdit?: boolean;
    } = {}): Promise<ConfluenceAttachment> {
        const { path: safeFilePath, data } = await readExistingAttachment(this.options, filePath);
        const mimeType = options.mimeType || "application/octet-stream";
        const form = new FormData();
        form.append("file", new Blob([data], { type: mimeType }), basename(safeFilePath));
        if (options.comment) form.append("comment", options.comment);
        form.append("minorEdit", options.minorEdit === false ? "false" : "true");
        const updated = requireResponseObject(await atlassianPostFormData({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path: `/rest/api/content/${encodeURIComponent(pageId)}` +
                `/child/attachment/${encodeURIComponent(attachmentId)}/data`,
            body: form,
        }), `attachment update response for ${attachmentId} on page ${pageId}`);
        return {
            ...toUploadedAttachment(updated, basename(safeFilePath), mimeType, data.byteLength),
            // The server may answer with only a subset of the attachment bean;
            // the ID the caller asked us to replace is authoritative.
            id: readId(updated, "id") || attachmentId,
        };
    }
}

function toLabel(label: unknown): ConfluenceLabel {
    return {
        name: readString(label, "name"),
        prefix: readString(label, "prefix") || "global",
        id: readId(label, "id"),
    };
}

/**
 * Maps an attachment bean returned by an upload, falling back to what was
 * actually sent. Confluence's upload responses vary in how much of the bean
 * they include, and a caller that just uploaded a file should never be told the
 * result has no name and zero bytes.
 */
function toUploadedAttachment(
    attachment: unknown,
    fallbackTitle: string,
    fallbackMimeType: string,
    fallbackSize: number,
): ConfluenceAttachment {
    return {
        id: readId(attachment, "id"),
        title: readString(attachment, "title") || fallbackTitle,
        mediaType: readString(attachment, "metadata", "mediaType") || fallbackMimeType,
        fileSize: readNumber(attachment, "extensions", "fileSize") ?? fallbackSize,
        author: readString(attachment, "version", "by", "displayName")
            || readString(attachment, "version", "by", "username")
            || "Unknown",
        created: readString(attachment, "version", "when"),
        downloadPath: readString(attachment, "_links", "download"),
    };
}

/**
 * Registers the extended Confluence tools: global search, page hierarchy,
 * version history and restore, spaces, labels, restrictions, content
 * properties, watches, trash and attachment uploads.
 *
 * Two absences here are deliberate rather than incomplete. Confluence Data
 * Center's REST reference documents no way to *set* a content restriction and
 * no way to list a page's watchers, so neither is offered — inventing a path
 * for an access-control API would be exactly the wrong place to guess. Page
 * templates are likewise Cloud-only and are not exposed.
 */
import { z } from "zod";
import type { ConfluenceClient } from "../confluenceClient.js";
import {
    numericIdSchema,
    runTool,
    textFieldSchema,
    titleFieldSchema,
    type ToolRegistrar,
} from "./shared.js";

/** Confluence space keys are short, alphanumeric, and never a URL. */
const spaceKeySchema = z
    .string()
    .min(1)
    .max(255)
    .regex(/^[A-Za-z0-9~_]+$/, "Must be a bare Confluence space key such as 'ENG' — not a URL or name");

const labelSchema = z
    .string()
    .min(1)
    .max(255)
    .regex(/^[^\s]+$/, "A Confluence label cannot contain whitespace");

export function registerConfluenceExtraTools(tool: ToolRegistrar, client: ConfluenceClient): void {
    tool("core", "read", "confluence_search", {
        title: "Search all Confluence entities",
        description:
            "Search every entity type Confluence indexes — pages, blog posts, spaces, users and " +
            "attachments — using CQL. confluence_search_pages can only ever return content, so questions " +
            "like 'which space is X in' or 'is there a user called Y' need this instead. Returns " +
            "lightweight hits; fetch a page's body with confluence_get_page. Read-only.",
        inputSchema: {
            cql: z.string().min(1).max(10_000)
                .describe("CQL query, e.g. 'type = user and user.fullname ~ \"Kowalska\"' or 'siteSearch ~ \"budget\"'"),
            limit: z.number().int().positive().max(100).optional()
                .describe("Maximum hits per page (default 20)"),
            start: z.number().int().min(0).max(10_000).optional()
                .describe("Zero-based offset; pass `nextStart` from a previous call"),
        },
    }, async ({ cql, limit, start }) =>
        runTool("confluence_search", () => client.search(cql, limit, start)));

    tool("core", "read", "confluence_get_page_ancestors", {
        title: "Get a Confluence page's ancestors",
        description: "List the chain of parent pages above a page, outermost first. Use it to work out " +
            "where a page sits in a documentation tree. Read-only.",
        inputSchema: {
            pageId: numericIdSchema.describe("Confluence page ID, e.g. '123456'"),
        },
    }, async ({ pageId }) =>
        runTool("confluence_get_page_ancestors", () => client.getPageAncestors(pageId)));

    tool("core", "read", "confluence_get_page_descendants", {
        title: "Get all pages below a Confluence page",
        description: "List every page beneath a page at any depth, not just its direct children. " +
            "Implemented as a CQL `ancestor` search, so it works on Data Center versions that lack the " +
            "descendant shortcut. Use confluence_get_page_children for one level only. Read-only.",
        inputSchema: {
            pageId: numericIdSchema.describe("Confluence page ID, e.g. '123456'"),
            limit: z.number().int().positive().max(500).optional()
                .describe("Maximum descendants to return (default 100)"),
        },
    }, async ({ pageId, limit }) =>
        runTool("confluence_get_page_descendants", () => client.getPageDescendants(pageId, limit)));

    tool("core", "read", "confluence_export_page", {
        title: "Export a Confluence page as HTML",
        description:
            "Return a page rendered as HTML with its macros expanded, rather than the lossy plain-text " +
            "rendering confluence_get_page produces. Use this when the page has to be reproduced " +
            "elsewhere. The output can be large — a page with big tables easily exceeds the tool result " +
            "ceiling. Read-only.",
        inputSchema: {
            pageId: numericIdSchema.describe("Confluence page ID, e.g. '123456'"),
            format: z.enum(["export_view", "styled_view", "view"]).optional()
                .describe("Rendering to request: 'export_view' (default, self-contained), 'styled_view' (includes CSS), 'view' (as displayed)"),
        },
    }, async ({ pageId, format }) =>
        runTool("confluence_export_page", () => client.exportPage(pageId, format)));

    tool("core", "read", "confluence_get_page_version", {
        title: "Get a historical Confluence page version",
        description:
            "Read the content of one earlier version of a page, both as storage-format markup and as " +
            "plain text. Use confluence_get_page_history to find the version number. This is how an " +
            "edit is reviewed before confluence_restore_page_version reverts it. Read-only.",
        inputSchema: {
            pageId: numericIdSchema.describe("Confluence page ID, e.g. '123456'"),
            versionNumber: z.number().int().positive().describe("Version number from confluence_get_page_history"),
        },
    }, async ({ pageId, versionNumber }) =>
        runTool("confluence_get_page_version", () => client.getPageVersion(pageId, versionNumber)));

    tool("core", "read", "confluence_get_space", {
        title: "Get a Confluence space",
        description: "Get one space's name, type, description and homepage. Read-only.",
        inputSchema: {
            spaceKey: spaceKeySchema.describe("Space key, e.g. 'ENG'"),
        },
    }, async ({ spaceKey }) => runTool("confluence_get_space", () => client.getSpace(spaceKey)));

    tool("core", "read", "confluence_list_space_content", {
        title: "List a Confluence space's pages",
        description: "List the pages in a space. Use confluence_get_page_children or " +
            "confluence_get_page_descendants to walk one tree rather than the whole space. Read-only.",
        inputSchema: {
            spaceKey: spaceKeySchema.describe("Space key, e.g. 'ENG'"),
            limit: z.number().int().positive().max(200).optional()
                .describe("Maximum pages to return (default 50)"),
        },
    }, async ({ spaceKey, limit }) =>
        runTool("confluence_list_space_content", () => client.listSpaceContent(spaceKey, limit)));

    tool("core", "read", "confluence_list_labels", {
        title: "List a Confluence page's labels",
        description: "List the labels attached to a page. Labels are Confluence's basic taxonomy and are " +
            "queryable from CQL as `label = \"x\"`. Read-only.",
        inputSchema: {
            pageId: numericIdSchema.describe("Confluence page ID, e.g. '123456'"),
        },
    }, async ({ pageId }) => runTool("confluence_list_labels", () => client.listLabels(pageId)));

    tool("core", "read", "confluence_get_restrictions", {
        title: "Get a Confluence page's restrictions",
        description:
            "Report which users and groups a page's view and edit permissions are restricted to. Only " +
            "operations that are actually restricted are returned; an absent operation means the page " +
            "inherits its space's permissions. Read-only — Confluence Data Center publishes no " +
            "supported REST endpoint for *changing* restrictions, so they must be edited in the UI.",
        inputSchema: {
            pageId: numericIdSchema.describe("Confluence page ID, e.g. '123456'"),
        },
    }, async ({ pageId }) => runTool("confluence_get_restrictions", () => client.getRestrictions(pageId)));

    tool("core", "read", "confluence_list_content_properties", {
        title: "List a Confluence page's property keys",
        description: "List the content-property keys stored on a page, with their versions. Content " +
            "properties are app storage, so this is mainly useful for diagnosing what an installed app " +
            "recorded. Read-only.",
        inputSchema: {
            pageId: numericIdSchema.describe("Confluence page ID, e.g. '123456'"),
        },
    }, async ({ pageId }) =>
        runTool("confluence_list_content_properties", () => client.listContentProperties(pageId)));

    tool("core", "read", "confluence_get_content_property", {
        title: "Get a Confluence content property",
        description: "Read one content property's JSON value and version. Read-only.",
        inputSchema: {
            pageId: numericIdSchema.describe("Confluence page ID, e.g. '123456'"),
            propertyKey: z.string().min(1).max(255).describe("Property key from confluence_list_content_properties"),
        },
    }, async ({ pageId, propertyKey }) =>
        runTool("confluence_get_content_property", () => client.getContentProperty(pageId, propertyKey)));

    tool("core", "read", "confluence_is_watching_page", {
        title: "Check whether the current user watches a page",
        description: "Report whether the account behind the configured token is watching a page. " +
            "Confluence Data Center publishes no endpoint that lists a page's other watchers, so only " +
            "the caller's own subscription is visible. Read-only.",
        inputSchema: {
            pageId: numericIdSchema.describe("Confluence page ID, e.g. '123456'"),
        },
    }, async ({ pageId }) =>
        runTool("confluence_is_watching_page", () => client.isWatchingPage(pageId)));

    tool("core", "read", "confluence_list_trashed_pages", {
        title: "List trashed Confluence pages",
        description: "List pages sitting in a space's trash: deleted, but still restorable with " +
            "confluence_restore_from_trash. Read-only.",
        inputSchema: {
            spaceKey: spaceKeySchema.describe("Space key, e.g. 'ENG'"),
            limit: z.number().int().positive().max(200).optional()
                .describe("Maximum pages to return (default 50)"),
        },
    }, async ({ spaceKey, limit }) =>
        runTool("confluence_list_trashed_pages", () => client.listTrashedPages(spaceKey, limit)));

    tool("write", "write", "confluence_restore_page_version", {
        title: "Restore an earlier Confluence page version",
        description:
            "Revert a page to the content of an earlier version by republishing that version's markup. " +
            "Mutates data: the page's current content is replaced and every watcher is notified. It is " +
            "recoverable — the replaced content stays in the page history as its own version, and this " +
            "revert becomes a new version — but anything written since that version disappears from the " +
            "live page. Review it with confluence_get_page_version first.",
        inputSchema: {
            pageId: numericIdSchema.describe("Confluence page ID, e.g. '123456'"),
            versionNumber: z.number().int().positive()
                .describe("Version number to restore, from confluence_get_page_history"),
        },
        annotations: { destructiveHint: true },
    }, async ({ pageId, versionNumber }) =>
        runTool("confluence_restore_page_version", () => client.restorePageVersion(pageId, versionNumber)));

    tool("write", "write", "confluence_move_page", {
        title: "Move a Confluence page",
        description:
            "Re-parent a page, moving it and its whole subtree elsewhere in the tree. Mutates data: the " +
            "page's content is untouched, but its position, breadcrumb and URL path change, and links " +
            "that used the old path may break. Reversible by moving it back.",
        inputSchema: {
            pageId: numericIdSchema.describe("Confluence page ID to move"),
            newParentId: numericIdSchema.describe("Page ID of the new parent"),
        },
        annotations: { destructiveHint: true },
        validate: ({ pageId, newParentId }) =>
            pageId === newParentId ? "a page cannot be made its own parent." : undefined,
    }, async ({ pageId, newParentId }) =>
        runTool("confluence_move_page", () => client.movePage(pageId, newParentId)));

    tool("write", "write", "confluence_create_space", {
        title: "Create a Confluence space",
        description:
            "Create a Confluence space. Mutates data: creates a real space visible in the space " +
            "directory. Set `isPrivate` to create one visible only to its creator. A space is a " +
            "significant, organisation-level object — confirm the key and name are the intended ones, " +
            "because a space key cannot be changed afterwards.",
        inputSchema: {
            key: spaceKeySchema.describe("Space key, e.g. 'ENG'. Permanent — it cannot be changed later"),
            name: titleFieldSchema.describe("Space name"),
            description: textFieldSchema.optional().describe("Space description, as plain text"),
            isPrivate: z.boolean().optional()
                .describe("Create a private space visible only to its creator (default false)"),
        },
    }, async (args) => runTool("confluence_create_space", () => client.createSpace(args)));

    tool("write", "write", "confluence_update_space", {
        title: "Update a Confluence space",
        description: "Update a space's name or description. Mutates data. The space key cannot be " +
            "changed. Omitted fields keep their current values.",
        inputSchema: {
            spaceKey: spaceKeySchema.describe("Space key, e.g. 'ENG'"),
            name: titleFieldSchema.optional().describe("New space name"),
            description: textFieldSchema.optional().describe("New space description"),
        },
        annotations: { destructiveHint: true },
        validate: ({ name, description }) =>
            name === undefined && description === undefined
                ? "nothing to update — supply at least one of: name, description."
                : undefined,
    }, async ({ spaceKey, name, description }) =>
        runTool("confluence_update_space", () => client.updateSpace(spaceKey, { name, description })));

    tool("write", "destructive", "confluence_delete_space", {
        title: "Delete a Confluence space",
        description:
            "Delete an entire Confluence space and everything in it. Mutates data and is effectively " +
            "irreversible: unlike a page, a deleted space does not land in a recoverable trash, and " +
            "recovery means a backup restore. Confluence accepts the request and performs the deletion " +
            "as a background task, so a success here means 'accepted', not 'finished'. Verify what the " +
            "space contains with confluence_list_space_content first.",
        inputSchema: {
            spaceKey: spaceKeySchema.describe("Space key to delete, e.g. 'ENG'"),
        },
    }, async ({ spaceKey }) => runTool("confluence_delete_space", () => client.deleteSpace(spaceKey)));

    tool("write", "write", "confluence_add_labels", {
        title: "Add labels to a Confluence page",
        description: "Add one or more labels to a page. Mutates data, but additively: existing labels " +
            "are kept. Labels drive CQL queries and macro-based page lists, so adding one can change " +
            "which indexes a page appears in.",
        inputSchema: {
            pageId: numericIdSchema.describe("Confluence page ID, e.g. '123456'"),
            labels: z.array(labelSchema).min(1).max(50)
                .describe("Labels to add. Labels cannot contain whitespace"),
        },
    }, async ({ pageId, labels }) =>
        runTool("confluence_add_labels", () => client.addLabels(pageId, labels)));

    tool("write", "destructive", "confluence_remove_label", {
        title: "Remove a label from a Confluence page",
        description: "Remove one label from a page. Mutates data. The page may drop out of CQL queries " +
            "and macro-generated indexes that select on that label.",
        inputSchema: {
            pageId: numericIdSchema.describe("Confluence page ID, e.g. '123456'"),
            label: labelSchema.describe("Exact label name from confluence_list_labels"),
        },
    }, async ({ pageId, label }) =>
        runTool("confluence_remove_label", () => client.removeLabel(pageId, label)));

    tool("write", "destructive", "confluence_set_content_property", {
        title: "Write a Confluence content property",
        description:
            "Write a JSON value into a page's content property, replacing whatever was there. Mutates " +
            "data and is treated as destructive: content properties are where installed apps keep their " +
            "state, so overwriting one corrupts that app's records, with no undo. Only use it for a " +
            "property key you own.",
        inputSchema: {
            pageId: numericIdSchema.describe("Confluence page ID, e.g. '123456'"),
            propertyKey: z.string().min(1).max(255).describe("Property key to write"),
            value: z.unknown().describe("JSON value to store"),
        },
    }, async ({ pageId, propertyKey, value }) =>
        runTool("confluence_set_content_property", () => client.setContentProperty(pageId, propertyKey, value)));

    tool("write", "write", "confluence_set_page_watch", {
        title: "Watch or unwatch a Confluence page",
        description: "Start or stop watching a page as the account behind the configured token. Mutates " +
            "only that account's own notification subscription; nobody else is affected.",
        inputSchema: {
            pageId: numericIdSchema.describe("Confluence page ID, e.g. '123456'"),
            watching: z.boolean().describe("True to watch, false to stop watching"),
        },
    }, async ({ pageId, watching }) =>
        runTool("confluence_set_page_watch", () => client.setPageWatch(pageId, watching)));

    tool("write", "write", "confluence_restore_from_trash", {
        title: "Restore a trashed Confluence page",
        description: "Restore a page from a space's trash back to normal, visible content. Mutates data " +
            "by publishing a new version of the page. Find candidates with confluence_list_trashed_pages.",
        inputSchema: {
            pageId: numericIdSchema.describe("Trashed page ID from confluence_list_trashed_pages"),
        },
    }, async ({ pageId }) =>
        runTool("confluence_restore_from_trash", () => client.restoreFromTrash(pageId)));

    tool("write", "destructive", "confluence_purge_from_trash", {
        title: "Permanently purge a trashed Confluence page",
        description:
            "Permanently erase a page that is already in the trash. Mutates data and cannot be undone " +
            "by any means short of a backup restore — this is the step that makes " +
            "confluence_delete_page irreversible. The page must already be trashed.",
        inputSchema: {
            pageId: numericIdSchema.describe("Trashed page ID from confluence_list_trashed_pages"),
        },
    }, async ({ pageId }) =>
        runTool("confluence_purge_from_trash", () => client.purgeFromTrash(pageId)));

    tool("files", "write", "confluence_upload_attachment", {
        title: "Upload a Confluence attachment",
        description:
            "Upload a local file as an attachment on a Confluence page. Mutates data: creates a real " +
            "attachment that everyone who can read the page can download. The file must sit inside a " +
            "directory named by ATLASSIAN_ATTACHMENT_DIRS; without that allowlist the tool is not " +
            "registered at all. Check what the page already carries with confluence_list_attachments.",
        inputSchema: {
            pageId: numericIdSchema.describe("Confluence page ID, e.g. '123456'"),
            filePath: z.string().min(1).max(4096)
                .describe("Absolute path of the local file to upload, inside an allowed attachment directory"),
            mimeType: z.string().max(255).optional()
                .describe("MIME type to declare, e.g. 'application/pdf' (default application/octet-stream)"),
            comment: textFieldSchema.optional().describe("Optional attachment comment"),
            minorEdit: z.boolean().optional()
                .describe("Treat as a minor edit so watchers are not notified (default true)"),
        },
    }, async ({ pageId, filePath, mimeType, comment, minorEdit }) =>
        runTool("confluence_upload_attachment", () =>
            client.uploadAttachment(pageId, filePath, { mimeType, comment, minorEdit })));

    tool("files", "write", "confluence_update_attachment_data", {
        title: "Replace a Confluence attachment's contents",
        description:
            "Upload a new version of an existing attachment. Mutates data: the attachment ID, its links " +
            "and its comments survive, but the file everyone downloads is replaced. The previous " +
            "version stays in the attachment's own version history. The source file must sit inside an " +
            "allowed attachment directory.",
        inputSchema: {
            pageId: numericIdSchema.describe("Confluence page ID the attachment belongs to"),
            attachmentId: z.string().min(1).max(64)
                .describe("Attachment ID from confluence_list_attachments"),
            filePath: z.string().min(1).max(4096)
                .describe("Absolute path of the replacement file, inside an allowed attachment directory"),
            mimeType: z.string().max(255).optional().describe("MIME type to declare for the new content"),
            comment: textFieldSchema.optional().describe("Optional comment describing the new version"),
            minorEdit: z.boolean().optional()
                .describe("Treat as a minor edit so watchers are not notified (default true)"),
        },
        annotations: { destructiveHint: true },
    }, async ({ pageId, attachmentId, filePath, mimeType, comment, minorEdit }) =>
        runTool("confluence_update_attachment_data", () =>
            client.updateAttachmentData(pageId, attachmentId, filePath, { mimeType, comment, minorEdit })));
}

/**
 * Shared plumbing for tool registration.
 *
 * The server's tool surface grew past the point where one file could hold it
 * legibly, so registration is split per feature area. Everything those modules
 * need in common — the registrar signature, the argument schemas that stop a
 * doomed call before it costs a round trip, and the result helpers — lives
 * here so the split does not fork those decisions.
 */
import type { ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ToolGroup } from "../config.js";
import { AtlassianHttpError } from "../httpClient.js";

/**
 * How a tool affects the world, used to derive MCP annotations:
 *  - "read"        never modifies anything
 *  - "write"       creates or updates, and is reversible
 *  - "destructive" removes data or is otherwise hard to undo
 * "local" additionally marks tools that touch the local filesystem rather
 * than (or as well as) the remote Atlassian instance.
 */
export type ToolKind = "read" | "write" | "destructive" | "local";

export interface ToolSpec<InputArgs extends z.ZodRawShape> {
    title?: string;
    description?: string;
    inputSchema?: InputArgs;
    annotations?: ToolAnnotations;
    /**
     * Cross-field precondition, checked before the handler runs and so before
     * any HTTP request. Returns a message naming what is missing, or undefined
     * when the arguments are usable.
     */
    validate?: (args: any) => string | undefined;
}

/**
 * Registers one tool, subject to the active profile and the server-side safety
 * policy. Implemented in `index.ts`; passed to each registration module so the
 * policy decision stays in exactly one place.
 */
export type ToolRegistrar = <InputArgs extends z.ZodRawShape>(
    group: ToolGroup,
    kind: ToolKind,
    name: string,
    spec: ToolSpec<InputArgs>,
    handler: ToolCallback<InputArgs>,
) => void;

/** Formats any thrown error into a concise, user-facing message string. */
export function formatError(error: unknown): string {
    if (error instanceof AtlassianHttpError) {
        return error.message;
    }
    if (error instanceof Error) {
        return error.message;
    }
    return String(error);
}

/**
 * Shared parameter schemas. Without them the model can spend a full round trip
 * on an argument that could never work — `jira_get_issue({issueKey: "https://
 * jira/browse/ABC-123"})` used to validate, reach Jira and come back 404.
 * These are token-cost guards, not a security boundary: every interpolation
 * into a REST path is already encodeURIComponent-escaped.
 */
export const issueKeySchema = z
    .string()
    .max(255)
    .regex(
        /^[A-Za-z][A-Za-z0-9_]*-[1-9][0-9]*$/,
        "Must be a bare Jira issue key such as 'ABC-123' — not a URL, summary or ID",
    );

/** Confluence content IDs (pages, comments, attachments) are decimal integers. */
export const numericIdSchema = z
    .string()
    .max(32)
    .regex(/^[1-9][0-9]*$/, "Must be a numeric Atlassian content ID such as '601156620'");

/** Jira entity IDs (filters, versions, components, permissions) are decimal integers too. */
export const jiraIdSchema = z
    .string()
    .max(32)
    .regex(/^[1-9][0-9]*$/, "Must be a numeric Jira entity ID such as '10402'");

/** Project keys: letters, digits and underscores, never a URL. */
export const projectKeySchema = z
    .string()
    .max(255)
    .regex(/^[A-Za-z][A-Za-z0-9_]*$/, "Must be a bare project key such as 'ABC' — not a URL or name");

/** Free-text bodies: generous, but not "the model pastes 10 MB" generous. */
export const MAX_TEXT_FIELD_CHARS = 100_000;
export const MAX_TITLE_CHARS = 255;

export const textFieldSchema = z
    .string()
    .max(MAX_TEXT_FIELD_CHARS, `Must be at most ${MAX_TEXT_FIELD_CHARS} characters`);

export const titleFieldSchema = z
    .string()
    .max(MAX_TITLE_CHARS, `Must be at most ${MAX_TITLE_CHARS} characters`);

/** Absolute HTTP(S) URL, for remote links. Rejects `file:` and `javascript:`. */
export const externalUrlSchema = z
    .string()
    .max(2_000)
    .regex(/^https?:\/\/\S+$/i, "Must be an absolute http(s) URL");

/** ISO-8601 date, as Jira's version and sprint endpoints expect. */
export const isoDateSchema = z
    .string()
    .max(40)
    .regex(/^\d{4}-\d{2}-\d{2}/, "Must start with an ISO-8601 date such as '2026-03-31'");

/** Serialises a successful tool result. */
export function jsonResult(value: unknown): { content: { type: "text"; text: string }[] } {
    return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

/** Serialises a failure, naming the tool so the model can tell which call failed. */
export function errorResult(toolName: string, error: unknown): {
    isError: true;
    content: { type: "text"; text: string }[];
} {
    return {
        isError: true,
        content: [{ type: "text", text: `${toolName} failed: ${formatError(error)}` }],
    };
}

/**
 * Wraps a handler body so every registration module reports failures the same
 * way. Without it each tool repeats an eight-line try/catch whose only variable
 * part is the tool name — and one that silently drops `isError` looks like a
 * success to the client.
 */
export async function runTool(
    toolName: string,
    body: () => Promise<unknown>,
): Promise<{ content: { type: "text"; text: string }[]; isError?: true }> {
    try {
        return jsonResult(await body());
    } catch (error) {
        return errorResult(toolName, error);
    }
}

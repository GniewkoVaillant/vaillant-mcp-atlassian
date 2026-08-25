/**
 * Loads and validates configuration from environment variables.
 * Fails fast with a clear error message if required variables are missing.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Tool groups that can be enabled/disabled to control the tools/list payload. */
export type ToolGroup = "core" | "forms" | "write" | "files" | "links" | "agile" | "dev";

export const ALL_TOOL_GROUPS: ToolGroup[] = [
  "core",
  "forms",
  "write",
  "files",
  "links",
  "agile",
  "dev",
];

/** Named profiles mapping to a set of tool groups. */
const PROFILES: Record<string, ToolGroup[]> = {
  full: ALL_TOOL_GROUPS,
  ppm: ["core", "forms", "write", "files", "links"],
  agile: ["core", "agile", "dev"],
  read: ["core", "forms", "agile", "dev", "links"],
  core: ["core"],
};

export interface AtlassianConfig {
  /** Path of the .env that was loaded, or null when none was found. */
  envFile: string | null;
  jiraBaseUrl: string;
  jiraPat: string;
  confluenceBaseUrl: string;
  confluencePat: string;
  /** When true, every mutating tool is refused before any network call. */
  readOnly: boolean;
  /** Tool groups exposed via tools/list. */
  enabledGroups: Set<ToolGroup>;
  /** Absolute directories that attachment download/upload may touch. */
  attachmentDirs: string[];
  /** Per-request HTTP timeout in milliseconds. */
  timeoutMs: number;
}

/**
 * Minimal .env loader. Keeping secrets in a gitignored .env next to the
 * install, rather than inline in the MCP client's config, means the client
 * config can be shared or committed without leaking tokens.
 *
 * Values already present in the real environment always win, so a wrapper
 * script or CI can still override the file.
 */
function loadEnvFile(): string | null {
  const explicit = process.env.ATLASSIAN_ENV_FILE?.trim();
  const installRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const candidates = explicit ? [resolve(explicit)] : [join(installRoot, ".env")];

  for (const candidate of candidates) {
    let contents: string;
    try {
      contents = readFileSync(candidate, "utf8");
    } catch {
      continue;
    }

    for (const rawLine of contents.split("\n")) {
      const line = rawLine.trim();
      if (line === "" || line.startsWith("#")) continue;

      const separator = line.indexOf("=");
      if (separator === -1) continue;

      const key = line.slice(0, separator).trim();
      if (key === "") continue;

      let value = line.slice(separator + 1).trim();
      // Strip matching surrounding quotes, which people add out of habit and
      // which would otherwise end up inside the token.
      if (value.length >= 2 && (value.startsWith('"') || value.startsWith("'"))) {
        const quote = value[0];
        if (value.endsWith(quote)) value = value.slice(1, -1);
      }

      if (process.env[key] === undefined || process.env[key] === "") {
        process.env[key] = value;
      }
    }
    return candidate;
  }

  if (explicit) {
    throw new Error(`ATLASSIAN_ENV_FILE points at "${explicit}", which could not be read.`);
  }
  return null;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(
      `Missing required environment variable "${name}". ` +
        `See .env.example for the full list of required variables.`,
    );
  }
  return value;
}

/** Removes a trailing slash so we can safely concatenate paths. */
function normalizeBaseUrl(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  throw new Error(`Invalid boolean value "${raw}". Use true/false.`);
}

function parseTimeout(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 30_000;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(
      `Invalid ATLASSIAN_TIMEOUT_MS "${raw}". Expected a positive number of milliseconds.`,
    );
  }
  return value;
}

/**
 * Resolves ATLASSIAN_PROFILE into a set of tool groups. Accepts either a named
 * profile ("full", "ppm", "agile", "read", "core") or a comma-separated list of
 * raw group names, so callers can compose an exact surface.
 */
function parseProfile(raw: string | undefined): Set<ToolGroup> {
  if (raw === undefined || raw.trim() === "") return new Set(ALL_TOOL_GROUPS);
  const value = raw.trim().toLowerCase();

  const named = PROFILES[value];
  if (named) return new Set(named);

  const requested = value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  const groups = new Set<ToolGroup>();
  for (const part of requested) {
    if (!ALL_TOOL_GROUPS.includes(part as ToolGroup)) {
      throw new Error(
        `Unknown tool group "${part}" in ATLASSIAN_PROFILE. ` +
          `Valid profiles: ${Object.keys(PROFILES).join(", ")}. ` +
          `Valid groups: ${ALL_TOOL_GROUPS.join(", ")}.`,
      );
    }
    groups.add(part as ToolGroup);
  }
  if (groups.size === 0) {
    throw new Error(`ATLASSIAN_PROFILE "${raw}" resolved to no tool groups.`);
  }
  // "core" is always useful and cheap; keep it available so the agent can at
  // least look issues up regardless of which extra groups were requested.
  groups.add("core");
  return groups;
}

function parseAttachmentDirs(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === "") return [];
  return raw
    .split(":")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

export function loadConfig(): AtlassianConfig {
  const envFile = loadEnvFile();

  const missing: string[] = [];
  const names = ["JIRA_BASE_URL", "JIRA_PAT", "CONFLUENCE_BASE_URL", "CONFLUENCE_PAT"];
  for (const name of names) {
    const value = process.env[name];
    if (!value || value.trim() === "") {
      missing.push(name);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(", ")}. ` +
        (envFile
          ? `Loaded "${envFile}" but it did not define them.`
          : `No .env file was found next to the install; copy .env.example to .env and fill it in, ` +
            `or set ATLASSIAN_ENV_FILE to its location.`),
    );
  }

  return {
    envFile,
    jiraBaseUrl: normalizeBaseUrl(requireEnv("JIRA_BASE_URL")),
    jiraPat: requireEnv("JIRA_PAT"),
    confluenceBaseUrl: normalizeBaseUrl(requireEnv("CONFLUENCE_BASE_URL")),
    confluencePat: requireEnv("CONFLUENCE_PAT"),
    readOnly: parseBoolean(process.env.ATLASSIAN_READ_ONLY, false),
    enabledGroups: parseProfile(process.env.ATLASSIAN_PROFILE),
    attachmentDirs: parseAttachmentDirs(process.env.ATLASSIAN_ATTACHMENT_DIRS),
    timeoutMs: parseTimeout(process.env.ATLASSIAN_TIMEOUT_MS),
  };
}

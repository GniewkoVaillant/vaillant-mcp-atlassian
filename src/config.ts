/**
 * Loads and validates configuration from environment variables.
 * Fails fast with a clear error message if required variables are missing.
 */
import { readFileSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_MAX_ATTACHMENT_BYTES } from "./attachmentSecurity.js";

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
  // Registration still removes writes; including every group preserves all
  // read-only discovery tools, even those historically grouped with writes.
  read: ALL_TOOL_GROUPS,
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
  /** Destructive tools are absent unless an operator explicitly opts in. */
  allowDestructive: boolean;
  /** Tool groups exposed via tools/list. */
  enabledGroups: Set<ToolGroup>;
  /** Absolute directories that attachment download/upload may touch. */
  attachmentDirs: string[];
  /** Per-request HTTP timeout in milliseconds. */
  timeoutMs: number;
  /** End-to-end HTTP deadline, including queueing and retry delays. */
  totalTimeoutMs: number;
  /** Process-wide upper bound on simultaneous upstream requests. */
  maxConcurrentRequests: number;
  /** Maximum requests permitted to wait for an upstream slot. */
  maxQueuedRequests: number;
  /** Largest attachment accepted for upload or download. */
  maxAttachmentBytes: number;
  /** Maximum pages automatically traversed by a Jira Agile operation. */
  maxPaginationPages: number;
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

    const fileInfo = statSync(candidate);
    if (!fileInfo.isFile()) {
      throw new Error(`Atlassian environment file "${candidate}" must be a regular file.`);
    }
    if (process.platform !== "win32" && (fileInfo.mode & 0o077) !== 0) {
      throw new Error(
        `Atlassian environment file "${candidate}" is accessible to other users. ` +
          `Run chmod 600 on that file before starting the server.`,
      );
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

/** Rejects credential-bearing or non-TLS URLs before any PAT can be sent. */
function normalizeBaseUrl(raw: string, name: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid ${name}. Expected an absolute HTTPS URL.`);
  }

  const isLoopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback)) {
    throw new Error(`${name} must use HTTPS; HTTP is allowed only for local loopback testing.`);
  }
  if (url.username || url.password) {
    throw new Error(`${name} must not contain embedded credentials.`);
  }
  if (url.search || url.hash) {
    throw new Error(`${name} must not contain a query string or fragment.`);
  }

  return raw.endsWith("/") ? raw.slice(0, -1) : raw;
}

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  throw new Error(`Invalid boolean value "${raw}". Use true/false.`);
}

function parsePositiveInteger(
  raw: string | undefined,
  name: string,
  fallback: number,
  maximum: number,
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(
      `Invalid ${name} "${raw}". Expected an integer between 1 and ${maximum}.`,
    );
  }
  return value;
}

function parseQueueLimit(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 16;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0 || value > 256) {
    throw new Error(`Invalid ATLASSIAN_MAX_QUEUED_REQUESTS "${raw}". Expected an integer between 0 and 256.`);
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
    .split(delimiter)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((directory) => {
      if (!isAbsolute(directory) || resolve(directory) === parse(resolve(directory)).root) {
        throw new Error(
          `Invalid ATLASSIAN_ATTACHMENT_DIRS entry "${directory}". ` +
            `Use an absolute directory other than the filesystem root.`,
        );
      }
      return directory;
    });
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
    jiraBaseUrl: normalizeBaseUrl(requireEnv("JIRA_BASE_URL"), "JIRA_BASE_URL"),
    jiraPat: requireEnv("JIRA_PAT"),
    confluenceBaseUrl: normalizeBaseUrl(requireEnv("CONFLUENCE_BASE_URL"), "CONFLUENCE_BASE_URL"),
    confluencePat: requireEnv("CONFLUENCE_PAT"),
    readOnly:
      parseBoolean(process.env.ATLASSIAN_READ_ONLY, false) ||
      process.env.ATLASSIAN_PROFILE?.trim().toLowerCase() === "read",
    allowDestructive: parseBoolean(process.env.ATLASSIAN_ALLOW_DESTRUCTIVE, false),
    enabledGroups: parseProfile(process.env.ATLASSIAN_PROFILE),
    attachmentDirs: parseAttachmentDirs(process.env.ATLASSIAN_ATTACHMENT_DIRS),
    timeoutMs: parsePositiveInteger(process.env.ATLASSIAN_TIMEOUT_MS, "ATLASSIAN_TIMEOUT_MS", 30_000, 300_000),
    totalTimeoutMs: parsePositiveInteger(
      process.env.ATLASSIAN_TOTAL_TIMEOUT_MS,
      "ATLASSIAN_TOTAL_TIMEOUT_MS",
      45_000,
      300_000,
    ),
    maxConcurrentRequests: parsePositiveInteger(
      process.env.ATLASSIAN_MAX_CONCURRENT_REQUESTS,
      "ATLASSIAN_MAX_CONCURRENT_REQUESTS",
      4,
      64,
    ),
    maxQueuedRequests: parseQueueLimit(process.env.ATLASSIAN_MAX_QUEUED_REQUESTS),
    maxAttachmentBytes: parsePositiveInteger(
      process.env.ATLASSIAN_MAX_ATTACHMENT_BYTES,
      "ATLASSIAN_MAX_ATTACHMENT_BYTES",
      DEFAULT_MAX_ATTACHMENT_BYTES,
      100 * 1024 * 1024,
    ),
    maxPaginationPages: parsePositiveInteger(
      process.env.ATLASSIAN_MAX_PAGINATION_PAGES,
      "ATLASSIAN_MAX_PAGINATION_PAGES",
      10,
      100,
    ),
  };
}

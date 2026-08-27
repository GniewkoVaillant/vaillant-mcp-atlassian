#!/usr/bin/env node
/**
 * Smoke test: boots the built server over stdio, lists its tools, and (when
 * real credentials are present) performs one read-only Jira and Confluence
 * call to prove auth works end to end.
 *
 * Exits non-zero on failure so it can gate a deploy.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const entrypoint = join(projectRoot, "dist", "index.js");

if (!existsSync(entrypoint)) {
  console.error(`No build found at ${entrypoint}. Run "npm run build" first.`);
  process.exit(1);
}

const envFileCandidate = process.env.ATLASSIAN_ENV_FILE
  ? process.env.ATLASSIAN_ENV_FILE
  : join(projectRoot, ".env");

// The server loads a .env itself, so credentials may be present even when
// they are absent from this process's environment.
const hasRealCredentials =
  Boolean(
    process.env.JIRA_BASE_URL &&
      process.env.JIRA_PAT &&
      process.env.CONFLUENCE_BASE_URL &&
      process.env.CONFLUENCE_PAT,
  ) || existsSync(envFileCandidate);

// A routine build must never query production merely because local .env
// credentials happen to exist. Live checks require a deliberate operator opt-in.
const runLiveChecks = hasRealCredentials && process.env.ATLASSIAN_SMOKE_LIVE === "true";

const env = hasRealCredentials
  ? { ...process.env }
  : {
      ...process.env,
      JIRA_BASE_URL: "https://jira.invalid",
      JIRA_PAT: "placeholder",
      CONFLUENCE_BASE_URL: "https://confluence.invalid",
      CONFLUENCE_PAT: "placeholder",
    };

const child = spawn(process.execPath, [entrypoint], {
  env,
  stdio: ["pipe", "pipe", "pipe"],
});

let stderr = "";
child.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});

const pending = new Map();
let nextId = 1;
let buffer = "";

child.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  let newline = buffer.indexOf("\n");
  while (newline !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf("\n");
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    const resolver = pending.get(message.id);
    if (resolver) {
      pending.delete(message.id);
      resolver(message);
    }
  }
});

function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out waiting for "${method}"`));
    }, 30_000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

const failures = [];

function check(name, condition, detail) {
  if (condition) {
    console.log(`  ok    ${name}`);
  } else {
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
    failures.push(name);
  }
}

/** Tool results come back as text content; unwrap and flag MCP-level errors. */
function toolText(response) {
  if (response.error) return { ok: false, text: response.error.message };
  const result = response.result;
  const text = (result?.content || []).map((part) => part.text || "").join("\n");
  return { ok: !result?.isError, text };
}

try {
  console.log("handshake");
  const initialized = await request("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "smoke-test", version: "1.0.0" },
  });
  check("initialize", Boolean(initialized.result), JSON.stringify(initialized.error));
  check(
    "server identifies itself",
    initialized.result?.serverInfo?.name === "mcp-atlassian",
    initialized.result?.serverInfo?.name,
  );

  console.log("tools");
  const listed = await request("tools/list", {});
  const tools = listed.result?.tools || [];
  check("tools/list returns tools", tools.length > 0, `got ${tools.length}`);

  const payloadBytes = JSON.stringify(tools).length;
  console.log(`  info  ${tools.length} tools, ${payloadBytes} B (~${Math.round(payloadBytes / 4)} tokens)`);

  const annotated = tools.filter((tool) => tool.annotations);
  check("every tool is annotated", annotated.length === tools.length, `${annotated.length}/${tools.length}`);

  // destructiveHint is an advisory MCP annotation describing what a tool does to
  // existing data; it is NOT the registration gate. Overwriting tools such as
  // confluence_update_page carry it even though they are plain writes.
  const destructiveHinted = tools.filter((tool) => tool.annotations?.destructiveHint);
  console.log(`  info  ${destructiveHinted.length} tools hint destructive: ${destructiveHinted.map((t) => t.name).join(", ") || "none"}`);

  // The gate is ATLASSIAN_ALLOW_DESTRUCTIVE, and what it withholds are the
  // delete tools (kind: "destructive"). That is what this check must assert.
  const deleteTools = tools.filter((tool) => /(^|_)delete_/.test(tool.name));
  if (!hasRealCredentials && process.env.ATLASSIAN_ALLOW_DESTRUCTIVE !== "true") {
    check(
      "delete tools withheld unless ATLASSIAN_ALLOW_DESTRUCTIVE=true",
      deleteTools.length === 0,
      deleteTools.map((t) => t.name).join(", "),
    );
  } else if (process.env.ATLASSIAN_ALLOW_DESTRUCTIVE === "true") {
    check("delete tools present when explicitly allowed", deleteTools.length === 6, `${deleteTools.length}/6`);
  }

  if (runLiveChecks) {
    console.log("live read-only calls");

    const jira = await request("tools/call", {
      name: "jira_search_issues",
      arguments: { jql: "ORDER BY created DESC", maxResults: 1 },
    });
    const jiraResult = toolText(jira);
    check("jira_search_issues", jiraResult.ok, jiraResult.text.slice(0, 200));

    const confluence = await request("tools/call", {
      name: "confluence_search_pages",
      arguments: { cql: "type = page", limit: 1 },
    });
    const confluenceResult = toolText(confluence);
    check("confluence_search_pages", confluenceResult.ok, confluenceResult.text.slice(0, 200));

    // Optional, read-only issue-field and ProForma checks. Opt-in via a
    // disposable/known test issue rather than a hard-coded key, so this
    // script never assumes a specific production ticket exists.
    const smokeIssue = process.env.ATLASSIAN_SMOKE_JIRA_ISSUE?.trim();
    if (smokeIssue) {
      const issueFields = await request("tools/call", {
        name: "jira_get_issue_fields",
        arguments: { issueKey: smokeIssue },
      });
      const issueFieldsResult = toolText(issueFields);
      check(
        `jira_get_issue_fields (${smokeIssue}, no fieldNames)`,
        issueFieldsResult.ok,
        issueFieldsResult.text.slice(0, 200),
      );

      const proformaSummary = await request("tools/call", {
        name: "jira_get_proforma_forms_summary",
        arguments: { issueKey: smokeIssue },
      });
      const proformaSummaryResult = toolText(proformaSummary);
      check(
        `jira_get_proforma_forms_summary (${smokeIssue})`,
        proformaSummaryResult.ok,
        proformaSummaryResult.text.slice(0, 200),
      );
    } else {
      console.log("  skip  set ATLASSIAN_SMOKE_JIRA_ISSUE to also exercise jira_get_issue_fields / ProForma reads");
    }
  } else {
    console.log("live read-only calls");
    console.log(
      hasRealCredentials
        ? "  skip  set ATLASSIAN_SMOKE_LIVE=true to explicitly enable upstream calls"
        : "  skip  no credentials in environment",
    );
  }
} catch (error) {
  console.error(`\nsmoke test aborted: ${error.message}`);
  if (stderr.trim()) console.error(`server stderr:\n${stderr.trim()}`);
  child.kill();
  process.exit(1);
}

child.kill();

console.log("");
if (failures.length > 0) {
  console.error(`${failures.length} check(s) failed: ${failures.join(", ")}`);
  if (stderr.trim()) console.error(`server stderr:\n${stderr.trim()}`);
  process.exit(1);
}

console.log("all checks passed");
process.exit(0);

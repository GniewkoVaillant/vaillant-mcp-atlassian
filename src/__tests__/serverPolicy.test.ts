import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

type ListedTool = Awaited<ReturnType<Client["listTools"]>>["tools"][number];

async function withServer(
  overrides: Record<string, string>,
  run: (client: Client, tools: ListedTool[]) => Promise<void>,
): Promise<void> {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) => value !== undefined && !key.startsWith("ATLASSIAN_"),
    ),
  ) as Record<string, string>;
  const env = {
    ...inherited,
    JIRA_BASE_URL: "https://jira.example.test",
    JIRA_PAT: "synthetic-jira-token",
    CONFLUENCE_BASE_URL: "https://confluence.example.test",
    CONFLUENCE_PAT: "synthetic-confluence-token",
    ...overrides,
  };
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [new URL("../index.js", import.meta.url).pathname],
    env,
    stderr: "pipe",
  });
  const client = new Client({ name: "server-policy-test", version: "1.0.0" });

  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    await run(client, tools);
  } finally {
    await client.close();
  }
}

describe("server-enforced MCP tool safety policy", () => {
  test("destructive tools are neither listed nor callable by default", async () => {
    await withServer({}, async (client, tools) => {
      assert.equal(tools.some((tool) => tool.name.includes("delete")), false);
      assert.equal(tools.some((tool) => tool.name === "jira_add_comment"), true);
      assert.equal(tools.some((tool) => tool.name === "confluence_delete_page"), false);

      const denied = await client.callTool({
        name: "confluence_delete_page",
        arguments: { pageId: "123" },
      });
      assert.equal(denied.isError, true);
      assert.match(JSON.stringify(denied.content), /not found|unknown tool/i);
    });
  });

  test("an explicit operator opt-in exposes correctly annotated destructive tools", async () => {
    await withServer({ ATLASSIAN_ALLOW_DESTRUCTIVE: "true" }, async (_client, tools) => {
      const destructive = tools.filter((tool) => tool.annotations?.destructiveHint);

      assert.ok(destructive.length > 0);
      assert.ok(destructive.some((tool) => tool.name === "confluence_delete_page"));
      assert.ok(destructive.some((tool) => tool.name === "jira_delete_worklog"));
    });
  });

  test("read-only mode takes precedence over destructive opt-in", async () => {
    await withServer(
      { ATLASSIAN_READ_ONLY: "true", ATLASSIAN_ALLOW_DESTRUCTIVE: "true" },
      async (_client, tools) => {
        assert.ok(tools.length > 0);
        assert.ok(tools.every((tool) => tool.annotations?.readOnlyHint === true));
      },
    );
  });

  test("the read profile never exposes mutations and retains read-only worklog discovery", async () => {
    await withServer(
      { ATLASSIAN_PROFILE: "read", ATLASSIAN_READ_ONLY: "false" },
      async (_client, tools) => {
        assert.ok(tools.every((tool) => tool.annotations?.readOnlyHint === true));
        assert.ok(tools.some((tool) => tool.name === "jira_list_worklogs"));
        assert.ok(tools.some((tool) => tool.name === "jira_list_attachments"));
      },
    );
  });

  test("in-place overwrites are annotated destructive, additive writes are not", async () => {
    await withServer({}, async (_client, tools) => {
      const hint = (name: string) =>
        tools.find((tool) => tool.name === name)?.annotations?.destructiveHint;

      // Non-additive: these replace or remove existing state without merging.
      for (const name of [
        "jira_update_issue",
        "jira_assign_issue",
        "jira_edit_comment",
        "jira_remove_watcher",
        "jira_transition_issue",
        "confluence_update_comment",
        "confluence_update_page",
      ]) {
        assert.equal(hint(name), true, `${name} should be flagged destructive`);
      }

      // Purely additive: nothing that already exists is touched.
      for (const name of [
        "jira_create_issue",
        "jira_add_comment",
        "jira_add_watcher",
        "jira_add_worklog",
        "jira_create_issue_link",
        "jira_upload_attachment",
        "confluence_add_comment",
        "confluence_create_page",
      ]) {
        assert.equal(hint(name), false, `${name} should not be flagged destructive`);
      }
    });
  });

  test("an explicit per-tool annotation overrides the value derived from kind", async () => {
    await withServer({}, async (_client, tools) => {
      const update = tools.find((tool) => tool.name === "confluence_update_page");

      // destructiveHint is overridden; the other three still come from `kind`.
      assert.equal(update?.annotations?.destructiveHint, true);
      assert.equal(update?.annotations?.readOnlyHint, false);
      assert.equal(update?.annotations?.idempotentHint, false);
      assert.equal(update?.annotations?.openWorldHint, true);
    });
  });

  test("an update with no fields is refused before any request is sent", async () => {
    await withServer({}, async (client, _tools) => {
      const page = await client.callTool({
        name: "confluence_update_page",
        arguments: { pageId: "601156620" },
      });
      assert.equal(page.isError, true);
      assert.match(JSON.stringify(page.content), /at least one of: title, body/);

      const issue = await client.callTool({
        name: "jira_update_issue",
        arguments: { issueKey: "ABC-123" },
      });
      assert.equal(issue.isError, true);
      assert.match(
        JSON.stringify(issue.content),
        /at least one of: summary, description, assignee, priority, labels, fields/,
      );
    });
  });

  test("malformed identifiers are rejected by the schema, not by Atlassian", async () => {
    await withServer({}, async (client, tools) => {
      const badKey = await client.callTool({
        name: "jira_get_issue",
        arguments: { issueKey: "https://jira.example.test/browse/ABC-123" },
      });
      assert.equal(badKey.isError, true);
      assert.match(JSON.stringify(badKey.content), /bare Jira issue key/);

      const badPage = await client.callTool({
        name: "confluence_get_page",
        arguments: { pageId: "not-a-number" },
      });
      assert.equal(badPage.isError, true);
      assert.match(JSON.stringify(badPage.content), /numeric Atlassian content ID/);

      // The ceilings that were missing entirely.
      const projects = tools.find((tool) => tool.name === "jira_list_projects");
      assert.ok(
        Object.prototype.hasOwnProperty.call(projects?.inputSchema.properties ?? {}, "limit"),
      );
      const search = tools.find((tool) => tool.name === "jira_search_issues");
      assert.equal((search?.inputSchema.properties as any)?.startAt?.maximum, 10000);
      const update = tools.find((tool) => tool.name === "jira_update_issue");
      assert.equal((update?.inputSchema.properties as any)?.labels?.maxItems, 100);
    });
  });

  test("oversized free text is refused rather than shipped to Atlassian", async () => {
    await withServer({}, async (client, _tools) => {
      const result = await client.callTool({
        name: "confluence_update_page",
        arguments: { pageId: "601156620", body: "x".repeat(100_001) },
      });
      assert.equal(result.isError, true);
      assert.match(JSON.stringify(result.content), /at most 100000 characters/);
    });
  });

  test("tool output is clamped to the configured ceiling with an explicit marker", async () => {
    await withServer({ ATLASSIAN_MAX_TOOL_RESULT_BYTES: "200" }, async (client, _tools) => {
      const result = await client.callTool({
        name: "jira_get_issue",
        arguments: { issueKey: "ABC-123" },
      });
      // The host does not resolve, so this is the error path — which is exactly
      // the point: every text part a handler returns goes through the clamp.
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      assert.ok(Buffer.byteLength(text, "utf8") <= 200, `got ${Buffer.byteLength(text, "utf8")}`);
      assert.match(text, /truncated: \d+ of \d+ bytes omitted/);
      assert.match(text, /jira_get_issue failed/);
    });
  });

  test("attachment upload is identified as a remote write", async () => {
    await withServer({}, async (_client, tools) => {
      const upload = tools.find((tool) => tool.name === "jira_upload_attachment");

      assert.equal(upload?.annotations?.readOnlyHint, false);
      assert.equal(upload?.annotations?.openWorldHint, true);
    });
  });
});

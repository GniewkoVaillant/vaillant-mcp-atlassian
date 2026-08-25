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
      assert.equal(tools.some((tool) => tool.annotations?.destructiveHint), false);
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

  test("attachment upload is identified as a remote write", async () => {
    await withServer({}, async (_client, tools) => {
      const upload = tools.find((tool) => tool.name === "jira_upload_attachment");

      assert.equal(upload?.annotations?.readOnlyHint, false);
      assert.equal(upload?.annotations?.openWorldHint, true);
    });
  });
});

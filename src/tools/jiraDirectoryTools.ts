/**
 * Registers the Jira user and group directory tools.
 *
 * Read-only by design. Creating or deactivating accounts is an identity
 * operation with its own audit trail and approval path; exposing it through an
 * agent would put user provisioning behind a chat prompt, which is not a
 * trade this server is willing to make.
 */
import { z } from "zod";
import type { JiraDirectoryClient } from "../jiraDirectoryClient.js";
import { issueKeySchema, projectKeySchema, runTool, type ToolRegistrar } from "./shared.js";

export function registerJiraDirectoryTools(tool: ToolRegistrar, client: JiraDirectoryClient): void {
    tool("users", "read", "jira_search_users", {
        title: "Search Jira users",
        description:
            "Search the Jira Data Center user directory by username, display name or email fragment. " +
            "Returns the `name` (username) that every write tool here expects — jira_assign_issue, " +
            "jira_add_watcher and jira_add_filter_permission all take a username, which rarely matches " +
            "the display name a person is known by. Results are capped at 50. Read-only.",
        inputSchema: {
            query: z.string().min(1).max(255)
                .describe("Fragment matched against username, display name and email"),
            limit: z.number().int().positive().max(50).optional()
                .describe("Maximum users to return (default 20, hard cap 50)"),
            includeInactive: z.boolean().optional()
                .describe("Include deactivated accounts (default false; they cannot be assigned work)"),
        },
    }, async ({ query, limit, includeInactive }) =>
        runTool("jira_search_users", () => client.searchUsers(query, limit, includeInactive)));

    tool("users", "read", "jira_find_assignable_users", {
        title: "Find assignable Jira users",
        description:
            "Search only users who may actually be assigned a given issue or project. This is the " +
            "correct lookup before jira_assign_issue: an account can exist and be active and still lack " +
            "the Assignable User permission on that project, in which case the assign call fails. " +
            "Supply issueKey or projectKey. Read-only.",
        inputSchema: {
            query: z.string().max(255).optional()
                .describe("Optional fragment matched against username and display name"),
            issueKey: issueKeySchema.optional().describe("Issue the user must be assignable to, e.g. 'ABC-123'"),
            projectKey: projectKeySchema.optional().describe("Project the user must be assignable in, e.g. 'ABC'"),
            limit: z.number().int().positive().max(50).optional()
                .describe("Maximum users to return (default 20, hard cap 50)"),
        },
        validate: ({ issueKey, projectKey }) =>
            issueKey === undefined && projectKey === undefined
                ? "assignability is scoped — supply either issueKey or projectKey."
                : undefined,
    }, async ({ query, issueKey, projectKey, limit }) =>
        runTool("jira_find_assignable_users", () =>
            client.findAssignableUsers({ query, issueKey, projectKey, limit })));

    tool("users", "read", "jira_get_user", {
        title: "Get a Jira user",
        description: "Resolve one exact username into its profile: display name, email and whether the " +
            "account is active. Fails if no such username exists, which is the useful answer when a " +
            "write is about to be attempted against it. Read-only.",
        inputSchema: {
            username: z.string().min(1).max(255)
                .describe("Exact Jira username (the `name` field, not the display name)"),
        },
    }, async ({ username }) => runTool("jira_get_user", () => client.getUser(username)));

    tool("users", "read", "jira_list_group_members", {
        title: "List Jira group members",
        description: "List the members of a Jira group, with a truncation flag. Corporate groups run to " +
            "thousands of accounts, so results are capped at 50 and `hasMore` reports when the group is " +
            "larger than what came back. Read-only.",
        inputSchema: {
            groupName: z.string().min(1).max(255).describe("Exact group name, e.g. 'jira-software-users'"),
            limit: z.number().int().positive().max(50).optional()
                .describe("Maximum members to return (default 20, hard cap 50)"),
            includeInactive: z.boolean().optional().describe("Include deactivated members (default false)"),
        },
    }, async ({ groupName, limit, includeInactive }) =>
        runTool("jira_list_group_members", () => client.listGroupMembers(groupName, limit, includeInactive)));

    tool("users", "read", "jira_find_groups", {
        title: "Find Jira groups",
        description: "Find group names matching a fragment, so a filter share or a notification can name " +
            "a group that really exists. Read-only.",
        inputSchema: {
            query: z.string().min(1).max(255).describe("Fragment matched against group names"),
            limit: z.number().int().positive().max(50).optional()
                .describe("Maximum groups to return (default 20, hard cap 50)"),
        },
    }, async ({ query, limit }) => runTool("jira_find_groups", () => client.findGroups(query, limit)));

    tool("users", "read", "jira_get_my_permissions", {
        title: "Get the current user's Jira permissions",
        description:
            "List the permissions the configured Personal Access Token's owner actually holds, " +
            "optionally scoped to one project or issue. Only granted permissions are returned. Checking " +
            "this before a write turns a post-hoc 403 into 'this account cannot do that', which is the " +
            "difference between retrying pointlessly and asking for access. Read-only.",
        inputSchema: {
            projectKey: projectKeySchema.optional().describe("Scope the answer to one project, e.g. 'ABC'"),
            issueKey: issueKeySchema.optional().describe("Scope the answer to one issue, e.g. 'ABC-123'"),
        },
    }, async ({ projectKey, issueKey }) =>
        runTool("jira_get_my_permissions", () => client.getMyPermissions({ projectKey, issueKey })));
}

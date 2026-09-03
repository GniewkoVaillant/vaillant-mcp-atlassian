/**
 * Registers the issue-level Jira tools that sit outside the original
 * create/update/comment set: bulk creation, remote links, notifications, votes,
 * worklog edits and issue properties.
 */
import { z } from "zod";
import type { JiraClient } from "../jiraClient.js";
import {
    externalUrlSchema,
    issueKeySchema,
    projectKeySchema,
    runTool,
    textFieldSchema,
    titleFieldSchema,
    type ToolRegistrar,
} from "./shared.js";

export function registerJiraIssueExtraTools(tool: ToolRegistrar, client: JiraClient): void {
    tool("write", "write", "jira_bulk_create_issues", {
        title: "Create several Jira issues at once",
        description:
            "Create up to 50 Jira issues in one request. Mutates data: every accepted row becomes a " +
            "real issue. Jira applies rows independently, so **partial success is normal** — the result " +
            "reports `created` and `failed` separately, and a non-empty `failed` list does not mean " +
            "nothing was created. Re-running the whole batch after a partial failure duplicates the " +
            "rows that already succeeded. Call jira_get_create_meta first to confirm the fields each " +
            "issue type requires.",
        inputSchema: {
            issues: z.array(z.object({
                projectKey: projectKeySchema.describe("Project key, e.g. 'ABC'"),
                issueType: z.string().max(255).describe("Issue type name, e.g. 'Story', 'Task', 'Bug'"),
                summary: titleFieldSchema.describe("Issue summary/title"),
                description: textFieldSchema.optional().describe("Issue description"),
                parentKey: issueKeySchema.optional().describe("Parent issue key, required for a sub-task"),
                assignee: z.string().max(255).optional().describe("Assignee username"),
                priority: z.string().max(255).optional().describe("Priority name, e.g. 'High'"),
                labels: z.array(z.string().max(255)).max(100).optional().describe("Labels to set"),
                fields: z.record(z.string(), z.unknown()).optional()
                    .describe("Escape hatch: raw Jira `fields` entries for anything not named above"),
            })).min(1).max(50).describe("The issues to create, at most 50 per call"),
        },
    }, async ({ issues }) =>
        runTool("jira_bulk_create_issues", () => client.bulkCreateIssues(issues)));

    tool("links", "read", "jira_list_remote_links", {
        title: "List Jira remote links",
        description: "List an issue's remote links: the web links pointing outside Jira, such as " +
            "Confluence pages or documents. These live on a separate endpoint and are invisible to " +
            "jira_get_issue_links, which only sees issue-to-issue relationships. Read-only.",
        inputSchema: {
            issueKey: issueKeySchema.describe("Jira issue key, e.g. 'ABC-123'"),
        },
    }, async ({ issueKey }) =>
        runTool("jira_list_remote_links", () => client.listRemoteLinks(issueKey)));

    tool("links", "write", "jira_create_remote_link", {
        title: "Add a remote link to a Jira issue",
        description: "Attach an external http(s) URL to a Jira issue, so it appears under the issue's " +
            "links. Mutates data. Use jira_create_issue_link instead for a link between two Jira issues.",
        inputSchema: {
            issueKey: issueKeySchema.describe("Jira issue key, e.g. 'ABC-123'"),
            url: externalUrlSchema.describe("Absolute http(s) URL to link to"),
            title: titleFieldSchema.describe("Link text shown on the issue"),
            summary: textFieldSchema.optional().describe("Optional short description shown with the link"),
            relationship: z.string().max(255).optional()
                .describe("Relationship label, e.g. 'documented by', 'causes'"),
            globalId: z.string().max(255).optional()
                .describe("Stable identifier; re-using one updates that link instead of adding another"),
        },
    }, async ({ issueKey, ...options }) =>
        runTool("jira_create_remote_link", () => client.createRemoteLink(issueKey, options)));

    tool("links", "destructive", "jira_delete_remote_link", {
        title: "Delete a Jira remote link",
        description: "Delete one remote link from an issue by its link ID. Mutates data and cannot be " +
            "undone.",
        inputSchema: {
            issueKey: issueKeySchema.describe("Jira issue key, e.g. 'ABC-123'"),
            linkId: z.string().max(64).describe("Link ID returned by jira_list_remote_links"),
        },
    }, async ({ issueKey, linkId }) =>
        runTool("jira_delete_remote_link", () => client.deleteRemoteLink(issueKey, linkId)));

    tool("write", "write", "jira_notify_issue", {
        title: "Send a Jira issue notification",
        description:
            "Send an ad-hoc email about an issue to named users, groups, or the issue's reporter, " +
            "assignee and watchers. This leaves Jira and reaches people's inboxes: it cannot be recalled " +
            "and it is not an issue comment, so it leaves no visible record on the issue. Prefer " +
            "jira_add_comment unless a mail is specifically what is wanted. At least one recipient is " +
            "required.",
        inputSchema: {
            issueKey: issueKeySchema.describe("Jira issue key, e.g. 'ABC-123'"),
            subject: titleFieldSchema.describe("Email subject"),
            body: textFieldSchema.describe("Email body, as plain text"),
            toUsernames: z.array(z.string().max(255)).max(50).optional()
                .describe("Usernames to notify (the `name` field, verified with jira_search_users)"),
            toGroups: z.array(z.string().max(255)).max(20).optional()
                .describe("Group names to notify — a group can be very large, so check jira_list_group_members first"),
            toReporter: z.boolean().optional().describe("Also notify the issue's reporter"),
            toAssignee: z.boolean().optional().describe("Also notify the issue's assignee"),
            toWatchers: z.boolean().optional().describe("Also notify everyone watching the issue"),
        },
        validate: ({ toUsernames, toGroups, toReporter, toAssignee, toWatchers }) => {
            const named = (value: unknown) => Array.isArray(value) && value.length > 0;
            return !named(toUsernames) && !named(toGroups) && !toReporter && !toAssignee && !toWatchers
                ? "no recipients — supply at least one of: toUsernames, toGroups, toReporter, " +
                  "toAssignee, toWatchers."
                : undefined;
        },
    }, async ({ issueKey, ...options }) =>
        runTool("jira_notify_issue", () => client.notifyIssue(issueKey, options)));

    tool("write", "read", "jira_get_issue_votes", {
        title: "Get Jira issue votes",
        description: "Get an issue's vote count, who voted, and whether the current user has. Read-only.",
        inputSchema: {
            issueKey: issueKeySchema.describe("Jira issue key, e.g. 'ABC-123'"),
        },
    }, async ({ issueKey }) => runTool("jira_get_issue_votes", () => client.getIssueVotes(issueKey)));

    tool("write", "write", "jira_set_issue_vote", {
        title: "Vote on a Jira issue",
        description: "Add or remove the current user's vote on an issue. Mutates data, and the vote is " +
            "attributed to the account behind the configured token — it is that person's vote, not an " +
            "anonymous one. Jira does not let a user vote on an issue they reported.",
        inputSchema: {
            issueKey: issueKeySchema.describe("Jira issue key, e.g. 'ABC-123'"),
            vote: z.boolean().describe("True to vote, false to remove the vote"),
        },
    }, async ({ issueKey, vote }) =>
        runTool("jira_set_issue_vote", () => client.setIssueVote(issueKey, vote)));

    tool("write", "write", "jira_update_worklog", {
        title: "Update a Jira worklog entry",
        description:
            "Edit an existing worklog entry's time, comment or start time. Mutates data: the entry is " +
            "replaced, and fields left out keep their current values. Jira normally restricts this to " +
            "your own worklogs unless you hold project-admin rights. Worklogs created through the " +
            "vaillant-timetracking plugin carry a work category this endpoint does not preserve — check " +
            "the plugin's timesheet after editing one.",
        inputSchema: {
            issueKey: issueKeySchema.describe("Jira issue key, e.g. 'ABC-123'"),
            worklogId: z.string().max(64).describe("Worklog ID returned by jira_list_worklogs"),
            timeSpent: z.string().max(64).optional().describe("New duration in Jira format, e.g. '3h 30m'"),
            comment: textFieldSchema.optional().describe("New worklog comment"),
            started: z.string().max(64).optional()
                .describe("New start time, ISO-8601, e.g. '2026-03-31T09:00:00.000+0200'"),
        },
        // Replaces the entry rather than adding to it.
        annotations: { destructiveHint: true },
        validate: ({ timeSpent, comment, started }) =>
            timeSpent === undefined && comment === undefined && started === undefined
                ? "nothing to update — supply at least one of: timeSpent, comment, started."
                : undefined,
    }, async ({ issueKey, worklogId, ...options }) =>
        runTool("jira_update_worklog", () => client.updateWorklog(issueKey, worklogId, options)));

    tool("write", "read", "jira_list_issue_properties", {
        title: "List Jira issue property keys",
        description: "List the property keys stored on an issue. Issue properties are app storage — " +
            "ProForma's form data lives here — so this is mostly useful for diagnosing what an installed " +
            "app has recorded against an issue. Read-only.",
        inputSchema: {
            issueKey: issueKeySchema.describe("Jira issue key, e.g. 'ABC-123'"),
        },
    }, async ({ issueKey }) =>
        runTool("jira_list_issue_properties", () => client.listIssueProperties(issueKey)));

    tool("write", "destructive", "jira_set_issue_property", {
        title: "Write a Jira issue property",
        description:
            "Write a JSON value into an issue property, replacing whatever was there. Mutates data and " +
            "is treated as destructive for a reason: issue properties are where installed apps keep " +
            "their own state, and overwriting one — ProForma's form data, for instance — corrupts that " +
            "app's records with no undo and no version history. Only use it for a property key you own.",
        inputSchema: {
            issueKey: issueKeySchema.describe("Jira issue key, e.g. 'ABC-123'"),
            propertyKey: z.string().min(1).max(255)
                .describe("Property key to write. Never reuse an app's key, e.g. anything starting with 'proforma.'"),
            value: z.unknown().describe("JSON value to store"),
        },
    }, async ({ issueKey, propertyKey, value }) =>
        runTool("jira_set_issue_property", () => client.setIssueProperty(issueKey, propertyKey, value)));
}

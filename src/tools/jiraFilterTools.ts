/**
 * Registers the Jira saved-filter and dashboard tools.
 *
 * Sharing is treated as a disclosure decision throughout: creating a filter
 * leaves it private, and widening its audience is a separate, explicitly named
 * call. "global" and "authenticated" are spelled out in the description rather
 * than hidden behind a type string, because both mean "everyone who can log in
 * can read this query and its results".
 */
import { z } from "zod";
import type { JiraFilterClient } from "../jiraFilterClient.js";
import {
    jiraIdSchema,
    runTool,
    textFieldSchema,
    titleFieldSchema,
    type ToolRegistrar,
} from "./shared.js";

/** JQL is free text, but a filter's query is not a place for a 100 kB paste. */
const jqlSchema = z.string().min(1).max(10_000);

export function registerJiraFilterTools(tool: ToolRegistrar, client: JiraFilterClient): void {
    tool("filters", "read", "jira_list_favourite_filters", {
        title: "List favourite Jira filters",
        description: "List the saved filters the current user has marked as favourites, with their JQL " +
            "and who they are shared with. This is the shortest path from 'the filter I always use' to " +
            "a query you can actually run. Read-only.",
        inputSchema: {
            limit: z.number().int().positive().max(50).optional()
                .describe("Maximum filters to return (default 25, hard cap 50)"),
        },
    }, async ({ limit }) =>
        runTool("jira_list_favourite_filters", () => client.listFavouriteFilters(limit)));

    tool("filters", "read", "jira_search_filters", {
        title: "Search Jira filters",
        description:
            "Search saved filters by name or owner. Jira Data Center 9.x has no filter-search endpoint, " +
            "so on those instances this falls back to filtering the caller's favourites and reports " +
            "`source: \"favourites\"` — a narrower result set that must not be read as 'no such filter " +
            "exists'. Read-only.",
        inputSchema: {
            name: z.string().max(255).optional().describe("Fragment matched against the filter name"),
            owner: z.string().max(255).optional().describe("Filter owner's username"),
            groupName: z.string().max(255).optional().describe("Only filters shared with this group"),
            projectId: z.number().int().positive().optional().describe("Only filters shared with this project ID"),
            limit: z.number().int().positive().max(50).optional()
                .describe("Maximum filters to return (default 25, hard cap 50)"),
        },
    }, async (args) => runTool("jira_search_filters", () => client.searchFilters(args)));

    tool("filters", "read", "jira_get_filter", {
        title: "Get a Jira filter",
        description: "Get one saved filter by ID: its JQL, owner, description and share permissions. " +
            "Pass the JQL to jira_search_issues to run it. Read-only.",
        inputSchema: {
            filterId: jiraIdSchema.describe("Filter ID, the number in a `?filter=12345` URL"),
        },
    }, async ({ filterId }) => runTool("jira_get_filter", () => client.getFilter(filterId)));

    tool("filters", "read", "jira_get_filter_permissions", {
        title: "Get Jira filter share permissions",
        description: "List who a saved filter is shared with, with each share's ID so it can be removed " +
            "by jira_delete_filter_permission. Read-only.",
        inputSchema: {
            filterId: jiraIdSchema.describe("Filter ID"),
        },
    }, async ({ filterId }) =>
        runTool("jira_get_filter_permissions", () => client.getFilterPermissions(filterId)));

    tool("filters", "read", "jira_list_dashboards", {
        title: "List Jira dashboards",
        description: "List dashboards visible to the current user. Dashboards are where saved filters " +
            "are consumed, so this is how 'which report does this query drive' becomes answerable. " +
            "Data Center publishes no gadget-level REST API, so gadget contents are not available. " +
            "Read-only.",
        inputSchema: {
            favouriteOnly: z.boolean().optional().describe("Return only the caller's favourite dashboards"),
            limit: z.number().int().positive().max(50).optional()
                .describe("Maximum dashboards to return (default 25, hard cap 50)"),
        },
    }, async (args) => runTool("jira_list_dashboards", () => client.listDashboards(args)));

    tool("filters", "read", "jira_get_dashboard", {
        title: "Get a Jira dashboard",
        description: "Get one dashboard's name, owner and view URL. Read-only.",
        inputSchema: {
            dashboardId: jiraIdSchema.describe("Dashboard ID"),
        },
    }, async ({ dashboardId }) => runTool("jira_get_dashboard", () => client.getDashboard(dashboardId)));

    tool("filters", "write", "jira_create_filter", {
        title: "Create a Jira filter",
        description:
            "Save a JQL query as a Jira filter. Mutates data: creates a real filter owned by the " +
            "account behind the configured token. The filter is created **private** — nobody else can " +
            "see it until jira_add_filter_permission is called explicitly. Validate the JQL with " +
            "jira_search_issues first; Jira accepts a syntactically valid query that returns nothing.",
        inputSchema: {
            name: titleFieldSchema.describe("Filter name, as it will appear in Jira's filter list"),
            jql: jqlSchema.describe("The JQL query to save"),
            description: textFieldSchema.optional().describe("Filter description"),
            favourite: z.boolean().optional()
                .describe("Also add the new filter to the caller's own favourites (default false)"),
        },
    }, async (args) => runTool("jira_create_filter", () => client.createFilter(args)));

    tool("filters", "write", "jira_update_filter", {
        title: "Update a Jira filter",
        description:
            "Update a saved filter's name, JQL or description. Mutates data. Anyone the filter is " +
            "shared with sees the new query immediately, and boards or dashboards driven by it change " +
            "with it — changing a shared filter's JQL is not a private edit. Omitted fields keep their " +
            "current values.",
        inputSchema: {
            filterId: jiraIdSchema.describe("Filter ID"),
            name: titleFieldSchema.optional().describe("New filter name"),
            jql: jqlSchema.optional().describe("New JQL query"),
            description: textFieldSchema.optional().describe("New description"),
            favourite: z.boolean().optional().describe("Set the caller's favourite flag"),
        },
        // Replaces the stored definition; it is not merged with the old one.
        annotations: { destructiveHint: true },
        validate: ({ name, jql, description, favourite }) =>
            name === undefined && jql === undefined && description === undefined && favourite === undefined
                ? "nothing to update — supply at least one of: name, jql, description, favourite."
                : undefined,
    }, async ({ filterId, ...options }) =>
        runTool("jira_update_filter", () => client.updateFilter(filterId, options)));

    tool("filters", "write", "jira_set_filter_favourite", {
        title: "Set a Jira filter as favourite",
        description: "Add or remove a saved filter from the current user's favourites. Affects only the " +
            "token owner's own list; nobody else's view changes.",
        inputSchema: {
            filterId: jiraIdSchema.describe("Filter ID"),
            favourite: z.boolean().describe("True to favourite, false to un-favourite"),
        },
    }, async ({ filterId, favourite }) =>
        runTool("jira_set_filter_favourite", () => client.setFilterFavourite(filterId, favourite)));

    tool("filters", "write", "jira_add_filter_permission", {
        title: "Share a Jira filter",
        description:
            "Share a saved filter with a group, a project, a project role, one user, every logged-in " +
            "user ('authenticated') or everyone who can reach the instance ('global'). Mutates data and " +
            "widens who can read the query **and the issues it returns** — 'global' and 'authenticated' " +
            "are instance-wide disclosures, so prefer a named group or project. Shares are added " +
            "view-only; edit rights are not granted by this tool.",
        inputSchema: {
            filterId: jiraIdSchema.describe("Filter ID"),
            type: z.enum(["group", "project", "projectRole", "user", "authenticated", "global"])
                .describe("Who to share with. 'authenticated' = any logged-in user; 'global' = everyone"),
            groupName: z.string().max(255).optional()
                .describe("Group name, required when type is 'group'. Verify it with jira_find_groups"),
            projectId: jiraIdSchema.optional()
                .describe("Project ID, required when type is 'project' or 'projectRole'"),
            projectRoleId: jiraIdSchema.optional()
                .describe("Project role ID from jira_list_project_roles, required when type is 'projectRole'"),
            username: z.string().max(255).optional()
                .describe("Username, required when type is 'user'. Verify it with jira_search_users"),
        },
    }, async ({ filterId, ...options }) =>
        runTool("jira_add_filter_permission", () => client.addFilterPermission(filterId, options)));

    tool("filters", "destructive", "jira_delete_filter_permission", {
        title: "Remove a Jira filter share",
        description: "Remove one share permission from a saved filter, narrowing who can see it. " +
            "Mutates data. People who relied on that share lose access to the filter, and any board or " +
            "dashboard they own that is driven by it stops working for them.",
        inputSchema: {
            filterId: jiraIdSchema.describe("Filter ID"),
            permissionId: jiraIdSchema.describe("Share permission ID from jira_get_filter_permissions"),
        },
    }, async ({ filterId, permissionId }) =>
        runTool("jira_delete_filter_permission", () => client.deleteFilterPermission(filterId, permissionId)));

    tool("filters", "destructive", "jira_delete_filter", {
        title: "Delete a Jira filter",
        description: "Permanently delete a saved filter. Mutates data and cannot be undone. Any board, " +
            "dashboard gadget or subscription driven by this filter breaks — check " +
            "jira_get_filter_permissions first to see who else depends on it.",
        inputSchema: {
            filterId: jiraIdSchema.describe("Filter ID"),
        },
    }, async ({ filterId }) => runTool("jira_delete_filter", () => client.deleteFilter(filterId)));
}

/**
 * Registers the Jira metadata and project-configuration tools.
 *
 * These exist to make the write tools survivable. `jira_create_issue` and
 * `jira_update_issue` accept a project, an issue type and a field bag, and Jira
 * answers a bare 400 when any of them is wrong for that screen. The discovery
 * tools here are the lookup that turns those failures into a decision the agent
 * can make before it sends anything.
 */
import { z } from "zod";
import type { JiraMetaClient } from "../jiraMetaClient.js";
import {
    isoDateSchema,
    issueKeySchema,
    jiraIdSchema,
    projectKeySchema,
    runTool,
    textFieldSchema,
    titleFieldSchema,
    type ToolRegistrar,
} from "./shared.js";

export function registerJiraMetaTools(tool: ToolRegistrar, client: JiraMetaClient): void {
    tool("meta", "read", "jira_list_fields", {
        title: "List Jira fields",
        description:
            "List the Jira Data Center field catalogue: field ID, name, whether it is a custom field, " +
            "its schema type and the names it can be referenced by in JQL. Use it to resolve a custom " +
            "field's ID before passing it to jira_update_issue's `fields` object or naming it in JQL. " +
            "Read-only.",
        inputSchema: {
            query: z
                .string()
                .max(255)
                .optional()
                .describe("Optional case-insensitive filter matched against field ID, name and JQL clause names"),
            limit: z.number().int().positive().max(500).optional()
                .describe("Maximum fields to return; a real instance carries several hundred"),
        },
    }, async ({ query, limit }) =>
        runTool("jira_list_fields", () => client.listFields(query, limit)));

    tool("meta", "read", "jira_get_create_meta", {
        title: "Get Jira issue creation metadata",
        description:
            "Get the fields a project's issue types accept on the create screen, with which are required " +
            "and which values they allow. Call this before jira_create_issue or jira_bulk_create_issues " +
            "against an unfamiliar project: it is the difference between a working create and an opaque " +
            "400 naming a custom field ID. Allowed-value lists are capped per field. Read-only.",
        inputSchema: {
            projectKeys: z.array(projectKeySchema).min(1).max(10)
                .describe("Project keys to describe, e.g. ['ABC']. Required on Jira 9+, where the global form of this endpoint was removed"),
            issueTypeNames: z.array(z.string().max(255)).max(20).optional()
                .describe("Optional issue type names to narrow the answer, e.g. ['Bug','Story']"),
            includeFields: z.boolean().optional()
                .describe("Include per-field metadata (default true). Set false for just the issue type list, which is far smaller"),
        },
    }, async ({ projectKeys, issueTypeNames, includeFields }) =>
        runTool("jira_get_create_meta", () =>
            client.getCreateMeta({ projectKeys, issueTypeNames, includeFields })));

    tool("meta", "read", "jira_get_edit_meta", {
        title: "Get Jira issue edit metadata",
        description:
            "Get the fields the current user may edit on one issue, with their allowed values and the " +
            "update operations each accepts. This answers 'will this update be rejected, and what may " +
            "I send instead' before jira_update_issue is called. Read-only.",
        inputSchema: {
            issueKey: issueKeySchema.describe("Jira issue key, e.g. 'ABC-123'"),
        },
    }, async ({ issueKey }) =>
        runTool("jira_get_edit_meta", () => client.getEditMeta(issueKey)));

    tool("meta", "read", "jira_list_issue_types", {
        title: "List Jira issue types",
        description: "List every issue type configured on the instance, with ID, name and description. " +
            "Note that a project usually accepts only a subset — use jira_get_create_meta for what one " +
            "project actually allows. Read-only.",
        inputSchema: {},
    }, async () => runTool("jira_list_issue_types", () => client.listIssueTypes()));

    tool("meta", "read", "jira_list_priorities", {
        title: "List Jira priorities",
        description: "List the priority values this instance defines, so jira_create_issue and " +
            "jira_update_issue can be given a name Jira will accept. Read-only.",
        inputSchema: {},
    }, async () => runTool("jira_list_priorities", () => client.listPriorities()));

    tool("meta", "read", "jira_list_resolutions", {
        title: "List Jira resolutions",
        description: "List the resolution values this instance defines. Workflows commonly require a " +
            "resolution on the transition screen; jira_get_transitions reports which, and this reports " +
            "the values that exist. Read-only.",
        inputSchema: {},
    }, async () => runTool("jira_list_resolutions", () => client.listResolutions()));

    tool("meta", "read", "jira_list_statuses", {
        title: "List Jira statuses",
        description: "List every status defined on the instance. For the statuses one project's " +
            "workflows actually use, prefer jira_list_project_statuses. Read-only.",
        inputSchema: {},
    }, async () => runTool("jira_list_statuses", () => client.listStatuses()));

    tool("meta", "read", "jira_get_project", {
        title: "Get Jira project details",
        description: "Get one project's configuration: lead, type, issue types, component names and " +
            "versions. Read-only.",
        inputSchema: {
            projectKey: projectKeySchema.describe("Project key, e.g. 'ABC'"),
        },
    }, async ({ projectKey }) =>
        runTool("jira_get_project", () => client.getProject(projectKey)));

    tool("meta", "read", "jira_list_project_components", {
        title: "List Jira project components",
        description: "List a project's components with their IDs, descriptions, leads and default " +
            "assignee behaviour. Read-only.",
        inputSchema: {
            projectKey: projectKeySchema.describe("Project key, e.g. 'ABC'"),
        },
    }, async ({ projectKey }) =>
        runTool("jira_list_project_components", () => client.listProjectComponents(projectKey)));

    tool("meta", "read", "jira_list_project_versions", {
        title: "List Jira project versions",
        description: "List a project's versions (fix versions / releases), with release and archive " +
            "state and dates. Read-only.",
        inputSchema: {
            projectKey: projectKeySchema.describe("Project key, e.g. 'ABC'"),
        },
    }, async ({ projectKey }) =>
        runTool("jira_list_project_versions", () => client.listProjectVersions(projectKey)));

    tool("meta", "read", "jira_list_project_statuses", {
        title: "List Jira project statuses by issue type",
        description: "List the statuses each of a project's issue types can reach, grouped by issue " +
            "type and annotated with the status category. This is the workflow as it actually applies " +
            "to this project. Read-only.",
        inputSchema: {
            projectKey: projectKeySchema.describe("Project key, e.g. 'ABC'"),
        },
    }, async ({ projectKey }) =>
        runTool("jira_list_project_statuses", () => client.listProjectStatuses(projectKey)));

    tool("meta", "read", "jira_list_project_roles", {
        title: "List Jira project roles",
        description: "List a project's roles and their IDs. The role ID is what jira_add_filter_permission " +
            "needs to share a filter with a project role. Read-only.",
        inputSchema: {
            projectKey: projectKeySchema.describe("Project key, e.g. 'ABC'"),
        },
    }, async ({ projectKey }) =>
        runTool("jira_list_project_roles", () => client.listProjectRoles(projectKey)));

    tool("meta", "read", "jira_get_jql_autocomplete", {
        title: "Get JQL fields and functions",
        description: "List the fields, functions and reserved words this instance accepts in JQL, with " +
            "the operators each field supports. Use it before composing a JQL query against an " +
            "unfamiliar instance, where a wrong custom field name costs a full round trip. Read-only.",
        inputSchema: {},
    }, async () => runTool("jira_get_jql_autocomplete", () => client.getJqlAutocomplete()));

    tool("meta", "read", "jira_get_jql_suggestions", {
        title: "Get JQL value suggestions",
        description: "Suggest valid values for one JQL field, optionally filtered by a fragment — for " +
            "example which sprints match '2026' or which components start with 'api'. Read-only.",
        inputSchema: {
            fieldName: z.string().max(255).describe("JQL field name, e.g. 'sprint', 'component', 'fixVersion'"),
            fieldValue: z.string().max(255).optional()
                .describe("Optional fragment the suggested values must contain"),
        },
    }, async ({ fieldName, fieldValue }) =>
        runTool("jira_get_jql_suggestions", () => client.getJqlSuggestions(fieldName, fieldValue)));

    tool("meta", "read", "jira_get_myself", {
        title: "Get the current Jira user",
        description: "Return the account behind the configured Personal Access Token: username, display " +
            "name, email, time zone and group memberships. Every 'assign this to me' or 'what did I log' " +
            "request needs the username, which is not otherwise discoverable. Read-only.",
        inputSchema: {},
    }, async () => runTool("jira_get_myself", () => client.getMyself()));

    tool("meta", "write", "jira_create_version", {
        title: "Create Jira project version",
        description: "Create a version (fix version / release) in a project. Mutates data: sends a POST " +
            "that creates a real version other people will see in the release picker.",
        inputSchema: {
            projectKey: projectKeySchema.describe("Project key the version belongs to, e.g. 'ABC'"),
            name: titleFieldSchema.describe("Version name, e.g. '2026.1'"),
            description: textFieldSchema.optional().describe("Version description"),
            startDate: isoDateSchema.optional().describe("Start date, ISO-8601, e.g. '2026-01-15'"),
            releaseDate: isoDateSchema.optional().describe("Planned release date, ISO-8601"),
            released: z.boolean().optional().describe("Create the version already marked released"),
        },
    }, async (args) => runTool("jira_create_version", () => client.createVersion(args)));

    tool("meta", "write", "jira_update_version", {
        title: "Update Jira project version",
        description: "Update a project version's name, dates, or release/archive state. Mutates data. " +
            "Marking a version released is visible to everyone and drives release reports, so treat it " +
            "as a real publication step. Omit a field to leave it unchanged.",
        inputSchema: {
            versionId: jiraIdSchema.describe("Version ID returned by jira_list_project_versions"),
            name: titleFieldSchema.optional().describe("New version name"),
            description: textFieldSchema.optional().describe("New description"),
            startDate: isoDateSchema.optional().describe("New start date, ISO-8601"),
            releaseDate: isoDateSchema.optional().describe("New release date, ISO-8601"),
            released: z.boolean().optional().describe("Mark the version released or unreleased"),
            archived: z.boolean().optional().describe("Archive or unarchive the version"),
        },
        annotations: { destructiveHint: true },
        validate: ({ name, description, startDate, releaseDate, released, archived }) =>
            name === undefined && description === undefined && startDate === undefined &&
            releaseDate === undefined && released === undefined && archived === undefined
                ? "nothing to update — supply at least one of: name, description, startDate, " +
                  "releaseDate, released, archived."
                : undefined,
    }, async ({ versionId, ...options }) =>
        runTool("jira_update_version", () => client.updateVersion(versionId, options)));

    tool("meta", "destructive", "jira_delete_version", {
        title: "Delete Jira project version",
        description: "Permanently delete a project version. Mutates data and cannot be undone: issues " +
            "referencing this version lose it. Consider jira_update_version with archived=true instead, " +
            "which hides the version without destroying the reference.",
        inputSchema: {
            versionId: jiraIdSchema.describe("Version ID returned by jira_list_project_versions"),
        },
    }, async ({ versionId }) =>
        runTool("jira_delete_version", () => client.deleteVersion(versionId)));

    tool("meta", "write", "jira_create_component", {
        title: "Create Jira project component",
        description: "Create a component in a project. Mutates data: sends a POST that creates a real " +
            "component other people will see in the component picker.",
        inputSchema: {
            projectKey: projectKeySchema.describe("Project key the component belongs to, e.g. 'ABC'"),
            name: titleFieldSchema.describe("Component name"),
            description: textFieldSchema.optional().describe("Component description"),
            leadUserName: z.string().max(255).optional()
                .describe("Username of the component lead (the `name` field, not the display name)"),
            assigneeType: z.enum(["PROJECT_DEFAULT", "COMPONENT_LEAD", "PROJECT_LEAD", "UNASSIGNED"]).optional()
                .describe("Default assignee behaviour for issues in this component"),
        },
    }, async (args) => runTool("jira_create_component", () => client.createComponent(args)));

    tool("meta", "write", "jira_update_component", {
        title: "Update Jira project component",
        description: "Update a component's name, description, lead or default assignee behaviour. " +
            "Mutates data. Omit a field to leave it unchanged.",
        inputSchema: {
            componentId: jiraIdSchema.describe("Component ID returned by jira_list_project_components"),
            name: titleFieldSchema.optional().describe("New component name"),
            description: textFieldSchema.optional().describe("New description"),
            leadUserName: z.string().max(255).optional().describe("New component lead username"),
            assigneeType: z.enum(["PROJECT_DEFAULT", "COMPONENT_LEAD", "PROJECT_LEAD", "UNASSIGNED"]).optional()
                .describe("New default assignee behaviour"),
        },
        annotations: { destructiveHint: true },
        validate: ({ name, description, leadUserName, assigneeType }) =>
            name === undefined && description === undefined && leadUserName === undefined &&
            assigneeType === undefined
                ? "nothing to update — supply at least one of: name, description, leadUserName, assigneeType."
                : undefined,
    }, async ({ componentId, ...options }) =>
        runTool("jira_update_component", () => client.updateComponent(componentId, options)));

    tool("meta", "destructive", "jira_delete_component", {
        title: "Delete Jira project component",
        description: "Permanently delete a project component. Mutates data and cannot be undone. Issues " +
            "carrying the component lose it unless `moveIssuesTo` names a replacement.",
        inputSchema: {
            componentId: jiraIdSchema.describe("Component ID returned by jira_list_project_components"),
            moveIssuesTo: jiraIdSchema.optional()
                .describe("Optional component ID to reassign the affected issues to instead of clearing the field"),
        },
    }, async ({ componentId, moveIssuesTo }) =>
        runTool("jira_delete_component", () => client.deleteComponent(componentId, moveIssuesTo)));
}

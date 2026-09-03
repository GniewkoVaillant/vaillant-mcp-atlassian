/**
 * Read-mostly client for Jira Data Center's metadata and project-configuration
 * endpoints.
 *
 * The write tools in `JiraClient` previously operated blind: `jira_create_issue`
 * had to guess which fields a project's issue type accepts, and `jira_update_issue`
 * had to guess whether a field is on the edit screen at all. Both failures surface
 * as an opaque Jira 400 that names a field ID, not a remedy. `createmeta` and
 * `editmeta` are what turns that guessing into a lookup, so they are the reason
 * this module exists; the dictionaries and project configuration around them
 * serve the same purpose for priorities, resolutions, components and versions.
 *
 * Payload discipline matters more here than anywhere else in the codebase:
 * a full `createmeta` expansion on a large project is several megabytes of
 * `allowedValues`, so every mapper below reduces upstream objects to the fields
 * an agent can actually act on, and caps the option lists it returns.
 */
import { atlassianDelete, atlassianGet, atlassianPost, atlassianPut, AtlassianHttpError } from "./httpClient.js";
import {
    readArray,
    readBoolean,
    readId,
    readPath,
    readString,
    requireUpstreamArray,
    requireUpstreamObject,
} from "./upstreamShape.js";

export interface JiraMetaClientOptions {
    baseUrl: string;
    pat: string;
}

/**
 * Upper bound on the `allowedValues` returned for a single field. A component
 * or version picker on a long-lived project carries hundreds of entries, and
 * the agent only needs enough of them to recognise the shape of the field and
 * pick a value it was already told about.
 */
const MAX_ALLOWED_VALUES = 50;

function requireArray(value: unknown, description: string): unknown[] {
    return requireUpstreamArray("Jira", value, description);
}

function requireObject(value: unknown, description: string): Record<string, unknown> {
    return requireUpstreamObject("Jira", value, description);
}

/** Human-usable label for an allowed-value entry, whatever shape Jira used. */
function allowedValueLabel(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    if (typeof value === "string") return value;
    // Jira labels an option differently per field type: a component has a
    // `name`, a select option a `value`, a cascading option a `label`.
    const label = readString(value, "name")
        || readString(value, "value")
        || readString(value, "label")
        || readString(value, "key")
        || readId(value, "id");
    return label === "" ? null : label;
}

export interface JiraFieldMeta {
    id: string;
    name: string;
    required: boolean;
    schemaType: string;
    /** "array", "option", "user"… — the operand shape the JSON value must take. */
    schemaItems: string | null;
    /** Jira's own hint for custom fields, e.g. `com.atlassian.jira.plugin…:select`. */
    custom: string | null;
    /** Update verbs the field accepts, e.g. ["set"], ["add","remove"]. */
    operations: string[];
    hasDefaultValue: boolean;
    allowedValues: string[];
    allowedValuesTruncated: boolean;
}

/** Reduces one Jira field-meta object to the parts a caller can act on. */
function toFieldMeta(fieldId: string, meta: unknown): JiraFieldMeta {
    const labels = readArray(meta, "allowedValues")
        .map(allowedValueLabel)
        .filter((label: string | null): label is string => label !== null);
    const schemaItems = readString(meta, "schema", "items");
    const custom = readString(meta, "schema", "custom");
    return {
        id: fieldId,
        name: readString(meta, "name") || fieldId,
        required: readBoolean(meta, "required"),
        schemaType: readString(meta, "schema", "type"),
        schemaItems: schemaItems === "" ? null : schemaItems,
        custom: custom === "" ? null : custom,
        operations: readArray(meta, "operations")
            .filter((operation: unknown): operation is string => typeof operation === "string"),
        hasDefaultValue: readBoolean(meta, "hasDefaultValue"),
        allowedValues: labels.slice(0, MAX_ALLOWED_VALUES),
        allowedValuesTruncated: labels.length > MAX_ALLOWED_VALUES,
    };
}

function toFieldMetaList(fields: unknown, description: string): JiraFieldMeta[] {
    if (fields === undefined || fields === null) return [];
    const object = requireObject(fields, description);
    return Object.entries(object).map(([fieldId, meta]) => toFieldMeta(fieldId, meta));
}

export interface JiraFieldDefinition {
    id: string;
    name: string;
    custom: boolean;
    schemaType: string;
    /** JQL clause names, which is what a caller actually needs to write a query. */
    clauseNames: string[];
}

export interface JiraCreateMetaIssueType {
    id: string;
    name: string;
    subtask: boolean;
    /** Empty when the caller did not ask for field expansion. */
    fields: JiraFieldMeta[];
}

export interface JiraCreateMetaProject {
    id: string;
    key: string;
    name: string;
    issueTypes: JiraCreateMetaIssueType[];
}

export interface JiraCreateMetaResult {
    /** Which endpoint answered, since DC 9/10 split the legacy one. */
    source: "createmeta" | "createmeta-split";
    projects: JiraCreateMetaProject[];
}

export interface JiraNamedEntity {
    id: string;
    name: string;
    description: string;
}

export interface JiraProjectDetails {
    id: string;
    key: string;
    name: string;
    description: string;
    lead: string;
    projectTypeKey: string;
    url: string;
    issueTypes: { id: string; name: string; subtask: boolean }[];
    components: string[];
    versions: { id: string; name: string; released: boolean; archived: boolean }[];
}

export interface JiraComponentSummary {
    id: string;
    name: string;
    description: string;
    lead: string;
    assigneeType: string;
}

export interface JiraVersionSummary {
    id: string;
    name: string;
    description: string;
    released: boolean;
    archived: boolean;
    startDate: string;
    releaseDate: string;
    overdue: boolean;
}

export interface JiraProjectRole {
    name: string;
    id: string;
}

export interface JiraJqlAutocomplete {
    visibleFieldNames: {
        value: string;
        displayName: string;
        operators: string[];
        types: string[];
    }[];
    visibleFunctionNames: { value: string; displayName: string; types: string[] }[];
    jqlReservedWords: string[];
}

export interface JiraCurrentUser {
    name: string;
    displayName: string;
    emailAddress: string;
    active: boolean;
    timeZone: string;
    groups: string[];
}

export interface JiraDeleteResult {
    id: string;
    deleted: true;
}

export class JiraMetaClient {
    private readonly options: JiraMetaClientOptions;

    constructor(options: JiraMetaClientOptions) {
        this.options = options;
    }

    private get<T = unknown>(path: string, query?: Record<string, string | number | boolean | undefined>): Promise<T> {
        return atlassianGet<T>({ baseUrl: this.options.baseUrl, pat: this.options.pat, path, query });
    }

    /**
     * Lists the instance's field catalogue, optionally filtered by name or ID.
     * `JiraClient` already fetches this internally for `jira_get_issue_fields`,
     * but nothing exposed it, so a caller composing a JQL query or an
     * `updateIssue` `fields` object had no way to learn a custom field's ID.
     */
    async listFields(query?: string, limit?: number): Promise<JiraFieldDefinition[]> {
        const fields = await this.get("/rest/api/2/field");
        const normalized = query?.trim().toLowerCase();
        const mapped = requireArray(fields, "field catalogue").map((field: unknown) => ({
            id: readId(field, "id"),
            name: readString(field, "name"),
            custom: readBoolean(field, "custom"),
            schemaType: readString(field, "schema", "type"),
            clauseNames: readArray(field, "clauseNames")
                .filter((clause: unknown): clause is string => typeof clause === "string"),
        }));
        const matched = normalized
            ? mapped.filter((field) =>
                field.id.toLowerCase().includes(normalized) ||
                field.name.toLowerCase().includes(normalized) ||
                field.clauseNames.some((clause: string) => clause.toLowerCase().includes(normalized)))
            : mapped;
        return typeof limit === "number" && Number.isFinite(limit) && limit >= 0
            ? matched.slice(0, Math.floor(limit))
            : matched;
    }

    /**
     * Returns which fields a project's issue types accept on the create screen.
     *
     * Jira 9 deprecated the single `createmeta` endpoint in favour of a split
     * pair, and Data Center releases disagree about whether the old one still
     * answers. Trying the legacy endpoint first and falling back on a 404/410
     * keeps one tool working across the whole supported range, and `source`
     * reports which path actually answered so a failure is diagnosable.
     */
    async getCreateMeta(options: {
        projectKeys?: string[];
        issueTypeNames?: string[];
        includeFields?: boolean;
    } = {}): Promise<JiraCreateMetaResult> {
        const includeFields = options.includeFields !== false;
        const query: Record<string, string | undefined> = {
            projectKeys: options.projectKeys?.length ? options.projectKeys.join(",") : undefined,
            issuetypeNames: options.issueTypeNames?.length ? options.issueTypeNames.join(",") : undefined,
            expand: includeFields ? "projects.issuetypes.fields" : undefined,
        };

        try {
            const response = requireObject(
                await this.get("/rest/api/2/issue/createmeta", query),
                "create metadata response",
            );
            return {
                source: "createmeta",
                projects: requireArray(response.projects, "create metadata project list").map((project: unknown) => ({
                    id: readId(project, "id"),
                    key: readString(project, "key"),
                    name: readString(project, "name"),
                    issueTypes: readArray(project, "issuetypes")
                        .map((issueType: unknown) => ({
                            id: readId(issueType, "id"),
                            name: readString(issueType, "name"),
                            subtask: readBoolean(issueType, "subtask"),
                            fields: includeFields
                                ? toFieldMetaList(readPath(issueType, "fields"), "create metadata field map")
                                : [],
                        })),
                })),
            };
        } catch (error) {
            const removed = error instanceof AtlassianHttpError && [404, 410].includes(error.status);
            if (!removed) throw error;
            if (!options.projectKeys?.length) {
                throw new Error(
                    "This Jira Data Center version removed the global /rest/api/2/issue/createmeta " +
                    "endpoint. Supply projectKeys so the per-project replacement endpoint can be used.",
                );
            }
            return { source: "createmeta-split", projects: await this.getCreateMetaSplit(options, includeFields) };
        }
    }

    /**
     * Jira 9+ replacement for `createmeta`: one call per project for the issue
     * types, then one call per issue type for its fields. Deliberately serial —
     * the field call fans out per issue type, and the shared HTTP budget is
     * small enough that a parallel fan-out here would starve other tools.
     */
    private async getCreateMetaSplit(
        options: { projectKeys?: string[]; issueTypeNames?: string[] },
        includeFields: boolean,
    ): Promise<JiraCreateMetaProject[]> {
        const wanted = options.issueTypeNames?.map((name) => name.toLowerCase());
        const projects: JiraCreateMetaProject[] = [];

        for (const projectKey of options.projectKeys ?? []) {
            const typesResponse = requireObject(
                await this.get(`/rest/api/2/issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes`),
                `create metadata issue types response for project ${projectKey}`,
            );
            const issueTypes: JiraCreateMetaIssueType[] = [];
            for (const issueType of requireArray(typesResponse.values, `issue type list for project ${projectKey}`)) {
                const name = readString(issueType, "name");
                if (wanted && !wanted.includes(name.toLowerCase())) continue;
                const id = readId(issueType, "id");
                let fields: JiraFieldMeta[] = [];
                if (includeFields && id) {
                    const fieldResponse = requireObject(
                        await this.get(
                            `/rest/api/2/issue/createmeta/${encodeURIComponent(projectKey)}` +
                            `/issuetypes/${encodeURIComponent(id)}`,
                        ),
                        `create metadata field response for ${projectKey}/${id}`,
                    );
                    // The split endpoint returns a paginated *array* of field
                    // objects that carry their own `fieldId`, not the keyed map
                    // the legacy endpoint used.
                    fields = requireArray(fieldResponse.values, `field list for ${projectKey}/${id}`)
                        .map((field: unknown) =>
                            toFieldMeta(readString(field, "fieldId") || readString(field, "key"), field));
                }
                issueTypes.push({ id, name, subtask: readBoolean(issueType, "subtask"), fields });
            }
            projects.push({ id: "", key: projectKey, name: "", issueTypes });
        }
        return projects;
    }

    /**
     * Returns the fields the current user may edit on one issue, with their
     * allowed values. This is the direct answer to "will this update be
     * rejected, and what may I send instead".
     */
    async getEditMeta(issueKey: string): Promise<JiraFieldMeta[]> {
        const response = requireObject(
            await this.get(`/rest/api/2/issue/${encodeURIComponent(issueKey)}/editmeta`),
            `edit metadata response for issue ${issueKey}`,
        );
        return toFieldMetaList(response.fields, `edit metadata field map for issue ${issueKey}`);
    }

    private async listNamedEntities(path: string, description: string): Promise<JiraNamedEntity[]> {
        const values = await this.get(path);
        return requireArray(values, description).map((entity: unknown) => ({
            id: readId(entity, "id"),
            name: readString(entity, "name"),
            description: readString(entity, "description"),
        }));
    }

    listIssueTypes(): Promise<JiraNamedEntity[]> {
        return this.listNamedEntities("/rest/api/2/issuetype", "issue type list");
    }

    listPriorities(): Promise<JiraNamedEntity[]> {
        return this.listNamedEntities("/rest/api/2/priority", "priority list");
    }

    listResolutions(): Promise<JiraNamedEntity[]> {
        return this.listNamedEntities("/rest/api/2/resolution", "resolution list");
    }

    listStatuses(): Promise<JiraNamedEntity[]> {
        return this.listNamedEntities("/rest/api/2/status", "status list");
    }

    async getProject(projectKey: string): Promise<JiraProjectDetails> {
        const project = requireObject(
            await this.get(`/rest/api/2/project/${encodeURIComponent(projectKey)}`),
            `project ${projectKey} response`,
        );
        const projectKeyOrFallback = readString(project, "key") || projectKey;
        return {
            id: readId(project, "id"),
            key: projectKeyOrFallback,
            name: readString(project, "name"),
            description: readString(project, "description"),
            lead: readString(project, "lead", "displayName") || readString(project, "lead", "name"),
            projectTypeKey: readString(project, "projectTypeKey"),
            url: `${this.options.baseUrl}/browse/${projectKeyOrFallback}`,
            issueTypes: requireArray(project.issueTypes, `issue type list on project ${projectKey}`)
                .map((issueType: unknown) => ({
                    id: readId(issueType, "id"),
                    name: readString(issueType, "name"),
                    subtask: readBoolean(issueType, "subtask"),
                })),
            components: requireArray(project.components, `component list on project ${projectKey}`)
                .map((component: unknown) => readString(component, "name"))
                .filter((name: string) => name !== ""),
            versions: requireArray(project.versions, `version list on project ${projectKey}`)
                .map((version: unknown) => ({
                    id: readId(version, "id"),
                    name: readString(version, "name"),
                    released: readBoolean(version, "released"),
                    archived: readBoolean(version, "archived"),
                })),
        };
    }

    async listProjectComponents(projectKey: string): Promise<JiraComponentSummary[]> {
        const components = await this.get(`/rest/api/2/project/${encodeURIComponent(projectKey)}/components`);
        return requireArray(components, `component list for project ${projectKey}`).map(toComponentSummary);
    }

    async listProjectVersions(projectKey: string): Promise<JiraVersionSummary[]> {
        const versions = await this.get(`/rest/api/2/project/${encodeURIComponent(projectKey)}/versions`);
        return requireArray(versions, `version list for project ${projectKey}`).map(toVersionSummary);
    }

    /** Statuses grouped by issue type, which is how a workflow actually varies. */
    async listProjectStatuses(projectKey: string): Promise<
        { issueType: string; statuses: { id: string; name: string; category: string }[] }[]
    > {
        const response = await this.get(`/rest/api/2/project/${encodeURIComponent(projectKey)}/statuses`);
        return requireArray(response, `status list for project ${projectKey}`).map((issueType: unknown) => ({
            issueType: readString(issueType, "name"),
            statuses: readArray(issueType, "statuses")
                .map((status: unknown) => ({
                    id: readId(status, "id"),
                    name: readString(status, "name"),
                    category: readString(status, "statusCategory", "name"),
                })),
        }));
    }

    /** Project roles come back as a `{ roleName: url }` map, not a list. */
    async listProjectRoles(projectKey: string): Promise<JiraProjectRole[]> {
        const roles = requireObject(
            await this.get(`/rest/api/2/project/${encodeURIComponent(projectKey)}/role`),
            `role map for project ${projectKey}`,
        );
        return Object.entries(roles).map(([name, url]) => ({
            name,
            // The map's value is the role's self URL; its last segment is the ID.
            id: typeof url === "string" ? url.split("/").pop() || "" : "",
        }));
    }

    /**
     * Returns the fields, functions and reserved words this instance accepts in
     * JQL. Without it, a JQL query against an unfamiliar instance is guesswork,
     * and a wrong custom field name costs a full round trip.
     */
    async getJqlAutocomplete(): Promise<JiraJqlAutocomplete> {
        const response = requireObject(
            await this.get("/rest/api/2/jql/autocompletedata"),
            "JQL autocomplete response",
        );
        return {
            visibleFieldNames: requireArray(response.visibleFieldNames, "JQL field list").map((field: unknown) => ({
                value: readString(field, "value"),
                displayName: readString(field, "displayName"),
                operators: readArray(field, "operators").filter(isString),
                types: readArray(field, "types").filter(isString),
            })),
            visibleFunctionNames: requireArray(response.visibleFunctionNames, "JQL function list")
                .map((fn: unknown) => ({
                    value: readString(fn, "value"),
                    displayName: readString(fn, "displayName"),
                    types: readArray(fn, "types").filter(isString),
                })),
            jqlReservedWords: requireArray(response.jqlReservedWords, "JQL reserved word list").filter(isString),
        };
    }

    /** Value suggestions for one JQL field, e.g. which sprints match "2024". */
    async getJqlSuggestions(fieldName: string, fieldValue?: string): Promise<{ value: string; displayName: string }[]> {
        const response = requireObject(
            await this.get("/rest/api/2/jql/autocompletedata/suggestions", { fieldName, fieldValue }),
            `JQL suggestion response for field ${fieldName}`,
        );
        return requireArray(response.results, `JQL suggestion list for field ${fieldName}`).map((result: unknown) => ({
            value: readString(result, "value"),
            displayName: readString(result, "displayName"),
        }));
    }

    /**
     * Identifies the account behind the PAT. Every "assign this to me" or
     * "what did I log" question needs the username, and there was no way to
     * obtain it without already knowing it.
     */
    async getMyself(): Promise<JiraCurrentUser> {
        const user = requireObject(
            await this.get("/rest/api/2/myself", { expand: "groups" }),
            "current user response",
        );
        return {
            name: readString(user, "name") || readString(user, "key"),
            displayName: readString(user, "displayName"),
            emailAddress: readString(user, "emailAddress"),
            // Absent means active: only an explicit `false` deactivates.
            active: user.active !== false,
            timeZone: readString(user, "timeZone"),
            groups: readArray(user, "groups", "items")
                .map((group: unknown) => readString(group, "name"))
                .filter((name: string) => name !== ""),
        };
    }

    /**
     * Creates a project version. Mutates data: POST /rest/api/2/version.
     * Release planning was read-only before this; a fix version could be read
     * but never created, so the plan had to be built in the Jira UI.
     */
    async createVersion(options: {
        projectKey: string;
        name: string;
        description?: string;
        startDate?: string;
        releaseDate?: string;
        released?: boolean;
    }): Promise<JiraVersionSummary> {
        const created = await atlassianPost({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path: "/rest/api/2/version",
            body: {
                project: options.projectKey,
                name: options.name,
                description: options.description,
                startDate: options.startDate,
                releaseDate: options.releaseDate,
                released: options.released,
            },
        });
        return toVersionSummary(created);
    }

    /** Updates a project version in place. Mutates data: PUT /rest/api/2/version/{id}. */
    async updateVersion(versionId: string, options: {
        name?: string;
        description?: string;
        startDate?: string;
        releaseDate?: string;
        released?: boolean;
        archived?: boolean;
    }): Promise<JiraVersionSummary> {
        const updated = await atlassianPut({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path: `/rest/api/2/version/${encodeURIComponent(versionId)}`,
            body: {
                name: options.name,
                description: options.description,
                startDate: options.startDate,
                releaseDate: options.releaseDate,
                released: options.released,
                archived: options.archived,
            },
        });
        return toVersionSummary(updated);
    }

    async deleteVersion(versionId: string): Promise<JiraDeleteResult> {
        await atlassianDelete({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path: `/rest/api/2/version/${encodeURIComponent(versionId)}`,
        });
        return { id: versionId, deleted: true };
    }

    /** Creates a project component. Mutates data: POST /rest/api/2/component. */
    async createComponent(options: {
        projectKey: string;
        name: string;
        description?: string;
        leadUserName?: string;
        assigneeType?: string;
    }): Promise<JiraComponentSummary> {
        const created = await atlassianPost({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path: "/rest/api/2/component",
            body: {
                project: options.projectKey,
                name: options.name,
                description: options.description,
                leadUserName: options.leadUserName,
                assigneeType: options.assigneeType,
            },
        });
        return toComponentSummary(created);
    }

    async updateComponent(componentId: string, options: {
        name?: string;
        description?: string;
        leadUserName?: string;
        assigneeType?: string;
    }): Promise<JiraComponentSummary> {
        const updated = await atlassianPut({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path: `/rest/api/2/component/${encodeURIComponent(componentId)}`,
            body: {
                name: options.name,
                description: options.description,
                leadUserName: options.leadUserName,
                assigneeType: options.assigneeType,
            },
        });
        return toComponentSummary(updated);
    }

    async deleteComponent(componentId: string, moveIssuesTo?: string): Promise<JiraDeleteResult> {
        await atlassianDelete({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path: `/rest/api/2/component/${encodeURIComponent(componentId)}`,
            query: { moveIssuesTo },
        });
        return { id: componentId, deleted: true };
    }
}

/** Narrowing predicate for the string lists Jira returns inside JQL metadata. */
function isString(value: unknown): value is string {
    return typeof value === "string";
}

function toVersionSummary(version: unknown): JiraVersionSummary {
    return {
        id: readId(version, "id"),
        name: readString(version, "name"),
        description: readString(version, "description"),
        released: readBoolean(version, "released"),
        archived: readBoolean(version, "archived"),
        startDate: readString(version, "startDate"),
        releaseDate: readString(version, "releaseDate"),
        overdue: readBoolean(version, "overdue"),
    };
}

function toComponentSummary(component: unknown): JiraComponentSummary {
    return {
        id: readId(component, "id"),
        name: readString(component, "name"),
        description: readString(component, "description"),
        lead: readString(component, "lead", "displayName") || readString(component, "lead", "name"),
        assigneeType: readString(component, "assigneeType"),
    };
}

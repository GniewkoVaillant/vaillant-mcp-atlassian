/**
 * Client for Jira Data Center saved filters and dashboards.
 *
 * A saved filter is how a team shares a JQL query, and it was the one part of
 * Jira this server could see the *effects* of but never the definition: an agent
 * could run JQL, but could not read the filter a colleague referred to by name,
 * and could not persist a query it had just built so anyone else could use it.
 *
 * Data Center's filter surface changed across releases: `/filter/search` arrived
 * later than the rest, and the unqualified `GET /filter` was deprecated on the
 * way. `listFilters` therefore degrades through the alternatives rather than
 * failing outright on whichever version the instance happens to run.
 */
import { atlassianDelete, atlassianGet, atlassianPost, atlassianPut, AtlassianHttpError } from "./httpClient.js";
import {
    readBoolean,
    readId,
    readPath,
    readString,
    requireUpstreamArray,
    requireUpstreamObject,
} from "./upstreamShape.js";

export interface JiraFilterClientOptions {
    baseUrl: string;
    pat: string;
}

const MAX_FILTER_RESULTS = 50;

function clampLimit(limit: number | undefined, fallback = 25): number {
    if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) return fallback;
    return Math.min(Math.floor(limit), MAX_FILTER_RESULTS);
}

function requireArray(value: unknown, description: string): unknown[] {
    return requireUpstreamArray("Jira", value, description);
}

function requireObject(value: unknown, description: string): Record<string, unknown> {
    return requireUpstreamObject("Jira", value, description);
}

export interface JiraFilterSummary {
    id: string;
    name: string;
    description: string;
    owner: string;
    jql: string;
    favourite: boolean;
    /** Plain-language rendering of who the filter is shared with. */
    sharedWith: string[];
    url: string;
}

export interface JiraFilterPermission {
    id: string;
    type: string;
    /** The group, project, role or user the share targets; empty for global shares. */
    target: string;
}

export interface JiraDashboardSummary {
    id: string;
    name: string;
    owner: string;
    view: string;
}

export interface JiraFilterDeleteResult {
    id: string;
    deleted: true;
}

/** Renders one share permission as something a person can read. */
function describeShare(permission: unknown): string {
    const type = readString(permission, "type") || "unknown";
    switch (type) {
        case "group":
            return `group:${readString(permission, "group", "name") || readString(permission, "groupname") || "?"}`;
        case "project": {
            const project = readString(permission, "project", "key")
                || readString(permission, "project", "name")
                || "?";
            const role = readString(permission, "role", "name");
            return role ? `project:${project}/role:${role}` : `project:${project}`;
        }
        case "user":
            return `user:${readString(permission, "user", "name") || readString(permission, "user", "displayName") || "?"}`;
        case "global":
            return "global (anyone who can log in)";
        case "authenticated":
            return "authenticated (any logged-in user)";
        default:
            return type;
    }
}

function toSharePermission(permission: unknown): JiraFilterPermission {
    return {
        id: readId(permission, "id"),
        type: readString(permission, "type"),
        target: describeShare(permission),
    };
}

function toFilterSummary(baseUrl: string, filter: unknown): JiraFilterSummary {
    const id = readId(filter, "id");
    return {
        id,
        name: readString(filter, "name"),
        description: readString(filter, "description"),
        owner: readString(filter, "owner", "displayName") || readString(filter, "owner", "name"),
        jql: readString(filter, "jql"),
        favourite: readBoolean(filter, "favourite"),
        sharedWith: requireArray(
            readPath(filter, "sharePermissions"),
            "filter share permission list",
        ).map(describeShare),
        url: id ? `${baseUrl}/issues/?filter=${encodeURIComponent(id)}` : "",
    };
}

export class JiraFilterClient {
    private readonly options: JiraFilterClientOptions;

    constructor(options: JiraFilterClientOptions) {
        this.options = options;
    }

    private get<T = unknown>(path: string, query?: Record<string, string | number | boolean | undefined>): Promise<T> {
        return atlassianGet<T>({ baseUrl: this.options.baseUrl, pat: this.options.pat, path, query });
    }

    /** The caller's favourite filters — the shortest path to "the filter I use". */
    async listFavouriteFilters(limit?: number): Promise<JiraFilterSummary[]> {
        const filters = await this.get("/rest/api/2/filter/favourite", { expand: "jql,sharePermissions,description" });
        return requireArray(filters, "favourite filter list")
            .slice(0, clampLimit(limit))
            .map((filter) => toFilterSummary(this.options.baseUrl, filter));
    }

    /**
     * Searches saved filters by name or owner.
     *
     * `/filter/search` is **not** present on Jira Data Center 9.x — it answers
     * 404 there — so this degrades to filtering the caller's favourites, which
     * is the only filter collection the v2 API will enumerate. `source` reports
     * which path answered, because "favourites" is a genuinely narrower result
     * set and must not be mistaken for "no such filter exists".
     */
    async searchFilters(options: {
        name?: string;
        owner?: string;
        groupName?: string;
        projectId?: number;
        limit?: number;
    } = {}): Promise<{ source: "search" | "favourites"; filters: JiraFilterSummary[] }> {
        const maxResults = clampLimit(options.limit);
        try {
            const response = requireObject(
                await this.get("/rest/api/2/filter/search", {
                    filterName: options.name,
                    owner: options.owner,
                    groupname: options.groupName,
                    projectId: options.projectId,
                    maxResults,
                    expand: "jql,sharePermissions,description,owner",
                }),
                "filter search response",
            );
            return {
                source: "search",
                filters: requireArray(response.values, "filter search result list")
                    .map((filter) => toFilterSummary(this.options.baseUrl, filter)),
            };
        } catch (error) {
            if (!(error instanceof AtlassianHttpError) || error.status !== 404) throw error;
            const needle = options.name?.trim().toLowerCase();
            const favourites = await this.listFavouriteFilters(MAX_FILTER_RESULTS);
            return {
                source: "favourites",
                filters: (needle
                    ? favourites.filter((filter) => filter.name.toLowerCase().includes(needle))
                    : favourites
                ).slice(0, maxResults),
            };
        }
    }

    async getFilter(filterId: string): Promise<JiraFilterSummary> {
        const filter = requireObject(
            await this.get(`/rest/api/2/filter/${encodeURIComponent(filterId)}`, {
                expand: "jql,sharePermissions,description,owner",
            }),
            `filter ${filterId} response`,
        );
        return toFilterSummary(this.options.baseUrl, filter);
    }

    async getFilterPermissions(filterId: string): Promise<JiraFilterPermission[]> {
        const permissions = await this.get(`/rest/api/2/filter/${encodeURIComponent(filterId)}/permission`);
        return requireArray(permissions, `share permission list for filter ${filterId}`)
            .map(toSharePermission);
    }

    /**
     * Creates a saved filter. Mutates data: POST /rest/api/2/filter.
     *
     * Deliberately created private: a new filter is owned by the PAT's account,
     * and sharing it is a separate, explicit decision made through
     * `addFilterPermission` rather than a side effect of creating it.
     */
    async createFilter(options: {
        name: string;
        jql: string;
        description?: string;
        favourite?: boolean;
    }): Promise<JiraFilterSummary> {
        const created = await atlassianPost({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path: "/rest/api/2/filter",
            query: { expand: "jql,sharePermissions,description,owner" },
            body: {
                name: options.name,
                jql: options.jql,
                description: options.description,
                favourite: options.favourite === true,
            },
        });
        return toFilterSummary(this.options.baseUrl, created);
    }

    /** Updates a saved filter in place. Mutates data: PUT /rest/api/2/filter/{id}. */
    async updateFilter(filterId: string, options: {
        name?: string;
        jql?: string;
        description?: string;
        favourite?: boolean;
    }): Promise<JiraFilterSummary> {
        // Jira replaces the filter wholesale on PUT, so anything omitted here
        // would be cleared. Read the current definition and merge instead.
        const current = await this.getFilter(filterId);
        const updated = await atlassianPut({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path: `/rest/api/2/filter/${encodeURIComponent(filterId)}`,
            query: { expand: "jql,sharePermissions,description,owner" },
            body: {
                name: options.name ?? current.name,
                jql: options.jql ?? current.jql,
                description: options.description ?? current.description,
                favourite: options.favourite ?? current.favourite,
            },
        });
        return toFilterSummary(this.options.baseUrl, updated);
    }

    async deleteFilter(filterId: string): Promise<JiraFilterDeleteResult> {
        await atlassianDelete({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path: `/rest/api/2/filter/${encodeURIComponent(filterId)}`,
        });
        return { id: filterId, deleted: true };
    }

    /**
     * Shares a filter with a group, project, project role, or every logged-in
     * user. Widening who can see a query is a real disclosure decision, which
     * is why "global" and "authenticated" are spelled out in the tool
     * description rather than hidden behind a type string.
     */
    async addFilterPermission(filterId: string, options: {
        type: "group" | "project" | "projectRole" | "user" | "authenticated" | "global";
        groupName?: string;
        projectId?: string;
        projectRoleId?: string;
        username?: string;
    }): Promise<JiraFilterPermission[]> {
        const body: Record<string, unknown> = {
            type: options.type === "projectRole" ? "project" : options.type,
            // Jira DC's share bean carries explicit view/edit flags. Edit is not
            // offered here: letting other people rewrite a shared query's JQL is
            // a separate, larger decision than letting them read it.
            view: true,
            edit: false,
        };
        if (options.type === "group") {
            if (!options.groupName) throw new Error("Sharing with a group requires groupName.");
            body.groupname = options.groupName;
        }
        if (options.type === "project" || options.type === "projectRole") {
            if (!options.projectId) throw new Error("Sharing with a project requires projectId.");
            body.projectId = options.projectId;
        }
        if (options.type === "projectRole") {
            if (!options.projectRoleId) throw new Error("Sharing with a project role requires projectRoleId.");
            body.projectRoleId = options.projectRoleId;
        }
        if (options.type === "user") {
            if (!options.username) throw new Error("Sharing with a user requires username.");
            body.userKey = options.username;
            body.username = options.username;
        }
        const permissions = await atlassianPost({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path: `/rest/api/2/filter/${encodeURIComponent(filterId)}/permission`,
            body,
        });
        return requireArray(permissions, `share permission list for filter ${filterId}`)
            .map(toSharePermission);
    }

    async deleteFilterPermission(filterId: string, permissionId: string): Promise<JiraFilterDeleteResult> {
        await atlassianDelete({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path: `/rest/api/2/filter/${encodeURIComponent(filterId)}` +
                `/permission/${encodeURIComponent(permissionId)}`,
        });
        return { id: permissionId, deleted: true };
    }

    /**
     * Adds or removes the filter from the caller's own favourites.
     *
     * Data Center's v2 filter resource has no favourite sub-resource; Atlassian's
     * own documentation redirects to the v1 path used here. It is stable but
     * undocumented as a public API, so a 404 from it means "this instance does
     * not support toggling favourites over REST", not "no such filter".
     */
    async setFilterFavourite(filterId: string, favourite: boolean): Promise<JiraFilterSummary> {
        const request = favourite ? atlassianPut : atlassianDelete;
        await request({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path: `/rest/api/1.0/filters/${encodeURIComponent(filterId)}/favourite`,
        });
        // The v1 endpoint's response shape differs from v2's filter bean, so the
        // filter is re-read rather than mapped from whatever it returned.
        return this.getFilter(filterId);
    }

    /**
     * Lists dashboards. Dashboards are where saved filters are actually
     * consumed, so being able to name the dashboard a filter feeds is what makes
     * "which report does this query drive" answerable.
     */
    async listDashboards(options: { favouriteOnly?: boolean; limit?: number } = {}): Promise<{
        total: number;
        returned: number;
        dashboards: JiraDashboardSummary[];
    }> {
        const response = requireObject(
            await this.get("/rest/api/2/dashboard", {
                filter: options.favouriteOnly ? "favourite" : undefined,
                maxResults: clampLimit(options.limit),
            }),
            "dashboard list response",
        );
        const dashboards = requireArray(response.dashboards, "dashboard list").map(toDashboardSummary);
        return {
            total: typeof response.total === "number" ? response.total : dashboards.length,
            returned: dashboards.length,
            dashboards,
        };
    }

    async getDashboard(dashboardId: string): Promise<JiraDashboardSummary> {
        const dashboard = requireObject(
            await this.get(`/rest/api/2/dashboard/${encodeURIComponent(dashboardId)}`),
            `dashboard ${dashboardId} response`,
        );
        return toDashboardSummary(dashboard);
    }
}

function toDashboardSummary(dashboard: unknown): JiraDashboardSummary {
    return {
        id: readId(dashboard, "id"),
        name: readString(dashboard, "name"),
        owner: readString(dashboard, "owner", "displayName") || readString(dashboard, "owner", "name"),
        view: readString(dashboard, "view"),
    };
}

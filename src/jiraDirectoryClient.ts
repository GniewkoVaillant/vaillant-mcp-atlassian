/**
 * Read-only client for Jira Data Center's user and group directory.
 *
 * Every write tool in this server that touches a person — assign, add watcher,
 * share a filter, restrict a page — takes a *username*, which on Data Center is
 * the `name` field and almost never matches the display name people actually
 * know. Before this module there was no way to resolve "Anna Kowalska" into the
 * string Jira wants, so the assign call failed with an opaque 400 and the agent
 * had no next move.
 *
 * Data Center is deliberately assumed throughout: Cloud's `accountId` model does
 * not exist here, and the search parameter is `username`, not `query`.
 */
import { atlassianGet } from "./httpClient.js";
import { requireUpstreamArray, requireUpstreamObject } from "./upstreamShape.js";

export interface JiraDirectoryClientOptions {
    baseUrl: string;
    pat: string;
}

/**
 * Hard ceiling on any one directory response. A user search is an easy way to
 * pull a company's entire staff list into a model's context, which is both a
 * token problem and a data-minimisation problem, so the cap is enforced here
 * rather than trusted to the caller.
 */
const MAX_DIRECTORY_RESULTS = 50;

function clampLimit(limit: number | undefined): number {
    if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) return 20;
    return Math.min(Math.floor(limit), MAX_DIRECTORY_RESULTS);
}

function requireArray(value: unknown, description: string): any[] {
    return requireUpstreamArray("Jira", value, description);
}

export interface JiraUserSummary {
    /** The username Jira write APIs expect. */
    name: string;
    displayName: string;
    emailAddress: string;
    active: boolean;
}

export interface JiraGroupSummary {
    name: string;
}

export interface JiraPermissionSummary {
    key: string;
    name: string;
    havePermission: boolean;
}

function toUserSummary(user: any): JiraUserSummary {
    return {
        name: user?.name || user?.key || "",
        displayName: user?.displayName || "",
        emailAddress: user?.emailAddress || "",
        active: user?.active !== false,
    };
}

export class JiraDirectoryClient {
    private readonly options: JiraDirectoryClientOptions;

    constructor(options: JiraDirectoryClientOptions) {
        this.options = options;
    }

    private get<T = any>(path: string, query?: Record<string, string | number | boolean | undefined>): Promise<T> {
        return atlassianGet<T>({ baseUrl: this.options.baseUrl, pat: this.options.pat, path, query });
    }

    /**
     * Searches the user directory by username, display name or email fragment.
     * `includeInactive` defaults to false: a deactivated account cannot be
     * assigned work, and offering one as a candidate wastes a round trip.
     */
    async searchUsers(query: string, limit?: number, includeInactive = false): Promise<JiraUserSummary[]> {
        const users = await this.get("/rest/api/2/user/search", {
            username: query,
            maxResults: clampLimit(limit),
            includeActive: true,
            includeInactive,
        });
        return requireArray(users, "user search result list").map(toUserSummary);
    }

    /**
     * Searches only users who may actually be assigned the given issue or
     * project. This is the correct lookup before `jira_assign_issue`: a user
     * can exist, be active, and still not hold Assignable User on the project.
     */
    async findAssignableUsers(options: {
        query?: string;
        issueKey?: string;
        projectKey?: string;
        limit?: number;
    }): Promise<JiraUserSummary[]> {
        if (!options.issueKey && !options.projectKey) {
            throw new Error("Assignable user search requires either issueKey or projectKey.");
        }
        const users = await this.get("/rest/api/2/user/assignable/search", {
            username: options.query,
            issueKey: options.issueKey,
            project: options.projectKey,
            maxResults: clampLimit(options.limit),
        });
        return requireArray(users, "assignable user search result list").map(toUserSummary);
    }

    /** Resolves one exact username into its profile, or fails saying it does not exist. */
    async getUser(username: string): Promise<JiraUserSummary> {
        const user = requireUpstreamObject(
            "Jira",
            await this.get("/rest/api/2/user", { username, expand: "groups" }),
            `user response for "${username}"`,
        );
        return toUserSummary(user);
    }

    /**
     * Lists the members of a group. Bounded like every other directory read:
     * a large corporate group is thousands of accounts, and only the first page
     * is ever useful to an agent.
     */
    async listGroupMembers(groupName: string, limit?: number, includeInactive = false): Promise<{
        group: string;
        total: number;
        returned: number;
        hasMore: boolean;
        members: JiraUserSummary[];
    }> {
        const maxResults = clampLimit(limit);
        const response = requireUpstreamObject(
            "Jira",
            await this.get("/rest/api/2/group/member", {
                groupname: groupName,
                maxResults,
                includeInactiveUsers: includeInactive,
            }),
            `group member response for "${groupName}"`,
        );
        const members = requireArray(response.values, `member list for group "${groupName}"`).map(toUserSummary);
        const total = typeof response.total === "number" ? response.total : members.length;
        return {
            group: groupName,
            total,
            returned: members.length,
            hasMore: response.isLast === false || members.length < total,
            members,
        };
    }

    /** Finds group names matching a fragment, so a share or restriction can name a real group. */
    async findGroups(query: string, limit?: number): Promise<JiraGroupSummary[]> {
        const response = requireUpstreamObject(
            "Jira",
            await this.get("/rest/api/2/groups/picker", { query, maxResults: clampLimit(limit) }),
            `group picker response for "${query}"`,
        );
        return requireArray(response.groups, "group picker result list")
            .map((group: any) => ({ name: group?.name || "" }))
            .filter((group: JiraGroupSummary) => group.name !== "");
    }

    /**
     * Reports which permissions the PAT's owner holds, optionally scoped to a
     * project or issue. Checking this before a write turns "403 after the fact"
     * into "this account cannot do that", which is a far more actionable answer.
     */
    async getMyPermissions(options: { projectKey?: string; issueKey?: string } = {}): Promise<JiraPermissionSummary[]> {
        const response = requireUpstreamObject(
            "Jira",
            await this.get("/rest/api/2/mypermissions", {
                projectKey: options.projectKey,
                issueKey: options.issueKey,
            }),
            "permission response",
        );
        const permissions = requireUpstreamObject("Jira", response.permissions, "permission map");
        return Object.entries(permissions)
            .map(([key, permission]: [string, any]) => ({
                key,
                name: permission?.name || key,
                havePermission: permission?.havePermission === true,
            }))
            // Only granted permissions are actionable, and the full catalogue is
            // ~50 entries of mostly "false" that no caller needs to read.
            .filter((permission) => permission.havePermission);
    }
}

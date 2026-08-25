/**
 * Read-only client for the Jira Agile REST API (`/rest/agile/1.0`), used for
 * board/sprint/velocity reporting on Jira Data Center. Authenticates with the
 * same Personal Access Token as the regular REST API client — Agile endpoints
 * on Data Center require no additional scopes.
 */
import { atlassianGet } from "./httpClient.js";
import { DEFAULT_CONCURRENCY, mapWithConcurrency } from "./concurrency.js";

export interface ClientOptions {
    baseUrl: string;
    pat: string;
}

export interface JiraBoardSummary {
    id: number;
    name: string;
    type: string;
    projectKey: string;
    projectName: string;
}

export interface JiraSprintSummary {
    id: number;
    name: string;
    state: string;
    startDate: string | null;
    endDate: string | null;
    goal: string | null;
}

export interface JiraStoryPointsFieldInfo {
    fieldId: string | null;
    fieldName: string | null;
}

export interface JiraSprintIssueSummary {
    key: string;
    summary: string;
    status: string;
    statusCategory: string;
    issueType: string;
    assignee: string;
    storyPoints: number | null;
}

/**
 * Sprint scope as Jira itself reports it, separating the original commitment
 * from work added or removed after the sprint started. Null when the
 * greenhopper sprint report is unavailable on this instance.
 */
export interface JiraSprintScope {
    initialCommittedPoints: number | null;
    currentScopePoints: number | null;
    completedPoints: number | null;
    notCompletedPoints: number | null;
    removedPoints: number | null;
    addedDuringSprintPoints: number;
    addedDuringSprintKeys: string[];
    removedKeys: string[];
}

export interface JiraSprintReport {
    sprintId: number;
    sprintName: string;
    state: string;
    startDate: string | null;
    endDate: string | null;
    goal: string | null;
    storyPointsField: string | null;
    storyPointsFieldName: string | null;
    committedPoints: number | null;
    completedPoints: number | null;
    issueCount: number;
    issuesByStatus: Record<string, number>;
    issues: JiraSprintIssueSummary[];
    scope: JiraSprintScope | null;
    scopeNote: string;
}

export interface JiraVelocitySprintSummary {
    sprintId: number;
    sprintName: string;
    startDate: string | null;
    endDate: string | null;
    committedPoints: number | null;
    completedPoints: number | null;
    completionPercent: number | null;
    issueCount: number;
}

export interface JiraBoardVelocityReport {
    boardId: number;
    storyPointsField: string | null;
    storyPointsFieldName: string | null;
    sprints: JiraVelocitySprintSummary[];
    averageCommittedPoints: number | null;
    averageCompletedPoints: number | null;
}

function toSprintSummary(sprint: any): JiraSprintSummary {
    return {
        id: sprint.id,
        name: sprint.name,
        state: sprint.state,
        startDate: sprint.startDate ?? null,
        endDate: sprint.endDate ?? null,
        goal: sprint.goal ?? null,
    };
}
function round2(value: number): number {
    return Math.round(value * 100) / 100;
}
export class JiraAgileClient {
    private readonly options: ClientOptions;
    constructor(options: ClientOptions) {
        this.options = options;
    }
    /**
     * Lists boards visible to the PAT's owner, optionally filtered by name or
     * project. Three tools here take a board ID, and before this there was no
     * way to discover one from inside the agent.
     */
    async listBoards(options: { name?: string; projectKeyOrId?: string } = {}): Promise<JiraBoardSummary[]> {
        const boards: any[] = [];
        let startAt = 0;
        const maxResults = 50;
        for (;;) {
            const page = await atlassianGet({
                baseUrl: this.options.baseUrl,
                pat: this.options.pat,
                path: "/rest/agile/1.0/board",
                query: {
                    startAt,
                    maxResults,
                    name: options.name,
                    projectKeyOrId: options.projectKeyOrId,
                },
            });
            const values = page.values || [];
            boards.push(...values);
            const gotAll = page.isLast === true ||
                values.length === 0 ||
                (page.total !== undefined && boards.length >= page.total);
            if (gotAll) break;
            startAt += values.length;
        }
        return boards.map((board) => ({
            id: board.id,
            name: board.name || "",
            type: board.type || "",
            projectKey: board.location?.projectKey || "",
            projectName: board.location?.projectName || "",
        }));
    }
    /**
     * Lists sprints for a board, paginating through `startAt` as needed.
     * If `state` is omitted, all sprints (active, closed, future) are returned.
     */
    async getBoardSprints(boardId: number, state?: string): Promise<JiraSprintSummary[]> {
        const sprints: any[] = [];
        let startAt = 0;
        const maxResults = 50;
        for (;;) {
            const page = await atlassianGet({
                baseUrl: this.options.baseUrl,
                pat: this.options.pat,
                path: `/rest/agile/1.0/board/${boardId}/sprint`,
                query: {
                    startAt,
                    maxResults,
                    state,
                },
            });
            sprints.push(...(page.values || []));
            const gotAll = page.isLast === true ||
                !page.values ||
                page.values.length === 0 ||
                (page.total !== undefined && sprints.length >= page.total);
            if (gotAll)
                break;
            startAt += page.values.length;
        }
        return sprints.map(toSprintSummary);
    }
    /**
     * Fetches a board's configuration and returns the estimation field ID/name
     * used for story points, if the board is configured for one (rather than,
     * e.g., time-based estimation).
     */
    async getBoardStoryPointsField(boardId: number): Promise<JiraStoryPointsFieldInfo> {
        const config = await atlassianGet({
            baseUrl: this.options.baseUrl,
            pat: this.options.pat,
            path: `/rest/agile/1.0/board/${boardId}/configuration`,
        });
        const field = config.estimation?.field;
        return {
            fieldId: field?.fieldId ?? null,
            fieldName: field?.displayName ?? null,
        };
    }
    async getSprintIssues(sprintId: number, storyPointsField: string | null): Promise<any[]> {
        const fieldsParam = ["summary", "status", "issuetype", "assignee"];
        if (storyPointsField)
            fieldsParam.push(storyPointsField);
        const issues: any[] = [];
        let startAt = 0;
        const maxResults = 100;
        for (;;) {
            const page = await atlassianGet({
                baseUrl: this.options.baseUrl,
                pat: this.options.pat,
                path: `/rest/agile/1.0/sprint/${sprintId}/issue`,
                query: {
                    startAt,
                    maxResults,
                    fields: fieldsParam.join(","),
                },
            });
            issues.push(...(page.issues || []));
            const total = page.total ?? issues.length;
            if (issues.length >= total || !page.issues || page.issues.length === 0)
                break;
            startAt += page.issues.length;
        }
        return issues;
    }
    /**
     * Fetches Jira's own sprint report from the greenhopper API, which is the
     * only source that distinguishes the sprint's *initial* commitment from
     * work added after it started. Summing story points from the sprint's
     * current issue list cannot see scope creep: an issue added on day 8 looks
     * exactly like one committed on day 1.
     *
     * This endpoint is undocumented and absent or restricted on some
     * instances, so callers must treat a null result as "unavailable" rather
     * than an error.
     */
    private async getGreenhopperScope(
        boardId: number,
        sprintId: number,
    ): Promise<JiraSprintScope | null> {
        let report: any;
        try {
            report = await atlassianGet({
                baseUrl: this.options.baseUrl,
                pat: this.options.pat,
                path: "/rest/greenhopper/1.0/rapid/charts/sprintreport",
                query: { rapidViewId: boardId, sprintId },
            });
        } catch {
            return null;
        }

        const contents = report?.contents;
        if (!contents) return null;

        const keysAddedDuringSprint = Object.keys(contents.issueKeysAddedDuringSprint || {});
        const sum = (value: any): number | null =>
            typeof value?.value === "number" ? round2(value.value) : null;

        const completed = sum(contents.completedIssuesEstimateSum);
        const notCompleted = sum(contents.issuesNotCompletedEstimateSum);
        const punted = sum(contents.puntedIssuesEstimateSum);
        const allIssues = sum(contents.allIssuesEstimateSum);

        // Everything in the sprint now, minus what was added after it started.
        const addedPoints = (contents.issuesNotCompletedInCurrentSprint || [])
            .concat(contents.completedIssues || [])
            .filter((issue: any) => keysAddedDuringSprint.includes(issue.key))
            .reduce(
                (total: number, issue: any) =>
                    total + (typeof issue.estimateStatistic?.statFieldValue?.value === "number"
                        ? issue.estimateStatistic.statFieldValue.value
                        : 0),
                0,
            );

        return {
            initialCommittedPoints:
                allIssues !== null ? round2(allIssues - addedPoints + (punted ?? 0)) : null,
            currentScopePoints: allIssues,
            completedPoints: completed,
            notCompletedPoints: notCompleted,
            removedPoints: punted,
            addedDuringSprintPoints: round2(addedPoints),
            addedDuringSprintKeys: keysAddedDuringSprint,
            removedKeys: (contents.puntedIssues || []).map((issue: any) => issue.key),
        };
    }
    /**
     * Builds a completion/velocity report for a single sprint on a board:
     * committed vs completed story points (dynamically discovering the
     * board's configured story points field), plus a per-status breakdown.
     *
     * `prefetched` lets callers that already hold the board's sprint list and
     * estimation field pass them in, which is what getBoardVelocity does to
     * avoid refetching both once per sprint.
     */
    async getSprintReport(
        boardId: number,
        sprintId: number,
        prefetched?: { sprints: JiraSprintSummary[]; storyPointsInfo: JiraStoryPointsFieldInfo },
    ): Promise<JiraSprintReport> {
        const [sprints, storyPointsInfo] = prefetched
            ? [prefetched.sprints, prefetched.storyPointsInfo]
            : await Promise.all([
                this.getBoardSprints(boardId),
                this.getBoardStoryPointsField(boardId),
            ]);
        const sprint = sprints.find((s) => s.id === sprintId);
        const { fieldId: storyPointsField, fieldName: storyPointsFieldName } = storyPointsInfo;
        const [rawIssues, scope] = await Promise.all([
            this.getSprintIssues(sprintId, storyPointsField),
            this.getGreenhopperScope(boardId, sprintId),
        ]);
        const issuesByStatus: Record<string, number> = {};
        const issues: JiraSprintIssueSummary[] = [];
        let committedPoints = 0;
        let completedPoints = 0;
        let sawAnyPoints = false;
        for (const issue of rawIssues) {
            const statusName = issue.fields.status?.name || "Unknown";
            const statusCategory = issue.fields.status?.statusCategory?.key || "unknown";
            issuesByStatus[statusName] = (issuesByStatus[statusName] || 0) + 1;
            let points = null;
            if (storyPointsField) {
                const raw = issue.fields[storyPointsField];
                if (typeof raw === "number") {
                    points = raw;
                    sawAnyPoints = true;
                }
            }
            if (points !== null) {
                committedPoints += points;
                if (statusCategory === "done") {
                    completedPoints += points;
                }
            }
            const assignee = issue.fields.assignee;
            issues.push({
                key: issue.key,
                summary: issue.fields.summary || "",
                status: statusName,
                statusCategory,
                issueType: issue.fields.issuetype?.name || "Unknown",
                assignee: assignee?.displayName || assignee?.name || "Unassigned",
                storyPoints: points,
            });
        }
        return {
            sprintId,
            sprintName: sprint?.name ?? `Sprint ${sprintId}`,
            state: sprint?.state ?? "unknown",
            startDate: sprint?.startDate ?? null,
            endDate: sprint?.endDate ?? null,
            goal: sprint?.goal ?? null,
            storyPointsField,
            storyPointsFieldName,
            committedPoints: sawAnyPoints ? round2(committedPoints) : null,
            completedPoints: sawAnyPoints ? round2(completedPoints) : null,
            issueCount: rawIssues.length,
            issuesByStatus,
            issues,
            scope,
            scopeNote: scope
                ? "`committedPoints` is the sprint's current scope. Use `scope.initialCommittedPoints` for what was actually committed at sprint start."
                : "Jira's sprint report was unavailable, so scope added mid-sprint could not be separated out. `committedPoints` reflects current scope, not the original commitment.",
        };
    }
    /**
     * Convenience report combining the most recently closed sprints on a board
     * with their completion data, for a quick velocity summary.
     */
    async getBoardVelocity(boardId: number, numSprints = 3): Promise<JiraBoardVelocityReport> {
        const [closedSprints, storyPointsInfo] = await Promise.all([
            this.getBoardSprints(boardId, "closed"),
            this.getBoardStoryPointsField(boardId),
        ]);
        // Sort explicitly rather than trusting the API's ordering: relying on
        // "closed sprints come back oldest-first" silently picks the wrong
        // sprints when it doesn't hold.
        const orderedSprints = [...closedSprints].sort((left, right) => {
            const leftEnd = left.endDate ? Date.parse(left.endDate) : 0;
            const rightEnd = right.endDate ? Date.parse(right.endDate) : 0;
            if (leftEnd !== rightEnd) return rightEnd - leftEnd;
            return right.id - left.id;
        });
        const recentSprints = orderedSprints.slice(0, numSprints);
        // Reuse the sprint list and estimation field we already fetched;
        // otherwise each report refetches both, once per sprint.
        const sprintReports = await mapWithConcurrency(
            recentSprints,
            DEFAULT_CONCURRENCY,
            (sprint) =>
                this.getSprintReport(boardId, sprint.id, {
                    sprints: closedSprints,
                    storyPointsInfo,
                }),
        );
        const sprints = sprintReports.map((report) => {
            const completionPercent = report.committedPoints !== null &&
                report.committedPoints > 0 &&
                report.completedPoints !== null
                ? round2((report.completedPoints / report.committedPoints) * 100)
                : null;
            return {
                sprintId: report.sprintId,
                sprintName: report.sprintName,
                startDate: report.startDate,
                endDate: report.endDate,
                committedPoints: report.committedPoints,
                completedPoints: report.completedPoints,
                completionPercent,
                issueCount: report.issueCount,
            };
        });
        const committedValues = sprints
            .map((s) => s.committedPoints)
            .filter((v): v is number => v !== null);
        const completedValues = sprints
            .map((s) => s.completedPoints)
            .filter((v): v is number => v !== null);
        return {
            boardId,
            storyPointsField: storyPointsInfo.fieldId,
            storyPointsFieldName: storyPointsInfo.fieldName,
            sprints,
            averageCommittedPoints: committedValues.length > 0
                ? round2(committedValues.reduce((a, b) => a + b, 0) / committedValues.length)
                : null,
            averageCompletedPoints: completedValues.length > 0
                ? round2(completedValues.reduce((a, b) => a + b, 0) / completedValues.length)
                : null,
        };
    }
}

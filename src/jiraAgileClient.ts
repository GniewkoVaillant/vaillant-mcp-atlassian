/**
 * Read-only client for the Jira Agile REST API (`/rest/agile/1.0`), used for
 * board/sprint/velocity reporting on Jira Data Center. Authenticates with the
 * same Personal Access Token as the regular REST API client — Agile endpoints
 * on Data Center require no additional scopes.
 */
import { atlassianGet } from "./httpClient.js";

export interface ClientOptions {
    baseUrl: string;
    pat: string;
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
     * Builds a completion/velocity report for a single sprint on a board:
     * committed vs completed story points (dynamically discovering the
     * board's configured story points field), plus a per-status breakdown.
     */
    async getSprintReport(boardId: number, sprintId: number): Promise<JiraSprintReport> {
        const [sprints, storyPointsInfo] = await Promise.all([
            this.getBoardSprints(boardId),
            this.getBoardStoryPointsField(boardId),
        ]);
        const sprint = sprints.find((s) => s.id === sprintId);
        const { fieldId: storyPointsField, fieldName: storyPointsFieldName } = storyPointsInfo;
        const rawIssues = await this.getSprintIssues(sprintId, storyPointsField);
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
        // Closed sprints are typically returned oldest-first; take the most recent N.
        const recentSprints = closedSprints.slice(-numSprints).reverse();
        const sprintReports = await Promise.all(recentSprints.map((sprint) => this.getSprintReport(boardId, sprint.id)));
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

/**
 * Registers the Jira Agile backlog and sprint tools.
 *
 * The existing agile tools report on sprints that already happened. These are
 * the ones that change the plan, so the boundary between "reversible" and
 * "not" is drawn carefully: moving issues between a sprint and the backlog is
 * ordinary planning, while closing a sprint completes it for the whole team and
 * pushes unfinished work out of it.
 */
import { z } from "zod";
import type { JiraAgileClient } from "../jiraAgileClient.js";
import { isoDateSchema, issueKeySchema, runTool, textFieldSchema, titleFieldSchema, type ToolRegistrar } from "./shared.js";

const boardIdSchema = z.number().int().positive();
const sprintIdSchema = z.number().int().positive();
const issueKeyBatchSchema = z.array(issueKeySchema).min(1).max(50);

export function registerJiraAgileWriteTools(tool: ToolRegistrar, client: JiraAgileClient): void {
    tool("agile", "read", "jira_get_board_backlog", {
        title: "Get a Jira board's backlog",
        description: "List the issues on a board that are in no sprint — the board's backlog. Sprint " +
            "planning starts here; without it the candidate work can only be found by reconstructing " +
            "the board's filter as JQL. Returns a bounded window: check `hasMore` and `total`. " +
            "Read-only.",
        inputSchema: {
            boardId: boardIdSchema.describe("Board ID from jira_list_boards"),
            limit: z.number().int().positive().max(200).optional()
                .describe("Maximum issues to return (default 50, hard cap 200)"),
        },
    }, async ({ boardId, limit }) =>
        runTool("jira_get_board_backlog", () => client.getBoardBacklog(boardId, limit)));

    tool("agile", "read", "jira_get_board_issues", {
        title: "Get issues on a Jira board",
        description: "List the issues a board covers, optionally narrowed by JQL. Unlike a plain " +
            "jira_search_issues call, this applies the board's own filter first, so the answer matches " +
            "what the board actually shows. Returns a bounded window: check `hasMore` and `total`. " +
            "Read-only.",
        inputSchema: {
            boardId: boardIdSchema.describe("Board ID from jira_list_boards"),
            jql: z.string().max(10_000).optional().describe("Optional extra JQL, applied on top of the board's filter"),
            limit: z.number().int().positive().max(200).optional()
                .describe("Maximum issues to return (default 50, hard cap 200)"),
        },
    }, async ({ boardId, jql, limit }) =>
        runTool("jira_get_board_issues", () => client.getBoardIssues(boardId, { jql, limit })));

    tool("agile", "read", "jira_list_board_epics", {
        title: "List epics on a Jira board",
        description: "List the epics configured on a board, with their keys, names and whether they are " +
            "marked done. Returns a bounded window: check `hasMore` and `total`. Read-only.",
        inputSchema: {
            boardId: boardIdSchema.describe("Board ID from jira_list_boards"),
            limit: z.number().int().positive().max(200).optional()
                .describe("Maximum epics to return (default 50, hard cap 200)"),
        },
    }, async ({ boardId, limit }) =>
        runTool("jira_list_board_epics", () => client.listBoardEpics(boardId, limit)));

    tool("agile", "write", "jira_create_sprint", {
        title: "Create a Jira sprint",
        description:
            "Create a sprint on a Scrum board. Mutates data: creates a real sprint the whole team sees. " +
            "The sprint is created in the `future` state and is not started — starting it is a separate " +
            "jira_update_sprint call with state='active'. Deleting an unstarted, empty sprint undoes this.",
        inputSchema: {
            name: titleFieldSchema.describe("Sprint name, e.g. 'Sprint 42'"),
            originBoardId: boardIdSchema.describe("Board the sprint belongs to, from jira_list_boards"),
            goal: textFieldSchema.optional().describe("Sprint goal"),
            startDate: isoDateSchema.optional().describe("Planned start, ISO-8601, e.g. '2026-04-01T09:00:00.000+02:00'"),
            endDate: isoDateSchema.optional().describe("Planned end, ISO-8601"),
        },
    }, async (args) => runTool("jira_create_sprint", () => client.createSprint(args)));

    tool("agile", "write", "jira_update_sprint", {
        title: "Update a Jira sprint",
        description:
            "Update a sprint's name, goal, dates or state. Mutates data and is visible to the whole " +
            "team. Changing `state` is the significant part: 'active' starts the sprint and begins its " +
            "burndown, and 'closed' completes it — closing pushes every unfinished issue out of the " +
            "sprint and cannot be cleanly undone. Omitted fields keep their current values.",
        inputSchema: {
            sprintId: sprintIdSchema.describe("Sprint ID from jira_get_board_sprints"),
            name: titleFieldSchema.optional().describe("New sprint name"),
            goal: textFieldSchema.optional().describe("New sprint goal"),
            state: z.enum(["future", "active", "closed"]).optional()
                .describe("New state. 'active' starts the sprint; 'closed' completes it and ejects unfinished work"),
            startDate: isoDateSchema.optional().describe("New start date, ISO-8601"),
            endDate: isoDateSchema.optional().describe("New end date, ISO-8601"),
        },
        annotations: { destructiveHint: true },
        validate: ({ name, goal, state, startDate, endDate }) =>
            name === undefined && goal === undefined && state === undefined &&
            startDate === undefined && endDate === undefined
                ? "nothing to update — supply at least one of: name, goal, state, startDate, endDate."
                : undefined,
    }, async ({ sprintId, ...options }) =>
        runTool("jira_update_sprint", () => client.updateSprint(sprintId, options)));

    tool("agile", "destructive", "jira_delete_sprint", {
        title: "Delete a Jira sprint",
        description: "Permanently delete a sprint. Mutates data and cannot be undone: the sprint's " +
            "history and its burndown disappear, and its issues return to the backlog. Deleting a " +
            "closed sprint destroys the velocity record jira_get_board_velocity depends on.",
        inputSchema: {
            sprintId: sprintIdSchema.describe("Sprint ID from jira_get_board_sprints"),
        },
    }, async ({ sprintId }) => runTool("jira_delete_sprint", () => client.deleteSprint(sprintId)));

    tool("agile", "write", "jira_move_issues_to_sprint", {
        title: "Move Jira issues into a sprint",
        description: "Move up to 50 issues into a sprint. Mutates data: issues leave whichever sprint or " +
            "backlog they were in. Reversible with jira_move_issues_to_backlog or another move. Adding " +
            "work to an already-active sprint is scope creep and shows up as such in the sprint report.",
        inputSchema: {
            sprintId: sprintIdSchema.describe("Destination sprint ID"),
            issueKeys: issueKeyBatchSchema.describe("Issue keys to move, at most 50 per call"),
        },
    }, async ({ sprintId, issueKeys }) =>
        runTool("jira_move_issues_to_sprint", () => client.moveIssuesToSprint(sprintId, issueKeys)));

    tool("agile", "write", "jira_move_issues_to_backlog", {
        title: "Move Jira issues to the backlog",
        description: "Move up to 50 issues out of their sprint and back to the backlog. Mutates data. " +
            "Removing an issue from an active sprint counts as removed scope in the sprint report.",
        inputSchema: {
            issueKeys: issueKeyBatchSchema.describe("Issue keys to move, at most 50 per call"),
        },
    }, async ({ issueKeys }) =>
        runTool("jira_move_issues_to_backlog", () => client.moveIssuesToBacklog(issueKeys)));

    tool("agile", "write", "jira_rank_issues", {
        title: "Rank Jira issues",
        description: "Re-order issues on a board by ranking them before or after another issue. Mutates " +
            "data: rank is a global ordering, so this changes the order everyone sees on the board. " +
            "Supply exactly one of rankBeforeIssue or rankAfterIssue.",
        inputSchema: {
            issueKeys: issueKeyBatchSchema.describe("Issue keys to move, at most 50 per call"),
            rankBeforeIssue: issueKeySchema.optional().describe("Place the issues immediately above this issue"),
            rankAfterIssue: issueKeySchema.optional().describe("Place the issues immediately below this issue"),
            rankCustomFieldId: z.number().int().positive().optional()
                .describe("Rank field ID; only needed on instances with more than one rank field"),
        },
        validate: ({ rankBeforeIssue, rankAfterIssue }) => {
            const anchors = [rankBeforeIssue, rankAfterIssue].filter(Boolean).length;
            if (anchors === 0) return "supply exactly one of rankBeforeIssue or rankAfterIssue.";
            if (anchors === 2) return "rankBeforeIssue and rankAfterIssue are mutually exclusive.";
            return undefined;
        },
    }, async (args) => runTool("jira_rank_issues", () => client.rankIssues(args)));
}

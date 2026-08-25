import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { computeCycleTime, type JiraStatusTransition } from "../jiraClient.js";

function transition(to: string, at: string, from = "Backlog"): JiraStatusTransition {
  return { from, to, at, author: "Tester" };
}

describe("computeCycleTime", () => {
  test("computes a simple forward cycle time rounded to one decimal day", () => {
    const result = computeCycleTime(
      "ABC-1",
      [transition("In Progress", "2024-01-01T00:00:00.000Z"), transition("Done", "2024-01-03T12:00:00.000Z", "In Progress")],
      "In Progress",
      "Done",
    );

    assert.equal(result.cycleTimeDays, 2.5);
    assert.equal(result.fromStatusEnteredAt, "2024-01-01T00:00:00.000Z");
    assert.equal(result.toStatusEnteredAt, "2024-01-03T12:00:00.000Z");
  });

  test("matches statuses case-insensitively", () => {
    const result = computeCycleTime(
      "ABC-2",
      [transition("in progress", "2024-01-01T00:00:00.000Z"), transition("DONE", "2024-01-02T00:00:00.000Z", "in progress")],
      "In Progress",
      "Done",
    );

    assert.equal(result.cycleTimeDays, 1);
  });

  test("uses the first entry into the start status and last entry into the done status after reopen", () => {
    const result = computeCycleTime(
      "ABC-3",
      [
        transition("In Progress", "2024-01-01T00:00:00.000Z"),
        transition("Done", "2024-01-02T00:00:00.000Z", "In Progress"),
        transition("In Progress", "2024-01-05T00:00:00.000Z", "Done"),
        transition("Done", "2024-01-07T12:00:00.000Z", "In Progress"),
      ],
      "In Progress",
      "Done",
    );

    assert.equal(result.fromStatusEnteredAt, "2024-01-01T00:00:00.000Z");
    assert.equal(result.toStatusEnteredAt, "2024-01-07T12:00:00.000Z");
    assert.equal(result.cycleTimeDays, 6.5);
  });

  test("returns null cycle time with a note when the start status was never entered", () => {
    const result = computeCycleTime("ABC-4", [transition("Done", "2024-01-02T00:00:00.000Z")], "In Progress", "Done");

    assert.equal(result.cycleTimeDays, null);
    assert.equal(result.note, 'Issue never transitioned to "In Progress".');
    assert.equal(result.fromStatusEnteredAt, null);
    assert.equal(result.toStatusEnteredAt, "2024-01-02T00:00:00.000Z");
  });

  test("returns null cycle time with a note when the target status was never entered", () => {
    const result = computeCycleTime("ABC-5", [transition("In Progress", "2024-01-01T00:00:00.000Z")], "In Progress", "Done");

    assert.equal(result.cycleTimeDays, null);
    assert.equal(result.note, 'Issue never transitioned to "Done".');
    assert.equal(result.fromStatusEnteredAt, "2024-01-01T00:00:00.000Z");
    assert.equal(result.toStatusEnteredAt, null);
  });
});

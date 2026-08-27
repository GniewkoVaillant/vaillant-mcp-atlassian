import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mapWithConcurrency } from "../concurrency.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("mapWithConcurrency", () => {
  test("returns results in input order even when workers finish out of order", async () => {
    const results = await mapWithConcurrency([1, 2, 3, 4], 4, async (item) => {
      await delay((5 - item) * 5);
      return item * 10;
    });

    assert.deepEqual(results, [10, 20, 30, 40]);
  });

  test("respects the configured concurrency cap", async () => {
    let inFlight = 0;
    let peak = 0;

    await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (item) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await delay(5);
      inFlight -= 1;
      return item;
    });

    // Only the cap is a contract. Pinning the exact peak also pins the
    // scheduler: a perfectly correct change in how work is handed out would
    // fail here for no reason.
    assert.ok(peak <= 2, `expected at most 2 workers in flight, observed ${peak}`);
    assert.ok(peak >= 2, "expected the helper to actually run work in parallel");
  });

  test("returns an empty array without invoking the worker for empty input", async () => {
    let invoked = false;
    const results = await mapWithConcurrency([], 2, async () => {
      invoked = true;
      return 1;
    });

    assert.deepEqual(results, []);
    assert.equal(invoked, false);
  });

  test("handles a limit larger than the item count", async () => {
    const results = await mapWithConcurrency(["a", "b"], 10, async (item, index) => `${index}:${item}`);

    assert.deepEqual(results, ["0:a", "1:b"]);
  });

  test("propagates a rejecting worker", async () => {
    await assert.rejects(
      mapWithConcurrency([1, 2, 3], 2, async (item) => {
        if (item === 2) throw new Error("worker failed");
        return item;
      }),
      /worker failed/,
    );
  });
});

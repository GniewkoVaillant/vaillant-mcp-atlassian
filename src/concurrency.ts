/**
 * Bounded-parallelism helper.
 *
 * Batch tools accept up to 50 issue keys, and each key can fan out into
 * several REST calls. Running those with a bare `Promise.all` fires every
 * request at once, which is a reliable way to get rate-limited by Jira (or to
 * make an on-prem instance unhappy). This keeps a fixed number in flight while
 * preserving input order in the result.
 */
export async function mapWithConcurrency<Item, Result>(
  items: readonly Item[],
  limit: number,
  worker: (item: Item, index: number) => Promise<Result>,
): Promise<Result[]> {
  if (items.length === 0) return [];

  const effectiveLimit = Math.max(1, Math.min(limit, items.length));
  const results = new Array<Result>(items.length);
  let cursor = 0;

  async function run(): Promise<void> {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index]!, index);
    }
  }

  await Promise.all(Array.from({ length: effectiveLimit }, () => run()));
  return results;
}

/** Default in-flight request budget for batch tools. */
export const DEFAULT_CONCURRENCY = 5;

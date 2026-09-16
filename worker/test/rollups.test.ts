import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { recomputeRollups } from "../src/db/rollups";
import { isoWeek } from "../src/util/isoweek";

async function seed(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO contributors (id, login, is_bot) VALUES (1, 'alice', 0), (2, 'robo[bot]', 1)",
    ),
    env.DB.prepare(
      `INSERT INTO activity_events (contributor_id, type, external_id, occurred_at) VALUES
       (1, 'commit', 'e1', '2026-01-05T10:00:00Z'),
       (1, 'commit', 'e2', '2026-01-05T15:00:00Z'),
       (1, 'pr',     'e3', '2026-01-06T10:00:00Z'),
       (2, 'commit', 'e4', '2026-01-05T10:00:00Z')`,
    ),
  ]);
}

describe("recomputeRollups", () => {
  it("aggregates per day/contributor/type and is safe to re-run", async () => {
    await seed();
    await recomputeRollups(env.DB);

    const rows = await env.DB.prepare(
      "SELECT day, contributor_id, type, count FROM daily_rollups ORDER BY day, contributor_id, type",
    ).all();
    expect(rows.results).toEqual([
      { day: "2026-01-05", contributor_id: 1, type: "commit", count: 2 },
      { day: "2026-01-05", contributor_id: 2, type: "commit", count: 1 },
      { day: "2026-01-06", contributor_id: 1, type: "pr", count: 1 },
    ]);

    // Add one event, full recompute stays correct.
    await env.DB.prepare(
      "INSERT INTO activity_events (contributor_id, type, external_id, occurred_at) VALUES (1, 'commit', 'e5', '2026-01-05T23:00:00Z')",
    ).run();
    await recomputeRollups(env.DB);
    const after = await env.DB.prepare(
      "SELECT count FROM daily_rollups WHERE day = '2026-01-05' AND contributor_id = 1 AND type = 'commit'",
    ).first<{ count: number }>();
    expect(after!.count).toBe(3);
  });
});

describe("isoWeek", () => {
  it("handles year boundaries per ISO-8601", () => {
    expect(isoWeek("2024-12-30")).toBe("2025-W01"); // Monday of week 1, 2025
    expect(isoWeek("2027-01-01")).toBe("2026-W53"); // Friday of week 53, 2026
    expect(isoWeek("2026-01-01")).toBe("2026-W01"); // Thursday
    expect(isoWeek("2026-09-16")).toBe("2026-W38");
    expect(isoWeek("2026-01-05T10:00:00Z")).toBe("2026-W02"); // full timestamps OK
  });
});

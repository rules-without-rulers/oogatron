import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
// The same validator that snapshot.mjs runs before writing a snapshot and
// that the jumbotron's data.js will wrap — fixture and live responses can
// never drift apart without a test failing.
import { validateStats } from "../../scripts/lib/validate-stats.mjs";
import fixture from "../../harness/fixtures/stats.json";

describe("stats contract", () => {
  it("harness fixture matches the schema", () => {
    const { ok, errors } = validateStats(fixture);
    expect(errors).toEqual([]);
    expect(ok).toBe(true);
  });

  it("a live /v1/stats response matches the same schema", async () => {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO contributors (id, github_id, login, display_name, avatar_url, is_bot, first_seen_at, last_seen_at)
         VALUES (1, 1001, 'alice', 'Alice A', NULL, 0, '2026-01-05T10:00:00Z', '2026-01-05T10:00:00Z')`,
      ),
      env.DB.prepare(
        `INSERT INTO activity_events (contributor_id, type, external_id, occurred_at)
         VALUES (1, 'commit', 'e1', '2026-01-05T10:00:00Z')`,
      ),
      env.DB.prepare(
        `INSERT INTO daily_rollups (day, contributor_id, type, count)
         VALUES ('2026-01-05', 1, 'commit', 1)`,
      ),
    ]);
    const res = await SELF.fetch("https://oogatron.test/v1/stats");
    expect(res.status).toBe(200);
    const { ok, errors } = validateStats(await res.json());
    expect(errors).toEqual([]);
    expect(ok).toBe(true);
  });
});

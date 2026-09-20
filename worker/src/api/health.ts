import { json } from "./respond";

// Last sync run + cursors + row counts: the primary verification surface for
// checking ingested totals against the GitHub UI. Cursors and event counts
// are broken out per repo so backfill progress is visible repo by repo.
export async function handleHealth(env: Env): Promise<Response> {
  const [lastRun, state, byType, byRepo, repoRows, contribs, rollups] =
    await env.DB.batch([
      env.DB.prepare("SELECT * FROM sync_runs ORDER BY id DESC LIMIT 1"),
      env.DB.prepare("SELECT repo, source, cursor, updated_at FROM sync_state"),
      env.DB.prepare(
        "SELECT type, COUNT(*) AS n FROM activity_events GROUP BY type",
      ),
      env.DB.prepare(
        "SELECT repo, type, COUNT(*) AS n FROM activity_events GROUP BY repo, type",
      ),
      env.DB.prepare(
        "SELECT name, default_branch, is_active, last_checked_at FROM repos ORDER BY name",
      ),
      env.DB.prepare(
        "SELECT is_bot, COUNT(*) AS n FROM contributors GROUP BY is_bot",
      ),
      env.DB.prepare("SELECT COUNT(*) AS n FROM daily_rollups"),
    ]);

  const events: Record<string, number> = {};
  for (const r of byType.results as Array<{ type: string; n: number }>) {
    events[r.type] = r.n;
  }
  const eventsByRepo: Record<string, Record<string, number>> = {};
  for (const r of byRepo.results as Array<{
    repo: string;
    type: string;
    n: number;
  }>) {
    (eventsByRepo[r.repo] ??= {})[r.type] = r.n;
  }
  const contributors = { human: 0, bot: 0 };
  for (const r of contribs.results as Array<{ is_bot: number; n: number }>) {
    if (r.is_bot) contributors.bot = r.n;
    else contributors.human = r.n;
  }

  const last = (lastRun.results[0] ?? null) as Record<string, unknown> | null;
  if (last && typeof last["detail"] === "string") {
    try {
      last["detail"] = JSON.parse(last["detail"]);
    } catch {
      // leave as text
    }
  }

  return json({
    last_run: last,
    repos: repoRows.results,
    sync_state: Object.fromEntries(
      (
        state.results as Array<{
          repo: string;
          source: string;
          cursor: string | null;
          updated_at: string;
        }>
      ).map((r) => [
        `${r.repo}/${r.source}`,
        {
          cursor: r.cursor === null ? null : JSON.parse(r.cursor),
          updated_at: r.updated_at,
        },
      ]),
    ),
    counts: {
      contributors,
      events,
      events_by_repo: eventsByRepo,
      daily_rollups: (rollups.results[0] as { n: number }).n,
    },
  });
}

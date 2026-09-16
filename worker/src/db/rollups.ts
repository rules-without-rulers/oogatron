// Full recompute after every event-writing sync: one batch, milliseconds of
// SQLite time at this project's scale (< ~5k events), and it eliminates the
// incremental-invalidation bug class entirely (late-arriving events, bot
// reclassification, edited payloads). Revisit around ~100k events.
export async function recomputeRollups(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM daily_rollups"),
    db.prepare(
      `INSERT INTO daily_rollups (day, contributor_id, type, count)
       SELECT substr(occurred_at, 1, 10), contributor_id, type, COUNT(*)
       FROM activity_events
       GROUP BY 1, 2, 3`,
    ),
  ]);
}

// Known bot logins that no pattern catches (e.g. a CI committer using a
// personal-looking account). Filled in after inspecting the real backfill via
// /v1/stats?include_bots=1; reconcileBots() reclassifies existing rows on the
// next sync after a redeploy.
export const BOT_LOGINS: string[] = [];

export const BOT_PATTERNS: RegExp[] = [
  /\[bot\]$/i,
  /^dependabot/i,
  /^github-actions/i,
  /^renovate/i,
];

export function isBot(login: string, typename?: string | null): boolean {
  if (typename === "Bot") return true;
  if (BOT_LOGINS.includes(login)) return true;
  return BOT_PATTERNS.some((p) => p.test(login));
}

// Re-applies the current bot config to every contributors row, so editing the
// config and redeploying reclassifies history on the next sync. SQLite has no
// regex, so matching happens here; one SELECT plus at most one batched UPDATE.
// Promote-only: rows flagged from the GraphQL "Bot" typename at ingest time
// are invisible to this login-based recheck and must not be demoted by it.
export async function reconcileBots(db: D1Database): Promise<number> {
  const rows = await db
    .prepare("SELECT id, login FROM contributors WHERE is_bot = 0")
    .all<{ id: number; login: string }>();
  const promote = rows.results.filter((r) => isBot(r.login));
  if (promote.length === 0) return 0;
  await db.batch(
    promote.map((r) =>
      db.prepare("UPDATE contributors SET is_bot = 1 WHERE id = ?").bind(r.id),
    ),
  );
  return promote.length;
}

// Data intake for the jumbotron. This is the ONLY module that understands the
// /v1/stats JSON shape (schema_version 2); views consume the parsed model and
// never touch raw JSON. Unknown extra fields are tolerated — the API contract
// allows additive changes within a schema version. Zero dependencies.
//
// (scripts/lib/validate-stats.mjs is the deep validator used by CI and the
// snapshot script; this module does its own light structural check so the
// jumbotron directory stays self-contained for drop-in integration.)

/**
 * @typedef {{ commits: number, prs: number, reviews: number }} Counts
 * @typedef {{ week: string, commits: number, prs: number, reviews: number }} WeekBucket
 * @typedef {{ login: string, display_name: string|null, avatar_url: string|null,
 *             first_seen_at: string|null, last_seen_at: string|null,
 *             counts: Counts, weekly: WeekBucket[] }} Contributor
 * @typedef {{ login: string, count: number }} LeaderboardEntry
 * @typedef {{ name: string, totals: Counts & { contributors: number },
 *             weekly: WeekBucket[],
 *             weeklyTotals: Array<{ week: string, total: number }> }} RepoStats
 *
 * @typedef {{
 *   org: string,
 *   generatedAt: string,
 *   totals: Counts & { contributors: number },
 *   leaderboards: { commits: LeaderboardEntry[], prs: LeaderboardEntry[],
 *                   reviews: LeaderboardEntry[] },
 *   repos: RepoStats[],
 *   contributors: Contributor[],
 *   byLogin: Map<string, Contributor>,
 *   latestWeek: string|null,
 *   weeklyTotals: Array<{ week: string, total: number } & Omit<WeekBucket, "week">>,
 * }} StatsModel
 */

/**
 * Parses and validates a /v1/stats payload into the view model.
 * Throws an Error with a readable message on structural mismatch.
 * @param {unknown} json
 * @returns {StatsModel}
 */
export function parseStats(json) {
  if (typeof json !== "object" || json === null) {
    throw new Error("stats payload is not an object");
  }
  const root = /** @type {Record<string, any>} */ (json);
  const version = root.meta?.schema_version;
  if (version !== 2) {
    throw new Error(`unsupported stats schema_version: ${String(version)}`);
  }
  for (const key of ["totals", "leaderboards", "repos", "contributors"]) {
    if (root[key] === undefined)
      throw new Error(`stats payload missing ${key}`);
  }
  if (!Array.isArray(root.contributors)) {
    throw new Error("stats contributors is not an array");
  }
  if (!Array.isArray(root.repos)) {
    throw new Error("stats repos is not an array");
  }

  /** @type {Contributor[]} */
  const contributors = root.contributors.map((c) => ({
    login: String(c.login),
    display_name: c.display_name ?? null,
    avatar_url: c.avatar_url ?? null,
    first_seen_at: c.first_seen_at ?? null,
    last_seen_at: c.last_seen_at ?? null,
    counts: normalizeCounts(c.counts),
    weekly: normalizeWeekly(c.weekly),
  }));

  const byLogin = new Map(contributors.map((c) => [c.login, c]));

  /** @type {RepoStats[]} */
  const repos = root.repos.map((r) => {
    const weekly = normalizeWeekly(r.weekly);
    return {
      name: String(r.name),
      totals: {
        contributors: r.totals?.contributors | 0,
        ...normalizeCounts(r.totals),
      },
      weekly,
      weeklyTotals: weekly.map((w) => ({
        week: w.week,
        total: w.commits + w.prs + w.reviews,
      })),
    };
  });

  const weeklyMap = new Map();
  for (const c of contributors) {
    for (const w of c.weekly) {
      let agg = weeklyMap.get(w.week);
      if (!agg) {
        agg = { week: w.week, commits: 0, prs: 0, reviews: 0, total: 0 };
        weeklyMap.set(w.week, agg);
      }
      agg.commits += w.commits;
      agg.prs += w.prs;
      agg.reviews += w.reviews;
      agg.total += w.commits + w.prs + w.reviews;
    }
  }
  const weeklyTotals = [...weeklyMap.values()].sort((a, b) =>
    a.week < b.week ? -1 : 1,
  );
  const latestWeek =
    weeklyTotals.length > 0 ? weeklyTotals[weeklyTotals.length - 1].week : null;

  return {
    org: String(root.meta.org ?? ""),
    generatedAt: String(root.meta.generated_at ?? ""),
    totals: {
      contributors: root.totals.contributors | 0,
      ...normalizeCounts(root.totals),
    },
    leaderboards: {
      commits: normalizeBoard(root.leaderboards.commits),
      prs: normalizeBoard(root.leaderboards.prs),
      reviews: normalizeBoard(root.leaderboards.reviews),
    },
    repos,
    contributors,
    byLogin,
    latestWeek,
    weeklyTotals,
  };
}

/**
 * Short human label for a contributor (login, unless it is a synthesized
 * email-hash identity with a usable display name).
 * @param {Contributor} c
 * @returns {string}
 */
export function displayLabel(c) {
  if (c.login.startsWith("email:")) {
    return c.display_name || "anonymous";
  }
  return c.login;
}

/** @param {any} counts @returns {Counts} */
function normalizeCounts(counts) {
  return {
    commits: (counts?.commits ?? 0) | 0,
    prs: (counts?.prs ?? 0) | 0,
    reviews: (counts?.reviews ?? 0) | 0,
  };
}

/** @param {any} weekly @returns {WeekBucket[]} */
function normalizeWeekly(weekly) {
  if (!Array.isArray(weekly)) return [];
  return weekly
    .map((w) => ({
      week: String(w.week),
      commits: w.commits | 0,
      prs: w.prs | 0,
      reviews: w.reviews | 0,
    }))
    .sort((a, b) => (a.week < b.week ? -1 : 1));
}

/** @param {any} board @returns {LeaderboardEntry[]} */
function normalizeBoard(board) {
  if (!Array.isArray(board)) return [];
  return board.map((e) => ({ login: String(e.login), count: e.count | 0 }));
}

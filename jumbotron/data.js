// Data intake for the jumbotron. This is the ONLY module that understands the
// /v1/stats JSON shape (schema_version 1); views consume the parsed model and
// never touch raw JSON. Unknown extra fields are tolerated — the API contract
// allows additive changes within a schema version. Zero dependencies.
//
// (scripts/lib/validate-stats.mjs is the deep validator used by CI and the
// snapshot script; this module does its own light structural check so the
// jumbotron directory stays self-contained for drop-in integration.)

/**
 * @typedef {{ issue: number, review: number, commit: number, all: number }} CommentCounts
 * @typedef {{ commits: number, prs: number, reviews: number, comments: CommentCounts }} Counts
 * @typedef {{ week: string, commits: number, prs: number, reviews: number, comments: number }} WeekBucket
 * @typedef {{ login: string, display_name: string|null, avatar_url: string|null,
 *             first_seen_at: string|null, last_seen_at: string|null,
 *             counts: Counts, weekly: WeekBucket[] }} Contributor
 * @typedef {{ login: string, count: number }} LeaderboardEntry
 *
 * @typedef {{
 *   repo: string,
 *   generatedAt: string,
 *   totals: Counts & { contributors: number },
 *   leaderboards: { commits: LeaderboardEntry[], prs: LeaderboardEntry[],
 *                   reviews: LeaderboardEntry[], comments: LeaderboardEntry[] },
 *   contributors: Contributor[],
 *   byLogin: Map<string, Contributor>,
 *   latestWeek: string|null,
 *   weeklyTotals: Array<{ week: string, total: number } & Omit<WeekBucket, "week">>,
 *   tickerText: string,
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
  if (version !== 1) {
    throw new Error(`unsupported stats schema_version: ${String(version)}`);
  }
  for (const key of ["totals", "leaderboards", "contributors"]) {
    if (root[key] === undefined) throw new Error(`stats payload missing ${key}`);
  }
  if (!Array.isArray(root.contributors)) {
    throw new Error("stats contributors is not an array");
  }

  /** @type {Contributor[]} */
  const contributors = root.contributors.map((c) => ({
    login: String(c.login),
    display_name: c.display_name ?? null,
    avatar_url: c.avatar_url ?? null,
    first_seen_at: c.first_seen_at ?? null,
    last_seen_at: c.last_seen_at ?? null,
    counts: normalizeCounts(c.counts),
    weekly: Array.isArray(c.weekly)
      ? c.weekly
          .map((w) => ({
            week: String(w.week),
            commits: w.commits | 0,
            prs: w.prs | 0,
            reviews: w.reviews | 0,
            comments: w.comments | 0,
          }))
          .sort((a, b) => (a.week < b.week ? -1 : 1))
      : [],
  }));

  const byLogin = new Map(contributors.map((c) => [c.login, c]));

  const weeklyMap = new Map();
  for (const c of contributors) {
    for (const w of c.weekly) {
      let agg = weeklyMap.get(w.week);
      if (!agg) {
        agg = { week: w.week, commits: 0, prs: 0, reviews: 0, comments: 0, total: 0 };
        weeklyMap.set(w.week, agg);
      }
      agg.commits += w.commits;
      agg.prs += w.prs;
      agg.reviews += w.reviews;
      agg.comments += w.comments;
      agg.total += w.commits + w.prs + w.reviews + w.comments;
    }
  }
  const weeklyTotals = [...weeklyMap.values()].sort((a, b) =>
    a.week < b.week ? -1 : 1,
  );
  const latestWeek =
    weeklyTotals.length > 0 ? weeklyTotals[weeklyTotals.length - 1].week : null;

  /** @type {StatsModel} */
  const model = {
    repo: String(root.meta.repo ?? ""),
    generatedAt: String(root.meta.generated_at ?? ""),
    totals: {
      contributors: root.totals.contributors | 0,
      commits: root.totals.commits | 0,
      prs: root.totals.prs | 0,
      reviews: root.totals.reviews | 0,
      comments: normalizeComments(root.totals.comments),
    },
    leaderboards: {
      commits: normalizeBoard(root.leaderboards.commits),
      prs: normalizeBoard(root.leaderboards.prs),
      reviews: normalizeBoard(root.leaderboards.reviews),
      comments: normalizeBoard(root.leaderboards.comments),
    },
    contributors,
    byLogin,
    latestWeek,
    weeklyTotals,
    tickerText: "",
  };
  model.tickerText = deriveTicker(model);
  return model;
}

/**
 * Builds the scrolling ticker line from the freshest data the snapshot
 * carries: the latest ISO week's per-contributor activity.
 * @param {StatsModel} model
 * @returns {string}
 */
export function deriveTicker(model) {
  const parts = [];
  const t = model.totals;
  parts.push(
    `${model.repo}  ${t.contributors} CONTRIBUTORS  ${t.commits} COMMITS  ` +
      `${t.prs} PRS  ${t.reviews} REVIEWS  ${t.comments.all} COMMENTS`,
  );
  if (model.latestWeek) {
    const active = model.contributors
      .map((c) => ({
        c,
        w: c.weekly.find((w) => w.week === model.latestWeek),
      }))
      .filter((e) => e.w && e.w.commits + e.w.prs + e.w.reviews + e.w.comments > 0)
      .sort(
        (a, b) =>
          b.w.commits + b.w.prs + b.w.reviews + b.w.comments -
          (a.w.commits + a.w.prs + a.w.reviews + a.w.comments),
      );
    parts.push(`WEEK ${model.latestWeek}:`);
    for (const { c, w } of active) {
      const bits = [];
      if (w.commits) bits.push(`${w.commits} COMMIT${w.commits === 1 ? "" : "S"}`);
      if (w.prs) bits.push(`${w.prs} PR${w.prs === 1 ? "" : "S"}`);
      if (w.reviews) bits.push(`${w.reviews} REVIEW${w.reviews === 1 ? "" : "S"}`);
      if (w.comments) bits.push(`${w.comments} COMMENT${w.comments === 1 ? "" : "S"}`);
      parts.push(`${displayLabel(c).toUpperCase()}: ${bits.join(" + ")}`);
    }
  }
  return parts.join("   ***   ");
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
    comments: normalizeComments(counts?.comments),
  };
}

/** @param {any} c @returns {CommentCounts} */
function normalizeComments(c) {
  return {
    issue: (c?.issue ?? 0) | 0,
    review: (c?.review ?? 0) | 0,
    commit: (c?.commit ?? 0) | 0,
    all: (c?.all ?? 0) | 0,
  };
}

/** @param {any} board @returns {LeaderboardEntry[]} */
function normalizeBoard(board) {
  if (!Array.isArray(board)) return [];
  return board.map((e) => ({ login: String(e.login), count: e.count | 0 }));
}

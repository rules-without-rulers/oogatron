import { botFilter } from "../db/queries";
import { isoWeek } from "../util/isoweek";
import { json } from "./respond";

interface ContributorRow {
  id: number;
  login: string;
  display_name: string | null;
  avatar_url: string | null;
  first_seen_at: string | null;
  last_seen_at: string | null;
}

interface RollupRow {
  contributor_id: number;
  day: string;
  type: string;
  count: number;
}

export interface Counts {
  commits: number;
  prs: number;
  reviews: number;
  comments: { issue: number; review: number; commit: number; all: number };
}

function emptyCounts(): Counts {
  return {
    commits: 0,
    prs: 0,
    reviews: 0,
    comments: { issue: 0, review: 0, commit: 0, all: 0 },
  };
}

export function addToCounts(counts: Counts, type: string, n: number): void {
  if (type === "commit") counts.commits += n;
  else if (type === "pr") counts.prs += n;
  else if (type === "review") counts.reviews += n;
  else if (type === "comment_issue") counts.comments.issue += n;
  else if (type === "comment_review") counts.comments.review += n;
  else if (type === "comment_commit") counts.comments.commit += n;
  if (type.startsWith("comment_")) counts.comments.all += n;
}

interface WeeklyBucket {
  week: string;
  commits: number;
  prs: number;
  reviews: number;
  comments: number;
}

export function weeklyFrom(
  rows: Array<{ day: string; type: string; count: number }>,
): WeeklyBucket[] {
  const byWeek = new Map<string, WeeklyBucket>();
  for (const r of rows) {
    const week = isoWeek(r.day);
    let b = byWeek.get(week);
    if (!b) {
      b = { week, commits: 0, prs: 0, reviews: 0, comments: 0 };
      byWeek.set(week, b);
    }
    if (r.type === "commit") b.commits += r.count;
    else if (r.type === "pr") b.prs += r.count;
    else if (r.type === "review") b.reviews += r.count;
    else if (r.type.startsWith("comment_")) b.comments += r.count;
  }
  return [...byWeek.values()].sort((a, b) => (a.week < b.week ? -1 : 1));
}

function totalOf(c: Counts): number {
  return c.commits + c.prs + c.reviews + c.comments.all;
}

// Assembles the /v1/stats payload (also the snapshot format) from rollups +
// contributors — never from raw events. The contributors array is always
// complete, which is what lets snapshot mode filter per-user client-side.
export async function assembleStats(
  env: Env,
  url: URL,
  opts: { withWeekly: boolean },
): Promise<Record<string, unknown>> {
  const [contribRes, rollupRes] = await env.DB.batch([
    env.DB.prepare(
      `SELECT c.id, c.login, c.display_name, c.avatar_url, c.first_seen_at, c.last_seen_at
       FROM contributors c WHERE 1=1${botFilter(url)}
       ORDER BY c.login`,
    ),
    env.DB.prepare(
      `SELECT r.contributor_id, r.day, r.type, r.count
       FROM daily_rollups r JOIN contributors c ON c.id = r.contributor_id
       WHERE 1=1${botFilter(url)}`,
    ),
  ]);
  const contributors = contribRes.results as unknown as ContributorRow[];
  const rollups = rollupRes.results as unknown as RollupRow[];

  const totals = emptyCounts();
  const perContributor = new Map<
    number,
    { counts: Counts; rollups: RollupRow[] }
  >();
  for (const c of contributors) {
    perContributor.set(c.id, { counts: emptyCounts(), rollups: [] });
  }
  for (const r of rollups) {
    addToCounts(totals, r.type, r.count);
    const pc = perContributor.get(r.contributor_id);
    if (pc) {
      addToCounts(pc.counts, r.type, r.count);
      pc.rollups.push(r);
    }
  }

  // "Total contributors" = union of humans with >=1 event of any type (or
  // everyone with events under ?include_bots=1) — not the roster row count
  // and not GitHub's commit-only number.
  const activeCount = [...perContributor.values()].filter(
    (pc) => totalOf(pc.counts) > 0,
  ).length;

  const leaderboardFor = (
    metric: (c: Counts) => number,
  ): Array<{ login: string; count: number }> =>
    contributors
      .map((c) => ({
        login: c.login,
        count: metric(perContributor.get(c.id)!.counts),
      }))
      .filter((e) => e.count > 0)
      .sort((a, b) => b.count - a.count || (a.login < b.login ? -1 : 1));

  const contributorObjs = contributors
    .map((c) => {
      const pc = perContributor.get(c.id)!;
      const obj: Record<string, unknown> = {
        login: c.login,
        display_name: c.display_name,
        avatar_url: c.avatar_url,
        first_seen_at: c.first_seen_at,
        last_seen_at: c.last_seen_at,
        counts: pc.counts,
      };
      if (opts.withWeekly) obj["weekly"] = weeklyFrom(pc.rollups);
      return obj;
    })
    .sort((a, b) => {
      const ta = totalOf(a["counts"] as Counts);
      const tb = totalOf(b["counts"] as Counts);
      return (
        tb - ta || ((a["login"] as string) < (b["login"] as string) ? -1 : 1)
      );
    });

  return {
    totals: { contributors: activeCount, ...totals },
    leaderboards: {
      commits: leaderboardFor((c) => c.commits),
      prs: leaderboardFor((c) => c.prs),
      reviews: leaderboardFor((c) => c.reviews),
      comments: leaderboardFor((c) => c.comments.all),
    },
    contributors: contributorObjs,
  };
}

export async function handleStats(
  env: Env,
  request: Request,
): Promise<Response> {
  const url = new URL(request.url);
  return json(await assembleStats(env, url, { withWeekly: true }));
}

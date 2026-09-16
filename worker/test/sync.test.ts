import { env, fetchMock } from "cloudflare:test";
import { beforeAll, afterEach, describe, expect, it } from "vitest";
import { runSync } from "../src/sync/run";
import { parseCommitsPage } from "../src/sync/commits";
import { isCountableReview } from "../src/sync/prs";
import commitsPage from "./fixtures/graphql/commits-page.json";
import prsPage from "./fixtures/graphql/prs-page.json";
import issuesPage from "./fixtures/graphql/issues-page.json";
import commitComments from "./fixtures/graphql/commit-comments.json";

function mockGitHub() {
  fetchMock
    .get("https://api.github.com")
    .intercept({ path: "/graphql", method: "POST" })
    .reply(200, (opts) => {
      const body = JSON.parse(String(opts.body)) as { query: string };
      if (body.query.includes("query Commits")) return commitsPage;
      if (body.query.includes("query PRs")) return prsPage;
      if (body.query.includes("query Issues")) return issuesPage;
      if (body.query.includes("query CommitComments")) return commitComments;
      throw new Error(`unmocked GraphQL query: ${body.query.slice(0, 80)}`);
    })
    .persist();
}

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterEach(() => {
  fetchMock.assertNoPendingInterceptors();
});

async function eventCounts(): Promise<Record<string, number>> {
  const rows = await env.DB.prepare(
    "SELECT type, COUNT(*) AS n FROM activity_events GROUP BY type",
  ).all<{ type: string; n: number }>();
  return Object.fromEntries(rows.results.map((r) => [r.type, r.n]));
}

describe("full sync against recorded GraphQL pages", () => {
  it("ingests all sources, resolves identities, and is idempotent", async () => {
    mockGitHub();

    const first = await runSync(env, "admin");
    expect(first.skipped).toBe(false);
    expect(first.kind).toBe("backfill");
    expect(first.done).toBe(true);

    const counts = await eventCounts();
    expect(counts).toEqual({
      commit: 3,
      pr: 2,
      review: 1, // APPROVED only: PENDING and the empty-body container are skipped
      comment_review: 1,
      comment_issue: 4, // PR conversation x2 + issue comments x2
      comment_commit: 1,
    });

    // Identity resolution.
    const contributors = await env.DB.prepare(
      "SELECT login, github_id, display_name, is_bot FROM contributors ORDER BY login",
    ).all<{
      login: string;
      github_id: number | null;
      display_name: string | null;
      is_bot: number;
    }>();
    const byLogin = new Map(contributors.results.map((c) => [c.login, c]));

    expect(byLogin.get("alice")).toMatchObject({ github_id: 1001, is_bot: 0 });
    // noreply email "2002+bob@..." recovered to a real identity:
    expect(byLogin.get("bob")).toMatchObject({ github_id: 2002 });
    // unknown email became a hash row; no raw email stored anywhere:
    const emailRow = contributors.results.find((c) =>
      c.login.startsWith("email:"),
    );
    expect(emailRow).toBeDefined();
    expect(emailRow!.login).toMatch(/^email:[0-9a-f]{16}$/);
    expect(emailRow!.display_name).toBe("Carol");
    const rawEmailScan = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM contributors WHERE login LIKE '%@%'",
    ).first<{ n: number }>();
    expect(rawEmailScan!.n).toBe(0);
    // GraphQL Bot typename flagged:
    expect(byLogin.get("github-actions")).toMatchObject({ is_bot: 1 });
    // Deleted PR author became ghost:
    expect(byLogin.get("ghost")).toBeDefined();

    // Rollups were recomputed.
    const rollups = await env.DB.prepare(
      "SELECT SUM(count) AS n FROM daily_rollups",
    ).first<{ n: number }>();
    expect(rollups!.n).toBe(12);

    // Sync state promoted to incremental everywhere.
    const state = await env.DB.prepare(
      "SELECT source, cursor FROM sync_state",
    ).all<{ source: string; cursor: string }>();
    const bySource = Object.fromEntries(
      state.results.map((r) => [r.source, JSON.parse(r.cursor)]),
    );
    expect(bySource["commits"].phase).toBe("incremental");
    expect(bySource["commits"].since).toBe("2026-01-07T12:00:00Z");
    expect(bySource["prs"].phase).toBe("incremental");
    expect(bySource["issue_comments"].phase).toBe("incremental");
    expect(bySource["commit_comments"].cursor).toBe("cc-cursor-1");

    // Second run: incremental, and re-upserting the same pages changes nothing.
    const second = await runSync(env, "admin");
    expect(second.kind).toBe("incremental");
    expect(second.done).toBe(true);
    expect(await eventCounts()).toEqual(counts);
    const contributorCount = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM contributors",
    ).first<{ n: number }>();
    expect(contributorCount!.n).toBe(contributors.results.length);
  });
});

describe("parseCommitsPage", () => {
  it("extracts events and the max committedDate", () => {
    const { events, pageInfo, maxSeen } = parseCommitsPage(
      commitsPage.data as Record<string, unknown>,
    );
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({
      type: "commit",
      externalId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1",
      actor: { githubId: 1001, login: "alice" },
      payload: { headline: "feat: add entropy sampler", additions: 120 },
    });
    expect(events[1].actor).toMatchObject({
      login: null,
      email: "2002+bob@users.noreply.github.com",
    });
    expect(pageInfo.hasNextPage).toBe(false);
    expect(maxSeen).toBe("2026-01-07T12:00:00Z");
  });
});

describe("isCountableReview", () => {
  it("skips containers and drafts, counts real submissions", () => {
    expect(isCountableReview("APPROVED", "")).toBe(true);
    expect(isCountableReview("CHANGES_REQUESTED", "")).toBe(true);
    expect(isCountableReview("DISMISSED", "")).toBe(true);
    expect(isCountableReview("COMMENTED", "")).toBe(false);
    expect(isCountableReview("COMMENTED", "  \n")).toBe(false);
    expect(isCountableReview("COMMENTED", "real prose")).toBe(true);
  });
});

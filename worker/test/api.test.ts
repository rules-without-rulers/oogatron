import { env, fetchMock, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import commitsPage from "./fixtures/graphql/commits-page.json";
import prsPage from "./fixtures/graphql/prs-page.json";
import issuesPage from "./fixtures/graphql/issues-page.json";
import commitComments from "./fixtures/graphql/commit-comments.json";

const BASE = "https://oogatron.test";

async function seed(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO contributors (id, github_id, login, display_name, avatar_url, is_bot, first_seen_at, last_seen_at) VALUES
       (1, 1001, 'alice', 'Alice A', 'https://a.example/alice.png', 0, '2026-01-05T10:00:00Z', '2026-01-13T08:00:00Z'),
       (2, 4004, 'erik', NULL, NULL, 0, '2026-01-09T10:00:00Z', '2026-01-13T09:00:00Z'),
       (3, 5005, 'robo[bot]', NULL, NULL, 1, '2026-01-05T10:00:00Z', '2026-01-05T10:00:00Z')`,
    ),
    env.DB.prepare(
      `INSERT INTO activity_events (contributor_id, type, external_id, occurred_at) VALUES
       (1, 'commit', 'e1', '2026-01-05T10:00:00Z'),
       (1, 'commit', 'e2', '2026-01-12T15:00:00Z'),
       (1, 'pr',     'e3', '2026-01-06T10:00:00Z'),
       (1, 'comment_issue', 'e4', '2026-01-13T08:00:00Z'),
       (2, 'review', 'e5', '2026-01-09T10:00:00Z'),
       (3, 'commit', 'e6', '2026-01-05T10:00:00Z')`,
    ),
    env.DB.prepare(
      `INSERT INTO daily_rollups (day, contributor_id, type, count) VALUES
       ('2026-01-05', 1, 'commit', 1),
       ('2026-01-12', 1, 'commit', 1),
       ('2026-01-06', 1, 'pr', 1),
       ('2026-01-13', 1, 'comment_issue', 1),
       ('2026-01-09', 2, 'review', 1),
       ('2026-01-05', 3, 'commit', 1)`,
    ),
  ]);
}

describe("/v1/stats", () => {
  it("assembles totals, leaderboards, and contributors; excludes bots by default", async () => {
    await seed();
    const res = await SELF.fetch(`${BASE}/v1/stats`);
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const body = (await res.json()) as any;

    expect(body.meta).toMatchObject({
      repo: "OogaBoogaX/entropylab",
      schema_version: 1,
    });
    expect(body.totals).toEqual({
      contributors: 2,
      commits: 2, // bot commit excluded
      prs: 1,
      reviews: 1,
      comments: { issue: 1, review: 0, commit: 0, all: 1 },
    });
    expect(body.leaderboards.commits).toEqual([{ login: "alice", count: 2 }]);
    expect(body.leaderboards.reviews).toEqual([{ login: "erik", count: 1 }]);

    const logins = body.contributors.map((c: any) => c.login);
    expect(logins).toEqual(["alice", "erik"]); // sorted by total activity
    expect(body.contributors[0].weekly).toEqual([
      { week: "2026-W02", commits: 1, prs: 1, reviews: 0, comments: 0 },
      { week: "2026-W03", commits: 1, prs: 0, reviews: 0, comments: 1 },
    ]);
  });

  it("includes bots with ?include_bots=1", async () => {
    await seed();
    const res = await SELF.fetch(`${BASE}/v1/stats?include_bots=1`);
    const body = (await res.json()) as any;
    expect(body.totals.commits).toBe(3);
    expect(body.totals.contributors).toBe(3);
    expect(body.contributors.map((c: any) => c.login)).toContain("robo[bot]");
  });

  it("serves the second request from KV and misses after a generation bump", async () => {
    await seed();
    const first = await SELF.fetch(`${BASE}/v1/stats`);
    expect(first.headers.get("x-oogatron-cache")).toBeNull();
    const second = await SELF.fetch(`${BASE}/v1/stats`);
    expect(second.headers.get("x-oogatron-cache")).toBe("hit");
    await env.CACHE.put("cache:gen", "999");
    const third = await SELF.fetch(`${BASE}/v1/stats`);
    expect(third.headers.get("x-oogatron-cache")).toBeNull();
  });
});

describe("/v1/contributors", () => {
  it("returns the roster without weekly", async () => {
    await seed();
    const res = await SELF.fetch(`${BASE}/v1/contributors`);
    const body = (await res.json()) as any;
    expect(body.contributors[0].weekly).toBeUndefined();
    expect(body.contributors[0].counts).toBeDefined();
  });

  it("serves one contributor with from/to/type filters from raw events", async () => {
    await seed();
    const all = (await (
      await SELF.fetch(`${BASE}/v1/contributors/alice`)
    ).json()) as any;
    expect(all.counts.commits).toBe(2);
    expect(all.counts.prs).toBe(1);

    const windowed = (await (
      await SELF.fetch(
        `${BASE}/v1/contributors/alice?from=2026-01-10&to=2026-01-12`,
      )
    ).json()) as any;
    expect(windowed.counts.commits).toBe(1); // only e2 on the 12th
    expect(windowed.counts.prs).toBe(0);

    const typed = (await (
      await SELF.fetch(`${BASE}/v1/contributors/alice?type=pr`)
    ).json()) as any;
    expect(typed.counts.prs).toBe(1);
    expect(typed.counts.commits).toBe(0);

    const bad = await SELF.fetch(`${BASE}/v1/contributors/alice?type=nope`);
    expect(bad.status).toBe(400);
  });

  it("404s unknown logins and hides bots by default", async () => {
    await seed();
    expect((await SELF.fetch(`${BASE}/v1/contributors/nobody`)).status).toBe(
      404,
    );
    expect((await SELF.fetch(`${BASE}/v1/contributors/robo[bot]`)).status).toBe(
      404,
    );
    expect(
      (await SELF.fetch(`${BASE}/v1/contributors/robo[bot]?include_bots=1`))
        .status,
    ).toBe(200);
  });
});

describe("CORS", () => {
  it("answers preflight on /v1/*", async () => {
    const res = await SELF.fetch(`${BASE}/v1/stats`, { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-methods")).toContain("GET");
  });
});

describe("/admin/backfill", () => {
  beforeAll(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });

  it("rejects missing or wrong bearer tokens", async () => {
    expect(
      (await SELF.fetch(`${BASE}/admin/backfill`, { method: "POST" })).status,
    ).toBe(401);
    const wrong = await SELF.fetch(`${BASE}/admin/backfill`, {
      method: "POST",
      headers: { authorization: "Bearer nope" },
    });
    expect(wrong.status).toBe(401);
  });

  it("runs a sync slice with a valid token", async () => {
    fetchMock
      .get("https://api.github.com")
      .intercept({ path: "/graphql", method: "POST" })
      .reply(200, (opts) => {
        const body = JSON.parse(String(opts.body)) as { query: string };
        if (body.query.includes("query Commits")) return commitsPage;
        if (body.query.includes("query PRs")) return prsPage;
        if (body.query.includes("query Issues")) return issuesPage;
        if (body.query.includes("query CommitComments")) return commitComments;
        throw new Error("unmocked query");
      })
      .persist();

    const res = await SELF.fetch(`${BASE}/admin/backfill`, {
      method: "POST",
      headers: { authorization: "Bearer test-admin-token" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.result.done).toBe(true);
    expect(body.result.eventsWritten).toBeGreaterThan(0);
  });
});

describe("unknown routes", () => {
  it("404s", async () => {
    expect((await SELF.fetch(`${BASE}/nope`)).status).toBe(404);
  });
});

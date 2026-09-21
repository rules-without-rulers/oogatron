import { describe, expect, it } from "vitest";
import { parseStats } from "../../jumbotron/data.js";
import {
  DEFAULT_PALETTE,
  VIEWS,
  drawText,
  fitText,
  glyphOf,
  measureText,
  recentAge,
} from "../../jumbotron/views.js";
import fixture from "../../harness/fixtures/stats.json";

// Minimal recording stand-in for CanvasRenderingContext2D: the views and the
// bitmap-font renderer only use fillStyle + fillRect, which makes their
// output testable without a DOM.
function recordingCtx() {
  const rects: Array<{
    x: number;
    y: number;
    w: number;
    h: number;
    style: string;
  }> = [];
  return {
    rects,
    fillStyle: "" as string,
    fillRect(x: number, y: number, w: number, h: number) {
      rects.push({ x, y, w, h, style: String(this.fillStyle) });
    },
  };
}

describe("data.js parseStats", () => {
  it("parses the real fixture into the view model", () => {
    const model = parseStats(fixture);
    expect(model.org).toBe("OogaBoogaX");
    expect(model.totals.contributors).toBeGreaterThan(0);
    expect(Number.isInteger(model.totals.comments)).toBe(true);
    expect(model.repos.length).toBeGreaterThan(0);
    expect(model.repos[0].name).toBe("entropylab");
    expect(model.repos[0].totals.commits).toBeGreaterThan(0);
    expect(model.repos[0].leaderboards.commits.length).toBeGreaterThan(0);
    expect(model.repos[0].lastActivityAt).toMatch(/^\d{4}-/);
    expect(model.recent.length).toBeGreaterThan(0);
    expect(model.contributors.length).toBeGreaterThan(0);
    expect(model.byLogin.has(model.contributors[0].login)).toBe(true);
    expect(model.latestWeek).toMatch(/^\d{4}-W\d{2}$/);
    expect(model.weeklyTotals.length).toBeGreaterThan(0);
  });

  it("rejects other schema versions but tolerates extra fields", () => {
    for (const schema_version of [1, 2, 99]) {
      expect(() =>
        parseStats({
          meta: { schema_version },
          totals: {},
          leaderboards: {},
          repos: [],
          recent: [],
          contributors: [],
        }),
      ).toThrow(/schema_version/);
    }
    const extended = JSON.parse(JSON.stringify(fixture));
    extended.meta.someFutureField = true;
    extended.contributors[0].badge = "gold";
    extended.repos[0].mascot = "gorilla";
    extended.recent[0].mood = "jubilant";
    expect(() => parseStats(extended)).not.toThrow();
  });
});

describe("views.js bitmap font", () => {
  it("draws one rect per set bit and measures deterministically", () => {
    const ctx = recordingCtx();
    // 'A' = 01110/10001/10001/11111/10001/10001/10001 -> 18 set bits
    drawText(ctx as never, "A", 0, 0, "#fff", 1);
    expect(ctx.rects.length).toBe(18);
    expect(measureText("AB")).toBe(11); // 2 glyphs * (5+1) - 1
    expect(measureText("AB", 2)).toBe(22);
    // unknown glyphs fall back to a box rather than vanishing
    expect(glyphOf("~").length).toBe(7);
    expect(fitText("abcdefgh", 24)).toBe("abcd"); // 24px fits 4 glyphs
  });

  it("recentAge compresses to minutes, hours, days", () => {
    const now = Date.parse("2026-01-10T12:00:00Z");
    expect(recentAge("2026-01-10T11:55:00Z", now)).toBe("5M");
    expect(recentAge("2026-01-10T09:00:00Z", now)).toBe("3H");
    expect(recentAge("2026-01-08T09:00:00Z", now)).toBe("2D");
    expect(recentAge("2026-01-11T00:00:00Z", now)).toBe("NOW"); // future-safe
  });
});

describe("view renderers against the real fixture", () => {
  const model = parseStats(fixture);
  const repoName = model.repos[0].name;
  const cases: Array<[string, unknown]> = [
    ["recent", undefined],
    ["totals", undefined],
    ["repo", { name: repoName }],
    ["repo", { name: "no-such-repo-falls-back" }],
    ["leaderboard", { type: "commits", repo: repoName }],
    ["leaderboard", { type: "prs", repo: repoName }],
    ["leaderboard", { type: "reviews", repo: repoName }],
    ["leaderboard", { type: "comments", repo: repoName }],
  ];

  it.each(cases)(
    "%s renders without throwing and paints the board",
    (name, params) => {
      const ctx = recordingCtx();
      const animated = VIEWS[name as string](
        ctx as never,
        192,
        108,
        model,
        params,
        DEFAULT_PALETTE,
        1.5,
      );
      // background + content: a populated board is hundreds of rects
      expect(ctx.rects.length).toBeGreaterThan(100);
      // full-board clear happens first
      expect(ctx.rects[0]).toMatchObject({ x: 0, y: 0, w: 192, h: 108 });
      // nothing is painted below the board's bottom edge
      expect(ctx.rects.every((r) => r.y + r.h <= 108)).toBe(true);
      expect(typeof animated).toBe("boolean");
    },
  );

  it("the registry holds exactly the v3 view set", () => {
    expect(Object.keys(VIEWS).sort()).toEqual([
      "leaderboard",
      "recent",
      "repo",
      "totals",
    ]);
  });

  it("no view requests continuous animation", () => {
    const ctx = recordingCtx();
    for (const [name, render] of Object.entries(VIEWS)) {
      expect(
        render(ctx as never, 192, 108, model, undefined, DEFAULT_PALETTE, 0),
        name,
      ).toBe(false);
    }
  });
});

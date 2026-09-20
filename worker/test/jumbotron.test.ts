import { describe, expect, it } from "vitest";
import { parseStats } from "../../jumbotron/data.js";
import {
  DEFAULT_PALETTE,
  VIEWS,
  drawText,
  fitText,
  glyphOf,
  measureText,
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
    expect(model.repos.length).toBeGreaterThan(0);
    expect(model.repos[0].name).toBe("entropylab");
    expect(model.repos[0].totals.commits).toBeGreaterThan(0);
    expect(model.contributors.length).toBeGreaterThan(0);
    expect(model.byLogin.has(model.contributors[0].login)).toBe(true);
    expect(model.latestWeek).toMatch(/^\d{4}-W\d{2}$/);
    expect(model.weeklyTotals.length).toBeGreaterThan(0);
  });

  it("rejects unknown schema versions but tolerates extra fields", () => {
    expect(() =>
      parseStats({
        meta: { schema_version: 1 },
        totals: {},
        leaderboards: {},
        repos: [],
        contributors: [],
      }),
    ).toThrow(/schema_version/);
    expect(() =>
      parseStats({
        meta: { schema_version: 99 },
        totals: {},
        leaderboards: {},
        repos: [],
        contributors: [],
      }),
    ).toThrow(/schema_version/);
    const extended = JSON.parse(JSON.stringify(fixture));
    extended.meta.someFutureField = true;
    extended.contributors[0].badge = "gold";
    extended.repos[0].mascot = "gorilla";
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
});

describe("view renderers against the real fixture", () => {
  const model = parseStats(fixture);
  const cases: Array<[string, unknown]> = [
    ["totals", undefined],
    ["repo", { name: model.repos[0].name }],
    ["repo", { name: "no-such-repo-falls-back" }],
    ["leaderboard", { type: "commits" }],
    ["leaderboard", { type: "prs" }],
    ["leaderboard", { type: "reviews" }],
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
      expect(typeof animated).toBe("boolean");
    },
  );

  it("removed views (ticker, contributor) are gone from the registry", () => {
    expect(Object.keys(VIEWS).sort()).toEqual([
      "leaderboard",
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

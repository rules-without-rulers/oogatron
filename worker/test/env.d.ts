declare module "cloudflare:test" {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface ProvidedEnv extends Env {
    TEST_MIGRATIONS: D1Migration[];
  }
}

// The jumbotron is plain JS with JSDoc types; declare the members the worker
// test suite exercises.
declare module "*/jumbotron/data.js" {
  export function parseStats(json: unknown): {
    org: string;
    totals: Record<string, unknown> & { contributors: number };
    leaderboards: Record<string, Array<{ login: string; count: number }>>;
    repos: Array<{
      name: string;
      totals: Record<string, number> & { contributors: number };
      weekly: Array<{ week: string }>;
      weeklyTotals: Array<{ week: string; total: number }>;
    }>;
    contributors: Array<{ login: string; weekly: Array<{ week: string }> }>;
    byLogin: Map<string, unknown>;
    latestWeek: string | null;
    weeklyTotals: Array<{ week: string; total: number }>;
  };
  export function displayLabel(c: {
    login: string;
    display_name?: string | null;
  }): string;
}

declare module "*/jumbotron/views.js" {
  export const DEFAULT_PALETTE: Record<string, string>;
  export const GLYPH_W: number;
  export const GLYPH_H: number;
  export function glyphOf(ch: string): number[];
  export function measureText(text: string, scale?: number): number;
  export function drawText(
    ctx: unknown,
    text: string,
    x: number,
    y: number,
    color: string,
    scale?: number,
  ): void;
  export function fitText(
    text: string,
    maxWidth: number,
    scale?: number,
  ): string;
  export const VIEWS: Record<
    string,
    (
      ctx: unknown,
      W: number,
      H: number,
      model: unknown,
      params: unknown,
      palette: unknown,
      t?: number,
    ) => boolean
  >;
}

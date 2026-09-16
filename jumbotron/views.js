// Canvas renderers for the jumbotron views. Everything draws onto a small
// offscreen 2D canvas (the "LED board") that screen.js uploads as a
// NEAREST-filtered WebGL texture, so every logical pixel becomes a chunky
// voxel-style block. Text uses a built-in 5x7 bitmap font: deterministic on
// every platform (no system-font drift) and authentically blocky.
//
// Zero dependencies. Views never touch raw JSON — only the parsed StatsModel
// from data.js.

/** @typedef {import("./data.js").StatsModel} StatsModel */
/** @typedef {import("./data.js").Contributor} Contributor */

import { displayLabel } from "./data.js";

// Named palette tokens, in one place — values extracted from oogaboogaland's
// src/ (Phase 4) so the jumbotron reads as native to the island. Sources in
// oogaboogaland: style.css :root tokens (the HUD deliberately reuses in-world
// material colors), hub-models.js WOOD/PLANK/screen constants, qr.js darks,
// gl-renderer.js matrix green, race-hud.js gold.
export const DEFAULT_PALETTE = {
  screenBg: "#0a0c0a", // qr.js dark — near-black with a green cast
  grid: "#131912", // scanline tint over screenBg
  text: "#f3efe4", // --paper, the cave-sign pixel-text color
  dim: "#a6a6a2", // --muted
  accent: "#d8892b", // --accent (also the legendary tier color)
  commits: "#46ff70", // matrix green — the in-world screen glow
  prs: "#3fd1c5", // lab console screen teal
  reviews: "#6f9fca", // screen blue / rare tier
  comments: "#f5c542", // race-HUD player gold
  danger: "#e5533d", // --danger
  bezel: "#8a6236", // WOOD
  bezelLight: "#a9773f", // PLANK
  bezelDark: "#5c4425", // WOOD_DK
  screenBezel: "#1d2326", // wall-screen bezel (hub-models SCREEN)
  standDark: "#4a3319", // wood end-grain / edge
  nail: "#3a2a18", // nails & iron
};

// Logical board resolution (multiplied by options.pixelDensity).
export const BOARD_W = 192;
export const BOARD_H = 108;

// ---------------------------------------------------------------------------
// 5x7 bitmap font (rows of 5 bits, top to bottom). Lowercase maps to upper.
// ---------------------------------------------------------------------------

/** @type {Record<string, number[]>} */
const FONT = {
  A: [0b01110, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001],
  B: [0b11110, 0b10001, 0b11110, 0b10001, 0b10001, 0b10001, 0b11110],
  C: [0b01110, 0b10001, 0b10000, 0b10000, 0b10000, 0b10001, 0b01110],
  D: [0b11100, 0b10010, 0b10001, 0b10001, 0b10001, 0b10010, 0b11100],
  E: [0b11111, 0b10000, 0b11110, 0b10000, 0b10000, 0b10000, 0b11111],
  F: [0b11111, 0b10000, 0b11110, 0b10000, 0b10000, 0b10000, 0b10000],
  G: [0b01110, 0b10001, 0b10000, 0b10111, 0b10001, 0b10001, 0b01111],
  H: [0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001, 0b10001],
  I: [0b01110, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
  J: [0b00111, 0b00010, 0b00010, 0b00010, 0b10010, 0b10010, 0b01100],
  K: [0b10001, 0b10010, 0b10100, 0b11000, 0b10100, 0b10010, 0b10001],
  L: [0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b11111],
  M: [0b10001, 0b11011, 0b10101, 0b10101, 0b10001, 0b10001, 0b10001],
  N: [0b10001, 0b11001, 0b10101, 0b10011, 0b10001, 0b10001, 0b10001],
  O: [0b01110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110],
  P: [0b11110, 0b10001, 0b10001, 0b11110, 0b10000, 0b10000, 0b10000],
  Q: [0b01110, 0b10001, 0b10001, 0b10001, 0b10101, 0b10010, 0b01101],
  R: [0b11110, 0b10001, 0b10001, 0b11110, 0b10100, 0b10010, 0b10001],
  S: [0b01111, 0b10000, 0b10000, 0b01110, 0b00001, 0b00001, 0b11110],
  T: [0b11111, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100],
  U: [0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110],
  V: [0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01010, 0b00100],
  W: [0b10001, 0b10001, 0b10001, 0b10101, 0b10101, 0b11011, 0b10001],
  X: [0b10001, 0b10001, 0b01010, 0b00100, 0b01010, 0b10001, 0b10001],
  Y: [0b10001, 0b10001, 0b01010, 0b00100, 0b00100, 0b00100, 0b00100],
  Z: [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b10000, 0b11111],
  0: [0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110],
  1: [0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
  2: [0b01110, 0b10001, 0b00001, 0b00110, 0b01000, 0b10000, 0b11111],
  3: [0b11111, 0b00010, 0b00100, 0b00010, 0b00001, 0b10001, 0b01110],
  4: [0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010],
  5: [0b11111, 0b10000, 0b11110, 0b00001, 0b00001, 0b10001, 0b01110],
  6: [0b00110, 0b01000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110],
  7: [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000],
  8: [0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110],
  9: [0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00010, 0b01100],
  " ": [0, 0, 0, 0, 0, 0, 0],
  "-": [0, 0, 0, 0b01110, 0, 0, 0],
  "_": [0, 0, 0, 0, 0, 0, 0b11111],
  ".": [0, 0, 0, 0, 0, 0b00110, 0b00110],
  ",": [0, 0, 0, 0, 0, 0b00100, 0b01000],
  ":": [0, 0b00110, 0b00110, 0, 0b00110, 0b00110, 0],
  "/": [0b00001, 0b00010, 0b00010, 0b00100, 0b01000, 0b01000, 0b10000],
  "+": [0, 0b00100, 0b00100, 0b11111, 0b00100, 0b00100, 0],
  "*": [0, 0b10101, 0b01110, 0b11111, 0b01110, 0b10101, 0],
  "#": [0b01010, 0b11111, 0b01010, 0b01010, 0b01010, 0b11111, 0b01010],
  "%": [0b11001, 0b11010, 0b00010, 0b00100, 0b01000, 0b01011, 0b10011],
  "?": [0b01110, 0b10001, 0b00001, 0b00110, 0b00100, 0, 0b00100],
  "!": [0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0, 0b00100],
  "'": [0b00100, 0b00100, 0, 0, 0, 0, 0],
  "(": [0b00010, 0b00100, 0b01000, 0b01000, 0b01000, 0b00100, 0b00010],
  ")": [0b01000, 0b00100, 0b00010, 0b00010, 0b00010, 0b00100, 0b01000],
  "[": [0b01110, 0b01000, 0b01000, 0b01000, 0b01000, 0b01000, 0b01110],
  "]": [0b01110, 0b00010, 0b00010, 0b00010, 0b00010, 0b00010, 0b01110],
  "=": [0, 0, 0b11111, 0, 0b11111, 0, 0],
  ">": [0b10000, 0b01000, 0b00100, 0b00010, 0b00100, 0b01000, 0b10000],
  "<": [0b00001, 0b00010, 0b00100, 0b01000, 0b00100, 0b00010, 0b00001],
};
const FALLBACK_GLYPH = [0b11111, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b11111];

export const GLYPH_W = 5;
export const GLYPH_H = 7;
const TRACKING = 1; // pixels between glyphs

/** @param {string} ch @returns {number[]} */
export function glyphOf(ch) {
  const up = ch.toUpperCase();
  return FONT[up] ?? FALLBACK_GLYPH;
}

/**
 * Pixel width of a string at a given scale (no trailing tracking).
 * @param {string} text @param {number} [scale]
 */
export function measureText(text, scale = 1) {
  if (text.length === 0) return 0;
  return (text.length * (GLYPH_W + TRACKING) - TRACKING) * scale;
}

/**
 * Draws bitmap text. `ctx` only needs fillRect + fillStyle, which is what
 * lets renderer tests run against a recording stub instead of a real canvas.
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} text
 * @param {number} x @param {number} y
 * @param {string} color
 * @param {number} [scale]
 */
export function drawText(ctx, text, x, y, color, scale = 1) {
  ctx.fillStyle = color;
  let cx = x;
  for (const ch of text) {
    const rows = glyphOf(ch);
    for (let r = 0; r < GLYPH_H; r++) {
      const bits = rows[r];
      for (let c = 0; c < GLYPH_W; c++) {
        if (bits & (1 << (GLYPH_W - 1 - c))) {
          ctx.fillRect(cx + c * scale, y + r * scale, scale, scale);
        }
      }
    }
    cx += (GLYPH_W + TRACKING) * scale;
  }
}

/** Truncates text to fit maxWidth pixels at scale, adding no ellipsis (LED style). */
export function fitText(text, maxWidth, scale = 1) {
  const perChar = (GLYPH_W + TRACKING) * scale;
  const maxChars = Math.max(0, Math.floor((maxWidth + TRACKING * scale) / perChar));
  return text.length <= maxChars ? text : text.slice(0, maxChars);
}

// ---------------------------------------------------------------------------
// Deterministic LifeHash-style identicon: 8x8 horizontally mirrored grid.
// ---------------------------------------------------------------------------

/** FNV-1a 32-bit. @param {string} s */
export function hash32(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Deterministic 8x8 identicon grid for a login. Cell values: 0 = off,
 * 1 = primary color, 2 = secondary color. Mirrored across the vertical axis.
 * @param {string} login
 * @returns {number[][]}
 */
export function identiconGrid(login) {
  let state = hash32(login) || 1;
  const next = () => {
    // mulberry32
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const grid = [];
  for (let r = 0; r < 8; r++) {
    const row = new Array(8).fill(0);
    for (let c = 0; c < 4; c++) {
      const v = next();
      const cell = v < 0.42 ? 0 : v < 0.78 ? 1 : 2;
      row[c] = cell;
      row[7 - c] = cell;
    }
    grid.push(row);
  }
  return grid;
}

// oogaboogaland's LifeHash implementation (bc-lifehash) derives all identicon
// colors from this fixed 7-stop spectrum; picking our pair from the same
// stops keeps contributor identicons color-consistent with the island's.
const LIFEHASH_SPECTRUM = [
  "#00a8de",
  "#293c82",
  "#d23b82",
  "#d93f35",
  "#f4e451",
  "#009e54",
];

/** Picks two identicon colors deterministically from the LifeHash spectrum. */
export function identiconColors(login, _palette) {
  const h = hash32(`${login}#color`);
  const a = h % LIFEHASH_SPECTRUM.length;
  const b =
    (a + 1 + ((h >>> 8) % (LIFEHASH_SPECTRUM.length - 1))) %
    LIFEHASH_SPECTRUM.length;
  return [LIFEHASH_SPECTRUM[a], LIFEHASH_SPECTRUM[b]];
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} login
 * @param {number} x @param {number} y @param {number} cell cell size in px
 * @param {typeof DEFAULT_PALETTE} palette
 */
export function drawIdenticon(ctx, login, x, y, cell, palette) {
  const grid = identiconGrid(login);
  const [c1, c2] = identiconColors(login, palette);
  ctx.fillStyle = palette.grid;
  ctx.fillRect(x - 1, y - 1, 8 * cell + 2, 8 * cell + 2);
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const v = grid[r][c];
      if (v === 0) continue;
      ctx.fillStyle = v === 1 ? c1 : c2;
      ctx.fillRect(x + c * cell, y + r * cell, cell, cell);
    }
  }
}

// ---------------------------------------------------------------------------
// Shared chrome
// ---------------------------------------------------------------------------

function clearBoard(ctx, W, H, palette) {
  ctx.fillStyle = palette.screenBg;
  ctx.fillRect(0, 0, W, H);
  // faint scanline grid for the LED feel
  ctx.fillStyle = palette.grid;
  for (let y = 0; y < H; y += 4) ctx.fillRect(0, y, W, 1);
}

function header(ctx, W, palette, title, right) {
  drawText(ctx, title, 3, 3, palette.accent, 1);
  if (right) {
    drawText(ctx, right, W - 3 - measureText(right, 1), 3, palette.dim, 1);
  }
  ctx.fillStyle = palette.dim;
  ctx.fillRect(0, 12, W, 1);
}

const TYPE_COLOR = { commits: "commits", prs: "prs", reviews: "reviews", comments: "comments" };

// ---------------------------------------------------------------------------
// Views. Each renders the full board; signature:
//   render(ctx, W, H, model, params, palette, t) -> dirtyNextFrame (boolean)
// ---------------------------------------------------------------------------

/** @type {Record<string, Function>} */
export const VIEWS = {
  totals: renderTotals,
  leaderboard: renderLeaderboard,
  contributor: renderContributor,
  ticker: renderTicker,
};

export function renderTotals(ctx, W, H, model, _params, palette) {
  clearBoard(ctx, W, H, palette);
  header(ctx, W, palette, "ENTROPYLAB TOTALS", model.latestWeek ?? "");

  const t = model.totals;
  const rows = [
    ["CONTRIBUTORS", t.contributors, palette.accent],
    ["COMMITS", t.commits, palette.commits],
    ["PRS", t.prs, palette.prs],
    ["REVIEWS", t.reviews, palette.reviews],
    ["COMMENTS", t.comments.all, palette.comments],
  ];
  let y = 17;
  for (const [label, value, color] of rows) {
    drawText(ctx, String(label), 6, y + 3, palette.dim, 1);
    const v = String(value);
    drawText(ctx, v, W - 66 - measureText(v, 2), y, color, 2);
    y += 15;
  }

  // repo-wide weekly activity sparkline, right side
  const spark = model.weeklyTotals.slice(-14);
  if (spark.length > 0) {
    const maxV = Math.max(...spark.map((w) => w.total), 1);
    const bw = 4;
    const bx = W - 6 - spark.length * bw;
    const baseY = H - 12;
    const maxH = 56;
    spark.forEach((w, i) => {
      const h = Math.max(1, Math.round((w.total / maxV) * maxH));
      ctx.fillStyle = i === spark.length - 1 ? palette.accent : palette.commits;
      ctx.fillRect(bx + i * bw, baseY - h, bw - 1, h);
    });
    const label = `${spark.length} WEEKS`;
    drawText(ctx, label, W - 6 - measureText(label), baseY + 3, palette.dim, 1);
  }
  return false;
}

export function renderLeaderboard(ctx, W, H, model, params, palette) {
  const type = params?.type ?? "commits";
  const board = model.leaderboards[type] ?? [];
  const color = palette[TYPE_COLOR[type] ?? "accent"];
  clearBoard(ctx, W, H, palette);
  header(ctx, W, palette, `TOP ${type.toUpperCase()}`, model.latestWeek ?? "");

  const top = board.slice(0, 7);
  const maxV = Math.max(...top.map((e) => e.count), 1);
  let y = 16;
  top.forEach((e, i) => {
    const c = model.byLogin.get(e.login);
    const label = fitText((c ? displayLabel(c) : e.login).toUpperCase(), 66, 1);
    drawText(ctx, String(i + 1), 4, y, i === 0 ? palette.accent : palette.dim, 1);
    drawText(ctx, label, 14, y, palette.text, 1);
    const barX = 84;
    const barMax = W - barX - 30;
    const bw = Math.max(1, Math.round((e.count / maxV) * barMax));
    ctx.fillStyle = color;
    ctx.fillRect(barX, y + 1, bw, 5);
    const v = String(e.count);
    drawText(ctx, v, W - 4 - measureText(v, 1), y, color, 1);
    y += 13;
  });
  return false;
}

export function renderContributor(ctx, W, H, model, params, palette) {
  const login = params?.login;
  const c = (login && model.byLogin.get(login)) || model.contributors[0];
  clearBoard(ctx, W, H, palette);
  if (!c) {
    drawText(ctx, "NO CONTRIBUTORS", 40, 48, palette.dim, 1);
    return false;
  }
  header(ctx, W, palette, "CONTRIBUTOR", model.latestWeek ?? "");

  drawIdenticon(ctx, c.login, 6, 18, 4, palette);
  const name = fitText(displayLabel(c).toUpperCase(), W - 50, 1);
  drawText(ctx, name, 44, 20, palette.text, 1);
  if (c.display_name && !c.login.startsWith("email:")) {
    drawText(ctx, fitText(c.display_name.toUpperCase(), W - 50, 1), 44, 30, palette.dim, 1);
  }

  const counts = [
    ["CM", c.counts.commits, palette.commits],
    ["PR", c.counts.prs, palette.prs],
    ["RV", c.counts.reviews, palette.reviews],
    ["MSG", c.counts.comments.all, palette.comments],
  ];
  let x = 44;
  for (const [label, value, color] of counts) {
    drawText(ctx, String(label), x, 42, palette.dim, 1);
    drawText(ctx, String(value), x, 50, color, 1);
    x += 36;
  }

  // weekly sparkline (all activity), last 26 weeks
  const weeks = c.weekly.slice(-26);
  if (weeks.length > 0) {
    const maxV = Math.max(
      ...weeks.map((w) => w.commits + w.prs + w.reviews + w.comments),
      1,
    );
    const bw = 5;
    const bx = 6;
    const baseY = H - 12;
    const maxH = 28;
    weeks.forEach((w, i) => {
      const total = w.commits + w.prs + w.reviews + w.comments;
      const h = Math.max(total > 0 ? 1 : 0, Math.round((total / maxV) * maxH));
      if (h > 0) {
        ctx.fillStyle = i === weeks.length - 1 ? palette.accent : palette.prs;
        ctx.fillRect(bx + i * bw, baseY - h, bw - 1, h);
      }
    });
    ctx.fillStyle = palette.grid;
    ctx.fillRect(bx, baseY, weeks.length * bw, 1);
    drawText(ctx, `${weeks.length} WEEKS`, bx, baseY + 3, palette.dim, 1);
  }
  return false;
}

const TICKER_SPEED = 30; // px per second

export function renderTicker(ctx, W, H, model, _params, palette, t) {
  clearBoard(ctx, W, H, palette);
  header(ctx, W, palette, "LIVE WIRE", model.latestWeek ?? "");

  // static digest in the middle
  const digest = [
    ["COMMITS", model.totals.commits, palette.commits],
    ["PRS", model.totals.prs, palette.prs],
    ["REVIEWS", model.totals.reviews, palette.reviews],
    ["COMMENTS", model.totals.comments.all, palette.comments],
  ];
  let x = 6;
  for (const [label, value, color] of digest) {
    drawText(ctx, String(label), x, 26, palette.dim, 1);
    drawText(ctx, String(value), x, 36, color, 2);
    x += 46;
  }

  // scrolling marquee
  const text = model.tickerText || "NO DATA";
  const tw = measureText(text, 1) + W;
  const offset = ((t ?? 0) * TICKER_SPEED) % tw;
  const y = H - 20;
  ctx.fillStyle = palette.grid;
  ctx.fillRect(0, y - 4, W, 15);
  drawText(ctx, text, W - offset, y, palette.accent, 1);
  return true; // animates every frame
}

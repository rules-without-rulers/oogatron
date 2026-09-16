// Hand-rolled, dependency-free structural validator for the /v1/stats payload
// (schema_version 1). Shared by the worker's contract test, snapshot.mjs, and
// later the jumbotron's data.js. Unknown extra fields are tolerated — the
// contract allows additive changes within a schema_version.

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const ISO_WEEK = /^\d{4}-W\d{2}$/;

/**
 * @param {unknown} json
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateStats(json) {
  /** @type {string[]} */
  const errors = [];
  const fail = (/** @type {string} */ msg) => {
    errors.push(msg);
  };

  if (typeof json !== "object" || json === null) {
    return { ok: false, errors: ["payload is not an object"] };
  }
  const root = /** @type {Record<string, any>} */ (json);

  // meta
  const meta = root.meta;
  if (typeof meta !== "object" || meta === null) fail("meta missing");
  else {
    if (meta.schema_version !== 1) fail(`meta.schema_version !== 1`);
    if (typeof meta.repo !== "string") fail("meta.repo not a string");
    if (typeof meta.generated_at !== "string" || !ISO_DATE.test(meta.generated_at))
      fail("meta.generated_at not ISO-8601");
  }

  // totals
  const totals = root.totals;
  if (typeof totals !== "object" || totals === null) fail("totals missing");
  else {
    for (const k of ["contributors", "commits", "prs", "reviews"]) {
      if (!Number.isInteger(totals[k])) fail(`totals.${k} not an integer`);
    }
    checkComments(totals.comments, "totals.comments", fail);
  }

  // leaderboards
  const lb = root.leaderboards;
  if (typeof lb !== "object" || lb === null) fail("leaderboards missing");
  else {
    for (const k of ["commits", "prs", "reviews", "comments"]) {
      if (!Array.isArray(lb[k])) {
        fail(`leaderboards.${k} not an array`);
        continue;
      }
      lb[k].forEach((/** @type {any} */ e, /** @type {number} */ i) => {
        if (typeof e?.login !== "string")
          fail(`leaderboards.${k}[${i}].login not a string`);
        if (!Number.isInteger(e?.count))
          fail(`leaderboards.${k}[${i}].count not an integer`);
      });
    }
  }

  // contributors
  if (!Array.isArray(root.contributors)) fail("contributors not an array");
  else {
    root.contributors.forEach((/** @type {any} */ c, /** @type {number} */ i) => {
      const at = `contributors[${i}]`;
      if (typeof c?.login !== "string") fail(`${at}.login not a string`);
      for (const k of ["display_name", "avatar_url", "first_seen_at", "last_seen_at"]) {
        if (c?.[k] !== null && typeof c?.[k] !== "string")
          fail(`${at}.${k} not string|null`);
      }
      if (typeof c?.counts !== "object" || c.counts === null)
        fail(`${at}.counts missing`);
      else {
        for (const k of ["commits", "prs", "reviews"]) {
          if (!Number.isInteger(c.counts[k])) fail(`${at}.counts.${k} not an integer`);
        }
        checkComments(c.counts.comments, `${at}.counts.comments`, fail);
      }
      if (!Array.isArray(c?.weekly)) fail(`${at}.weekly not an array`);
      else {
        c.weekly.forEach((/** @type {any} */ w, /** @type {number} */ j) => {
          if (typeof w?.week !== "string" || !ISO_WEEK.test(w.week))
            fail(`${at}.weekly[${j}].week not YYYY-Www`);
          for (const k of ["commits", "prs", "reviews", "comments"]) {
            if (!Number.isInteger(w?.[k])) fail(`${at}.weekly[${j}].${k} not an integer`);
          }
        });
      }
    });
  }

  return { ok: errors.length === 0, errors };
}

/**
 * @param {any} comments
 * @param {string} at
 * @param {(msg: string) => void} fail
 */
function checkComments(comments, at, fail) {
  if (typeof comments !== "object" || comments === null) {
    fail(`${at} missing`);
    return;
  }
  for (const k of ["issue", "review", "commit", "all"]) {
    if (!Number.isInteger(comments[k])) fail(`${at}.${k} not an integer`);
  }
}

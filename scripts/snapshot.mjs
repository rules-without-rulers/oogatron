#!/usr/bin/env node
// Fetches /v1/stats from a deployed oogatron worker, validates it against the
// shared schema checker, and writes a deterministic snapshot JSON. Used by CI
// and, later, by oogaboogaland's build to bake stats in at build time.
//
// Usage: node scripts/snapshot.mjs --url https://oogatron.example.workers.dev \
//                                  --out harness/fixtures/stats.json

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { validateStats } from "./lib/validate-stats.mjs";

const { values } = parseArgs({
  options: {
    url: { type: "string" },
    out: { type: "string", default: "harness/fixtures/stats.json" },
  },
});

if (!values.url) {
  console.error("usage: snapshot.mjs --url <worker base url> [--out <path>]");
  process.exit(2);
}

const endpoint = new URL("/v2/stats", values.url).toString();
const res = await fetch(endpoint);
if (!res.ok) {
  console.error(`GET ${endpoint} -> HTTP ${res.status}`);
  process.exit(1);
}
const payload = await res.json();

const { ok, errors } = validateStats(payload);
if (!ok) {
  console.error(`payload failed validation:\n  ${errors.join("\n  ")}`);
  process.exit(1);
}

const outPath = resolve(values.out);
await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, JSON.stringify(payload, null, 2) + "\n");
console.log(
  `wrote ${outPath} (${payload.contributors.length} contributors, ` +
    `${payload.totals.commits} commits)`,
);

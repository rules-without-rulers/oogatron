#!/usr/bin/env node
// Headless-browser smoke test for the harness: serves the repo statically,
// opens harness/index.html in both WebGL2 and ?canvas2d=1 modes, and fails on
// ANY console error/warning or page error — the same clean-console standard
// oogaboogaland holds. Uses puppeteer-core with a system Chrome (nothing is
// downloaded). Optionally writes screenshots: --shots <dir>.
//
// Usage: node scripts/smoke-harness.mjs [--shots /tmp/shots]

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { parseArgs } from "node:util";
import puppeteer from "puppeteer-core";

const { values } = parseArgs({ options: { shots: { type: "string" } } });

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
};

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
  ].filter(Boolean);
  for (const c of candidates) if (existsSync(c)) return c;
  throw new Error("no Chrome found; set CHROME_PATH");
}

const server = createServer(async (req, res) => {
  try {
    const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname));
    const file = join(ROOT, path);
    if (!file.startsWith(ROOT)) throw new Error("traversal");
    const body = await readFile(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const browser = await puppeteer.launch({
  executablePath: findChrome(),
  headless: true,
  args: [
    "--no-sandbox",
    "--use-angle=swiftshader", // software WebGL so CI runners render too
    "--enable-unsafe-swiftshader",
    "--hide-scrollbars",
  ],
});

let failures = 0;

async function checkPage(label, url, expectStatusContains) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  const problems = [];
  page.on("console", (msg) => {
    if (msg.type() === "error" || msg.type() === "warning") {
      problems.push(`console.${msg.type()}: ${msg.text()}`);
    }
  });
  page.on("pageerror", (err) => problems.push(`pageerror: ${err.message}`));
  page.on("requestfailed", (req) =>
    problems.push(`requestfailed: ${req.url()} (${req.failure()?.errorText})`),
  );

  await page.goto(url, { waitUntil: "networkidle0", timeout: 30000 });
  // let a few frames render (view rotation, marquee, texture upload)
  await new Promise((r) => setTimeout(r, 1500));

  const status = await page.$eval("#status", (el) => el.textContent ?? "");
  const errBox = await page.$eval("#err", (el) => el.textContent ?? "");
  if (!status.includes(expectStatusContains)) {
    problems.push(`status "${status}" does not contain "${expectStatusContains}"`);
  }
  if (errBox.trim() !== "") problems.push(`error banner shown: ${errBox}`);

  if (values.shots) {
    await page.screenshot({ path: join(values.shots, `${label}.png`) });
  }

  if (problems.length > 0) {
    failures++;
    console.error(`FAIL ${label}`);
    for (const p of problems) console.error(`  ${p}`);
  } else {
    console.log(`ok   ${label} — ${status}`);
  }
  await page.close();
}

const base = `http://127.0.0.1:${port}/harness/index.html`;
await checkPage("webgl2", base, "webgl2");
await checkPage("canvas2d", `${base}?canvas2d=1`, "canvas2d");

await browser.close();
server.close();
process.exit(failures > 0 ? 1 : 0);

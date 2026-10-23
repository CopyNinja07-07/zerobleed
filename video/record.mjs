// Records the demo video: real ZeroBleed runs in the live dashboard, between
// title cards. Headless Chrome, 1920x1080, no sound (voiceover is added later
// from video/VOICEOVER.md). Each scene is its own clip; the clips are joined
// into video/zerobleed-demo.mp4 and the scene timings saved for the script.
//
// Needs: npm start running (API, dashboard, data silos), Zetaris and Nightshift up.
// Usage: node video/record.mjs
import { chromium } from "playwright-core";
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import ffmpegPath from "ffmpeg-static";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const DASH = "http://localhost:3030";
const CARDS = `file://${path.resolve("video/cards.html")}`;
const OUT = path.resolve("video/clips");
const size = { width: 1920, height: 1080 };
// Recorded at 1080p with the page zoomed to 125%, so dashboard text is readable.
const viewport = size;
// ONLY=title,close re-records just those scenes and re-joins the existing clips.
const ONLY = process.env.ONLY ? process.env.ONLY.split(",") : null;
if (!ONLY) rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
// The first recording context sometimes starts with a mis-sized frame; warm one up first.
{
  const warm = await browser.newContext({ viewport: size, recordVideo: { dir: path.join(OUT, "warmup"), size } });
  const p = await warm.newPage();
  await p.waitForTimeout(500);
  await warm.close();
  rmSync(path.join(OUT, "warmup"), { recursive: true, force: true });
}
const timings = [];
let n = 0;

const ORDER = ["title", "problem", "how", "live1-intro", "live1-run", "live2-intro", "live2-run", "results", "close"];
async function clip(name, fn) {
  n = ORDER.indexOf(name);
  if (ONLY && !ONLY.includes(name)) return;
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, colorScheme: "dark", recordVideo: { dir: OUT, size } });
  const page = await ctx.newPage();
  await page.addInitScript(() => document.addEventListener("DOMContentLoaded", () => (document.documentElement.style.zoom = "1.25")));
  await page.setContent('<body style="margin:0;background:#08070d"></body>'); // no white flash
  const t0 = Date.now();
  await fn(page);
  const seconds = (Date.now() - t0) / 1000;
  await ctx.close();
  const file = (await page.video().path());
  const target = path.join(OUT, `${String(n + 1).padStart(2, "0")}-${name}.webm`);
  renameSync(file, target);
  timings.push({ scene: name, seconds: +seconds.toFixed(1) });
  console.log(`recorded ${name} (${seconds.toFixed(1)}s)`);
}

const card = (scene, ms) => async (page) => {
  await page.goto(`${CARDS}?scene=${scene}`);
  await page.waitForTimeout(ms);
};

// Smooth scroll so a viewer can follow.
async function glide(page, y, ms = 2500) {
  await page.evaluate(([y, ms]) => new Promise((done) => {
    const start = window.scrollY, t0 = performance.now();
    const step = (t) => {
      const k = Math.min(1, (t - t0) / ms);
      window.scrollTo(0, start + (y - start) * (k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2));
      k < 1 ? requestAnimationFrame(step) : done();
    };
    requestAnimationFrame(step);
  }), [y, ms]);
}

async function liveRun(page, id, compare) {
  await page.goto(`${DASH}/?run=${id}&compare=${compare ? 1 : 0}`);
  // Wait for the real run to finish: the decision card replaces "Working...".
  await page.waitForSelector("#decision .decision", { timeout: 300_000 });
  if (compare) await page.waitForFunction(() => document.getElementById("bars").innerText.includes("Normal agent"), null, { timeout: 300_000 });
  await page.waitForTimeout(3000);
  const y = (sel) => page.evaluate((s) => (document.querySelector(s).getBoundingClientRect().top + window.scrollY - 20) * 1.25, sel);
  await glide(page, await y("#chunks"), 3000);
  await page.waitForTimeout(5000);
  await glide(page, await y("#calls"), 3000);
  await page.waitForTimeout(6000);
  await glide(page, 0, 2500);
  await page.waitForTimeout(2500);
}

await clip("title", card("title", 6000));
await clip("problem", card("problem", 9000));
await clip("how", card("how", 9000));
await clip("live1-intro", card("live1", 5000));
await clip("live1-run", (page) => liveRun(page, "SHP-1017", false));
await clip("live2-intro", card("live2", 6000));
await clip("live2-run", (page) => liveRun(page, "ALR-2004", true));
await clip("results", card("results", 10000));
await clip("close", card("close", 5000));
await browser.close();

// Join the clips into one MP4.
const list = readdirSync(OUT).filter((f) => f.endsWith(".webm")).sort();
writeFileSync(path.join(OUT, "list.txt"), list.map((f) => `file '${path.join(OUT, f)}'`).join("\n"));
execFileSync(ffmpegPath, ["-y", "-f", "concat", "-safe", "0", "-i", path.join(OUT, "list.txt"), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", "30", "-crf", "20", "-preset", "medium", path.resolve("video/zerobleed-demo.mp4")], { stdio: "inherit" });
if (!ONLY) writeFileSync(path.resolve("video/timings.json"), JSON.stringify(timings, null, 2));
console.log("wrote video/zerobleed-demo.mp4", timings);

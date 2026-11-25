// Screenshots of the landing page and dashboard (desktop + mobile). Usage: node scripts/shots.mjs [base] [outDir]
import { chromium } from "playwright-core";
const [base = "http://localhost:4180/", out = "shots"] = process.argv.slice(2);
const b = await chromium.launch({ channel: "msedge", headless: true });
for (const [name, w, h] of [["desk", 1440, 900], ["mob", 390, 844]]) {
  const p = await b.newPage({ viewport: { width: w, height: h } });
  const errs = [];
  p.on("console", (m) => m.type() === "error" && errs.push(m.text()));
  p.on("pageerror", (e) => errs.push(e.message));
  await p.goto(base, { waitUntil: "networkidle" });
  await p.waitForTimeout(3500);
  await p.screenshot({ path: `${out}/landing-${name}.png`, fullPage: true });
  await p.goto(base + "#/app", { waitUntil: "networkidle" });
  await p.waitForTimeout(2500);
  await p.screenshot({ path: `${out}/app-${name}.png`, fullPage: true });
  const overflow = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  console.log(name, "overflow", overflow, "errors", errs.slice(0, 5));
  await p.close();
}
await b.close();

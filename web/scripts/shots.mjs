// Screenshots of the landing page and dashboard. Usage: node scripts/shots.mjs [base] [outDir]
import { chromium } from "playwright-core";
const [base = "http://localhost:4181/", out = "shots"] = process.argv.slice(2);
const b = await chromium.launch({ channel: "msedge", headless: true });
for (const [name, w, h] of [["desk", 1440, 900], ["mob", 390, 844]]) {
  const p = await b.newPage({ viewport: { width: w, height: h } });
  const errs = [];
  p.on("console", (m) => m.type() === "error" && errs.push(m.text()));
  p.on("pageerror", (e) => errs.push(e.message));
  await p.goto(base, { waitUntil: "networkidle" });
  await p.waitForTimeout(3500);
  await p.screenshot({ path: `${out}/hero-${name}.png` });
  // Scroll through once so scroll-revealed content is visible in the full-page capture.
  const H = await p.evaluate(() => document.documentElement.scrollHeight);
  for (let y = 0; y < H; y += 500) { await p.evaluate((y) => scrollTo(0, y), y); await p.waitForTimeout(140); }
  await p.evaluate(() => scrollTo(0, 0));
  await p.waitForTimeout(600);
  await p.screenshot({ path: `${out}/landing-${name}.png`, fullPage: true });
  await p.goto(base + "#/app", { waitUntil: "networkidle" });
  await p.waitForTimeout(4000);
  await p.screenshot({ path: `${out}/app-${name}.png`, fullPage: true });
  const overflow = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  console.log(name, "overflow", overflow, "errors", errs.slice(0, 6));
  await p.close();
}
await b.close();

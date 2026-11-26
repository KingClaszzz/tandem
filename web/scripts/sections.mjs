// Viewport-sized captures of key sections. Usage: node scripts/sections.mjs [base] [outDir]
import { chromium } from "playwright-core";
const [base = "http://localhost:4181/", out = "shots"] = process.argv.slice(2);
const b = await chromium.launch({ channel: "msedge", headless: true });
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.goto(base, { waitUntil: "networkidle" });
await p.addStyleTag({ content: "html{scroll-behavior:auto!important}" });
await p.waitForTimeout(2500);
await p.screenshot({ path: `${out}/s-hero.png` });
for (const id of ["loop", "proof", "contracts", "safety"]) {
  await p.evaluate((id) => document.getElementById(id).scrollIntoView(), id);
  await p.waitForTimeout(1600);
  await p.screenshot({ path: `${out}/s-${id}.png` });
}
await p.evaluate(() => document.getElementById("proof").scrollIntoView());
await p.evaluate(() => scrollBy(0, 640));
await p.waitForTimeout(1200);
await p.screenshot({ path: `${out}/s-proof2.png` });
await p.goto(base + "#/app", { waitUntil: "networkidle" });
await p.waitForTimeout(4500);
await p.screenshot({ path: `${out}/s-app-top.png` });
await p.evaluate(() => scrollTo(0, 700));
await p.waitForTimeout(800);
await p.screenshot({ path: `${out}/s-app-mid.png` });
await b.close();

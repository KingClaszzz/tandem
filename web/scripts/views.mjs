// Screenshots every console view on desktop and mobile. Usage: node scripts/views.mjs [base] [outDir]
import { chromium } from "playwright-core";
const [base = "http://localhost:4181/", out = "shots"] = process.argv.slice(2);
const views = ["", "borrow", "positions", "risk", "latency", "activity", "system"];
const b = await chromium.launch({ channel: "msedge", headless: true });
for (const [name, w, h] of [["desk", 1440, 900], ["mob", 390, 844]]) {
  const p = await b.newPage({ viewport: { width: w, height: h } });
  const errs = [];
  p.on("console", (m) => m.type() === "error" && errs.push(m.text().slice(0, 140)));
  p.on("pageerror", (e) => errs.push(e.message.slice(0, 140)));
  for (const v of views) {
    await p.goto(`${base}#/app${v ? "/" + v : ""}`, { waitUntil: "networkidle" });
    await p.waitForTimeout(v === "activity" || v === "" ? 6500 : 4000);
    await p.screenshot({ path: `${out}/v-${v || "overview"}-${name}.png`, fullPage: true });
    const overflow = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    if (overflow > 0) console.log(name, v || "overview", "horizontal overflow", overflow);
  }
  console.log(name, "errors:", errs.length ? errs.slice(0, 4) : "none");
  await p.close();
}
await b.close();

import { chromium } from "playwright-core";
const base = process.argv[2] ?? "http://localhost:4181/";
const b = await chromium.launch({ channel: "msedge", headless: true });
for (const [w, h] of [[1280, 800], [390, 800]]) {
  const ctx = await b.newContext({ viewport: { width: w, height: h } });
  const p = await ctx.newPage();
  for (const [name, hash] of [["gate", "#/app"], ["guide", "#/guide"]]) {
    await p.goto(base + hash, { waitUntil: "networkidle" });
    await p.waitForTimeout(600);
    const over = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    await p.screenshot({ path: `../docs/img/${name}-${w}.png` });
    console.log(name, w, "overflow", over);
  }
  // tour with a connected stub wallet
  await ctx.addInitScript(() => { window.ethereum = { request: async ({ method }) => (method === "eth_accounts" || method === "eth_requestAccounts" ? ["0x1111111111111111111111111111111111111111"] : method === "eth_chainId" ? "0x14a34" : null), on() {}, removeListener() {} }; });
  const q = await ctx.newPage();
  await q.goto(base + "#/app", { waitUntil: "networkidle" });
  await q.locator(".tour-card").waitFor({ timeout: 15000 });
  await q.screenshot({ path: `../docs/img/tour-${w}.png` });
  console.log("tour shown", w, "overflow", await q.evaluate(() => document.documentElement.scrollWidth - innerWidth));
  await ctx.close();
}
await b.close();

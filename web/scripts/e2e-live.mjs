// End-to-end test of the dashboard against the live testnets. A fake browser wallet signs with the
// testnet key from ../../.env (read locally, never logged). Runs: connect -> borrow -> crash -> reset.
// Usage: node scripts/e2e-live.mjs [base-url] [out-dir]
import { chromium } from "playwright-core";
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, parseGwei } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia, unichainSepolia } from "viem/chains";

const [base = "http://localhost:4181/", out = "shots"] = process.argv.slice(2);
const env = Object.fromEntries(
  readFileSync(new URL("../../.env", import.meta.url), "utf8").split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
);
const pk = env.PRIVATE_KEY.startsWith("0x") ? env.PRIVATE_KEY : `0x${env.PRIVATE_KEY}`;
const account = privateKeyToAccount(pk);
const lasna = { id: 5318007, name: "Reactive Lasna", nativeCurrency: { name: "lREACT", symbol: "lREACT", decimals: 18 }, rpcUrls: { default: { http: ["https://lasna-rpc.rnk.dev/"] } } };
const chains = { 84532: baseSepolia, 1301: unichainSepolia, 5318007: lasna };
const pub = Object.fromEntries(Object.entries(chains).map(([id, c]) => [id, createPublicClient({ chain: c, transport: http() })]));
const wal = Object.fromEntries(Object.entries(chains).map(([id, c]) => [id, createWalletClient({ account, chain: c, transport: http() })]));

let current = 84532, connected = false;
const sent = [];
async function rpc(method, params = []) {
  switch (method) {
    case "eth_accounts": return connected ? [account.address] : [];
    case "eth_requestAccounts": connected = true; return [account.address];
    case "eth_chainId": return "0x" + current.toString(16);
    case "wallet_switchEthereumChain": {
      const id = parseInt(params[0].chainId, 16);
      if (!chains[id]) throw Object.assign(new Error("unknown chain"), { code: 4902 });
      current = id;
      return null;
    }
    case "wallet_addEthereumChain": current = parseInt(params[0].chainId, 16); return null;
    case "eth_sendTransaction": {
      const t = params[0];
      const hash = await wal[current].sendTransaction({
        to: t.to, data: t.data, value: t.value ? BigInt(t.value) : undefined,
        ...(current === 5318007 ? { maxPriorityFeePerGas: parseGwei("1") } : {}),
      });
      sent.push({ chain: current, hash });
      return hash;
    }
    default: return pub[current].request({ method, params });
  }
}

const browser = await chromium.launch({ channel: "msedge", headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.exposeFunction("__rpc", rpc);
await ctx.addInitScript(() => {
  window.ethereum = { request: ({ method, params }) => window.__rpc(method, params ?? []), on() {}, removeListener() {} };
});
const page = await ctx.newPage();
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 200)));
page.on("pageerror", (e) => errors.push(e.message.slice(0, 200)));
const step = (s) => console.log("•", s);
const go = (v) => page.evaluate((v) => { location.hash = `#/app/${v}`; }, v);

try {
  await page.goto(base + "#/app", { waitUntil: "networkidle" });
  await page.addStyleTag({ content: "html{scroll-behavior:auto!important}" });
  step("connect");
  await page.getByRole("button", { name: "Connect wallet" }).first().click();
  await page.locator(".nav-end .chip.live").waitFor({ timeout: 20000 });
  await go("borrow");
  await page.locator(".b-wallet").waitFor({ timeout: 30000 });
  await page.waitForTimeout(2500);

  step("borrow 0.05 tWETH at 60% LTV");
  const t0 = Date.now();
  await page.getByRole("button", { name: /Lock collateral and borrow/ }).click();
  await page.locator(".trace .node.done", { hasText: "disburse()" }).waitFor({ timeout: 120000 });
  console.log(`  borrow loop done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  await page.waitForTimeout(3500);
  await page.screenshot({ path: `${out}/e2e-1-borrowed.png`, fullPage: true });
  await go("positions");
  await page.locator(".tbl tbody tr").first().waitFor({ timeout: 20000 });
  console.log("  newest row:", (await page.locator(".tbl tbody tr").first().textContent()).replace(/\s+/g, " ").slice(0, 130));
  await page.screenshot({ path: `${out}/e2e-positions.png`, fullPage: true });
  await go("risk");
  await page.locator(".rt em").first().waitFor({ timeout: 20000 });
  console.log("  ruler tick:", await page.locator(".rt em").first().textContent());

  step("move the target to $2,200");
  await page.locator(".ruler-input").evaluate((el) => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    set.call(el, "2200");
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.waitForTimeout(500);
  console.log("  preview:", (await page.locator(".preview p").textContent()).slice(0, 150));
  await page.locator(".ruler-panel").screenshot({ path: `${out}/e2e-2-ruler.png` });

  step("post the price");
  const t1 = Date.now();
  await page.getByRole("button", { name: /^Post \$2,200/ }).click();
  await page.locator(".trace .node.done", { hasText: "seize()" }).waitFor({ timeout: 150000 });
  console.log(`  liquidation loop done in ${((Date.now() - t1) / 1000).toFixed(1)}s`);
  await page.waitForTimeout(3500);
  await page.screenshot({ path: `${out}/e2e-3-liquidated.png`, fullPage: true });
  await go("positions");
  await page.waitForTimeout(3500);
  // The default filter shows open loans only, and this one is now closed.
  await page.getByRole("button", { name: "all", exact: true }).click();
  await page.locator(".tbl tbody tr").first().waitFor({ timeout: 20000 });
  console.log("  newest row:", (await page.locator(".tbl tbody tr").first().textContent()).replace(/\s+/g, " ").slice(0, 130));
  await go("latency");
  await page.waitForTimeout(800);
  console.log("  your runs:", (await page.locator(".mine-sum").textContent().catch(() => "none saved yet")).replace(/\s+/g, " "));
  await page.screenshot({ path: `${out}/e2e-latency.png`, fullPage: true });
  await go("risk");

  step("reset the price to $3,000");
  await page.getByRole("button", { name: "Reset to $3,000" }).click();
  // The feed accepts one update per 30 s, so the button first counts down.
  await page.getByRole("button", { name: /^Post \$3,000/ }).click({ timeout: 90000 });
  await page.locator(".price-now", { hasText: "$3,000.00" }).waitFor({ timeout: 120000 });
  console.log("  price now:", (await page.locator(".price-now").textContent()).trim());
} catch (e) {
  console.log("FAILED:", e.message.split("\n")[0]);
  await page.screenshot({ path: `${out}/e2e-fail.png`, fullPage: true }).catch(() => {});
}
console.log("transactions sent from the UI:", sent.length);
console.log("console errors:", errors.length ? errors : "none");
await browser.close();

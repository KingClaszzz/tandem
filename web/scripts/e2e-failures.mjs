// Black-box failure tests for the console. A scripted browser wallet misbehaves in the ways real wallets do
// (no wallet, user rejects, wrong chain, hangs, hostile error text) and the network is cut. No transaction is
// ever sent: the fake wallet only answers or refuses. Usage: node scripts/e2e-failures.mjs [base-url]
import { chromium } from "playwright-core";
import { readFileSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";

const base = process.argv[2] ?? "http://localhost:4181/";
const env = Object.fromEntries(readFileSync(new URL("../../.env", import.meta.url), "utf8").split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]));
const addr = privateKeyToAccount(env.PRIVATE_KEY.startsWith("0x") ? env.PRIVATE_KEY : `0x${env.PRIVATE_KEY}`).address;
const rejected = () => Object.assign(new Error("User rejected the request."), { code: 4001 });

const browser = await chromium.launch({ channel: "msedge", headless: true });
const results = [];

async function scenario(name, { wallet = "normal", methods = {}, run }) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const calls = [];
  let chain = 84532;
  await ctx.exposeFunction("__rpc", async (method, params) => {
    calls.push(method);
    if (methods[method]) return methods[method](params, { chain: () => chain, setChain: (c) => (chain = c) });
    switch (method) {
      case "eth_accounts": return [];
      case "eth_requestAccounts": return [addr];
      case "eth_chainId": return "0x" + chain.toString(16);
      case "wallet_switchEthereumChain": chain = parseInt(params[0].chainId, 16); return null;
      default: throw Object.assign(new Error(`unsupported ${method}`), { code: -32601 });
    }
  });
  await ctx.addInitScript(() => { try { localStorage.setItem("tandem:tour-seen", "1"); } catch {} });
  if (wallet !== "none") {
    await ctx.addInitScript(() => {
      window.ethereum = {
        // Playwright drops error codes across the bridge; rebuild the one real wallets attach to a rejection.
        request: async ({ method, params }) => {
          try { return await window.__rpc(method, params ?? []); } catch (e) {
            const err = new Error(String(e.message).replace(/^Error: /, ""));
            if (/User rejected/i.test(err.message)) err.code = 4001;
            const c = /\[code:(-?\d+)\]/.exec(err.message);
            if (c) err.code = Number(c[1]);
            throw err;
          }
        },
        on() {}, removeListener() {},
      };
    });
  }
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message.slice(0, 160)));
  page.on("console", (m) => m.type() === "error" && /Content Security Policy|Refused to/i.test(m.text()) && errors.push("CSP: " + m.text().slice(0, 140)));
  let verdict = "pass", detail = "";
  try {
    await page.goto(base + "#/app", { waitUntil: "networkidle" });
    await page.addStyleTag({ content: "html{scroll-behavior:auto!important}" });
    await page.locator(".side-foot b, .gate h1").first().waitFor({ timeout: 20000 });
    detail = (await run(page, calls)) ?? "";
    if (errors.length) { verdict = "FAIL"; detail += ` | uncaught page errors: ${errors.join("; ")}`; }
  } catch (e) {
    verdict = "FAIL";
    detail = e.message.split("\n")[0];
  }
  results.push([name, verdict, detail]);
  console.log(`${verdict === "pass" ? "✔" : "✘"} ${name}${detail ? "  →  " + detail : ""}`);
  await ctx.close();
}

const banner = (page) => page.locator(".banner[role=alert]");
const go = (page, view) => page.evaluate((v) => { location.hash = `#/app/${v}`; }, view);
const connect = async (page, view = "borrow") => {
  await page.getByRole("button", { name: "Connect wallet" }).first().click();
  await page.locator(".nav-end .chip.live").waitFor({ timeout: 15000 });
  await go(page, view);
  await page.locator(".b-wallet").waitFor({ timeout: 30000 });
  await page.waitForTimeout(1500);
};

await scenario("no wallet installed: the console stays closed and offers a way forward", {
  wallet: "none",
  run: async (page) => {
    await page.locator(".gate h1").waitFor({ timeout: 10000 });
    if (await page.locator(".side").count()) throw new Error("dashboard visible without a wallet");
    await page.getByRole("link", { name: "Get a wallet" }).waitFor({ timeout: 5000 });
    await page.getByRole("link", { name: "Back to home" }).click();
    await page.locator(".hero").waitFor({ timeout: 10000 });
    return "gate shown, home reachable";
  },
});

await scenario("user rejects the connection request", {
  methods: { eth_requestAccounts: () => { throw rejected(); } },
  run: async (page) => {
    await page.getByRole("button", { name: "Connect wallet" }).first().click();
    const t = await banner(page).textContent();
    if (!/rejected/i.test(t)) throw new Error(`unexpected message: ${t}`);
    if (await page.locator(".nav-end .chip.live").count()) throw new Error("shows connected after a rejection");
    return t;
  },
});

await scenario("user rejects the borrow transaction: UI recovers, nothing half-done", {
  methods: { eth_sendTransaction: () => { throw rejected(); } },
  run: async (page, calls) => {
    await connect(page);
    const btn = page.getByRole("button", { name: /Lock collateral and borrow|Approving|Locking/ });
    await btn.click();
    await banner(page).waitFor({ timeout: 20000 });
    const t = await banner(page).textContent();
    if (!/rejected/i.test(t)) throw new Error(`unexpected message: ${t}`);
    await page.getByRole("button", { name: /Lock collateral and borrow/ }).waitFor();
    if (await page.getByRole("button", { name: /Lock collateral and borrow/ }).isDisabled()) throw new Error("button stuck disabled after rejection");
    if (await page.locator(".trace .node.wait").count()) throw new Error("trace left waiting after a rejected tx");
    return `${t} (wallet saw ${calls.filter((c) => c === "eth_sendTransaction").length} send request)`;
  },
});

await scenario("wallet refuses to switch network: no transaction is attempted", {
  methods: { wallet_switchEthereumChain: () => { throw rejected(); }, eth_chainId: () => "0x1" },
  run: async (page, calls) => {
    await connect(page);
    await page.getByRole("button", { name: /Lock collateral and borrow/ }).click();
    await banner(page).waitFor({ timeout: 20000 });
    const sent = calls.filter((c) => c === "eth_sendTransaction").length;
    if (sent) throw new Error(`${sent} transaction(s) sent while on the wrong chain`);
    return await banner(page).textContent();
  },
});

await scenario("wallet stays on the wrong chain after a 'successful' switch: no transaction", {
  methods: { wallet_switchEthereumChain: () => null, eth_chainId: () => "0x1" },
  run: async (page, calls) => {
    await connect(page);
    await page.getByRole("button", { name: /Lock collateral and borrow/ }).click();
    await page.waitForTimeout(4000);
    const sent = calls.filter((c) => c === "eth_sendTransaction").length;
    if (sent) throw new Error(`${sent} transaction(s) sent while the wallet reported chain 0x1`);
    return (await banner(page).count()) ? await banner(page).textContent() : "no banner shown";
  },
});

await scenario("double click, triple click and Enter spam while a transaction is pending: one request", {
  methods: { eth_sendTransaction: async () => { await new Promise((r) => setTimeout(r, 2500)); throw rejected(); } },
  run: async (page, calls) => {
    await connect(page);
    await page.locator("form.borrow-grid button.b-go:enabled").waitFor({ timeout: 20000 });
    // Fire everything inside one task, before the wallet answers: the worst case a fast user or a bug can produce.
    await page.evaluate(() => {
      const b = document.querySelector("form.borrow-grid button.b-go");
      b.click(); b.click(); b.click();
      const i = document.querySelector("input[aria-label='Collateral in tWETH']");
      for (let k = 0; k < 3; k++) i.form.requestSubmit();
    });
    await banner(page).waitFor({ timeout: 20000 });
    await page.waitForTimeout(1500);
    const sent = calls.filter((c) => c === "eth_sendTransaction").length;
    if (sent !== 1) throw new Error(`wallet received ${sent} send requests`);
    return "wallet received exactly 1 request";
  },
});

await scenario("a wallet's internal error is shown once and never retried automatically", {
  methods: { eth_sendTransaction: () => { throw new Error("Internal JSON-RPC error [code:-32603]"); } },
  run: async (page, calls) => {
    await connect(page);
    await page.getByRole("button", { name: /Lock collateral and borrow/ }).click();
    await banner(page).waitFor({ timeout: 20000 });
    await page.waitForTimeout(2500);
    const sent = calls.filter((c) => c === "eth_sendTransaction").length;
    if (sent !== 1) throw new Error(`wallet received ${sent} send requests (the transport retried)`);
    return "1 request, then the error is shown";
  },
});

await scenario("disconnect returns to the home page, the console stays closed, connecting again works", {
  methods: { eth_accounts: () => [addr] },
  run: async (page, calls) => {
    // This wallet already authorised the site, so the app connects by itself on load.
    await page.locator(".wm-btn").waitFor({ timeout: 15000 });
    await page.locator(".wm-btn").click();
    await page.getByRole("menuitem", { name: "Disconnect" }).click();
    await page.locator(".hero").waitFor({ timeout: 10000 });
    if (await page.locator(".side").count()) throw new Error("dashboard still visible after Disconnect");
    await page.evaluate(() => { location.hash = "#/app"; });
    await page.locator(".gate h1").waitFor({ timeout: 10000 });
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(2500);
    if (await page.locator(".side").count()) throw new Error("the wallet reconnected on its own after a reload");
    await page.getByRole("button", { name: "Connect wallet" }).first().click();
    await page.locator(".wm-btn").waitFor({ timeout: 10000 });
    return "left the console, gate after reload, connects again on request";
  },
});

await scenario("switch account: asks the wallet, takes the new account, and says so when nothing changed", {
  methods: {
    eth_accounts: () => [addr],
    wallet_requestPermissions: () => { throw Object.assign(new Error("not supported"), { code: -32601 }); },
  },
  run: async (page) => {
    await page.locator(".wm-btn").waitFor({ timeout: 15000 });
    await page.locator(".wm-btn").click();
    await page.getByRole("menuitem", { name: "Switch account" }).click();
    await page.locator(".banner[role=status]", { hasText: "Same account" }).waitFor({ timeout: 8000 });
    return "fell back to a plain request, told the user the account is unchanged";
  },
});

await scenario("hostile error text from a wallet is shown as plain text and cannot run script", {
  methods: { eth_sendTransaction: () => { throw new Error("<img src=x onerror=\"window.__xss=1\"> execution reverted: " + "A".repeat(600)); } },
  run: async (page) => {
    await connect(page);
    await page.getByRole("button", { name: /Lock collateral and borrow/ }).click();
    await banner(page).waitFor({ timeout: 20000 });
    await page.waitForTimeout(500);
    if (await page.evaluate(() => window.__xss)) throw new Error("script from error text executed");
    if (await banner(page).locator("img").count()) throw new Error("error text was rendered as HTML");
    const len = (await banner(page).textContent()).length;
    if (len > 260) throw new Error(`error text not truncated (${len} chars)`);
    return `rendered as text, ${len} chars`;
  },
});

await scenario("an RPC outage shows an error and the console recovers by itself", {
  run: async (page) => {
    await connect(page);
    await page.route("**://sepolia.base.org/**", (r) => r.abort());
    await page.waitForTimeout(6500);
    const during = (await banner(page).count()) ? (await banner(page).textContent()).slice(0, 90) : "";
    if (!during) throw new Error("no error shown while the Base RPC was unreachable");
    await page.unroute("**://sepolia.base.org/**");
    await banner(page).waitFor({ state: "detached", timeout: 25000 });
    return `showed "${during}…" then cleared`;
  },
});

await scenario("a polluted collateral field cannot produce an invalid transaction", {
  run: async (page) => {
    await connect(page);
    const input = page.locator("input[aria-label='Collateral in tWETH']");
    for (const v of ["1e9999", "-5", "0.0000000000000000001", "abc", "0", ".", "99999999999999999999"]) {
      await input.fill(v);
      const enabled = await page.getByRole("button", { name: /Lock collateral and borrow/ }).isEnabled();
      const shown = await input.inputValue();
      if (enabled && !/^\d*\.?\d+$/.test(shown)) throw new Error(`button enabled for "${v}" (field shows "${shown}")`);
      if (enabled && Number(shown) > 5) throw new Error(`button enabled for an amount above the balance: "${shown}"`);
    }
    return "button stays disabled for junk, zero and over-balance input";
  },
});

await browser.close();
const bad = results.filter((r) => r[1] !== "pass");
console.log(`\n${results.length - bad.length}/${results.length} scenarios passed`);
process.exit(bad.length ? 1 : 0);

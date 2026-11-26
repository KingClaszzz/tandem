// Builds src/snippets.json from the real contract sources and compiled ABIs, so the code shown on the landing
// page can never drift from what is deployed. Run `npm run snippets` in web/ after changing a contract.
import { readFileSync, writeFileSync } from "node:fs";
import { Interface } from "ethers";

const root = new URL("../../", import.meta.url);
const read = (p) => readFileSync(new URL(p, root), "utf8");

/** Returns the source of `fn` with its doc comment, found by name and cut at the matching closing brace. */
function extract(src, fn) {
  const lines = src.split("\n");
  const start = lines.findIndex((l) => new RegExp(`^\\s*function\\s+${fn}\\b`).test(l));
  if (start < 0) throw new Error(`function ${fn} not found`);
  let depth = 0, end = start, opened = false;
  for (let i = start; i < lines.length; i++) {
    for (const ch of lines[i]) { if (ch === "{") { depth++; opened = true; } else if (ch === "}") depth--; }
    if (opened && depth === 0) { end = i; break; }
  }
  let from = start;
  while (from > 0 && /^\s*(\/\/\/|\/\/)/.test(lines[from - 1])) from--;
  return { text: lines.slice(from, end + 1).map((l) => l.replace(/^ {4}/, "")).join("\n"), start: from + 1, end: end + 1 };
}

const files = {
  TandemReactive: "contracts/TandemReactive.sol",
  CollateralVault: "contracts/CollateralVault.sol",
  LendingPool: "contracts/LendingPool.sol",
  PriceFeed: "contracts/PriceFeed.sol",
};
const src = Object.fromEntries(Object.entries(files).map(([k, p]) => [k, read(p)]));

// What each snippet is, and what to point out. `at` is a regular expression for the line the note belongs to.
const SNIPPETS = [
  {
    id: "subscribe", tab: "Subscribe", contract: "TandemReactive", title: "Listen to eight events on two chains",
    lead: "The reactive contract is wired once. After that, a matching log on any of the three contracts calls react().",
    parts: [["configure"], ["_sub"]],
    notes: [
      ["if \\(feed != address\\(0\\)\\)", "One-time wiring. The owner can call this once and has no other power over the system."],
      ["_sub\\(collateralChainId, feed_", "Subscribes to the price feed's AnswerUpdated on Base."],
      ["_sub\\(debtChainId, pool_, LIQUIDATED\\)", "Each destination is confirmed by an event, so a loan is only final when the other chain says so."],
      ["SYSTEM\\.subscribe", "Reactive Omni's system contract. Subscribing from a function, not the constructor, works: the vault and pool need this contract's address first."],
    ],
  },
  {
    id: "react", tab: "React", contract: "TandemReactive", title: "One entry point for every event",
    lead: "Reactive calls react() with the log. The contract checks which chain and which contract it came from before doing anything.",
    parts: [["react"]],
    notes: [
      ["onlySystem", "Only Reactive's system contract can call this."],
      ["log\\.contractAddress == feed", "A look-alike contract emitting the same event is ignored: the chain id and the exact address are checked."],
      ["_onAnswer", "A new price. This is where unhealthy loans are found."],
      ["_onLocked", "A new loan. The size, the loan count and the LTV are checked here, at the price Reactive last saw."],
      ["LIQUIDATED", "The debt chain confirmed the liquidation. Only now is the seize requested."],
    ],
  },
  {
    id: "liquidate", tab: "Liquidate", contract: "TandemReactive", title: "Find unhealthy loans, ask Unichain to close them",
    lead: "On every price update the reactive contract walks its open loans and sends one callback per loan that crossed 80%.",
    parts: [["_onAnswer"], ["_callback"]],
    notes: [
      ["round <= lastRound", "Replayed or out-of-order rounds are ignored."],
      ["MAX_LIQ_PER_SWEEP", "At most 10 liquidations per update, so one reactive transaction stays under the 900k gas cap."],
      ["_startLiquidation", "Marks the loan Liquidating and requests liquidate() on Unichain."],
      ["requestCallbackV_1_0", "The callback. Unichain's proxy accepts it only from this contract, and the first argument is replaced with this contract's address."],
    ],
  },
  {
    id: "guard", tab: "Guard", contract: "CollateralVault", title: "Only Reactive can move the collateral",
    lead: "The vault holds the borrower's tWETH. It has no owner key that can seize it.",
    parts: [["seize"]],
    notes: [
      ["onlyServiceProvider", "The caller must be Base's callback proxy."],
      ["onlyCallbackSender\\(sender\\)", "The proxy reports which reactive contract sent it. Anyone else is rejected."],
      ["if \\(l\\.status != Status\\.Locked\\) return;", "Idempotent: a duplicate or late callback does nothing, so retries are safe."],
      ["_unlock\\(l\\.owner\\)", "Frees one of the borrower's three loan slots."],
      ["returned", "Whatever collateral is left after debt plus the 5% penalty goes back to the borrower."],
    ],
  },
  {
    id: "order", tab: "Order", contract: "LendingPool", title: "The debt chain closes first",
    lead: "Repay and liquidate both change the loan's state on Unichain, so exactly one of them can win.",
    parts: [["repay"], ["liquidate"]],
    notes: [
      ["revert NotActive", "After liquidate() lands, repay() on that loan reverts. A borrower can never repay and also lose the collateral."],
      ["l\\.status = Status\\.Repaid", "State is set before the transfer."],
      ["l\\.status = Status\\.Liquidated", "The seize on Base only follows after Reactive sees this event."],
    ],
  },
  {
    id: "poke", tab: "Poke", contract: "TandemReactive", title: "Anyone can unstick a loan",
    lead: "A callback can fail, for instance if a destination runs out of callback funds. No keeper is needed to recover.",
    parts: [["poke"]],
    notes: [
      ["RETRY_AFTER", "Only after a minute without an answer, so it cannot be used to spam."],
      ["_requestSeize", "Re-sends the pending step. The callbacks are idempotent, so a duplicate does nothing."],
      ["NothingToRetry", "Healthy and finished loans are left alone."],
    ],
  },
  {
    id: "feed", tab: "Feed", contract: "PriceFeed", title: "Spam costs the operator, so it is limited",
    lead: "Every price update makes the reactive contract run once, and the operator pays for each run.",
    parts: [["_post"]],
    notes: [
      ["MIN_INTERVAL", "One update per 30 seconds from anyone, which caps the spam at two reactions a minute."],
      ["NoChange", "An update that changes nothing would only cost a reaction."],
      ["MoveTooLarge", "No more than a 50% move per update."],
      ["emit AnswerUpdated", "The same event Chainlink's aggregators emit, so a real feed could replace this one."],
    ],
  },
];

const out = { code: [], abi: {} };
for (const s of SNIPPETS) {
  const pieces = s.parts.map(([fn]) => extract(src[s.contract], fn));
  const text = pieces.map((p) => p.text).join("\n\n");
  const lines = text.split("\n");
  const notes = [];
  for (const [re, note] of s.notes) {
    const i = lines.findIndex((l) => new RegExp(re).test(l));
    if (i >= 0) notes.push({ line: i, text: note });
  }
  out.code.push({
    id: s.id, tab: s.tab, title: s.title, lead: s.lead, contract: s.contract, file: files[s.contract],
    from: pieces[0].start, to: pieces[0].end, text, notes,
  });
}

// Interfaces, straight from the compiled ABIs.
for (const name of Object.keys(files)) {
  const abi = JSON.parse(read(`artifacts/contracts/${name}.sol/${name}.json`)).abi;
  const iface = new Interface(abi);
  const clean = (s) => s.replace(/^(function|event) /, "");
  out.abi[name] = {
    events: iface.fragments.filter((f) => f.type === "event").map((f) => clean(f.format("full"))),
    // State-changing functions only: the getters for constants and mappings are noise here.
    functions: iface.fragments.filter((f) => f.type === "function" && (f.stateMutability === "nonpayable" || f.stateMutability === "payable")).map((f) => clean(f.format("full"))),
  };
}

writeFileSync(new URL("web/src/snippets.json", root), JSON.stringify(out, null, 1) + "\n");
console.log(`snippets.json: ${out.code.length} snippets, ${out.code.reduce((a, c) => a + c.notes.length, 0)} annotated lines, ABIs for ${Object.keys(out.abi).length} contracts`);

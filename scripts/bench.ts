// Measures the liquidation loop on the live testnets, N times, and writes:
//   evidence/bench-*.json  every run with all tx hashes
//   web/src/bench.json     the summary the website shows
// Each run: borrow (60% LTV) -> crash to $2,200 -> wait for seize -> restore $3,000.
// Times are wall-clock ms from the origin receipt to the first sighting of each event (polling 250 ms).
// Usage: npx ts-node scripts/bench.ts [runs=15]
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ethers } from "ethers";
import { link } from "./lib";
import { compact } from "./publish";
import { POLL_MS, PX, c, d, ensureAllowance, ensureWeth, fmt, loanIdOf, marks, seen, send, setPrice } from "./loop";

const RUNS = Number(process.argv[2] ?? 15);
const COLL = ethers.parseEther("0.05");
const DEBT = 90_000_000n; // $90 on $150 of collateral = 60% LTV; at $2,200 it is 81.8%

async function main() {
  const me = await (c.vault.runner as ethers.Wallet).getAddress();
  console.log(`bench: ${RUNS} liquidation loops from ${me}`);
  await setPrice(PX(3000));
  await ensureAllowance(c.weth, me, d.vault.address, COLL);

  const runs = [];
  for (let i = 0; i < RUNS; i++) {
    await ensureWeth(me, COLL);
    let from = await marks();
    const lock = await send(c.vault.lock(COLL, DEBT));
    const id = loanIdOf(lock.receipt);
    const approved = await seen("lasna", c.rc, ["BorrowApproved"], id, from.lasna, lock.t);
    const disbursed = await seen("uni", c.pool, ["Disbursed"], id, from.uni, lock.t);

    from = await marks();
    const crash = (await setPrice(PX(2200)))!;
    const requested = await seen("lasna", c.rc, ["LiquidationRequested"], id, from.lasna, crash.t);
    const liquidated = await seen("uni", c.pool, ["Liquidated"], id, from.uni, crash.t);
    const seizeRequested = await seen("lasna", c.rc, ["SeizeRequested"], id, from.lasna, crash.t);
    const seized = await seen("base", c.vault, ["CollateralSeized"], id, from.base, crash.t);
    await setPrice(PX(3000));

    runs.push({ loanId: id.toString(), borrow: { lock: lock.hash, approved, disbursed }, liquidation: { price: crash.hash, requested, liquidated, seizeRequested, seized } });
    console.log(`#${String(i + 1).padStart(2)} loan ${id}  borrow ${fmt(disbursed.ms)}  liq: rc ${fmt(requested.ms)} uni ${fmt(liquidated.ms)} rc ${fmt(seizeRequested.ms)} base ${fmt(seized.ms)}`);
  }

  const q = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return Math.round(s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]); };
  const stat = (xs: number[]) => ({ p50: q(xs, 50), p95: q(xs, 95), max: Math.round(Math.max(...xs)) });
  const L = runs.map((r) => r.liquidation);
  const summary = {
    measuredAt: new Date().toISOString().slice(0, 10),
    runs: runs.length,
    method: `wall-clock from the origin tx receipt to the first sighting of each event, polling public RPCs every ${POLL_MS} ms`,
    hops: [
      { name: "Base price tx → Reactive react()", ...stat(L.map((l) => l.requested.ms)) },
      { name: "Reactive → Unichain liquidate()", ...stat(L.map((l) => l.liquidated.ms - l.requested.ms)) },
      { name: "Unichain → Reactive react()", ...stat(L.map((l) => l.seizeRequested.ms - l.liquidated.ms)) },
      { name: "Reactive → Base seize()", ...stat(L.map((l) => l.seized.ms - l.seizeRequested.ms)) },
    ],
    total: stat(L.map((l) => l.seized.ms)),
    crashToDebtClosed: stat(L.map((l) => l.liquidated.ms)),
    borrow: stat(runs.map((r) => r.borrow.disbursed.ms)),
  };

  mkdirSync(join(__dirname, "..", "evidence"), { recursive: true });
  const file = join(__dirname, "..", "evidence", `bench-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, JSON.stringify({ summary, deployments: d, runs }, null, 1));
  writeFileSync(join(__dirname, "..", "web", "src", "bench.json"), JSON.stringify(compact({ summary, runs } as any), null, 1) + "\n");
  console.log("\n" + JSON.stringify(summary, null, 2));
  console.log("\nevidence:", file);
  const r0 = runs[0].liquidation;
  console.log("example loop:", link("base", "tx", r0.price), link("uni", "tx", r0.liquidated.hash), link("base", "tx", r0.seized.hash));
}
main().catch((e) => { console.error(e.shortMessage ?? e.message ?? e); process.exit(1); });

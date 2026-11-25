// Measures the full liquidation loop on the live testnets, N times.
//   borrow: lock (Base) -> BorrowApproved (Lasna) -> Disbursed (Unichain)
//   crash:  setPrice (Base) -> LiquidationRequested (Lasna) -> Liquidated (Unichain) -> SeizeRequested (Lasna) -> CollateralSeized (Base)
// Times are wall-clock ms between the origin receipt and the moment each event is first seen, polling every 250 ms.
// Usage: npx ts-node scripts/bench.ts [runs=30]
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ethers } from "ethers";
import { ChainKey, artifact, link, loadDeployments, provider, wallet } from "./lib";

const RUNS = Number(process.argv[2] ?? 30);
const POLL_MS = 250;
const COLL = ethers.parseEther("0.05");
const BORROW = 90n * 10n ** 6n; // $90 on $150 of collateral at $3,000 = 60% LTV
const HIGH = 3000n * 10n ** 8n;
const CRASH = 2200n * 10n ** 8n; // 90 / 110 = 81.8% > 80%

const d = loadDeployments();
const at = (k: string, chain: ChainKey, name: string) => new ethers.Contract(d[k].address, artifact(name).abi, wallet(chain));
const feed = at("feed", "base", "PriceFeed");
const vault = at("vault", "base", "CollateralVault");
const weth = at("tWETH", "base", "TestToken");
const pool = at("pool", "uni", "LendingPool");
const rc = new ethers.Contract(d.reactive.address, artifact("TandemReactive").abi, provider("lasna"));

type Seen = { hash: string; ms: number };

/** Polls `contract` on its chain for `event` with loanId (topic1) from `fromBlock`, until seen. */
async function seen(chain: ChainKey, contract: ethers.Contract, event: string, loanId: bigint | null, fromBlock: number, t0: number): Promise<Seen> {
  const filter = loanId === null ? contract.filters[event]() : contract.filters[event](loanId);
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    try {
      const logs = await contract.queryFilter(filter, fromBlock);
      if (logs.length) return { hash: logs[0].transactionHash, ms: performance.now() - t0 };
    } catch { /* transient RPC error */ }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  throw new Error(`${event} for loan ${loanId} not seen on ${chain} within 3 minutes`);
}

const blocks = async () => {
  const [b, l, u] = await Promise.all([provider("base").getBlockNumber(), provider("lasna").getBlockNumber(), provider("uni").getBlockNumber()]);
  return { base: b - 20, lasna: l - 5, uni: u - 5 };
};

async function send(tx: Promise<ethers.ContractTransactionResponse>) {
  const r = await (await tx).wait();
  return { receipt: r!, t: performance.now() };
}

async function setPrice(p: bigint) {
  if ((await feed.price()) === p) return null;
  return send(feed.setPrice(p));
}

async function main() {
  const me = wallet("base").address;
  console.log(`bench: ${RUNS} runs, wallet ${me}`);
  await setPrice(HIGH);
  if ((await weth.allowance(me, d.vault.address)) < COLL * BigInt(RUNS)) await send(weth.approve(d.vault.address, ethers.MaxUint256));

  const runs: any[] = [];
  for (let i = 0; i < RUNS; i++) {
    if ((await weth.balanceOf(me)) < COLL) {
      const next = Number(await weth.lastDrip(me)) + 61 - Math.floor(Date.now() / 1000);
      if (next > 0) await new Promise((r) => setTimeout(r, next * 1000));
      await send(weth.faucet());
    }
    // borrow loop
    let from = await blocks();
    const lock = await send(vault.lock(COLL, BORROW));
    const loanId = BigInt(lock.receipt.logs.find((l) => l.address.toLowerCase() === d.vault.address.toLowerCase())!.topics[1]);
    const approved = await seen("lasna", rc, "BorrowApproved", loanId, from.lasna, lock.t);
    const disbursed = await seen("uni", pool, "Disbursed", loanId, from.uni, lock.t);

    // liquidation loop
    from = await blocks();
    const crash = (await setPrice(CRASH))!;
    const [req, liq] = await Promise.all([
      seen("lasna", rc, "LiquidationRequested", loanId, from.lasna, crash.t),
      seen("uni", pool, "Liquidated", loanId, from.uni, crash.t),
    ]);
    const [seizeReq, seized] = await Promise.all([
      seen("lasna", rc, "SeizeRequested", loanId, from.lasna, crash.t),
      seen("base", vault, "CollateralSeized", loanId, from.base, crash.t),
    ]);
    await setPrice(HIGH);

    const run = {
      loanId: loanId.toString(),
      borrow: { lock: lock.receipt.hash, approved, disbursed },
      liquidation: { price: crash.receipt.hash, requested: req, liquidated: liq, seizeRequested: seizeReq, seized },
    };
    runs.push(run);
    console.log(
      `#${String(i + 1).padStart(2)} loan ${loanId}  borrow ${(disbursed.ms / 1000).toFixed(2)}s  ` +
      `liq: rc ${(req.ms / 1000).toFixed(2)}s  uni ${(liq.ms / 1000).toFixed(2)}s  rc ${(seizeReq.ms / 1000).toFixed(2)}s  base ${(seized.ms / 1000).toFixed(2)}s`,
    );
  }

  const q = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return Math.round(s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]); };
  const stat = (xs: number[]) => ({ p50: q(xs, 50), p95: q(xs, 95), max: Math.round(Math.max(...xs)) });
  const L = runs.map((r) => r.liquidation);
  const hops = [
    { name: "Base price tx → Reactive react()", xs: L.map((l) => l.requested.ms) },
    { name: "Reactive → Unichain liquidate()", xs: L.map((l) => l.liquidated.ms - l.requested.ms) },
    { name: "Unichain → Reactive react()", xs: L.map((l) => l.seizeRequested.ms - l.liquidated.ms) },
    { name: "Reactive → Base seize()", xs: L.map((l) => l.seized.ms - l.seizeRequested.ms) },
  ];
  const summary = {
    measuredAt: new Date().toISOString().slice(0, 10),
    runs: runs.length,
    method: `wall-clock from origin receipt to first sighting of each event, polling every ${POLL_MS} ms on public RPCs`,
    hops: hops.map((h) => ({ name: h.name, ...stat(h.xs) })),
    total: stat(L.map((l) => l.seized.ms)),
    crashToDebtClosed: stat(L.map((l) => l.liquidated.ms)),
    borrow: stat(runs.map((r) => r.borrow.disbursed.ms)),
  };

  mkdirSync(join(__dirname, "..", "evidence"), { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  writeFileSync(join(__dirname, "..", "evidence", `bench-${stamp}.json`), JSON.stringify({ summary, deployments: d, runs }, null, 1));
  writeFileSync(join(__dirname, "..", "web", "src", "bench.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log("\n", JSON.stringify(summary, null, 2));
  const r0 = runs[0].liquidation;
  console.log("\nexample loop:", link("base", "tx", r0.price), link("uni", "tx", r0.liquidated.hash), link("base", "tx", r0.seized.hash));
}
main().catch((e) => { console.error(e); process.exit(1); });

// Runs every loop once on the live testnets and writes the tx hashes to evidence/smoke-*.json.
//   1. borrow  (lock -> BorrowApproved -> Disbursed)
//   2. repay   (repay -> ReleaseRequested -> CollateralReleased)
//   3. refused (lock over 70% LTV -> BorrowRefused -> CollateralReleased)
//   4. liquidation (price crash -> LiquidationRequested -> Liquidated -> SeizeRequested -> CollateralSeized)
// Usage: npx ts-node scripts/smoke.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ethers } from "ethers";
import { link } from "./lib";
import { PX, c, d, ensureAllowance, ensureWeth, fmt, loanIdOf, marks, seen, send, setPrice, type Seen } from "./loop";

const out: Record<string, unknown> = { at: new Date().toISOString(), deployments: d };
const line = (s: Seen) => `   ${fmt(s.ms).padStart(7)}  ${s.chain.padEnd(5)} ${s.event.padEnd(20)} ${link(s.chain, "tx", s.hash)}`;

async function borrow(me: string, coll: bigint, debt: bigint) {
  await ensureWeth(me, coll);
  await ensureAllowance(c.weth, me, d.vault.address, coll);
  const from = await marks();
  const lock = await send(c.vault.lock(coll, debt));
  const id = loanIdOf(lock.receipt);
  console.log(` lock #${id}  ${link("base", "tx", lock.hash)}`);
  const rc = await seen("lasna", c.rc, ["BorrowApproved", "BorrowRefused"], id, from.lasna, lock.t);
  console.log(line(rc));
  const dest = rc.event === "BorrowApproved"
    ? await seen("uni", c.pool, ["Disbursed", "BorrowRejected"], id, from.uni, lock.t)
    : await seen("base", c.vault, ["CollateralReleased"], id, from.base, lock.t);
  console.log(line(dest));
  return { id, lock: lock.hash, steps: [rc, dest] };
}

async function main() {
  const me = c.vault.runner ? await (c.vault.runner as ethers.Wallet).getAddress() : "";
  await setPrice(PX(3000));

  console.log("1) borrow 0.05 tWETH -> 90 tUSD (60% LTV)");
  const b = await borrow(me, ethers.parseEther("0.05"), 90_000_000n);
  out.borrow = b;

  console.log("2) repay");
  await ensureAllowance(c.usd, me, d.pool.address, 90_000_000n);
  let from = await marks();
  const repay = await send(c.pool.repay(b.id));
  console.log(` repay #${b.id}  ${link("uni", "tx", repay.hash)}`);
  const rel = [
    await seen("lasna", c.rc, ["ReleaseRequested"], b.id, from.lasna, repay.t),
    await seen("base", c.vault, ["CollateralReleased"], b.id, from.base, repay.t),
  ];
  rel.forEach((s) => console.log(line(s)));
  out.repay = { id: b.id, repay: repay.hash, steps: rel };

  console.log("3) borrow over 70% LTV (refused)");
  out.refused = await borrow(me, ethers.parseEther("0.05"), 110_000_000n);

  console.log("4) borrow, then crash the price to $2,200");
  const l = await borrow(me, ethers.parseEther("0.05"), 90_000_000n);
  from = await marks();
  const crash = (await setPrice(PX(2200)))!;
  console.log(` post $2,200  ${link("base", "tx", crash.hash)}`);
  const liq = [
    await seen("lasna", c.rc, ["LiquidationRequested"], l.id, from.lasna, crash.t),
    await seen("uni", c.pool, ["Liquidated"], l.id, from.uni, crash.t),
    await seen("lasna", c.rc, ["SeizeRequested"], l.id, from.lasna, crash.t),
    await seen("base", c.vault, ["CollateralSeized"], l.id, from.base, crash.t),
  ];
  liq.forEach((s) => console.log(line(s)));
  out.liquidation = { borrow: l, price: crash.hash, steps: liq };
  await setPrice(PX(3000));

  const final = await Promise.all([b.id, l.id].map(async (id) => [id.toString(), Number((await c.rc.loans(id)).status)]));
  out.rcFinalStatus = Object.fromEntries(final);
  console.log("RC final status (6 = Released, 7 = Seized):", out.rcFinalStatus);

  mkdirSync(join(__dirname, "..", "evidence"), { recursive: true });
  const file = join(__dirname, "..", "evidence", `smoke-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, JSON.stringify(out, (_, v) => (typeof v === "bigint" ? v.toString() : v), 1));
  console.log("evidence:", file);
}
main().catch((e) => { console.error(e.shortMessage ?? e.message ?? e); process.exit(1); });

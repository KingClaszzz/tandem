// Health check for the whole system. Read-only unless --poke is given.
//   - funding: RC lREACT and debt on Lasna, vault/pool ETH and debt at their callback proxies
//   - every loan: RC state vs vault (Base) vs pool (Unichain), flagged when they disagree
//   - --poke: calls poke() for loans stuck in a non-final state for longer than RETRY_AFTER
// Usage: npx ts-node scripts/status.ts [--poke]
import { ethers } from "ethers";
import { CALLBACK_PROXY, provider } from "./lib";
import { c, d, send } from "./loop";

const RC_STATUS = ["None", "Pending", "Active", "Liquidating", "Seizing", "Releasing", "Released", "Seized"];
const VAULT = ["None", "Locked", "Released", "Seized"];
const POOL = ["None", "Active", "Repaid", "Liquidated", "Rejected"];
const DEBT_ABI = ["function debt(address) view returns (uint256)"];

/** What vault/pool should say for each RC state, once every callback has landed. */
const EXPECT: Record<string, [string[], string[]]> = {
  Pending: [["Locked"], ["None"]],
  Active: [["Locked"], ["Active"]],
  Liquidating: [["Locked"], ["Active"]],
  Seizing: [["Locked"], ["Liquidated"]],
  Releasing: [["Locked"], ["None", "Repaid", "Rejected"]],
  Released: [["Released"], ["None", "Repaid", "Rejected"]],
  Seized: [["Seized"], ["Liquidated"]],
};

async function main() {
  const poke = process.argv.includes("--poke");
  const eth = (x: bigint) => Number(ethers.formatEther(x)).toFixed(5);
  const [rcBal, rcDebt, vBal, vDebt, pBal, pDebt] = await Promise.all([
    provider("lasna").getBalance(d.reactive.address),
    new ethers.Contract("0x8888888888888888888888888888888888888888", DEBT_ABI, provider("lasna")).debt(d.reactive.address),
    provider("base").getBalance(d.vault.address),
    new ethers.Contract(CALLBACK_PROXY.base, DEBT_ABI, provider("base")).debt(d.vault.address),
    provider("uni").getBalance(d.pool.address),
    new ethers.Contract(CALLBACK_PROXY.uni, DEBT_ABI, provider("uni")).debt(d.pool.address),
  ]);
  console.log("funding");
  console.log(`  RC    ${eth(rcBal)} lREACT   debt ${eth(rcDebt)}${rcDebt > 0n ? "  ⚠ delivery halted" : ""}`);
  console.log(`  vault ${eth(vBal)} ETH      debt ${eth(vDebt)}${vDebt > 0n ? "  ⚠ callbacks revert" : ""}`);
  console.log(`  pool  ${eth(pBal)} ETH      debt ${eth(pDebt)}${pDebt > 0n ? "  ⚠ callbacks revert" : ""}`);

  const [price, rcPrice, open, active, n, liquidity] = await Promise.all([
    c.feed.latestAnswer(), c.rc.price(), c.rc.openTotal(), c.rc.activeCount(), c.vault.nextId(), c.pool.liquidity(),
  ]);
  console.log(`market  feed $${Number(price) / 1e8}  RC sees $${Number(rcPrice) / 1e8}  open ${open}  active ${active}  pool liquidity ${Number(liquidity) / 1e6} tUSD`);

  const retryAfter = Number(await c.rc.RETRY_AFTER());
  const now = Math.floor(Date.now() / 1000);
  let issues = 0;
  for (let id = 1n; id <= n; id++) {
    const [r, v, p] = await Promise.all([c.rc.loans(id), c.vault.loans(id), c.pool.loans(id)]);
    const rs = RC_STATUS[Number(r.status)], vs = VAULT[Number(v.status)], ps = POOL[Number(p.status)];
    const [okV, okP] = EXPECT[rs] ?? [[vs], [ps]];
    const settled = okV.includes(vs) && okP.includes(ps);
    const inFlight = ["Pending", "Liquidating", "Seizing", "Releasing"].includes(rs);
    const age = now - Number(r.lastRequest);
    const stuck = inFlight && age > retryAfter;
    if (!settled || stuck) issues++;
    console.log(`  #${String(id).padEnd(4)} RC ${rs.padEnd(11)} vault ${vs.padEnd(8)} pool ${ps.padEnd(10)}${!settled ? "  mismatch" : ""}${stuck ? `  stuck ${age}s` : ""}`);
    if (stuck && poke) {
      const r2 = await send(c.rc.poke(id));
      console.log(`         poked: ${r2.hash}`);
    }
  }
  console.log(issues ? `${issues} loan(s) need attention${poke ? "" : " (run with --poke to retry stuck ones)"}` : "all loans consistent");
}
main().catch((e) => { console.error(e.shortMessage ?? e.message ?? e); process.exit(1); });

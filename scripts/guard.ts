// Keeps the automation funded. Reactions are paid in lREACT by the reactive contract and callbacks in ETH by the
// vault and the pool; a contract in debt stops receiving deliveries. This checks all three and, with --apply,
// pays any debt and tops up what is low from the deployer wallet. Dry run by default: nothing is sent without --apply.
// Usage: npx ts-node scripts/guard.ts [--apply]
import { ethers } from "ethers";
import { CALLBACK_PROXY, artifact, link, loadDeployments, provider, wallet } from "./lib";

const apply = process.argv.includes("--apply");
const d = loadDeployments();
const SYSTEM = "0x8888888888888888888888888888888888888888";
const DEBT = ["function debt(address) view returns (uint256)"];
const eth = (x: bigint) => Number(ethers.formatEther(x));

type Target = { name: string; key: "reactive" | "vault" | "pool"; chain: "lasna" | "base" | "uni"; abi: string; owedTo: string; low: bigint; top: bigint; unit: string };
const targets: Target[] = [
  { name: "reactive contract", key: "reactive", chain: "lasna", abi: "TandemReactive", owedTo: SYSTEM, low: ethers.parseEther("0.15"), top: ethers.parseEther("0.3"), unit: "lREACT" },
  { name: "vault (Base callbacks)", key: "vault", chain: "base", abi: "CollateralVault", owedTo: CALLBACK_PROXY.base, low: ethers.parseEther("0.0008"), top: ethers.parseEther("0.002"), unit: "ETH" },
  { name: "pool (Unichain callbacks)", key: "pool", chain: "uni", abi: "LendingPool", owedTo: CALLBACK_PROXY.uni, low: ethers.parseEther("0.0008"), top: ethers.parseEther("0.002"), unit: "ETH" },
];
// What the deployer wallet keeps for itself on each chain.
const KEEP = { lasna: ethers.parseEther("0.05"), base: ethers.parseEther("0.0005"), uni: ethers.parseEther("0.0005") };

async function main() {
  console.log(apply ? "guard: applying" : "guard: dry run (add --apply to send transactions)");
  let unresolved = 0;
  for (const t of targets) {
    const addr = d[t.key].address;
    const p = provider(t.chain);
    const w = wallet(t.chain);
    const [bal, debt] = await Promise.all([p.getBalance(addr), new ethers.Contract(t.owedTo, DEBT, p).debt(addr) as Promise<bigint>]);
    console.log(`\n${t.name}: ${eth(bal)} ${t.unit}, debt ${eth(debt)}`);

    let balance = bal;
    const need = debt > 0n || bal < t.low;
    if (need) {
      const amount = debt > 0n && bal < debt ? debt - bal + t.top : bal < t.low ? t.top : 0n;
      if (amount > 0n) {
        const spare = (await p.getBalance(w.address)) - KEEP[t.chain];
        if (spare < amount) {
          console.log(`  needs ${eth(amount)} ${t.unit} but the wallet only has ${eth(spare > 0n ? spare : 0n)} to spare. Add funds.`);
          unresolved++;
          continue;
        }
        console.log(`  top up ${eth(amount)} ${t.unit} from ${w.address}`);
        if (apply) {
          const tx = await w.sendTransaction({ to: addr, value: amount });
          await tx.wait();
          console.log(`  sent ${link(t.chain, "tx", tx.hash)}`);
          balance += amount;
        }
      }
      if (debt > 0n) {
        console.log("  pay the debt: coverDebt()");
        if (apply) {
          const c = new ethers.Contract(addr, artifact(t.abi).abi, w);
          const tx = await c.coverDebt();
          await tx.wait();
          console.log(`  sent ${link(t.chain, "tx", tx.hash)}`);
        }
      }
    } else {
      console.log("  fine");
    }
  }
  if (unresolved) { console.log(`\n${unresolved} item(s) need funds the wallet does not have.`); process.exit(2); }
}
main().catch((e) => { console.error(e.shortMessage ?? e.message ?? e); process.exit(1); });

// Prints the deployer address and its balance on the three chains. Safe to run any time.
import { ethers } from "ethers";
import { CHAINS, ChainKey, provider, wallet } from "./lib";

async function main() {
  const addr = wallet("lasna").address;
  console.log(`wallet ${addr}`);
  for (const c of Object.keys(CHAINS) as ChainKey[]) {
    try {
      const [bal, net] = await Promise.all([provider(c).getBalance(addr), provider(c).getNetwork()]);
      console.log(`  ${c.padEnd(6)} chain ${net.chainId}  ${ethers.formatEther(bal)} ${CHAINS[c].symbol}`);
    } catch (e) {
      console.log(`  ${c.padEnd(6)} RPC error: ${(e as Error).message.slice(0, 80)}`);
    }
  }
}
main().catch((e) => { console.error(e.message); process.exit(1); });

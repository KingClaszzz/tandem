// Moves Sepolia ETH to Unichain Sepolia through the canonical bridge (send ETH to the
// L1StandardBridgeProxy listed in Unichain's docs). Arrives in a few minutes.
// Usage: npx ts-node scripts/bridge-uni.ts <amount>
import { ethers } from "ethers";
import { wallet } from "./lib";

const BRIDGE = "0xea58fcA6849d79EAd1f26608855c2D6407d54Ce2";

async function main() {
  const amount = process.argv[2];
  if (!(Number(amount) > 0 && Number(amount) <= 0.1)) throw new Error("amount must be between 0 and 0.1 ETH");
  const w = wallet("lasna").connect(new ethers.JsonRpcProvider(process.env.SEPOLIA_RPC ?? "https://ethereum-sepolia-rpc.publicnode.com", 11155111, { staticNetwork: true }));
  const req = { to: BRIDGE, value: ethers.parseEther(amount) };
  const gas = await w.estimateGas(req); // the portal meters L2 gas: ~665k on L1, a fixed limit is too low
  const tx = await w.sendTransaction({ ...req, gasLimit: (gas * 12n) / 10n });
  console.log(`sent ${amount} ETH to the Unichain bridge: https://sepolia.etherscan.io/tx/${tx.hash}`);
  await tx.wait();
  console.log("done on Sepolia; it shows up on Unichain Sepolia in a few minutes (npm run check)");
}
main().catch((e) => { console.error(e.shortMessage ?? e.message); process.exit(1); });

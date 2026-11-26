// Swaps a little testnet ETH for Lasna lREACT through Reactive's official faucet contract
// (1 ETH = 100 lREACT; never more than 5 ETH per tx).
// Usage: npx ts-node scripts/get-lreact.ts <amount> [sepolia|base]
import { ethers } from "ethers";
import { wallet } from "./lib";

const FAUCET = {
  sepolia: { address: "0x9b9BB25f1A81078C544C829c5EB7822d747Cf434", rpc: process.env.SEPOLIA_RPC ?? "https://ethereum-sepolia-rpc.publicnode.com", id: 11155111, explorer: "https://sepolia.etherscan.io" },
  base: { address: "0x2afaFD298b23b62760711756088F75B7409f5967", rpc: process.env.BASE_SEPOLIA_RPC ?? "https://sepolia.base.org", id: 84532, explorer: "https://sepolia.basescan.org" },
};

async function main() {
  const amount = process.argv[2] ?? "0.02";
  const from = (process.argv[3] ?? "sepolia") as keyof typeof FAUCET;
  const f = FAUCET[from];
  if (!f) throw new Error("source must be sepolia or base");
  if (!(Number(amount) > 0 && Number(amount) <= 1)) throw new Error("amount must be between 0 and 1 ETH");
  const w = wallet("lasna").connect(new ethers.JsonRpcProvider(f.rpc, f.id, { staticNetwork: true }));
  const faucet = new ethers.Contract(f.address, ["function request(address) payable"], w);
  const tx = await faucet.request(w.address, { value: ethers.parseEther(amount) });
  console.log(`sent ${amount} ETH on ${from}: ${f.explorer}/tx/${tx.hash}`);
  await tx.wait();
  console.log(`done: expect ~${Number(amount) * 100} lREACT on Lasna shortly (npm run check)`);
}
main().catch((e) => { console.error(e.shortMessage ?? e.message); process.exit(1); });

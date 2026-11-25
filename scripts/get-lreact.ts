// Swaps a little Base Sepolia ETH for Lasna lREACT through Reactive's official faucet contract
// (1 ETH = 100 lREACT; never more than 5 ETH per tx). Usage: npx ts-node scripts/get-lreact.ts 0.02
import { ethers } from "ethers";
import { LREACT_FAUCET_BASE, link, wallet } from "./lib";

async function main() {
  const amount = process.argv[2] ?? "0.02";
  if (Number(amount) <= 0 || Number(amount) > 1) throw new Error("amount must be between 0 and 1 ETH");
  const w = wallet("base");
  const faucet = new ethers.Contract(LREACT_FAUCET_BASE, ["function request(address) payable"], w);
  const tx = await faucet.request(w.address, { value: ethers.parseEther(amount) });
  console.log("sent", link("base", "tx", tx.hash));
  await tx.wait();
  console.log(`done: expect ~${Number(amount) * 100} lREACT on Lasna in a few seconds (npm run check)`);
}
main().catch((e) => { console.error(e.message); process.exit(1); });

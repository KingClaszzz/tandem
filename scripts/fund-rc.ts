// Sends lREACT from the deployer to the reactive contract. Usage: npx ts-node scripts/fund-rc.ts <amount>
import { ethers } from "ethers";
import { link, loadDeployments, provider, wallet } from "./lib";

async function main() {
  const amount = process.argv[2];
  if (!(Number(amount) > 0 && Number(amount) <= 10)) throw new Error("amount must be between 0 and 10 lREACT");
  const rc = loadDeployments().reactive.address;
  const tx = await wallet("lasna").sendTransaction({ to: rc, value: ethers.parseEther(amount) });
  await tx.wait();
  console.log("sent", amount, "lREACT to the RC:", link("lasna", "tx", tx.hash));
  console.log("RC balance:", ethers.formatEther(await provider("lasna").getBalance(rc)));
}
main().catch((e) => { console.error(e.shortMessage ?? e.message); process.exit(1); });

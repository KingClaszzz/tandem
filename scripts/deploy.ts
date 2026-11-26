// Deploys Tandem to Lasna + Base Sepolia + Unichain Sepolia. Resumable: steps already in
// deployments.json are skipped. Usage: npm run deploy
import { ethers } from "ethers";
import { CALLBACK_PROXY, CHAINS, ChainKey, artifact, link, loadDeployments, saveDeployments, wallet } from "./lib";

const E18 = 10n ** 18n;
const INITIAL_PRICE = 3000n * 10n ** 8n;
const RC_FUNDING = ethers.parseEther(process.env.RC_FUNDING ?? "1.5"); // lREACT; the rest stays in the wallet for top-ups
const VAULT_FUNDING = ethers.parseEther(process.env.VAULT_FUNDING ?? "0.002"); // Base ETH for callbacks
const POOL_FUNDING = ethers.parseEther(process.env.POOL_FUNDING ?? "0.004"); // Unichain ETH for callbacks

const d = loadDeployments();

async function deploy(key: string, chain: ChainKey, name: string, args: unknown[], value = 0n) {
  if (d[key]) {
    console.log(`= ${key.padEnd(8)} ${d[key].address} (already deployed)`);
    return d[key].address;
  }
  const { abi, bytecode } = artifact(name);
  const f = new ethers.ContractFactory(abi, bytecode, wallet(chain));
  const c = await f.deploy(...args, { value });
  const tx = c.deploymentTransaction()!;
  console.log(`… ${key.padEnd(8)} ${chain} ${link(chain, "tx", tx.hash)}`);
  await c.waitForDeployment();
  d[key] = { chain, address: await c.getAddress(), tx: tx.hash };
  saveDeployments(d);
  console.log(`+ ${key.padEnd(8)} ${d[key].address}`);
  return d[key].address;
}

async function main() {
  const me = wallet("lasna").address;
  console.log("deployer", me);

  const rc = await deploy("reactive", "lasna", "TandemReactive", [CHAINS.base.id, CHAINS.uni.id], RC_FUNDING);
  const weth = await deploy("tWETH", "base", "TestToken", ["Tandem Test WETH", "tWETH", 18, 2n * E18, 0]);
  const feed = await deploy("feed", "base", "PriceFeed", [INITIAL_PRICE]);
  const vault = await deploy("vault", "base", "CollateralVault", [CALLBACK_PROXY.base, rc, weth, me], VAULT_FUNDING);
  const usd = await deploy("tUSD", "uni", "TestToken", ["Tandem Test USD", "tUSD", 6, 1000n * 10n ** 6n, 1_000_000n * 10n ** 6n]);
  const pool = await deploy("pool", "uni", "LendingPool", [CALLBACK_PROXY.uni, rc, usd], POOL_FUNDING);

  if (!d._meta?.seeded) {
    const token = new ethers.Contract(usd, artifact("TestToken").abi, wallet("uni"));
    const tx = await token.transfer(pool, 900_000n * 10n ** 6n);
    console.log("… seed pool", link("uni", "tx", tx.hash));
    await tx.wait();
    d._meta = { ...d._meta, seeded: tx.hash };
    saveDeployments(d);
  }

  if (!d._meta?.configured) {
    const r = new ethers.Contract(rc, artifact("TandemReactive").abi, wallet("lasna"));
    const tx = await r.configure(feed, vault, pool, INITIAL_PRICE);
    console.log("… configure", link("lasna", "tx", tx.hash));
    await tx.wait();
    d._meta = { ...d._meta, configured: tx.hash, deployedAt: new Date().toISOString() };
    saveDeployments(d);
  }

  console.log("\nTandem is live:");
  for (const [k, v] of Object.entries(d)) if (k !== "_meta") console.log(`  ${k.padEnd(8)} ${link(v.chain, "address", v.address)}`);
}
main().catch((e) => { console.error(e); process.exit(1); });

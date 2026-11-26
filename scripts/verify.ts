// Verifies every deployed contract on Sourcify (API v2) from Hardhat's build info, so the source is
// readable on Blockscout-style explorers. Usage: npx ts-node scripts/verify.ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CHAINS, loadDeployments } from "./lib";

const API = "https://sourcify.dev/server";
const UA = { "User-Agent": "tandem-verify/1.0 (hackathon project)", "Content-Type": "application/json" };
const SOURCE: Record<string, string> = {
  reactive: "contracts/TandemReactive.sol:TandemReactive",
  tWETH: "contracts/TestToken.sol:TestToken",
  feed: "contracts/PriceFeed.sol:PriceFeed",
  vault: "contracts/CollateralVault.sol:CollateralVault",
  tUSD: "contracts/TestToken.sol:TestToken",
  pool: "contracts/LendingPool.sol:LendingPool",
};

function buildInfo(identifier: string) {
  const dir = join(__dirname, "..", "artifacts", "build-info");
  const [file] = identifier.split(":");
  for (const f of readdirSync(dir)) {
    const b = JSON.parse(readFileSync(join(dir, f), "utf8"));
    if (b.input?.sources?.[file]) return b as { solcLongVersion: string; input: unknown };
  }
  throw new Error(`no build info for ${identifier}`);
}

async function main() {
  const d = loadDeployments();
  for (const [key, identifier] of Object.entries(SOURCE)) {
    const e = d[key];
    const chainId = CHAINS[e.chain].id;
    const check = await fetch(`${API}/v2/contract/${chainId}/${e.address}`, { headers: UA });
    if (check.ok && (await check.json()).match) {
      console.log(`= ${key.padEnd(8)} already verified`);
      continue;
    }
    const b = buildInfo(identifier);
    const res = await fetch(`${API}/v2/verify/${chainId}/${e.address}`, {
      method: "POST",
      headers: UA,
      body: JSON.stringify({ stdJsonInput: b.input, compilerVersion: b.solcLongVersion, contractIdentifier: identifier, creationTransactionHash: e.tx }),
    });
    const body = await res.json();
    if (!res.ok) {
      console.log(`✗ ${key.padEnd(8)} ${res.status} ${body.message ?? body.customCode ?? JSON.stringify(body).slice(0, 160)}`);
      continue;
    }
    let status = "pending";
    for (let i = 0; i < 30 && status === "pending"; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const job = await (await fetch(`${API}/v2/verify/${body.verificationId}`, { headers: UA })).json();
      status = job.isJobCompleted ? (job.contract?.match ?? job.error?.message ?? "failed") : "pending";
    }
    console.log(`${status === "match" || status === "exact_match" ? "✓" : "?"} ${key.padEnd(8)} ${status}`);
  }
}
main().catch((e) => { console.error(e.message); process.exit(1); });

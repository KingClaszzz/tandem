import "dotenv/config";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ethers } from "ethers";

export const CHAINS = {
  lasna: { id: 5318007, rpc: process.env.LASNA_RPC ?? "https://lasna-rpc.rnk.dev/", explorer: "https://lasna.reactscan.net", symbol: "lREACT" },
  base: { id: 84532, rpc: process.env.BASE_SEPOLIA_RPC ?? "https://sepolia.base.org", explorer: "https://sepolia.basescan.org", symbol: "ETH" },
  uni: { id: 1301, rpc: process.env.UNICHAIN_SEPOLIA_RPC ?? "https://sepolia.unichain.org", explorer: "https://sepolia.uniscan.xyz", symbol: "ETH" },
} as const;
export type ChainKey = keyof typeof CHAINS;

export const CALLBACK_PROXY = {
  base: "0x476F44b11F5C942c58f4c8E3d0300E5710743585",
  uni: "0x775c9B990ADe401060B78D0e98684eEf8d2466C1",
};
export const LREACT_FAUCET_BASE = "0x2afaFD298b23b62760711756088F75B7409f5967";

export function provider(c: ChainKey) {
  return new ethers.JsonRpcProvider(CHAINS[c].rpc, CHAINS[c].id, { staticNetwork: true });
}

export function wallet(c: ChainKey) {
  const pk = process.env.PRIVATE_KEY;
  if (!pk) throw new Error("PRIVATE_KEY is missing in .env (use a fresh testnet-only wallet)");
  return new ethers.Wallet(pk, provider(c));
}

export function artifact(name: string, dir = "") {
  const p = join(__dirname, "..", "artifacts", "contracts", dir, `${name}.sol`, `${name}.json`);
  return JSON.parse(readFileSync(p, "utf8")) as { abi: ethers.InterfaceAbi; bytecode: string };
}

const DEPLOYMENTS = join(__dirname, "..", "deployments.json");
export type Deployments = Record<string, { chain: ChainKey; address: string; tx?: string }> & { _meta?: any };
export function loadDeployments(): Deployments {
  return existsSync(DEPLOYMENTS) ? JSON.parse(readFileSync(DEPLOYMENTS, "utf8")) : {};
}
export function saveDeployments(d: Deployments) {
  const json = JSON.stringify(d, null, 2) + "\n";
  writeFileSync(DEPLOYMENTS, json);
  writeFileSync(join(__dirname, "..", "web", "src", "deployments.json"), json); // the web app reads its copy
}

export const link = (c: ChainKey, kind: "tx" | "address", v: string) => `${CHAINS[c].explorer}/${kind}/${v}`;

// Shared helpers for scripts that drive real loops on the testnets (smoke, bench).
import { ethers } from "ethers";
import { ChainKey, artifact, loadDeployments, provider, wallet } from "./lib";

export const POLL_MS = 250;
export const d = loadDeployments();
if (!d.reactive) throw new Error("deployments.json is empty: run npm run deploy first");

const at = (k: string, chain: ChainKey, name: string) => new ethers.Contract(d[k].address, artifact(name).abi, wallet(chain));
export const c = {
  feed: at("feed", "base", "PriceFeed"),
  vault: at("vault", "base", "CollateralVault"),
  weth: at("tWETH", "base", "TestToken"),
  pool: at("pool", "uni", "LendingPool"),
  usd: at("tUSD", "uni", "TestToken"),
  rc: at("reactive", "lasna", "TandemReactive"),
};

export type Seen = { chain: ChainKey; event: string; hash: string; ms: number };

/** Recent block per chain, a little in the past, to start event searches from. */
export async function marks() {
  const [b, l, u] = await Promise.all((["base", "lasna", "uni"] as ChainKey[]).map((k) => provider(k).getBlockNumber()));
  return { base: b - 30, lasna: l - 5, uni: u - 5 } as Record<ChainKey, number>;
}

/** Sends a tx and returns its receipt plus the wall-clock moment the receipt was seen. */
export async function send(tx: Promise<ethers.ContractTransactionResponse>) {
  const r = await (await tx).wait();
  if (!r || r.status !== 1) throw new Error("tx failed");
  return { receipt: r, hash: r.hash, t: performance.now() };
}

/** Polls for the first of `events` (filtered by loanId when given) and returns when it was first seen. */
export async function seen(chain: ChainKey, contract: ethers.Contract, events: string[], loanId: bigint | null, fromBlock: number, t0: number, timeoutMs = 180_000): Promise<Seen> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const event of events) {
      try {
        const filter = loanId === null ? contract.filters[event]() : contract.filters[event](loanId);
        const logs = await contract.queryFilter(filter, fromBlock);
        if (logs.length) return { chain, event, hash: logs[0].transactionHash, ms: performance.now() - t0 };
      } catch { /* transient RPC error: retry */ }
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  throw new Error(`${events.join("|")} for loan ${loanId} not seen on ${chain} within ${timeoutMs / 1000}s`);
}

export const loanIdOf = (receipt: ethers.TransactionReceipt) =>
  BigInt(receipt.logs.find((l) => l.address.toLowerCase() === d.vault.address.toLowerCase())!.topics[1]);

export const PX = (usd: number) => BigInt(Math.round(usd)) * 10n ** 8n;

/** The feed accepts one update per MIN_INTERVAL. Waits until it will, using the chain's own clock. */
export async function waitForFeedSlot() {
  let every = 0n;
  try { every = await c.feed.MIN_INTERVAL(); } catch { return; } // the first deployment had no cooldown
  const last: bigint = await c.feed.latestTimestamp();
  const head = await provider("base").getBlock("latest");
  const wait = Number(last + every - BigInt(head!.timestamp));
  if (wait > 0) await new Promise((r) => setTimeout(r, (wait + 2) * 1000));
}

/** Moves the demo price to `target`, stepping if needed to respect the feed's 50% max move and its cooldown. */
export async function setPrice(target: bigint) {
  let cur: bigint = await c.feed.latestAnswer();
  let last;
  while (cur !== target) {
    const max = (cur * 15n) / 10n, min = (cur * 6n) / 10n;
    const next = target > max ? max : target < min ? min : target;
    await waitForFeedSlot();
    last = await send(c.feed.post(next));
    cur = next;
  }
  return last;
}

export async function ensureWeth(me: string, amount: bigint) {
  if ((await c.weth.balanceOf(me)) >= amount) return;
  const next = Number(await c.weth.lastDrip(me)) + 61 - Math.floor(Date.now() / 1000);
  if (next > 0) await new Promise((r) => setTimeout(r, next * 1000));
  await send(c.weth.faucet());
}

export async function ensureAllowance(token: ethers.Contract, owner: string, spender: string, amount: bigint) {
  if ((await token.allowance(owner, spender)) < amount) await send(token.approve(spender, ethers.MaxUint256));
}

export const fmt = (ms: number) => `${(ms / 1000).toFixed(2)}s`;

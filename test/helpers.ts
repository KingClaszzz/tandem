import "@nomicfoundation/hardhat-chai-matchers";
import { expect } from "chai";
import { ethers, network } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import type { ContractTransactionResponse, Log } from "ethers";

export const SYSTEM = "0x8888888888888888888888888888888888888888";
export const BASE = 84532n;
export const UNI = 1301n;
export const E18 = 10n ** 18n;
export const USD = (n: number) => BigInt(Math.round(n * 1e6)); // tUSD, 6 dp
export const PX = (n: number) => BigInt(n) * 10n ** 8n; // price, 8 dp

// RC statuses
export const S = { None: 0n, Pending: 1n, Active: 2n, Liquidating: 3n, Seizing: 4n, Releasing: 5n, Released: 6n, Seized: 7n };
// vault: None, Locked, Released, Seized · pool: None, Active, Repaid, Liquidated, Rejected
export const V = { Locked: 1n, Released: 2n, Seized: 3n };
export const P = { None: 0n, Active: 1n, Repaid: 2n, Liquidated: 3n, Rejected: 4n };

export type Cb = { chain: bigint; recipient: string; payload: string; selector: string };

export async function setup({ poolLiquidity = USD(500_000) } = {}) {
  const [deployer, alice, bob, treasury] = await ethers.getSigners();

  // Put the mock system contract's code at Reactive's fixed system address.
  const sysImpl = await ethers.deployContract("MockSystem");
  await network.provider.send("hardhat_setCode", [SYSTEM, await ethers.provider.getCode(await sysImpl.getAddress())]);
  // setCode keeps the old storage: clear the subscription list so each test starts from an empty system contract.
  await network.provider.send("hardhat_setStorageAt", [SYSTEM, "0x0", ethers.ZeroHash]);
  const system = await ethers.getContractAt("MockSystem", SYSTEM);

  const rc = await ethers.deployContract("TandemReactive", [BASE, UNI]);
  const baseProxy = await ethers.deployContract("MockProxy");
  const uniProxy = await ethers.deployContract("MockProxy");

  const weth = await ethers.deployContract("TestToken", ["Test WETH", "tWETH", 18, 2n * E18, 0]);
  const usd = await ethers.deployContract("TestToken", ["Test USD", "tUSD", 6, USD(1000), USD(1_000_000)]);
  const feed = await ethers.deployContract("PriceFeed", [PX(3000)]);
  const vault = await ethers.deployContract("CollateralVault", [baseProxy, rc, weth, treasury.address]);
  const pool = await ethers.deployContract("LendingPool", [uniProxy, rc, usd]);
  if (poolLiquidity > 0n) await usd.transfer(pool, poolLiquidity);
  await rc.configure(feed, vault, pool, PX(3000));

  const chainOf = new Map<string, bigint>([
    [(await feed.getAddress()).toLowerCase(), BASE],
    [(await vault.getAddress()).toLowerCase(), BASE],
    [(await pool.getAddress()).toLowerCase(), UNI],
  ]);
  const proxyOf = new Map<bigint, typeof baseProxy>([[BASE, baseProxy], [UNI, uniProxy]]);
  const rcAddr = await rc.getAddress();
  const sel = (c: { interface: any }, name: string) => c.interface.getFunction(name)!.selector as string;
  const SEL = { disburse: sel(pool, "disburse"), liquidate: sel(pool, "liquidate"), seize: sel(vault, "seize"), release: sel(vault, "release") };

  const trace: string[] = [];
  const held: Cb[] = [];

  const toRecord = (log: Log, chainId: bigint) => ({
    chainId, contractAddress: log.address,
    topic0: log.topics[0] ?? 0, topic1: log.topics[1] ?? 0, topic2: log.topics[2] ?? 0, topic3: log.topics[3] ?? 0,
    data: log.data, blockNumber: log.blockNumber, opCode: 0, blockHash: log.blockHash, txHash: log.transactionHash, logIndex: log.index,
  });

  function callbacksIn(logs: readonly Log[]): Cb[] {
    const out: Cb[] = [];
    for (const l of logs) {
      if (l.address.toLowerCase() !== SYSTEM.toLowerCase()) continue;
      const ev = system.interface.parseLog(l);
      if (ev?.name !== "CallbackRequested") continue;
      const [, chain, recipient, gas, payload] = ev.args;
      expect(gas).to.be.gte(100_000n);
      out.push({ chain, recipient, payload, selector: payload.slice(0, 10) });
    }
    return out;
  }

  /** Plays the Reactive Network: delivers origin logs to the RC and executes the callbacks it requests,
   *  until quiet. Callbacks whose selector is in `hold` are parked in `held` instead of executed. */
  async function pump(logs: readonly Log[], hold: string[] = []) {
    let queue: Log[] = [...logs];
    while (queue.length) {
      const next: Log[] = [];
      for (const log of queue) {
        const chainId = chainOf.get(log.address.toLowerCase());
        if (!chainId) continue;
        const rec = await (await system.deliver(rcAddr, toRecord(log, chainId))).wait();
        next.push(...(await runCallbacks(callbacksIn(rec!.logs), hold)));
      }
      queue = next;
    }
  }
  async function runCallbacks(cbs: Cb[], hold: string[] = []) {
    const out: Log[] = [];
    for (const cb of cbs) {
      if (hold.includes(cb.selector)) { held.push(cb); continue; }
      trace.push(`${cb.chain === BASE ? "base" : "uni"}:${cb.selector}`);
      const r = await (await proxyOf.get(cb.chain)!.execute(cb.recipient, rcAddr, cb.payload)).wait();
      out.push(...r!.logs);
    }
    return out;
  }
  const relay = async (tx: Promise<ContractTransactionResponse> | ContractTransactionResponse, hold: string[] = []) =>
    pump((await (await tx).wait())!.logs, hold);
  /** Executes parked callbacks (e.g. after a simulated delay) and pumps what they emit. */
  async function release(hold: string[] = []) {
    const cbs = held.splice(0);
    await pump(await runCallbacks(cbs), hold);
  }
  /** Calls poke() on the RC (as any user) and pumps the callbacks it requests. */
  async function poke(id: bigint, hold: string[] = []) {
    const rec = await (await rc.connect(bob).poke(id)).wait();
    await pump(await runCallbacks(callbacksIn(rec!.logs), hold), hold);
  }

  async function borrow(who: typeof alice, eth: bigint, usdAmt: bigint, hold: string[] = []) {
    if ((await weth.balanceOf(who)) < eth) await weth.connect(who).faucet();
    await weth.connect(who).approve(vault, eth);
    await relay(vault.connect(who).lock(eth, usdAmt), hold);
    return await vault.nextId();
  }
  // The feed accepts one update per 30 s from anyone, so every price move first lets the cooldown pass.
  const setPrice = async (p: bigint, hold: string[] = []) => { await time.increase(31); return relay(feed.post(p), hold); };

  return { deployer, alice, bob, treasury, system, rc, weth, usd, feed, vault, pool, baseProxy, uniProxy, relay, release, poke, borrow, setPrice, trace, held, SEL, toRecord };
}


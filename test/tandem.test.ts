import "@nomicfoundation/hardhat-chai-matchers";
import { expect } from "chai";
import { ethers, network } from "hardhat";
import type { ContractTransactionResponse, Log } from "ethers";

const SYSTEM = "0x8888888888888888888888888888888888888888";
const BASE = 84532n;
const UNI = 1301n;
const E18 = 10n ** 18n;
const USD = (n: number) => BigInt(Math.round(n * 1e6)); // tUSD, 6 dp
const PX = (n: number) => BigInt(n) * 10n ** 8n; // price, 8 dp

async function setup() {
  const [deployer, alice, bob] = await ethers.getSigners();

  // Put the mock system contract's code at Reactive's fixed system address.
  const sysImpl = await ethers.deployContract("MockSystem");
  await network.provider.send("hardhat_setCode", [SYSTEM, await ethers.provider.getCode(await sysImpl.getAddress())]);
  const system = await ethers.getContractAt("MockSystem", SYSTEM);

  const rc = await ethers.deployContract("TandemReactive", [BASE, UNI]);
  const baseProxy = await ethers.deployContract("MockProxy");
  const uniProxy = await ethers.deployContract("MockProxy");

  const weth = await ethers.deployContract("TestToken", ["Test WETH", "tWETH", 18, 2n * E18, 0]);
  const usd = await ethers.deployContract("TestToken", ["Test USD", "tUSD", 6, USD(1000), USD(1_000_000)]);
  const feed = await ethers.deployContract("PriceFeed", [PX(3000)]);
  const vault = await ethers.deployContract("CollateralVault", [baseProxy, rc, weth, deployer.address]);
  const pool = await ethers.deployContract("LendingPool", [uniProxy, rc, usd]);
  await usd.transfer(pool, USD(500_000));
  await rc.configure(feed, vault, pool, PX(3000));

  const chainOf = new Map<string, bigint>([
    [(await feed.getAddress()).toLowerCase(), BASE],
    [(await vault.getAddress()).toLowerCase(), BASE],
    [(await pool.getAddress()).toLowerCase(), UNI],
  ]);
  const proxyOf = new Map<bigint, typeof baseProxy>([[BASE, baseProxy], [UNI, uniProxy]]);
  const rcAddr = await rc.getAddress();

  const trace: string[] = [];

  /** Plays the Reactive Network: delivers origin logs to the RC, then executes the callbacks it asks for, until quiet. */
  async function relay(tx: Promise<ContractTransactionResponse> | ContractTransactionResponse) {
    let queue: Log[] = [...(await (await tx).wait())!.logs];
    while (queue.length) {
      const next: Log[] = [];
      for (const log of queue) {
        const chainId = chainOf.get(log.address.toLowerCase());
        if (!chainId) continue;
        const rec = await (await system.deliver(rcAddr, {
          chainId, contractAddress: log.address,
          topic0: log.topics[0] ?? 0, topic1: log.topics[1] ?? 0, topic2: log.topics[2] ?? 0, topic3: log.topics[3] ?? 0,
          data: log.data, blockNumber: log.blockNumber, opCode: 0, blockHash: log.blockHash, txHash: log.transactionHash, logIndex: log.index,
        })).wait();
        for (const l of rec!.logs) {
          if (l.address.toLowerCase() !== SYSTEM.toLowerCase()) continue;
          const ev = system.interface.parseLog(l);
          if (ev?.name !== "CallbackRequested") continue;
          const [, cbChain, recipient, gas, payload] = ev.args;
          expect(gas).to.be.gte(100_000n);
          trace.push(`${cbChain === BASE ? "base" : "uni"}:${payload.slice(0, 10)}`);
          const cb = await (await proxyOf.get(cbChain)!.execute(recipient, rcAddr, payload)).wait();
          next.push(...cb!.logs);
        }
      }
      queue = next;
    }
  }

  async function borrow(who: typeof alice, eth: bigint, usdAmt: bigint) {
    await weth.connect(who).faucet();
    await weth.connect(who).approve(vault, eth);
    await relay(vault.connect(who).lock(eth, usdAmt));
    return await vault.nextId();
  }

  return { deployer, alice, bob, system, rc, weth, usd, feed, vault, pool, baseProxy, uniProxy, relay, borrow, trace };
}

describe("Tandem", () => {
  it("subscribes to the six origin events on configure", async () => {
    const { system } = await setup();
    expect(await system.subCount()).to.equal(6n);
  });

  it("borrow: lock on Base -> tUSD disbursed on Unichain", async () => {
    const { alice, usd, pool, rc, borrow } = await setup();
    const id = await borrow(alice, E18, USD(2000)); // 2000 / 3000 = 66.7% LTV
    expect(await usd.balanceOf(alice)).to.equal(USD(2000));
    expect((await pool.loans(id)).status).to.equal(1n); // Active
    expect(await rc.activeCount()).to.equal(1n);
  });

  it("borrow over max LTV is refused and collateral comes back", async () => {
    const { alice, weth, usd, vault, borrow } = await setup();
    const id = await borrow(alice, E18, USD(2200)); // 73% LTV
    expect(await usd.balanceOf(alice)).to.equal(0n);
    expect(await weth.balanceOf(alice)).to.equal(2n * E18);
    expect((await vault.loans(id)).status).to.equal(2n); // Released
  });

  it("repay on Unichain releases collateral on Base", async () => {
    const { alice, weth, usd, pool, vault, rc, relay, borrow } = await setup();
    const id = await borrow(alice, E18, USD(2000));
    await usd.connect(alice).approve(pool, USD(2000));
    await relay(pool.connect(alice).repay(id));
    expect((await vault.loans(id)).status).to.equal(2n);
    expect(await weth.balanceOf(alice)).to.equal(2n * E18);
    expect(await rc.activeCount()).to.equal(0n);
  });

  it("price crash: liquidate on Unichain first, then seize on Base", async () => {
    const { deployer, alice, weth, feed, pool, vault, rc, relay, borrow, trace } = await setup();
    const id = await borrow(alice, E18, USD(2000));
    trace.length = 0;
    await relay(feed.setPrice(PX(2400))); // 2000 / 2400 = 83% > 80%
    expect((await pool.loans(id)).status).to.equal(3n); // Liquidated
    expect((await vault.loans(id)).status).to.equal(3n); // Seized
    expect(await weth.balanceOf(deployer)).to.equal(E18); // treasury
    const liq = pool.interface.getFunction("liquidate")!.selector;
    const seize = vault.interface.getFunction("seize")!.selector;
    expect(trace).to.deep.equal([`uni:${liq}`, `base:${seize}`]);
    expect(await rc.activeCount()).to.equal(0n);
  });

  it("a small dip above the threshold liquidates nothing", async () => {
    const { alice, feed, pool, relay, borrow } = await setup();
    const id = await borrow(alice, E18, USD(2000));
    await relay(feed.setPrice(PX(2600))); // 76.9%
    expect((await pool.loans(id)).status).to.equal(1n);
  });

  it("only unhealthy loans are liquidated in a sweep", async () => {
    const { alice, bob, feed, pool, relay, borrow } = await setup();
    const risky = await borrow(alice, E18, USD(2000));
    const safe = await borrow(bob, E18, USD(1000));
    await relay(feed.setPrice(PX(2400)));
    expect((await pool.loans(risky)).status).to.equal(3n);
    expect((await pool.loans(safe)).status).to.equal(1n);
  });

  it("repay after liquidation reverts, so nobody repays and loses collateral", async () => {
    const { alice, usd, feed, pool, relay, borrow } = await setup();
    const id = await borrow(alice, E18, USD(2000));
    await relay(feed.setPrice(PX(2400)));
    await usd.connect(alice).approve(pool, USD(2000));
    await expect(pool.connect(alice).repay(id)).to.be.revertedWithCustomError(pool, "NotActive");
  });

  it("rejects callbacks that don't come through the proxy or from the RC", async () => {
    const { alice, vault, pool, baseProxy, borrow } = await setup();
    const id = await borrow(alice, E18, USD(2000));
    await expect(vault.connect(alice).seize(alice.address, id)).to.be.revertedWithCustomError(vault, "NotAuthorized");
    const payload = vault.interface.encodeFunctionData("seize", [alice.address, id]);
    await expect(baseProxy.execute(vault, alice.address, payload)).to.be.revertedWithCustomError(vault, "CallbackNotAuthorized");
    await expect(pool.connect(alice).liquidate(alice.address, id)).to.be.revertedWithCustomError(pool, "NotAuthorized");
  });

  it("react() only accepts the system contract", async () => {
    const { alice, rc } = await setup();
    const log = { chainId: BASE, contractAddress: alice.address, topic0: 0, topic1: 0, topic2: 0, topic3: 0, data: "0x", blockNumber: 0, opCode: 0, blockHash: 0, txHash: 0, logIndex: 0 };
    await expect(rc.connect(alice).react(log)).to.be.revertedWithCustomError(rc, "NotAuthorized");
  });

  it("ignores look-alike events from other contracts", async () => {
    const { deployer, alice, pool, rc, relay, borrow } = await setup();
    const id = await borrow(alice, E18, USD(2000));
    const fakeFeed = await ethers.deployContract("PriceFeed", [PX(3000)]);
    await relay(fakeFeed.connect(deployer).setPrice(PX(200)));
    expect((await pool.loans(id)).status).to.equal(1n);
    expect(await rc.price()).to.equal(PX(3000));
  });

  it("configure is owner-only and one-time", async () => {
    const { alice, rc, feed, vault, pool } = await setup();
    await expect(rc.connect(alice).configure(feed, vault, pool, 1)).to.be.revertedWithCustomError(rc, "NotOwner");
    await expect(rc.configure(feed, vault, pool, 1)).to.be.revertedWithCustomError(rc, "AlreadyConfigured");
  });

  it("a full sweep of 25 loans stays under the 900k reactive gas cap", async () => {
    const { feed, system, rc, weth, vault, relay } = await setup();
    const signers = await ethers.getSigners();
    for (let i = 0; i < 25; i++) {
      const s = signers[3 + (i % 15)];
      if (i < 15) await weth.connect(s).faucet();
      await weth.connect(s).approve(vault, E18 / 10n);
      await relay(vault.connect(s).lock(E18 / 10n, USD(200)));
    }
    expect(await rc.activeCount()).to.equal(25n);
    const tx = await feed.setPrice(PX(2400));
    const log = (await tx.wait())!.logs[0];
    const gas = await system.deliver.estimateGas(await rc.getAddress(), {
      chainId: BASE, contractAddress: log.address, topic0: log.topics[0], topic1: log.topics[1], topic2: log.topics[2], topic3: 0,
      data: log.data, blockNumber: log.blockNumber, opCode: 0, blockHash: log.blockHash, txHash: log.transactionHash, logIndex: log.index,
    });
    console.log(`      sweep gas for 25 liquidations: ${gas}`);
    expect(gas).to.be.lt(900_000n);
  });
});

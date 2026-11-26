import "@nomicfoundation/hardhat-chai-matchers";
import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { BASE, E18, P, PX, S, UNI, USD, V, setup } from "./helpers";

// The tests target the current contracts. SRC=archive/v1/contracts runs the same suite against the first deployment,
// where the properties marked fixedInV2 are known issues and show as pending.
const V2 = !process.env.SRC || !process.env.SRC.includes("v1");

describe("Tandem", () => {
  describe("wiring", () => {
    it("subscribes to the eight origin events on configure", async () => {
      const { system } = await setup();
      expect(await system.subCount()).to.equal(8n);
    });

    it("configure is owner-only and one-time", async () => {
      const { alice, rc, feed, vault, pool } = await setup();
      await expect(rc.connect(alice).configure(feed, vault, pool, 1)).to.be.revertedWithCustomError(rc, "NotOwner");
      await expect(rc.configure(feed, vault, pool, 1)).to.be.revertedWithCustomError(rc, "AlreadyConfigured");
    });
  });

  describe("borrow", () => {
    it("lock on Base -> tUSD disbursed on Unichain", async () => {
      const { alice, usd, pool, rc, borrow } = await setup();
      const id = await borrow(alice, E18, USD(2000)); // 66.7% LTV
      expect(await usd.balanceOf(alice)).to.equal(USD(2000));
      expect((await pool.loans(id)).status).to.equal(P.Active);
      expect((await rc.loans(id)).status).to.equal(S.Active);
      expect(await rc.openTotal()).to.equal(1n);
    });

    for (const [name, eth, debt, reason] of [
      ["over 70% LTV", E18, USD(2200), 1],
    ] as const) {
      it(`refuses a borrow ${name} and returns the collateral`, async () => {
        const { alice, weth, usd, vault, rc, borrow } = await setup();
        const id = await borrow(alice, eth, debt);
        expect(await usd.balanceOf(alice)).to.equal(0n);
        expect(await weth.balanceOf(alice)).to.equal(2n * E18);
        expect((await vault.loans(id)).status).to.equal(V.Released);
        expect((await rc.loans(id)).status).to.equal(S.Released);
        expect(await rc.openTotal()).to.equal(0n);
        const logs = await rc.queryFilter(rc.filters.BorrowRefused(id));
        expect(logs[0].args.reason).to.equal(reason);
      });
    }

    it(V2 ? "caps open loans per borrower at 3, at the vault" : "caps open loans per borrower at 3 (Reactive refuses the 4th)", async () => {
      const { alice, weth, vault, borrow } = await setup();
      for (let i = 0; i < 3; i++) await borrow(alice, E18 / 2n, USD(500));
      if (V2) {
        await weth.connect(alice).approve(vault, E18);
        await expect(vault.connect(alice).lock(E18 / 2n, USD(500))).to.be.revertedWithCustomError(vault, "TooManyLoans");
      } else {
        const id = await borrow(alice, E18 / 2n, USD(500));
        expect((await vault.loans(id)).status).to.equal(V.Released);
      }
    });

    it("pool without liquidity rejects, and the collateral comes back", async () => {
      const { alice, weth, pool, vault, rc, borrow } = await setup({ poolLiquidity: 0n });
      const id = await borrow(alice, E18, USD(2000));
      expect((await pool.loans(id)).status).to.equal(P.Rejected);
      expect((await vault.loans(id)).status).to.equal(V.Released);
      expect((await rc.loans(id)).status).to.equal(S.Released);
      expect(await weth.balanceOf(alice)).to.equal(2n * E18);
      expect(await rc.openTotal()).to.equal(0n);
    });
  });

  describe("repay", () => {
    it("repay on Unichain releases collateral on Base and finalizes", async () => {
      const { alice, weth, usd, pool, vault, rc, relay, borrow } = await setup();
      const id = await borrow(alice, E18, USD(2000));
      await usd.connect(alice).approve(pool, USD(2000));
      await relay(pool.connect(alice).repay(id));
      expect((await vault.loans(id)).status).to.equal(V.Released);
      expect((await rc.loans(id)).status).to.equal(S.Released);
      expect(await weth.balanceOf(alice)).to.equal(2n * E18);
      expect(await rc.activeCount()).to.equal(0n);
    });
  });

  describe("liquidation", () => {
    it("crash: liquidate on Unichain first, then seize debt + 5% and return the rest", async () => {
      const { alice, treasury, weth, pool, vault, rc, borrow, setPrice, trace, SEL } = await setup();
      const id = await borrow(alice, E18, USD(2000));
      trace.length = 0;
      await setPrice(PX(2400)); // 2000 / 2400 = 83.3% > 80%
      expect(trace).to.deep.equal([`uni:${SEL.liquidate}`, `base:${SEL.seize}`]);
      expect((await pool.loans(id)).status).to.equal(P.Liquidated);
      expect((await vault.loans(id)).status).to.equal(V.Seized);
      expect((await rc.loans(id)).status).to.equal(S.Seized);
      // 2000 * 1.05 / 2400 = 0.875 tWETH to the treasury, 0.125 back to the borrower
      const seized = (USD(2000) * 100n * E18 * 10500n) / (PX(2400) * 10000n);
      expect(await weth.balanceOf(treasury)).to.equal(seized);
      expect(await weth.balanceOf(alice)).to.equal(2n * E18 - seized);
      expect(await rc.openTotal()).to.equal(0n);
    });

    it("seizes everything when collateral is worth less than debt + penalty", async () => {
      const { alice, treasury, weth, borrow, setPrice } = await setup();
      await borrow(alice, E18, USD(2000));
      await setPrice(PX(1900)); // collateral $1,900 < $2,100
      expect(await weth.balanceOf(treasury)).to.equal(E18);
    });

    it("a dip that stays under 80% liquidates nothing", async () => {
      const { alice, pool, borrow, setPrice } = await setup();
      const id = await borrow(alice, E18, USD(2000));
      await setPrice(PX(2600)); // 76.9%
      expect((await pool.loans(id)).status).to.equal(P.Active);
    });

    it("only unhealthy loans are liquidated in a sweep", async () => {
      const { alice, bob, pool, borrow, setPrice } = await setup();
      const risky = await borrow(alice, E18, USD(2000));
      const safe = await borrow(bob, E18, USD(1000));
      await setPrice(PX(2400));
      expect((await pool.loans(risky)).status).to.equal(P.Liquidated);
      expect((await pool.loans(safe)).status).to.equal(P.Active);
    });

    it("a loan that lands while the price is already low is liquidated on arrival", async () => {
      const { alice, pool, borrow, setPrice, release, SEL } = await setup();
      const id = await borrow(alice, E18, USD(2000), [SEL.disburse]); // disburse in flight
      await setPrice(PX(2400));
      await release();
      expect((await pool.loans(id)).status).to.equal(P.Liquidated);
    });

    it("repay after liquidation reverts", async () => {
      const { alice, usd, pool, borrow, setPrice } = await setup();
      const id = await borrow(alice, E18, USD(2000));
      await setPrice(PX(2400));
      await usd.connect(alice).approve(pool, USD(2000));
      await expect(pool.connect(alice).repay(id)).to.be.revertedWithCustomError(pool, "NotActive");
    });

    it("race: repay lands before the liquidate callback -> no liquidation, collateral released", async () => {
      const { alice, weth, usd, pool, vault, rc, relay, borrow, setPrice, release, SEL } = await setup();
      const id = await borrow(alice, E18, USD(2000));
      await setPrice(PX(2400), [SEL.liquidate]); // liquidate requested, still in flight
      expect((await rc.loans(id)).status).to.equal(S.Liquidating);
      await usd.connect(alice).approve(pool, USD(2000));
      await relay(pool.connect(alice).repay(id));
      await release(); // the late liquidate() must be a no-op
      expect((await pool.loans(id)).status).to.equal(P.Repaid);
      expect((await vault.loans(id)).status).to.equal(V.Released);
      expect((await rc.loans(id)).status).to.equal(S.Released);
      expect(await weth.balanceOf(alice)).to.equal(2n * E18);
    });

    it("liquidates at most 10 loans per price update; poke catches the rest", async () => {
      const { pool, rc, weth, vault, relay, poke, setPrice } = await setup();
      const signers = (await ethers.getSigners()).slice(4, 19); // 15 borrowers, 1 loan each
      for (const s of signers) {
        await weth.connect(s).faucet();
        await weth.connect(s).approve(vault, E18);
        await relay(vault.connect(s).lock(E18 / 10n, USD(200)));
      }
      await setPrice(PX(2400)); // 200 / 240 = 83%
      let liquidated = 0;
      for (let i = 1n; i <= 15n; i++) if ((await pool.loans(i)).status === P.Liquidated) liquidated++;
      expect(liquidated).to.equal(10);
      for (const id of await rc.activeIds()) await poke(id);
      for (let i = 1n; i <= 15n; i++) expect((await pool.loans(i)).status).to.equal(P.Liquidated);
    });
  });

  describe("liveness (poke)", () => {
    it("re-sends a dropped seize after 60s, and only once it is due", async () => {
      const { alice, vault, rc, borrow, setPrice, poke, held, SEL } = await setup();
      const id = await borrow(alice, E18, USD(2000));
      await setPrice(PX(2400), [SEL.seize]); // seize callback "lost"
      held.length = 0;
      expect((await rc.loans(id)).status).to.equal(S.Seizing);
      await expect(rc.poke(id)).to.be.revertedWithCustomError(rc, "TooSoon");
      await time.increase(61);
      await poke(id);
      expect((await vault.loans(id)).status).to.equal(V.Seized);
      expect((await rc.loans(id)).status).to.equal(S.Seized);
    });

    it("re-sends a dropped disburse; a duplicate can't pay twice", async () => {
      const { alice, usd, pool, rc, borrow, poke, release, SEL } = await setup();
      const id = await borrow(alice, E18, USD(2000), [SEL.disburse]);
      expect((await rc.loans(id)).status).to.equal(S.Pending);
      await time.increase(61);
      await poke(id);
      await release(); // the original disburse finally arrives
      expect(await usd.balanceOf(alice)).to.equal(USD(2000));
      expect((await pool.loans(id)).status).to.equal(P.Active);
    });

    it("re-sends a dropped release", async () => {
      const { alice, usd, pool, vault, rc, relay, borrow, poke, held, SEL } = await setup();
      const id = await borrow(alice, E18, USD(2000));
      await usd.connect(alice).approve(pool, USD(2000));
      await relay(pool.connect(alice).repay(id), [SEL.release]);
      held.length = 0;
      await time.increase(61);
      await poke(id);
      expect((await vault.loans(id)).status).to.equal(V.Released);
      expect((await rc.loans(id)).status).to.equal(S.Released);
    });

    it("has nothing to retry on healthy or final loans", async () => {
      const { alice, rc, borrow } = await setup();
      const id = await borrow(alice, E18, USD(2000));
      await time.increase(61);
      await expect(rc.poke(id)).to.be.revertedWithCustomError(rc, "NothingToRetry");
      await expect(rc.poke(999)).to.be.revertedWithCustomError(rc, "NothingToRetry");
    });
  });

  describe("security", () => {
    it("rejects callbacks that don't come through the proxy or from the RC", async () => {
      const { alice, vault, pool, baseProxy, uniProxy, borrow } = await setup();
      const id = await borrow(alice, E18, USD(2000));
      await expect(vault.connect(alice).seize(alice.address, id, 1)).to.be.revertedWithCustomError(vault, "NotAuthorized");
      await expect(vault.connect(alice).release(alice.address, id)).to.be.revertedWithCustomError(vault, "NotAuthorized");
      await expect(pool.connect(alice).liquidate(alice.address, id)).to.be.revertedWithCustomError(pool, "NotAuthorized");
      await expect(pool.connect(alice).disburse(alice.address, 99, alice.address, 1)).to.be.revertedWithCustomError(pool, "NotAuthorized");
      // Right proxy, wrong reactive contract
      const p1 = vault.interface.encodeFunctionData("seize", [alice.address, id, 1]);
      await expect(baseProxy.execute(vault, alice.address, p1)).to.be.revertedWithCustomError(vault, "CallbackNotAuthorized");
      const p2 = pool.interface.encodeFunctionData("liquidate", [alice.address, id]);
      await expect(uniProxy.execute(pool, alice.address, p2)).to.be.revertedWithCustomError(pool, "CallbackNotAuthorized");
    });

    it("react() only accepts the system contract", async () => {
      const { alice, rc } = await setup();
      const log = { chainId: BASE, contractAddress: alice.address, topic0: 0, topic1: 0, topic2: 0, topic3: 0, data: "0x", blockNumber: 0, opCode: 0, blockHash: 0, txHash: 0, logIndex: 0 };
      await expect(rc.connect(alice).react(log)).to.be.revertedWithCustomError(rc, "NotAuthorized");
    });

    it("ignores look-alike events from other contracts and other chains", async () => {
      const { alice, pool, rc, system, borrow, toRecord } = await setup();
      const id = await borrow(alice, E18, USD(2000));
      const fake = await ethers.deployContract("PriceFeed", [PX(3000)]);
      await time.increase(31);
      const log = (await (await fake.post(PX(1600))).wait())!.logs[0];
      await system.deliver(await rc.getAddress(), toRecord(log, BASE)); // right chain, wrong contract
      const real = await ethers.getContractAt("PriceFeed", await rc.feed());
      await time.increase(31);
      const log2 = (await (await real.post(PX(1600))).wait())!.logs[0];
      await system.deliver(await rc.getAddress(), toRecord(log2, UNI)); // right contract, wrong chain
      expect(await rc.price()).to.equal(PX(3000));
      expect((await pool.loans(id)).status).to.equal(P.Active);
    });

    it("ignores replayed or out-of-order price rounds", async () => {
      const { alice, feed, rc, pool, system, borrow, setPrice, toRecord } = await setup();
      const id = await borrow(alice, E18, USD(2000));
      await time.increase(31);
      const old = (await (await feed.post(PX(2400))).wait())!.logs[0]; // round 2, not delivered yet
      await setPrice(PX(2900)); // round 3 delivered
      await system.deliver(await rc.getAddress(), toRecord(old, BASE)); // stale round 2 arrives late
      expect(await rc.price()).to.equal(PX(2900));
      expect((await pool.loans(id)).status).to.equal(P.Active);
    });

    it("idempotent callbacks: a duplicate seize can't move collateral twice", async () => {
      const { alice, treasury, weth, vault, rc, baseProxy, borrow, setPrice } = await setup();
      const id = await borrow(alice, E18, USD(2000));
      await setPrice(PX(2400));
      const before = await weth.balanceOf(treasury);
      const payload = vault.interface.encodeFunctionData("seize", [ethers.ZeroAddress, id, E18]);
      await baseProxy.execute(vault, await rc.getAddress(), payload);
      expect(await weth.balanceOf(treasury)).to.equal(before);
    });

    it(V2 ? "feed guardrails: bounds, max 50% move, one update per 30 s, no no-op updates" : "feed guardrails: bounds and max 50% move per update", async () => {
      const { feed } = await setup();
      if (V2) {
        await expect(feed.post(PX(2900))).to.be.revertedWithCustomError(feed, "TooSoon");
        await time.increase(31);
        await expect(feed.post(PX(3000))).to.be.revertedWithCustomError(feed, "NoChange");
      }
      await expect(feed.post(PX(1400))).to.be.revertedWithCustomError(feed, "MoveTooLarge");
      await expect(feed.post(PX(50))).to.be.revertedWithCustomError(feed, "OutOfBounds");
      await feed.post(PX(1600));
      const [round, answer] = await feed.latestRoundData();
      expect(round).to.equal(2n);
      expect(answer).to.equal(PX(1600));
    });
  });

  describe("gas", () => {
    it("worst-case sweep (50 open loans, 10 liquidations) stays under the 900k reactive cap", async () => {
      const { feed, system, rc, weth, vault, relay, toRecord } = await setup();
      const signers = (await ethers.getSigners()).slice(4, 20); // 16 borrowers x 3 loans + 2 = 50
      let n = 0;
      for (const s of signers) {
        await weth.connect(s).faucet();
        await weth.connect(s).approve(vault, E18);
        for (let k = 0; k < 3 && n < 50; k++, n++) await relay(vault.connect(s).lock(E18 / 10n, USD(200)));
      }
      expect(await rc.openTotal()).to.equal(48n);
      const extra = (await ethers.getSigners())[2]; // bob
      await weth.connect(extra).faucet();
      await weth.connect(extra).approve(vault, E18);
      await relay(vault.connect(extra).lock(E18 / 10n, USD(200)));
      await relay(vault.connect(extra).lock(E18 / 10n, USD(200)));
      expect(await rc.openTotal()).to.equal(50n);
      await time.increase(31);
      const log = (await (await feed.post(PX(2400))).wait())!.logs[0];
      const gas = await system.deliver.estimateGas(await rc.getAddress(), toRecord(log, BASE));
      console.log(`      sweep gas, 50 open / 10 liquidated: ${gas}`);
      expect(gas).to.be.lt(900_000n);
    });
  });
});

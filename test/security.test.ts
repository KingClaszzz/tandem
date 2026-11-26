import "@nomicfoundation/hardhat-chai-matchers";
import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { BASE, E18, P, PX, S, USD, V, setup } from "./helpers";

// The first deployment (archive/v1) is missing the properties marked `fixedInV2`; the current contracts have them.
// Run `SRC=archive/v1/contracts npx hardhat test` to see them as pending known issues on v1.
const V2 = !process.env.SRC || !process.env.SRC.includes("v1");
const fixedInV2 = V2 ? it : it.skip;

/** Properties the system must have. Each one is written as the behaviour we want, so a test that
 *  fails is a vulnerability, and a test that passes is a property we can rely on. */
describe("security properties", () => {
  describe("spam: making Reactive run is the one thing that costs the operator", () => {
    fixedInV2("a storm of price posts cannot trigger an unbounded number of reactions", async () => {
      const { feed } = await setup();
      let accepted = 0;
      for (let i = 0; i < 12; i++) {
        try { await feed.post(PX(i % 2 ? 3000 : 3100)); accepted++; } catch { /* rejected */ }
      }
      // Every accepted post is one reaction paid for by the reactive contract's lREACT.
      expect(accepted, "posts accepted back to back").to.be.lte(1);
    });

    fixedInV2("a post that changes nothing is rejected (it would only cost a reaction)", async () => {
      const { feed } = await setup();
      await time.increase(3600);
      await expect(feed.post(PX(3000))).to.be.reverted;
    });

    fixedInV2("the same account cannot post twice inside the cooldown, but can again after it", async () => {
      const { feed } = await setup();
      await time.increase(3600);
      await feed.post(PX(2900));
      await expect(feed.post(PX(2800))).to.be.reverted;
      await time.increase(3600);
      await feed.post(PX(2800));
    });
  });

  describe("input validation at the origin (reverting there costs Reactive nothing)", () => {
    fixedInV2("rejects a lock with an absurd borrow amount instead of stranding the collateral", async () => {
      const { alice, weth, vault, rc, system, toRecord } = await setup();
      await weth.connect(alice).faucet();
      await weth.connect(alice).approve(vault, E18);
      let accepted = true;
      let receipt;
      try { receipt = await (await vault.connect(alice).lock(E18, 2n ** 250n)).wait(); } catch { accepted = false; }
      if (!accepted) return; // refused at the origin: nothing can be stranded
      // If the vault accepted it, the reactive contract must at least be able to process the event,
      // otherwise the collateral is locked forever with Reactive never hearing about it.
      const log = receipt!.logs.find((l) => l.address === vault.target)!;
      await expect(system.deliver(await rc.getAddress(), toRecord(log, BASE)), "react() must not revert on a vault event").to.not.be.reverted;
    });

    fixedInV2("rejects loans below 50 tUSD and above the per-loan maximum", async () => {
      const { alice, weth, vault } = await setup();
      await weth.connect(alice).faucet();
      await weth.connect(alice).approve(vault, 2n * E18);
      await expect(vault.connect(alice).lock(E18, USD(10))).to.be.reverted;
      await expect(vault.connect(alice).lock(E18, USD(1_000_000))).to.be.reverted;
    });

    fixedInV2("rejects a 4th concurrent locked loan from the same address", async () => {
      const { alice, weth, vault, borrow } = await setup();
      for (let i = 0; i < 3; i++) await borrow(alice, E18 / 4n, USD(300));
      await weth.connect(alice).approve(vault, E18);
      await expect(vault.connect(alice).lock(E18 / 4n, USD(300))).to.be.reverted;
    });

    fixedInV2("rejects a lock once 50 loans are locked system-wide", async () => {
      const { weth, vault, relay } = await setup();
      const signers = await ethers.getSigners();
      let n = 0;
      for (const s of signers.slice(1, 20)) {
        if (n >= 50) break;
        await weth.connect(s).faucet();
        await weth.connect(s).approve(vault, 2n * E18);
        for (let k = 0; k < 3 && n < 50; k++, n++) await relay(vault.connect(s).lock(E18 / 10n, USD(100)));
      }
      expect(n).to.equal(50);
      const extra = signers[0];
      await weth.connect(extra).faucet();
      await weth.connect(extra).approve(vault, E18);
      await expect(vault.connect(extra).lock(E18 / 10n, USD(100))).to.be.reverted;
    });
  });

  describe("drain", () => {
    it("many sybil borrowers cannot pull the pool below its floor", async () => {
      const { pool, usd, weth, vault, relay } = await setup({ poolLiquidity: USD(500_000) });
      const signers = await ethers.getSigners();
      for (const s of signers.slice(4, 20)) {
        await weth.connect(s).faucet();
        await weth.connect(s).approve(vault, 2n * E18);
        for (let k = 0; k < 3; k++) {
          try { await relay(vault.connect(s).lock(E18 / 2n, USD(1000))); } catch { /* refused at the origin */ }
        }
      }
      const left = await usd.balanceOf(pool);
      // 50 open loans at the largest size the system allows can never take more than this.
      expect(left, "pool tUSD after the attack").to.be.gte(USD(500_000) - 50n * USD(5000));
    });

    it("a third party repaying a loan releases the collateral to its owner, not to the payer", async () => {
      const { alice, bob, weth, usd, pool, relay, borrow } = await setup();
      const id = await borrow(alice, E18, USD(2000));
      await usd.transfer(bob, USD(2000));
      await usd.connect(bob).approve(pool, USD(2000));
      const bobBefore = await weth.balanceOf(bob);
      await relay(pool.connect(bob).repay(id));
      expect(await weth.balanceOf(alice)).to.equal(2n * E18);
      expect(await weth.balanceOf(bob)).to.equal(bobBefore);
    });

    it("liquidation never seizes more than the collateral, nor less than min(collateral, debt + 5%)", async () => {
      const { alice, treasury, weth, borrow, setPrice, rc } = await setup();
      await borrow(alice, E18, USD(2000));
      await setPrice(PX(2100));
      const seized = await weth.balanceOf(treasury);
      expect(seized).to.be.lte(E18);
      const wanted = (USD(2000) * 100n * E18 * 10500n) / (PX(2100) * 10000n);
      expect(seized).to.equal(wanted < E18 ? wanted : E18);
      expect(await rc.openTotal()).to.equal(0n);
    });
  });
});

/* ------------------------------------------------------------------ randomised invariants */

function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("invariants under random sequences", () => {
  for (const seed of [11, 23, 37, 41, 59, 73]) {
    it(`seed ${seed}: borrow / repay / price moves / dropped callbacks / pokes`, async function () {
      this.timeout(600_000);
      const env = await setup();
      const { rc, weth, usd, pool, vault, feed, deployer, treasury, SEL } = env;
      const r = rng(seed);
      const users = (await ethers.getSigners()).slice(4, 12);
      const held = [SEL.disburse, SEL.liquidate, SEL.seize, SEL.release];
      const counts = { borrow: 0, repay: 0, post: 0, poke: 0, liquidated: 0 };
      const feedNow = async () => BigInt(await feed.latestAnswer());

      for (let step = 0; step < 40; step++) {
        const op = r();
        const hold = r() < 0.25 ? [held[Math.floor(r() * held.length)]] : [];
        try {
          if (op < 0.35) {
            const u = users[Math.floor(r() * users.length)];
            const coll = (BigInt(20 + Math.floor(r() * 400)) * E18) / 1000n;
            const price = Number(await rc.price()) / 1e8;
            const debt = BigInt(Math.floor((Number(coll) / 1e18) * price * (0.3 + 0.5 * r()))) * 1_000_000n;
            if (debt >= USD(50)) {
              if ((await weth.balanceOf(u)) < coll) { await time.increase(61); await weth.connect(u).faucet(); }
              await env.borrow(u, coll, debt, hold);
              counts.borrow++;
            }
          } else if (op < 0.5) {
            const n = Number(await vault.nextId());
            if (n > 0) {
              const id = BigInt(1 + Math.floor(r() * n));
              const l = await pool.loans(id);
              if (l.status === P.Active) {
                const owner = users.find((u) => u.address === l.borrower);
                if (owner) {
                  await usd.connect(owner).approve(pool, l.debt);
                  await env.relay(pool.connect(owner).repay(id), hold);
                  counts.repay++;
                }
              }
            }
          } else if (op < 0.75) {
            await time.increase(31);
            const now = await feedNow();
            const next = (now * BigInt(Math.round((0.55 + 0.9 * r()) * 1000))) / 1000n;
            if (next >= PX(100) && next <= PX(20000) && next !== now) { await env.relay(feed.post(next), hold); counts.post++; }
          } else if (op < 0.85) {
            await env.release();
          } else {
            await time.increase(61);
            const n = Number(await vault.nextId());
            for (let id = 1; id <= n; id++) {
              try { await env.poke(BigInt(id)); counts.poke++; } catch { /* nothing to retry, or too soon */ }
            }
          }
        } catch (e) {
          // An operation the contracts refuse (cooldown, caps, faucet limits) is fine; anything else is not.
          const m = String((e as Error).message);
          if (!/revert|TooSoon|reverted|NothingToRetry/i.test(m)) throw e;
        }
      }

      // Flush: deliver everything that is still in flight and let anyone poke what is stuck.
      for (let round = 0; round < 6; round++) {
        await env.release();
        await time.increase(61);
        const n = Number(await vault.nextId());
        for (let id = 1; id <= n; id++) { try { await env.poke(BigInt(id)); } catch { /* ok */ } }
      }
      await env.release();

      // ---- invariants
      const n = Number(await vault.nextId());
      const price = await rc.price();
      let lockedSum = 0n, open = 0, seized = 0;
      const openBy = new Map<string, number>();
      for (let id = 1; id <= n; id++) {
        const [v, p, c] = await Promise.all([vault.loans(id), pool.loans(id), rc.loans(id)]);
        const label = `loan ${id} (vault ${v.status}, pool ${p.status}, rc ${c.status})`;
        if (v.status === V.Locked) lockedSum += v.collateral;
        // never both outcomes
        expect(!(v.status === V.Seized && p.status === P.Repaid), `${label}: repaid and seized`).to.equal(true);
        expect(!(v.status === V.Released && p.status === P.Liquidated), `${label}: liquidated but released`).to.equal(true);
        // settled: final, or active and healthy
        const final = c.status === S.Released || c.status === S.Seized;
        const active = c.status === S.Active;
        expect(final || active, `${label}: not settled after flushing`).to.equal(true);
        if (c.status === S.Released) expect(v.status, `${label}: RC says released`).to.equal(V.Released);
        if (c.status === S.Seized) { expect(v.status, label).to.equal(V.Seized); expect(p.status, label).to.equal(P.Liquidated); seized++; }
        if (active) {
          expect(v.status, `${label}: active but collateral not locked`).to.equal(V.Locked);
          expect(p.status, `${label}: active but pool disagrees`).to.equal(P.Active);
          const healthy = BigInt(c.debt) * 100n * 10000n <= ((BigInt(c.collateral) * price) / E18) * 8000n;
          expect(healthy, `${label}: unhealthy loan left open`).to.equal(true);
          open++;
          openBy.set(c.borrower, (openBy.get(c.borrower) ?? 0) + 1);
        }
      }
      expect(await weth.balanceOf(vault), "vault holds exactly the locked collateral").to.equal(lockedSum);
      expect(await rc.openTotal(), "RC open counter").to.equal(BigInt(open));
      for (const [who, cnt] of openBy) expect(await rc.openBy(who), `openBy ${who}`).to.equal(BigInt(cnt));
      // token conservation
      const holders = [...users.map((u) => u.address), await vault.getAddress(), await pool.getAddress(), treasury.address, deployer.address];
      let wSum = 0n, uSum = 0n;
      for (const h of new Set(holders)) { wSum += await weth.balanceOf(h); uSum += await usd.balanceOf(h); }
      expect(wSum, "tWETH conserved").to.equal(await weth.totalSupply());
      expect(uSum, "tUSD conserved").to.equal(await usd.totalSupply());
      counts.liquidated = seized;
      console.log(`      seed ${seed}: ${n} loans, ${open} left active, ${seized} liquidated, ops`, JSON.stringify(counts));
    });
  }
});

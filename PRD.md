# Tandem — PRD

## One line
Borrow on one chain against collateral on another. Reactive Omni closes bad loans across both chains in about two seconds, with no liquidation bots.

## Event
Reactive Omni Buildathon (DoraHacks). Track: **Every Second Counts**.
Deadline: **2026-12-06 03:00 WIB** (page shows UTC+7). Internal target: submit by 2026-12-04.

Judging (1–5 each, equal weight):
- **Execution:** reactive txs and callbacks on-chain, or the entry is not scored.
- **Integration:** would it be simpler without Reactive?
- **Usefulness**
- **Craft:** code, demo, docs.

Track asks for latency numbers measured across the full loop.

Submission: public repo, deployed addresses, tx hashes for the full loop (origin event → reactive tx → callback), video < 3 min.

## Problem
Cross-chain lending (collateral on chain A, loan on chain B) is rarely built safely. The weak point is liquidation. When the collateral price drops, someone has to notice on A, act on B and seize on A before the position goes underwater. Today that takes an off-chain bot watching two chains, holding keys and gas on both, plus a bridge or messaging layer. Each part is slow, a trust assumption, or a point of failure. On the previous Reactive version (~7 s blocks), a loop was too slow for this. Omni has ~1 s blocks with instant finality.

## Solution
Three contracts and one Reactive contract:

| Chain | Contract | Role |
|---|---|---|
| Base Sepolia (84532) | `PriceFeed` | demo ETH/USD feed. Emits `PriceUpdated` |
| Base Sepolia | `CollateralVault` | holds tWETH. `lock` emits `CollateralLocked`. Callbacks: `release`, `seize` |
| Unichain Sepolia (1301) | `LendingPool` | holds tUSD liquidity. Callback `disburse` opens a loan. `repay` emits `Repaid`. Callback `liquidate` closes the loan, and then a repay is impossible |
| Reactive Lasna (5318007) | `TandemReactive` | mirrors every loan and the price. Decides and sends callbacks |

### Loops (each one is origin event → RC → callback)
1. **Borrow:** `CollateralLocked` (Base) → RC checks LTV against the last price → `LendingPool.disburse` (Unichain). If the LTV is too high, it calls `CollateralVault.release` (Base) instead.
2. **Repay:** `Repaid` (Unichain) → RC → `CollateralVault.release` (Base).
3. **Liquidation (the hero):** `PriceUpdated` (Base) → RC finds loans under the threshold → `LendingPool.liquidate` (Unichain) → `Liquidated` event → RC → `CollateralVault.seize` (Base).

Why liquidation does Unichain first: the loan's state lives on the debt chain. Once `liquidate` lands, a racing `repay` reverts, so a user can never repay *and* lose collateral.

### Risk parameters
- Max LTV to borrow: 70%.
- Liquidation threshold: 80%.
- The price has 8 decimals. tWETH has 18 decimals and tUSD has 6.

## Users and the demo
- **Borrower:** lock tWETH on Base and receive tUSD on Unichain, with no bridge.
- **Lender or protocol:** gets solvent loans without running a keeper.
- **Judge:**
  - Open the app with a wallet on the testnets.
  - Mint test tokens.
  - Borrow.
  - Press "Crash price".
  - Watch the timeline fill with three tx links across three chains, with measured seconds.

## Proof plan (evidence a judge can see)
- Deployed and verified addresses for all 4 contracts in the README.
- A `scripts/bench` run of N ≥ 30 liquidation loops, recording these wall-clock times (ms):
  - price tx mined on Base
  - RC tx on Lasna
  - `liquidate` mined on Unichain
  - `seize` mined on Base

  Report p50, p95 and max for each hop and for the total. Commit the raw JSON and a table to the README.
- Tx hashes for one full loop of each kind.
- Unit tests for every contract, with the system contract and callback proxy mocked.

## Scope: must have
- [ ] Contracts plus unit tests (Hardhat, Solidity 0.8.29, reactive-lib-omni copied into `contracts/reactive-lib`).
- [ ] Deploy scripts for 3 chains, writing addresses to `deployments.json`.
- [ ] Web app (Vite, React, TS, viem):
  - landing page
  - app: connect wallet, faucet, borrow, repay, crash/restore price, live loop timeline with explorer links, latency panel
- [ ] Bench script and results.
- [ ] README, video, and submission.

## Nice to have
- Partial liquidation and a liquidation bonus.
- A position list that shows the health of every borrower.
- Mainnet note (not deployed).

## Non-goals
- A real oracle. The demo feed is settable on purpose, and this is stated in the README.
- Real money.
- Interest rates (fixed 0% for the demo, stated).

## Honest limits to state
- Test tokens and a settable demo price feed.
- The RC holds the loan list in its own storage. The cap is a max of 25 active loans per sweep, because the gas cap per reactive tx is 900k.
- Latency depends on public testnet RPCs. We report what we measured, when we measured it, and how.

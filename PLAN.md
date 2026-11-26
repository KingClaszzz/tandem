# PLAN — Tandem (deadline 2026-12-06 03:00 WIB, target submit 2026-12-04)

Status legend: [ ] todo · [~] in progress · [x] done (verified)

## Day 1–2 (Nov 25–26): contracts
- [x] Hardhat project, vendored reactive-lib-omni, solc 0.8.29
- [x] TestToken, PriceFeed, CollateralVault, LendingPool, TandemReactive
- [x] Mocks: MockSystem (records subscriptions and callback requests), MockProxy (calls the callbacks with the RC address injected)
- [x] Unit tests: borrow ok, borrow over LTV gets a refund, repay releases, crash liquidates (Unichain first, then seize), a repay after liquidation reverts, unauthorized callers are rejected, gas cap on the sweep

## Day 2–3 (Nov 26–27): testnet (needs the user)
- [x] User: fresh testnet wallet, ETH on Base Sepolia + Unichain Sepolia, lREACT from the faucet, key in `.env`
- [x] Deployed 2026-11-25 (deployments.json): RC on Lasna → tokens/feed/vault on Base → token/pool on Unichain → `rc.configure` → funded
- [x] First real loop of each kind (borrow, repay, refused, liquidation) with tx hashes in `evidence/smoke-*.json`

## Day 3–6 (Nov 27–30): app
- [x] Landing (hero with a live loop diagram, how it works, proof numbers, CTA)
- [x] UI rebuilt on the final contracts (2026-11-26): landing (ASCII hero, 3-loop explainer, measured-latency strip plot, run explorer, contracts, threat table) and console (price ruler with liquidation ticks, borrow form, live loop trace, loans ledger, poke). Verified end to end on testnets through the real UI (borrow -> crash -> seize -> reset, 3 txs, no console errors).
- [ ] Deploy to Vercel

## Day 6–7 (Dec 1–2): proof
- [~] Bench script written (scripts/bench.ts); run N≥30 liquidation loops, results JSON + README table
- [ ] README with addresses, tx hashes, how to run

## Day 8 (Dec 3): video + submit
- [ ] Video < 3 min (hook, problem, live demo, latency proof, try it)
- [ ] DoraHacks form, then submit on Dec 4

## Log
- 2026-11-25: research done, idea chosen (cross-chain lending with keeperless liquidation, ESC track). Foundry binary download was blocked, so we switched to Hardhat.
- 2026-11-25: 5 contracts + mocks, 13 tests passing (25-loan sweep = 505k gas). Deploy/check/get-lreact/bench scripts. Web landing + dashboard built (Inter/JetBrains Mono, dark, three-lane loop trace). Waiting on the user's testnet wallet to deploy.
- 2026-11-25: System redesign before deploy (docs/DESIGN.md):
  - acknowledged state machine (Released and Seized only after destination events)
  - poke() retries
  - seize = debt + 5%, with the remainder going to the borrower
  - Chainlink-compatible feed with round ordering and 50% move guard
  - anti-griefing caps; 10 liquidations per sweep

  27 tests passing. Deployed to the 3 testnets. Smoke ran all 4 loops on-chain: liquidation crash → seized in 4.3 s.
- 2026-11-26: UI redesign. Live trace now polls all three chains in parallel: a UI-driven crash to seize showed 3.2 s, in line with the bench (p50 4.4 s). 6 UI logic tests. Still to do: README (root), video, Vercel deploy, DoraHacks form.
- 2026-11-26: Security pass. White-box review, attack tests, randomised invariants (6 seeds), black-box UI failure injection (10 scenarios), live end-to-end. Findings: unbounded reaction spam through PriceFeed.post(), vault accepting loans Reactive later refuses, react() revert on an absurd borrow amount, viem retrying wallet sends. Web fixes are live in web/. Contract fixes are in contracts-v2/ (42 tests pass: `SRC=contracts-v2 npx hardhat test`) and need a redeploy plus a fresh bench before they replace the deployed v1. Default `npx hardhat test` runs against the deployed v1 and fails the 9 tests that encode the fixes, on purpose.
- 2026-11-26: Option A done. Hardened contracts promoted to contracts/ and deployed (verified exact match on Sourcify); v1 archived in archive/v1. Smoke ran all loops; 15-run bench: median 3.89 s, p95 4.89 s. Console rebuilt (light theme, grouped navigation, next-step guide, plain-language borrow summary); landing gained live strip, why-Reactive, audience, architecture, tested carousel, roadmap, FAQ, custom cursor and scroll progress.

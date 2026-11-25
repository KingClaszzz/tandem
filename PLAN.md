# PLAN — Tandem (deadline 2026-12-06 03:00 WIB, target submit 2026-12-04)

Status legend: [ ] todo · [~] in progress · [x] done (verified)

## Day 1–2 (Nov 25–26): contracts
- [x] Hardhat project, vendored reactive-lib-omni, solc 0.8.29
- [x] TestToken, PriceFeed, CollateralVault, LendingPool, TandemReactive
- [x] Mocks: MockSystem (records subscriptions and callback requests), MockProxy (calls the callbacks with the RC address injected)
- [x] Unit tests: borrow ok, borrow over LTV gets a refund, repay releases, crash liquidates (Unichain first, then seize), a repay after liquidation reverts, unauthorized callers are rejected, gas cap on the sweep

## Day 2–3 (Nov 26–27): testnet (needs the user)
- [ ] User: fresh testnet wallet, ETH on Base Sepolia + Unichain Sepolia, lREACT from the faucet, key in `.env`
- [x] Deploy script (written, not run yet): RC on Lasna → vault/feed/tokens on Base → pool/token on Unichain → `rc.setDestinations` → fund
- [ ] First real loop of each kind with tx hashes recorded in `evidence/`

## Day 3–6 (Nov 27–30): app
- [x] Landing (hero with a live loop diagram, how it works, proof numbers, CTA)
- [~] App: wallet, network switch, faucet, borrow/repay, crash/restore, live timeline, latency panel, positions
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

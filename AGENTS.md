# AGENTS.md — read this first

This file is for an AI coding agent picking up the Tandem project. Read `PRD.md` for the product, `docs/DESIGN.md` for the state machine and threat model (code must match it), and `PLAN.md` for status.

## Who does what
- The user is a student who sets the direction. The agent builds everything.
- The user runs `git push` and anything that needs a private key or wallet.
- The user does all git commits and pushes. The agent does not commit.
- Live end-to-end runs (`e2e-live.mjs`) each cost about 0.07 lREACT. The reactive contract has little fuel, so run them sparingly and check `npm run status` before and after.
- The agent never types, stores or prints private keys. Keys live in `.env`, which is gitignored, and the user fills them in.
- Chat with the user in casual Indonesian. Write everything judges read (README, UI copy, video, form) in plain English with no hype words.

## Layout
```
omni/
  AGENTS.md  PRD.md  PLAN.md
  contracts/            Solidity 0.8.29
    reactive-lib/       vendored copy of Reactive-Network/reactive-lib-omni (src/)
    TandemReactive.sol  runs on Reactive Lasna
    CollateralVault.sol PriceFeed.sol TestToken.sol   (Base Sepolia)
    LendingPool.sol                                    (Unichain Sepolia)
    test/               mocks for the system contract and callback proxy
  test/                 Hardhat tests
  scripts/              check · get-lreact · bridge-uni · fund-rc · deploy · smoke (all loops once) · bench (latency) · status (health, --poke) · lib/loop helpers
  deployments.json      addresses per chain (deploy script writes it here and to web/src/)
  evidence/             raw bench runs (JSON) with tx hashes
  web/                  Vite + React + TS + viem app: landing (#/) and console (#/app)
    src/chain.ts        ABIs, addresses, constants mirrored from the contracts
    src/market.ts       reads from the 3 chains; live loop tracker (parallel event buffer)
    src/bench.ts        typed view of src/bench.json (real runs, published by scripts/publish.ts)
    src/ui.tsx          nav pill, ASCII field, Scramble, LoopTrace; CSS: index/landing/app/console.css
    src/Dashboard.tsx   wallet gate (no console without a connected wallet; Disconnect returns to #/) + console shell: actions (one at a time), routing between views
    src/Guide.tsx, src/Tour.tsx   #/guide page and the first-visit spotlight tour (flag tandem:tour-seen)
    src/views/          Overview, Borrow, Positions, Risk, Latency, Activity, System, LiveLoop, ctx.ts
    src/activity.ts     live event feed + price history; src/stats.ts, src/charts.tsx, src/format.ts
  archive/v1/           the first deployment: contracts, addresses, evidence, bench (kept as evidence, superseded)
  ref-lib/              upstream clone, reference only (gitignored)
```

## Reactive Omni facts (checked 2026-11-25)
- The RVM is gone. Subscribe with `SYSTEM.subscribe(chainId, contract, t0, t1, t2, t3)`. `SYSTEM` is `0x8888…8888`. Tandem subscribes inside `configure()` (not the constructor), because the destinations are deployed after the RC. Verified on Lasna on 2026-11-25: the system contract emitted 8 subscription events and every loop ran.
- `react(LogRecord calldata)` is guarded by `onlySystem`. LogRecord fields are `topic0..topic3`.
- Callbacks: `SYSTEM.requestCallbackV_1_0(CallbackConfiguration_V_1_0{chainId, recipient, gasLimit, payload})`.
  - The minimum gas limit is 100k (lower values are silently dropped). Use 400k–1M.
  - The first payload argument is an `address` slot. The proxy overwrites it with the RC address. Encode it as `address(0)`.
- Destination contracts extend `AbstractCallback(callbackProxy, rcAddress)`. Guard each callback with `onlyServiceProvider onlyCallbackSender(sender)`. `_CALLBACK_SENDER` is immutable, so deploy the RC first and the destinations after it. The RC learns the addresses through the owner-only, one-time `configure(feed, vault, pool, price)`.
- Callback proxies:
  - Base Sepolia `0x476F44b11F5C942c58f4c8E3d0300E5710743585`
  - Unichain Sepolia `0x775c9B990ADe401060B78D0e98684eEf8d2466C1`
- Lasna:
  - chain 5318007
  - RPC `https://lasna-rpc.rnk.dev/`
  - explorer `https://lasna.reactscan.net/`
- Fees:
  - The RC pays in lREACT. Fund it with a payable constructor or `SYSTEM.depositTo(rc)`.
  - Callbacks are paid by the destination contract in destination ETH. Fund the destinations.
  - Any debt stops delivery. Expose `coverDebt()`.
  - Base contracts are not payable, so add `payable` yourself.
- The gas cap per reactive tx is 900k.
- Lasna rejects txs with a zero priority fee, which is what its RPC suggests. `scripts/lib.ts` (`LasnaProvider`) forces at least 1 gwei.
- Measured costs (2026-11-25):
  - about 0.017 lREACT per reactive execution
  - about 2e-6 ETH per callback on Base and Unichain
  - so one bench run (6 reactions) costs about 0.1 lREACT
- - Scripts that post prices wait for the feed's 30 s cooldown (`waitForFeedSlot` in scripts/loop.ts), so a bench of 15 runs takes about 20 minutes.
- The OP Stack bridge deposit (Sepolia → Unichain) needs about 665k gas. Always estimate it.
- Base Sepolia makes 200 ms blocks. Use timestamps, never block counts.
- lREACT faucet: send Sepolia ETH to `0x9b9BB25f1A81078C544C829c5EB7822d747Cf434`, or Base Sepolia ETH to `0x2afaFD298b23b62760711756088F75B7409f5967`, calling `request(address)`. The rate is 1 ETH = 100 lREACT. Never send more than 5 ETH in one tx.

## Commands (repo root)
- `npm test`: 27 contract tests
- `npm run status`: health of every loan across 3 chains
- `npm run smoke`: every loop once, on testnet
- `npm run bench -- 15`: latency runs, then `npm run publish` copies them to the website
- `npm run guard`, `npm run set-price -- 3000`: keep the demo funded and reset the price
- `npx hardhat test`: 42 tests on the current contracts. `SRC=archive/v1/contracts npx hardhat test` runs the same suite on the first deployment (7 show as pending known issues)
- `cd web && node scripts/e2e-failures.mjs`: 12 browser scenarios with a misbehaving wallet, no transactions
- `cd web && npm run snippets`: regenerates the landing page's code excerpts and interface lists from the contracts and ABIs. Run it after changing a contract or recompiling.
- `cd web && npm test` (UI logic), `npm run build`, `node scripts/e2e-live.mjs` (drives the real UI on testnets with a fake wallet signing from `.env`; costs about 0.2 lREACT)

## Rules
- Never fake numbers, tx hashes or results. Latency figures come only from `scripts/bench` output files.
- Never put secrets in the client, the repo or a commit. Scan before each commit.
- Keep the code lean and the comments rare and useful.
- UI: no AI slop. Design language (reactive.network reference): pure black, hairline rules instead of cards, weight-300 headlines that decode on scroll, `//` and `[ ]` mono labels, ASCII field, nav that becomes a pill on scroll, `[+]`/`[>]` step lists. Chain colors: Base blue, Lasna cyan, Unichain pink. Do not add gradients, glow orbs, icon-card grids, emoji, or anything that follows the pointer around the screen (the user rejected a round cursor). Hover effects must link a claim to its proof: code line ↔ note, threat ↔ test, hop ↔ bar.
  - Reference the reactive.network / DoraHacks feel: dark, precise, monospace data, restrained motion, real hover states.
  - Respect `prefers-reduced-motion`.
- Before saying something works, run it: unit tests, a build, and for on-chain work a real tx with its hash.
- Toolchain: Hardhat via npm. Native Foundry binaries could not be installed in this environment.

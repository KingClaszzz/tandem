# AGENTS.md — read this first

This file is for an AI coding agent picking up the Tandem project. Read `PRD.md` for the product and `PLAN.md` for status.

## Who does what
- The user is a student who sets the direction. The agent builds everything.
- The user runs `git push` and anything that needs a private key or wallet.
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
  scripts/              check, get-lreact, deploy, bench (latency), lib
  deployments.json      addresses per chain (deploy script writes it here and to web/src/)
  evidence/             raw bench runs (JSON) with tx hashes
  web/                  Vite + React + TS + viem app (landing + /app)
  ref-lib/              upstream clone, reference only (gitignored)
```

## Reactive Omni facts (checked 2026-11-25)
- The RVM is gone. Subscribe with `SYSTEM.subscribe(chainId, contract, t0, t1, t2, t3)`. `SYSTEM` is `0x8888…8888`. Tandem subscribes inside `configure()` (not the constructor), because the destinations are deployed after the RC. Verify on Lasna that this works.
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
- Base Sepolia makes 200 ms blocks. Use timestamps, never block counts.
- lREACT faucet: send Sepolia ETH to `0x9b9BB25f1A81078C544C829c5EB7822d747Cf434`, or Base Sepolia ETH to `0x2afaFD298b23b62760711756088F75B7409f5967`, calling `request(address)`. The rate is 1 ETH = 100 lREACT. Never send more than 5 ETH in one tx.

## Rules
- Never fake numbers, tx hashes or results. Latency figures come only from `scripts/bench` output files.
- Never put secrets in the client, the repo or a commit. Scan before each commit.
- Keep the code lean and the comments rare and useful.
- UI: no AI slop.
  - Reference the reactive.network / DoraHacks feel: dark, precise, monospace data, restrained motion, real hover states.
  - Respect `prefers-reduced-motion`.
- Before saying something works, run it: unit tests, a build, and for on-chain work a real tx with its hash.
- Toolchain: Hardhat via npm. Native Foundry binaries could not be installed in this environment.

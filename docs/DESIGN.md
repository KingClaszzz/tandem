# Tandem system design

This is the source of truth for how the contracts behave. Code follows this document; if they disagree, fix one of them on purpose.

## 1. Components

| Chain | Contract | Holds | Trusts |
|---|---|---|---|
| Base Sepolia (84532) | `PriceFeed` | ETH/USD answer, rounds | nobody (demo: anyone can post within guardrails) |
| Base Sepolia | `CollateralVault` | borrowers' tWETH | Base callback proxy + `TandemReactive` address |
| Unichain Sepolia (1301) | `LendingPool` | lenders' tUSD, loan book (source of truth for debt) | Unichain callback proxy + `TandemReactive` address |
| Reactive Lasna (5318007) | `TandemReactive` (RC) | a mirror of every loan + last price | Reactive system contract (`0x8888…`) for `react()`; its own owner once for `configure()` |

There is no database and no server. All state is on-chain. The web app reads the chains directly. Off-chain scripts (`status`, `bench`) only read, or send the same public txs a user could send.

## 2. Price source

`PriceFeed` emits the Chainlink OCR event `AnswerUpdated(int256 indexed current, uint256 indexed roundId, uint256 updatedAt)` and implements `latestRoundData()`. The RC only depends on that event, so on a real network it can subscribe to a Chainlink aggregator without code changes.

**Demo guardrails.** Anyone can post a price, so judges can trigger a liquidation. Each update must:
- stay within $100–$20,000
- move at most 50% from the previous answer
- come at least 30 seconds after the previous update, from anyone, and change the price. Every update makes the reactive contract run once and the operator pays for each run, so this is what bounds the cost of spam: at most 2 reactions a minute.

The README states plainly that this is a demo feed.

**RC rule:** ignore any `roundId` that is not greater than the last one seen. This makes the RC robust to replays and out-of-order delivery.

## 3. Loan state machine (as mirrored in the RC)

```
              CollateralLocked (Base)
                     │ LTV ≤ 70%, size ok, slots free → request disburse
                     │ otherwise                      → request release
                     ▼
   ┌────────── PENDING ───────────┐
   │ BorrowRejected (Uni)         │ Disbursed (Uni)
   ▼                              ▼
RELEASING ◄──── Repaid (Uni) ── ACTIVE ── price makes LTV > 80% → request liquidate
   │                              │                                     │
   │ CollateralReleased (Base)    │ Repaid (Uni) (wins a race)          ▼
   ▼                              └───────────────────────────── LIQUIDATING
RELEASED (final)                                                        │ Liquidated (Uni)
                                                                        ▼  → request seize(amount)
                                                                     SEIZING
                                                                        │ CollateralSeized (Base)
                                                                        ▼
                                                                     SEIZED (final)
```

Every outgoing request is matched by an event the RC subscribes to. A loan is only final when the destination chain confirms it:
- `Disbursed` or `BorrowRejected`
- `Liquidated`
- `CollateralReleased` or `CollateralSeized`

## 4. Ordering and race rules
1. **Debt chain first.** Liquidation goes `liquidate()` on Unichain → `Liquidated` → `seize()` on Base. After `liquidate()` the pool rejects `repay()`. A borrower can therefore never both repay and lose collateral.
2. **Repay racing a liquidation.**
   - If `repay()` lands before `liquidate()`, the pool's `liquidate()` is a no-op. The RC sees `Repaid` and releases the collateral.
   - If `liquidate()` lands first, `repay()` reverts.

   Exactly one of the two happens.
3. **All callbacks are idempotent.** Each destination checks the loan's status before acting:
   - `disburse` only from None
   - `liquidate` only from Active
   - `release` and `seize` only from Locked

   Re-sending a callback can never double-pay or double-seize.

## 5. Liquidation economics
At the price `P` that triggered the liquidation:

`seize = min(collateral, debt × (1 + 5% penalty) / P)`

- `seize` goes to the treasury.
- The remainder goes back to the borrower in the same `seize()` call.
- The borrower keeps the borrowed tUSD.

The pool writes the debt off. The treasury's seized tWETH on Base is the reserve backing that write-off. Moving it back to Unichain is out of scope and stated in the README.

## 6. Liveness: no keeper needed, anyone can unstick
Callbacks can fail, for example when a destination contract runs out of callback funds. The RC records `lastRequest` per loan.

`poke(loanId)` is **public**. If the loan is in a non-final state and at least `RETRY_AFTER` (60 s) has passed since the last request, it re-sends the pending callback:

| State | Re-sends |
|---|---|
| PENDING | disburse |
| LIQUIDATING | liquidate |
| SEIZING | seize |
| RELEASING | release |
| ACTIVE (unhealthy at the RC price) | liquidate |

Because the callbacks are idempotent, a poke is always safe. The rate limit stops anyone from draining the RC's lREACT by spamming.

## 7. Bounded work (900k gas per reactive tx)

Limits that a revert can enforce are enforced **at the origin**, in `CollateralVault.lock()`, because a revert there costs Reactive nothing. A request refused later by the reactive contract has already cost one paid reaction and a paid release callback.
- loan size 50 to 5,000 tUSD, at most 3 locked loans per wallet and 50 in total (vault)
- the reactive contract also range-checks what it decodes (collateral and debt fit in 128 bits), so `react()` cannot revert on an event it accepts
- `MAX_ACTIVE = 50` open loans in the RC.
- A price update liquidates at most `MAX_LIQ_PER_SWEEP = 10` loans. Any unhealthy loans left over are caught on the next price update, or by `poke`.
- Anti-griefing:
  - minimum debt of 50 tUSD
  - at most 3 open loans per borrower

## 8. Threat model

| Threat | Mitigation |
|---|---|
| Fake callback (someone calls `seize`/`release`/`liquidate`/`disburse`) | `onlyServiceProvider` (callback proxy) + `onlyCallbackSender` (RC address injected by the proxy) |
| Fake event (look-alike contract emits `AnswerUpdated`/`Repaid`) | RC checks `log.chainId` and `log.contractAddress` against the configured addresses. Subscriptions are filtered by contract too |
| Direct call to `react()` | `onlySystem` |
| RC re-wired by the owner | `configure()` is one-time. The owner has no other power: no pause, no withdraw, no upgrade |
| Double outcome (repay and seize) | §4 ordering + idempotent callbacks |
| Replay or old price | monotonic `roundId` |
| Stuck funds after a failed callback | §6 `poke` |
| Gas-cap DoS from many loans | §7 caps |
| Callback debt halts delivery | contracts are funded at deploy. `coverDebt()` is public. The `status` script shows balances and debts |
| Price manipulation | Demo only: the public feed is the point of the demo. On a real network, point the RC at a Chainlink aggregator (same event) |
| Reentrancy | test tokens have no hooks. Checks-effects-interactions everywhere. Status is set before transfers |
| Spam on the feed or the vault makes Reactive spend its fuel | Feed: one update per 30 s, no-op updates rejected. Vault: size, per-wallet and global limits checked at the origin. Fuel is visible in the console and `npm run guard` tops it up. A determined attacker is slowed, not stopped; the real fix is a fee per loan (not built) |
| `react()` reverting on a hostile amount | Origin limits plus a range check in the reactive contract |

## 9. Known limits (stated in the README)
- Test tokens, demo price feed, 0% interest, full repay only.
- Seized collateral stays on Base. There is no cross-chain settlement of the reserve.
- One collateral asset and one debt asset.

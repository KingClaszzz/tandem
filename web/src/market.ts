import { useCallback, useEffect, useRef, useState } from "react";
import { formatUnits, type Address } from "viem";
import { ADDR, PROXY, SYSTEM, abi, client, debtAbi, deployed, LIQ_THRESHOLD, RC, type Lane } from "./chain";

/* ------------------------------------------------------------------ types and pure helpers */

export type Loan = {
  id: bigint;
  owner: Address;
  collateral: number; // tWETH
  debt: number; // tUSD
  vault: number; // 0 None, 1 Locked, 2 Released, 3 Seized
  pool: number; // 0 None, 1 Active, 2 Repaid, 3 Liquidated, 4 Rejected
  rc?: number; // reactive contract status, read for loans whose collateral is still locked
  lastRequest?: number; // unix seconds of the last callback request
  seized?: number; // tWETH the treasury took when this loan was liquidated
};

export type Stage = "waiting" | "active" | "liquidating" | "seizing" | "releasing" | "repaid" | "refused" | "rejected" | "seized";

export const STAGE_LABEL: Record<Stage, string> = {
  waiting: "Waiting for Reactive",
  active: "Active",
  liquidating: "Liquidating",
  seizing: "Seizing collateral",
  releasing: "Releasing collateral",
  repaid: "Repaid",
  refused: "Refused",
  rejected: "Rejected",
  seized: "Liquidated",
};

export const isOpen = (s: Stage) => s === "active" || s === "waiting" || s === "liquidating";
export const isFinal = (s: Stage) => s === "repaid" || s === "refused" || s === "rejected" || s === "seized";

export function stageOf(l: Loan): Stage {
  if (l.vault === 3) return "seized";
  if (l.vault === 2) return l.pool === 4 ? "rejected" : l.pool === 2 ? "repaid" : "refused";
  switch (l.rc) {
    case RC.Pending: return "waiting";
    case RC.Active: return "active";
    case RC.Liquidating: return "liquidating";
    case RC.Seizing: return "seizing";
    case RC.Releasing: return "releasing";
  }
  if (l.pool === 1) return "active";
  if (l.pool === 3) return "seizing";
  if (l.pool === 2 || l.pool === 4) return "releasing";
  return "waiting";
}

export const ltv = (l: Pick<Loan, "collateral" | "debt">, price: number) => (l.collateral > 0 && price > 0 ? l.debt / (l.collateral * price) : 0);
/** ETH price at which this loan crosses the liquidation threshold. */
export const liqPrice = (l: Pick<Loan, "collateral" | "debt">) => (l.collateral > 0 ? l.debt / (l.collateral * LIQ_THRESHOLD) : 0);
/** Loans that a price update to `price` would liquidate (the contract caps a sweep at 10). */
export const wouldLiquidate = (loans: Loan[], price: number) =>
  loans.filter((l) => stageOf(l) === "active" && ltv(l, price) > LIQ_THRESHOLD);

/* ------------------------------------------------------------------ chain reads */

export type Me = { weth?: number; usd?: number; ethBase?: number; ethUni?: number; nextDrip?: number };
export type Market = {
  price?: number;
  round?: number;
  rcPrice?: number;
  rcRound?: number;
  open?: number;
  liquidity?: number;
  tvlWeth?: number; // tWETH held by the vault: exactly the collateral still locked
  loans: Loan[];
  me: Me;
  updatedAt?: number;
  error?: string;
};

const MAX_LOANS = 120;
const n6 = (x: bigint) => Number(formatUnits(x, 6));
const n8 = (x: bigint) => Number(formatUnits(x, 8));
const n18 = (x: bigint) => Number(formatUnits(x, 18));

async function readMe(a: Address): Promise<Me> {
  const [[weth, drip, ethBase], [usd, ethUni]] = await Promise.all([
    Promise.all([
      client.base.readContract({ address: ADDR.weth, abi: abi.token, functionName: "balanceOf", args: [a] }),
      client.base.readContract({ address: ADDR.weth, abi: abi.token, functionName: "lastDrip", args: [a] }),
      client.base.getBalance({ address: a }),
    ]),
    Promise.all([
      client.uni.readContract({ address: ADDR.usd, abi: abi.token, functionName: "balanceOf", args: [a] }),
      client.uni.getBalance({ address: a }),
    ]),
  ]);
  return { weth: n18(weth), usd: n6(usd), ethBase: n18(ethBase), ethUni: n18(ethUni), nextDrip: drip > 0n ? Number(drip) + 60 : 0 };
}

// A finished loan never changes, so what the reactive contract recorded as seized is read once per loan.
const SEIZED = new Map<string, number>();

export function useMarket(account?: Address, intervalMs = 2500) {
  const [m, setM] = useState<Market>({ loans: [], me: {} });
  const busy = useRef(false);

  const refresh = useCallback(async (): Promise<boolean> => {
    if (!deployed || busy.current) return true;
    busy.current = true;
    try {
      const [[price, round, nextId, vaultWeth], [liquidity], rcState, me] = await Promise.all([
        client.base.multicall({
          allowFailure: false,
          contracts: [
            { address: ADDR.feed, abi: abi.feed, functionName: "latestAnswer" },
            { address: ADDR.feed, abi: abi.feed, functionName: "latestRound" },
            { address: ADDR.vault, abi: abi.vault, functionName: "nextId" },
            { address: ADDR.weth, abi: abi.token, functionName: "balanceOf", args: [ADDR.vault] },
          ],
        }),
        client.uni.multicall({ allowFailure: false, contracts: [{ address: ADDR.pool, abi: abi.pool, functionName: "liquidity" }] }),
        Promise.all([
          client.lasna.readContract({ address: ADDR.rc, abi: abi.rc, functionName: "price" }),
          client.lasna.readContract({ address: ADDR.rc, abi: abi.rc, functionName: "lastRound" }),
          client.lasna.readContract({ address: ADDR.rc, abi: abi.rc, functionName: "openTotal" }),
        ]).catch(() => undefined),
        account ? readMe(account) : Promise.resolve({} as Me),
      ]);

      const first = nextId > BigInt(MAX_LOANS) ? nextId - BigInt(MAX_LOANS) + 1n : 1n;
      const ids: bigint[] = [];
      for (let i = nextId; i >= first && i > 0n; i--) ids.push(i);

      const [vaultRows, poolRows] = ids.length
        ? await Promise.all([
            client.base.multicall({ allowFailure: false, contracts: ids.map((id) => ({ address: ADDR.vault, abi: abi.vault, functionName: "loans", args: [id] }) as const) }),
            client.uni.multicall({ allowFailure: false, contracts: ids.map((id) => ({ address: ADDR.pool, abi: abi.pool, functionName: "loans", args: [id] }) as const) }),
          ])
        : [[], []];

      const loans: Loan[] = ids.map((id, i) => {
        const [owner, collateral, vs] = vaultRows[i] as readonly [Address, bigint, number];
        const [, debt, ps] = poolRows[i] as readonly [Address, bigint, number];
        return { id, owner, collateral: n18(collateral), debt: n6(debt), vault: vs, pool: ps };
      });

      for (const l of loans) if (l.vault === 3) l.seized = SEIZED.get(l.id.toString());
      await Promise.all(
        loans.filter((l) => l.vault === 3 && !SEIZED.has(l.id.toString())).slice(0, 40).map(async (l) => {
          try {
            const r = await client.lasna.readContract({ address: ADDR.rc, abi: abi.rc, functionName: "loans", args: [l.id] });
            SEIZED.set(l.id.toString(), n18(r[5]));
            l.seized = SEIZED.get(l.id.toString());
          } catch { /* shown as unknown until the next read */ }
        }),
      );

      // Lasna has no multicall: ask the reactive contract only about loans whose collateral is still locked.
      const locked = loans.filter((l) => l.vault === 1).slice(0, 20);
      await Promise.all(
        locked.map(async (l) => {
          try {
            const r = await client.lasna.readContract({ address: ADDR.rc, abi: abi.rc, functionName: "loans", args: [l.id] });
            l.rc = r[2];
            l.lastRequest = Number(r[1]);
            // Debt as the reactive contract mirrors it: the pool shows 0 until disbursed.
            if (!l.debt) l.debt = n6(r[4]);
          } catch { /* leave undefined: stage falls back to the pool state */ }
        }),
      );

      setM({
        price: n8(price),
        round: Number(round),
        rcPrice: rcState ? Number(formatUnits(rcState[0], 8)) : undefined,
        rcRound: rcState ? Number(rcState[1]) : undefined,
        open: rcState ? Number(rcState[2]) : undefined,
        liquidity: n6(liquidity),
        tvlWeth: n18(vaultWeth),
        loans,
        me,
        updatedAt: Date.now(),
      });
      return true;
    } catch (e) {
      setM((s) => ({ ...s, error: `Could not read the chains: ${((e as Error).message ?? "").split("\n")[0].slice(0, 100)}. Retrying.` }));
      return false;
    } finally {
      busy.current = false;
    }
  }, [account]);

  // Poll politely: stop while the tab is hidden, and back off (up to 16x) while the public RPCs are failing.
  useEffect(() => {
    let on = true, timer: ReturnType<typeof setTimeout>, fails = 0;
    const loop = async () => {
      if (!on) return;
      if (!document.hidden) fails = (await refresh()) ? 0 : Math.min(fails + 1, 4);
      timer = setTimeout(loop, intervalMs * 2 ** fails);
    };
    const onVisible = () => { if (!document.hidden) { clearTimeout(timer); fails = 0; loop(); } };
    loop();
    document.addEventListener("visibilitychange", onVisible);
    return () => { on = false; clearTimeout(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [refresh, intervalMs]);

  return { ...m, refresh };
}

/** Latest block number of each chain, polled. Works without a wallet or a deployment. */
export function useBlocks(intervalMs = 3000) {
  const [b, setB] = useState<Partial<Record<Lane, bigint>>>({});
  useEffect(() => {
    let on = true;
    const tick = async () => {
      if (document.hidden) return;
      const r = await Promise.allSettled((["base", "lasna", "uni"] as Lane[]).map((l) => client[l].getBlockNumber()));
      const v = (x: PromiseSettledResult<bigint>) => (x.status === "fulfilled" ? x.value : undefined);
      if (on) setB((p) => ({ base: v(r[0]) ?? p.base, lasna: v(r[1]) ?? p.lasna, uni: v(r[2]) ?? p.uni }));
    };
    tick();
    const t = setInterval(tick, intervalMs);
    return () => { on = false; clearInterval(t); };
  }, [intervalMs]);
  return b;
}


/* ------------------------------------------------------------------ chain health */

export type ChainHealth = Record<Lane, { head?: bigint; latencyMs?: number; blockMs?: number }>;

/** Latest block, RPC round-trip time and observed block time for each chain. */
export function useChainHealth(intervalMs = 4000) {
  const [h, setH] = useState<ChainHealth>({ base: {}, lasna: {}, uni: {} });
  const last = useRef<Partial<Record<Lane, { head: bigint; t: number }>>>({});
  useEffect(() => {
    let on = true;
    const tick = async () => {
      if (document.hidden) return;
      const next: ChainHealth = { base: {}, lasna: {}, uni: {} };
      await Promise.all(
        (["base", "lasna", "uni"] as Lane[]).map(async (l) => {
          const t0 = performance.now();
          try {
            const head = await client[l].getBlockNumber();
            const t1 = performance.now();
            const prev = last.current[l];
            let blockMs: number | undefined;
            if (prev && head > prev.head) blockMs = (t1 - prev.t) / Number(head - prev.head);
            last.current[l] = { head, t: t1 };
            next[l] = { head, latencyMs: t1 - t0, blockMs };
          } catch { /* leave empty: shown as unreachable */ }
        }),
      );
      if (on) setH((p) => ({
        base: { ...next.base, blockMs: next.base.blockMs ?? p.base.blockMs },
        lasna: { ...next.lasna, blockMs: next.lasna.blockMs ?? p.lasna.blockMs },
        uni: { ...next.uni, blockMs: next.uni.blockMs ?? p.uni.blockMs },
      }));
    };
    tick();
    const t = setInterval(tick, intervalMs);
    return () => { on = false; clearInterval(t); };
  }, [intervalMs]);
  return h;
}

/* ------------------------------------------------------------------ fuel: what keeps the automation running */

export type Fuel = {
  rc?: number; rcDebt?: number; vault?: number; vaultDebt?: number; pool?: number; poolDebt?: number;
  feedNextAt?: number; // unix seconds: when the feed accepts the next price (0 if it has no cooldown)
  maxBorrow?: number; // tUSD the vault accepts per loan. Only the hardened vault has this limit.
};

/** Balances and debts of the three contracts. A contract in debt stops receiving reactions or callbacks. */
export function useFuel(intervalMs = 10_000) {
  const [f, setF] = useState<Fuel>({});
  useEffect(() => {
    if (!deployed) return;
    let on = true;
    const tick = async () => {
      if (document.hidden) return;
      const n = (x: PromiseSettledResult<bigint>) => (x.status === "fulfilled" ? Number(formatUnits(x.value, 18)) : undefined);
      const [rc, rcDebt, vault, vaultDebt, pool, poolDebt, last, every, maxB] = await Promise.allSettled([
        client.lasna.getBalance({ address: ADDR.rc }),
        client.lasna.readContract({ address: SYSTEM, abi: debtAbi, functionName: "debt", args: [ADDR.rc] }),
        client.base.getBalance({ address: ADDR.vault }),
        client.base.readContract({ address: PROXY.base, abi: debtAbi, functionName: "debt", args: [ADDR.vault] }),
        client.uni.getBalance({ address: ADDR.pool }),
        client.uni.readContract({ address: PROXY.uni, abi: debtAbi, functionName: "debt", args: [ADDR.pool] }),
        client.base.readContract({ address: ADDR.feed, abi: abi.feed, functionName: "latestTimestamp" }),
        client.base.readContract({ address: ADDR.feed, abi: abi.feed, functionName: "MIN_INTERVAL" }),
        client.base.readContract({ address: ADDR.vault, abi: abi.vault, functionName: "MAX_BORROW" }),
      ]);
      if (!on) return;
      setF({
        rc: n(rc), rcDebt: n(rcDebt), vault: n(vault), vaultDebt: n(vaultDebt), pool: n(pool), poolDebt: n(poolDebt),
        // v1 of the feed has no cooldown, so MIN_INTERVAL may not exist.
        feedNextAt: last.status === "fulfilled" && every.status === "fulfilled" ? Number(last.value) + Number(every.value) : 0,
        maxBorrow: maxB.status === "fulfilled" ? Number(maxB.value) / 1e6 : undefined,
      });
    };
    tick();
    const t = setInterval(tick, intervalMs);
    return () => { on = false; clearInterval(t); };
  }, [intervalMs]);
  return f;
}

/* ------------------------------------------------------------------ live loop tracking */

export type Step = {
  lane: Lane;
  label: string; // e.g. "liquidate()"
  detail: string;
  status: "wait" | "done" | "fail";
  hash?: string;
  ms?: number; // seen in the browser, ms after the origin tx was mined
};
export type LoopKind = "borrow" | "repay" | "liquidation";
export type LoopRun = { kind: LoopKind; steps: Step[]; startedAt: number; note?: string; done?: boolean };

type Watch = { lane: Lane; address: Address; abi: readonly unknown[]; events: string[]; loanId?: bigint };
const STEP_TIMEOUT_MS = 120_000;
const POLL_MS = 300;

type Seen = { lane: Lane; name: string; hash: string; loanId?: bigint; at: number; key: string };

/** Polls the three contracts in parallel into one buffer, so a step is detected as soon as its event
 *  exists, regardless of which step the UI is waiting on. Returns a stop function. */
function startFeed(starts: Record<Lane, bigint>, buffer: Seen[], stopped: () => boolean) {
  const sources: { lane: Lane; address: Address; abi: readonly unknown[] }[] = [
    { lane: "lasna", address: ADDR.rc, abi: abi.rc },
    { lane: "base", address: ADDR.vault, abi: abi.vault },
    { lane: "uni", address: ADDR.pool, abi: abi.pool },
  ];
  const known = new Set<string>();
  // The public RPCs reject eth_getLogs over a long block range (about 150 blocks on Base Sepolia), so each poll reads
  // only from just behind the last one. Asking from the start every time would stop working after about 30 s on Base.
  const reach: Record<Lane, bigint> = { base: 140n, uni: 900n, lasna: 4000n };
  const cursor: Record<Lane, bigint> = { ...starts };
  (async () => {
    const deadline = performance.now() + STEP_TIMEOUT_MS + 15_000;
    while (!stopped() && performance.now() < deadline) {
      await Promise.all(
        sources.map(async (src) => {
          try {
            const head = await client[src.lane].getBlockNumber();
            const from = head - cursor[src.lane] > reach[src.lane] ? head - reach[src.lane] : cursor[src.lane];
            const logs = (await client[src.lane].getContractEvents({ address: src.address, abi: src.abi as never, fromBlock: from, toBlock: head, strict: false })) as any[];
            cursor[src.lane] = head - 2n; // overlap a couple of blocks; duplicates are dropped by key
            const at = performance.now();
            for (const l of logs) {
              const key = `${src.lane}:${l.transactionHash}:${l.logIndex}`;
              if (known.has(key)) continue;
              known.add(key);
              buffer.push({ lane: src.lane, name: l.eventName, hash: l.transactionHash, loanId: l.args?.loanId, at, key });
            }
          } catch {
            /* RPC hiccup: the next poll retries */
          }
        }),
      );
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  })();
}

export function useLoop() {
  const [run, setRun] = useState<LoopRun>();
  const token = useRef(0);

  const track = useCallback(
    async (kind: LoopKind, origin: { lane: Lane; hash: string; label: string; detail: string; minedAt: number }, opts: { loanId?: bigint; expectLiquidations?: number } = {}) => {
      const my = ++token.current;
      const cancelled = () => token.current !== my;
      const starts = Object.fromEntries(
        await Promise.all((["base", "lasna", "uni"] as Lane[]).map(async (l) => [l, (await client[l].getBlockNumber()) - (l === "base" ? 80n : 15n)])),
      ) as Record<Lane, bigint>;
      const buffer: Seen[] = [];
      const used = new Set<string>();
      let over = false;
      startFeed(starts, buffer, () => cancelled() || over);
      const steps: Step[] = [{ lane: origin.lane, label: origin.label, detail: origin.detail, status: "done", hash: origin.hash, ms: 0 }];
      // A reaction happens before the callback it causes. If a slower RPC showed us the reaction after its effect,
      // the effect's time is the latest the reaction can have happened, so cap it there.
      const ordered = () => {
        const out = steps.map((s) => ({ ...s }));
        for (let i = out.length - 2; i >= 0; i--) {
          const a = out[i], b = out[i + 1];
          if (a.status === "done" && b.status === "done" && a.ms !== undefined && b.ms !== undefined && a.ms > b.ms) a.ms = b.ms;
        }
        return out;
      };
      const publish = (note?: string, done?: boolean) => {
        if (done) over = true;
        if (!cancelled()) setRun({ kind, steps: ordered(), startedAt: origin.minedAt, note, done });
      };
      const settle = (s: Partial<Step>) => { Object.assign(steps[steps.length - 1], s); publish(); };
      publish();

      const step = async (w: Watch, label: string, detail: string) => {
        steps.push({ lane: w.lane, label, detail, status: "wait" });
        publish();
        const deadline = performance.now() + STEP_TIMEOUT_MS;
        let hit: Seen | undefined;
        while (!cancelled() && performance.now() < deadline && !hit) {
          hit = buffer.find((e) => !used.has(e.key) && e.lane === w.lane && w.events.includes(e.name) && (w.loanId === undefined || e.loanId === w.loanId) && e.at >= origin.minedAt - 2000);
          if (!hit) await new Promise((r) => setTimeout(r, 80));
        }
        if (cancelled()) return undefined;
        if (hit) used.add(hit.key);
        settle(hit ? { status: "done", hash: hit.hash, ms: Math.max(0, hit.at - origin.minedAt) } : { status: "fail", detail: "not seen within 2 minutes" });
        return hit ? { event: hit.name, hash: hit.hash, loanId: hit.loanId, ms: hit.at - origin.minedAt } : undefined;
      };
      const rc = (events: string[], loanId?: bigint): Watch => ({ lane: "lasna", address: ADDR.rc, abi: abi.rc, events, loanId });
      const vault = (events: string[], loanId?: bigint): Watch => ({ lane: "base", address: ADDR.vault, abi: abi.vault, events, loanId });
      const pool = (events: string[], loanId?: bigint): Watch => ({ lane: "uni", address: ADDR.pool, abi: abi.pool, events, loanId });

      if (kind === "liquidation") {
        if (!opts.expectLiquidations) {
          const r = await step(rc(["PriceSeen"]), "react()", "price recorded");
          return publish(r ? "No open loan crossed the 80% threshold at this price." : undefined, true);
        }
        const a = await step(rc(["LiquidationRequested"]), "react()", "loan over 80% LTV, liquidation requested");
        if (!a) return publish(undefined, true);
        const id = a.loanId!;
        if (!(await step(pool(["Liquidated"], id), "liquidate()", `loan #${id} closed, repay is now impossible`))) return publish(undefined, true);
        if (!(await step(rc(["SeizeRequested"], id), "react()", "saw Liquidated, seize requested"))) return publish(undefined, true);
        await step(vault(["CollateralSeized"], id), "seize()", `debt + 5% to the treasury, the rest back to the borrower`);
        return publish(opts.expectLiquidations > 1 ? `${opts.expectLiquidations} loans crossed the threshold; this trace follows #${id}.` : undefined, true);
      }

      if (kind === "borrow") {
        const a = await step(rc(["BorrowApproved", "BorrowRefused"], opts.loanId), "react()", "checking LTV, size and limits");
        if (!a) return publish(undefined, true);
        if (a.event === "BorrowRefused") {
          settle({ detail: "refused, collateral is on its way back" });
          await step(vault(["CollateralReleased"], opts.loanId), "release()", "collateral returned to your wallet");
          return publish("Refused: the loan is above 70% LTV, below 50 tUSD, or over a limit. That is an on-chain decision too.", true);
        }
        settle({ detail: "approved" });
        const b = await step(pool(["Disbursed", "BorrowRejected"], opts.loanId), "disburse()", "tUSD sent to your wallet");
        if (b?.event === "BorrowRejected") {
          settle({ label: "reject()", detail: "pool could not fund it" });
          await step(vault(["CollateralReleased"], opts.loanId), "release()", "collateral returned to your wallet");
        }
        return publish(undefined, true);
      }

      await step(rc(["ReleaseRequested"], opts.loanId), "react()", "saw Repaid, release requested");
      await step(vault(["CollateralReleased"], opts.loanId), "release()", "collateral back in your wallet");
      return publish(undefined, true);
    },
    [],
  );

  return { run, track, clear: () => { token.current++; setRun(undefined); } };
}

import { useCallback, useEffect, useRef, useState } from "react";
import { formatUnits, type Address } from "viem";
import { ADDR, abi, client, deployed, LIQ_THRESHOLD, type Lane } from "./chain";

export type Loan = {
  id: bigint;
  owner: Address;
  collateral: number; // tWETH
  debt: number; // tUSD
  vault: number; // 0 None, 1 Locked, 2 Released, 3 Seized
  pool: number; // 0 None, 1 Active, 2 Repaid, 3 Liquidated
};

export type Market = {
  price?: number;
  rcPrice?: number;
  active?: number;
  loans: Loan[];
  me: { weth?: number; usd?: number; ethBase?: number; ethUni?: number; nextDrip?: number };
  updatedAt?: number;
  error?: string;
};

const MAX_LOANS = 60;

export const ltv = (l: Pick<Loan, "collateral" | "debt">, price: number) => (l.collateral > 0 ? l.debt / (l.collateral * price) : 0);
/** Price at which this loan crosses the liquidation threshold. */
export const liqPrice = (l: Pick<Loan, "collateral" | "debt">) => (l.collateral > 0 ? l.debt / (l.collateral * LIQ_THRESHOLD) : 0);

export function useMarket(account?: Address, intervalMs = 2500) {
  const [m, setM] = useState<Market>({ loans: [], me: {} });
  const busy = useRef(false);

  const refresh = useCallback(async () => {
    if (!deployed || busy.current) return;
    busy.current = true;
    try {
      const [price, nextId] = await client.base.multicall({
        allowFailure: false,
        contracts: [
          { address: ADDR.feed, abi: abi.feed, functionName: "price" },
          { address: ADDR.vault, abi: abi.vault, functionName: "nextId" },
        ],
      });
      const first = nextId > BigInt(MAX_LOANS) ? nextId - BigInt(MAX_LOANS) + 1n : 1n;
      const ids: bigint[] = [];
      for (let i = nextId; i >= first && i > 0n; i--) ids.push(i);

      const [vaultRows, poolRows, rcState, me] = await Promise.all([
        ids.length ? client.base.multicall({ allowFailure: false, contracts: ids.map((id) => ({ address: ADDR.vault, abi: abi.vault, functionName: "loans", args: [id] }) as const) }) : [],
        ids.length ? client.uni.multicall({ allowFailure: false, contracts: ids.map((id) => ({ address: ADDR.pool, abi: abi.pool, functionName: "loans", args: [id] }) as const) }) : [],
        Promise.all([
          client.lasna.readContract({ address: ADDR.rc, abi: abi.rc, functionName: "price" }),
          client.lasna.readContract({ address: ADDR.rc, abi: abi.rc, functionName: "activeCount" }),
        ]).catch(() => undefined),
        account ? readMe(account) : Promise.resolve({}),
      ]);

      const loans: Loan[] = ids.map((id, i) => {
        const [owner, collateral, vs] = vaultRows[i] as readonly [Address, bigint, number];
        const [, debt, ps] = poolRows[i] as readonly [Address, bigint, number];
        return { id, owner, collateral: Number(formatUnits(collateral, 18)), debt: Number(formatUnits(debt, 6)), vault: vs, pool: ps };
      });

      setM({
        price: Number(formatUnits(price, 8)),
        rcPrice: rcState ? Number(formatUnits(rcState[0], 8)) : undefined,
        active: rcState ? Number(rcState[1]) : undefined,
        loans,
        me,
        updatedAt: Date.now(),
      });
    } catch (e) {
      setM((s) => ({ ...s, error: (e as Error).message.split("\n")[0] }));
    } finally {
      busy.current = false;
    }
  }, [account]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, intervalMs);
    return () => clearInterval(t);
  }, [refresh, intervalMs]);

  return { ...m, refresh };
}

async function readMe(a: Address): Promise<Market["me"]> {
  const [[weth, drip], [usd], ethBase, ethUni] = await Promise.all([
    client.base.multicall({
      allowFailure: false,
      contracts: [
        { address: ADDR.weth, abi: abi.token, functionName: "balanceOf", args: [a] },
        { address: ADDR.weth, abi: abi.token, functionName: "lastDrip", args: [a] },
      ],
    }),
    client.uni.multicall({ allowFailure: false, contracts: [{ address: ADDR.usd, abi: abi.token, functionName: "balanceOf", args: [a] }] }),
    client.base.getBalance({ address: a }),
    client.uni.getBalance({ address: a }),
  ]);
  return {
    weth: Number(formatUnits(weth, 18)),
    usd: Number(formatUnits(usd, 6)),
    ethBase: Number(formatUnits(ethBase, 18)),
    ethUni: Number(formatUnits(ethUni, 18)),
    nextDrip: drip > 0n ? Number(drip) + 60 : 0,
  };
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
export type LoopRun = { kind: "borrow" | "repay" | "liquidation"; steps: Step[]; startedAt: number; note?: string; done?: boolean };

type Watch = { lane: Lane; address: Address; abi: readonly unknown[]; events: string[]; loanId?: bigint };

const STEP_TIMEOUT_MS = 120_000;

async function waitFor(w: Watch, fromBlock: bigint, origin: number, cancelled: () => boolean) {
  const c = client[w.lane];
  const deadline = performance.now() + STEP_TIMEOUT_MS;
  while (!cancelled() && performance.now() < deadline) {
    try {
      const to = await c.getBlockNumber();
      const logs = await c.getContractEvents({ address: w.address, abi: w.abi as any, fromBlock, toBlock: to, strict: false });
      const hit = logs.find((l: any) => w.events.includes(l.eventName) && (w.loanId === undefined || l.args?.loanId === w.loanId)) as any;
      if (hit) return { event: hit.eventName as string, hash: hit.transactionHash as string, loanId: hit.args?.loanId as bigint | undefined, ms: performance.now() - origin };
    } catch {
      /* RPC hiccup: retry */
    }
    await new Promise((r) => setTimeout(r, 350));
  }
  return undefined;
}

export function useLoop() {
  const [run, setRun] = useState<LoopRun>();
  const token = useRef(0);

  const track = useCallback(async (kind: LoopRun["kind"], origin: { lane: Lane; hash: string; label: string; detail: string; minedAt: number }, opts: { loanId?: bigint; expectLiquidations?: number } = {}) => {
    const my = ++token.current;
    const cancelled = () => token.current !== my;
    const starts = Object.fromEntries(
      await Promise.all((["base", "lasna", "uni"] as Lane[]).map(async (l) => [l, (await client[l].getBlockNumber()) - (l === "base" ? 60n : 15n)])),
    ) as Record<Lane, bigint>;
    const steps: Step[] = [{ lane: origin.lane, label: origin.label, detail: origin.detail, status: "done", hash: origin.hash, ms: 0 }];
    const push = (s: Step) => { steps.push(s); setRun({ kind, steps: [...steps], startedAt: origin.minedAt }); };
    const settle = (s: Partial<Step>) => { Object.assign(steps[steps.length - 1], s); setRun({ kind, steps: [...steps], startedAt: origin.minedAt }); };
    const finish = (note?: string) => !cancelled() && setRun({ kind, steps: [...steps], startedAt: origin.minedAt, note, done: true });
    setRun({ kind, steps: [...steps], startedAt: origin.minedAt });

    const step = async (w: Watch, label: string, detail: string) => {
      push({ lane: w.lane, label, detail, status: "wait" });
      const r = await waitFor(w, starts[w.lane], origin.minedAt, cancelled);
      if (cancelled()) return undefined;
      settle(r ? { status: "done", hash: r.hash, ms: r.ms } : { status: "fail", detail: "not seen within 2 minutes" });
      return r;
    };

    if (kind === "liquidation") {
      if (!opts.expectLiquidations) {
        const r = await step({ lane: "lasna", address: ADDR.rc, abi: abi.rc, events: ["PriceSeen"] }, "react()", "price recorded, every loan still above the threshold");
        return finish(r ? "No loan crossed the liquidation threshold." : undefined);
      }
      const a = await step({ lane: "lasna", address: ADDR.rc, abi: abi.rc, events: ["LiquidationRequested"] }, "react()", "health check failed, liquidation requested");
      if (!a) return finish();
      const b = await step({ lane: "uni", address: ADDR.pool, abi: abi.pool, events: ["Liquidated"], loanId: a.loanId }, "liquidate()", `loan #${a.loanId} closed, repay now impossible`);
      if (!b) return finish();
      const c = await step({ lane: "lasna", address: ADDR.rc, abi: abi.rc, events: ["SeizeRequested"], loanId: a.loanId }, "react()", "saw Liquidated, seize requested");
      if (!c) return finish();
      await step({ lane: "base", address: ADDR.vault, abi: abi.vault, events: ["CollateralSeized"], loanId: a.loanId }, "seize()", `collateral of #${a.loanId} moved to treasury`);
      return finish(opts.expectLiquidations > 1 ? `${opts.expectLiquidations} loans crossed the threshold; this trace follows #${a.loanId}.` : undefined);
    }

    if (kind === "borrow") {
      const a = await step({ lane: "lasna", address: ADDR.rc, abi: abi.rc, events: ["BorrowApproved", "BorrowRefused"], loanId: opts.loanId }, "react()", "LTV check");
      if (!a) return finish();
      if (a.event === "BorrowRefused") {
        settle({ detail: "LTV above 70%, refused" });
        await step({ lane: "base", address: ADDR.vault, abi: abi.vault, events: ["CollateralReleased"], loanId: opts.loanId }, "release()", "collateral returned");
        return finish("Borrow refused: the requested amount is above 70% of the collateral value.");
      }
      settle({ detail: "LTV under 70%, approved" });
      await step({ lane: "uni", address: ADDR.pool, abi: abi.pool, events: ["Disbursed", "BorrowRejected"], loanId: opts.loanId }, "disburse()", "tUSD sent to your wallet");
      return finish();
    }

    // repay
    await step({ lane: "lasna", address: ADDR.rc, abi: abi.rc, events: ["ReleaseRequested"], loanId: opts.loanId }, "react()", "saw Repaid, release requested");
    await step({ lane: "base", address: ADDR.vault, abi: abi.vault, events: ["CollateralReleased"], loanId: opts.loanId }, "release()", "collateral back in your wallet");
    return finish();
  }, []);

  return { run, track, clear: () => { token.current++; setRun(undefined); } };
}

export const loansUnderThreshold = (loans: Loan[], price: number) =>
  loans.filter((l) => l.pool === 1 && l.vault === 1 && ltv(l, price) > LIQ_THRESHOLD);

import raw from "./bench.json";
import type { Lane } from "./chain";
import type { Step } from "./market";

export type Hit = { hash: string; ms: number; chain: Lane; event: string };
export type BenchRun = {
  loan: number; lock: string; approved: Hit; disbursed: Hit;
  price: string; requested: Hit; liquidated: Hit; seizeRequested: Hit; seized: Hit;
};
export type Stat = { p50: number; p95: number; max: number };
export type Bench = {
  measuredAt?: string; method?: string; runs?: BenchRun[];
  hops?: ({ name: string } & Stat)[]; total?: Stat; crashToDebtClosed?: Stat; borrow?: Stat;
};

export const bench = raw as Bench;
export const runs: BenchRun[] = bench.runs ?? [];
export const measured = runs.length > 0 && Boolean(bench.total);
export const sec = (ms: number, d = 1) => (ms / 1000).toFixed(d);

/** One recorded liquidation, as trace steps. `ms` is measured from the price transaction's receipt. */
export function runSteps(r: BenchRun): Step[] {
  return [
    { lane: "base", label: "post()", detail: "price drops to $2,200", status: "done", hash: r.price, ms: 0 },
    { lane: "lasna", label: "react()", detail: `loan #${r.loan} over 80% LTV`, status: "done", hash: r.requested.hash, ms: r.requested.ms },
    { lane: "uni", label: "liquidate()", detail: "debt closed, repay disabled", status: "done", hash: r.liquidated.hash, ms: r.liquidated.ms },
    { lane: "lasna", label: "react()", detail: "saw Liquidated, seize requested", status: "done", hash: r.seizeRequested.hash, ms: r.seizeRequested.ms },
    { lane: "base", label: "seize()", detail: "debt + 5% to the treasury", status: "done", hash: r.seized.hash, ms: r.seized.ms },
  ];
}

/** Per-hop duration of every run (ms), with the transaction that ended the hop. */
export const hopSeries = [
  { name: "Price tx on Base → Reactive reacts", pick: (r: BenchRun) => ({ ms: r.requested.ms, hash: r.requested.hash, lane: "lasna" as Lane }) },
  { name: "Reactive → debt closed on Unichain", pick: (r: BenchRun) => ({ ms: r.liquidated.ms - r.requested.ms, hash: r.liquidated.hash, lane: "uni" as Lane }) },
  { name: "Unichain → Reactive reacts again", pick: (r: BenchRun) => ({ ms: r.seizeRequested.ms - r.liquidated.ms, hash: r.seizeRequested.hash, lane: "lasna" as Lane }) },
  { name: "Reactive → collateral seized on Base", pick: (r: BenchRun) => ({ ms: r.seized.ms - r.seizeRequested.ms, hash: r.seized.hash, lane: "base" as Lane }) },
];

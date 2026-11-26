import { useEffect, useState } from "react";
import { formatUnits } from "viem";
import { ADDR, BORROW_REFUSED, RC_LABEL, abi, client, deployed, type Lane } from "./chain";
import type { Point } from "./charts";

export type Activity = { key: string; lane: Lane; name: string; text: string; hash: string; at: number; loanId?: bigint; approx: boolean };

const u6 = (x: bigint) => `$${Number(formatUnits(x, 6)).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
const w = (x: bigint) => `${Number(formatUnits(x, 18)).toLocaleString("en-US", { maximumFractionDigits: 4 })} tWETH`;
const p8 = (x: bigint) => `$${Number(formatUnits(BigInt(x), 8)).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

/** One human sentence per contract event. Anything not listed here is not shown. */
function describe(name: string, a: any): string | undefined {
  switch (name) {
    case "AnswerUpdated": return `Price posted: ${p8(a.current)} (round ${a.roundId})`;
    case "PriceSeen": return `Reactive saw the price ${p8(a.price)} (round ${a.round})`;
    case "CollateralLocked": return `Loan #${a.loanId} opened: ${w(a.collateral)} locked for ${u6(a.borrowAmount)}`;
    case "CollateralReleased": return `Loan #${a.loanId}: collateral returned to the borrower`;
    case "CollateralSeized": return `Loan #${a.loanId}: ${w(a.seized)} seized, ${w(a.returned)} returned to the borrower`;
    case "BorrowApproved": return `Loan #${a.loanId} approved at ${p8(a.price)}`;
    case "BorrowRefused": return `Loan #${a.loanId} refused: ${BORROW_REFUSED[a.reason] ?? "limit reached"}`;
    case "LiquidationRequested": return `Loan #${a.loanId} is over 80% LTV at ${p8(a.price)}. Liquidation requested`;
    case "SeizeRequested": return `Loan #${a.loanId}: seize requested (${w(a.seizeAmount)})`;
    case "ReleaseRequested": return `Loan #${a.loanId}: release requested`;
    case "LoanFinal": return `Loan #${a.loanId} is final: ${RC_LABEL[Number(a.status)]}`;
    case "Disbursed": return `Loan #${a.loanId}: ${u6(a.amount)} paid out`;
    case "BorrowRejected": return `Loan #${a.loanId}: the pool could not fund ${u6(a.amount)}`;
    case "Repaid": return `Loan #${a.loanId} repaid (${u6(a.amount)})`;
    case "Liquidated": return `Loan #${a.loanId} liquidated, ${u6(a.debt)} of debt closed`;
  }
}

/**
 * A live stream of what happened on the three chains, plus the price history Reactive has seen.
 * The public RPCs cap eth_getLogs ranges (about 150 blocks on Base Sepolia, 1,000 on Unichain, 5,000 on Lasna), so the
 * first read looks back as far as each allows and later reads only fetch what is new.
 */
export function useActivity(intervalMs = 3000) {
  const [events, setEvents] = useState<Activity[]>([]);
  const [tape, setTape] = useState<Point[]>([]);

  useEffect(() => {
    if (!deployed) return;
    let on = true;
    let first = true;
    const seen = new Set<string>();
    const from: Record<string, bigint> = {};
    const sources: { lane: Lane; address: `0x${string}`; abi: readonly unknown[]; reach: bigint; blockMs: number }[] = [
      { lane: "lasna", address: ADDR.rc, abi: abi.rc, reach: 4000n, blockMs: 1000 },
      { lane: "uni", address: ADDR.pool, abi: abi.pool, reach: 900n, blockMs: 1000 },
      { lane: "base", address: ADDR.vault, abi: abi.vault, reach: 140n, blockMs: 200 },
      { lane: "base", address: ADDR.feed, abi: abi.feed, reach: 140n, blockMs: 200 },
    ];

    const tick = async () => {
      if (document.hidden) return;
      const heads = new Map<Lane, bigint>();
      await Promise.all((["base", "lasna", "uni"] as Lane[]).map(async (l) => { try { heads.set(l, await client[l].getBlockNumber()); } catch { /* skip this chain this round */ } }));
      const out: Activity[] = [];
      const pts: Point[] = [];
      await Promise.all(
        sources.map(async (s) => {
          const head = heads.get(s.lane);
          if (head === undefined) return;
          const k = `${s.lane}:${s.address}`;
          const fromBlock = from[k] !== undefined && head - from[k] <= s.reach ? from[k] : head - s.reach;
          try {
            const logs = (await client[s.lane].getContractEvents({ address: s.address, abi: s.abi as never, fromBlock, toBlock: head, strict: false })) as any[];
            from[k] = head - 2n;
            for (const l of logs) {
              const key = `${s.lane}:${l.transactionHash}:${l.logIndex}`;
              if (seen.has(key)) continue;
              seen.add(key);
              const text = describe(l.eventName, l.args ?? {});
              if (!text) continue;
              // Events found on the first read are placed by block distance from now; later ones by when we saw them.
              const at = first ? Date.now() - Number(head - l.blockNumber) * s.blockMs : Date.now();
              out.push({ key, lane: s.lane, name: l.eventName, text, hash: l.transactionHash, at, loanId: l.args?.loanId, approx: first });
              if (l.eventName === "PriceSeen") pts.push({ t: at, p: Number(formatUnits(l.args.price, 8)) });
            }
          } catch {
            /* range rejected or RPC hiccup: leave `from` alone and try again next round */
          }
        }),
      );
      first = false;
      if (!on) return;
      if (out.length) setEvents((prev) => [...out, ...prev].sort((a, b) => b.at - a.at).slice(0, 150));
      if (pts.length) setTape((prev) => [...prev, ...pts].sort((a, b) => a.t - b.t).slice(-300));
    };

    tick();
    const t = setInterval(tick, intervalMs);
    return () => { on = false; clearInterval(t); };
  }, [intervalMs]);

  return { events, tape };
}

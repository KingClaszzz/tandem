import { LIQ_THRESHOLD } from "./chain";
import { isOpen, liqPrice, ltv, stageOf, type Loan } from "./market";

export type Bin = { label: string; count: number; tone: "ok" | "warn" | "bad" };

/** Everything the overview needs, derived from the loans the console has read. */
export function stats(loans: Loan[], price: number) {
  const active = loans.filter((l) => stageOf(l) === "active");
  const open = loans.filter((l) => isOpen(stageOf(l)));
  const debt = loans.filter((l) => l.pool === 1).reduce((a, l) => a + l.debt, 0); // outstanding at the pool
  const lockedCollateral = loans.filter((l) => l.vault === 1).reduce((a, l) => a + l.collateral, 0);
  const activeDebt = active.reduce((a, l) => a + l.debt, 0);
  const activeValue = active.reduce((a, l) => a + l.collateral * price, 0);
  const liquidated = loans.filter((l) => stageOf(l) === "seized").length;
  const repaid = loans.filter((l) => stageOf(l) === "repaid").length;
  const refused = loans.filter((l) => stageOf(l) === "refused" || stageOf(l) === "rejected").length;
  const seizedWeth = loans.reduce((a, l) => a + (l.seized ?? 0), 0);

  const byRisk = [...active].sort((a, b) => ltv(b, price) - ltv(a, price));
  const edges: [string, number, number, Bin["tone"]][] = [
    ["<50%", 0, 0.5, "ok"], ["50–60", 0.5, 0.6, "ok"], ["60–70", 0.6, 0.7, "ok"], ["70–75", 0.7, 0.75, "warn"], ["75–80", 0.75, LIQ_THRESHOLD, "warn"], [">80", LIQ_THRESHOLD, Infinity, "bad"],
  ];
  const bins: Bin[] = edges.map(([label, lo, hi, tone]) => ({ label, tone, count: active.filter((l) => { const v = ltv(l, price); return v >= lo && v < hi; }).length }));

  return {
    active, open, debt, lockedCollateral, liquidated, repaid, refused, seizedWeth,
    avgLtv: activeValue > 0 ? activeDebt / activeValue : 0,
    nearest: byRisk,
    bins,
    atRisk: active.filter((l) => ltv(l, price) > 0.75).length,
  };
}

/** How far the price can fall before this loan is liquidated, as a fraction of today's price. */
export const buffer = (l: Pick<Loan, "collateral" | "debt">, price: number) => (price > 0 ? Math.max(0, 1 - liqPrice(l) / price) : 0);

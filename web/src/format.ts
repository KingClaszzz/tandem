import { PENALTY } from "./chain";
import type { Loan } from "./market";

export const usd = (n?: number, d = 0) =>
  n === undefined || !Number.isFinite(n) ? "—" : `$${n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })}`;
export const num = (n?: number, d = 4) => (n === undefined || !Number.isFinite(n) ? "—" : n.toLocaleString("en-US", { maximumFractionDigits: d }));
export const pct = (x: number, d = 1) => `${(x * 100).toFixed(d)}%`;
export const toE8 = (p: number) => BigInt(Math.round(p * 100)) * 1_000_000n;
/** tWETH the treasury takes at price `p`: debt plus the penalty, never more than the collateral. */
export const seizeFor = (l: Pick<Loan, "collateral" | "debt">, p: number) => Math.min(l.collateral, (l.debt * (1 + PENALTY)) / p);

export function ago(ms: number, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ago`;
}

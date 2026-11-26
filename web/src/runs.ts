import { useCallback, useState } from "react";
import type { Lane } from "./chain";
import type { LoopKind } from "./market";

export type Cost = { lreact: number; ethBase: number; ethUni: number };
export type SavedRun = {
  at: number; kind: LoopKind; totalMs: number;
  steps: { lane: Lane; label: string; ms: number; hash?: string }[];
  cost?: Cost;
};

const KEY = "tandem:runs";
const read = (): SavedRun[] => { try { return JSON.parse(localStorage.getItem(KEY) ?? "[]"); } catch { return []; } };

/** The loops this browser has run, kept locally so the Latency Lab can compare them with the published benchmark. */
export function useMyRuns() {
  const [runs, setRuns] = useState<SavedRun[]>(read);
  const add = useCallback((r: SavedRun) => {
    setRuns((prev) => {
      const next = [r, ...prev].slice(0, 40);
      try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* storage unavailable */ }
      return next;
    });
  }, []);
  const clear = useCallback(() => { setRuns([]); try { localStorage.removeItem(KEY); } catch { /* ignore */ } }, []);
  return { runs, add, clear };
}

export const quantile = (xs: number[], p: number) => {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};

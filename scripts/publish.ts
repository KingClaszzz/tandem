// Turns a bench evidence file (evidence/bench-*.json) into web/src/bench.json: the summary plus every
// run's per-hop timings and tx hashes, so the website can show real runs and link to their transactions.
// Usage: npx ts-node scripts/publish.ts [evidence-file]   (defaults to the newest bench file)
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Hit = { hash: string; ms: number };
type Run = {
  loanId: string;
  borrow: { lock: string; approved: Hit; disbursed: Hit };
  liquidation: { price: string; requested: Hit; liquidated: Hit; seizeRequested: Hit; seized: Hit };
};

export function compact(evidence: { summary: Record<string, unknown>; runs: Run[] }) {
  return {
    ...evidence.summary,
    runs: evidence.runs.map((r) => ({
      loan: Number(r.loanId),
      lock: r.borrow.lock,
      approved: r.borrow.approved,
      disbursed: r.borrow.disbursed,
      price: r.liquidation.price,
      requested: r.liquidation.requested,
      liquidated: r.liquidation.liquidated,
      seizeRequested: r.liquidation.seizeRequested,
      seized: r.liquidation.seized,
    })),
  };
}

export function publish(evidenceFile?: string) {
  const dir = join(__dirname, "..", "evidence");
  const file = evidenceFile ?? join(dir, readdirSync(dir).filter((f) => f.startsWith("bench-")).sort().pop()!);
  const out = compact(JSON.parse(readFileSync(file, "utf8")));
  writeFileSync(join(__dirname, "..", "web", "src", "bench.json"), JSON.stringify(out, null, 1) + "\n");
  return { file, runs: out.runs.length };
}

if (require.main === module) {
  const r = publish(process.argv[2]);
  console.log(`published ${r.runs} runs from ${r.file}`);
}

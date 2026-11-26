import { useState } from "react";
import { LANE_SHORT, txUrl } from "../chain";
import { measured, runs, runSteps, sec } from "../bench";
import { LoopTrace, fmtMs } from "../ui";
import { REACTION_COST } from "../chain";
import type { Ctx } from "./ctx";

const eth = (v: number) => (v === 0 ? "0" : v < 1e-6 ? "<0.000001" : v.toFixed(6));

/** The trace of the loop the user just started. With `fallback`, shows a recorded run when nothing is running. */
export default function LiveLoop({ c, fallback = false }: { c: Ctx; fallback?: boolean }) {
  const run = c.loop.run;
  const [copied, setCopied] = useState(false);
  if (!run && !(fallback && measured)) return null;

  const rec = runs[Math.floor(runs.length / 2)];
  if (!run && !rec) return null;
  const copy = () => {
    if (!run) return;
    const md = [`Tandem ${run.kind} loop, measured in the browser from the first receipt:`, ...run.steps.map((s) => `- ${LANE_SHORT[s.lane]} \`${s.label}\` ${fmtMs(s.ms)} ${s.hash ? txUrl(s.lane, s.hash) : ""}`)].join("\n");
    navigator.clipboard?.writeText(md).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => {});
  };

  return (
    <section className="panel spot" aria-labelledby="h-trace">
      <div className="panel-top">
        <h2 id="h-trace">{run ? "Live loop" : "A recorded loop"}</h2>
        {run && (
          <span className="row-gap">
            <button className="btn btn-sm" onClick={copy}>{copied ? "Copied" : "Copy proof"}</button>
            <button className="btn btn-sm" onClick={c.loop.clear}>Clear</button>
          </span>
        )}
      </div>
      {run ? (
        <>
          <LoopTrace steps={run.steps} />
          <p className="small muted trace-note">
            {run.note ?? (run.done ? "Loop complete. Every box links to its transaction." : "Watching the three chains…")} Times are measured in your browser from the first transaction's receipt.
          </p>
          {run.done && c.cost && (
            <p className="cost small" title="Balance of the reactive contract, vault and pool before and after this loop. It also includes anything else that happened meanwhile.">
              <b>What this loop cost the operator:</b>{" "}
              <span className="num">{c.cost.lreact.toFixed(3)} lREACT</span> <span className="muted">(about {Math.round(c.cost.lreact / REACTION_COST)} reactions)</span>
              {" · "}<span className="num">{eth(c.cost.ethBase)} ETH</span> <span className="muted">Base callbacks</span>
              {" · "}<span className="num">{eth(c.cost.ethUni)} ETH</span> <span className="muted">Unichain callbacks</span>
            </p>
          )}
        </>
      ) : (
        <>
          <p className="small muted rec-note">
            Loan #{rec.loan}, recorded on testnet: a price crash to $2,200 took {sec(rec.seized.ms)}s to seize the collateral. Every box is a real transaction. Borrow or move the price to watch your own.
          </p>
          <LoopTrace steps={runSteps(rec)} />
        </>
      )}
    </section>
  );
}

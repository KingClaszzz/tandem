import { LANE_SHORT } from "../chain";
import { bench, hopSeries, measured, runs, sec } from "../bench";
import { ago } from "../format";
import { quantile } from "../runs";
import { Arrow } from "../ui";
import type { Ctx } from "./ctx";

// Each hop takes the colour of the chain it ends on.
const COLORS = ["var(--lasna)", "var(--uni)", "var(--lasna)", "var(--base)"];

const OLD_BLOCK = 7; // seconds, the previous Reactive network (from the buildathon brief)
const OMNI_BLOCK = 1; // seconds, Omni
const REACTIONS = 2; // reactions on the liquidation path: price update, then Liquidated

export default function Latency({ c }: { c: Ctx }) {
  const mine = c.myRuns.runs;
  const myLiq = mine.filter((r) => r.kind === "liquidation");
  const mine50 = quantile(myLiq.map((r) => r.totalMs), 50);
  const mine95 = quantile(myLiq.map((r) => r.totalMs), 95);

  if (!measured) return <div className="view"><section className="panel"><p className="muted">Run <code>npm run bench</code> to record the benchmark.</p></section></div>;

  const hops = bench.hops!;
  const sum = hops.reduce((a, h) => a + h.p50, 0);
  const total = bench.total!;
  const oldAvg = total.p50 / 1000 - OMNI_BLOCK + OLD_BLOCK; // swap the average Omni block wait for the old one
  const wait = (b: number) => REACTIONS * b;

  return (
    <div className="view">
      <section className="panel spot">
        <div className="panel-top"><h2>Where the {sec(total.p50, 1)} seconds go</h2><span className="tag">{runs.length} liquidations, {bench.measuredAt}</span></div>
        <div className="lab-big">
          <div className="big-sm num">{sec(total.p50, 2)}<small>s</small><span className="cap">median, price tx → collateral seized</span></div>
          <dl className="mini">
            <div><dt>p95</dt><dd className="num">{sec(total.p95, 2)}s</dd></div>
            <div><dt>Fastest</dt><dd className="num">{sec(Math.min(...runs.map((r) => r.seized.ms)), 2)}s</dd></div>
            <div><dt>Debt closed, p50</dt><dd className="num">{sec(bench.crashToDebtClosed!.p50, 2)}s</dd></div>
            <div><dt>Borrow, p50</dt><dd className="num">{sec(bench.borrow!.p50, 2)}s</dd></div>
          </dl>
        </div>

        <div className="hopbar" role="img" aria-label="Share of the median loop time spent in each hop">
          {hops.map((h, i) => (
            <div key={h.name} style={{ flexBasis: `${(h.p50 / sum) * 100}%`, ["--c" as string]: COLORS[i] }} title={`${h.name}: ${sec(h.p50, 2)} s`}>
              <i /><span className="num">{sec(h.p50, 2)}s</span>
            </div>
          ))}
        </div>
        <ul className="hoplist">
          {hops.map((h, i) => (
            <li key={h.name} style={{ ["--c" as string]: COLORS[i] }}>
              <i className="dot" style={{ background: COLORS[i] }} />
              <span>{h.name}</span>
              <span className="num muted">p50 {sec(h.p50, 2)}s · p95 {sec(h.p95, 2)}s</span>
              <span className="muted small">ends on {LANE_SHORT[hopSeries[i].pick(runs[0]).lane]}</span>
            </li>
          ))}
        </ul>
        <p className="small muted">The longest hop is Reactive reaching Unichain. We did not dig into why, so we do not claim it is inherent to Unichain. Method: {bench.method}.</p>
      </section>

      <div className="grid-2">
        <section className="panel spot">
          <div className="panel-top"><h2>Why this loop needs Omni</h2><span className="tag">an estimate, not a measurement</span></div>
          <p className="muted pad-b">
            Two Reactive reactions sit on the liquidation path: one when the price is posted, one when the debt chain confirms <code>Liquidated</code>. Each starts at the next Reactive block, so it waits between zero and one block interval.
          </p>
          <table className="tbl model fit">
            <thead><tr><th /><th>Previous network</th><th>Omni</th></tr></thead>
            <tbody>
              <tr><td>Block time</td><td className="num">≈ {OLD_BLOCK} s</td><td className="num">≈ {OMNI_BLOCK} s</td></tr>
              <tr><td>Wait added by 2 reactions, on average</td><td className="num">≈ {wait(OLD_BLOCK / 2)} s</td><td className="num">≈ {wait(OMNI_BLOCK / 2)} s</td></tr>
              <tr><td>Wait added by 2 reactions, worst case</td><td className="num">≈ {wait(OLD_BLOCK)} s</td><td className="num">≈ {wait(OMNI_BLOCK)} s</td></tr>
              <tr className="tot"><td>Whole loop</td><td className="num">≈ {oldAvg.toFixed(1)} s on average</td><td className="num">{sec(total.p50, 1)} s measured</td></tr>
            </tbody>
          </table>
          <p className="small muted">
            The Omni column is our measurement. The previous-network column swaps Omni's average wait for the old one using the published block times, so treat it as arithmetic, not a test on the old network.
            In a fast market, ten seconds is a long time to leave an undercollateralised loan open.
          </p>
        </section>

        <section className="panel spot">
          <div className="panel-top">
            <h2>Your runs</h2>
            {mine.length > 0 && <button className="btn btn-sm" onClick={c.myRuns.clear}>Clear</button>}
          </div>
          {mine.length === 0 ? (
            <p className="muted empty-sm">Nothing yet. Borrow or move the price and each loop is saved here, in this browser only, with its timings and what it cost.</p>
          ) : (
            <>
              {myLiq.length > 0 && (
                <p className="mine-sum">
                  <span className="num">{myLiq.length}</span> liquidation{myLiq.length > 1 ? "s" : ""}: median <b className="num">{sec(mine50!, 1)}s</b>, p95 <span className="num">{sec(mine95!, 1)}s</span>
                  {" "}<span className="muted">(published {sec(total.p50, 1)}s)</span>
                </p>
              )}
              <div className="table-scroll">
                <table className="tbl">
                  <thead><tr><th>When</th><th>Loop</th><th>Total</th><th>Cost</th></tr></thead>
                  <tbody>
                    {mine.slice(0, 12).map((r) => (
                      <tr key={r.at}>
                        <td data-l="When" className="muted">{ago(r.at)}</td>
                        <td data-l="Loop">{r.kind}</td>
                        <td data-l="Total" className="num">{sec(r.totalMs, 2)}s</td>
                        <td data-l="Cost" className="num muted">{r.cost ? `${r.cost.lreact.toFixed(3)} lREACT` : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          <a className="btn btn-sm" href="#/app/activity">Replay a recorded run <Arrow /></a>
        </section>
      </div>
    </div>
  );
}

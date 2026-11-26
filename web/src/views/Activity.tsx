import { useEffect, useMemo, useState } from "react";
import { LANES, LANE_SHORT, txUrl, type Lane } from "../chain";
import { bench, runs, runSteps, sec } from "../bench";
import { ago } from "../format";
import { LoopTrace } from "../ui";
import type { Step } from "../market";
import LiveLoop from "./LiveLoop";
import type { Ctx } from "./ctx";

/** Plays a recorded liquidation back with its real timings, so a visitor without a wallet or testnet ETH can watch the loop. */
function Replay() {
  if (!runs.length) {
    return (
      <section className="panel spot">
        <div className="panel-top"><h2>Replay a real liquidation</h2><span className="tag">no wallet needed</span></div>
        <p className="muted empty-sm">No recorded runs yet. Run <code>npm run bench</code> and they appear here.</p>
      </section>
    );
  }
  return <ReplayPlayer />;
}

function ReplayPlayer() {
  const [pick, setPick] = useState(Math.floor(runs.length / 2));
  const [elapsed, setElapsed] = useState<number>();
  const [speed, setSpeed] = useState(1);
  const all = useMemo(() => runSteps(runs[pick]), [pick]);
  const total = all[all.length - 1].ms ?? 0;

  useEffect(() => {
    if (elapsed === undefined || elapsed > total + 600) return;
    const start = performance.now() - elapsed / speed;
    const t = setInterval(() => setElapsed((performance.now() - start) * speed), 60);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [elapsed === undefined, speed, pick, total]);

  const shown: Step[] = elapsed === undefined ? [] : all.filter((s) => (s.ms ?? 0) <= elapsed);
  const next = elapsed === undefined ? undefined : all[shown.length];
  const steps: Step[] = next ? [...shown, { ...next, status: "wait", ms: undefined }] : shown;
  const done = elapsed !== undefined && !next;

  return (
    <section className="panel spot">
      <div className="panel-top">
        <h2>Replay a real liquidation</h2>
        <span className="tag">no wallet needed</span>
      </div>
      <p className="muted pad-b">
        Recorded on the live testnets on {bench.measuredAt}. The timings and the transaction hashes are the real ones. Pick any of the {runs.length} runs.
      </p>
      <div className="replay-bar">
        <div className="runs-pick" role="group" aria-label="Pick a recorded run">
          {runs.map((r, i) => (
            <button key={r.loan} className={i === pick ? "on" : ""} aria-pressed={i === pick} onClick={() => { setPick(i); setElapsed(undefined); }}>{i + 1}</button>
          ))}
        </div>
        <label className="g-sel">Speed
          <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} aria-label="Replay speed">
            <option value={0.5}>0.5×</option><option value={1}>1× (real time)</option><option value={2}>2×</option>
          </select>
        </label>
        <button className="btn btn-sm btn-primary" onClick={() => setElapsed(0)}>{elapsed === undefined ? "Play" : done ? "Play again" : "Restart"}</button>
        {elapsed !== undefined && <span className="num replay-clock">{(Math.min(elapsed, total) / 1000).toFixed(1)}s</span>}
      </div>
      {elapsed === undefined ? (
        <div className="empty">
          <p>Press Play. A price update lands on Base, Reactive reacts on Lasna, the debt closes on Unichain, and the collateral is seized on Base. In about {sec(runs[pick].seized.ms, 1)} seconds.</p>
        </div>
      ) : (
        <LoopTrace steps={steps} />
      )}
    </section>
  );
}

export default function Activity({ c }: { c: Ctx }) {
  const [lane, setLane] = useState<Lane | "all">("all");
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 5000); return () => clearInterval(t); }, []);
  const list = c.feed.events.filter((e) => lane === "all" || e.lane === lane);

  return (
    <div className="view">
      <LiveLoop c={c} />
      <div className="split-wide">
        <section className="panel spot">
          <div className="panel-top">
            <h2>Everything that happened</h2>
            <div className="chips" role="group" aria-label="Filter by chain">
              {(["all", ...LANES] as (Lane | "all")[]).map((l) => (
                <button key={l} className={`fchip ${lane === l ? "on" : ""}`} aria-pressed={lane === l} onClick={() => setLane(l)}>{l === "all" ? "all chains" : LANE_SHORT[l]}</button>
              ))}
            </div>
          </div>
          <p className="small muted pad-b">Events from the vault, the pool, the price feed and the reactive contract. History is as far back as each public RPC allows (about 30 s on Base, 15 min on Unichain, 80 min on Lasna). New events stream in every few seconds.</p>
          {list.length === 0 ? (
            <p className="muted empty-sm">Nothing in this window. Borrow or move the price and it shows up here.</p>
          ) : (
            <ul className="feed">
              {list.slice(0, 60).map((e) => (
                <li key={e.key} className={`lane-${e.lane}`}>
                  <i className="dot" />
                  <span className="f-text">{e.text}</span>
                  <span className="f-lane small muted">{LANE_SHORT[e.lane]}</span>
                  <a className="f-time small muted ul" href={txUrl(e.lane, e.hash)} target="_blank" rel="noreferrer" title={e.hash}>{e.approx ? "≈ " : ""}{ago(e.at, now)}</a>
                </li>
              ))}
            </ul>
          )}
        </section>
        <Replay />
      </div>
    </div>
  );
}

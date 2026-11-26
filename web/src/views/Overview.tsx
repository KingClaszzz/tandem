import { useMemo } from "react";
import { LANE_SHORT, txUrl } from "../chain";
import { bench, measured, runs, sec } from "../bench";
import { Bars, PriceTape, Split } from "../charts";
import { ago, num, pct, usd } from "../format";
import { liqPrice, ltv } from "../market";
import { buffer, stats } from "../stats";
import { Arrow, Hint } from "../ui";
import NextStep from "./NextStep";
import type { Ctx } from "./ctx";

function Tile({ label, value, sub, hint, tone }: { label: string; value: string; sub?: string; hint: string; tone?: "warn" | "bad" }) {
  return (
    <div className={`tile spot ${tone ?? ""}`}>
      <span className="tile-l">{label}<Hint text={hint} /></span>
      <b className="num">{value}</b>
      {sub && <span className="small muted">{sub}</span>}
    </div>
  );
}

export default function Overview({ c }: { c: Ctx }) {
  const { m } = c;
  const price = m.price ?? 0;
  const s = useMemo(() => stats(m.loans, price), [m.loans, price]);
  const tvl = (m.tvlWeth ?? 0) * price;
  const liquidity = m.liquidity ?? 0;
  const util = s.debt + liquidity > 0 ? s.debt / (s.debt + liquidity) : 0;
  const coverage = s.debt > 0 ? tvl / s.debt : undefined;
  const synced = m.price !== undefined && m.rcPrice !== undefined && Math.abs(m.price - m.rcPrice) < 1e-6;
  const tape = useMemo(() => (price ? [...c.feed.tape, { t: Date.now(), p: price }] : c.feed.tape), [c.feed.tape, price]);
  const levels = useMemo(() => s.active.map((l) => ({ p: liqPrice(l), label: `#${l.id} ${usd(liqPrice(l))}` })), [s.active]);
  const recent = c.feed.events.slice(0, 6);

  return (
    <div className="view">
      <NextStep c={c} />

      <div className="tiles">
        <Tile label="Locked as collateral" hint="The test WETH people have locked on Base to back their loans." value={`${num(m.tvlWeth, 3)} tWETH`} sub={usd(tvl)} />
        <Tile label="Borrowed right now" hint="Test USD currently lent out by the pool on Unichain." value={usd(s.debt)} sub={`${s.active.length} open loan${s.active.length === 1 ? "" : "s"}`} />
        <Tile label="Available to borrow" hint="Test USD still in the pool." value={usd(liquidity)} sub={`${pct(util)} of the pool is lent out`} />
        <Tile
          label="Safety cushion" hint="Collateral value divided by money borrowed. 2× means the collateral is worth twice the debt. Loans are liquidated well before this reaches 1×."
          value={coverage ? `${coverage.toFixed(2)}×` : "—"} sub={coverage ? "collateral value ÷ debt" : "no open loans yet"} tone={coverage !== undefined && coverage < 1.25 ? "warn" : undefined}
        />
      </div>
      <p className="subtle-stats">
        <span><b className="num">{s.liquidated}</b> liquidated, {num(s.seizedWeth, 3)} tWETH seized</span>
        <span><b className="num">{s.repaid}</b> repaid</span>
        <span><b className="num">{s.active.length ? pct(s.avgLtv) : "—"}</b> average LTV <Hint text="Loan-to-value: the debt as a share of the collateral's value. A loan is liquidated above 80%." /></span>
        <span><b className="num">{s.atRisk}</b> above 75%</span>
      </p>

      <div className="grid-2">
        <section className="panel spot">
          <div className="panel-top">
            <h2>ETH price and where loans get liquidated</h2>
            <span className={`chip ${synced ? "live" : "warn"}`}>{m.rcPrice === undefined ? "Reactive: …" : synced ? `in sync · round ${m.rcRound}` : `behind · sees ${usd(m.rcPrice, 2)}`}</span>
          </div>
          <PriceTape points={tape} levels={levels} />
          <p className="small muted">Dashed lines are the prices at which open loans reach 80% LTV. History comes from the reactive contract's own <code>PriceSeen</code> events.</p>
        </section>

        <section className="panel spot">
          <div className="panel-top"><h2>Loans to watch</h2><span className="tag">closest to liquidation</span></div>
          {s.nearest.length === 0 ? (
            <p className="muted empty-sm">No open loans. When someone borrows, the riskiest positions are ranked here.</p>
          ) : (
            <ul className="radar">
              {s.nearest.slice(0, 6).map((l) => (
                <li key={l.id.toString()}>
                  <span className="num">#{l.id.toString()}</span>
                  <span className="num">{pct(ltv(l, price))}</span>
                  <span className="rbar"><i style={{ width: `${Math.min(100, (ltv(l, price) / 0.8) * 100)}%` }} className={ltv(l, price) > 0.75 ? "bad" : ltv(l, price) > 0.65 ? "warn" : ""} /></span>
                  <span className="small muted num">−{pct(buffer(l, price))} to go</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <div className="grid-3">
        <section className="panel spot">
          <div className="panel-top"><h2>How risky are the open loans?</h2></div>
          <Bars bins={s.bins} />
        </section>

        <section className="panel spot">
          <div className="panel-top"><h2>The lending pool</h2></div>
          <Split parts={[{ label: `Lent out ${usd(s.debt)}`, value: s.debt, color: "var(--uni)" }, { label: `Available ${usd(liquidity)}`, value: liquidity, color: "var(--line-2)" }]} />
          <p className="small muted">tUSD on Unichain. Collateral against it, on Base: {num(m.tvlWeth, 3)} tWETH.</p>
          <dl className="mini">
            <div><dt>Repaid</dt><dd className="num">{s.repaid}</dd></div>
            <div><dt>Refused</dt><dd className="num">{s.refused}</dd></div>
            <div><dt>Liquidated</dt><dd className="num">{s.liquidated}</dd></div>
          </dl>
        </section>

        <section className="panel spot hero-card">
          <div className="panel-top"><h2>Crash to seized</h2><span className="tag">{runs.length} recorded runs</span></div>
          {measured ? (
            <>
              <div className="big-sm num">{sec(bench.total!.p50, 1)}<small>s</small></div>
              <p className="small muted">median across {runs.length} liquidations on the live testnets, p95 {sec(bench.total!.p95, 1)} s.</p>
              <a className="btn btn-sm" href="#/app/latency">Open the Latency Lab <Arrow /></a>
            </>
          ) : <p className="muted">Run <code>npm run bench</code> to record it.</p>}
        </section>
      </div>

      <section className="panel spot">
        <div className="panel-top">
          <h2>What just happened</h2>
          <a className="btn btn-sm" href="#/app/activity">All activity <Arrow /></a>
        </div>
        {recent.length === 0 ? <p className="muted empty-sm">Reading recent events…</p> : (
          <ul className="feed compact">
            {recent.map((e) => (
              <li key={e.key} className={`lane-${e.lane}`}>
                <i className="dot" />
                <span className="f-text">{e.text}</span>
                <span className="f-lane small muted">{LANE_SHORT[e.lane]}</span>
                <a className="f-time small muted ul" href={txUrl(e.lane, e.hash)} target="_blank" rel="noreferrer">{e.approx ? "≈ " : ""}{ago(e.at)}</a>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

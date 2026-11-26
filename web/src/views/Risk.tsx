import { useEffect, useMemo, useState } from "react";
import { LIQ_THRESHOLD, MAX_LTV, MAX_MOVE, PENALTY, PRICE_MAX, PRICE_MIN, START_PRICE } from "../chain";
import { liqPrice, stageOf, wouldLiquidate } from "../market";
import { num, pct, seizeFor, usd } from "../format";
import { Arrow } from "../ui";
import LiveLoop from "./LiveLoop";
import type { Ctx } from "./ctx";

function PriceDesk({ c }: { c: Ctx }) {
  const { m, target, setTarget, account, busy, connect, fuel } = c;
  const [tnow, setTnow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => { const t = setInterval(() => setTnow(Math.floor(Date.now() / 1000)), 1000); return () => clearInterval(t); }, []);
  const cooldown = Math.max(0, (fuel.feedNextAt ?? 0) - tnow);
  const price = m.price;
  const lo = price ? Math.max(PRICE_MIN, Math.ceil(price * (1 - MAX_MOVE))) : PRICE_MIN;
  const hi = price ? Math.min(PRICE_MAX, Math.floor(price * (1 + MAX_MOVE))) : PRICE_MAX;
  const eff = Math.min(hi, Math.max(lo, target ?? price ?? START_PRICE));
  const open = m.loans.filter((l) => stageOf(l) === "active");
  const hits = wouldLiquidate(m.loans, eff);
  const synced = price !== undefined && m.rcPrice !== undefined && Math.abs(price - m.rcPrice) < 1e-6;
  const changed = price !== undefined && Math.abs(eff - price) > 0.004;
  const x = (p: number) => ((p - lo) / Math.max(1, hi - lo)) * 100;

  // Group liquidation-price ticks that fall on nearly the same spot.
  const ticks = useMemo(() => {
    const g = new Map<number, { p: number; ids: bigint[] }>();
    for (const l of open) {
      const p = liqPrice(l);
      if (p < lo || p > hi) continue;
      const key = Math.round(((p - lo) / Math.max(1, hi - lo)) * 60);
      const e = g.get(key) ?? { p, ids: [] };
      e.ids.push(l.id);
      g.set(key, e);
    }
    return [...g.values()];
  }, [open, lo, hi]);
  const below = open.filter((l) => liqPrice(l) < lo).length;
  const seized = hits.slice(0, 10).reduce((a, l) => a + seizeFor(l, eff), 0);
  const debt = hits.slice(0, 10).reduce((a, l) => a + l.debt, 0);
  const preset = (f: number) => setTarget(Math.min(hi, Math.max(lo, Math.round((price ?? START_PRICE) * f))));

  return (
    <section className="panel spot ruler-panel" aria-labelledby="h-price">
      <div className="price-top">
        <div>
          <p className="tag" id="h-price">ETH / USD · demo feed on Base</p>
          <div className="price-now num">{usd(price, 2)}</div>
        </div>
        <div className="sync">
          <span className={`chip ${synced ? "live" : "warn"}`} title="The reactive contract's own copy of the price, read from Lasna">
            {m.rcPrice === undefined ? "Reactive: …" : synced ? `Reactive in sync · round ${m.rcRound}` : `Reactive sees ${usd(m.rcPrice, 2)} · round ${m.rcRound}`}
          </span>
          <span className="muted small num">{m.open ?? "—"} open loans · pool liquidity {m.liquidity !== undefined ? `${num(m.liquidity, 0)} tUSD` : "—"}</span>
        </div>
      </div>

      <div className="ruler">
        <div className="ruler-ticks" aria-hidden="true">
          {ticks.map((t) => (
            <span key={t.p} className={`rt ${eff <= t.p ? "hit" : ""}`} style={{ left: `${x(t.p)}%` }} title={`liquidation price ${usd(t.p, 2)}`}>
              <em>{t.ids.length === 1 ? `#${t.ids[0]}` : `${t.ids.length} loans`}</em><i />
            </span>
          ))}
        </div>
        <div className="ruler-track">
          {price !== undefined && changed && <div className={`zone ${eff < price ? "down" : "up"}`} style={{ left: `${Math.min(x(eff), x(price))}%`, width: `${Math.abs(x(eff) - x(price))}%` }} />}
          {price !== undefined && <div className="now" style={{ left: `${x(price)}%` }}><em>now</em></div>}
          <input
            type="range" className="ruler-input" min={lo} max={hi} step={1} value={eff}
            onChange={(e) => setTarget(Number(e.target.value))}
            aria-label="Target ETH price in USD" aria-valuetext={usd(eff)} disabled={price === undefined}
          />
        </div>
        <div className="ruler-scale num"><span>{usd(lo)}</span><span className="ruler-hint">±{MAX_MOVE * 100}% per update, the feed's guardrail</span><span>{usd(hi)}</span></div>
      </div>

      <div className="price-bottom">
        <div className="preview" aria-live="polite">
          <div className="target num">{usd(eff, 0)}</div>
          {!changed ? (
            <p className="muted">{open.length === 0 ? "No open loans yet. Borrow, and each loan's liquidation price appears on the ruler as a tick." : `Drag the handle to pick a price. Ticks mark the price at which each open loan reaches 80% LTV.${below ? ` ${below} more sit below ${usd(lo)}.` : ""}`}</p>
          ) : hits.length ? (
            <p>
              <b>{hits.length} loan{hits.length > 1 ? "s" : ""}</b> would be liquidated ({hits.slice(0, 6).map((l) => `#${l.id}`).join(", ")}{hits.length > 6 ? "…" : ""}).
              {" "}{usd(debt)} of debt closed, about {num(seized, 3)} tWETH seized.{hits.length > 10 ? " One update handles 10; the rest wait for the next." : ""}
            </p>
          ) : (
            <p className="muted">No open loan crosses 80% at this price. Reactive will still record the new price.</p>
          )}
        </div>
        <div className="price-actions">
          <div className="presets" role="group" aria-label="Presets">
            <button className="btn btn-sm" onClick={() => preset(0.9)}>−10%</button>
            <button className="btn btn-sm" onClick={() => preset(0.8)}>−20%</button>
            <button className="btn btn-sm" onClick={() => setTarget(Math.min(hi, Math.max(lo, START_PRICE)))}>Reset to $3,000</button>
          </div>
          {account ? (
            <button className="btn btn-primary" disabled={!changed || !!busy || cooldown > 0} onClick={() => c.act.post(Math.round(eff * 100) / 100)} title={cooldown > 0 ? "The feed accepts one update per cooldown, so nobody can make Reactive run in a loop" : undefined}>
              {busy === "post" ? "Waiting for your wallet…" : cooldown > 0 ? `Next update in ${cooldown}s` : changed ? `Post ${usd(eff)}` : "Pick a price"} <Arrow />
            </button>
          ) : (
            <button className="btn btn-primary" onClick={connect}>Connect wallet to post <Arrow /></button>
          )}
        </div>
      </div>
    </section>
  );
}

/** What each price drop would do to the whole book, and whether the pool would still be covered. */
function Stress({ c }: { c: Ctx }) {
  const { m } = c;
  const price = m.price ?? 0;
  const active = m.loans.filter((l) => stageOf(l) === "active");
  const rows = useMemo(() => {
    const totalDebt = active.reduce((a, l) => a + l.debt, 0);
    return [-0.05, -0.1, -0.2, -0.3, -0.4, -0.5].map((d) => {
      const p = Math.max(PRICE_MIN, price * (1 + d));
      const hit = wouldLiquidate(m.loans, p);
      const handled = hit.slice(0, 10);
      const debt = handled.reduce((a, l) => a + l.debt, 0);
      const seizedUsd = handled.reduce((a, l) => a + seizeFor(l, p) * p, 0);
      const shortfall = hit.reduce((a, l) => a + Math.max(0, l.debt - l.collateral * p), 0);
      const remainingDebt = totalDebt - debt;
      const remainingValue = active.filter((l) => !handled.includes(l)).reduce((a, l) => a + l.collateral * p, 0);
      return { d, p, n: hit.length, handled: handled.length, debt, seizedUsd, shortfall, cover: remainingDebt > 0 ? remainingValue / remainingDebt : undefined };
    });
  }, [m.loans, price, active]);

  return (
    <section className="panel spot">
      <div className="panel-top">
        <h2>Stress test</h2>
        <span className="tag">the whole book, at each price drop</span>
      </div>
      {active.length === 0 ? (
        <p className="muted empty-sm">No open loans to stress. Once there are some, this shows what a crash would do to them and to the pool.</p>
      ) : (
        <div className="table-scroll">
          <table className="tbl stress">
            <thead><tr><th>Drop</th><th>ETH</th><th>Loans liquidated</th><th>Debt closed</th><th>Collateral seized</th><th>Pool shortfall</th><th>Cover after</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.d}>
                  <td data-l="Drop" className="num">{pct(r.d, 0)}</td>
                  <td data-l="ETH" className="num">{usd(r.p)}</td>
                  <td data-l="Loans liquidated" className="num">{r.n}{r.n > r.handled ? <span className="muted small"> ({r.handled} per update)</span> : ""}</td>
                  <td data-l="Debt closed" className="num">{usd(r.debt)}</td>
                  <td data-l="Collateral seized" className="num">{usd(r.seizedUsd)}</td>
                  <td data-l="Pool shortfall" className={`num ${r.shortfall > 0 ? "neg" : ""}`}>{r.shortfall > 0 ? usd(r.shortfall) : "none"}</td>
                  <td data-l="Cover after" className="num">{r.cover === undefined ? "—" : `${r.cover.toFixed(2)}×`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="small muted">
        A loan is liquidated above 80% LTV. The treasury takes the debt plus a {pct(PENALTY, 0)} penalty in tWETH, and the rest goes back to the borrower. A shortfall appears only if the collateral
        is worth less than the debt, which needs a fall larger than the gap between 80% and 100% LTV. "Cover after" is the value of the collateral still locked divided by the debt still owed.
      </p>
    </section>
  );
}

/** A calculator for a loan that does not exist yet. Nothing here is read from or sent to a chain. */
function Simulator({ c }: { c: Ctx }) {
  const price = c.m.price ?? START_PRICE;
  const [coll, setColl] = useState("1");
  const [ltvTarget, setLtvTarget] = useState(0.6);
  const amount = Number(coll) || 0;
  const debt = amount * price * ltvTarget;
  const liq = amount > 0 ? debt / (amount * LIQ_THRESHOLD) : 0;
  const drops = [-0.1, -0.2, -0.3, -0.4, -0.5];

  return (
    <section className="panel spot">
      <div className="panel-top"><h2>Position simulator</h2><span className="tag">hypothetical, nothing is sent</span></div>
      <div className="sim">
        <div className="sim-in">
          <label className="field">
            <span className="tag">Collateral</span>
            <span className="input-wrap"><input className="input num" inputMode="decimal" maxLength={14} value={coll} onChange={(e) => setColl(e.target.value.replace(/[^\d.]/g, ""))} aria-label="Simulated collateral in tWETH" /><span className="unit">tWETH</span></span>
          </label>
          <label className="field">
            <span className="tag">Loan-to-value <b className="num">{pct(ltvTarget)}</b></span>
            <input type="range" className="slider" min={0.1} max={0.75} step={0.01} value={ltvTarget} onChange={(e) => setLtvTarget(Number(e.target.value))} style={{ ["--v" as string]: `${((ltvTarget - 0.1) / 0.65) * 100}%` }} aria-label="Simulated loan to value" />
            <span className="scale"><span>10%</span><span className="mark" style={{ left: `${((MAX_LTV - 0.1) / 0.65) * 100}%` }}>70% max</span></span>
          </label>
          <dl className="rules">
            <div><dt>ETH price now</dt><dd className="num">{usd(price, 2)}</dd></div>
            <div><dt>Collateral value</dt><dd className="num">{usd(amount * price)}</dd></div>
            <div><dt>You would borrow</dt><dd className="num">{usd(debt)} tUSD</dd></div>
            <div><dt>Liquidated if ETH ≤</dt><dd className="num">{usd(liq, 2)} (−{pct(Math.max(0, 1 - liq / price))})</dd></div>
          </dl>
        </div>
        <div className="table-scroll">
          <table className="tbl fit">
            <thead><tr><th>If ETH falls</th><th>ETH</th><th>LTV</th><th>Outcome</th><th>You keep</th></tr></thead>
            <tbody>
              {drops.map((d) => {
                const p = price * (1 + d);
                const v = amount > 0 ? debt / (amount * p) : 0;
                const hit = v > LIQ_THRESHOLD;
                const taken = hit ? seizeFor({ collateral: amount, debt }, p) : 0;
                return (
                  <tr key={d}>
                    <td data-l="If ETH falls" className="num">{pct(d, 0)}</td>
                    <td data-l="ETH" className="num">{usd(p)}</td>
                    <td data-l="LTV" className="num">{pct(v)}</td>
                    <td data-l="Outcome"><span className={`state ${hit ? "bad" : v > 0.75 ? "warn" : "ok"}`}>{hit ? "Liquidated" : v > 0.75 ? "At risk" : "Safe"}</span></td>
                    <td data-l="You keep" className="num">{hit ? `${num(amount - taken, 3)} tWETH + ${usd(debt)} tUSD` : "everything"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      <p className="small muted">On liquidation the treasury takes the debt plus {pct(PENALTY, 0)} in tWETH at the price that triggered it, and the rest of the collateral goes back to you. You keep the tUSD you borrowed.</p>
    </section>
  );
}

export default function Risk({ c }: { c: Ctx }) {
  return (
    <div className="view">
      <PriceDesk c={c} />
      <LiveLoop c={c} />
      <Stress c={c} />
      <Simulator c={c} />
    </div>
  );
}

import { DEPLOYMENTS, LANES, LANE_NAME, LIQ_THRESHOLD, LOW_FUEL, MAX_LTV, MAX_PER_BORROWER, MIN_DEBT, MIN_FUEL, PENALTY, REACTION_COST, RETRY_AFTER, addrUrl, deployed, sourcifyUrl, type Lane } from "../chain";
import { pct } from "../format";
import { CopyBtn, Ext, Tick } from "../ui";
import type { Ctx } from "./ctx";

const CONTRACTS = [
  ["reactive", "TandemReactive"], ["feed", "PriceFeed"], ["vault", "CollateralVault"], ["pool", "LendingPool"], ["tWETH", "tWETH"], ["tUSD", "tUSD"],
] as const;

function Gauge({ label, value, unit, low, min, max, digits = 3, debt }: { label: string; value?: number; unit: string; low: number; min: number; max: number; digits?: number; debt?: number }) {
  const tone = value === undefined ? "" : (debt ?? 0) > 0 || value < min ? "bad" : value < low ? "warn" : "ok";
  return (
    <div className={`gauge ${tone}`}>
      <div className="g-top"><span className="tag">{label}</span><span className="state">{tone === "bad" ? ((debt ?? 0) > 0 ? "in debt" : "empty") : tone === "warn" ? "low" : tone === "ok" ? "funded" : "…"}</span></div>
      <b className="num">{value === undefined ? "—" : value.toFixed(digits)} <small>{unit}</small></b>
      <span className="g-bar"><i style={{ width: `${Math.min(100, ((value ?? 0) / max) * 100)}%` }} /></span>
      {(debt ?? 0) > 0 && <span className="small bad-text">owes {debt!.toFixed(6)} {unit}, deliveries are halted</span>}
    </div>
  );
}

export default function System({ c }: { c: Ctx }) {
  const { fuel, m, chain } = c;
  const synced = m.round !== undefined && m.rcRound !== undefined && m.round === m.rcRound;
  const lag = m.round !== undefined && m.rcRound !== undefined ? m.round - m.rcRound : undefined;

  return (
    <div className="view">
      <section className="panel spot">
        <div className="panel-top"><h2>Automation fuel</h2><span className="tag">what keeps it running</span></div>
        <div className="gauges">
          <Gauge label="Reactive contract" value={fuel.rc} unit="lREACT" low={LOW_FUEL} min={MIN_FUEL} max={2} digits={3} debt={fuel.rcDebt} />
          <Gauge label="Vault · Base callbacks" value={fuel.vault} unit="ETH" low={0.0008} min={0.0002} max={0.004} digits={5} debt={fuel.vaultDebt} />
          <Gauge label="Pool · Unichain callbacks" value={fuel.pool} unit="ETH" low={0.0008} min={0.0002} max={0.006} digits={5} debt={fuel.poolDebt} />
        </div>
        <p className="small muted">
          Every time one of the contracts' events matters, the reactive contract runs and pays about {REACTION_COST} lREACT (measured). The vault and the pool pay for their own callbacks in ETH.
          {fuel.rc !== undefined && <> At that rate the reactive contract can serve roughly <b className="num">{Math.floor(fuel.rc / REACTION_COST)}</b> more reactions.</>}{" "}
          If a contract falls into debt, the network stops delivering to it. The operator tops these up with <code>npm run guard</code>.
        </p>
      </section>

      <div className="grid-2">
        <section className="panel spot">
          <div className="panel-top"><h2>Chains</h2><span className="tag">live from the public RPCs</span></div>
          <div className="table-scroll">
            <table className="tbl fit">
              <thead><tr><th>Chain</th><th>Latest block</th><th>Block time</th><th>RPC latency</th></tr></thead>
              <tbody>
                {LANES.map((l: Lane) => {
                  const h = chain[l];
                  return (
                    <tr key={l} className={`lane-${l}`}>
                      <td data-l="Chain"><i className="dot" /> {LANE_NAME[l]}</td>
                      <td data-l="Latest block" className="num">{h.head ? <Tick value={h.head.toString()} /> : <span className="muted">unreachable</span>}</td>
                      <td data-l="Block time" className="num">{h.blockMs ? `${(h.blockMs / 1000).toFixed(2)} s` : "…"}</td>
                      <td data-l="RPC latency" className="num">{h.latencyMs ? `${Math.round(h.latencyMs)} ms` : "…"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="small muted">Block time is measured between our own polls, so it is approximate.</p>
        </section>

        <section className="panel spot">
          <div className="panel-top"><h2>Is Reactive keeping up?</h2></div>
          <dl className="rules">
            <div><dt>Feed round on Base</dt><dd className="num">{m.round ?? "—"}</dd></div>
            <div><dt>Round the reactive contract has processed</dt><dd className="num">{m.rcRound ?? "—"}</dd></div>
            <div><dt>Status</dt><dd className={`num ${synced ? "ok-text" : "warn-text"}`}>{lag === undefined ? "…" : synced ? "in sync" : `${lag} round${lag === 1 ? "" : "s"} behind`}</dd></div>
            <div><dt>Price on Base</dt><dd className="num">{m.price !== undefined ? `$${m.price.toFixed(2)}` : "—"}</dd></div>
            <div><dt>Price Reactive holds</dt><dd className="num">{m.rcPrice !== undefined ? `$${m.rcPrice.toFixed(2)}` : "—"}</dd></div>
          </dl>
          <p className="small muted">A few seconds behind right after a price update is normal. A gap that stays means the reactive contract is out of fuel or the network is down.</p>
        </section>
      </div>

      <div className="grid-2">
        <section className="panel spot">
          <div className="panel-top"><h2>Parameters</h2><span className="tag">enforced by the contracts</span></div>
          <dl className="rules">
            <div><dt>Max loan-to-value</dt><dd className="num">{pct(MAX_LTV, 0)}</dd></div>
            <div><dt>Liquidation threshold</dt><dd className="num">{pct(LIQ_THRESHOLD, 0)}</dd></div>
            <div><dt>Liquidation penalty</dt><dd className="num">{pct(PENALTY, 0)}</dd></div>
            <div><dt>Minimum loan</dt><dd className="num">{MIN_DEBT} tUSD</dd></div>
            <div><dt>Open loans per borrower</dt><dd className="num">{MAX_PER_BORROWER}</dd></div>
            <div><dt>Open loans in total</dt><dd className="num">50</dd></div>
            <div><dt>Liquidations per price update</dt><dd className="num">10</dd></div>
            <div><dt>Retry window for <code>poke</code></dt><dd className="num">{RETRY_AFTER} s</dd></div>
            <div><dt>Price feed guardrail</dt><dd className="num">$100 to $20,000, ±50% per update, one update per 30 s</dd></div>
          </dl>
        </section>

        <section className="panel spot">
          <div className="panel-top"><h2>Contracts</h2><span className="tag">source verified on Sourcify</span></div>
          {!deployed ? <p className="muted">Not deployed.</p> : (
            <ul className="addr-list">
              {CONTRACTS.map(([k, name]) => {
                const e = DEPLOYMENTS[k]!;
                return (
                  <li key={k} className={`lane-${e.chain}`}>
                    <span><i className="dot" /> {name}</span>
                    <a className="mono ul" href={addrUrl(e.chain, e.address)} target="_blank" rel="noreferrer">{e.address.slice(0, 8)}…{e.address.slice(-6)}</a>
                    <CopyBtn text={e.address} />
                    <a className="verified" href={sourcifyUrl(e.chain, e.address)} target="_blank" rel="noreferrer">source<Ext /></a>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>

      <section className="panel spot">
        <div className="panel-top"><h2>Known limits of this deployment</h2></div>
        <ul className="limits-list">
          <li>The price feed is a demo feed that anyone can post to. It accepts one update per 30 seconds, which caps how fast anyone can make the reactive contract spend fuel, but it does not stop someone who keeps paying gas. The real fix is a fee per loan, which is not built.</li>
          <li>Reactions are paid from a finite lREACT balance. Watch the fuel gauge above, and the operator tops it up with <code>npm run guard</code>.</li>
          <li>Test tokens, 0% interest, and the treasury is a plain wallet.</li>
        </ul>
      </section>
    </div>
  );
}

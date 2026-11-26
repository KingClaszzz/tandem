import { useEffect, useState } from "react";
import { LIQ_THRESHOLD, MAX_LTV, MAX_PER_BORROWER, MIN_DEBT, PENALTY } from "../chain";
import { liqPrice } from "../market";
import { num, pct, usd } from "../format";
import { buffer } from "../stats";
import { Arrow, Hint } from "../ui";
import LiveLoop from "./LiveLoop";
import type { Ctx } from "./ctx";

const PRESETS: [string, number][] = [["Safer", 0.4], ["Balanced", 0.6], ["Maximum", MAX_LTV]];

function BorrowForm({ c }: { c: Ctx }) {
  const { m, account, busy, connect, hasWallet, myOpen, halted, fuel } = c;
  const maxBorrow = fuel.maxBorrow;
  const [coll, setColl] = useState("0.05");
  const [target, setTarget] = useState(0.6);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => { const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000); return () => clearInterval(t); }, []);

  const amount = Number(coll) || 0;
  const p = m.price ?? 0;
  const debt = Math.floor(amount * p * target);
  const liq = liqPrice({ collateral: amount, debt });
  const buf = buffer({ collateral: amount, debt }, p);
  const wait = m.me.nextDrip && m.me.nextDrip > now ? m.me.nextDrip - now : 0;

  // The hardened vault rejects these outright, so they are blocked here. The first vault accepted them and
  // Reactive refused them afterwards, so there they are only a warning.
  const hard = maxBorrow !== undefined;
  const blocked: string[] = [];
  const reasons: string[] = [];
  if (debt > 0 && debt < MIN_DEBT) (hard ? blocked : reasons).push(`below the ${MIN_DEBT} tUSD minimum`);
  if (hard && debt > maxBorrow) blocked.push(`above the ${maxBorrow.toLocaleString("en-US")} tUSD maximum per loan`);
  if (myOpen >= MAX_PER_BORROWER) (hard ? blocked : reasons).push(`you already have ${MAX_PER_BORROWER} open loans`);
  if (target > MAX_LTV) reasons.push("above 70% LTV");
  const noGas = Boolean(account) && ((m.me.ethBase ?? 1) === 0 || (m.me.ethUni ?? 1) === 0);
  const working = busy === "approve" || busy === "lock" || busy === "borrow";
  const typed = /^\d*\.?\d+$/.test(coll) && amount > 0 && debt > 0;
  const funded = (m.me.weth ?? 0) >= amount;
  const tone = buf < 0.1 ? "bad" : buf < 0.25 ? "warn" : "ok";

  return (
    <section className="panel spot borrow" aria-labelledby="h-borrow">
      <div className="panel-top"><h2 id="h-borrow">Borrow test USD against test WETH</h2><span className="tag">lock on Base, receive on Unichain</span></div>

      {account && (
        <div className="b-wallet">
          <span><span className="tag">Your tWETH</span><b className="num">{num(m.me.weth)}</b></span>
          <span><span className="tag">Your tUSD</span><b className="num">{num(m.me.usd, 2)}</b></span>
          <span title="Gas on Base / on Unichain"><span className="tag">Gas</span><b className="num">{num(m.me.ethBase, 4)} / {num(m.me.ethUni, 4)} ETH</b></span>
          <span className="b-mint">
            <button type="button" className="btn btn-sm" disabled={!!busy || wait > 0} onClick={c.act.faucet}>{busy === "faucet" ? "Minting…" : wait ? `Mint again in ${wait}s` : "Mint 2 test WETH"}</button>
            <button type="button" className="btn btn-sm" disabled={!!busy} onClick={c.act.usdFaucet} title="Test USD, only needed to repay more than you borrowed">{busy === "faucet-usd" ? "Minting…" : "Mint test USD"}</button>
          </span>
        </div>
      )}
      {noGas && <p className="banner small">You need a little test ETH on both Base Sepolia and Unichain Sepolia for gas. Any public faucet works.</p>}

      <form className="borrow-grid" onSubmit={(e) => { e.preventDefault(); if (!account) return connect(); if (typed && funded) c.act.borrow(coll, debt); }}>
        <div className="b-inputs">
          <label className="field">
            <span className="f-label">1. How much collateral?</span>
            <span className="input-wrap">
              <input className="input num" inputMode="decimal" maxLength={24} value={coll} onChange={(e) => setColl(e.target.value.replace(/[^\d.]/g, ""))} aria-label="Collateral in tWETH" />
              <span className="unit">tWETH</span>
            </span>
            <span className="f-sub">
              Worth <b className="num">{usd(amount * p)}</b> at today's price
              {account && <button type="button" className="linklike" onClick={() => setColl((Math.floor((m.me.weth ?? 0) * 1e6) / 1e6).toString())}>use all I have</button>}
            </span>
          </label>

          <div className="field">
            <span className="f-label">2. How much do you want to borrow? <Hint text="Loan-to-value (LTV) is the loan as a share of the collateral's value. Higher means more money now but a smaller safety buffer. Loans above 70% are refused, and loans are liquidated above 80%." /></span>
            <div className="presets-row" role="group" aria-label="Borrow preset">
              {PRESETS.map(([name, v]) => <button type="button" key={name} className={`fchip ${Math.abs(target - v) < 0.005 ? "on" : ""}`} onClick={() => setTarget(v)}>{name} · {pct(v, 0)}</button>)}
            </div>
            <input type="range" className="slider" min={0.1} max={0.75} step={0.01} value={target} onChange={(e) => setTarget(Number(e.target.value))} style={{ ["--v" as string]: `${((target - 0.1) / 0.65) * 100}%` }} aria-label="Loan to value" />
            <span className="scale"><span>10%</span><span className="mark" style={{ left: `${((MAX_LTV - 0.1) / 0.65) * 100}%` }}>70% max</span></span>
          </div>
        </div>

        <aside className="b-summary" aria-live="polite">
          <span className="tag">You will receive</span>
          <div className="b-big num">{usd(debt)}<small> tUSD on Unichain</small></div>

          <div className={`b-meter ${tone}`} title={`Price buffer ${pct(buf)}`}>
            <span className="b-track"><i style={{ width: `${Math.min(100, (buf / 0.6) * 100)}%` }} /></span>
            <span className="b-meter-l"><b>Safety buffer</b><span className="num">ETH can fall {pct(buf, 0)} before liquidation</span></span>
          </div>

          <p className="b-sentence">
            If ETH drops below <b className="num">{usd(liq, 2)}</b>, Reactive closes the loan and your collateral is sold to repay it, plus a {pct(PENALTY, 0)} penalty. You keep the {usd(debt)} and whatever collateral is left.
          </p>

          <dl className="b-rows">
            <div><dt>Collateral you lock</dt><dd className="num">{num(amount, 4)} tWETH</dd></div>
            <div><dt>Liquidation price <Hint text="The ETH price at which this loan reaches 80% LTV and is liquidated." /></dt><dd className="num">{usd(liq, 2)}</dd></div>
            <div><dt>Interest</dt><dd className="num">none (demo)</dd></div>
          </dl>

          {blocked.length > 0 && <p className="small warn">The vault will not accept this loan: {blocked.join(", ")}.</p>}
          {reasons.length > 0 && <p className="small warn">Reactive will refuse this loan: {reasons.join(", ")}. The collateral comes straight back. That loop is on-chain too, try it.</p>}
          {account && !funded && <p className="small warn">You hold {num(m.me.weth)} tWETH. Mint some first.</p>}
          {halted && <p className="small warn">New loans are paused: Reactive has run out of fuel, so nothing could release your collateral. The operator needs to top it up.</p>}

          {account ? (
            <button className="btn btn-primary btn-lg b-go" disabled={!!busy || !typed || !funded || halted || blocked.length > 0}>
              {working ? (busy === "approve" ? "Approving tWETH…" : "Locking…") : "Lock collateral and borrow"} <Arrow />
            </button>
          ) : (
            <button className="btn btn-primary btn-lg b-go" type="submit">{hasWallet ? "Connect wallet to borrow" : "Install a wallet to borrow"} <Arrow /></button>
          )}
        </aside>
      </form>
    </section>
  );
}

export default function Borrow({ c }: { c: Ctx }) {
  return (
    <div className="view">
      <BorrowForm c={c} />
      <LiveLoop c={c} />
      <div className="grid-2">
        <section className="panel spot">
          <div className="panel-top"><h2>How this loan moves</h2></div>
          <ol className="flow">
            <li className="lane-base"><i className="dot" /><div><b>Base</b><span>You lock tWETH in the vault. It emits <code>CollateralLocked</code>.</span></div></li>
            <li className="lane-lasna"><i className="dot" /><div><b>Lasna</b><span>Reactive checks the size, your loan count and the {pct(MAX_LTV, 0)} limit at the last price it saw.</span></div></li>
            <li className="lane-uni"><i className="dot" /><div><b>Unichain</b><span>If it passes, the pool pays you in tUSD. If not, the collateral is sent back.</span></div></li>
          </ol>
        </section>
        <section className="panel spot">
          <div className="panel-top"><h2>The rules, enforced on-chain</h2></div>
          <dl className="rules">
            <div><dt>Borrow up to</dt><dd className="num">{pct(MAX_LTV, 0)} of the collateral's value</dd></div>
            <div><dt>Liquidation at</dt><dd className="num">{pct(LIQ_THRESHOLD, 0)} loan-to-value</dd></div>
            <div><dt>Liquidation penalty</dt><dd className="num">{pct(PENALTY, 0)}, the rest returns to you</dd></div>
            <div><dt>Minimum loan</dt><dd className="num">{MIN_DEBT} tUSD</dd></div>
            <div><dt>Open loans per wallet</dt><dd className="num">{MAX_PER_BORROWER}</dd></div>
          </dl>
        </section>
      </div>
    </div>
  );
}

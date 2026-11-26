import { useEffect, useMemo, useRef, useState } from "react";
import type { Address } from "viem";
import { LIQ_THRESHOLD, MAX_LTV, MAX_PER_BORROWER, RC_LABEL, RETRY_AFTER } from "../chain";
import { fmtAddr } from "../wallet";
import { isFinal, isOpen, liqPrice, ltv, STAGE_LABEL, stageOf, type Loan, type Stage } from "../market";
import { num, pct, seizeFor, usd } from "../format";
import { buffer } from "../stats";
import { Arrow } from "../ui";
import LiveLoop from "./LiveLoop";
import type { Ctx } from "./ctx";

const VAULT = ["—", "Locked", "Released", "Seized"];
const POOL = ["—", "Active", "Repaid", "Liquidated", "Rejected"];
const TONE: Record<Stage, string> = { waiting: "warn", active: "ok", liquidating: "warn", seizing: "warn", releasing: "warn", repaid: "dim", refused: "dim", rejected: "dim", seized: "bad" };

export function Health({ l, price }: { l: Loan; price?: number }) {
  const v = price ? ltv(l, price) : 0;
  const tone = v > LIQ_THRESHOLD ? "bad" : v > 0.75 ? "warn" : "ok";
  return (
    <span className={`health ${tone}`} title={`LTV ${pct(v)}. Liquidation at 80%`}>
      <span className="bar"><i style={{ width: `${Math.min(100, v * 100)}%` }} /><em style={{ left: `${MAX_LTV * 100}%` }} /><em className="hard" style={{ left: `${LIQ_THRESHOLD * 100}%` }} /></span>
      <span className="num">{pct(v)}</span>
    </span>
  );
}

/** Do the three chains agree about this loan? Each chain holds its own piece, so a mismatch would be a real bug. */
function chains(l: Loan): { label: string; tone: "ok" | "warn" | "bad"; title: string } {
  const title = `Base: ${VAULT[l.vault]} · Unichain: ${POOL[l.pool]}${l.rc !== undefined ? ` · Lasna: ${RC_LABEL[l.rc]}` : ""}`;
  const impossible = (l.vault === 3 && l.pool !== 3) || (l.vault === 2 && (l.pool === 3 || l.pool === 1));
  if (impossible) return { label: "Mismatch", tone: "bad", title };
  const s = stageOf(l);
  if (s === "waiting" || s === "liquidating" || s === "seizing" || s === "releasing") return { label: "In flight", tone: "warn", title };
  return { label: "In sync", tone: "ok", title };
}

/** Browser notifications when one of your loans gets close to its liquidation price. Runs only while the tab is open. */
function useGuardian(c: Ctx) {
  const [on, setOn] = useState(() => { try { return localStorage.getItem("tandem:guardian") === "1"; } catch { return false; } });
  const [thr, setThr] = useState(() => { try { return Number(localStorage.getItem("tandem:guardian-thr")) || 0.1; } catch { return 0.1; } });
  const [toast, setToast] = useState<string>();
  const alerted = useRef(new Set<string>());
  const price = c.m.price ?? 0;

  useEffect(() => {
    if (!on || !price) return;
    for (const l of c.mine) {
      const key = l.id.toString();
      if (stageOf(l) !== "active") { alerted.current.delete(key); continue; }
      const b = buffer(l, price);
      if (b < thr && !alerted.current.has(key)) {
        alerted.current.add(key);
        const msg = `Loan #${l.id} is only ${(b * 100).toFixed(1)}% above its liquidation price of ${usd(liqPrice(l), 2)}. Repay it or expect a liquidation.`;
        setToast(msg);
        try { if (typeof Notification !== "undefined" && Notification.permission === "granted") new Notification("Tandem: a loan is close to liquidation", { body: msg }); } catch { /* not allowed */ }
      } else if (b >= thr * 1.2) alerted.current.delete(key);
    }
  }, [on, thr, c.mine, price]);

  const set = (v: boolean) => {
    setOn(v);
    try { localStorage.setItem("tandem:guardian", v ? "1" : "0"); } catch { /* ignore */ }
    if (v && typeof Notification !== "undefined" && Notification.permission === "default") Notification.requestPermission().catch(() => {});
  };
  const setThreshold = (v: number) => { setThr(v); try { localStorage.setItem("tandem:guardian-thr", String(v)); } catch { /* ignore */ } };
  const perm = typeof Notification === "undefined" ? "unsupported" : Notification.permission;
  return { on, set, thr, setThreshold, toast, dismiss: () => setToast(undefined), perm };
}

function Card({ l, c }: { l: Loan; c: Ctx }) {
  const price = c.m.price ?? 0;
  const s = stageOf(l);
  const open = s === "active";
  const lp = liqPrice(l);
  const seized = seizeFor(l, lp);
  return (
    <article className={`pos spot ${open ? "" : "closed"}`}>
      <div className="pos-top">
        <b className="num">Loan #{l.id.toString()}</b>
        <span className={`state ${TONE[s]}`}>{STAGE_LABEL[s]}</span>
      </div>
      <div className="pos-grid">
        <div><span className="tag">Collateral</span><b className="num">{num(l.collateral)} tWETH</b><span className="small muted num">{usd(l.collateral * price)}</span></div>
        <div><span className="tag">Debt</span><b className="num">{l.debt ? usd(l.debt) : "—"}</b><span className="small muted">tUSD on Unichain</span></div>
      </div>
      {open && (
        <>
          <Health l={l} price={price} />
          <div className="pos-liq small">
            <span>Liquidated at <b className="num">{usd(lp, 2)}</b> <span className="muted">(−{pct(buffer(l, price))})</span></span>
            <span className="muted">then {num(seized, 3)} tWETH seized, {num(l.collateral - seized, 3)} back to you</span>
          </div>
        </>
      )}
      {open && <button className="btn btn-sm" disabled={!!c.busy} onClick={() => c.act.repay(l)}>{c.busy === "repay" ? "Repaying…" : "Repay and release collateral"}</button>}
    </article>
  );
}

type Filter = "open" | "all" | "liquidated" | "closed";

export default function Positions({ c }: { c: Ctx }) {
  const { m, mine, account } = c;
  const price = m.price ?? 0;
  const g = useGuardian(c);
  const [filter, setFilter] = useState<Filter>("open");
  const [limit, setLimit] = useState(12);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => { const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 2000); return () => clearInterval(t); }, []);

  const active = mine.filter((l) => stageOf(l) === "active");
  const collateral = active.reduce((a, l) => a + l.collateral, 0);
  const debt = active.reduce((a, l) => a + l.debt, 0);
  const blended = collateral * price > 0 ? debt / (collateral * price) : 0;
  const tight = active.length ? Math.min(...active.map((l) => buffer(l, price))) : undefined;
  const myOpen = mine.filter((l) => isOpen(stageOf(l)));
  const myClosed = mine.filter((l) => isFinal(stageOf(l))).slice(0, 6);

  const rows = useMemo(() => {
    let r = m.loans;
    if (filter === "open") r = r.filter((l) => isOpen(stageOf(l)));
    else if (filter === "liquidated") r = r.filter((l) => stageOf(l) === "seized");
    else if (filter === "closed") r = r.filter((l) => isFinal(stageOf(l)));
    return filter === "open" ? [...r].sort((a, b) => ltv(b, price) - ltv(a, price)) : r;
  }, [m.loans, filter, price]);

  return (
    <div className="view">
      {g.toast && (
        <div className="banner" role="status">
          {g.toast} <button className="linklike" onClick={g.dismiss}>Dismiss</button>
        </div>
      )}

      <section className="panel spot">
        <div className="panel-top">
          <h2>Your account</h2>
          <span className="tag">{account ? fmtAddr(account) : "not connected"}</span>
        </div>
        {!account ? (
          <p className="muted">Connect a wallet to see your positions. The table below shows every loan in the market.</p>
        ) : (
          <div className="kpis tight">
            <div className="kpi"><span className="tag">Collateral</span><b className="num">{num(collateral, 3)} tWETH</b><span className="small muted">{usd(collateral * price)}</span></div>
            <div className="kpi"><span className="tag">Debt</span><b className="num">{usd(debt)}</b><span className="small muted">tUSD</span></div>
            <div className="kpi"><span className="tag">Blended LTV</span><b className="num">{active.length ? pct(blended) : "—"}</b><span className="small muted">liquidation at 80%</span></div>
            <div className="kpi"><span className="tag">Open loans</span><b className="num">{myOpen.length} / {MAX_PER_BORROWER}</b><span className="small muted">per wallet</span></div>
            <div className={`kpi ${tight !== undefined && tight < 0.1 ? "warn" : ""}`}><span className="tag">Tightest buffer</span><b className="num">{tight !== undefined ? `−${pct(tight)}` : "—"}</b><span className="small muted">price drop to liquidation</span></div>
          </div>
        )}
      </section>

      <section className="panel spot guardian">
        <div className="panel-top"><h2>Guardian</h2><span className="tag">browser alerts</span></div>
        <div className="g-row">
          <p className="muted">Get a notification when one of your loans gets close to its liquidation price. It runs in this tab only. Nothing is sent anywhere.</p>
          <label className="g-sel">Alert within
            <select value={g.thr} onChange={(e) => g.setThreshold(Number(e.target.value))} aria-label="Alert threshold">
              <option value={0.05}>5%</option><option value={0.1}>10%</option><option value={0.15}>15%</option><option value={0.2}>20%</option>
            </select>
          </label>
          <button className={`btn btn-sm ${g.on ? "" : "btn-primary"}`} onClick={() => g.set(!g.on)} aria-pressed={g.on}>{g.on ? "Guardian is on" : "Turn on"}</button>
        </div>
        {g.on && g.perm === "denied" && <p className="small warn">Browser notifications are blocked for this site. You will still see alerts here in the page.</p>}
        {g.on && g.perm === "unsupported" && <p className="small warn">This browser has no notifications. You will still see alerts here in the page.</p>}
      </section>

      {account && (myOpen.length > 0 || myClosed.length > 0) && (
        <div className="cards">
          {myOpen.map((l) => <Card key={l.id.toString()} l={l} c={c} />)}
          {myClosed.map((l) => <Card key={l.id.toString()} l={l} c={c} />)}
        </div>
      )}
      {account && myOpen.length === 0 && myClosed.length === 0 && (
        <section className="panel"><p className="muted empty-sm">You have no loans yet. <a className="ul" href="#/app/borrow">Open one <Arrow /></a></p></section>
      )}

      <LiveLoop c={c} />

      <section className="panel spot ledger">
        <div className="panel-top">
          <h2>Market loans</h2>
          <span className="tag">latest {m.loans.length}, read from three chains</span>
          <div className="chips" role="group" aria-label="Filter loans">
            {(["open", "all", "liquidated", "closed"] as Filter[]).map((f) => (
              <button key={f} className={`fchip ${filter === f ? "on" : ""}`} aria-pressed={filter === f} onClick={() => { setFilter(f); setLimit(12); }}>{f}</button>
            ))}
          </div>
        </div>
        {rows.length === 0 ? <p className="muted empty-sm">Nothing here.</p> : (
          <div className="table-scroll">
            <table className="tbl">
              <thead><tr><th>Loan</th><th>Borrower</th><th>Collateral</th><th>Debt</th><th>LTV now</th><th>Liquidates at</th><th>Chains</th><th>State</th><th><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {rows.slice(0, limit).map((l) => {
                  const s = stageOf(l);
                  const mineRow = account && l.owner.toLowerCase() === (account as Address).toLowerCase();
                  const sync = chains(l);
                  const stuck = (s === "waiting" || s === "liquidating" || s === "seizing" || s === "releasing") && l.lastRequest !== undefined && now - l.lastRequest > RETRY_AFTER;
                  return (
                    <tr key={l.id.toString()} className={mineRow ? "me" : ""}>
                      <td data-l="Loan" className="num">#{l.id.toString()}</td>
                      <td data-l="Borrower" className="num">{fmtAddr(l.owner)}</td>
                      <td data-l="Collateral" className="num">{num(l.collateral)} tWETH</td>
                      <td data-l="Debt" className="num">{l.debt ? usd(l.debt) : "—"}</td>
                      <td data-l="LTV now">{s === "active" ? <Health l={l} price={price} /> : <span className="muted">—</span>}</td>
                      <td data-l="Liquidates at" className="num">{s === "active" ? usd(liqPrice(l), 2) : "—"}</td>
                      <td data-l="Chains"><span className={`state ${sync.tone}`} title={sync.title}>{sync.label}</span></td>
                      <td data-l="State"><span className={`state ${TONE[s]}`}>{STAGE_LABEL[s]}</span>{stuck && <span className="muted small"> · no reply for {now - l.lastRequest!}s</span>}</td>
                      <td className="act">
                        <div>
                          {mineRow && s === "active" && <button className="btn btn-sm" disabled={!!c.busy} onClick={() => c.act.repay(l)}>{c.busy === "repay" ? "Repaying…" : "Repay"}</button>}
                          {account && stuck && <button className="btn btn-sm" disabled={!!c.busy} onClick={() => c.act.poke(l)} title="Anyone can re-send a request that has had no answer for a minute">Poke</button>}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {rows.length > limit && <div className="more-row"><button className="btn btn-sm" onClick={() => setLimit((n) => n + 20)}>Show {Math.min(20, rows.length - limit)} more</button></div>}
      </section>
    </div>
  );
}

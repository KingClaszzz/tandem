import { useEffect, useMemo, useState } from "react";
import { parseUnits, type Address } from "viem";
import { ADDR, abi, client, deployed, LANE_NAME, LIQ_THRESHOLD, MAX_LTV, PRICE_MAX, PRICE_MIN, PoolStatus, type Lane } from "./chain";
import { liqPrice, loansUnderThreshold, ltv, useLoop, useMarket, type Loan } from "./market";
import { fmtAddr, send, short, useWallet } from "./wallet";
import { Arrow, LoopTrace, Logo } from "./ui";

const usd = (n?: number, d = 0) => (n === undefined ? "—" : `$${n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })}`);
const num = (n?: number, d = 4) => (n === undefined ? "—" : n.toLocaleString("en-US", { maximumFractionDigits: d }));
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

function useBlocks() {
  const [b, setB] = useState<Partial<Record<Lane, bigint>>>({});
  useEffect(() => {
    let on = true;
    const tick = async () => {
      const r = await Promise.allSettled((["base", "lasna", "uni"] as Lane[]).map((l) => client[l].getBlockNumber()));
      if (on) setB({ base: ok(r[0]), lasna: ok(r[1]), uni: ok(r[2]) });
    };
    const ok = (x: PromiseSettledResult<bigint>) => (x.status === "fulfilled" ? x.value : undefined);
    tick();
    const t = setInterval(tick, 3000);
    return () => { on = false; clearInterval(t); };
  }, []);
  return b;
}

export default function Dashboard() {
  const { account, connect, error: walletErr, hasWallet } = useWallet();
  const m = useMarket(account);
  const loop = useLoop();
  const blocks = useBlocks();
  const [busy, setBusy] = useState<string>();
  const [err, setErr] = useState<string>();

  async function act(label: string, fn: () => Promise<void>) {
    setErr(undefined);
    setBusy(label);
    try { await fn(); } catch (e) { setErr(short(e)); } finally { setBusy(undefined); m.refresh(); }
  }

  const mine = useMemo(() => m.loans.filter((l) => account && l.owner.toLowerCase() === account.toLowerCase()), [m.loans, account]);

  return (
    <div className="app">
      <nav className="nav">
        <div className="wrap wide nav-in">
          <Logo />
          <div className="chains">
            {(["base", "lasna", "uni"] as Lane[]).map((l) => (
              <span key={l} className={`pill lane-${l}`} title={LANE_NAME[l]}>
                <i className="dot" />{LANE_NAME[l].split(" ")[l === "lasna" ? 1 : 0]}
                <span className="num muted">{blocks[l] ? `#${blocks[l]!.toString()}` : "…"}</span>
              </span>
            ))}
          </div>
          {account ? <span className="pill live">{fmtAddr(account)}</span> : <button className="btn btn-sm btn-primary" onClick={connect}>Connect wallet</button>}
        </div>
      </nav>

      <main className="wrap wide dash">
        {!deployed && <div className="banner">Contracts are not deployed yet. Run <code>npm run deploy</code> in the repo root, then rebuild.</div>}
        {(walletErr || err || m.error) && <div className="banner bad" role="alert">{walletErr ?? err ?? m.error}</div>}

        <section className="col">
          <MarketCard m={m} busy={busy} account={account} onSet={(p, label) => act(label, async () => {
            const hits = loansUnderThreshold(m.loans, p).length;
            const r = await send("base", account!, ADDR.feed, abi.feed, "setPrice", [parseUnits(String(p), 8)]);
            loop.track("liquidation", { lane: "base", hash: r.hash, label: "setPrice()", detail: `ETH set to ${usd(p)}`, minedAt: r.minedAt }, { expectLiquidations: hits });
          })} />
          <BorrowCard m={m} account={account} busy={busy} connect={connect} hasWallet={hasWallet}
            onFaucet={() => act("faucet", async () => { await send("base", account!, ADDR.weth, abi.token, "faucet"); })}
            onBorrow={(c, d) => act("borrow", async () => {
              const amount = parseUnits(String(c), 18);
              const allowance = await client.base.readContract({ address: ADDR.weth, abi: abi.token, functionName: "allowance", args: [account!, ADDR.vault] });
              if (allowance < amount) { setBusy("approve tWETH"); await send("base", account!, ADDR.weth, abi.token, "approve", [ADDR.vault, amount]); }
              setBusy("lock");
              const r = await send("base", account!, ADDR.vault, abi.vault, "lock", [amount, parseUnits(String(d), 6)]);
              const id = BigInt(r.receipt.logs.find((l) => l.address.toLowerCase() === ADDR.vault.toLowerCase())!.topics[1]!);
              loop.track("borrow", { lane: "base", hash: r.hash, label: "lock()", detail: `loan #${id}: ${num(c)} tWETH for ${usd(d)}`, minedAt: r.minedAt }, { loanId: id });
            })}
          />
        </section>

        <section className="col">
          <div className="card pad live-card">
            <div className="card-top">
              <h2>Live loop</h2>
              {loop.run && <button className="btn btn-sm" onClick={loop.clear}>Clear</button>}
            </div>
            {loop.run ? (
              <>
                <LoopTrace steps={loop.run.steps} />
                <p className="muted small trace-note">
                  {loop.run.note ?? (loop.run.done ? "Loop complete. Every box links to its transaction." : "Watching the three chains…")}
                  {" "}Times are measured in your browser from the moment the first transaction was mined.
                </p>
              </>
            ) : (
              <div className="empty">
                <p>Borrow, repay or move the price. Each transaction Reactive triggers shows up here, in its chain's column, with the time it took and a link to the explorer.</p>
              </div>
            )}
          </div>
          <MyLoans loans={mine} price={m.price} busy={busy} onRepay={(l) => act("repay", async () => {
            const amount = parseUnits(String(l.debt), 6);
            const allowance = await client.uni.readContract({ address: ADDR.usd, abi: abi.token, functionName: "allowance", args: [account!, ADDR.pool] });
            if (allowance < amount) { setBusy("approve tUSD"); await send("uni", account!, ADDR.usd, abi.token, "approve", [ADDR.pool, amount]); }
            setBusy("repay");
            const r = await send("uni", account!, ADDR.pool, abi.pool, "repay", [l.id]);
            loop.track("repay", { lane: "uni", hash: r.hash, label: "repay()", detail: `loan #${l.id}: ${usd(l.debt)} repaid`, minedAt: r.minedAt }, { loanId: l.id });
          })} />
        </section>

        <AllLoans loans={m.loans} price={m.price} account={account} />
      </main>
    </div>
  );
}

function MarketCard({ m, busy, account, onSet }: { m: ReturnType<typeof useMarket>; busy?: string; account?: Address; onSet: (p: number, label: string) => void }) {
  const [custom, setCustom] = useState("");
  const p = m.price;
  const synced = p !== undefined && m.rcPrice !== undefined && Math.abs(p - m.rcPrice) < 1e-6;
  const crash = p ? Math.max(PRICE_MIN, Math.round(p * 0.8)) : undefined;
  const at = (x?: number) => (x ? loansUnderThreshold(m.loans, x).length : 0);
  const c = Number(custom);
  const customOk = custom !== "" && c >= PRICE_MIN && c <= PRICE_MAX;
  return (
    <div className="card pad">
      <div className="card-top"><h2>Market</h2><span className="tag">tWETH / USD · Base</span></div>
      <div className="price">
        <span className="num big">{usd(p, 2)}</span>
        <span className={`pill ${synced ? "live" : ""}`} title="The price the reactive contract last saw">{m.rcPrice === undefined ? "Reactive: …" : synced ? "Reactive in sync" : `Reactive sees ${usd(m.rcPrice, 2)}`}</span>
      </div>
      <dl className="kv">
        <div><dt>Open loans (Reactive)</dt><dd className="num">{m.active ?? "—"}</dd></div>
        <div><dt>Borrow up to</dt><dd className="num">{pct(MAX_LTV)}</dd></div>
        <div><dt>Liquidation at</dt><dd className="num">{pct(LIQ_THRESHOLD)}</dd></div>
      </dl>
      <div className="price-actions">
        <button className="btn btn-bad" disabled={!account || !!busy || !crash} onClick={() => onSet(crash!, "crash")}>
          Crash −20% {crash ? <span className="num">→ {usd(crash)}</span> : null}
        </button>
        <button className="btn" disabled={!account || !!busy || p === 3000} onClick={() => onSet(3000, "restore")}>Reset to $3,000</button>
      </div>
      <form className="row-form" onSubmit={(e) => { e.preventDefault(); if (customOk) onSet(c, "set"); }}>
        <input className="input num" inputMode="decimal" placeholder="Set any price, e.g. 2450" value={custom} onChange={(e) => setCustom(e.target.value.replace(/[^\d.]/g, ""))} aria-label="New price in USD" />
        <button className="btn" disabled={!account || !!busy || !customOk}>Set</button>
      </form>
      <p className="muted small">
        {crash ? `At ${usd(crash)}, ${at(crash)} open loan${at(crash) === 1 ? "" : "s"} would cross 80%. ` : ""}
        This is a demo feed: anyone can move it between $100 and $20,000.
        {busy && ["crash", "restore", "set"].includes(busy) ? " Waiting for your wallet…" : ""}
      </p>
    </div>
  );
}

function BorrowCard({ m, account, busy, connect, hasWallet, onFaucet, onBorrow }: {
  m: ReturnType<typeof useMarket>; account?: Address; busy?: string; connect: () => void; hasWallet: boolean;
  onFaucet: () => void; onBorrow: (collateral: number, debt: number) => void;
}) {
  const [coll, setColl] = useState("1");
  const [target, setTarget] = useState(0.6);
  const c = Number(coll) || 0;
  const p = m.price ?? 0;
  const debt = Math.floor(c * p * target);
  const liq = liqPrice({ collateral: c, debt });
  const now = Math.floor(Date.now() / 1000);
  const dripWait = m.me.nextDrip && m.me.nextDrip > now ? m.me.nextDrip - now : 0;
  const noGas = account && ((m.me.ethBase ?? 1) === 0 || (m.me.ethUni ?? 1) === 0);

  if (!account) {
    return (
      <div className="card pad">
        <div className="card-top"><h2>Borrow</h2></div>
        <p className="muted">Connect a wallet to lock test collateral on Base Sepolia and borrow test USD on Unichain Sepolia.</p>
        <button className="btn btn-primary" onClick={connect}>{hasWallet ? "Connect wallet" : "Install a browser wallet"} <Arrow /></button>
      </div>
    );
  }
  return (
    <div className="card pad">
      <div className="card-top"><h2>Borrow</h2><span className="tag">lock on Base · receive on Unichain</span></div>
      <dl className="kv">
        <div><dt>tWETH (Base)</dt><dd className="num">{num(m.me.weth)}</dd></div>
        <div><dt>tUSD (Unichain)</dt><dd className="num">{num(m.me.usd, 2)}</dd></div>
        <div><dt>Gas ETH</dt><dd className="num">{num(m.me.ethBase, 3)} · {num(m.me.ethUni, 3)}</dd></div>
      </dl>
      {noGas && <p className="banner small">You need a little Sepolia ETH on both Base Sepolia and Unichain Sepolia for gas.</p>}
      <button className="btn btn-sm" disabled={!!busy || dripWait > 0} onClick={onFaucet}>
        {busy === "faucet" ? "Minting…" : dripWait ? `Faucet again in ${dripWait}s` : "Get 2 test WETH"}
      </button>

      <form className="borrow" onSubmit={(e) => { e.preventDefault(); if (c > 0 && debt > 0) onBorrow(c, debt); }}>
        <label className="field">
          <span className="tag">Collateral</span>
          <span className="input-wrap"><input className="input num" inputMode="decimal" value={coll} onChange={(e) => setColl(e.target.value.replace(/[^\d.]/g, ""))} aria-label="Collateral in tWETH" /><span className="unit">tWETH</span></span>
        </label>
        <label className="field">
          <span className="tag">Loan-to-value <b className="num">{pct(target)}</b></span>
          <input type="range" min={0.1} max={0.75} step={0.01} value={target} onChange={(e) => setTarget(Number(e.target.value))} style={{ ["--v" as any]: `${((target - 0.1) / 0.65) * 100}%` }} aria-label="Loan to value" />
          <span className="scale"><span>10%</span><span className="mark" style={{ left: `${((MAX_LTV - 0.1) / 0.65) * 100}%` }}>70% max</span><span>75%</span></span>
        </label>
        <div className="quote">
          <div><span className="muted">You receive</span><b className="num">{usd(debt)} tUSD</b></div>
          <div><span className="muted">Liquidated if ETH ≤</span><b className="num">{usd(liq, 2)}</b></div>
        </div>
        {target > MAX_LTV && <p className="small warn">Above 70%: Reactive will refuse this loan and send your collateral back. Try it, that loop is on-chain too.</p>}
        <button className="btn btn-primary" disabled={!!busy || c <= 0 || debt <= 0 || (m.me.weth ?? 0) < c}>
          {busy && ["approve tWETH", "lock", "borrow"].includes(busy) ? (busy === "approve tWETH" ? "Approving tWETH…" : "Locking…") : "Lock and borrow"} <Arrow />
        </button>
      </form>
    </div>
  );
}

function Health({ l, price }: { l: Loan; price?: number }) {
  const v = price ? ltv(l, price) : 0;
  const w = Math.min(1, v / 1);
  const tone = v > LIQ_THRESHOLD ? "bad" : v > 0.75 ? "warn" : "ok";
  return (
    <span className={`health ${tone}`} title={`LTV ${pct(v)}; liquidation at 80%`}>
      <span className="bar"><i style={{ width: `${w * 100}%` }} /><em style={{ left: "80%" }} /></span>
      <span className="num">{pct(v)}</span>
    </span>
  );
}

const statusOf = (l: Loan) =>
  l.pool === 3 ? (l.vault === 3 ? "Liquidated · seized" : "Liquidated · seizing") :
  l.pool === 2 ? (l.vault === 2 ? "Repaid · released" : "Repaid · releasing") :
  l.pool === 1 ? "Active" :
  l.vault === 2 ? "Refused · released" : l.vault === 1 ? "Waiting for Reactive" : PoolStatus[l.pool];

function MyLoans({ loans, price, busy, onRepay }: { loans: Loan[]; price?: number; busy?: string; onRepay: (l: Loan) => void }) {
  if (!loans.length) return null;
  return (
    <div className="card pad">
      <div className="card-top"><h2>Your loans</h2></div>
      <ul className="mine">
        {loans.map((l) => (
          <li key={l.id.toString()}>
            <div>
              <b className="num">#{l.id.toString()}</b>
              <span className="num">{num(l.collateral)} tWETH → {usd(l.debt)}</span>
              <span className="muted small">{statusOf(l)}</span>
            </div>
            {l.pool === 1 && <Health l={l} price={price} />}
            {l.pool === 1 && <button className="btn btn-sm" disabled={!!busy} onClick={() => onRepay(l)}>{busy === "repay" || busy === "approve tUSD" ? "Repaying…" : "Repay"}</button>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function AllLoans({ loans, price, account }: { loans: Loan[]; price?: number; account?: Address }) {
  if (!loans.length) return null;
  return (
    <section className="card pad all">
      <div className="card-top"><h2>All loans</h2><span className="tag">read from Base and Unichain</span></div>
      <div className="table-scroll">
        <table className="tbl">
          <thead><tr><th>Loan</th><th>Borrower</th><th>Collateral</th><th>Debt</th><th>LTV now</th><th>Liq. price</th><th>Status</th></tr></thead>
          <tbody>
            {loans.map((l) => (
              <tr key={l.id.toString()} className={account && l.owner.toLowerCase() === account.toLowerCase() ? "me" : ""}>
                <td className="num">#{l.id.toString()}</td>
                <td className="num">{fmtAddr(l.owner)}</td>
                <td className="num">{num(l.collateral)} tWETH</td>
                <td className="num">{l.debt ? usd(l.debt) : "—"}</td>
                <td>{l.pool === 1 ? <Health l={l} price={price} /> : <span className="muted">—</span>}</td>
                <td className="num">{l.pool === 1 ? usd(liqPrice(l), 2) : "—"}</td>
                <td><span className={`st st-${l.pool}`}>{statusOf(l)}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

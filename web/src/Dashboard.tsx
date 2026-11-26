import { useEffect, useMemo, useRef, useState } from "react";
import { formatEther, parseUnits, type Address } from "viem";
import { ADDR, LANES, LANE_NAME, LANE_SHORT, LOW_FUEL, MIN_FUEL, abi, client, deployed } from "./chain";
import { isOpen, stageOf, useBlocks, useChainHealth, useFuel, useLoop, useMarket, wouldLiquidate, type Loan } from "./market";
import { send, short, useWallet } from "./wallet";
import { toE8, usd } from "./format";
import { useActivity } from "./activity";
import { useMyRuns, type Cost } from "./runs";
import { Nav, ThemeToggle, Tick, useTheme } from "./ui";
import WalletMenu from "./WalletMenu";
import { Tour, TourButton, markTourSeen, tourSeen } from "./Tour";
import Activity from "./views/Activity";
import Borrow from "./views/Borrow";
import Latency from "./views/Latency";
import Overview from "./views/Overview";
import Positions from "./views/Positions";
import Risk from "./views/Risk";
import System from "./views/System";
import type { Ctx } from "./views/ctx";

const VIEWS = [
  ["overview", "Home", "Use", "Where the market stands, and what to do next."],
  ["borrow", "Borrow", "Use", "Lock test WETH on Base and receive test USD on Unichain."],
  ["positions", "My loans", "Use", "Your loans, and every loan in the market."],
  ["risk", "Price and risk", "Explore", "Move the price, see who gets liquidated, and stress the whole book."],
  ["latency", "Speed lab", "Explore", "Where the seconds go, what a loop costs, and how it compares with the old network."],
  ["activity", "Activity", "Explore", "Everything that happened on the three chains, and a replay of a real liquidation."],
  ["system", "Health", "Operate", "Fuel, chain health, parameters and contracts."],
] as const;
type View = (typeof VIEWS)[number][0];
const viewOf = (): View => {
  const v = /^#\/app\/?([a-z]*)/.exec(location.hash)?.[1] || "overview";
  return (VIEWS.find(([k]) => k === v)?.[0] ?? "overview") as View;
};

async function snapshot() {
  const [rc, v, p] = await Promise.all([
    client.lasna.getBalance({ address: ADDR.rc }),
    client.base.getBalance({ address: ADDR.vault }),
    client.uni.getBalance({ address: ADDR.pool }),
  ]);
  return { rc, v, p };
}

/** The console is only ever shown for a connected wallet. Without one, the visitor sees the gate. */
export default function Dashboard() {
  const w = useWallet();
  if (!w.ready) return <div className="gate-wait" aria-busy="true" />;
  if (!w.account) return <Gate w={w} />;
  return <Console w={w} account={w.account} />;
}

function Gate({ w }: { w: ReturnType<typeof useWallet> }) {
  const theme = useTheme();
  return (
    <div className="app">
      <Nav><ThemeToggle theme={theme.theme} onToggle={theme.toggle} /></Nav>
      <main className="wrap gate">
        <p className="kicker">// Console</p>
        <h1>Connect a wallet to open the console</h1>
        <p className="muted">
          The console shows your loans and sends transactions from your own wallet. Nothing is shown until you connect, and you can disconnect at any time.
          You need a browser wallet such as MetaMask or Rabby, and some Base Sepolia ETH for gas.
        </p>
        {w.error && <div className="banner bad" role="alert">{w.error}</div>}
        <div className="gate-actions">
          {w.hasWallet
            ? <button className="btn btn-primary" onClick={w.connect}>Connect wallet</button>
            : <a className="btn btn-primary" href="https://metamask.io/download" target="_blank" rel="noreferrer">Get a wallet</a>}
          <a className="btn" href="#/">Back to home</a>
          <a className="btn" href="#/guide">How it works: guide</a>
        </div>
        <p className="small muted">Test networks only. No real funds are involved.</p>
      </main>
    </div>
  );
}

function Console({ w, account }: { w: ReturnType<typeof useWallet>; account: Address }) {
  const { connect, switchAccount, error: walletErr, notice, dismissNotice, hasWallet } = w;
  const disconnect = async () => { location.hash = "#/"; await w.disconnect(); };
  const m = useMarket(account);
  const fuel = useFuel();
  const chain = useChainHealth();
  const feed = useActivity();
  const myRuns = useMyRuns();
  const loop = useLoop();
  const blocks = useBlocks();
  const theme = useTheme();
  const [view, setView] = useState<View>(viewOf);
  const [busy, setBusy] = useState<string>();
  const [err, setErr] = useState<string>();
  const [target, setTarget] = useState<number>();
  const [moved, setMoved] = useState(false);
  const [cost, setCost] = useState<Cost>();
  const [tour, setTour] = useState(() => !tourSeen());
  const inFlight = useRef(false);
  const snap = useRef<Awaited<ReturnType<typeof snapshot>>>();
  const savedFor = useRef<number>();

  useEffect(() => {
    const on = () => { setView(viewOf()); scrollTo(0, 0); };
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);

  // One action at a time. A second click, an Enter key or a re-render must never start a second transaction.
  async function act(label: string, fn: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setErr(undefined);
    setBusy(label);
    try {
      if (label === "post" || label === "borrow" || label === "repay") {
        setCost(undefined);
        snap.current = await snapshot().catch(() => undefined); // balances before, to price the loop afterwards
      }
      await fn();
    } catch (e) {
      setErr(short(e));
    } finally {
      inFlight.current = false;
      setBusy(undefined);
      m.refresh();
    }
  }

  // When a loop finishes: save it to this browser, and work out what it cost from the balance difference.
  useEffect(() => {
    const run = loop.run;
    if (!run?.done || savedFor.current === run.startedAt) return;
    savedFor.current = run.startedAt;
    (async () => {
      let c: Cost | undefined;
      const s0 = snap.current;
      if (s0) {
        await new Promise((r) => setTimeout(r, 4000)); // the last reaction (finalising the loan) runs just after the last event we watch
        try {
          const s1 = await snapshot();
          c = {
            lreact: Math.max(0, Number(formatEther(s0.rc - s1.rc))),
            ethBase: Math.max(0, Number(formatEther(s0.v - s1.v))),
            ethUni: Math.max(0, Number(formatEther(s0.p - s1.p))),
          };
          setCost(c);
        } catch { /* no cost shown */ }
      }
      if (run.steps.every((s) => s.status === "done")) {
        myRuns.add({ at: Date.now(), kind: run.kind, totalMs: run.steps[run.steps.length - 1].ms ?? 0, steps: run.steps.map((s) => ({ lane: s.lane, label: s.label, ms: s.ms ?? 0, hash: s.hash })), cost: c });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loop.run?.done, loop.run?.startedAt]);

  // No fuel means no reactions: a loan opened now could sit locked with nothing to release it.
  const halted = fuel.rc !== undefined && (fuel.rc < MIN_FUEL || (fuel.rcDebt ?? 0) > 0);
  const lowFuel = fuel.rc !== undefined && fuel.rc < LOW_FUEL;

  const mine = useMemo(() => m.loans.filter((l) => account && l.owner.toLowerCase() === account.toLowerCase()), [m.loans, account]);
  const myOpen = mine.filter((l) => isOpen(stageOf(l))).length;

  const actions: Ctx["act"] = {
    post: (p: number) => act("post", async () => {
      const hits = wouldLiquidate(m.loans, p).length;
      const r = await send("base", account!, ADDR.feed, abi.feed, "post", [toE8(p)]);
      setTarget(undefined);
      setMoved(true);
      loop.track("liquidation", { lane: "base", hash: r.hash, label: "post()", detail: `ETH set to ${usd(p, 2)}`, minedAt: r.minedAt }, { expectLiquidations: Math.min(hits, 10) });
    }),
    borrow: (coll: string, debt: number) => act("borrow", async () => {
      const amount = parseUnits(coll, 18);
      const allowance = await client.base.readContract({ address: ADDR.weth, abi: abi.token, functionName: "allowance", args: [account!, ADDR.vault] });
      if (allowance < amount) { setBusy("approve"); await send("base", account!, ADDR.weth, abi.token, "approve", [ADDR.vault, amount]); }
      setBusy("lock");
      const r = await send("base", account!, ADDR.vault, abi.vault, "lock", [amount, parseUnits(String(debt), 6)]);
      const id = BigInt(r.receipt.logs.find((l) => l.address.toLowerCase() === ADDR.vault.toLowerCase())!.topics[1]!);
      loop.track("borrow", { lane: "base", hash: r.hash, label: "lock()", detail: `loan #${id}: ${coll} tWETH for ${usd(debt)}`, minedAt: r.minedAt }, { loanId: id });
    }),
    repay: (l: Loan) => act("repay", async () => {
      const amount = parseUnits(String(l.debt), 6);
      const allowance = await client.uni.readContract({ address: ADDR.usd, abi: abi.token, functionName: "allowance", args: [account!, ADDR.pool] });
      if (allowance < amount) { setBusy("approve"); await send("uni", account!, ADDR.usd, abi.token, "approve", [ADDR.pool, amount]); }
      setBusy("repay");
      const r = await send("uni", account!, ADDR.pool, abi.pool, "repay", [l.id]);
      loop.track("repay", { lane: "uni", hash: r.hash, label: "repay()", detail: `loan #${l.id}: ${usd(l.debt)} repaid`, minedAt: r.minedAt }, { loanId: l.id });
    }),
    poke: (l: Loan) => act("poke", async () => { await send("lasna", account!, ADDR.rc, abi.rc, "poke", [l.id]); }),
    faucet: () => act("faucet", async () => { await send("base", account!, ADDR.weth, abi.token, "faucet"); }),
    usdFaucet: () => act("faucet-usd", async () => { await send("uni", account!, ADDR.usd, abi.token, "faucet"); }),
  };

  const ctx: Ctx = {
    account, connect, hasWallet, m, fuel, chain, busy, halted, mine, myOpen, moved, target, setTarget, loop, cost, feed,
    myRuns: { runs: myRuns.runs, clear: myRuns.clear }, act: actions,
  };
  const current = VIEWS.find(([k]) => k === view)!;

  return (
    <div className="app">
      <Nav>
        <div className="chains">
          {LANES.map((l) => (
            <span key={l} className={`chip lane-${l}`} title={`${LANE_NAME[l]} latest block`}>
              <i className="dot" />{LANE_SHORT[l]} <span className="num">{blocks[l] ? <Tick value={blocks[l]!.toString()} /> : "…"}</span>
            </span>
          ))}
        </div>
        <ThemeToggle theme={theme.theme} onToggle={theme.toggle} />
        <TourButton onStart={() => setTour(true)} />
        <WalletMenu account={account} onSwitch={switchAccount} onDisconnect={disconnect} />
      </Nav>
      {tour && <Tour onClose={() => { setTour(false); markTourSeen(); }} />}

      <div className="wrap wide console">
        <aside className="side" aria-label="Console sections">
          <nav>
            {(["Use", "Explore", "Operate"] as const).map((group) => (
              <div key={group} className="side-group">
                <span className="side-h">{group}</span>
                {VIEWS.filter((v) => v[2] === group).map(([k, label]) => (
                  <a key={k} href={k === "overview" ? "#/app" : `#/app/${k}`} className={view === k ? "on" : ""} aria-current={view === k ? "page" : undefined}>
                    {label}
                    {k === "positions" && myOpen > 0 && <span className="badge num">{myOpen}</span>}
                    {k === "system" && <i className={`fuel-dot ${halted ? "bad" : lowFuel ? "warn" : fuel.rc !== undefined ? "ok" : ""}`} title="Automation fuel" />}
                  </a>
                ))}
              </div>
            ))}
          </nav>
          <div className="side-foot">
            <span className="tag">ETH / USD</span>
            <b className="num">{usd(m.price, 2)}</b>
            <span className={`small ${m.price !== undefined && m.rcPrice !== undefined && Math.abs(m.price - m.rcPrice) < 1e-6 ? "ok-text" : "warn-text"}`}>
              {m.rcPrice === undefined ? "…" : Math.abs((m.price ?? 0) - m.rcPrice) < 1e-6 ? "Reactive in sync" : "Reactive behind"}
            </span>
          </div>
        </aside>

        <main className="main">
          <header className="dash-head">
            <div>
              <h1>{current[1]}</h1>
              <p className="muted">{current[3]}</p>
            </div>
            {(view === "overview" || view === "positions") && (
              <a className="btn btn-primary" href="#/app/borrow">{view === "positions" ? "New loan" : "Borrow"}</a>
            )}
          </header>

          {!deployed && <div className="banner">Contracts are not deployed yet. Run <code>npm run deploy</code> in the repo root.</div>}
          {(walletErr || err || m.error) && <div className="banner bad" role="alert">{walletErr ?? err ?? m.error}</div>}
          {notice && <div className="banner" role="status">{notice} <button className="ul" onClick={dismissNotice}>Dismiss</button></div>}
          {(halted || lowFuel) && view !== "system" && (
            <div className={`banner ${halted ? "bad" : ""}`} role="status">
              {halted ? "Reactive has run out of fuel, so new loans are paused." : "Reactive is running low on fuel."} <a className="ul" href="#/app/system">See the fuel gauge</a>
            </div>
          )}

          {view === "overview" && <Overview c={ctx} />}
          {view === "borrow" && <Borrow c={ctx} />}
          {view === "positions" && <Positions c={ctx} />}
          {view === "risk" && <Risk c={ctx} />}
          {view === "latency" && <Latency c={ctx} />}
          {view === "activity" && <Activity c={ctx} />}
          {view === "system" && <System c={ctx} />}

          <footer className="app-foot small muted">Test tokens only. The price feed is a demo feed anyone can move.</footer>
        </main>
      </div>
    </div>
  );
}

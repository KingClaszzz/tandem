import { useEffect, useState } from "react";
import { DEPLOYMENTS, LANE_NAME, addrUrl, deployed, type Lane } from "./chain";
import type { Step } from "./market";
import { Arrow, LoopTrace, Logo, Scramble } from "./ui";
import bench from "./bench.json";

export const REPO = "https://github.com/KingClaszzz/tandem";

type Stat = { p50: number; p95: number; max: number };
type Bench = { measuredAt?: string; runs?: number; hops?: { name: string; p50: number; p95: number; max: number }[]; total?: Stat };
const B = bench as Bench;
const measured = Boolean(B.runs && B.total);
const s = (ms: number) => `${(ms / 1000).toFixed(2)}s`;

const DEMO: Omit<Step, "status" | "ms">[] = [
  { lane: "base", label: "setPrice()", detail: "ETH drops to $2,400" },
  { lane: "lasna", label: "react()", detail: "loan #7 at 83% LTV, over 80%" },
  { lane: "uni", label: "liquidate()", detail: "loan closed, repay disabled" },
  { lane: "lasna", label: "react()", detail: "saw Liquidated, seize requested" },
  { lane: "base", label: "seize()", detail: "collateral to treasury" },
];

/** Hero trace: replays the liquidation loop. Uses measured per-hop medians once a bench has been run. */
function HeroLoop() {
  const [n, setN] = useState(1);
  useEffect(() => {
    const t = setInterval(() => setN((v) => (v >= DEMO.length + 3 ? 1 : v + 1)), 1100);
    return () => clearInterval(t);
  }, []);
  let acc = 0;
  const steps: Step[] = DEMO.slice(0, Math.min(n, DEMO.length)).map((d, i) => {
    if (i > 0 && measured) acc += B.hops![i - 1]?.p50 ?? 0;
    return { ...d, status: "done", ms: measured ? acc : undefined };
  });
  if (n < DEMO.length) steps.push({ ...DEMO[n], status: "wait" });
  return (
    <div className="card hero-trace">
      <div className="hero-trace-top">
        <span className="tag">Liquidation loop</span>
        <span className="tag">{measured ? `median of ${B.runs} measured runs` : "replay · numbers after the bench run"}</span>
      </div>
      <LoopTrace steps={steps} link={false} />
    </div>
  );
}

export default function Landing() {
  return (
    <>
      <nav className="nav">
        <div className="wrap nav-in">
          <Logo />
          <div className="nav-links">
            <a className="ulink" href="#how">How it works</a>
            <a className="ulink" href="#proof">Proof</a>
            <a className="ulink" href="#safety">Safety</a>
            <a className="ulink" href={REPO} target="_blank" rel="noreferrer">GitHub</a>
          </div>
          <a className="btn btn-sm btn-primary" href="#/app">Open app <Arrow /></a>
        </div>
      </nav>

      <header className="hero wrap">
        <div className="hero-copy">
          <p className="tag">[ Cross-chain lending on Reactive Omni ]</p>
          <h1><Scramble text="Borrow on Unichain." /><br /><span className="dim"><Scramble text="Keep collateral on Base." /></span></h1>
          <p className="lede">
            When the collateral price falls, one reactive contract closes the loan on Unichain and seizes the collateral on Base, in seconds.
            No liquidation bot, no bridge, no keeper.
          </p>
          <div className="cta">
            <a className="btn btn-primary" href="#/app">Try it on testnet <Arrow /></a>
            <a className="btn" href="#how">See the loops</a>
          </div>
          <dl className="facts">
            <div><dt className="tag">Max LTV</dt><dd className="num">70%</dd></div>
            <div><dt className="tag">Liquidated at</dt><dd className="num">80%</dd></div>
            <div><dt className="tag">{measured ? "Crash → seized, p50" : "Bots to run"}</dt><dd className="num">{measured ? s(B.total!.p50) : "0"}</dd></div>
          </dl>
        </div>
        <HeroLoop />
      </header>

      <section className="sec wrap">
        <p className="tag">The problem</p>
        <h2><Scramble text="Cross-chain loans fail at liquidation." /></h2>
        <div className="grid3">
          <article className="card pad">
            <h3>The debt chain can't see the price</h3>
            <p>Collateral sits on one chain and the loan on another. The contract holding the debt has no way to know the collateral just lost 20%.</p>
          </article>
          <article className="card pad">
            <h3>So someone runs a bot</h3>
            <p>A keeper watches both chains, holds keys and gas on each, and races other keepers. When it is down or slow, lenders take the loss.</p>
          </article>
          <article className="card pad">
            <h3>And it has to be fast</h3>
            <p>Reactive's previous version made ~7 s blocks. Omni makes ~1 s blocks with instant finality, so the whole two-chain loop now fits in seconds.</p>
          </article>
        </div>

        <div className="card compare">
          <div className="row head"><span /><span className="tag">Keeper bot</span><span className="tag">Tandem</span></div>
          <div className="row"><span className="muted">Who watches the price</span><span>A server you operate</span><span>A reactive contract on Lasna</span></div>
          <div className="row"><span className="muted">Who closes the loan</span><span>Your bot's key, on each chain</span><span>Callbacks signed by Reactive</span></div>
          <div className="row"><span className="muted">What you keep funded</span><span>Gas on every chain, plus a server</span><span>The contracts' own callback balance</span></div>
          <div className="row"><span className="muted">If it goes down</span><span>Bad debt piles up</span><span>Logic lives on-chain, nothing to restart</span></div>
        </div>
      </section>

      <section className="sec wrap" id="how">
        <p className="tag">How it works</p>
        <h2><Scramble text="Three loops, one reactive contract." /></h2>
        <div className="loops">
          <Loop n="01" title="Borrow" items={[["base", "lock()", "tWETH locked, CollateralLocked"], ["lasna", "react()", "LTV ≤ 70% at the last price"], ["uni", "disburse()", "tUSD sent to the borrower"]]} />
          <Loop n="02" title="Repay" items={[["uni", "repay()", "debt paid, Repaid"], ["lasna", "react()", "loan closed"], ["base", "release()", "collateral returned"]]} />
          <Loop n="03" title="Liquidate" items={[["base", "setPrice()", "PriceUpdated"], ["lasna", "react()", "finds loans over 80% LTV"], ["uni", "liquidate()", "loan closed first"], ["lasna", "react()", "saw Liquidated"], ["base", "seize()", "collateral to treasury"]]} />
        </div>
        <p className="note">
          <b>Why Unichain goes first.</b> The loan's state lives on the debt chain. Once <code>liquidate()</code> lands there, <code>repay()</code> reverts,
          so a borrower can never pay back the loan and still lose the collateral. The seize on Base only happens after Reactive sees <code>Liquidated</code>.
        </p>
      </section>

      <section className="sec wrap" id="proof">
        <p className="tag">Proof</p>
        <h2><Scramble text="Measured, not promised." /></h2>
        <div className="grid2">
          <div className="card pad">
            <h3>Latency across the full loop</h3>
            {measured ? (
              <>
                <table className="lat">
                  <thead><tr><th>Hop</th><th>p50</th><th>p95</th><th>max</th></tr></thead>
                  <tbody>
                    {B.hops!.map((h) => <tr key={h.name}><td>{h.name}</td><td>{s(h.p50)}</td><td>{s(h.p95)}</td><td>{s(h.max)}</td></tr>)}
                    <tr className="tot"><td>Price tx mined → collateral seized</td><td>{s(B.total!.p50)}</td><td>{s(B.total!.p95)}</td><td>{s(B.total!.max)}</td></tr>
                  </tbody>
                </table>
                <p className="muted small">{B.runs} liquidation loops on public testnets, {B.measuredAt}. Wall-clock time between receipts, polled every 250 ms. Script: <code>scripts/bench.ts</code>.</p>
              </>
            ) : (
              <p className="muted">The bench script runs repeated crash → liquidate → seize loops on the live testnets and records every hop. Results land here once it has run.</p>
            )}
          </div>
          <div className="card pad">
            <h3>Deployed contracts</h3>
            {deployed ? (
              <ul className="addrs">
                {(["reactive", "feed", "vault", "tWETH", "pool", "tUSD"] as const).map((k) => {
                  const e = DEPLOYMENTS[k]!;
                  return (
                    <li key={k}>
                      <span><i className={`dot lane-${e.chain}`} /> {k}</span>
                      <a className="mono ulink" href={addrUrl(e.chain as Lane, e.address)} target="_blank" rel="noreferrer">{e.address.slice(0, 10)}…{e.address.slice(-6)}</a>
                      <span className="muted small">{LANE_NAME[e.chain as Lane]}</span>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="muted">Not deployed yet.</p>
            )}
            <p className="muted small">13 unit tests cover every loop, the ordering rule, callback authentication and a 25-loan sweep under the 900k gas cap.</p>
          </div>
        </div>
      </section>

      <section className="sec wrap" id="safety">
        <p className="tag">Safety</p>
        <h2><Scramble text="What can and can't move funds." /></h2>
        <ul className="safety">
          <li><b>Only Reactive can release or seize.</b> Vault and pool callbacks check the callback proxy and the reactive contract's address.</li>
          <li><b>The RC ignores look-alikes.</b> It only acts on events from the exact feed, vault and pool it was configured with, on the right chain.</li>
          <li><b>No double outcome.</b> Liquidation closes the loan on the debt chain before the seize, so repay and seize can't both happen.</li>
          <li><b>Bounded work.</b> At most 25 open loans per sweep; a full sweep used 505k gas in tests, under the 900k cap.</li>
          <li><b>Honest demo.</b> Test tokens only. The price feed is a demo feed anyone can move inside $100–$20,000, so you can trigger a liquidation yourself.</li>
        </ul>
      </section>

      <section className="sec wrap end">
        <h2><Scramble text="Crash the price. Watch it settle." /></h2>
        <p className="lede">Free test tokens, a wallet on Base Sepolia and Unichain Sepolia, and about a minute.</p>
        <a className="btn btn-primary" href="#/app">Open the app <Arrow /></a>
      </section>

      <footer className="foot wrap">
        <Logo />
        <span className="muted small">Built for the Reactive Omni Buildathon · testnets only</span>
        <a className="ulink" href={REPO} target="_blank" rel="noreferrer">GitHub</a>
      </footer>
    </>
  );
}

function Loop({ n, title, items }: { n: string; title: string; items: [Lane, string, string][] }) {
  return (
    <article className="card pad loop">
      <div className="loop-top"><span className="tag">{n}</span><h3>{title}</h3></div>
      <ol>
        {items.map(([lane, fn, what], i) => (
          <li key={i} className={`lane-${lane}`}>
            <i className="dot" />
            <code>{fn}</code>
            <span>{what}</span>
          </li>
        ))}
      </ol>
    </article>
  );
}

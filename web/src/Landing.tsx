import { useEffect, useMemo, useRef, useState } from "react";
import { DEPLOYMENTS, LANE_NAME, LANES, addrUrl, deployed, sourcifyUrl, txUrl, type Lane } from "./chain";
import { bench, hopSeries, measured, runSteps, runs, sec } from "./bench";
import { useBlocks } from "./market";
import { Arrow, AsciiField, CopyBtn, Ext, LoopTrace, Nav, Scramble, Tick, reducedMotion } from "./ui";
import { Architecture, Audience, Faq, Footer, LiveBand, Roadmap, ScrollProgress, Tested, WhyReactive } from "./landing-extra";
import { CodeSection } from "./code";
import snippets from "./snippets.json";

export const REPO = "https://github.com/KingClaszzz/tandem";

/* ------------------------------------------------------------------ the three loops */

type FlowStep = { lane: Lane; fn: string; title: string; text: string };
type Flow = { id: string; label: string; steps: FlowStep[] };

const FLOWS: Flow[] = [
  {
    id: "borrow", label: "Borrow",
    steps: [
      { lane: "base", fn: "lock()", title: "Collateral is locked on Base", text: "You lock tWETH and ask for an amount of tUSD. The vault emits CollateralLocked and nothing else happens on Base." },
      { lane: "lasna", fn: "react()", title: "Reactive checks the loan", text: "LTV at the last price it saw must be 70% or less, the loan at least 50 tUSD, and the borrower under 3 open loans. If not, it asks Base to hand the collateral back." },
      { lane: "uni", fn: "disburse()", title: "The pool pays on Unichain", text: "tUSD goes straight to your wallet. The loan only counts as active once Reactive sees the pool's Disbursed event." },
    ],
  },
  {
    id: "repay", label: "Repay",
    steps: [
      { lane: "uni", fn: "repay()", title: "You repay on Unichain", text: "The debt chain is the source of truth for the loan. Repaying marks it closed there, in the same transaction." },
      { lane: "lasna", fn: "react()", title: "Reactive sees Repaid", text: "It moves the loan to Releasing and requests the collateral back." },
      { lane: "base", fn: "release()", title: "Collateral returns on Base", text: "The vault releases only if the loan is still locked, so a duplicate callback does nothing." },
    ],
  },
  {
    id: "liquidate", label: "Liquidate",
    steps: [
      { lane: "base", fn: "post()", title: "The price drops", text: "The feed emits AnswerUpdated. Reactive ignores any round that is not newer than the last one it processed." },
      { lane: "lasna", fn: "react()", title: "Reactive finds unhealthy loans", text: "Every open loan above 80% LTV at the new price, up to 10 per update. Anything left over is caught by the next update, or by anyone calling poke()." },
      { lane: "uni", fn: "liquidate()", title: "The debt chain closes the loan first", text: "Once this lands, repay() reverts. A borrower can never repay a loan and also lose the collateral." },
      { lane: "lasna", fn: "react()", title: "Reactive sees Liquidated", text: "Only now does it price the seizure: debt plus a 5% penalty, in tWETH, at the price that triggered it." },
      { lane: "base", fn: "seize()", title: "Collateral is seized on Base", text: "The penalty-adjusted amount goes to the treasury. Whatever collateral is left goes back to the borrower." },
    ],
  },
];

const X: Record<Lane, number> = { base: 72, lasna: 240, uni: 408 };
const COLOR: Record<Lane, string> = { base: "var(--base)", lasna: "var(--lasna)", uni: "var(--uni)" };
const STEP_MS = 2800;

function LoopDiagram({ flow, active, onPick }: { flow: Flow; active: number; onPick: (i: number) => void }) {
  const n = flow.steps.length;
  const y = (i: number) => 96 + i * 78;
  const H = y(n - 1) + 70;
  const path = (i: number) => {
    const a = flow.steps[i - 1], b = flow.steps[i];
    return `M${X[a.lane]} ${y(i - 1)} C${X[a.lane]} ${y(i - 1) + 38}, ${X[b.lane]} ${y(i) - 38}, ${X[b.lane]} ${y(i)}`;
  };
  const motion = !reducedMotion();
  return (
    <svg viewBox={`0 0 480 ${H}`} className="diagram" role="img" aria-label={`${flow.label} loop across Base, Reactive and Unichain`}>
      {LANES.map((l) => (
        <g key={l}>
          <line x1={X[l]} x2={X[l]} y1={52} y2={H - 14} className="rail" />
          <circle cx={X[l]} cy={28} r="4" fill={COLOR[l]} />
          <text x={X[l]} y={46} className="rail-label" textAnchor="middle" fill={COLOR[l]}>{LANE_NAME[l].split(" ")[l === "lasna" ? 1 : 0].toUpperCase()}</text>
        </g>
      ))}
      {flow.steps.slice(1).map((s, k) => {
        const i = k + 1;
        const state = i < active ? "past" : i === active ? "now" : "next";
        return (
          <g key={`${flow.id}-${i}`}>
            <path d={path(i)} className={`link ${state}`} stroke={COLOR[s.lane]} pathLength={1} />
            {state === "now" && motion && (
              <circle r="4.5" fill={COLOR[s.lane]} className="packet">
                <animateMotion dur="0.9s" path={path(i)} fill="freeze" calcMode="spline" keySplines="0.4 0 0.2 1" keyTimes="0;1" />
              </circle>
            )}
          </g>
        );
      })}
      {flow.steps.map((s, i) => {
        const on = i <= active;
        const left = s.lane === "uni";
        return (
          <g key={`${flow.id}-n${i}`} className={`dnode ${i === active ? "now" : on ? "past" : "next"}`} onPointerEnter={() => onPick(i)} onClick={() => onPick(i)}>
            <rect x={X[s.lane] - 18} y={y(i) - 20} width="170" height="40" fill="transparent" />
            <circle cx={X[s.lane]} cy={y(i)} r={i === active ? 7 : 5} fill={on ? COLOR[s.lane] : "var(--bg)"} stroke={COLOR[s.lane]} strokeWidth="1.5" />
            <text x={X[s.lane] + (left ? -14 : 14)} y={y(i) + 4} textAnchor={left ? "end" : "start"} className="fn">{s.fn}</text>
          </g>
        );
      })}
    </svg>
  );
}

function Loops() {
  const [fi, setFi] = useState(2);
  const [active, setActive] = useState(0);
  const [paused, setPaused] = useState(false);
  const [visible, setVisible] = useState(true);
  const root = useRef<HTMLDivElement>(null);
  const flow = FLOWS[fi];

  useEffect(() => {
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { threshold: 0.25 });
    if (root.current) io.observe(root.current);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (paused || !visible || reducedMotion()) return;
    const t = setTimeout(() => {
      if (active + 1 < flow.steps.length) setActive(active + 1);
      else { setFi((fi + 1) % FLOWS.length); setActive(0); }
    }, STEP_MS);
    return () => clearTimeout(t);
  }, [active, fi, paused, visible, flow.steps.length]);

  return (
    <div className="loops" ref={root} onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)} onFocus={() => setPaused(true)} onBlur={() => setPaused(false)}>
      <div className="loops-list">
        <div className="seg" role="tablist" aria-label="Loop">
          {FLOWS.map((f, i) => (
            <button key={f.id} role="tab" aria-selected={i === fi} className={i === fi ? "on" : ""} onClick={() => { setFi(i); setActive(0); }}>{f.label}</button>
          ))}
        </div>
        <ol className="steps">
          {flow.steps.map((s, i) => (
            <li key={`${flow.id}-${i}`} className={`${i === active ? "on" : ""} lane-${s.lane}`}>
              <button onClick={() => setActive(i)} onPointerEnter={() => setActive(i)} onFocus={() => setActive(i)} aria-expanded={i === active}>
                <span className="mk">{i === active ? "[>]" : "[+]"}</span>
                <span className="st">{s.title}</span>
                <code>{s.fn}</code>
              </button>
              <div className="more" aria-hidden={i !== active}>
                <div className="more-in">
                  <p>{s.text}</p>
                  {i === active && !paused && !reducedMotion() && <i className="prog" style={{ animationDuration: `${STEP_MS}ms` }} />}
                </div>
              </div>
            </li>
          ))}
        </ol>
      </div>
      <div className="loops-diagram"><LoopDiagram flow={flow} active={active} onPick={setActive} /></div>
    </div>
  );
}

/* ------------------------------------------------------------------ measured latency */

function Dots({ series, hop }: { series: ReturnType<typeof hopSeries[number]["pick"]>[]; hop: { p50: number; p95: number } | undefined }) {
  const max = Math.max(...series.map((s) => s.ms), 1) * 1.08;
  const pos = (ms: number) => `${(ms / max) * 100}%`;
  const [at, setAt] = useState<number>();
  return (
    <div
      className="strip" style={{ ["--max" as string]: String(max) }}
      onPointerMove={(e) => { const r = e.currentTarget.getBoundingClientRect(); setAt(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width))); }}
      onPointerLeave={() => setAt(undefined)}
    >
      <div className="axis" />
      {at !== undefined && <span className="xhair" style={{ left: `${at * 100}%` }}><em className="num">{((at * max) / 1000).toFixed(2)}s</em></span>}
      {hop && <span className="p50" style={{ left: pos(hop.p50) }}><em>p50 {sec(hop.p50, 2)}s</em></span>}
      {series.map((s, i) => (
        <a key={i} className={`pt lane-${s.lane}`} style={{ left: pos(s.ms), top: `${30 + ((i * 7) % 5) * 5}px` }} href={txUrl(s.lane, s.hash)} target="_blank" rel="noreferrer" title={`run ${i + 1}: ${sec(s.ms, 2)}s`} aria-label={`Run ${i + 1}, ${sec(s.ms, 2)} seconds, open transaction`} />
      ))}
    </div>
  );
}

function Proof() {
  const [pick, setPick] = useState(Math.floor(runs.length / 2));
  const [hot, setHot] = useState<number>();
  const series = useMemo(() => hopSeries.map((h) => runs.map(h.pick)), []);
  if (!measured) return <p className="muted">Run <code>npm run bench</code> to measure the loop on the live testnets. The results appear here.</p>;
  const t = bench.total!;
  return (
    <>
      <div className="bignum">
        <div>
          <span className="num big">{sec(t.p50, 1)}<small>s</small></span>
          <span className="cap">median, price tx → collateral seized</span>
        </div>
        <dl>
          <div><dt>p95</dt><dd className="num">{sec(t.p95, 1)}s</dd></div>
          <div><dt>debt closed on Unichain, p50</dt><dd className="num">{sec(bench.crashToDebtClosed!.p50, 1)}s</dd></div>
          <div><dt>borrow across chains, p50</dt><dd className="num">{sec(bench.borrow!.p50, 1)}s</dd></div>
          <div><dt>runs</dt><dd className="num">{runs.length}</dd></div>
        </dl>
      </div>

      <div className="hops" onPointerLeave={() => setHot(undefined)}>
        <div className="hops-head"><span className="tag">Every dot is one run. Click a dot to open its transaction.</span></div>
        <div className="hopstack" aria-hidden="true">
          {bench.hops!.map((h, i) => (
            <div key={h.name} className={`${hot === i ? "hot" : hot !== undefined ? "dim" : ""} lane-${hopSeries[i].pick(runs[0]).lane}`} style={{ flexBasis: `${(h.p50 / bench.hops!.reduce((a, x) => a + x.p50, 0)) * 100}%` }} onPointerEnter={() => setHot(i)}>
              <span className="num">{sec(h.p50, 2)}s</span>
            </div>
          ))}
        </div>
        {hopSeries.map((h, i) => (
          <div className={`hop-row ${hot === i ? "hot" : ""}`} key={h.name} onPointerEnter={() => setHot(i)}>
            <span className="hop-name">{h.name}</span>
            <Dots series={series[i]} hop={bench.hops?.[i]} />
            <span className="hop-p num">{sec(bench.hops![i].p95, 2)}s <small>p95</small></span>
          </div>
        ))}
      </div>

      <div className="runs">
        <div className="runs-head">
          <span className="tag">Run explorer</span>
          <div className="runs-pick" role="group" aria-label="Pick a recorded run">
            {runs.map((r, i) => (
              <button key={r.loan} className={i === pick ? "on" : ""} onClick={() => setPick(i)} aria-pressed={i === pick}>{i + 1}</button>
            ))}
          </div>
        </div>
        <LoopTrace steps={runSteps(runs[pick])} />
        <p className="small muted">Loan #{runs[pick].loan}: borrowed at 60% LTV, then the price went to $2,200 (81.8%). Every box is a real transaction.</p>
      </div>
      <p className="small muted method">
        Method: {bench.method}. Timings are measured from the receipt of the first transaction, so each is accurate to about a quarter of a second.
        Public RPCs, {bench.measuredAt}. Raw runs with all hashes are in <code>evidence/</code>.
      </p>
    </>
  );
}

/* ------------------------------------------------------------------ contracts, threats, limits */

const CONTRACTS: { key: "reactive" | "feed" | "vault" | "tWETH" | "pool" | "tUSD"; name: string; role: string }[] = [
  { key: "reactive", name: "TandemReactive", role: "Watches 8 events, mirrors every loan, decides" },
  { key: "feed", name: "PriceFeed", role: "Demo ETH/USD feed, Chainlink-style AnswerUpdated" },
  { key: "vault", name: "CollateralVault", role: "Holds tWETH, releases or seizes on callback" },
  { key: "pool", name: "LendingPool", role: "Holds tUSD, source of truth for debt" },
  { key: "tWETH", name: "tWETH", role: "Test collateral with a public faucet" },
  { key: "tUSD", name: "tUSD", role: "Test loan asset with a public faucet" },
];

const THREATS: [string, string, string][] = [
  ["Someone calls seize(), release(), liquidate() or disburse() directly", "Each is callable only by the chain's callback proxy, and only when the proxy reports Tandem's reactive contract as the sender.", "rejects callbacks that don't come through the proxy or from the RC"],
  ["A look-alike contract emits the same events", "The reactive contract checks the chain id and the exact feed, vault and pool addresses before acting on any log.", "ignores look-alike events from other contracts and other chains"],
  ["A borrower repays and also loses the collateral", "The debt chain closes the loan first. After liquidate() lands, repay() reverts. Seizing only follows Reactive seeing Liquidated.", "race: repay lands before the liquidate callback -> no liquidation, collateral released"],
  ["A callback is delivered twice or never", "All four callbacks act only on the expected state, so duplicates do nothing. Anyone can call poke() to re-send a request that is a minute old.", "idempotent callbacks: a duplicate seize can't move collateral twice"],
  ["An old or replayed price", "Rounds must increase. A stale AnswerUpdated is ignored.", "ignores replayed or out-of-order price rounds"],
  ["Too many loans for one reactive transaction", "At most 50 open loans, 3 per borrower, 10 liquidations per price update. The worst case measured 489k gas against a 900k cap.", "worst-case sweep (50 open loans, 10 liquidations) stays under the 900k reactive cap"],
  ["Someone spams the price feed to drain the reactive contract's fuel", "The feed accepts one update per 30 seconds from anyone and rejects an update that changes nothing. That caps it at 2 reactions a minute.", "a storm of price posts cannot trigger an unbounded number of reactions"],
  ["A loan that is too small, too big or over a limit costs Reactive a run", "The vault checks size, 3 loans per wallet and 50 in total itself, where a revert costs Reactive nothing.", "rejects loans below 50 tUSD and above the per-loan maximum"],
  ["The owner rewires or drains the system", "configure() runs once. The owner has no pause, upgrade or withdraw function.", "configure is owner-only and one-time"],
];

const LIMITS = [
  "Test tokens and a demo price feed that anyone can move, within $100–$20,000, 50% per update and once every 30 seconds. That is what lets a judge trigger a liquidation. On a live network the reactive contract would subscribe to a Chainlink aggregator, which emits the same event.",
  "0% interest, full repayment only, one collateral asset and one loan asset.",
  "Seized collateral stays on Base with the treasury. Settling that reserve against the pool's write-off is not built.",
  "Anyone who pays gas on three chains can still make Reactive run, only more slowly. The real answer is a fee per loan, which we did not add. The console shows the reactive contract's fuel and pauses new loans when it is empty.",
  "Timings come from public RPCs and a polling script, so treat them as seconds, not milliseconds.",
];

const SURFACE: Record<string, string[]> = {
  TandemReactive: snippets.abi.TandemReactive.functions.filter((f) => !/^(coverDebt|pay)\(/.test(f)).map((f) => f.split("(")[0]),
  PriceFeed: snippets.abi.PriceFeed.functions.map((f) => f.split("(")[0]),
  CollateralVault: snippets.abi.CollateralVault.functions.filter((f) => !/^(coverDebt|pay)\(/.test(f)).map((f) => f.split("(")[0]),
  LendingPool: snippets.abi.LendingPool.functions.filter((f) => !/^(coverDebt|pay)\(/.test(f)).map((f) => f.split("(")[0]),
  tWETH: ["faucet", "transfer", "approve"],
  tUSD: ["faucet", "transfer", "approve"],
};

function Contracts() {
  if (!deployed) return <p className="muted">Not deployed yet.</p>;
  return (
    <ul className="rows">
      {CONTRACTS.map((c) => {
        const e = DEPLOYMENTS[c.key]!;
        return (
          <li key={c.key} className={`lane-${e.chain}`} data-r tabIndex={0}>
            <span className="r-name"><i className="dot" />{c.name}</span>
            <span className="r-role">{c.role}</span>
            <span className="r-chain muted">{LANE_NAME[e.chain]}</span>
            <span className="r-addr">
              <a className="mono ul" href={addrUrl(e.chain, e.address)} target="_blank" rel="noreferrer">{e.address.slice(0, 8)}…{e.address.slice(-6)}</a>
              <CopyBtn text={e.address} />
              <a className="verified" href={sourcifyUrl(e.chain, e.address)} target="_blank" rel="noreferrer" title="Source code verified on Sourcify">source<Ext /></a>
            </span>
            <span className="r-fn"><b>Callable</b> {(SURFACE[c.name] ?? []).map((f) => <code key={f}>{f}()</code>)}</span>
          </li>
        );
      })}
    </ul>
  );
}

/* ------------------------------------------------------------------ page */

export default function Landing() {
  const b = useBlocks();
  const headline = measured ? `${sec(bench.total!.p50, 1)} seconds` : "seconds";
  return (
    <>
      <ScrollProgress />
      <Nav
        links={[
          { href: "#loop", label: "The loop" },
          { href: "#why", label: "Why Reactive" },
          { href: "#proof", label: "Proof" },
          { href: "#code", label: "Code" },
          { href: "#tested", label: "Tested" },
          { href: "#faq", label: "FAQ" },
          { href: "#/guide", label: "Guide" },
          { href: REPO, label: "GitHub", ext: true },
        ]}
      >
        <a className="btn btn-sm btn-primary" href="#/app">Launch app <Arrow /></a>
      </Nav>

      <header className="hero">
        <AsciiField className="hero-ascii" />
        <div className="wrap hero-in">
          <p className="tag" data-r>[ Cross-chain lending on Reactive Omni ]</p>
          <h1>
            <Scramble text="A loan across two chains," as="span" className="l1" />
            <Scramble text={`liquidated in ${headline}.`} as="span" className="l2" speed={30} />
          </h1>
          <p className="lede" data-r>
            Lock collateral on Base and borrow on Unichain. When the price falls, one Reactive contract closes the loan on Unichain and seizes the collateral on Base.
            No bot, no keeper, no bridge.
          </p>
          <div className="cta" data-r>
            <a className="btn btn-primary btn-lg" href="#/app">Crash the price yourself <Arrow /></a>
            <a className="btn btn-lg" href="#loop">See how a loan lives</a>
          </div>
        </div>
        <div className="wrap">
          <dl className="vitals">
            {LANES.map((l) => (
              <div key={l} className={`lane-${l}`}>
                <dt><i className="dot" />{LANE_NAME[l]} block</dt>
                <dd className="num">{b[l] ? <Tick value={b[l]!.toLocaleString("en-US")} /> : "…"}</dd>
              </div>
            ))}
            <div>
              <dt>Median crash → seized</dt>
              <dd className="num">{measured ? `${sec(bench.total!.p50, 2)}s` : "not measured"}</dd>
            </div>
          </dl>
        </div>
      </header>

      <LiveBand />

      <section className="sec" id="loop">
        <div className="wrap">
          <p className="kicker" data-r>// 01 · The loop</p>
          <Scramble text="One contract watches. Three chains obey." as="h2" />
          <p className="sub" data-r>
            Collateral lives on Base, debt lives on Unichain, and the decisions live on Reactive Lasna.
            Pick a loop and step through it. Each step is a transaction you can find in the proof below.
          </p>
          <Loops />
        </div>
      </section>

      <WhyReactive />
      <Audience />

      <section className="sec" id="proof">
        <div className="wrap">
          <p className="kicker" data-r>// 04 · Proof</p>
          <Scramble text="Measured on live testnets, not simulated." as="h2" />
          <Proof />
        </div>
      </section>

      <Architecture />
      <CodeSection />
      <Tested />

      <section className="sec" id="contracts">
        <div className="wrap">
          <p className="kicker" data-r>// 08 · Contracts</p>
          <Scramble text="Six contracts, source verified." as="h2" />
          <Contracts />
          <p className="small muted note" data-r>
            42 contract tests cover every loop, dropped callbacks, the repay-versus-liquidate race, spoofed callbacks and events, feed spam, oversized loans and a 50-loan sweep.
          </p>
        </div>
      </section>

      <section className="sec" id="safety">
        <div className="wrap">
          <p className="kicker" data-r>// 09 · Safety</p>
          <Scramble text="What can go wrong, and what stops it." as="h2" />
          <ul className="threats">
            {THREATS.map(([t, m, test], i) => (
              <li key={i} data-r tabIndex={0}>
                <span className="n num">{String(i + 1).padStart(2, "0")}</span>
                <span className="t">{t}</span>
                <span className="m">{m}</span>
                <span className="cov"><b>Covered by</b> <code>{test}</code></span>
              </li>
            ))}
          </ul>
          <div className="limits" data-r>
            <p className="tag">Known limits</p>
            <ul>{LIMITS.map((l, i) => <li key={i}>{l}</li>)}</ul>
          </div>
        </div>
      </section>

      <Roadmap />
      <Faq />

      <section className="sec end">
        <div className="wrap">
          <Scramble text="Move the price. Watch three chains settle." as="h2" />
          <p className="sub" data-r>Free test tokens, a wallet on Base Sepolia and Unichain Sepolia, and about a minute.</p>
          <a className="btn btn-primary btn-lg" href="#/app" data-r>Launch app <Arrow /></a>
        </div>
      </section>

      <Footer />
    </>
  );
}

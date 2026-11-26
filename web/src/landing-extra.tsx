import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { LANE_NAME, type Lane } from "./chain";
import { bench, measured, runs, sec } from "./bench";
import { num, usd } from "./format";
import { REACTION_COST } from "./chain";
import { useFuel, useMarket } from "./market";
import { stats } from "./stats";
import { Arrow, Ext, Scramble, reducedMotion } from "./ui";

const REPO = "https://github.com/KingClaszzz/tandem";

/* ------------------------------------------------------------------ scroll progress */

/** A thin line across the top in the three chain colours, filling as the page is read. */
export function ScrollProgress() {
  const bar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const on = () => {
      const h = document.documentElement.scrollHeight - innerHeight;
      if (bar.current) bar.current.style.transform = `scaleX(${h > 0 ? Math.min(1, scrollY / h) : 0})`;
    };
    on();
    addEventListener("scroll", on, { passive: true });
    return () => removeEventListener("scroll", on);
  }, []);
  return <div className="progress" aria-hidden="true"><div ref={bar} /></div>;
}

/* ------------------------------------------------------------------ horizontal drag scroller */

/** Scrolls sideways with a drag, the wheel, the keyboard or the arrows. The cursor becomes a "drag" label while over it. */
export function DragRow({ children, label }: { children: ReactNode; label: string }) {
  const row = useRef<HTMLDivElement>(null);
  const [p, setP] = useState(0);
  const drag = useRef({ down: false, x: 0, left: 0, moved: 0 });

  const update = () => {
    const el = row.current;
    if (el) setP(el.scrollWidth - el.clientWidth > 0 ? el.scrollLeft / (el.scrollWidth - el.clientWidth) : 0);
  };
  useEffect(() => { update(); }, []);

  const by = (dir: number) => row.current?.scrollBy({ left: dir * Math.min(420, (row.current?.clientWidth ?? 600) * 0.8), behavior: reducedMotion() ? "auto" : "smooth" });

  return (
    <div className="drag">
      <div
        ref={row} className="drag-row" tabIndex={0} role="region" aria-label={label}
        onScroll={update}
        onPointerDown={(e) => { if (e.pointerType !== "mouse") return; drag.current = { down: true, x: e.clientX, left: row.current!.scrollLeft, moved: 0 }; row.current!.classList.add("grabbing"); }}
        onPointerMove={(e) => { const d = drag.current; if (!d.down) return; const dx = e.clientX - d.x; d.moved = Math.max(d.moved, Math.abs(dx)); row.current!.scrollLeft = d.left - dx; }}
        onPointerUp={() => { drag.current.down = false; row.current?.classList.remove("grabbing"); }}
        onPointerLeave={() => { drag.current.down = false; row.current?.classList.remove("grabbing"); }}
        onClickCapture={(e) => { if (drag.current.moved > 6) { e.preventDefault(); e.stopPropagation(); drag.current.moved = 0; } }}
      >
        {children}
      </div>
      <div className="drag-foot">
        <span className="drag-bar"><i style={{ width: `${Math.max(12, 30 + p * 70)}%`, marginLeft: `${p * (100 - Math.max(12, 30 + p * 70))}%` }} /></span>
        <span className="drag-btns">
          <button type="button" className="icon-btn" onClick={() => by(-1)} aria-label="Scroll back"><Arrow /></button>
          <button type="button" className="icon-btn" onClick={() => by(1)} aria-label="Scroll forward"><Arrow /></button>
        </span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ live strip */

export function LiveBand() {
  const m = useMarket(undefined, 6000);
  const fuel = useFuel(20_000);
  const s = useMemo(() => stats(m.loans, m.price ?? 0), [m.loans, m.price]);
  const left = fuel.rc !== undefined ? Math.floor(fuel.rc / REACTION_COST) : undefined;
  const items: [string, string, string][] = [
    ["Open loans", String(s.active.length), `${s.liquidated} liquidated so far`],
    ["Collateral locked", `${num(m.tvlWeth, 3)} tWETH`, usd((m.tvlWeth ?? 0) * (m.price ?? 0))],
    ["Pool liquidity", usd(m.liquidity), "test USD on Unichain"],
    ["Reactive fuel", fuel.rc !== undefined ? `${fuel.rc.toFixed(2)} lREACT` : "…", left !== undefined ? `about ${left} reactions left` : ""],
  ];
  return (
    <section className="band">
      <div className="wrap band-in">
        <p className="tag"><span className="live-dot" />Live from the chains, right now</p>
        <dl className="band-grid">
          {items.map(([t, v, sub]) => (
            <div key={t} className="band-cell"><dt className="tag">{t}</dt><dd className="num">{v}</dd><span className="small muted">{sub}</span></div>
          ))}
        </dl>
        <a className="btn" href="#/app">Open the console <Arrow /></a>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ why Reactive */

const COMPARE: [string, string, string][] = [
  ["Who notices the price moved", "A server you run, watching Base", "A reactive contract subscribed to the feed's event"],
  ["Who decides which loans to close", "Code on that server", "Solidity in TandemReactive, run where the event arrives"],
  ["Who sends the transactions", "A hot key with gas on every chain", "Callbacks the chains accept only from the reactive contract"],
  ["If it goes down", "Bad debt piles up until someone notices", "Nothing to restart. Anyone can call poke() to re-send a stuck step"],
  ["What you pay for", "Servers, keys and gas on three chains", "About 0.017 lREACT per reaction, plus callback gas"],
];
const OMNI = 1, OLD = 7;

export function WhyReactive() {
  const omni = measured ? bench.total!.p50 / 1000 : undefined;
  const old = omni !== undefined ? omni - OMNI + OLD : undefined; // swap Omni's average block wait for the old one
  const max = Math.max(old ?? 0, omni ?? 0, 1);
  return (
    <section className="sec" id="why">
      <div className="wrap">
        <p className="kicker" data-r>// 02 · Why Reactive</p>
        <Scramble text="Without Reactive, this is a bot." as="h2" />
        <p className="sub" data-r>Take Reactive out and you have to rebuild three jobs somewhere else. Here is what replaces each.</p>
        <div className="compare" data-r>
          <div className="c-row c-head"><span /><span className="tag">With a keeper bot</span><span className="tag">With Tandem</span></div>
          {COMPARE.map(([a, b, c]) => (
            <div className="c-row" key={a}><span>{a}</span><span className="muted">{b}</span><span>{c}</span></div>
          ))}
        </div>

        {omni !== undefined && old !== undefined && (
          <div className="vs" data-r>
            <div className="vs-head">
              <h3>Speed matters here</h3>
              <span className="tag">the old-network figure is an estimate</span>
            </div>
            <div className="vs-row" style={{ ["--c" as string]: "var(--lasna)" }}>
              <span>Reactive Omni, measured</span>
              <span className="vs-track"><i style={{ width: `${(omni / max) * 100}%` }} /></span>
              <b className="num">{omni.toFixed(1)} s</b>
            </div>
            <div className="vs-row" style={{ ["--c" as string]: "var(--fg-4)" }}>
              <span>Same loop on ≈7 s blocks, estimated</span>
              <span className="vs-track"><i style={{ width: `${(old / max) * 100}%` }} /></span>
              <b className="num">≈ {old.toFixed(1)} s</b>
            </div>
            <p className="small muted">Two reactions sit on the liquidation path and each waits for the next Reactive block. The estimate swaps Omni's average wait for the old one. It is arithmetic from published block times, not a test on the old network.</p>
          </div>
        )}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ who it is for */

export function Audience() {
  const cols: { who: string; text: string; points: string[]; href: string; cta: string }[] = [
    {
      who: "Borrowers", text: "Keep your collateral on the chain you trust and borrow on another.",
      points: ["No bridge, no wrapped tokens", "See your liquidation price and safety buffer before you sign", "Guardian alerts you when a loan gets close"],
      href: "#/app/borrow", cta: "Try a loan",
    },
    {
      who: "Lenders", text: "Know what happens to the money you lend when the market moves.",
      points: ["The debt chain closes the loan first, so a loan is never repaid and seized", "A stress test of the whole book from −5% to −50%", "Every liquidation is on-chain with its transaction hashes"],
      href: "#/app/risk", cta: "Stress the book",
    },
    {
      who: "Builders", text: "A worked example of a multi-chain app on Reactive Omni.",
      points: ["Acknowledged state machine, idempotent callbacks and a public poke()", "42 contract tests, randomised runs and 11 browser failure scenarios", "A list of what broke and what we changed"],
      href: REPO, cta: "Read the code",
    },
  ];
  return (
    <section className="sec" id="for">
      <div className="wrap">
        <p className="kicker" data-r>// 03 · Who it is for</p>
        <Scramble text="Three people, one loop." as="h2" />
        <div className="aud">
          {cols.map((c) => (
            <article key={c.who} className="aud-card spot reticle" data-r>
              <h3>{c.who}</h3>
              <p className="muted">{c.text}</p>
              <ul>{c.points.map((p) => <li key={p}>{p}</li>)}</ul>
              <a className="aud-link ul" href={c.href} {...(c.href.startsWith("http") ? { target: "_blank", rel: "noreferrer" } : {})}>{c.cta} <Arrow /></a>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ architecture */

type Node = { id: string; lane: Lane; name: string; x: number; y: number; role: string; emits: string; accepts: string };
const NODES: Node[] = [
  { id: "feed", lane: "base", name: "PriceFeed", x: 150, y: 90, role: "The demo ETH/USD price. Anyone can post within guardrails.", emits: "AnswerUpdated", accepts: "post(price), once every 30 s" },
  { id: "vault", lane: "base", name: "CollateralVault", x: 150, y: 300, role: "Holds the borrower's tWETH.", emits: "CollateralLocked, CollateralReleased, CollateralSeized", accepts: "lock(), and release() / seize() only from Reactive" },
  { id: "rc", lane: "lasna", name: "TandemReactive", x: 450, y: 195, role: "Mirrors every loan, checks health, decides.", emits: "BorrowApproved, LiquidationRequested, SeizeRequested…", accepts: "events from the three contracts, poke() from anyone" },
  { id: "pool", lane: "uni", name: "LendingPool", x: 750, y: 195, role: "Holds the tUSD and is the source of truth for debt.", emits: "Disbursed, Repaid, Liquidated", accepts: "repay(), and disburse() / liquidate() only from Reactive" },
];
const EDGES: { id: string; from: string; to: string; label: string; kind: "event" | "callback"; lx: number; ly: number; anchor: "start" | "middle" | "end" }[] = [
  { id: "e1", from: "feed", to: "rc", label: "AnswerUpdated", kind: "event", lx: 340, ly: 100, anchor: "start" },
  { id: "e2", from: "vault", to: "rc", label: "CollateralLocked · Released · Seized", kind: "event", lx: 150, ly: 360, anchor: "middle" },
  { id: "e3", from: "pool", to: "rc", label: "Disbursed · Repaid|Liquidated", kind: "event", lx: 600, ly: 168, anchor: "middle" },
  { id: "c1", from: "rc", to: "pool", label: "disburse() · liquidate()", kind: "callback", lx: 600, ly: 244, anchor: "middle" },
  { id: "c2", from: "rc", to: "vault", label: "release() · seize()", kind: "callback", lx: 372, ly: 272, anchor: "start" },
];
const COLOR: Record<Lane, string> = { base: "var(--base)", lasna: "var(--lasna)", uni: "var(--uni)" };

export function Architecture() {
  const [active, setActive] = useState<string>();
  const byId = Object.fromEntries(NODES.map((n) => [n.id, n]));
  const sel = active ? byId[active] : undefined;
  const on = (e: { from: string; to: string }) => !active || e.from === active || e.to === active;
  const path = (a: Node, b: Node, off: number) => {
    const x1 = a.x + (b.x > a.x ? 84 : b.x < a.x ? -84 : 0), x2 = b.x + (b.x > a.x ? -84 : b.x < a.x ? 84 : 0);
    const y1 = a.y + off, y2 = b.y + off;
    const mx = (x1 + x2) / 2;
    return `M${x1} ${y1} C${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`;
  };
  return (
    <section className="sec" id="architecture">
      <div className="wrap">
        <p className="kicker" data-r>// 05 · Architecture</p>
        <Scramble text="Four contracts. Events in, callbacks out." as="h2" />
        <p className="sub" data-r>Hover a contract to see what it emits, what it accepts, and which arrows belong to it.</p>
        <div className="arch" data-r>
          <svg viewBox="0 0 900 400" className="arch-svg" role="img" aria-label="The contracts on Base, Lasna and Unichain and the events and callbacks between them">
            {(["base", "lasna", "uni"] as Lane[]).map((l, i) => (
              <g key={l}>
                <line x1={150 + i * 300} x2={150 + i * 300} y1={44} y2={380} className="arch-rail" />
                <text x={150 + i * 300} y={26} textAnchor="middle" className="arch-lane" fill={COLOR[l]}>{LANE_NAME[l].toUpperCase()}</text>
              </g>
            ))}
            {EDGES.map((e, i) => {
              const a = byId[e.from], b = byId[e.to];
              const off = e.kind === "callback" ? 12 : e.id === "e2" ? -10 : -12;
              return (
                <g key={e.id} className={`arch-edge ${e.kind} ${on(e) ? "" : "dim"}`}>
                  <path d={path(a, b, off + (i === 4 ? 10 : 0))} stroke={e.kind === "callback" ? COLOR[b.lane] : "var(--fg-3)"} />
                  <text x={e.lx} y={e.ly} textAnchor={e.anchor}>{e.label.split("|").map((t, k) => <tspan key={t} x={e.lx} dy={k ? 13 : 0}>{t}</tspan>)}</text>
                </g>
              );
            })}
            {NODES.map((n) => (
              <g
                key={n.id} className={`arch-node ${active === n.id ? "on" : active ? "dim" : ""}`} transform={`translate(${n.x - 84} ${n.y - 28})`}
                tabIndex={0} role="button" aria-label={`${n.name}: ${n.role}`}
                onPointerEnter={() => setActive(n.id)} onPointerLeave={() => setActive(undefined)} onFocus={() => setActive(n.id)} onBlur={() => setActive(undefined)}
              >
                <rect width="168" height="56" rx="10" stroke={COLOR[n.lane]} />
                <text x="84" y="34" textAnchor="middle" className="n-name">{n.name}</text>
              </g>
            ))}
          </svg>
          <div className="arch-detail" aria-live="polite">
            {sel ? (
              <>
                <p className="tag" style={{ color: COLOR[sel.lane] }}>{LANE_NAME[sel.lane]}</p>
                <h3>{sel.name}</h3>
                <p className="muted">{sel.role}</p>
                <dl>
                  <div><dt>Emits</dt><dd className="mono">{sel.emits}</dd></div>
                  <div><dt>Accepts</dt><dd className="mono">{sel.accepts}</dd></div>
                </dl>
              </>
            ) : <p className="muted">Solid lines are events the reactive contract listens to. Dashed lines are the callbacks it sends back. Nothing else can move collateral or debt.</p>}
          </div>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ tested */

export function Tested() {
  const cards: [string, string, string][] = [
    ["42", "contract tests", "Borrow, refusal, repay, liquidation, a repay racing a liquidation, dropped callbacks, spoofed callers and events, replayed prices, a 50-loan gas sweep."],
    ["6 × 40", "random sequences", "Random borrows, repays, price moves and callbacks dropped on purpose. After each one: tokens conserved, no loan both repaid and seized, all three chains agree."],
    ["11", "browser scenarios", "No wallet, user rejects, wrong chain, a hung wallet, hostile error text, the RPC going down, junk input, disconnect. No transaction is sent."],
    ["489k", "gas, worst case", "50 open loans with 10 liquidated by one price update, against a 900k cap per reactive transaction."],
    ["6 / 6", "contracts verified", "Exact-match source on Sourcify, including the reactive contract on Lasna."],
    [measured ? String(runs.length) : "—", "liquidations measured", measured ? `Median ${sec(bench.total!.p50, 1)} s from the price update to the collateral seized, p95 ${sec(bench.total!.p95, 1)} s. Every transaction hash is published.` : "Measured on the live testnets, with every transaction hash published."],
    ["1", "bug the live run found", "Our own trace stopped updating after about 30 s on Base, because the public RPC caps log ranges. The chain was fine. We fixed the tracker."],
    ["3", "flaws we found in v1", "A free price feed anyone could spam, a vault that accepted loans Reactive then refused, and an overflow. Found by attack tests, fixed in the deployed version."],
  ];
  return (
    <section className="sec" id="tested">
      <div className="wrap">
        <p className="kicker" data-r>// 07 · Tested</p>
        <Scramble text="Tested like the money was real." as="h2" />
        <p className="sub" data-r>Drag sideways, or use the arrows.</p>
      </div>
      <div className="wrap drag-wrap" data-r>
        <DragRow label="What we tested">
          {cards.map(([n, t, d]) => (
            <article key={t} className="t-card spot reticle">
              <b className="num">{n}</b>
              <h3>{t}</h3>
              <p className="muted">{d}</p>
            </article>
          ))}
        </DragRow>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ roadmap, faq, footer */

export function Roadmap() {
  const items: [string, string, string][] = [
    ["Now", "Working on testnets", "Three loops, 15+ measured liquidations, verified contracts, a console, test tokens and a demo price feed."],
    ["Next", "Make spam cost something", "A small fee on each loan that pays for the reactions it causes, and a Chainlink aggregator as the feed. It emits the same event, so the reactive contract does not change."],
    ["Then", "A bigger market", "More collateral and debt pairs, partial liquidation, interest, and a liquidation bonus that pays for itself."],
    ["Later", "Mainnet and an audit", "Reactive mainnet, real assets, and an independent review before anyone lends real money."],
  ];
  return (
    <section className="sec" id="roadmap">
      <div className="wrap">
        <p className="kicker" data-r>// 10 · What is next</p>
        <Scramble text="Honest about where it is." as="h2" />
        <ol className="road">
          {items.map(([when, t, d], i) => (
            <li key={when} data-r style={{ ["--i" as string]: i }}>
              <span className="road-when num">{when}</span>
              <div><h3>{t}</h3><p className="muted">{d}</p></div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

const FAQ: [string, string][] = [
  ["Is any of this real money?", "No. Everything runs on testnets with free test tokens. The ETH price comes from a demo feed that anyone can move."],
  ["Do I need a wallet to look around?", "No. The console reads the chains without one, and the Activity page replays any of the recorded liquidations with their real timings. A wallet is only needed to borrow or move the price."],
  ["What happens if Reactive runs out of fuel?", "Loans stay as they are and collateral is not lost, but nothing moves until the contract is topped up. The console shows the fuel gauge, pauses new loans when it is empty, and anyone can call poke() afterwards to re-send a stuck step."],
  ["Why does Unichain close the loan before Base seizes the collateral?", "So a borrower can never both repay and lose the collateral. Once liquidate() lands on the debt chain, repay() on that loan reverts. Seizing follows only after Reactive sees the loan closed."],
  ["Can anyone liquidate anyone?", "Only by moving the demo price, which is what lets you trigger a liquidation yourself. On a real network the price would come from a Chainlink aggregator, which emits the same event."],
  ["Why a 30-second cooldown on the price feed?", "Every price update makes the reactive contract run once, and the operator pays for each run. Without a cooldown, anyone could drain it by posting in a loop. We found that in our own attack tests."],
  ["How do I know the timings are real?", "Each of the measured runs has its transaction hashes published, and every dot on the latency chart opens its transaction. The raw runs are in the repository."],
];

export function Faq() {
  return (
    <section className="sec" id="faq">
      <div className="wrap">
        <p className="kicker" data-r>// 11 · Questions</p>
        <Scramble text="Things people ask." as="h2" />
        <div className="faq">
          {FAQ.map(([q, a]) => (
            <details key={q} data-r>
              <summary><span>{q}</span><i aria-hidden="true" /></summary>
              <p className="muted">{a}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

export function Footer() {
  const cols: [string, [string, string, boolean?][]][] = [
    ["Try it", [["Open the console", "#/app"], ["Replay a liquidation", "#/app/activity"], ["Speed lab", "#/app/latency"], ["System health", "#/app/system"]]],
    ["Proof", [["Measured runs", "#proof"], ["Contracts, verified", "#contracts"], ["What we tested", "#tested"], ["Known limits", "#safety"]]],
    ["Project", [["Source on GitHub", REPO, true], ["Reactive Omni Buildathon", "https://dorahacks.io/hackathon/reactive-omni-buildathon/detail", true], ["Reactive docs", "https://dev.reactive.network/", true], ["Sourcify", "https://sourcify.dev", true]]],
  ];
  return (
    <footer className="foot">
      <div className="wrap foot-grid">
        <div className="foot-brand">
          <b>Tandem</b>
          <p className="muted small">Cross-chain lending where Reactive does the liquidating. Built for the Reactive Omni Buildathon. Testnets only.</p>
        </div>
        {cols.map(([title, links]) => (
          <nav key={title} aria-label={title}>
            <span className="tag">{title}</span>
            {links.map(([label, href, ext]) => (
              <a key={label} className="ul" href={href} {...(ext ? { target: "_blank", rel: "noreferrer" } : {})}>{label}{ext && <Ext />}</a>
            ))}
          </nav>
        ))}
      </div>
    </footer>
  );
}

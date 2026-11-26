import { useMemo, useState, type ReactNode } from "react";
import snippets from "./snippets.json";
import { DEPLOYMENTS, sourcifyUrl, type Lane } from "./chain";
import { Ext, Scramble } from "./ui";

const REPO = "https://github.com/KingClaszzz/tandem";

/* ------------------------------------------------------------------ a small Solidity highlighter (no dependency) */

const KEYWORDS = new Set("function external internal public private view pure returns return if else for while revert emit constant immutable event error struct enum mapping memory calldata storage payable override virtual new delete true false using import contract abstract is this".split(" "));
const TYPES = new Set("address bool bytes string uint uint8 uint64 uint128 uint256 int256 bytes32".split(" "));

function tokenize(line: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\/\/.*$)|("[^"]*")|(\b0x[0-9a-fA-F]+\b|\b\d[\d_]*\b)|([A-Za-z_]\w*)|(\s+|.)/g;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(line))) {
    const [t, comment, str, num, word] = m;
    const key = k++;
    if (comment) out.push(<span key={key} className="c-com">{t}</span>);
    else if (str) out.push(<span key={key} className="c-str">{t}</span>);
    else if (num) out.push(<span key={key} className="c-num">{t}</span>);
    else if (word) {
      const call = line[re.lastIndex] === "(";
      const cls = KEYWORDS.has(word) ? "c-kw"
        : TYPES.has(word) ? "c-ty"
        : /^only[A-Z]/.test(word) ? "c-mod"
        : /^[A-Z][A-Z0-9_]{2,}$/.test(word) ? "c-const"
        : call ? "c-fn" : "";
      out.push(cls ? <span key={key} className={cls}>{t}</span> : t);
    } else out.push(t);
  }
  return out;
}

type Snip = (typeof snippets.code)[number];
type Note = { line: number; text: string };

const KEY: Record<string, "reactive" | "vault" | "pool" | "feed"> = { TandemReactive: "reactive", CollateralVault: "vault", LendingPool: "pool", PriceFeed: "feed" };
const LANE_OF: Record<string, Lane> = { TandemReactive: "lasna", CollateralVault: "base", LendingPool: "uni", PriceFeed: "base" };

function CodeBlock({ snip, hot, setHot }: { snip: Snip; hot?: number; setHot: (i?: number) => void }) {
  const lines = snip.text.split("\n");
  const notes = snip.notes as Note[];
  const noted = useMemo(() => new Set(notes.map((n) => n.line)), [notes]);
  const [copied, setCopied] = useState(false);
  const copy = () => navigator.clipboard?.writeText(snip.text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1400); }).catch(() => {});
  const dep = DEPLOYMENTS[KEY[snip.contract]];
  const lane = LANE_OF[snip.contract];

  return (
    <div className="code-grid">
      <div className="code-main">
        <div className="code-head">
          <span className={`lane-${lane}`}><i className="dot" /> <b className="mono">{snip.contract}.sol</b></span>
          <span className="code-links">
            <button type="button" className="copy" onClick={copy}>{copied ? "copied" : "copy code"}</button>
            <a className="ul" href={`${REPO}/blob/main/${snip.file}#L${snip.from}-L${snip.to}`} target="_blank" rel="noreferrer">on GitHub<Ext /></a>
            {dep && <a className="ul" href={sourcifyUrl(dep.chain, dep.address)} target="_blank" rel="noreferrer">verified source<Ext /></a>}
          </span>
        </div>
        <pre className="code" tabIndex={0} aria-label={`${snip.title}: source of ${snip.contract}`}>
          {lines.map((l, i) => {
            const has = noted.has(i);
            return (
              <div
                key={i} className={`ln ${has ? "has" : ""} ${hot === i ? "hot" : ""}`}
                onPointerEnter={has ? () => setHot(i) : undefined} onPointerLeave={has ? () => setHot(undefined) : undefined}
                onFocus={has ? () => setHot(i) : undefined} onBlur={has ? () => setHot(undefined) : undefined} tabIndex={has ? 0 : -1}
              >
                <span className="no num" aria-hidden="true">{i + 1}</span>
                <code>{l ? tokenize(l) : " "}</code>
              </div>
            );
          })}
        </pre>
      </div>

      <aside className="code-notes" aria-label="What to notice">
        <p className="tag">What to notice</p>
        <ol>
          {notes.map((n, i) => (
            <li key={i} className={hot === n.line ? "hot" : ""} onPointerEnter={() => setHot(n.line)} onPointerLeave={() => setHot(undefined)}>
              <span className="n num">line {n.line + 1}</span>
              <span>{n.text}</span>
            </li>
          ))}
        </ol>
        <p className="small muted">Hover a marked line, or a note, to link them. This code is read from the contracts in the repository, not typed here.</p>
      </aside>
    </div>
  );
}

/** Every contract's public surface, from the compiled ABIs. Click a row to copy it. */
function Interfaces() {
  const [copied, setCopied] = useState<string>();
  const copy = (s: string) => navigator.clipboard?.writeText(s).then(() => { setCopied(s); setTimeout(() => setCopied(undefined), 1200); }).catch(() => {});
  return (
    <div className="ifaces">
      {(Object.keys(snippets.abi) as (keyof typeof snippets.abi)[]).map((name) => {
        const a = snippets.abi[name];
        return (
          <section key={name} className={`iface lane-${LANE_OF[name]}`}>
            <h3><i className="dot" /> {name}</h3>
            <ul>
              {a.functions.filter((f) => !/^(coverDebt|pay)\(/.test(f)).map((f) => (
                <li key={f}><button type="button" onClick={() => copy(f)} title="Copy"><span className="tg fn">fn</span><code>{f}</code><span className="cp">{copied === f ? "copied" : "copy"}</span></button></li>
              ))}
              {a.events.filter((e) => !/^Callback\(/.test(e)).map((e) => (
                <li key={e}><button type="button" onClick={() => copy(e)} title="Copy"><span className="tg ev">event</span><code>{e}</code><span className="cp">{copied === e ? "copied" : "copy"}</span></button></li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

export function CodeSection() {
  const [tab, setTab] = useState(0);
  const [hot, setHot] = useState<number>();
  const tabs = [...snippets.code.map((c) => c.tab), "Interfaces"];
  const snip = snippets.code[tab];

  return (
    <section className="sec" id="code">
      <div className="wrap">
        <p className="kicker" data-r>// 06 · The code</p>
        <Scramble text="The whole idea, in the contracts' own words." as="h2" />
        <p className="sub" data-r>
          Seven short pieces of the real source. Each one is a rule the system depends on.
        </p>

        <div className="seg code-tabs" role="tablist" aria-label="Code excerpts" data-r>
          {tabs.map((t, i) => (
            <button key={t} role="tab" aria-selected={i === tab} className={i === tab ? "on" : ""} onClick={() => { setTab(i); setHot(undefined); }}>{t}</button>
          ))}
        </div>

        {snip ? (
          <>
            <div className="code-title">
              <h3>{snip.title}</h3>
              <p className="muted">{snip.lead}</p>
            </div>
            <CodeBlock key={snip.id} snip={snip} hot={hot} setHot={setHot} />
          </>
        ) : (
          <>
            <div className="code-title">
              <h3>What each contract exposes</h3>
              <p className="muted">Straight from the compiled ABIs: the functions that change state, and the events. Click one to copy it.</p>
            </div>
            <Interfaces />
          </>
        )}
      </div>
    </section>
  );
}

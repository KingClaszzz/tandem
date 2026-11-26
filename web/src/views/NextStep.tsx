import { stageOf } from "../market";
import { Arrow } from "../ui";
import type { Ctx } from "./ctx";

/** One clear next action for someone new, derived from what they have already done. It goes away once they have seen the whole loop. */
export default function NextStep({ c }: { c: Ctx }) {
  const { account, m, mine, moved } = c;
  const gas = (m.me.ethBase ?? 0) > 0 && (m.me.ethUni ?? 0) > 0;
  const hasTokens = (m.me.weth ?? 0) > 0 || mine.length > 0;
  const seen = moved || mine.some((l) => stageOf(l) === "seized");

  const steps = [
    { label: "Connect", done: Boolean(account) },
    { label: "Get test ETH", done: Boolean(account) && gas },
    { label: "Test tokens", done: hasTokens },
    { label: "Borrow", done: mine.length > 0 },
    { label: "Crash the price", done: seen },
  ];
  const idx = steps.findIndex((s) => !s.done);
  if (idx === -1) {
    return (
      <section className="panel nextstep done">
        <div>
          <p className="tag">You have seen the whole loop</p>
          <h2>Now look at what it cost and how fast it was</h2>
        </div>
        <div className="ns-actions">
          <a className="btn btn-primary" href="#/app/latency">Open the speed lab <Arrow /></a>
          <a className="btn" href="#/app/activity">Replay a recorded run</a>
        </div>
      </section>
    );
  }

  const copy: Record<number, { title: string; text: string; action: React.ReactNode }> = {
    0: {
      title: "Connect a wallet to try it",
      text: "Everything here uses test tokens on testnets, so nothing real is at risk. Any browser wallet works.",
      action: <button className="btn btn-primary" onClick={c.connect}>{c.hasWallet ? "Connect wallet" : "Install a browser wallet"} <Arrow /></button>,
    },
    1: {
      title: "You need a little test ETH on two chains",
      text: "Gas on Base Sepolia and on Unichain Sepolia. About 0.001 ETH on each is plenty, from any public faucet. This page notices when it arrives.",
      action: <button className="btn" onClick={() => m.refresh()}>I have it, check again</button>,
    },
    2: {
      title: "Get some test collateral",
      text: "One click mints 2 test WETH on Base. You will lock some of it as collateral.",
      action: <button className="btn btn-primary" disabled={!!c.busy} onClick={c.act.faucet}>{c.busy === "faucet" ? "Minting…" : "Mint 2 test WETH"} <Arrow /></button>,
    },
    3: {
      title: "Borrow against it, across chains",
      text: "You lock collateral on Base and receive test USD on Unichain. Reactive connects the two, with no bridge.",
      action: <a className="btn btn-primary" href="#/app/borrow">Open Borrow <Arrow /></a>,
    },
    4: {
      title: "Now crash the price and watch it settle",
      text: "Move the price down and Reactive closes the loan on Unichain and seizes the collateral on Base. You will see every step.",
      action: <a className="btn btn-primary" href="#/app/risk">Open Price and risk <Arrow /></a>,
    },
  };
  const s = copy[idx];

  return (
    <section className="panel nextstep">
      <ol className="ns-steps" aria-label="Your progress">
        {steps.map((st, i) => <li key={st.label} className={st.done ? "done" : i === idx ? "current" : ""}><i>{st.done ? "✓" : i + 1}</i><span>{st.label}</span></li>)}
      </ol>
      <div className="ns-body">
        <div>
          <p className="tag">Next step</p>
          <h2>{s.title}</h2>
          <p className="muted">{s.text}</p>
        </div>
        <div className="ns-actions">
          {s.action}
          {!account && <a className="btn" href="#/app/activity">Or watch a recorded liquidation, no wallet</a>}
        </div>
      </div>
    </section>
  );
}

import { Nav } from "./ui";

const STEPS: { t: string; body: string; note?: string }[] = [
  { t: "Get a browser wallet", body: "Install MetaMask or Rabby. Create a new account for testing; never use one that holds real funds." },
  { t: "Get test ETH on Base Sepolia", body: "You need a little Base Sepolia ETH for gas. Any Base Sepolia faucet works. Unichain Sepolia ETH is only needed if you want to repay, and the amounts are tiny.", note: "The app adds both networks to your wallet for you when you first need them." },
  { t: "Connect on the console page", body: "Open the console and press Connect wallet. Until you connect, the console shows nothing. Disconnect from the wallet menu at any time; it takes you back to the home page." },
  { t: "Get test tokens", body: "On Home, use the faucets: test WETH (the collateral) on Base, and test USD on Unichain if you want to repay later. They are free and have no value." },
  { t: "Borrow", body: "Open Borrow. Choose how much WETH to lock and how much USD to borrow. Keep it at or below 70% of the collateral's value. The app asks for two signatures: approve, then lock." },
  { t: "Watch the loop", body: "After you lock, a live tracker follows the loan: Base lock, Reactive reaction, Unichain payout. It usually takes a few seconds, and every step links to its transaction." },
  { t: "Repay, or move the price", body: "Repay from My loans to get your collateral back. Or open Price and risk and post a lower ETH price: when a loan passes 80% LTV, Reactive liquidates it by itself, with no keeper and no bridge." },
  { t: "Check the speed and the health", body: "Speed lab shows measured timings from real runs. Health shows the fuel of the reactive contract; if it is empty, new loans are paused." },
];

const FAQ: [string, string][] = [
  ["Switch account does nothing", "Your wallet picks the account. In the picker, choose a different account and confirm. If your wallet has no picker, change the account inside the wallet; the console follows it."],
  ["The console says Connect a wallet", "That is on purpose. The console only opens for a connected wallet. Press Connect, or go back to the home page."],
  ["A transaction was rejected", "The app checks each transaction before sending it. If it says the price moved or the limit was reached, read the message and try again with other values."],
  ["Is anything real here?", "No. These are test networks and test tokens. The price feed is a demo feed anyone can move, so you can trigger a liquidation yourself."],
];

export default function Guide() {
  return (
    <div className="app">
      <Nav>
        <a className="btn btn-sm" href="#/">Home</a>
        <a className="btn btn-sm btn-primary" href="#/app">Open console</a>
      </Nav>
      <main className="wrap guide">
        <p className="kicker">// Guide</p>
        <h1>From zero to a liquidation in eight steps</h1>
        <p className="muted">About five minutes. You only need a browser wallet and a little test ETH.</p>
        <ol className="g-steps">
          {STEPS.map((s, i) => (
            <li key={s.t}>
              <span className="g-n num">{String(i + 1).padStart(2, "0")}</span>
              <div>
                <h3>{s.t}</h3>
                <p>{s.body}</p>
                {s.note && <p className="small muted">{s.note}</p>}
              </div>
            </li>
          ))}
        </ol>
        <h2>If something looks wrong</h2>
        <dl className="g-faq">
          {FAQ.map(([q, a]) => (<div key={q}><dt>{q}</dt><dd>{a}</dd></div>))}
        </dl>
        <p className="g-cta"><a className="btn btn-primary" href="#/app">Open the console</a> <a className="btn" href="#/">Back to home</a></p>
      </main>
    </div>
  );
}

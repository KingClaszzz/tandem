import { useEffect, useRef, useState } from "react";
import { fmtAddr } from "./wallet";
import { CopyBtn } from "./ui";

/** Connected wallet chip with a real menu: copy address, switch account, disconnect. */
export default function WalletMenu({ account, onSwitch, onDisconnect }: { account: string; onSwitch: () => void; onDisconnect: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    addEventListener("mousedown", down);
    addEventListener("keydown", key);
    return () => { removeEventListener("mousedown", down); removeEventListener("keydown", key); };
  }, []);
  return (
    <div className="wmenu" ref={ref}>
      <button type="button" className="chip live num wm-btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)} title={account}>
        {fmtAddr(account)}
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
      </button>
      {open && (
        <div className="wm-pop" role="menu">
          <div className="wm-addr">
            <span className="tag">Connected</span>
            <span className="num">{account}</span>
            <CopyBtn text={account} label="copy address" />
          </div>
          <button role="menuitem" className="wm-item" onClick={() => { setOpen(false); onSwitch(); }}>Switch account</button>
          <button role="menuitem" className="wm-item danger" onClick={() => { setOpen(false); onDisconnect(); }}>Disconnect</button>
        </div>
      )}
    </div>
  );
}

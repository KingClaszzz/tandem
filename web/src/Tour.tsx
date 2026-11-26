import { useEffect, useLayoutEffect, useState } from "react";

const KEY = "tandem:tour-seen";
export const tourSeen = () => { try { return localStorage.getItem(KEY) === "1"; } catch { return true; } };
export const markTourSeen = () => { try { localStorage.setItem(KEY, "1"); } catch { /* storage unavailable */ } };

const STEPS: { sel: string; title: string; body: string }[] = [
  { sel: ".side nav", title: "Three groups of pages", body: "Use is where you borrow and repay. Explore shows the price, the speed and the activity. Operate shows the health of the automation." },
  { sel: ".side-foot", title: "The price that drives everything", body: "This is the ETH price on Base. When it falls far enough, loans become unhealthy and Reactive closes them. 'Reactive in sync' means it has seen the latest price." },
  { sel: ".chains", title: "Three chains, live", body: "Base holds the collateral, Unichain holds the debt, Lasna runs the reactive contract. The numbers are the latest block on each." },
  { sel: ".dash-head", title: "Start here", body: "Home tells you your next step. If you have no test tokens yet, it points you to the faucets. Then go to Borrow." },
  { sel: ".wmenu", title: "Your wallet", body: "Copy your address, switch to another account, or disconnect. Disconnecting takes you back to the home page." },
];

/** A short spotlight walk-through. It never blocks the page for good: Escape or Skip closes it at any step. */
export function Tour({ onClose }: { onClose: () => void }) {
  const [i, setI] = useState(0);
  const [box, setBox] = useState<DOMRect>();
  const step = STEPS[i];

  useLayoutEffect(() => {
    const place = () => {
      const el = document.querySelector(step.sel);
      if (!el) return setBox(undefined);
      el.scrollIntoView({ block: "nearest" });
      setBox(el.getBoundingClientRect());
    };
    place();
    addEventListener("resize", place);
    return () => removeEventListener("resize", place);
  }, [step.sel]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowRight") setI((n) => Math.min(n + 1, STEPS.length - 1));
      if (e.key === "ArrowLeft") setI((n) => Math.max(n - 1, 0));
    };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [onClose]);

  const last = i === STEPS.length - 1;
  const pad = 6;
  const style = box ? { top: box.top - pad, left: box.left - pad, width: box.width + pad * 2, height: box.height + pad * 2 } : undefined;
  // The card sits beside the highlighted box when there is room, and in the corner otherwise.
  const card: React.CSSProperties = box && innerWidth > 760
    ? { top: Math.min(Math.max(box.top, 16), innerHeight - 220), left: Math.min(box.right + 20, innerWidth - 360) }
    : { bottom: 16, left: 16, right: 16 };

  return (
    <div className="tour" role="dialog" aria-modal="true" aria-label="Console tour">
      <div className="tour-back" onClick={onClose} />
      {style && <div className="tour-hole" style={style} />}
      <div className="tour-card" style={card}>
        <span className="tag">Step {i + 1} of {STEPS.length}</span>
        <h3>{step.title}</h3>
        <p>{step.body}</p>
        <div className="tour-actions">
          <button className="btn btn-sm" onClick={onClose}>Skip</button>
          <span className="grow" />
          {i > 0 && <button className="btn btn-sm" onClick={() => setI(i - 1)}>Back</button>}
          <button className="btn btn-sm btn-primary" onClick={() => (last ? onClose() : setI(i + 1))} autoFocus>{last ? "Done" : "Next"}</button>
        </div>
      </div>
    </div>
  );
}

export function TourButton({ onStart }: { onStart: () => void }) {
  return <button type="button" className="chip tour-btn" onClick={onStart} title="Take a 1-minute tour of the console">Tour</button>;
}

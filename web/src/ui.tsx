import { useEffect, useRef, useState } from "react";
import { LANE_NAME, txUrl, type Lane } from "./chain";
import type { Step } from "./market";

export function Logo() {
  return (
    <a className="logo" href="#/" aria-label="Tandem home">
      <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true">
        <circle cx="8" cy="13" r="5.5" fill="none" stroke="var(--base)" strokeWidth="2" />
        <circle cx="18" cy="13" r="5.5" fill="none" stroke="var(--uni)" strokeWidth="2" />
        <circle cx="13" cy="13" r="1.8" fill="var(--lasna)" />
      </svg>
      Tandem
    </a>
  );
}

export const Arrow = () => (
  <svg className="arr" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M5 12h14M13 6l6 6-6 6" />
  </svg>
);

export const Ext = () => (
  <svg className="ext" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <path d="M7 17 17 7M8 7h9v9" />
  </svg>
);

const GLYPHS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_#/<>";
const reduced = () => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Text that decodes from random glyphs when it first scrolls into view (or when `text` changes). */
export function Scramble({ text, className, as: Tag = "span", speed = 28 }: { text: string; className?: string; as?: any; speed?: number }) {
  const [out, setOut] = useState(text);
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (reduced()) return setOut(text);
    let raf = 0, started = false;
    const run = () => {
      const t0 = performance.now();
      const tick = () => {
        // `speed` characters resolve per second-ish frame budget; the rest show random glyphs.
        const revealed = Math.floor(((performance.now() - t0) / 1000) * speed * 2);
        setOut(text.split("").map((ch, i) => (ch === " " || i < revealed ? ch : GLYPHS[(Math.random() * GLYPHS.length) | 0])).join(""));
        if (revealed < text.length) raf = requestAnimationFrame(tick);
        else setOut(text);
      };
      tick();
    };
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting && !started) { started = true; run(); } }, { threshold: 0.3 });
    if (ref.current) io.observe(ref.current);
    return () => { io.disconnect(); cancelAnimationFrame(raf); };
  }, [text, speed]);
  return <Tag ref={ref} className={className} aria-label={text}><span aria-hidden="true">{out}</span></Tag>;
}

/** Cursor spotlight for every `.card` (sets --mx / --my). Mount once. */
export function useSpotlight() {
  useEffect(() => {
    const move = (e: PointerEvent) => {
      const card = (e.target as Element | null)?.closest?.(".card") as HTMLElement | null;
      if (!card) return;
      const r = card.getBoundingClientRect();
      card.style.setProperty("--mx", `${e.clientX - r.left}px`);
      card.style.setProperty("--my", `${e.clientY - r.top}px`);
    };
    addEventListener("pointermove", move, { passive: true });
    return () => removeEventListener("pointermove", move);
  }, []);
}

const LANES: Lane[] = ["base", "lasna", "uni"];
const COLOR: Record<Lane, string> = { base: "var(--base)", lasna: "var(--lasna)", uni: "var(--uni)" };

export const fmtMs = (ms?: number) => (ms === undefined ? "" : ms === 0 ? "0.0s" : `+${(ms / 1000).toFixed(1)}s`);

/** Three-lane trace of one loop: each step sits in its chain's column, with a hop drawn from the previous step. */
export function LoopTrace({ steps, link = true }: { steps: Step[]; link?: boolean }) {
  return (
    <div className="trace">
      <div className="trace-head">
        <div>Time</div>
        {LANES.map((l) => (
          <div key={l} className={`lane-${l}`}><i className="dot" />{LANE_NAME[l].replace(" Sepolia", "").replace("Reactive ", "Reactive ")}</div>
        ))}
      </div>
      <div className="trace-body">
        <div className="lanes-bg"><div /><div /><div /></div>
        {steps.map((s, i) => {
          const prev = steps[i - 1];
          const col = LANES.indexOf(s.lane);
          const pcol = prev ? LANES.indexOf(prev.lane) : col;
          const lo = Math.min(col, pcol), hi = Math.max(col, pcol);
          const content = (
            <>
              <b>{s.label}</b>
              <span>{s.detail}</span>
              {s.hash && link && <Ext />}
            </>
          );
          return (
            <div className="trace-row" key={i}>
              <div className={`t ${s.status === "wait" ? "dim" : ""}`}>{s.status === "wait" ? "…" : s.status === "fail" ? "—" : fmtMs(s.ms)}</div>
              {prev && hi > lo && s.status !== "wait" && (
                <div
                  className={`hop ${col < pcol ? "rev" : ""}`}
                  style={{
                    left: `calc(var(--tc) + 8px + (100% - var(--tc) - 8px) * ${lo / 3} + (100% - var(--tc) - 8px) / 6)`,
                    width: `calc((100% - var(--tc) - 8px) * ${(hi - lo) / 3})`,
                    ["--from" as any]: COLOR[col < pcol ? s.lane : prev.lane],
                    ["--to" as any]: COLOR[col < pcol ? prev.lane : s.lane],
                    ["--origin" as any]: col < pcol ? "right" : "left",
                  }}
                />
              )}
              {LANES.map((l, j) =>
                j !== col ? <div key={l} /> : s.hash && link ? (
                  <a key={l} className={`node lane-${l} ${s.status}`} href={txUrl(l, s.hash)} target="_blank" rel="noreferrer" title={`${LANE_NAME[l]} tx ${s.hash}`}>{content}</a>
                ) : (
                  <div key={l} className={`node lane-${l} ${s.status}`}>{content}</div>
                ),
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

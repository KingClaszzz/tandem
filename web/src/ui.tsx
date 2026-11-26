import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { LANES, LANE_NAME, LANE_SHORT, txUrl, type Lane } from "./chain";
import type { Step } from "./market";

export const reducedMotion = () => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ------------------------------------------------------------------ marks and icons */

export function Mark({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 26 26" aria-hidden="true" className="mark">
      <circle cx="8" cy="13" r="5.5" fill="none" stroke="var(--base)" strokeWidth="2" />
      <circle cx="18" cy="13" r="5.5" fill="none" stroke="var(--uni)" strokeWidth="2" />
      <circle cx="13" cy="13" r="1.8" fill="var(--lasna)" />
    </svg>
  );
}

export function Logo() {
  return (
    <a className="logo" href="#/" aria-label="Tandem home">
      <Mark />
      <span className="logo-word">Tandem</span>
    </a>
  );
}

export const Arrow = () => (
  <svg className="arr" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M5 12h14M13 6l6 6-6 6" />
  </svg>
);
export const Ext = () => (
  <svg className="ext" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
    <path d="M7 17 17 7M8 7h9v9" />
  </svg>
);

/* ------------------------------------------------------------------ nav: full bar at the top, floating pill after scrolling */

export function Nav({ links, children }: { links?: { href: string; label: string; ext?: boolean }[]; children?: ReactNode }) {
  const [pill, setPill] = useState(false);
  useEffect(() => {
    const on = () => setPill(scrollY > 48);
    on();
    addEventListener("scroll", on, { passive: true });
    return () => removeEventListener("scroll", on);
  }, []);
  return (
    <header className={`nav ${pill ? "pill" : ""}`}>
      <nav className="nav-bar" aria-label="Main">
        <Logo />
        {links && (
          <div className="nav-links">
            {links.map((l) => (
              <a key={l.href} className="nl" href={l.href} {...(l.ext ? { target: "_blank", rel: "noreferrer" } : {})}>{l.label}</a>
            ))}
          </div>
        )}
        <div className="nav-end">{children}</div>
      </nav>
    </header>
  );
}

/* ------------------------------------------------------------------ text that decodes when it scrolls into view */

const GLYPHS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_#/<>[]";

export function Scramble({ text, as: Tag = "span", className, speed = 38, once = true }: { text: string; as?: any; className?: string; speed?: number; once?: boolean }) {
  const [out, setOut] = useState(text);
  const ref = useRef<HTMLElement>(null);
  const done = useRef(false);
  useEffect(() => {
    if (reducedMotion()) return setOut(text);
    let raf = 0;
    const run = () => {
      const t0 = performance.now();
      const tick = () => {
        const revealed = ((performance.now() - t0) / 1000) * speed;
        setOut(text.split("").map((ch, i) => (ch === " " || i < revealed ? ch : GLYPHS[(Math.random() * GLYPHS.length) | 0])).join(""));
        if (revealed < text.length) raf = requestAnimationFrame(tick);
        else setOut(text);
      };
      tick();
    };
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting && !(once && done.current)) { done.current = true; cancelAnimationFrame(raf); run(); }
    }, { threshold: 0.4 });
    io.observe(el);
    return () => { io.disconnect(); cancelAnimationFrame(raf); };
  }, [text, speed, once]);
  return <Tag ref={ref} className={className} aria-label={text}><span aria-hidden="true">{out}</span></Tag>;
}

/* ------------------------------------------------------------------ reveal on scroll + card spotlight */

export function useReveal() {
  useEffect(() => {
    if (reducedMotion()) return;
    document.documentElement.classList.add("reveal-on");
    const io = new IntersectionObserver(
      (es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } }),
      { threshold: 0.12, rootMargin: "0px 0px -6% 0px" },
    );
    const scan = () => document.querySelectorAll("[data-r]:not(.in)").forEach((el) => io.observe(el));
    scan();
    const mo = new MutationObserver(scan);
    mo.observe(document.body, { childList: true, subtree: true });
    return () => { io.disconnect(); mo.disconnect(); document.documentElement.classList.remove("reveal-on"); };
  }, []);
}

export function useSpotlight() {
  useEffect(() => {
    const move = (e: PointerEvent) => {
      const el = (e.target as Element | null)?.closest?.(".spot") as HTMLElement | null;
      if (!el) return;
      const r = el.getBoundingClientRect();
      el.style.setProperty("--mx", `${e.clientX - r.left}px`);
      el.style.setProperty("--my", `${e.clientY - r.top}px`);
    };
    addEventListener("pointermove", move, { passive: true });
    return () => removeEventListener("pointermove", move);
  }, []);
}

/* ------------------------------------------------------------------ ASCII field: three chain rails and the liquidation loop travelling between them */

const RAMP = " .·:-=+*#%@";
const RAIL_X = [0.78, 0.88, 0.97]; // base, lasna, unichain as a fraction of the canvas width
const RAIL_RGB: [number, number, number][] = [[77, 141, 255], [98, 208, 255], [255, 106, 213]];
// The liquidation loop: base → lasna → uni → lasna → base, one hop per row band.
const HOPS: [number, number][] = [[0, 1], [1, 2], [2, 1], [1, 0]];

export function AsciiField({ className }: { className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    const still = reducedMotion();
    let cw = 9, ch = 16, w = 0, h = 0, cols = 0, rows = 0, raf = 0, visible = true, last = 0;
    const mouse = { x: -999, y: -999 };

    const resize = () => {
      const r = cv.getBoundingClientRect();
      const dpr = Math.min(devicePixelRatio || 1, 2);
      w = r.width; h = r.height;
      cw = w < 700 ? 11 : 9; ch = w < 700 ? 19 : 16;
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      cols = Math.ceil(w / cw); rows = Math.ceil(h / ch);
      ctx.font = `12px "JetBrains Mono", ui-monospace, monospace`;
      ctx.textBaseline = "top";
    };

    const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      if (!visible || now - last < 40) return; // ~25 fps
      last = now;
      const t = still ? 6 : now / 1000;
      ctx.clearRect(0, 0, w, h);
      const railCol = RAIL_X.map((f) => Math.round(f * cols));

      for (let y = 0; y < rows; y++) {
        const ny = y / rows;
        for (let x = 0; x < cols; x++) {
          const nx = x / cols;
          // Slow interference of sines: a soft halftone landscape, strongest on the right.
          let v = 0.5 + 0.26 * Math.sin(nx * 9 + t * 0.55) + 0.16 * Math.sin(ny * 12 - t * 0.4 + nx * 4) + 0.1 * Math.sin((nx + ny) * 18 + t * 0.8);
          v = (v - 0.32) * smooth(0.3, 0.85, nx) * (0.55 + 0.45 * smooth(0, 0.35, ny)) * (1 - 0.7 * smooth(0.82, 1, ny));
          const dx = x * cw - mouse.x, dy = y * ch - mouse.y;
          v += 0.5 * Math.exp(-(dx * dx + dy * dy) / 5200);

          let rail = -1;
          for (let k = 0; k < 3; k++) if (x === railCol[k]) rail = k;
          if (rail >= 0) {
            const pulse = 0.5 + 0.5 * Math.sin(y * 0.4 - t * 2.4 + rail * 2);
            ctx.fillStyle = `rgba(${RAIL_RGB[rail].join(",")},${0.16 + 0.34 * pulse})`;
            ctx.fillText(pulse > 0.8 ? "┃" : "│", x * cw, y * ch);
            continue;
          }
          if (v < 0.1) continue;
          const i = Math.min(RAMP.length - 1, Math.floor(v * (RAMP.length - 1)));
          ctx.fillStyle = `rgba(245,245,247,${0.07 + Math.min(0.55, v * 0.55)})`;
          ctx.fillText(RAMP[i], x * cw, y * ch);
        }
      }

      // Packets: the real liquidation loop, one hop at a time, row by row.
      const cycle = (t % 10) / 10;
      const band = rows * 0.5 / HOPS.length;
      HOPS.forEach(([a, b], i) => {
        const p = (cycle - i * 0.2) / 0.16;
        if (p < 0 || p > 1.6) return;
        const row = Math.round(rows * 0.2 + i * band);
        const x0 = railCol[a], x1 = railCol[b], dir = Math.sign(x1 - x0);
        const head = x0 + (x1 - x0) * Math.min(1, p);
        const [r, g, bl] = RAIL_RGB[b];
        for (let s = 0; s < 14; s++) {
          const cx = Math.round(head - dir * s);
          if ((cx - x0) * dir < 0 || (cx - x1) * dir > 0) continue;
          const fade = (1 - s / 14) * (p > 1 ? Math.max(0, 1 - (p - 1) / 0.6) : 1);
          ctx.fillStyle = `rgba(${r},${g},${bl},${0.9 * fade})`;
          ctx.fillText(s === 0 ? (dir > 0 ? ">" : "<") : "-", cx * cw, row * ch);
        }
      });
    };

    const onMove = (e: PointerEvent) => { const r = cv.getBoundingClientRect(); mouse.x = e.clientX - r.left; mouse.y = e.clientY - r.top; };
    const onLeave = () => { mouse.x = mouse.y = -999; };
    resize();
    raf = requestAnimationFrame(frame);
    const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; }, { threshold: 0 });
    io.observe(cv);
    const ro = new ResizeObserver(resize);
    ro.observe(cv);
    window.addEventListener("pointermove", onMove, { passive: true });
    document.addEventListener("pointerleave", onLeave);
    document.fonts?.ready.then(resize);
    return () => { cancelAnimationFrame(raf); io.disconnect(); ro.disconnect(); window.removeEventListener("pointermove", onMove); document.removeEventListener("pointerleave", onLeave); };
  }, []);
  return <canvas ref={ref} className={className} aria-hidden="true" />;
}

/* ------------------------------------------------------------------ number that flashes when it changes (block heights) */

export function Tick({ value, className }: { value: string; className?: string }) {
  return <span key={value} className={`tick ${className ?? ""}`}>{value}</span>;
}

/* ------------------------------------------------------------------ three-lane trace */

export const fmtMs = (ms?: number) => (ms === undefined ? "" : ms === 0 ? "0.0s" : `+${(ms / 1000).toFixed(1)}s`);
const COLOR: Record<Lane, string> = { base: "var(--base)", lasna: "var(--lasna)", uni: "var(--uni)" };

/** One loop as a ledger: each step sits in its chain's column, with a hop drawn from the previous step. */
export function LoopTrace({ steps, link = true }: { steps: Step[]; link?: boolean }) {
  return (
    <div className="trace">
      <div className="trace-head">
        <div>Time</div>
        {LANES.map((l) => <div key={l} className={`lane-${l}`}><i className="dot" />{LANE_SHORT[l]}</div>)}
      </div>
      <div className="trace-body">
        <div className="lanes-bg"><div /><div /><div /></div>
        {steps.map((s, i) => {
          const prev = steps[i - 1];
          const col = LANES.indexOf(s.lane);
          const pcol = prev ? LANES.indexOf(prev.lane) : col;
          const lo = Math.min(col, pcol), hi = Math.max(col, pcol);
          const content = (<><b>{s.label}</b><span>{s.detail}</span>{s.hash && link && <Ext />}</>);
          return (
            <div className="trace-row" key={`${i}-${s.label}`}>
              <div className={`t ${s.status === "wait" ? "dim" : ""}`}>{s.status === "wait" ? "…" : s.status === "fail" ? "—" : fmtMs(s.ms)}</div>
              {prev && hi > lo && s.status !== "wait" && (
                <div
                  className={`hop ${col < pcol ? "rev" : ""}`}
                  style={{
                    left: `calc(var(--tc) + 8px + (100% - var(--tc) - 8px) * ${lo / 3} + (100% - var(--tc) - 8px) / 6)`,
                    width: `calc((100% - var(--tc) - 8px) * ${(hi - lo) / 3})`,
                    ["--from" as string]: COLOR[col < pcol ? s.lane : prev.lane],
                    ["--to" as string]: COLOR[col < pcol ? prev.lane : s.lane],
                  }}
                />
              )}
              {LANES.map((l, j) =>
                j !== col ? <div key={l} /> : s.hash && link ? (
                  <a key={l} className={`node lane-${l} ${s.status}`} href={txUrl(l, s.hash)} target="_blank" rel="noreferrer" title={`${LANE_NAME[l]} · ${s.hash}`}>{content}</a>
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

export function CopyBtn({ text, label = "copy" }: { text: string; label?: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button type="button" className="copy" onClick={() => { navigator.clipboard?.writeText(text).then(() => { setOk(true); setTimeout(() => setOk(false), 1400); }).catch(() => {}); }} aria-label={`Copy ${text}`}>
      {ok ? "copied" : label}
    </button>
  );
}

/* ------------------------------------------------------------------ small helpers for the console */

/** A "?" that explains a term on hover or keyboard focus. Plain text only. */
export function Hint({ text }: { text: string }) {
  return (
    <span className="hint" tabIndex={0} role="note" aria-label={text}>
      <i aria-hidden="true">?</i>
      <span className="hint-pop" role="tooltip">{text}</span>
    </span>
  );
}

/** Light by default in the console, dark on request. The landing page keeps the dark look: the attribute is removed on leaving. */
export function useTheme() {
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    try { return localStorage.getItem("tandem:theme") === "dark" ? "dark" : "light"; } catch { return "light"; }
  });
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem("tandem:theme", theme); } catch { /* storage unavailable */ }
  }, [theme]);
  useLayoutEffect(() => () => { delete document.documentElement.dataset.theme; }, []);
  return { theme, toggle: () => setTheme((t) => (t === "light" ? "dark" : "light")) };
}

export function ThemeToggle({ theme, onToggle }: { theme: "light" | "dark"; onToggle: () => void }) {
  return (
    <button type="button" className="icon-btn" onClick={onToggle} aria-label={theme === "light" ? "Switch to the dark theme" : "Switch to the light theme"} title={theme === "light" ? "Dark theme" : "Light theme"}>
      {theme === "light" ? (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" /></svg>
      ) : (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>
      )}
    </button>
  );
}

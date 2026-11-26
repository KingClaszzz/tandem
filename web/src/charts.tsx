import { useEffect, useMemo, useRef, useState } from "react";
import type { Bin } from "./stats";
import { ago, usd } from "./format";

export type Point = { t: number; p: number };
export type Level = { p: number; label: string };

/** Price history with a dashed line at every open loan's liquidation price. Hover for the value. */
export function PriceTape({ points, levels, height = 240 }: { points: Point[]; levels: Level[]; height?: number }) {
  const [hover, setHover] = useState<number>();
  const box = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(760);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const padL = 62, padR = W < 520 ? 12 : 84, padT = 14, padB = 26;
  const view = useMemo(() => {
    if (!points.length) return undefined;
    const t0 = points[0].t, t1 = Math.max(points[points.length - 1].t, t0 + 60_000);
    const ps = points.map((q) => q.p);
    let lo = Math.min(...ps), hi = Math.max(...ps);
    // Include only the liquidation levels that are close enough to matter, so one far-off loan can't flatten the line.
    const shown = levels.filter((l) => l.p > lo * 0.6 && l.p < hi * 1.4);
    for (const l of shown) { lo = Math.min(lo, l.p); hi = Math.max(hi, l.p); }
    const pad = Math.max((hi - lo) * 0.12, hi * 0.01);
    lo -= pad; hi += pad;
    const x = (t: number) => padL + ((t - t0) / (t1 - t0)) * (W - padL - padR);
    const y = (p: number) => padT + (1 - (p - lo) / (hi - lo)) * (height - padT - padB);
    return { t0, t1, lo, hi, x, y, shown };
  }, [points, levels, height, W, padR]);

  if (!view || points.length < 2) {
    return <div ref={box} className="chart-empty" style={{ height }}>{points.length ? "One price so far. The chart fills in as the feed is updated." : "No price updates seen yet."}</div>;
  }
  const { x, y, lo, hi, t0, t1, shown } = view;
  // A stepped line: the price holds until the next update.
  const path = points.map((q, i) => `${i ? `H${x(q.t).toFixed(1)}V` : "M"}${i ? "" : x(q.t).toFixed(1) + " "}${y(q.p).toFixed(1)}`).join("");
  const area = `${path}H${x(t1).toFixed(1)}V${height - padB}H${x(t0).toFixed(1)}Z`;
  const last = points[points.length - 1];
  const ticks = [0, 1, 2, 3].map((i) => lo + ((hi - lo) * i) / 3);
  const h = hover !== undefined ? points[hover] : undefined;

  return (
    <div ref={box} className="tape-box">
    <svg
      viewBox={`0 0 ${W} ${height}`} width={W} height={height} className="tape" role="img" aria-label={`ETH price history, latest ${usd(last.p, 2)}`}
      onPointerMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        const tx = t0 + (((e.clientX - r.left) / r.width) * W - padL) / (W - padL - padR) * (t1 - t0);
        let best = 0;
        points.forEach((q, i) => { if (Math.abs(q.t - tx) < Math.abs(points[best].t - tx)) best = i; });
        setHover(best);
      }}
      onPointerLeave={() => setHover(undefined)}
    >
      {ticks.map((v) => (
        <g key={v}>
          <line x1={padL} x2={W - padR} y1={y(v)} y2={y(v)} className="grid" />
          <text x={padL - 10} y={y(v) + 4} textAnchor="end" className="axis">{usd(v)}</text>
        </g>
      ))}
      <text x={padL} y={height - 6} className="axis">{ago(t0, t1).replace(" ago", "")} earlier</text>
      <text x={W - padR} y={height - 6} textAnchor="end" className="axis">latest</text>
      <path d={area} className="area" />
      <path d={path} className="line" />
      {shown.map((l) => (
        <g key={l.label + l.p}>
          <line x1={padL} x2={W - padR} y1={y(l.p)} y2={y(l.p)} className="level" />
          <text x={W - padR + 8} y={y(l.p) + 4} className="level-label">{l.label}</text>
        </g>
      ))}
      <circle cx={x(last.t)} cy={y(last.p)} r="4" className="now-dot" />
      {h && (
        <g>
          <line x1={x(h.t)} x2={x(h.t)} y1={padT} y2={height - padB} className="cross" />
          <circle cx={x(h.t)} cy={y(h.p)} r="4" className="cross-dot" />
          <text x={Math.min(x(h.t) + 10, W - padR - 150)} y={padT + 14} className="tip">{usd(h.p, 2)} · {ago(h.t, t1) === "just now" ? "latest" : ago(h.t, t1).replace(" ago", " before latest")}</text>
        </g>
      )}
    </svg>
    </div>
  );
}

export function Bars({ bins }: { bins: Bin[] }) {
  const max = Math.max(1, ...bins.map((b) => b.count));
  return (
    <div className="bars" role="img" aria-label="Open loans by loan-to-value">
      {bins.map((b) => (
        <div key={b.label} className={`bar-col ${b.tone}`}>
          <span className="bar-n num">{b.count || ""}</span>
          <i style={{ height: `${Math.max(b.count ? 6 : 2, (b.count / max) * 100)}%` }} />
          <span className="bar-l num">{b.label}</span>
        </div>
      ))}
    </div>
  );
}

export function Split({ parts }: { parts: { label: string; value: number; color: string }[] }) {
  const total = parts.reduce((a, p) => a + p.value, 0) || 1;
  return (
    <div className="split-bar">
      <div className="split-track" role="img" aria-label={parts.map((p) => `${p.label} ${((p.value / total) * 100).toFixed(1)}%`).join(", ")}>
        {parts.map((p) => <i key={p.label} style={{ width: `${(p.value / total) * 100}%`, background: p.color }} />)}
      </div>
      <div className="split-legend">
        {parts.map((p) => <span key={p.label}><i style={{ background: p.color }} />{p.label}</span>)}
      </div>
    </div>
  );
}

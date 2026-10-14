import type { ReactNode } from "react";

/**
 * Small accessible charts drawn in SVG/HTML. Each one has a visually hidden data table so screen-reader users get
 * the same numbers, and none relies on colour alone (forecast and estimate bars are hatched and labelled).
 */

export type BarDatum = { label: string; value: number; extra?: number; hatched?: boolean; note?: string };

const W = 560;
const H = 160;
const PAD = { l: 8, r: 8, t: 10, b: 26 };

function Hatch() {
  return (
    <defs>
      <pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <rect width="6" height="6" fill="var(--color-brand-100)" />
        <line x1="0" y1="0" x2="0" y2="6" stroke="var(--color-brand-500)" strokeWidth="2" />
      </pattern>
    </defs>
  );
}

/** Vertical bars. `extra` stacks a second (lighter) segment on top, used for estimates over posted revenue. */
export function Bars({ title, data, format = (n) => String(n), max, caption }: { title: string; data: BarDatum[]; format?: (n: number) => string; max?: number; caption?: ReactNode }) {
  const top = max ?? Math.max(1, ...data.map((d) => d.value + (d.extra ?? 0)));
  const bw = (W - PAD.l - PAD.r) / Math.max(1, data.length);
  const plotH = H - PAD.t - PAD.b;
  return (
    <figure>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={title} className="h-auto w-full">
        <Hatch />
        <line x1={PAD.l} x2={W - PAD.r} y1={H - PAD.b} y2={H - PAD.b} stroke="var(--color-slate-300)" />
        {data.map((d, i) => {
          const x = PAD.l + i * bw + bw * 0.15;
          const w = bw * 0.7;
          const h1 = (d.value / top) * plotH;
          const h2 = ((d.extra ?? 0) / top) * plotH;
          return (
            <g key={d.label}>
              <rect x={x} y={H - PAD.b - h1} width={w} height={h1} rx={2} fill={d.hatched ? "url(#hatch)" : "var(--color-brand-600)"} stroke={d.hatched ? "var(--color-brand-500)" : "none"} />
              {h2 > 0 && <rect x={x} y={H - PAD.b - h1 - h2} width={w} height={h2} rx={2} fill="url(#hatch)" stroke="var(--color-brand-500)" />}
              <text x={x + w / 2} y={H - PAD.b - h1 - h2 - 3} textAnchor="middle" fontSize="9" fill="var(--color-slate-700)">{format(d.value + (d.extra ?? 0))}</text>
              <text x={x + w / 2} y={H - 10} textAnchor="middle" fontSize="9" fill="var(--color-slate-600)">{d.label}</text>
            </g>
          );
        })}
      </svg>
      {caption && <figcaption className="mt-1 text-xs text-slate-600">{caption}</figcaption>}
      <table className="sr-only">
        <caption>{title}</caption>
        <thead><tr><th>Item</th><th>Value</th><th>Note</th></tr></thead>
        <tbody>{data.map((d) => <tr key={d.label}><td>{d.label}</td><td>{format(d.value + (d.extra ?? 0))}</td><td>{d.note ?? (d.hatched ? "Estimate" : "")}</td></tr>)}</tbody>
      </table>
    </figure>
  );
}

/** Two series side by side for each label (for example arrivals and departures). */
export function GroupedBars({ title, labels, a, b, aName, bName }: { title: string; labels: string[]; a: number[]; b: number[]; aName: string; bName: string }) {
  const top = Math.max(1, ...a, ...b);
  const bw = (W - PAD.l - PAD.r) / Math.max(1, labels.length);
  const plotH = H - PAD.t - PAD.b;
  return (
    <figure>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={title} className="h-auto w-full">
        <line x1={PAD.l} x2={W - PAD.r} y1={H - PAD.b} y2={H - PAD.b} stroke="var(--color-slate-300)" />
        {labels.map((l, i) => {
          const x = PAD.l + i * bw + bw * 0.1;
          const w = bw * 0.38;
          const ha = (a[i] / top) * plotH;
          const hb = (b[i] / top) * plotH;
          return (
            <g key={l}>
              <rect x={x} y={H - PAD.b - ha} width={w} height={ha} rx={2} fill="var(--color-brand-600)" />
              <rect x={x + w + 2} y={H - PAD.b - hb} width={w} height={hb} rx={2} fill="var(--color-gold-500)" />
              <text x={x + w / 2} y={H - PAD.b - ha - 3} textAnchor="middle" fontSize="9" fill="var(--color-slate-700)">{a[i]}</text>
              <text x={x + w * 1.5 + 2} y={H - PAD.b - hb - 3} textAnchor="middle" fontSize="9" fill="var(--color-slate-700)">{b[i]}</text>
              <text x={x + w + 1} y={H - 10} textAnchor="middle" fontSize="9" fill="var(--color-slate-600)">{l}</text>
            </g>
          );
        })}
      </svg>
      <figcaption className="mt-1 flex gap-4 text-xs text-slate-700">
        <span className="flex items-center gap-1"><span aria-hidden className="h-2.5 w-2.5 rounded-sm bg-brand-600" />{aName}</span>
        <span className="flex items-center gap-1"><span aria-hidden className="h-2.5 w-2.5 rounded-sm bg-gold-500" />{bName}</span>
      </figcaption>
      <table className="sr-only">
        <caption>{title}</caption>
        <thead><tr><th>Date</th><th>{aName}</th><th>{bName}</th></tr></thead>
        <tbody>{labels.map((l, i) => <tr key={l}><td>{l}</td><td>{a[i]}</td><td>{b[i]}</td></tr>)}</tbody>
      </table>
    </figure>
  );
}

/** Horizontal percentage bars: occupancy by floor or category, booking sources. */
export function HBars({ title, rows, suffix = "%" }: { title: string; rows: { label: string; value: number; detail?: string }[]; suffix?: string }) {
  const top = Math.max(1, ...rows.map((r) => r.value));
  return (
    <figure>
      <ul aria-label={title} className="space-y-2">
        {rows.map((r) => (
          <li key={r.label}>
            <div className="flex items-baseline justify-between gap-2 text-xs"><span className="truncate font-medium text-slate-800">{r.label}</span><span className="tabular-nums text-slate-600">{r.detail ?? `${r.value}${suffix}`}</span></div>
            <div className="mt-0.5 h-2 rounded-full bg-slate-200"><div className="h-full rounded-full bg-brand-600" style={{ width: `${Math.min(100, (r.value / top) * 100)}%` }} /></div>
          </li>
        ))}
      </ul>
    </figure>
  );
}

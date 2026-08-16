"use client";

// Hand-rolled SVG charts. Small on purpose: two series at most (Main and
// Branch), gaps rendered as gaps (edge case 24 — a missing month must not
// be interpolated across), tabular-nums everywhere.
//
// Colour note: the brand's slate/plum pair is close under red-green colour
// blindness (validated ΔE ≈ 3), and the spec's tokens are fixed. So colour
// is never the only encoding: the second series is dashed and every series
// is direct-labelled at its end, with a legend above.

import { useEffect, useMemo, useRef, useState } from "react";
import { formatCentavos } from "@/lib/money";

export interface SeriesPoint {
  label: string; // x label, e.g. "2026-03" or "2026-08-01"
  value: number | null; // null = gap, drawn as a break in the line
}

export interface Series {
  name: string;
  color: string;
  dashed?: boolean;
  points: SeriesPoint[];
}

const M = { top: 8, right: 72, bottom: 20, left: 56 };

export function LineChart({ series, height = 200, money = true }: {
  series: Series[];
  height?: number;
  money?: boolean;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  // The viewBox tracks the container's real pixel width, so text renders
  // at its stated size everywhere — a full-width chart and a half-width
  // tile used to scale the same 9px label to very different sizes.
  const [width, setWidth] = useState(640);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => setWidth(Math.max(320, el.clientWidth));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const labels = series[0]?.points.map((p) => p.label) ?? [];
  const n = labels.length;

  const max = useMemo(() => {
    let m = 0;
    for (const s of series) for (const p of s.points) if (p.value != null) m = Math.max(m, p.value);
    return m || 1;
  }, [series]);

  const x = (i: number) => M.left + (n <= 1 ? 0 : (i * (width - M.left - M.right)) / (n - 1));
  const y = (v: number) => M.top + (1 - v / max) * (height - M.top - M.bottom);

  // Build path segments, breaking at nulls so gaps stay gaps.
  function segments(points: SeriesPoint[]): string[] {
    const segs: string[] = [];
    let d = "";
    points.forEach((p, i) => {
      if (p.value == null) {
        if (d) segs.push(d);
        d = "";
        return;
      }
      d += `${d === "" ? "M" : "L"}${x(i).toFixed(1)},${y(p.value).toFixed(1)} `;
    });
    if (d) segs.push(d);
    return segs;
  }

  const gridLines = 4;
  const fmt = (v: number) => (money ? formatCentavos(v) : v.toLocaleString());
  const fmtShort = (v: number) =>
    money ? `₱${Math.round(v / 100 / 1000)}k` : v.toLocaleString();

  function onMove(e: React.MouseEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * width;
    if (n === 0) return;
    const i = Math.round(((px - M.left) / (width - M.left - M.right)) * (n - 1));
    setHover(i >= 0 && i < n ? i : null);
  }

  return (
    <div ref={wrapRef} className="relative">
      {series.length > 1 && (
        <div className="mb-2 flex gap-4 text-[11px] text-text-muted">
          {series.map((s) => (
            <span key={s.name} className="flex items-center gap-1">
              <svg width="16" height="6" aria-hidden>
                <line
                  x1="0" y1="3" x2="16" y2="3"
                  stroke={s.color} strokeWidth="2"
                  strokeDasharray={s.dashed ? "4 3" : undefined}
                />
              </svg>
              {s.name}
            </span>
          ))}
        </div>
      )}

      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full"
        role="img"
        aria-label={series.map((s) => s.name).join(", ")}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        {/* grid */}
        {Array.from({ length: gridLines + 1 }, (_, i) => {
          const v = (max / gridLines) * i;
          return (
            <g key={i}>
              <line
                x1={M.left} x2={width - M.right} y1={y(v)} y2={y(v)}
                stroke="var(--color-border)" strokeWidth="1"
              />
              <text
                x={M.left - 8} y={y(v) + 3}
                textAnchor="end" fontSize="10"
                fill="var(--color-text-muted)"
                style={{ fontVariantNumeric: "tabular-nums" }}
              >
                {fmtShort(v)}
              </text>
            </g>
          );
        })}

        {/* x labels: first, last, and a few between */}
        {labels.map((l, i) => {
          const step = Math.max(1, Math.ceil(n / 6));
          if (i % step !== 0 && i !== n - 1) return null;
          return (
            <text
              key={l} x={x(i)} y={height - 4}
              textAnchor="middle" fontSize="10"
              fill="var(--color-text-muted)"
              style={{ fontVariantNumeric: "tabular-nums" }}
            >
              {l.length > 7 ? l.slice(5) : l}
            </text>
          );
        })}

        {/* series */}
        {series.map((s) => (
          <g key={s.name}>
            {segments(s.points).map((d, i) => (
              <path
                key={i} d={d} fill="none"
                stroke={s.color} strokeWidth="2"
                strokeDasharray={s.dashed ? "4 3" : undefined}
                strokeLinecap="round"
              />
            ))}
            {/* lone points (a value with gaps both sides) need a dot */}
            {s.points.map((p, i) => {
              if (p.value == null) return null;
              const prev = i > 0 ? s.points[i - 1].value : null;
              const next = i < n - 1 ? s.points[i + 1].value : null;
              if (prev != null || next != null) return null;
              return <circle key={i} cx={x(i)} cy={y(p.value)} r="2.5" fill={s.color} />;
            })}
            {/* direct label at last real point (secondary encoding) */}
            {(() => {
              for (let i = n - 1; i >= 0; i--) {
                const v = s.points[i]?.value;
                if (v != null) {
                  return (
                    <text
                      x={x(i) + 6} y={y(v) + 3}
                      fontSize="10" fontWeight="700" fill={s.color}
                    >
                      {s.name}
                    </text>
                  );
                }
              }
              return null;
            })()}
          </g>
        ))}

        {/* hover crosshair */}
        {hover != null && (
          <line
            x1={x(hover)} x2={x(hover)} y1={M.top} y2={height - M.bottom}
            stroke="var(--color-text-muted)" strokeWidth="1" strokeDasharray="2 2"
          />
        )}
        {hover != null &&
          series.map((s) => {
            const v = s.points[hover]?.value;
            if (v == null) return null;
            return (
              <circle
                key={s.name} cx={x(hover)} cy={y(v)} r="3.5"
                fill={s.color} stroke="var(--color-surface-card)" strokeWidth="2"
              />
            );
          })}
      </svg>

      {hover != null && (
        <div
          className="pointer-events-none absolute top-0 rounded-[4px] border border-border bg-surface-card p-2 text-[11px] shadow-overlay"
          style={{
            left: `${((x(hover) / width) * 100).toFixed(1)}%`,
            transform: x(hover) > width / 2 ? "translateX(-105%)" : "translateX(8px)",
          }}
        >
          <div className="font-bold">{labels[hover]}</div>
          {series.map((s) => (
            <div key={s.name} className="tnum flex items-center gap-2">
              <span
                aria-hidden
                className="inline-block h-2 w-2 rounded-full"
                style={{ background: s.color }}
              />
              {s.name}:{" "}
              {s.points[hover]?.value == null ? "no data" : fmt(s.points[hover].value!)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Horizontal comparison bars (service revenue, payment mix, ...)
// ---------------------------------------------------------------------------

export function BarList({ items, money = true }: {
  items: Array<{ label: string; value: number; sub?: string; color?: string }>;
  money?: boolean;
}) {
  const max = Math.max(...items.map((i) => i.value), 1);
  return (
    <div className="space-y-2">
      {items.map((item) => (
        <div key={item.label} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4">
          <div>
            <div className="mb-1 flex items-baseline justify-between gap-2 text-[13px]">
              <span className="truncate" title={item.label}>{item.label}</span>
              {item.sub && <span className="shrink-0 text-[11px] text-text-muted">{item.sub}</span>}
            </div>
            <div className="h-2 w-full rounded-[4px] bg-surface-page">
              <div
                className="h-2 rounded-[4px]"
                style={{
                  width: `${((item.value / max) * 100).toFixed(1)}%`,
                  background: item.color ?? "var(--color-ink)",
                  minWidth: item.value > 0 ? "2px" : 0,
                }}
              />
            </div>
          </div>
          <span className="tnum text-[13px] font-bold">
            {money ? formatCentavos(item.value) : item.value.toLocaleString()}
          </span>
        </div>
      ))}
    </div>
  );
}

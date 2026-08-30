"use client";

// A date field that ALWAYS displays MM/DD/YYYY, regardless of the device
// locale. Native <input type="date"> renders in the browser's own
// convention — on tablets set to other locales that comes out DD/MM/YYYY
// and quietly mixes conventions across devices. Here the visible field is
// text in the Philippine convention (lenient: 8/30/2026 and pasted ISO
// both accepted), and the calendar button overlays an invisible native
// input so the familiar picker still opens. The value in and out of this
// component stays ISO, exactly like the native input it replaces.

import { useEffect, useRef, useState } from "react";
import { Calendar } from "lucide-react";
import { Input } from "@/components/ui";
import { fmtDate } from "@/lib/dates";

function parseMDY(text: string): string | null {
  const t = text.trim();
  let y: number, mo: number, d: number;
  const mdy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (mdy) { mo = +mdy[1]; d = +mdy[2]; y = +mdy[3]; }
  else if (iso) { y = +iso[1]; mo = +iso[2]; d = +iso[3]; }
  else return null;
  const dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) {
    return null; // e.g. 02/30/2026
  }
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function DateInput({ value, onChange, min, max, className = "w-40", "aria-label": ariaLabel }: {
  /** ISO date ("2026-08-30") or "" for empty. */
  value: string;
  /** Fires with an ISO date on every valid commit (blur, Enter, calendar pick). */
  onChange: (iso: string) => void;
  min?: string;
  max?: string;
  /** Width classes for the whole field (default w-40). */
  className?: string;
  "aria-label"?: string;
}) {
  const [text, setText] = useState(value ? fmtDate(value) : "");
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(value ? fmtDate(value) : "");
  }, [value]);

  function commit() {
    const iso = parseMDY(text);
    if (iso && (!min || iso >= min) && (!max || iso <= max)) {
      onChange(iso);
      setText(fmtDate(iso));
    } else {
      // Invalid or out of range: snap back to the last good value.
      setText(value ? fmtDate(value) : "");
    }
  }

  return (
    <span className={`relative inline-flex ${className}`}>
      <Input
        value={text}
        inputMode="numeric"
        placeholder="MM/DD/YYYY"
        aria-label={ariaLabel}
        className="w-full pr-8 tnum"
        onFocus={() => { focused.current = true; }}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => { focused.current = false; commit(); }}
        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
      />
      <span className="absolute inset-y-0 right-0 flex w-8 items-center justify-center text-text-muted">
        <Calendar size={14} aria-hidden />
        {/* Invisible native input over the icon: tapping it opens the
            device's calendar; its VALUE is never displayed, so the
            browser's own date format never leaks into the UI. */}
        <input
          type="date"
          tabIndex={-1}
          aria-label={ariaLabel ? `${ariaLabel} — calendar` : "Open calendar"}
          className="absolute inset-0 cursor-pointer opacity-0"
          value={value || ""}
          min={min}
          max={max}
          onClick={(e) => (e.target as HTMLInputElement).showPicker?.()}
          onChange={(e) => {
            if (e.target.value) {
              onChange(e.target.value);
              setText(fmtDate(e.target.value));
            }
          }}
        />
      </span>
    </span>
  );
}

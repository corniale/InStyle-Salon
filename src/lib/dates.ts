// Display dates in the Philippine convention, MM/DD/YYYY, everywhere a
// person reads them. Data stays ISO (YYYY-MM-DD) in the database, in query
// parameters, in <input type="date"> values, and in file names — only the
// rendered text changes.

/** "2026-08-30" (or an ISO timestamp) → "08/30/2026"; null-safe. */
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[2]}/${m[3]}/${m[1]}` : iso;
}

/** "2026-08-30" → "8/30" — compact month/day for tight headers. */
export function fmtMonthDay(iso: string): string {
  const m = /^\d{4}-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${Number(m[1])}/${Number(m[2])}` : iso;
}

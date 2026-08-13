// Money is integer centavos end to end (spec §6). These helpers are the only
// place pesos and centavos convert, and parsing never touches floating point:
// the peso string is split on the decimal point and both halves stay integers.

export function formatCentavos(
  cents: number | null | undefined,
  forceCentavos = false,
): string {
  if (cents == null) return "—";
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const pesos = Math.floor(abs / 100);
  const rem = Math.round(abs % 100);
  const body =
    rem === 0 && !forceCentavos
      ? pesos.toLocaleString("en-PH")
      : `${pesos.toLocaleString("en-PH")}.${String(rem).padStart(2, "0")}`;
  return `${negative ? "−" : ""}₱${body}`;
}

/** "1,234.50" -> 123450. Returns null for anything that is not money. */
export function parsePesos(input: string): number | null {
  const cleaned = input.replace(/[₱,\s]/g, "");
  if (cleaned === "" || cleaned === "-") return null;
  const m = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!m) return null;
  const sign = m[1] ? -1 : 1;
  const pesos = parseInt(m[2], 10);
  const centavos = m[3] ? parseInt(m[3].padEnd(2, "0"), 10) : 0;
  return sign * (pesos * 100 + centavos);
}

export function formatPct(value: number | null | undefined, digits = 1): string {
  if (value == null) return "—";
  return `${Number(value).toFixed(digits)}%`;
}

export function formatCount(value: number | null | undefined): string {
  if (value == null) return "—";
  return Number(value).toLocaleString("en-PH");
}

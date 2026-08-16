// CSV download helper shared by the export buttons. Excel-friendly: BOM,
// CRLF, quotes only where needed. Money is written in pesos with two
// decimals — spreadsheets should not have to know about centavos.

export function csvCell(v: string | number | boolean | null | undefined): string {
  if (v == null) return "";
  const t = String(v);
  return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}

export function csvPesos(cents: number | null | undefined): string {
  return cents == null ? "" : (cents / 100).toFixed(2);
}

export function downloadCsv(
  filename: string,
  header: string[],
  rows: (string | number | boolean | null | undefined)[][],
) {
  const body = [header.join(","), ...rows.map((r) => r.map(csvCell).join(","))].join("\r\n");
  const blob = new Blob(["﻿" + body], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

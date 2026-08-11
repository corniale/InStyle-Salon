// The anon-key probe (spec §8.3, §12). Run before every release and paste
// the output into the release notes. A table that returns rows to anon is a
// release blocker.
//
//   NEXT_PUBLIC_SUPABASE_URL=... NEXT_PUBLIC_SUPABASE_ANON_KEY=... \
//   node scripts/anon-probe.mjs

import { readFileSync } from "node:fs";

// Fall back to .env.local so the probe runs with the same values as the app.
function envOrDotfile(name) {
  if (process.env[name]) return process.env[name];
  try {
    const line = readFileSync(".env.local", "utf8")
      .split("\n")
      .find((l) => l.startsWith(`${name}=`));
    return line?.slice(name.length + 1).trim();
  } catch {
    return undefined;
  }
}

const url = envOrDotfile("NEXT_PUBLIC_SUPABASE_URL");
const anon = envOrDotfile("NEXT_PUBLIC_SUPABASE_ANON_KEY");
if (!url || !anon) {
  console.error(
    "Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY, or run from the project root where .env.local lives.",
  );
  process.exit(1);
}

const TABLES = [
  "branches", "profiles", "technicians", "service_types", "services",
  "branch_service_prices", "clients", "tickets", "ticket_lines",
  "ticket_payments", "packages", "package_sessions", "expenses",
  "cash_days", "shift_blocks", "audit_log", "series_counters",
  "v_ticket_lines_active", "v_client_visits", "v_client_retention",
  "v_service_margin", "v_technician_performance", "v_daily_cash",
];

let blocked = 0, leaks = 0;

console.log(`Anon-key probe against ${url}\n`);

for (const table of TABLES) {
  const res = await fetch(`${url}/rest/v1/${table}?select=*&limit=5`, {
    headers: { apikey: anon, Authorization: `Bearer ${anon}` },
  });
  const body = await res.text();

  let verdict;
  if (res.ok) {
    let rows;
    try { rows = JSON.parse(body); } catch { rows = null; }
    if (Array.isArray(rows) && rows.length === 0) {
      // 200 with zero rows is correct: RLS filtered everything (spec §8.3).
      verdict = "OK    (200, empty array)";
      blocked++;
    } else {
      verdict = `LEAK  (200, ${Array.isArray(rows) ? rows.length + " rows" : "non-array body"})`;
      leaks++;
    }
  } else {
    // 401/403/404: no grant at all — also correct.
    verdict = `OK    (${res.status})`;
    blocked++;
  }
  console.log(`  ${table.padEnd(26)} ${verdict}`);
}

// Write probe: an anonymous insert must fail.
const writeRes = await fetch(`${url}/rest/v1/clients`, {
  method: "POST",
  headers: { apikey: anon, Authorization: `Bearer ${anon}`, "Content-Type": "application/json" },
  body: JSON.stringify({ phone: "09170000000", full_name: "probe" }),
});
if (writeRes.ok) {
  console.log(`\n  INSERT clients            LEAK  (${writeRes.status})`);
  leaks++;
} else {
  console.log(`\n  INSERT clients            OK    (${writeRes.status}, rejected)`);
}

console.log(`\n${leaks === 0 ? "PASS" : "FAIL"} — ${blocked} surfaces closed, ${leaks} leaking.`);
process.exit(leaks === 0 ? 0 : 1);

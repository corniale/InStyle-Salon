// History import: CSV -> create_ticket RPC, idempotent by content hash.
// Server-side only; requires the service-role key in the environment.
// See scripts/import/README.md for the format.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}

const args = process.argv.slice(2);
const branchFlag = args.indexOf("--branch");
const branchCode = branchFlag >= 0 ? args[branchFlag + 1] : null;
const file = args.filter((a, i) => i !== branchFlag && i !== branchFlag + 1)[0];
if (!branchCode || !file) {
  console.error("Usage: node import.mjs --branch MAIN|BRANCH file.csv");
  process.exit(1);
}

const supabase = createClient(url, key, { auth: { persistSession: false } });

// ---------------------------------------------------------------------------
// CSV parsing — small and strict; quoted fields supported
// ---------------------------------------------------------------------------

function parseCsv(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); if (row.some((f) => f !== "")) rows.push(row); }
  return rows;
}

/** Pesos string -> integer centavos without floating point. */
function pesosToCents(s) {
  const cleaned = String(s ?? "").replace(/[₱,\s]/g, "");
  if (cleaned === "") return 0;
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!m) return null;
  return parseInt(m[1], 10) * 100 + (m[2] ? parseInt(m[2].padEnd(2, "0"), 10) : 0);
}

// ---------------------------------------------------------------------------

const [header, ...lines] = parseCsv(readFileSync(file, "utf8"));
const col = Object.fromEntries(header.map((h, i) => [h.trim().toLowerCase(), i]));
for (const required of ["date", "service", "technician", "qty", "price"]) {
  if (!(required in col)) {
    console.error(`CSV is missing the "${required}" column.`);
    process.exit(1);
  }
}
const get = (row, name) => (name in col ? (row[col[name]] ?? "").trim() : "");

// Reference data ------------------------------------------------------------

const { data: branch, error: branchErr } = await supabase
  .from("branches").select("id, code").eq("code", branchCode).single();
if (branchErr || !branch) {
  console.error(`Branch ${branchCode} not found.`);
  process.exit(1);
}

const { data: services } = await supabase
  .from("services").select("id, name, default_sharing_rate");
const { data: prices } = await supabase
  .from("branch_service_prices")
  .select("service_id, sharing_rate, effective_from")
  .eq("branch_id", branch.id)
  .order("effective_from", { ascending: false });
const { data: technicians } = await supabase
  .from("technicians").select("id, full_name");

const serviceByName = new Map(services.map((s) => [s.name.toLowerCase(), s]));
const techByName = new Map(technicians.map((t) => [t.full_name.toLowerCase(), t]));
const rateByService = new Map();
for (const p of prices ?? []) {
  if (!rateByService.has(p.service_id) && p.sharing_rate != null) {
    rateByService.set(p.service_id, p.sharing_rate);
  }
}

// Pre-validate the whole file: nothing partial is written -------------------

const missingServices = new Set();
const missingTechs = new Set();
const badRows = [];

for (const [i, row] of lines.entries()) {
  const service = get(row, "service");
  if (service && !serviceByName.has(service.toLowerCase())) missingServices.add(service);
  const tech = get(row, "technician");
  if (tech && !techByName.has(tech.toLowerCase())) missingTechs.add(tech);
  const assist = get(row, "assist");
  if (assist && !techByName.has(assist.toLowerCase())) missingTechs.add(assist);
  if (pesosToCents(get(row, "price")) == null) badRows.push(i + 2);
}

if (missingServices.size || missingTechs.size || badRows.length) {
  if (missingServices.size)
    console.error("Unknown services:\n  " + [...missingServices].join("\n  "));
  if (missingTechs.size)
    console.error("Unknown technicians:\n  " + [...missingTechs].join("\n  "));
  if (badRows.length) console.error("Unparseable prices on lines: " + badRows.join(", "));
  console.error("\nNothing was imported. Fix the catalogue or the CSV and rerun.");
  process.exit(1);
}

// Group rows into tickets: same date + same client identity -----------------

const tickets = new Map();
for (const row of lines) {
  const date = get(row, "date");
  const phone = get(row, "phone").replace(/\D/g, "");
  const name = get(row, "client_name");
  const clientKey = phone !== "" ? `p:${phone}` : `n:${name.toLowerCase() || "walk-in"}:${date}`;
  const ticketKey = `${date}|${clientKey}`;
  if (!tickets.has(ticketKey)) {
    tickets.set(ticketKey, { date, phone, name, rows: [] });
  }
  tickets.get(ticketKey).rows.push(row);
}

// Import --------------------------------------------------------------------

let created = 0, replayed = 0, failed = 0;

for (const [ticketKey, t] of tickets) {
  const contentHash = createHash("sha256")
    .update(branchCode + "|" + ticketKey + "|" + JSON.stringify(t.rows))
    .digest("hex")
    .slice(0, 24);

  const first = t.rows[0];
  const started = get(first, "time_started");
  const ended = get(first, "time_ended");
  // Time ended before time started in the source: keep the ticket, drop the
  // times (edge case 13) — bad times must not block the money.
  const timesValid = started && ended && ended >= started;

  const payload = {
    idempotency_key: `import:${branchCode}:${contentHash}`,
    branch_id: branch.id,
    ticket_date: t.date,
    client:
      t.phone !== ""
        ? { phone: t.phone, full_name: t.name || undefined }
        : { phone_declined: true, full_name: t.name || undefined },
    started_at: timesValid ? `${t.date}T${started}:00+08:00` : undefined,
    ended_at: timesValid ? `${t.date}T${ended}:00+08:00` : undefined,
    lines: t.rows.map((row) => {
      const service = serviceByName.get(get(row, "service").toLowerCase());
      const qty = Math.max(parseInt(get(row, "qty") || "1", 10) || 1, 1);
      const unit = pesosToCents(get(row, "price"));
      const discount = pesosToCents(get(row, "discount")) ?? 0;
      const rating = parseInt(get(row, "rating"), 10);
      return {
        service_id: service.id,
        technician_id: techByName.get(get(row, "technician").toLowerCase()).id,
        assist_technician_id: get(row, "assist")
          ? techByName.get(get(row, "assist").toLowerCase()).id
          : undefined,
        qty,
        unit_price_cents: unit,
        discount_cents: Math.min(discount, qty * unit),
        sharing_rate: rateByService.get(service.id) ?? service.default_sharing_rate,
        rating: rating >= 1 && rating <= 5 ? rating : undefined,
      };
    }),
    payments: [
      {
        method: /online|gcash/i.test(get(first, "payment")) ? "gcash" : "cash",
        amount_cents: t.rows.reduce((sum, row) => {
          const qty = Math.max(parseInt(get(row, "qty") || "1", 10) || 1, 1);
          const unit = pesosToCents(get(row, "price"));
          const discount = Math.min(pesosToCents(get(row, "discount")) ?? 0, qty * unit);
          return sum + qty * unit - discount;
        }, 0),
      },
    ],
  };

  const { data, error } = await supabase.rpc("create_ticket", { p_payload: payload });
  if (error) {
    failed++;
    console.error(`FAILED ${ticketKey}: ${error.message}`);
  } else if (data.duplicate) {
    replayed++;
  } else {
    created++;
  }
}

console.log(
  `\n${branchCode}: ${created} tickets imported, ${replayed} already present (skipped), ${failed} failed.`,
);
process.exit(failed > 0 ? 1 : 0);

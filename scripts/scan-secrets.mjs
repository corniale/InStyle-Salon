// Build-time secret scan (spec §12): no secrets in client code. Fails the
// build if a service-role key, a JWT-shaped literal, or a suspicious env
// name appears anywhere in src/ or in the client bundles under .next/.

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, extname } from "node:path";

const PATTERNS = [
  { name: "Supabase service-role JWT", re: /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  { name: "service role env leak", re: /SERVICE_ROLE[^\n]*=[^\n]*[A-Za-z0-9]{16}/ },
  { name: "NEXT_PUBLIC service role", re: /NEXT_PUBLIC[A-Z_]*SERVICE/i },
  { name: "private key block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "sb_secret key", re: /sb_secret_[A-Za-z0-9]{10,}/ },
];

const SCAN_EXT = new Set([".ts", ".tsx", ".js", ".mjs", ".css", ".html", ".json"]);
const SKIP_DIRS = new Set(["node_modules", ".git", "cache"]);

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const path = join(dir, name);
    const st = statSync(path);
    if (st.isDirectory()) yield* walk(path);
    else if (SCAN_EXT.has(extname(name)) || dir.includes(".next")) yield path;
  }
}

const roots = ["src", existsSync(".next/static") ? ".next/static" : null].filter(Boolean);
const findings = [];

for (const root of roots) {
  for (const file of walk(root)) {
    let text;
    try { text = readFileSync(file, "utf8"); } catch { continue; }
    for (const { name, re } of PATTERNS) {
      const m = re.exec(text);
      if (m) findings.push({ file, name, sample: m[0].slice(0, 32) + "…" });
    }
  }
}

if (findings.length) {
  console.error("Secret scan FAILED:\n");
  for (const f of findings) {
    console.error(`  ${f.file}\n    ${f.name}: ${f.sample}\n`);
  }
  process.exit(1);
}

console.log(`Secret scan passed (${roots.join(", ")}).`);

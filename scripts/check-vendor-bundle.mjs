// Searches the BUILT vendor bundle for anything internal. Run after `npm run build`.
// Fails (exit 1) if the vendor page ships table names, store code or keys.
// Plan: docs/vendor-portal-build-plan.md
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const dist = process.argv[2] || "dist";
const html = readFileSync(join(dist, "vendor.html"), "utf8");

// Collect the JS/CSS reachable from vendor.html, following static imports.
const seen = new Set();
const queue = [...html.matchAll(/(?:src|href)="\/(assets\/[^"]+)"/g)].map((m) => m[1]);
while (queue.length) {
  const f = queue.pop();
  if (seen.has(f)) continue;
  seen.add(f);
  if (!f.endsWith(".js")) continue;
  const code = readFileSync(join(dist, f), "utf8");
  for (const m of code.matchAll(/(?:from|import)\s*["']\.\/([^"']+\.js)["']/g)) queue.push(`assets/${m[1]}`);
  for (const m of code.matchAll(/import\(["']\.\/([^"']+\.js)["']\)/g)) queue.push(`assets/${m[1]}`);
}

const FORBIDDEN = [
  "supabase", "createClient", "VITE_SUPABASE", "service_role", "SUPABASE_SERVICE",
  "from('samples')", 'from("samples")', "starting_info", "running_line", "vendor_accounts",
  "vendor_sessions", "vendor_submissions", "app_secrets", "metal_prices", "metal_lock_history",
  "useMetalPriceStore", "useGenericStore", "ujwdpieleyuaiammaopj", "r2.cloudflarestorage",
  "sspProxy", "ssp-proxy", "quickbooks",
];

let bad = 0;
let bytes = 0;
for (const f of seen) {
  if (!f.endsWith(".js")) continue;
  const code = readFileSync(join(dist, f), "utf8");
  bytes += code.length;
  for (const word of FORBIDDEN) {
    if (code.toLowerCase().includes(word.toLowerCase())) {
      console.error(`FAIL: ${f} contains "${word}"`);
      bad++;
    }
  }
}
console.log(`Checked ${[...seen].filter((f) => f.endsWith(".js")).length} vendor JS files (${(bytes / 1024).toFixed(0)} kB).`);
if (bad) process.exit(1);
console.log("PASS: vendor bundle has no internal table names, store code or keys.");

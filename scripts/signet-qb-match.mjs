// Usage:
//   node scripts/signet-qb-match.mjs --signet "export 3.xlsx" [--from 2026-08-01] [--to 2026-11-18]
//        [--qb-json qb.json] [--entity "Zales Corporation   -ZALES"] [--out report.xlsx]
// Live QB pull needs the office network + env QB_API_KEY (and optional QB_API_URL,
// default http://192.168.1.7:8055). --qb-json skips the live call.
import fs from "node:fs";
import XLSX from "xlsx";
import { runMatch } from "../src/utils/signetQbMatch.js";

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith("--") ? [...a, [v.slice(2), arr[i + 1]]] : a), []));
if (!args.signet) { console.error("--signet <xlsx> required"); process.exit(1); }
const to = args.to || new Date().toISOString().slice(0, 10);
const from = args.from || new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10);
const entity = args.entity || "Zales Corporation   -ZALES";

async function getQb() {
  if (args["qb-json"]) return JSON.parse(fs.readFileSync(args["qb-json"], "utf8"));
  const base = (process.env.QB_API_URL || "http://192.168.1.7:8055").replace(/\/+$/, "");
  const key = process.env.QB_API_KEY;
  if (!key) throw new Error("Set QB_API_KEY (see config.env on eclsrv1) or pass --qb-json");
  const qs = new URLSearchParams({ date_from: from, date_to: to, entity, txn_types: "Invoice,CreditMemo", detail_level: "SummaryOnly", columns: "RefNumber,TxnType,Date,Name,Memo,PONumber,Amount" });
  const res = await fetch(`${base}/reports/CustomerBalanceDetail?${qs}`, { headers: { "X-API-Key": key }, signal: AbortSignal.timeout(180000) });
  if (!res.ok) throw new Error(`QB ${res.status}: ${await res.text()}`);
  const d = await res.json();
  return d.rows.filter((r) => r.type === "Data").map((r) => r.cells);
}

const wb = XLSX.readFile(args.signet, { cellDates: true });
const signetRows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { raw: true, defval: "" });
const qbRows = await getQb();
const r = runMatch({ qbRows, signetRows, from });

const fmtD = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d || "");
const line = (x) => ({
  Result: x.result, "QB Num": x.qb?.num ?? "", "QB Date": fmtD(x.qb?.date), "QB Amount": x.qb?.amount ?? "",
  "Signet Invoice#": x.signet?.num ?? "", "Signet Amount": x.signet?.amount ?? "", "Diff (Signet−QB)": x.diff ?? "",
  "Signet Status": x.signet?.status ?? "", PO: x.qb?.po || x.signet?.po || "", "QB Memo": x.qb?.memo ?? "",
  "Matched via": x.via ?? "", "Memo≠Signet": x.memoDisagrees ? "YES" : "",
});
const out = XLSX.utils.book_new();
const add = (name, rows) => XLSX.utils.book_append_sheet(out, XLSX.utils.json_to_sheet(rows.map(line)), name);
add("Invoices", r.invoices);
add("Invoices Signet-only", r.invoiceSignetOnly.map((s) => ({ result: "not-in-qb", qb: null, signet: s })));
add("Chargebacks", [...r.chargebacks, ...r.chargebackSignetOnly]);
XLSX.utils.book_append_sheet(out, XLSX.utils.json_to_sheet([{ section: "invoices", ...r.summary.invoices }, { section: "chargebacks", ...r.summary.chargebacks }]), "Summary");
const file = args.out || `signet-qb-match_${to}.xlsx`;
XLSX.writeFile(out, file);
console.log(JSON.stringify(r.summary, null, 1), "\n→", file);

// qbPoImport.js — import "All Purchase orders.xlsx" (QuickBooks export) into the
// shipments board as a SECOND source of truth (Brian 7/2: memos aren't always
// reliable; the QB PO sheet links vendor PO -> Signet PO earlier and carries
// per-vendor-PO dollars + dates).
//
// Source-of-truth rules:
//   - Signet-scraped ship_date/due_date stay king when present.
//   - QB owns qb_amount / qb_ship_date / qb_due_date (refreshed every import).
//   - SO link: fills gaps (needs_link / missing). A CONFLICT with an existing
//     link is flagged in memo_note, never silently overwritten.
//   - Stamps, status, notes, manual links are never touched.
// Validated against the real export 7/2/26: 965 POs, 835 with SO link, 0 dupes.

import * as XLSX from "xlsx";
import { SHIPMENTS_TABLE } from "./shipmentsSync";

const VENDOR_NAME_MAP = [
  [/amtai/i, "Amtai"],
  [/aoxin/i, "Aoxin"],
  [/china\s*ideal/i, "CIJ"],
  [/inah/i, "Inah"],
];
const PO_RE = /^\d{4,6}[a-z]?(-(\d+|new))?$/i;
const SO_RE = /sales\s+order\s+(\d{4,6})/i;

function vendorFromName(name) {
  for (const [re, v] of VENDOR_NAME_MAP) if (re.test(name || "")) return v;
  return null;
}

function toISO(v) {
  if (v == null) return null;
  if (v instanceof Date) return isNaN(v) ? null : v.toISOString().slice(0, 10);
  const d = new Date(v);
  return isNaN(d) ? null : d.toISOString().slice(0, 10);
}

export function parseQbPoFile(arrayBuffer) {
  const wb = XLSX.read(arrayBuffer, { cellDates: true });
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: null });
  let hr = -1;
  const cols = {};
  for (let i = 0; i < rows.length; i++) {
    const r = (rows[i] || []).map((c) => (c == null ? "" : String(c).trim().toLowerCase()));
    const num = r.indexOf("num");
    if (num >= 0 && r.indexOf("memo") >= 0) {
      hr = i;
      cols.num = num;
      cols.type = r.indexOf("type");
      cols.name = r.indexOf("name");
      cols.memo = r.indexOf("memo");
      cols.ship = r.indexOf("ship date");
      cols.due = r.indexOf("due date");
      cols.amount = r.indexOf("amount");
      break;
    }
  }
  if (hr < 0) throw new Error('No "Num"/"Memo" header row found — is this the QB purchase orders export?');

  const parsed = [];
  for (let i = hr + 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const numRaw = r[cols.num];
    if (numRaw == null) continue;
    const num = String(numRaw).trim();
    if (!PO_RE.test(num)) continue; // junk: "price req", "pricing 2", "quote11-17"...
    if (cols.type >= 0 && r[cols.type] && !/purchase order/i.test(String(r[cols.type]))) continue;
    const name = r[cols.name] == null ? "" : String(r[cols.name]).trim();
    const memo = r[cols.memo] == null ? "" : String(r[cols.memo]).trim();
    const soM = memo.match(SO_RE);
    parsed.push({
      vendorPo: num,
      vendor: vendorFromName(name),
      vendorName: name,
      signetPo: soM ? soM[1] : null,
      shipDate: toISO(r[cols.ship]),
      dueDate: toISO(r[cols.due]),
      amount: typeof r[cols.amount] === "number" ? r[cols.amount] : null,
    });
  }
  return parsed;
}

// Only INSERT rows that are still relevant (ship/due within the last 45 days or
// future) — updates apply to any existing row regardless of age.
function isCurrent(rec) {
  const ref = rec.dueDate || rec.shipDate;
  if (!ref) return false;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 45);
  return new Date(ref + "T00:00:00") >= cutoff;
}

export async function importQbPos(supabase, arrayBuffer) {
  const summary = { parsed: 0, updated: 0, inserted: 0, conflicts: [], errors: [] };
  let parsed;
  try {
    parsed = parseQbPoFile(arrayBuffer);
  } catch (err) {
    summary.errors.push(err.message);
    return summary;
  }
  summary.parsed = parsed.length;

  const { data: existingRows, error } = await supabase
    .from(SHIPMENTS_TABLE)
    .select("id, vendor_po, signet_po_number, vendor, link_source, memo_note");
  if (error) {
    summary.errors.push("read shipments: " + error.message);
    return summary;
  }
  const byVendorPo = new Map((existingRows ?? []).map((r) => [String(r.vendor_po), r]));

  for (const rec of parsed) {
    const existing = byVendorPo.get(rec.vendorPo);
    if (existing) {
      const patch = {
        qb_amount: rec.amount,
        qb_ship_date: rec.shipDate,
        qb_due_date: rec.dueDate,
        updated_at: new Date().toISOString(),
      };
      if (!existing.vendor && (rec.vendor || rec.vendorName)) {
        patch.vendor = rec.vendor || rec.vendorName;
      } else if (existing.vendor && rec.vendor && existing.vendor !== rec.vendor) {
        // memo said one vendor, QB (the payee of record) says another — flag, don't pick
        const note = `⚠ QB vendor: ${rec.vendor}`;
        if (!String(existing.memo_note || "").includes(note)) {
          patch.memo_note = [existing.memo_note, note].filter(Boolean).join("; ");
        }
        summary.conflicts.push(`${rec.vendorPo}: board says ${existing.vendor}, QB says ${rec.vendor}`);
      }
      if (rec.signetPo) {
        const cur = existing.signet_po_number;
        if (!cur || existing.link_source === "needs_link") {
          patch.signet_po_number = rec.signetPo;
          if (existing.link_source === "needs_link") patch.link_source = "qb";
        } else if (String(cur) !== String(rec.signetPo)) {
          const note = `⚠ QB says SO ${rec.signetPo}`;
          if (!String(existing.memo_note || "").includes(note)) {
            patch.memo_note = [existing.memo_note, note].filter(Boolean).join("; ");
          }
          summary.conflicts.push(`${rec.vendorPo}: board ${cur} vs QB ${rec.signetPo}`);
        }
      }
      const { error: e } = await supabase.from(SHIPMENTS_TABLE).update(patch).eq("id", existing.id);
      if (e) summary.errors.push(`update ${rec.vendorPo}: ` + e.message);
      else summary.updated++;
    } else {
      if (!isCurrent(rec)) continue; // don't flood the board with history
      const vendor = rec.vendor || rec.vendorName || null;
      const { error: e } = await supabase.from(SHIPMENTS_TABLE).insert({
        vendor_po: rec.vendorPo,
        signet_po_number: rec.signetPo,
        vendor,
        route: rec.vendor === "Inah" ? "direct" : "hk",
        qb_amount: rec.amount,
        qb_ship_date: rec.shipDate,
        qb_due_date: rec.dueDate,
        // no "Sales Order ####" in the QB memo → needs a human link
        link_source: rec.signetPo ? "qb" : "needs_link",
      });
      if (e) summary.errors.push(`insert ${rec.vendorPo}: ` + e.message);
      else summary.inserted++;
    }
  }
  return summary;
}

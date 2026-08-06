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
import { fetchMemosReport, isQbEnabled, QB_ALL_PO_VIEW, QB_OPEN_PO_VIEW } from "./qbClient";

// QuickBooks payee -> the short vendor name the board uses. Anything not
// matched here falls back to the RAW QB payee, which is how a row ended up
// reading "TIANJIN MINGHANG BEAUTY DAZZLING JEWELRY" alongside "Aoxin".
// Aoxin also trades as Fordxin, so both spellings map to Aoxin.
const VENDOR_NAME_MAP = [
  [/amtai/i, "Amtai"],
  [/aoxin|fordxin/i, "Aoxin"],
  [/china\s*ideal|\bcij\b/i, "CIJ"],
  [/inah/i, "Inah"],
  [/ming\s*hang/i, "MingHang"],
  [/grand\s*ways/i, "Grandways"],
  [/kadima/i, "Kadima"],
  [/better\s*charms/i, "Better Charms"],
];
const PO_RE = /^\d{4,6}[a-z]?(-(\d+|new))?$/i;
// Signet PO numbers are ALWAYS exactly 6 digits (verified: all 148 in the
// PLM). The old \d{4,6} with no boundary matched far too eagerly — a real
// memo reading "Sales Order 1345sample:" captured "1345" and would have
// linked that vendor PO to a sales order that doesn't exist. Requiring six
// digits not followed by another digit makes a wrong link impossible; a memo
// that doesn't match simply comes through as needs_link for a human.
const SO_RE = /sales\s*order\s*#?\s*(\d{6})(?!\d)/i;

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
      memo, // raw QB memo — shown on the board when there's no SO to link
      shipDate: toISO(r[cols.ship]),
      dueDate: toISO(r[cols.due]),
      amount: typeof r[cols.amount] === "number" ? r[cols.amount] : null,
    });
  }
  return parsed;
}

/**
 * Same records as parseQbPoFile, but from the connector's `open-po` view
 * instead of the exported spreadsheet — identical columns (Num, Type, Name,
 * Memo, Ship Date, Due Date, Amount), so the rules are shared verbatim: the
 * PO_RE junk filter, the "Sales Order ####" SO extraction, and the vendor
 * name map. Amounts arrive as strings over the API, so they're coerced here.
 */
export function parseQbPoRows(rows) {
  const parsed = [];
  for (const r of rows || []) {
    const numRaw = r?.Num ?? r?.num;
    if (numRaw == null) continue;
    const num = String(numRaw).trim();
    if (!PO_RE.test(num)) continue; // junk: "price req", "quote11-17", ...
    const type = r?.Type ?? r?.type;
    if (type && !/purchase order/i.test(String(type))) continue;
    const name = r?.Name == null ? "" : String(r.Name).trim();
    const memo = r?.Memo == null ? "" : String(r.Memo).trim();
    const soM = memo.match(SO_RE);
    const amtRaw = r?.Amount ?? r?.amount;
    const amt = amtRaw == null || amtRaw === "" ? null : Number(amtRaw);
    parsed.push({
      vendorPo: num,
      vendor: vendorFromName(name),
      vendorName: name,
      signetPo: soM ? soM[1] : null,
      memo,
      shipDate: toISO(r?.["Ship Date"] ?? r?.ship_date),
      dueDate: toISO(r?.["Due Date"] ?? r?.due_date),
      amount: Number.isFinite(amt) ? amt : null,
    });
  }
  return parsed;
}

/**
 * Pull the purchase orders straight from QuickBooks and run them through the
 * exact same upsert as the spreadsheet import — no second implementation to
 * drift.
 *
 * This is the ONLY thing that links the board. The QB purchase order IS the
 * vendor PO: its payee is the vendor, its memo names the Signet sales order.
 * So every PO becomes a shipments row, and that row carries the link back to
 * the Signet PO (shipments.signet_po_number). Nothing infers a link from a
 * Signet PO's memo any more — that guessed, this reads it from the source.
 *
 * Asks for `all-po` (open_only:false) so history comes along; falls back to
 * `open-po` if the connector's report_views.json predates that view, in which
 * case only currently-open POs land and the summary says so.
 *
 * GATED: no QuickBooks call unless the integration is on.
 */
export async function importQbPosFromQb(supabase, { settings, view } = {}) {
  const summary = { parsed: 0, updated: 0, inserted: 0, conflicts: [], errors: [], view: null };
  if (!isQbEnabled(settings)) {
    summary.errors.push("QuickBooks integration is off");
    return summary;
  }
  // Try every-PO first, then open-only. A connector that doesn't know the view
  // answers 404 "unknown view: all-po" — that's a config gap, not a failure, so
  // fall through rather than aborting the whole sync.
  const attempts = view ? [view] : [QB_ALL_PO_VIEW, QB_OPEN_PO_VIEW];
  let rows = null;
  const tried = [];
  for (const v of attempts) {
    try {
      const res = await fetchMemosReport({ settings, view: v });
      rows = res.rows || [];
      summary.view = v;
      break;
    } catch (e) {
      const msg = e?.message || String(e);
      tried.push(`${v}: ${msg}`);
      if (!/unknown view|404/i.test(msg)) break; // a real QB/transport error — stop
    }
  }
  if (rows === null) {
    summary.errors.push("fetch purchase orders — " + tried.join(" · "));
    return summary;
  }
  if (summary.view === QB_OPEN_PO_VIEW && attempts.length > 1) {
    summary.errors.push(
      `connector has no "${QB_ALL_PO_VIEW}" view — fell back to ${QB_OPEN_PO_VIEW}, so closed POs were not imported`
    );
  }
  const parsed = parseQbPoRows(rows);
  summary.parsed = parsed.length;
  if (!parsed.length) {
    summary.errors.push(`${summary.view} returned ${rows.length} row(s) but none looked like a purchase order`);
    return summary;
  }
  return upsertQbPoRecords(supabase, parsed, summary);
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
  return upsertQbPoRecords(supabase, parsed, summary);
}

/** The shared upsert — one implementation for the file and the API. */
export async function upsertQbPoRecords(supabase, parsed, summary = { parsed: parsed.length, updated: 0, inserted: 0, conflicts: [], errors: [] }) {
  const { data: existingRows, error } = await supabase
    .from(SHIPMENTS_TABLE)
    .select("id, vendor_po, signet_po_number, vendor, link_source, memo_note, deleted_at");
  if (error) {
    summary.errors.push("read shipments: " + error.message);
    return summary;
  }
  const byVendorPo = new Map((existingRows ?? []).map((r) => [String(r.vendor_po), r]));

  for (const rec of parsed) {
    let existing = byVendorPo.get(rec.vendorPo);

    if (!existing) {
      // Kevin 7/6: import EVERY PO in the QB file — the file is the source of
      // truth, history included.
      const vendor = rec.vendor || rec.vendorName || null;
      const { error: e } = await supabase.from(SHIPMENTS_TABLE).insert({
        vendor_po: rec.vendorPo,
        signet_po_number: rec.signetPo,
        vendor,
        route: rec.vendor === "Inah" ? "direct" : "hk",
        qb_amount: rec.amount,
        qb_ship_date: rec.shipDate,
        qb_due_date: rec.dueDate,
        // no "Sales Order ####" in the QB memo → needs a human link; keep the
        // raw memo visible so it's obvious what the PO was for
        link_source: rec.signetPo ? "qb" : "needs_link",
        memo_note: rec.signetPo ? null : rec.memo || null,
      });
      if (!e) {
        summary.inserted++;
        continue;
      }
      if (e.code === "23505" || /duplicate key/i.test(e.message)) {
        // the row appeared between our read and this insert (another tab or a
        // sync racing us) — re-fetch it and update instead of erroring
        const { data: ref } = await supabase
          .from(SHIPMENTS_TABLE)
          .select("id, vendor_po, signet_po_number, vendor, link_source, memo_note, deleted_at")
          .eq("vendor_po", rec.vendorPo)
          .maybeSingle();
        if (!ref) {
          summary.errors.push(`insert ${rec.vendorPo}: ` + e.message);
          continue;
        }
        existing = ref;
      } else {
        summary.errors.push(`insert ${rec.vendorPo}: ` + e.message);
        continue;
      }
    }

    // tombstoned = deleted once and for all — a re-import never touches or
    // resurrects it
    if (existing.deleted_at) continue;

    {
      const patch = {
        qb_amount: rec.amount,
        qb_ship_date: rec.shipDate,
        qb_due_date: rec.dueDate,
        updated_at: new Date().toISOString(),
      };
      // still unlinked → surface the QB memo so the row explains itself
      if (!rec.signetPo && !existing.signet_po_number && rec.memo && !existing.memo_note) {
        patch.memo_note = rec.memo;
      }
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
    }
  }
  return summary;
}

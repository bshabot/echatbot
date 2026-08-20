// src/utils/soLiveReconcile.js
//
// PROTOTYPE — manual-trigger only, no schedule. Kevin 8/20: "if we do a PO
// then that goes to the vendor to fulfill do you not have that info?" — yes:
// qb-connector already exposes real PO line items (GET /purchase-orders
// ?include_lines=true, added earlier this session for the update-lines
// flow). This is the ACCURATE version of the Shipments-board coverage badge
// (utils/soCoverage.js): that one guesses which vendor is "probably"
// responsible for a SKU from aliases/sample data; this one pulls the real
// line items off every internal PO linked to a Signet SO and sums actual
// ordered quantities, so "SO has 7 items, POs only cover 6" is a real count,
// not an inference.
//
// Why this can't just run in the background (yet): the PO line data only
// exists live in QuickBooks, reached through qb-connector — which only
// answers on the machine/network where QuickBooks is open. A browser
// sitting on that same network can call it fine (same as every other QB
// button in this app); a cloud scheduled job can't. Manual button it is,
// for now — see the chat thread this file's header comment came out of if
// this ever needs to become scheduled (it'd have to run FROM that network).
import { findPurchaseOrder } from "./qbClient";
import { normalizeModel, stripModel } from "./labelOrderUtils";

const LIVE_STATUSES = ["ACKNOWLEDGED", "MODIFIED", "NEW"];

/**
 * Check one Signet SO's items against the REAL line items on every internal
 * PO linked to it on the Shipments board.
 *
 * Returns:
 *   {
 *     soNumber, checkedPos: [{ refNumber, vendor, ok, error }],
 *     lines: [{ sku, model, description, soQty, poQty, short }],
 *     anyShort: boolean,
 *   }
 * `short` = soQty > poQty for that line — the real, quantity-level version
 * of "missing." A line with poQty >= soQty is fully covered even if it's
 * split across several internal POs (summed together).
 */
export async function checkSoAgainstLivePos(supabase, soNumber) {
  const so = String(soNumber).trim();

  const [linesRes, shipRes] = await Promise.all([
    supabase
      .from("signet_pos")
      .select("po_number, sku, model, description, order_qty, order_status, scraped_at")
      .eq("po_number", so)
      .order("scraped_at", { ascending: false })
      .limit(10000),
    supabase
      .from("shipments")
      .select("vendor_po, vendor")
      .eq("signet_po_number", so)
      .is("deleted_at", null),
  ]);
  if (linesRes.error) throw linesRes.error;
  if (shipRes.error) throw shipRes.error;

  // newest scrape per SKU wins (signet_pos gets re-scraped repeatedly)
  const seen = new Set();
  const soLines = [];
  for (const l of linesRes.data || []) {
    if (seen.has(l.sku)) continue;
    seen.add(l.sku);
    if (!LIVE_STATUSES.includes(l.order_status)) continue;
    soLines.push(l);
  }

  const vendorPos = Array.from(
    new Set((shipRes.data || []).map((s) => String(s.vendor_po).trim()).filter(Boolean))
  );

  // Pull each internal PO's real lines from QuickBooks, one at a time — the
  // connector serves one QuickBooks call at a time regardless, and this is a
  // manual click against a handful of POs, not a batch job.
  const checkedPos = [];
  const poQtyByModel = new Map(); // normalized model -> summed quantity
  for (const refNumber of vendorPos) {
    const vendorRow = (shipRes.data || []).find((s) => String(s.vendor_po).trim() === refNumber);
    try {
      const po = await findPurchaseOrder(refNumber);
      if (!po) {
        checkedPos.push({ refNumber, vendor: vendorRow?.vendor || null, ok: false, error: "not found in QuickBooks" });
        continue;
      }
      for (const line of po.lines || []) {
        if (!line.item) continue;
        const norm = normalizeModel(line.item);
        const stripped = stripModel(line.item);
        const qty = Number(line.quantity || 0);
        poQtyByModel.set(norm, (poQtyByModel.get(norm) || 0) + qty);
        if (stripped !== norm) {
          poQtyByModel.set(stripped, (poQtyByModel.get(stripped) || 0) + qty);
        }
      }
      checkedPos.push({ refNumber, vendor: vendorRow?.vendor || po.vendor || null, ok: true, error: null });
    } catch (e) {
      checkedPos.push({ refNumber, vendor: vendorRow?.vendor || null, ok: false, error: e?.message || String(e) });
    }
  }

  const lines = soLines.map((l) => {
    const norm = normalizeModel(l.model);
    const stripped = stripModel(l.model);
    const poQty = poQtyByModel.get(norm) ?? poQtyByModel.get(stripped) ?? 0;
    const soQty = Number(l.order_qty || 0);
    return {
      sku: l.sku,
      model: l.model,
      description: l.description,
      soQty,
      poQty,
      short: poQty < soQty,
    };
  });

  return {
    soNumber: so,
    checkedPos,
    lines,
    anyShort: lines.some((l) => l.short),
  };
}

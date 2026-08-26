import React, { useEffect, useMemo, useState } from "react";
import { X, TriangleAlert } from "lucide-react";
import { useSupabase } from "../SupaBaseProvider";
import {
  attributeLine,
  normalizeModel,
  stripModel,
  vendorLabelFor,
} from "../../utils/labelOrderUtils";

// Click a vendor PO on the shipments board → what's inside it.
// A vendor PO = this vendor's slice of the Signet sales order, so we pull the
// SO's lines and attribute each one with the SAME hierarchy the Labels and
// Factory Costs pages use (alias > single-SO vendor > exact sample > stripped).
// Lines that attribute to this row's vendor are the PO's contents; anything
// unmatched is shown separately so nothing is silently hidden.
const LIVE_STATUSES = ["ACKNOWLEDGED", "MODIFIED", "NEW"];

export default function VendorPoItemsDialog({ row, onClose }) {
  const { supabase } = useSupabase();
  const [state, setState] = useState({ loading: true, error: null, data: null });
  const [showOthers, setShowOthers] = useState(false);

  const myLabel = vendorLabelFor(row.vendor);

  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const po = String(row.signet_po_number).trim();
        // signet_pos_latest doesn't expose description, so read the base table
        // and dedupe per SKU keeping the newest scrape (same DISTINCT ON idea).
        const [linesRes, shipRes, vendRes, aliasRes, sampRes, siRes] =
          await Promise.all([
            supabase
              .from("signet_pos")
              .select(
                "po_number, sku, model, description, order_qty, shipped_qty, order_status, scraped_at"
              )
              .eq("po_number", po)
              .order("scraped_at", { ascending: false })
              .limit(10000),
            supabase
              .from("shipments")
              .select("signet_po_number, vendor_po, vendor")
              .eq("signet_po_number", po)
              .is("deleted_at", null),
            supabase.from("vendors").select("id, name"),
            supabase.from("model_aliases").select("alias, vendor_id"),
            supabase.from("samples").select("styleNumber, starting_info_id"),
            supabase.from("starting_info").select("id, vendor"),
          ]);
        const err =
          linesRes.error || shipRes.error || vendRes.error || aliasRes.error ||
          sampRes.error || siRes.error;
        if (err) throw err;

        const seen = new Set();
        const lines = [];
        for (const l of linesRes.data || []) {
          if (seen.has(l.sku)) continue; // newest scrape wins
          seen.add(l.sku);
          lines.push(l);
        }
        lines.sort((a, b) => String(a.sku).localeCompare(String(b.sku)));

        const soVendorsByPo = {};
        for (const s of shipRes.data || []) {
          if (!s.signet_po_number || !s.vendor_po) continue;
          const label = vendorLabelFor(s.vendor);
          if (!label) continue;
          const p = (soVendorsByPo[s.signet_po_number] ??= {});
          (p[label] ??= []).push(String(s.vendor_po));
        }

        const vendorsById = {};
        for (const v of vendRes.data || []) vendorsById[v.id] = v;

        const aliasMap = {};
        for (const a of aliasRes.data || [])
          aliasMap[normalizeModel(a.alias)] = a.vendor_id;

        const siVendor = {};
        for (const si of siRes.data || []) siVendor[si.id] = si.vendor;
        const exactMap = {};
        const strippedMap = {};
        for (const s of sampRes.data || []) {
          if (!s.styleNumber || !s.starting_info_id) continue;
          const vId = siVendor[s.starting_info_id];
          if (!vId) continue;
          const norm = normalizeModel(s.styleNumber);
          const stripped = stripModel(s.styleNumber);
          if (!(norm in exactMap)) exactMap[norm] = vId;
          if (!(stripped in strippedMap)) strippedMap[stripped] = vId;
        }

        const ctx = { aliasMap, exactMap, strippedMap, soVendorsByPo, vendorsById };
        const attributed = lines.map((l) => attributeLine(l, ctx));
        if (!dead)
          setState({
            loading: false,
            error: null,
            data: { attributed, soVendorsByPo },
          });
      } catch (e) {
        console.log("VendorPoItemsDialog fetch error", e);
        if (!dead)
          setState({ loading: false, error: e.message || String(e), data: null });
      }
    })();
    return () => { dead = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase, row.id]);

  const view = useMemo(() => {
    if (!state.data) return null;
    const { attributed, soVendorsByPo } = state.data;
    const mine = myLabel
      ? attributed.filter((l) => l.vendorLabel === myLabel)
      : [];
    const unassigned = attributed.filter((l) => !l.vendorLabel);
    const others = attributed.filter(
      (l) => l.vendorLabel && l.vendorLabel !== myLabel
    );
    const othersByVendor = {};
    for (const l of others) {
      const o = (othersByVendor[l.vendorLabel] ??= { label: l.vendorLabel, lines: [], units: 0 });
      o.lines.push(l);
      o.units += Number(l.order_qty || 0);
    }
    const units = (ls) => ls.reduce((s, l) => s + Number(l.order_qty || 0), 0);
    const mySos =
      (soVendorsByPo[String(row.signet_po_number).trim()] || {})[myLabel] || [];
    return {
      mine,
      mineUnits: units(mine),
      unassigned,
      unassignedUnits: units(unassigned),
      othersByVendor: Object.values(othersByVendor).sort((a, b) =>
        a.label.localeCompare(b.label)
      ),
      mySos,
    };
  }, [state.data, myLabel, row.signet_po_number]);

  const qty = (n) => Number(n || 0).toLocaleString();

  function linesTable(lines) {
    return (
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-gray-500">
            <th className="p-2">SKU</th>
            <th className="p-2">Style</th>
            <th className="p-2">Description</th>
            <th className="p-2 text-right">Qty</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.sku} className="border-t border-gray-100">
              <td className="p-2 whitespace-nowrap">{l.sku}</td>
              <td className="p-2 whitespace-nowrap">{l.model}</td>
              <td className="p-2 text-gray-600">{l.description || "—"}</td>
              <td className="p-2 text-right whitespace-nowrap">
                {qty(l.order_qty)}
                {!LIVE_STATUSES.includes(l.order_status) && (
                  <span className="ml-1.5 text-[10px] text-gray-400 uppercase">
                    {l.order_status}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl max-h-[85vh] max-md:max-h-[90dvh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-4 border-b">
          <div>
            <div className="font-semibold text-lg">
              PO {row.vendor_po}
              {myLabel ? ` — ${myLabel}` : ""}
            </div>
            <div className="text-sm text-gray-500">
              Signet SO {row.signet_po_number}
              {view
                ? ` · ${view.mine.length} style${view.mine.length === 1 ? "" : "s"} · ${qty(view.mineUnits)} pcs`
                : ""}
            </div>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X size={20} />
          </button>
        </div>

        <div className="px-5 py-4">
          {state.loading && (
            <div className="text-sm text-gray-400 py-6 text-center">
              Loading items…
            </div>
          )}
          {state.error && (
            <div className="text-sm text-red-600 py-4">
              Couldn't load items: {state.error}
            </div>
          )}

          {view && (
            <>
              {view.mySos.length > 1 && (
                <div className="text-xs text-gray-500 mb-2">
                  {myLabel} has {view.mySos.length} POs on this SO (
                  {view.mySos.join(", ")}) — items can't be split between them,
                  so all {myLabel} lines are shown.
                </div>
              )}

              {view.mine.length > 0 ? (
                <div className="border rounded overflow-x-auto">
                  {linesTable(view.mine)}
                </div>
              ) : (
                <div className="text-sm text-gray-400 py-4 text-center">
                  {myLabel
                    ? `No lines on SO ${row.signet_po_number} match ${myLabel}.`
                    : "No vendor on this row — vendor breakdown below."}
                </div>
              )}

              {view.unassigned.length > 0 && (
                <div className="mt-3 border border-amber-200 bg-amber-50/50 rounded overflow-x-auto">
                  <div className="px-2 pt-2 text-xs text-amber-700 flex items-center gap-1">
                    <TriangleAlert className="w-3.5 h-3.5" />
                    {view.unassigned.length} line
                    {view.unassigned.length === 1 ? "" : "s"} with no vendor
                    match ({qty(view.unassignedUnits)} pcs) — could belong to
                    this PO. Assign the style on the Labels page to clear this.
                  </div>
                  {linesTable(view.unassigned)}
                </div>
              )}

              {view.othersByVendor.length > 0 && (
                <div className="mt-3 text-xs text-gray-500">
                  Also on SO {row.signet_po_number}:{" "}
                  {view.othersByVendor
                    .map(
                      (o) =>
                        `${o.label} ${o.lines.length} style${o.lines.length === 1 ? "" : "s"} · ${qty(o.units)} pcs`
                    )
                    .join(" · ")}{" "}
                  <button
                    onClick={() => setShowOthers((s) => !s)}
                    className="text-blue-500 hover:underline"
                  >
                    {showOthers ? "hide" : "show"}
                  </button>
                </div>
              )}
              {showOthers &&
                view.othersByVendor.map((o) => (
                  <div key={o.label} className="mt-2 border rounded overflow-x-auto">
                    <div className="px-2 pt-2 text-xs font-medium text-gray-600">
                      {o.label}
                    </div>
                    {linesTable(o.lines)}
                  </div>
                ))}
            </>
          )}
        </div>

        <div className="flex justify-end px-5 py-4 border-t bg-gray-50 rounded-b-lg">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm rounded border hover:bg-gray-100"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

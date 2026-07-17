import React, { useEffect, useMemo, useState } from "react";
import { Calculator, ChevronDown, ChevronRight, RefreshCw, TriangleAlert } from "lucide-react";
import { useSupabase } from "../components/SupaBaseProvider";
import { useMessage } from "../components/Messages/MessageContext";
import { useMetalPriceStore } from "../store/MetalPrices";
import Loading from "../components/Loading";
import AddSampleModal from "../components/Samples/AddSampleModal";
import { getMetalCost } from "../components/Samples/CalculatePrice";
import { getTotalCost } from "../components/Samples/TotalCost";
import {
  attributeLine,
  normalizeModel,
  stripModel,
  vendorLabelFor,
} from "../utils/labelOrderUtils";

const LIVE_STATUSES = ["ACKNOWLEDGED", "MODIFIED", "NEW"];
const money = (n) =>
  n == null
    ? "—"
    : n.toLocaleString("en-US", { style: "currency", currency: "USD" });

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export default function FactoryCosts() {
  const { supabase } = useSupabase();
  const { showMessage } = useMessage();
  const { prices } = useMetalPriceStore();

  const [loading, setLoading] = useState(true);
  const [lines, setLines] = useState([]);
  const [soVendorsByPo, setSoVendorsByPo] = useState({});
  const [vendorsById, setVendorsById] = useState({});
  const [aliasMap, setAliasMap] = useState({});
  const [sampleMaps, setSampleMaps] = useState({ exactMap: {}, strippedMap: {} });
  const [siByStyle, setSiByStyle] = useState({ exact: {}, stripped: {} });

  const [selectedPos, setSelectedPos] = useState({});
  const [priced, setPriced] = useState(null); // { details, stonesBySi }
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState({});
  const [createFor, setCreateFor] = useState(null); // style number to prefill

  const [goldPrice, setGoldPrice] = useState("");
  const [silverPrice, setSilverPrice] = useState("");

  // default the editable inputs to the live PLM prices once loaded
  useEffect(() => {
    if (goldPrice === "" && prices?.gold?.price) setGoldPrice(String(prices.gold.price));
    if (silverPrice === "" && prices?.silver?.price) setSilverPrice(String(prices.silver.price));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prices]);

  const fetchAll = async () => {
    setLoading(true);
    try {
      const [posRes, shipRes, vendRes, aliasRes, sampRes, siRes] =
        await Promise.all([
          supabase
            .from("signet_pos_latest")
            .select("po_number, sku, model, order_qty, order_status, order_date")
            .in("order_status", LIVE_STATUSES)
            .order("order_date", { ascending: false }),
          supabase
            .from("shipments")
            .select("signet_po_number, vendor_po, vendor")
            .is("deleted_at", null),
          supabase.from("vendors").select("id, name, pricingsetting"),
          supabase.from("model_aliases").select("alias, vendor_id"),
          supabase.from("samples").select("styleNumber, starting_info_id"),
          supabase.from("starting_info").select("id, vendor"),
        ]);
      const err =
        posRes.error || shipRes.error || vendRes.error || aliasRes.error ||
        sampRes.error || siRes.error;
      if (err) throw err;

      setLines(posRes.data || []);

      const so = {};
      for (const s of shipRes.data || []) {
        if (!s.signet_po_number || !s.vendor_po) continue;
        const label = vendorLabelFor(s.vendor);
        if (!label) continue;
        const po = (so[s.signet_po_number] ??= {});
        (po[label] ??= []).push(String(s.vendor_po));
      }
      setSoVendorsByPo(so);

      const vById = {};
      for (const v of vendRes.data || []) vById[v.id] = v;
      setVendorsById(vById);

      const aMap = {};
      for (const a of aliasRes.data || []) aMap[normalizeModel(a.alias)] = a.vendor_id;
      setAliasMap(aMap);

      const siVendor = {};
      for (const si of siRes.data || []) siVendor[si.id] = si.vendor;
      const exactMap = {};
      const strippedMap = {};
      const exactSi = {};
      const strippedSi = {};
      for (const s of sampRes.data || []) {
        if (!s.styleNumber || !s.starting_info_id) continue;
        const vId = siVendor[s.starting_info_id];
        const norm = normalizeModel(s.styleNumber);
        const stripped = stripModel(s.styleNumber);
        if (!(norm in exactSi)) exactSi[norm] = s.starting_info_id;
        if (!(stripped in strippedSi)) strippedSi[stripped] = s.starting_info_id;
        if (vId && !(norm in exactMap)) exactMap[norm] = vId;
        if (vId && !(stripped in strippedMap)) strippedMap[stripped] = vId;
      }
      setSampleMaps({ exactMap, strippedMap });
      setSiByStyle({ exact: exactSi, stripped: strippedSi });
    } catch (e) {
      console.log("FactoryCosts fetch error", e);
      showMessage("Failed to load: " + (e.message || e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (supabase) fetchAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase]);

  const poGroups = useMemo(() => {
    const byPo = {};
    for (const l of lines) {
      const g = (byPo[l.po_number] ??= { po: l.po_number, date: l.order_date, lines: [] });
      g.lines.push(l);
    }
    return Object.values(byPo).sort((a, b) => (a.date < b.date ? 1 : -1));
  }, [lines]);

  const selected = poGroups.filter((g) => selectedPos[g.po]);

  const siIdForModel = (model) =>
    siByStyle.exact[normalizeModel(model)] ??
    siByStyle.stripped[stripModel(model)] ??
    null;

  const priceIt = async () => {
    if (selected.length === 0) {
      showMessage("Select at least one sales order first");
      return;
    }
    setBusy(true);
    try {
      const targetLines = selected.flatMap((g) => g.lines);
      const siIds = [
        ...new Set(targetLines.map((l) => siIdForModel(l.model)).filter(Boolean)),
      ];
      const details = {};
      const stonesBySi = {};
      for (const ids of chunk(siIds, 200)) {
        const [siRes, stRes] = await Promise.all([
          supabase
            .from("starting_info")
            .select(
              "id, vendor, weight, karat, metalType, laborCost, miscCost, platingCharge"
            )
            .in("id", ids),
          supabase
            .from("stones")
            .select("starting_info_id, cost, quantity")
            .in("starting_info_id", ids),
        ]);
        if (siRes.error) throw siRes.error;
        if (stRes.error) throw stRes.error;
        for (const si of siRes.data || []) details[si.id] = si;
        for (const st of stRes.data || [])
          (stonesBySi[st.starting_info_id] ??= []).push(st);
      }
      setPriced({ details, stonesBySi, pos: selected.map((g) => g.po) });
      setExpanded({});
    } catch (e) {
      console.log("price fetch error", e);
      showMessage("Pricing failed: " + (e.message || e));
    } finally {
      setBusy(false);
    }
  };

  // ---------- computed cost view (reactive to metal inputs) ----------

  const costView = useMemo(() => {
    if (!priced) return null;
    const gold = Number(goldPrice) || 0;
    const silver = Number(silverPrice) || 0;
    const ctx = { aliasMap, soVendorsByPo, vendorsById, ...sampleMaps };

    const targetLines = poGroups
      .filter((g) => priced.pos.includes(g.po))
      .flatMap((g) => g.lines);

    const rows = targetLines.map((raw) => {
      const attributed = attributeLine(raw, ctx);
      const siId = siIdForModel(raw.model);
      const si = siId ? priced.details[siId] : null;
      let unit = null;
      let metalCost = null;
      if (si) {
        const metalPrice =
          si.metalType === "Gold" ? gold : si.metalType === "Silver" ? silver : 0;
        const sampleVendor = vendorsById[si.vendor];
        const loss = Number(sampleVendor?.pricingsetting?.lossPercentage ?? 0);
        metalCost = getMetalCost(metalPrice, Number(si.weight) || 0, si.karat, loss);
        unit = getTotalCost(
          metalCost,
          Number(si.miscCost) || 0,
          Number(si.laborCost) || 0,
          priced.stonesBySi[siId] || [],
          Number(si.platingCharge) || 0
        );
      }
      return {
        ...attributed,
        si,
        unit,
        metalCost,
        extended: unit != null ? unit * Number(raw.order_qty || 0) : null,
      };
    });

    const byVendor = {};
    for (const r of rows) {
      const label = r.vendorLabel || "Unassigned";
      const v = (byVendor[label] ??= {
        label,
        rows: [],
        total: 0,
        units: 0,
        unpriced: 0,
        soNumbers: new Set(),
      });
      v.rows.push(r);
      v.units += Number(r.order_qty || 0);
      if (r.extended != null) v.total += r.extended;
      else v.unpriced += 1;
      const sos = (soVendorsByPo[r.po_number] || {})[r.vendorLabel] || [];
      sos.forEach((so) => v.soNumbers.add(so));
    }
    const vendors = Object.values(byVendor)
      .map((v) => ({ ...v, soNumbers: [...v.soNumbers].sort() }))
      .sort((a, b) => a.label.localeCompare(b.label));
    return {
      vendors,
      grandTotal: vendors.reduce((s, v) => s + v.total, 0),
      totalUnpriced: vendors.reduce((s, v) => s + v.unpriced, 0),
    };
  }, [priced, goldPrice, silverPrice, poGroups, aliasMap, soVendorsByPo, vendorsById, sampleMaps, siByStyle]);

  if (loading) return <Loading />;

  return (
    <div className="max-w-6xl">
      <div className="flex items-center justify-between mb-4 max-md:flex-col max-md:items-start max-md:gap-2">
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <Calculator className="w-6 h-6 text-[#C5A572]" /> Factory Costs
        </h1>
        <div className="flex items-center gap-3 max-md:flex-wrap">
          <label className="text-sm text-gray-600 flex items-center gap-1">
            Silver $/oz
            <input
              type="number"
              step="0.01"
              value={silverPrice}
              onChange={(e) => setSilverPrice(e.target.value)}
              className="border rounded px-2 py-1 w-24"
            />
          </label>
          <label className="text-sm text-gray-600 flex items-center gap-1">
            Gold $/oz
            <input
              type="number"
              step="0.01"
              value={goldPrice}
              onChange={(e) => setGoldPrice(e.target.value)}
              className="border rounded px-2 py-1 w-28"
            />
          </label>
          <button
            onClick={fetchAll}
            className="p-2 rounded hover:bg-gray-200"
            title="Refresh"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
          <button
            onClick={priceIt}
            disabled={busy || selected.length === 0}
            className="bg-[#C5A572] text-white px-4 py-2 rounded disabled:opacity-40"
          >
            {busy
              ? "Working..."
              : `Price it (${selected.length} SO${selected.length === 1 ? "" : "s"})`}
          </button>
        </div>
      </div>

      <p className="text-sm text-gray-500 mb-3">
        Estimated factory charges per item, from each sample's cost build-up
        (metal at the price above + labor + stones + plating, with the vendor's
        loss factor). Defaults to the live PLM metal price — type a different
        price to re-price instantly. Estimates only; the vendor SO confirmation
        is the final word.
      </p>

      {/* SO picker */}
      <div className="bg-white rounded shadow overflow-x-auto mb-6">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-gray-50 text-left">
              <th className="p-2 w-8"></th>
              <th className="p-2">Sales order</th>
              <th className="p-2">PO date</th>
              <th className="p-2 text-right">Lines</th>
              <th className="p-2 text-right">Units</th>
              <th className="p-2">Vendor SOs</th>
            </tr>
          </thead>
          <tbody>
            {poGroups.map((g) => (
              <tr key={g.po} className="border-b hover:bg-gray-50">
                <td className="p-2">
                  <input
                    type="checkbox"
                    checked={!!selectedPos[g.po]}
                    onChange={(e) =>
                      setSelectedPos((p) => ({ ...p, [g.po]: e.target.checked }))
                    }
                  />
                </td>
                <td className="p-2 font-medium">{g.po}</td>
                <td className="p-2">{g.date}</td>
                <td className="p-2 text-right">{g.lines.length}</td>
                <td className="p-2 text-right">
                  {g.lines
                    .reduce((s, l) => s + Number(l.order_qty || 0), 0)
                    .toLocaleString()}
                </td>
                <td className="p-2 text-xs text-gray-500">
                  {Object.entries(soVendorsByPo[g.po] || {})
                    .map(([v, sos]) => `${sos.join(",")} ${v}`)
                    .join(" · ") || "—"}
                </td>
              </tr>
            ))}
            {poGroups.length === 0 && (
              <tr>
                <td colSpan={6} className="p-6 text-center text-gray-400">
                  No open sales orders.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* cost view */}
      {costView && (
        <>
          <div className="flex items-baseline gap-4 mb-3">
            <h2 className="text-lg font-medium">
              Estimated total: {money(costView.grandTotal)}
            </h2>
            {costView.totalUnpriced > 0 && (
              <span className="text-sm text-yellow-700 flex items-center gap-1">
                <TriangleAlert className="w-4 h-4" />
                {costView.totalUnpriced} line(s) have no sample in the PLM — not
                included
              </span>
            )}
          </div>
          {costView.vendors.map((v) => (
            <div key={v.label} className="bg-white rounded shadow mb-4">
              <button
                className="w-full flex items-center justify-between p-3 text-left"
                onClick={() =>
                  setExpanded((p) => ({ ...p, [v.label]: !p[v.label] }))
                }
              >
                <div className="flex items-center gap-3">
                  {expanded[v.label] ? (
                    <ChevronDown className="w-4 h-4" />
                  ) : (
                    <ChevronRight className="w-4 h-4" />
                  )}
                  <span className="font-medium">{v.label}</span>
                  {v.soNumbers.length > 0 && (
                    <code className="text-xs bg-gray-100 px-2 py-0.5 rounded">
                      {v.soNumbers.join("-")} {v.label}
                    </code>
                  )}
                </div>
                <div className="flex items-center gap-4 text-sm">
                  <span className="text-gray-500">
                    {v.rows.length} lines · {v.units.toLocaleString()} pcs
                    {v.unpriced > 0 ? ` · ${v.unpriced} unpriced` : ""}
                  </span>
                  <span className="font-medium">{money(v.total)}</span>
                </div>
              </button>
              {expanded[v.label] && (
                <div className="border-t overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left text-gray-500 bg-gray-50">
                        <th className="p-2">SO</th>
                        <th className="p-2">SKU</th>
                        <th className="p-2">Style</th>
                        <th className="p-2">Metal</th>
                        <th className="p-2 text-right">Qty</th>
                        <th className="p-2 text-right">Metal $</th>
                        <th className="p-2 text-right">Unit cost</th>
                        <th className="p-2 text-right">Extended</th>
                      </tr>
                    </thead>
                    <tbody>
                      {v.rows
                        .slice()
                        .sort((a, b) => (b.extended || 0) - (a.extended || 0))
                        .map((r) => (
                          <tr
                            key={`${r.po_number}-${r.sku}`}
                            className="border-t border-gray-100"
                          >
                            <td className="p-2">{r.po_number}</td>
                            <td className="p-2">{r.sku}</td>
                            <td className="p-2">{r.model}</td>
                            <td className="p-2">
                              {r.si
                                ? `${r.si.metalType || "?"}${r.si.karat ? " " + r.si.karat : ""}`
                                : "—"}
                            </td>
                            <td className="p-2 text-right">
                              {Number(r.order_qty).toLocaleString()}
                            </td>
                            <td className="p-2 text-right">{money(r.metalCost)}</td>
                            <td className="p-2 text-right">{money(r.unit)}</td>
                            <td className="p-2 text-right font-medium">
                              {r.extended != null ? (
                                money(r.extended)
                              ) : (
                                <button
                                  className="text-yellow-700 underline"
                                  title="No sample in the PLM for this style — create it to price this line"
                                  onClick={() => setCreateFor(r.model)}
                                >
                                  no sample — create ⚠
                                </button>
                              )}
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ))}
        </>
      )}

      <AddSampleModal
        isOpen={!!createFor}
        initialValues={createFor ? { styleNumber: createFor, name: createFor } : null}
        onClose={() => setCreateFor(null)}
        onSave={async () => {
          setCreateFor(null);
          showMessage("Sample created — reloading, then hit Price it again");
          await fetchAll();
        }}
      />
    </div>
  );
}

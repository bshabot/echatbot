import React, { useEffect, useMemo, useState } from "react";
import { useSupabase } from "../SupaBaseProvider";
import { useMetalPriceStore } from "../../store/MetalPrices";
import {
  backEngineerMetalRate,
  recomputeSignetBill,
  rebillFromActualPrice,
  resolveMetal,
} from "../../utils/runningLinesMath";
import { publishedLockFor, isZeroedPoLine } from "../../utils/reconcilePOLines";
import { getWritableDocFolder, writeToFolder } from "../../utils/docFolder";
import { AlertTriangle, CheckCircle2, Download } from "lucide-react";
import { useAlert } from "../Alerts/AlertContext";

const MISMATCH_DOLLAR_THRESHOLD = 0.05; // line marked MISMATCH only if predicted differs from unit_price by more than 5¢

// Metal-weighted median of the implied $/oz across a PO's lines.
//
// Why weighted-median and not a 10¢ mode (old approach, replaced 2026-06-04):
// the old code rounded each implied rate to the nearest 10¢ and picked the
// most-common bucket, unweighted. That broke two ways:
//   1) Light/low-metal lines (sets, black-CZ, plated trinkets) produce a
//      meaningless implied $/oz, yet voted equally with real metal lines.
//   2) On a $78/oz value a 10¢ bucket is far too fine — real lines at 77.6 /
//      77.9 / 78.1 each landed in their OWN bucket and never formed a majority,
//      so a tight junk cluster could win.
// Result: PO 154125 silver lock detected as $247 (one tiny set line) → the
// S7839HE-GP line predicted at $30.67 vs Signet's $14.55 (−$4,594). PO 158256
// detected as $46 (light black-CZ cluster) → N2662NK/CZ-701/SPFB105 under-
// predicted by ~$1,687.
//
// Weighting each line's implied rate by its metal content (qty × net weight)
// and taking the median makes the lines that actually carry the metal set the
// lock, and is immune to outliers. Accepts bare numbers (back-compat) or
// { rate, weight } entries.
function detectModeRate(entries, bounds) {
  let norm = (entries || [])
    .map((e) => (typeof e === "number" ? { rate: e, weight: 1 } : e))
    .filter(
      (e) =>
        e &&
        Number.isFinite(e.rate) &&
        e.rate > 0 &&
        Number.isFinite(e.weight) &&
        e.weight > 0
    );
  if (norm.length === 0) return null;
  // Physical sanity filter (2026-06-04 v2): drop implied rates that can't be a
  // real metal lock. A 2-item set back-engineers to ~$246/oz silver and, with
  // enough metal weight, still won the weighted median on PO 154125. Only
  // applied when it leaves at least one rate, so a genuinely unusual PO still
  // detects from its own lines.
  if (bounds) {
    const inB = norm.filter((e) => e.rate >= bounds.min && e.rate <= bounds.max);
    if (inB.length) norm = inB;
  }
  norm.sort((a, b) => a.rate - b.rate);
  const totalW = norm.reduce((s, e) => s + e.weight, 0);
  let cum = 0;
  for (const e of norm) {
    cum += e.weight;
    if (cum >= totalW / 2) return e.rate;
  }
  return norm[norm.length - 1].rate;
}

function csvEscape(v) {
  if (v == null) return "";
  const s = String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

// Rebill CSVs go to the picked "rebills" folder when one is set (the OneDrive
// "ReBill From PLM" folder — see docFolder.js); otherwise a normal download.
// Returns "folder" | "download".
async function downloadAsCSV(filename, rows) {
  const csv = rows.map((r) => r.map(csvEscape).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const dir = await getWritableDocFolder("rebills");
  if (await writeToFolder(dir, filename, blob)) return "folder";
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  return "download";
}

export default function POLinesView({ po, onClose, onUpdate }) {
  const { supabase } = useSupabase();
  const { showAlert } = useAlert();
  const prices = useMetalPriceStore((s) => s.prices);

  // Re-bill inputs (default to today's spot + 4% upcharge per Brian)
  const [newSilver, setNewSilver] = useState(prices?.silver?.price ?? 30);
  const [newGold, setNewGold] = useState(prices?.gold?.price ?? 2400);
  const [upchargePct, setUpchargePct] = useState(4);
  const [baselineMode, setBaselineMode] = useState("signet"); // 'signet' | 'ssp'
  // Lock date picker — defaults to the PO's order date so opening the modal
  // shows the PO date pre-filled. Whenever the date changes (including the
  // initial mount), query metal_lock_history and auto-fill silver/gold.
  const [lockDate, setLockDate] = useState(po?.lock_date || po?.po_date || "");
  useEffect(() => {
    setLockDate(po?.lock_date || po?.po_date || "");
  }, [po?.id, po?.po_date, po?.lock_date]);
  useEffect(() => {
    if (!supabase || !lockDate) return;
    (async () => {
      const { data } = await supabase
        .from("metal_lock_history")
        .select("silver_lock, gold_lock")
        .eq("date", lockDate)
        .maybeSingle();
      if (data) {
        if (data.silver_lock != null) setNewSilver(Number(data.silver_lock));
        if (data.gold_lock != null) setNewGold(Number(data.gold_lock));
      }
    })();
  }, [supabase, lockDate]);

  const [lines, setLines] = useState([]);
  const [skuById, setSkuById] = useState(new Map());
  const [componentsBySsp, setComponentsBySsp] = useState(new Map());
  const [loading, setLoading] = useState(true);

  // Metal lock context (±10 days around PO date)
  const [lockHistory, setLockHistory] = useState([]);
  const [showLockHistory, setShowLockHistory] = useState(false);

  // Editable tariff % — lets Brian fix detection misses without leaving the modal
  const [tariffInput, setTariffInput] = useState(po.tariff_percent ?? 0);
  const [openIssue, setOpenIssue] = useState(null); // row whose known-issue popover is open
  useEffect(() => {
    setTariffInput(po.tariff_percent ?? 0);
  }, [po.id, po.tariff_percent]);

  async function saveTariff(newValue) {
    const n = Number(newValue);
    if (!Number.isFinite(n)) return;
    if (n === Number(po.tariff_percent)) return;
    const { error } = await supabase
      .from("running_line_purchase_orders")
      .update({ tariff_percent: n })
      .eq("id", po.id);
    if (error) {
      showAlert(error.message, { title: "Failed to update tariff", variant: "error" });
      return;
    }
    // Mutate the in-memory po so downstream calcs use the new value
    po.tariff_percent = n;
    // Notify parent so the PO list row updates immediately
    onUpdate?.({ id: po.id, tariff_percent: n });
  }

  // Persist the chosen lock date so reopening the PO restores it instead of
  // snapping back to the order date.
  async function saveLockDate(newDate) {
    const val = newDate || null;
    if (val === (po.lock_date || null)) return;
    const { error } = await supabase
      .from("running_line_purchase_orders")
      .update({ lock_date: val })
      .eq("id", po.id);
    if (error) {
      showAlert(error.message, { title: "Failed to save lock date", variant: "error" });
      return;
    }
    po.lock_date = val;
    onUpdate?.({ id: po.id, lock_date: val });
  }

  // Fetch the ±5d lock window when PO changes
  useEffect(() => {
    if (!supabase || !po?.po_date) {
      setLockHistory([]);
      return;
    }
    (async () => {
      const d = new Date(po.po_date);
      const start = new Date(d); start.setDate(d.getDate() - 10);
      const end = new Date(d); end.setDate(d.getDate() + 10);
      const fmt = (x) => x.toISOString().slice(0, 10);
      const { data } = await supabase
        .from("metal_lock_history")
        .select("date, silver_lock, gold_lock")
        .gte("date", fmt(start))
        .lte("date", fmt(end))
        .order("date", { ascending: true });
      setLockHistory(data ?? []);
    })();
  }, [supabase, po?.po_date]);

  useEffect(() => {
    if (!supabase || !po) return;
    (async () => {
      setLoading(true);
      const { data: lineRows } = await supabase
        .from("running_line_po_items")
        .select("*")
        .eq("po_id", po.id)
        .order("line_number", { ascending: true });
      setLines(lineRows ?? []);

      const skuNumbers = [...new Set((lineRows ?? []).map((l) => l.sku_number).filter(Boolean))];
      const vsns = [...new Set((lineRows ?? []).map((l) => l.vendor_style_number).filter(Boolean))];

      const { data: skuRows } = await supabase
        .from("running_line_skus")
        .select("*")
        .or(
          [
            skuNumbers.length ? `sku_number.in.(${skuNumbers.join(",")})` : null,
            vsns.length ? `vendor_style_number.in.(${vsns.join(",")})` : null,
          ]
            .filter(Boolean)
            .join(",")
        );

      // Build the lookup. When two SKU records share a key (duplicate style —
      // e.g. an old SSP and its re-scraped "-new" twin, or two rows with the
      // exact same vendor_style_number like N2109E / N2224E-SET), keep the most
      // recently scraped/updated one so prediction is deterministic instead of
      // depending on row order. Added 2026-06-04.
      const map = new Map();
      const ts = (s) => Date.parse(s?.last_scraped_at || s?.updated_at || "") || 0;
      const setBest = (key, s) => {
        const cur = map.get(key);
        if (!cur || ts(s) >= ts(cur)) map.set(key, s);
      };
      for (const s of skuRows ?? []) {
        if (s.sku_number) setBest(`sku:${s.sku_number}`, s);
        if (s.vendor_style_number) setBest(`vsn:${s.vendor_style_number}`, s);
      }
      setSkuById(map);

      const sspList = (skuRows ?? []).map((s) => s.ssp_number);
      if (sspList.length) {
        const [
          { data: matRows },
          { data: findRows },
          { data: chainRows },
        ] = await Promise.all([
          supabase
            .from("running_line_materials")
            .select(
              "ssp_number,material_type,metal_purity,metal_karat,metal_color,material_net_weight,metal_base_price,metal_loss_percent,material_cost"
            )
            .in("ssp_number", sspList),
          supabase
            .from("running_line_findings")
            .select(
              "ssp_number,finding_type,finding_net_weight,metal_purity,metal_base_price,metal_loss_percent,finding_material_cost"
            )
            .in("ssp_number", sspList),
          supabase
            .from("running_line_chains")
            .select(
              "ssp_number,chain_type,chain_net_weight,metal_purity,metal_karat,metal_base_price,metal_loss_percent,chain_material_cost"
            )
            .in("ssp_number", sspList),
        ]);
        const m = new Map();
        const push = (rows) => {
          for (const r of rows ?? []) {
            if (!m.has(r.ssp_number)) m.set(r.ssp_number, []);
            m.get(r.ssp_number).push(r);
          }
        };
        push(matRows);
        push(findRows);
        push(chainRows);
        setComponentsBySsp(m);
      }
      setLoading(false);
    })();
  }, [supabase, po]);

  // Step 1: Match each line to its SKU + materials and compute implied rate.
  // Uses tariffInput (the live editable value) so editing the tariff in the
  // modal recomputes immediately.
  const enriched = useMemo(() => {
    const tariffPct = Number(tariffInput ?? 0);
    const upchargeAtPo = Number(po.upcharge_percent ?? 0);
    return lines.map((line) => {
      const sku =
        (line.sku_number && skuById.get(`sku:${line.sku_number}`)) ||
        (line.vendor_style_number && skuById.get(`vsn:${line.vendor_style_number}`)) ||
        null;
      const components = sku ? componentsBySsp.get(sku.ssp_number) || [] : [];
      const metal = sku ? resolveMetal(components) : null;

      const impliedRate = sku
        ? backEngineerMetalRate(line, sku, components, { tariffPct, upchargePct: upchargeAtPo })
        : null;

      return { line, sku, materials: components, metal, impliedRate };
    });
  }, [lines, skuById, componentsBySsp, po, tariffInput]);

  // Step 2: Detect the PO's metal locks — ONE PER METAL TYPE.
  // Per Brian / SSP: signet updates weekly silver lock + weekly gold lock every
  // Friday. ALL silver SKUs on a PO share the silver lock; ALL gold SKUs share
  // the gold lock. Mixing metals into a single mode is wrong.
  const detectedLocks = useMemo(() => {
    // Two pools per metal: single-item lines are the trusted voters. Set lines
    // (item_count > 1) back-engineer less reliably, so they only vote when the
    // PO has NO single-item line of that metal — e.g. PO 152109 is brass + one
    // silver set; with a hard set-block the silver lock came back null and the
    // set was predicted at no lock. Fallback chain: singles → sets (still
    // sanity-bounded) → published lock for the PO date.
    const pools = {
      Silver: { single: [], set: [] },
      Gold: { single: [], set: [] },
    };
    for (const e of enriched) {
      if (e.impliedRate == null || !e.metal) continue;
      if (isZeroedPoLine(e.line)) continue; // zeroed SKUs are dead — no lock vote
      if (e.sku?.known_issue) continue; // flagged billing defects don't vote on the lock
      const mt = e.metal.metalType;
      if (!pools[mt]) continue;
      // Weight each line by its metal content (qty × net weight) so the lines
      // that actually carry metal set the lock. Light lines fall to ~0 weight.
      const weight =
        (Number(e.sku?.total_net_weight) || 0.0001) * (Number(e.line?.quantity) || 1);
      const entry = { rate: e.impliedRate, weight };
      (Number(e.sku?.item_count) > 1 ? pools[mt].set : pools[mt].single).push(entry);
    }
    const published = publishedLockFor(
      new Map((lockHistory || []).map((r) => [r.date, r])),
      po?.po_date
    );
    // Sanity bands keep junk implied rates (e.g. $246/oz silver) from setting
    // the lock. DATE-AWARE (2026-06-05): bands scale off the published lock for
    // the PO date (0.6x–1.6x) so 2024-era POs (silver ~$29, gold ~$2,400) don't
    // get their honest votes filtered by 2026-sized static bands. Static bands
    // are the fallback when no published lock exists for the date. Votes still
    // come ONLY from the PO's own lines.
    const boundsFor = (pub, fallback) =>
      pub != null && Number(pub) > 0 ? { min: Number(pub) * 0.6, max: Number(pub) * 1.6 } : fallback;
    const pick = (mt, staticBounds, pubField) => {
      const pub = published && published[pubField] != null ? Number(published[pubField]) : null;
      const bounds = boundsFor(pub, staticBounds);
      // HARD window when published exists (kills $240-style garbage), then
      // corroboration: a LONE vote >15% off published is untrusted -> published;
      // 2+ agreeing votes trusted at any distance (weekly lock lags fast markets).
      const hard = (arr) => (pub != null ? arr.filter((e) => e.rate >= bounds.min && e.rate <= bounds.max) : arr);
      const choose = (arr) => {
        const survivors = hard(arr);
        const m = detectModeRate(survivors, pub != null ? null : bounds);
        if (m == null) return null;
        if (pub != null && survivors.length === 1 && Math.abs(m / pub - 1) > 0.3) return null;
        return m;
      };
      return choose(pools[mt].single) ?? choose(pools[mt].set) ?? pub;
    };
    return {
      silver: pick("Silver", { min: 30, max: 150 }, "silver_lock"),
      gold: pick("Gold", { min: 2500, max: 7000 }, "gold_lock"),
    };
  }, [enriched, lockHistory, po?.po_date]);

  // Editable locks: defaults to detected per metal, Brian can override either
  const [silverLockOverride, setSilverLockOverride] = useState(null);
  const [goldLockOverride, setGoldLockOverride] = useState(null);
  const silverLock =
    silverLockOverride != null ? silverLockOverride : detectedLocks.silver;
  const goldLock =
    goldLockOverride != null ? goldLockOverride : detectedLocks.gold;

  // Reset overrides when PO changes
  useEffect(() => {
    setSilverLockOverride(null);
    setGoldLockOverride(null);
  }, [po?.id]);

  // For backward compatibility with per-line `lock` reference: pick the lock
  // matching the line's metal type
  const lockForLine = (metalType) =>
    metalType === "Gold" ? goldLock : metalType === "Brass" ? null : silverLock;

  // Step 3: Per-line reconciliation + new-bill computation
  const reconciled = useMemo(() => {
    const oldTariff = Number(tariffInput ?? 0);
    const oldUpcharge = Number(po.upcharge_percent ?? 0);
    const newTariff = Number(tariffInput ?? 0); // keep tariff from original PO
    const isReverseDir = po.direction === "reverse";

    return enriched.map((e) => {
      // Pick the lock for THIS line's metal
      const lineLock = e.metal ? lockForLine(e.metal.metalType) : null;

      // Predicted price at the per-metal PO lock, using OUR SSP data + Brian's
      // formula. Goal: match Signet's actual unit_price.
      // Upcharge is INTENTIONALLY 0 here — Signet doesn't add upcharge,
      // that's Brian's markup on top when HE bills. So predicted = piece × (1+tariff).
      // Brass lines have lineLock=null (no metal exposure); recomputeSignetBill
      // handles brass cleanly — metal stack returns 0, piece flows through.
      let predictedAtLock = null;
      if (e.sku && e.materials.length > 0) {
        predictedAtLock = recomputeSignetBill(e.sku, e.materials, {
          silver: silverLock ?? lineLock ?? 0,
          gold: goldLock ?? lineLock ?? 0,
          tariffPct: oldTariff,
          upchargePct: 0, // Signet doesn't apply upcharge — that's Brian's, not theirs
        });
      }
      // Zeroed SKUs (qty + extension wiped, stale unit_price left behind) are
      // excluded from reconciliation entirely — no mismatch, no confidence hit.
      const signetVsOurs =
        predictedAtLock != null && e.line.unit_price && !isZeroedPoLine(e.line)
          ? Number(e.line.unit_price) - predictedAtLock
          : null;

      // Reconcile based on DOLLAR diff between predicted and actual unit price.
      // Within $0.05 = matched; more than $0.05 off = MISMATCH.
      const reconcile =
        signetVsOurs != null
          ? Math.abs(signetVsOurs) <= MISMATCH_DOLLAR_THRESHOLD
          : null;

      // newBill: depends on baselineMode and direction
      let newBill = null;
      if (e.sku && e.materials.length > 0) {
        // For brass (lineLock null), still use the signet-baseline path —
        // rebillFromActualPrice handles no-metal-exposure cases correctly.
        const useSignetBaseline =
          baselineMode === "signet" && isReverseDir && e.line.unit_price;
        if (useSignetBaseline) {
          newBill = rebillFromActualPrice(e.line, e.sku, e.materials, {
            oldTariffPct: oldTariff,
            oldUpchargePct: oldUpcharge,
            oldLockRate: e.impliedRate || lineLock,
            newSilver,
            newGold,
            newTariffPct: newTariff,
            newUpchargePct: upchargePct,
          });
        } else {
          newBill = recomputeSignetBill(e.sku, e.materials, {
            silver: newSilver,
            gold: newGold,
            tariffPct: newTariff,
            upchargePct,
          });
        }
      }

      // Signet-price floor (Brian's rule, 2026-06-05): if Signet's own PO price
      // is HIGHER than our computed new bill, bill THEIR number — never hand a
      // billing mistake back. Applies to every line, including ones where the
      // metal lock dropped (intentional). Diagnostics (predicted / reconcile /
      // anomaly detection) are NOT floored — only the bill.
      let flooredToSignet = false;
      if (
        newBill != null &&
        e.line.unit_price != null &&
        Number(e.line.unit_price) > newBill
      ) {
        newBill = Number(e.line.unit_price);
        flooredToSignet = true;
      }

      const newExtension =
        newBill != null && e.line.quantity ? newBill * Number(e.line.quantity) : null;
      const deltaPerUnit =
        newBill != null && e.line.unit_price != null
          ? newBill - Number(e.line.unit_price)
          : null;
      const deltaTotal =
        deltaPerUnit != null && e.line.quantity != null
          ? deltaPerUnit * Number(e.line.quantity)
          : null;

      return {
        ...e,
        reconcile,
        predictedAtLock,
        signetVsOurs,
        newBill,
        flooredToSignet,
        newExtension,
        deltaPerUnit,
        deltaTotal,
      };
    });
  }, [enriched, silverLock, goldLock, po, newSilver, newGold, upchargePct, baselineMode, tariffInput]);

  // PO-level reconciliation summary
  const summary = useMemo(() => {
    let matched = 0,
      mismatched = 0,
      unmatched = 0;
    let oldTotal = 0,
      newTotal = 0;
    let dollarGap = 0;
    for (const r of reconciled) {
      if (!r.sku) unmatched++;
      else if (r.reconcile === true) matched++;
      else if (r.reconcile === false) mismatched++;
      oldTotal += Number(r.line.total_price ?? r.line.unit_price * (r.line.quantity || 1)) || 0;
      newTotal += Number(r.newExtension) || 0;
      if (r.signetVsOurs != null && r.line.quantity) {
        dollarGap += Math.abs(r.signetVsOurs) * Number(r.line.quantity);
      }
    }
    // Confidence score 0-100. Tuned so that a small number of small mismatches
    // still scores well, but lots of misses (even small ones) drag confidence
    // down. One big outlier also drops it.
    //   - Count penalty: 5 points per mismatched line (>$0.03 off)
    //   - Size penalty: max-mismatch × 5, capped at 50 (one $10 outlier costs 50)
    const cleanDiffs = [];
    let flaggedMismatchCount = 0;
    for (const r of reconciled) {
      if (r.signetVsOurs == null || !r.sku) continue;
      const d = Math.abs(r.signetVsOurs);
      if (r.sku.known_issue) {
        if (d > 0.03) flaggedMismatchCount++; // known issue — counted lightly below
      } else {
        cleanDiffs.push(d);
      }
    }
    let confidence = null;
    let confidenceLabel = "—";
    if (cleanDiffs.length > 0 || flaggedMismatchCount > 0) {
      const mismatched = cleanDiffs.filter((d) => d > 0.03);
      const mismatchCount = mismatched.length;
      const maxMismatch = mismatched.length ? Math.max(...mismatched) : 0;
      // Known-issue lines cost 1 point each (their miss is explained);
      // UNKNOWN mismatches cost the full 5 and drive the size penalty.
      const countPenalty = mismatchCount * 5 + flaggedMismatchCount * 1;
      const sizePenalty = Math.min(50, maxMismatch * 5);
      confidence = Math.max(0, 100 - countPenalty - sizePenalty);
      confidenceLabel =
        confidence >= 90 ? "High" : confidence >= 70 ? "Medium" : confidence >= 50 ? "Low" : "Very Low";
    }
    return {
      matched,
      mismatched,
      unmatched,
      total: reconciled.length,
      oldTotal,
      newTotal,
      delta: newTotal - oldTotal,
      dollarGap,
      confidence,
      confidenceLabel,
    };
  }, [reconciled]);

  // Persist the confidence score back to the PO record so the list view shows
  // it without having to open every PO. Debounced — only writes when the
  // computed score differs from what's stored.
  useEffect(() => {
    if (!supabase || !po?.id) return;
    if (summary.confidence == null) return;
    const stored = po.confidence_score == null ? null : Number(po.confidence_score);
    const next = Math.round(summary.confidence);
    if (stored === next) return;
    const handle = setTimeout(async () => {
      const { error } = await supabase
        .from("running_line_purchase_orders")
        .update({ confidence_score: next })
        .eq("id", po.id);
      if (!error) {
        po.confidence_score = next;
        onUpdate?.({ id: po.id, confidence_score: next });
      }
    }, 800);
    return () => clearTimeout(handle);
  }, [supabase, po?.id, summary.confidence]);

  const handleDownloadCSV = async () => {
    // Export date (ET) — stamped into the Memo cell per Brian (not the QB
    // import date). Same 11-column format as the multi-PO "Export all lines".
    const exportMD = (() => {
      const iso = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
      const p = iso.split("-");
      return p.length === 3 ? `${Number(p[1])}/${Number(p[2])}` : iso;
    })();
    const memoCell = po.memo ? `updated ${exportMD} ${po.memo}` : "";
    const header = [
      "PO #",
      "PO Date",
      "Ship Date",
      "Due Date",
      "Lock Date Used",
      "SKU",
      "Style #",
      "Qty",
      "Signet Price",
      "New Price",
      "Memo",
    ];
    // New Price = this PO's current rebill (newBill already respects the chosen
    // lock date, metals, upcharge, and the Signet-price floor).
    const rows = reconciled.map((r) => [
      po.po_number || "",
      po.po_date || "",
      po.ship_date || "",
      po.due_date || "",
      lockDate || po.lock_date || po.po_date || "",
      r.line.sku_number || "",
      r.line.vendor_style_number || "",
      r.line.quantity ?? "",
      r.line.unit_price ?? "",
      r.newBill != null ? r.newBill.toFixed(2) : "",
      memoCell,
    ]);
    const stamp = new Date().toISOString().slice(0, 10);
    const filename = `PO_${po.po_number || po.id.slice(0, 8)}_rebill_${stamp}.csv`;
    const where = await downloadAsCSV(filename, [header, ...rows]);
    if (where === "folder") showAlert(`Saved ${filename} to your rebills folder`, { variant: "success" });
  };

  const dollar = (n) =>
    n == null || !Number.isFinite(Number(n))
      ? "—"
      : Number(n).toLocaleString("en-US", { style: "currency", currency: "USD" });
  const pct = (n) => (n == null ? "—" : `${n.toFixed(2)}%`);

  const isReverse = po.direction === "reverse";

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-start justify-center p-4 overflow-y-auto max-md:p-2">
      <div className="bg-white rounded-lg shadow-xl max-w-7xl w-full my-8 max-md:my-2">
        {/* Header */}
        <div className="flex items-start justify-between p-4 border-b">
          <div>
            <h3 className="text-lg font-semibold text-gray-900">
              PO {po.po_number || po.id.slice(0, 8)} ·{" "}
              {isReverse ? "Signet → me (reverse)" : "Factory → me (forward)"}
            </h3>
            <div className="text-sm text-gray-500 mt-1 flex items-center gap-2 flex-wrap">
              <span className="font-semibold text-gray-800">{po.po_date || "—"}</span>
              <span>·</span>
              <span>{po.supplier || "—"}</span>
              <span>·</span>
              <span>{po.line_count ?? lines.length} lines</span>
              <span>·</span>
              <span className="inline-flex items-center gap-1">
                tariff
                <input
                  type="number"
                  value={tariffInput}
                  onChange={(e) => setTariffInput(e.target.value)}
                  onBlur={(e) => saveTariff(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.currentTarget.blur();
                  }}
                  step="0.1"
                  className="w-16 px-1 py-0.5 border border-gray-300 rounded text-sm focus:border-[#C5A572] focus:outline-none"
                />
                %
              </span>
            </div>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl px-2 max-md:p-2">
            ×
          </button>
        </div>

        {/* PO-level summary tiles */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 p-4 border-b bg-gray-50">
          <div>
            <div className="text-xs text-gray-500 uppercase tracking-wider">PO silver lock</div>
            <input
              type="number"
              value={silverLock != null ? silverLock.toFixed(2) : ""}
              onChange={(e) => setSilverLockOverride(Number(e.target.value) || null)}
              className="input text-xl font-semibold text-gray-900 w-full mt-1"
              step="0.01"
            />
            <div className="text-xs text-gray-500 mt-1">
              detected: {detectedLocks.silver ? `$${detectedLocks.silver.toFixed(2)}` : "—"}
              {silverLockOverride != null && (
                <button
                  onClick={() => setSilverLockOverride(null)}
                  className="ml-2 text-blue-600 hover:underline"
                >
                  reset
                </button>
              )}
            </div>
          </div>
          <div>
            <div className="text-xs text-gray-500 uppercase tracking-wider">PO gold lock</div>
            <input
              type="number"
              value={goldLock != null ? goldLock.toFixed(2) : ""}
              onChange={(e) => setGoldLockOverride(Number(e.target.value) || null)}
              className="input text-xl font-semibold text-gray-900 w-full mt-1"
              step="0.01"
            />
            <div className="text-xs text-gray-500 mt-1">
              detected: {detectedLocks.gold ? `$${detectedLocks.gold.toFixed(2)}` : "—"}
              {goldLockOverride != null && (
                <button
                  onClick={() => setGoldLockOverride(null)}
                  className="ml-2 text-blue-600 hover:underline"
                >
                  reset
                </button>
              )}
            </div>
          </div>
          <div>
            <div className="text-xs text-gray-500 uppercase tracking-wider">Data confidence</div>
            <div
              className={`text-xl font-semibold ${
                summary.confidence == null
                  ? "text-gray-400"
                  : summary.confidence >= 90
                  ? "text-green-600"
                  : summary.confidence >= 70
                  ? "text-amber-600"
                  : "text-red-600"
              }`}
            >
              {summary.confidence != null ? `${summary.confidence.toFixed(0)}%` : "—"}{" "}
              <span className="text-sm text-gray-500">{summary.confidenceLabel}</span>
            </div>
            <div className="text-xs text-gray-500">
              {summary.matched}/{summary.total} clean · {summary.mismatched} mismatch · ±${summary.dollarGap.toFixed(2)} total gap
            </div>
          </div>
          <div>
            <div className="text-xs text-gray-500 uppercase tracking-wider">Original total</div>
            <div className="text-xl font-semibold text-gray-900">{dollar(summary.oldTotal)}</div>
          </div>
          <div>
            <div className="text-xs text-gray-500 uppercase tracking-wider">New total</div>
            <div className="text-xl font-semibold text-gray-900">{dollar(summary.newTotal)}</div>
            <div
              className={`text-xs ${
                summary.delta >= 0 ? "text-green-600" : "text-red-600"
              }`}
            >
              {summary.delta >= 0 ? "+" : ""}
              {dollar(summary.delta)} vs original
            </div>
          </div>
        </div>

        {/* Metal lock context: ±5 days around PO date (collapsible) */}
        {po.po_date && (
          <div className="border-b">
            <button
              onClick={() => setShowLockHistory((v) => !v)}
              className="w-full px-4 py-2 text-left text-xs font-medium text-gray-600 hover:bg-gray-50 flex items-center justify-between"
            >
              <span>
                Metal lock context · 10 days before/after {po.po_date}
                {lockHistory.length > 0 && (
                  <span className="text-gray-400 ml-2">({lockHistory.length} days)</span>
                )}
              </span>
              <span className="text-gray-400">{showLockHistory ? "▾ hide" : "▸ show"}</span>
            </button>
            {showLockHistory && (
              <div className="px-4 pb-3">
                {lockHistory.length === 0 ? (
                  <div className="text-xs text-gray-500 italic">
                    No metal lock records for this date range. Add them on /metal-locks.
                  </div>
                ) : (
                  <table className="text-xs w-full max-w-lg">
                    <thead className="text-gray-500 uppercase tracking-wider">
                      <tr>
                        <th className="text-left py-1">Date</th>
                        <th className="text-left py-1">Day</th>
                        <th className="text-right py-1">Silver $/oz</th>
                        <th className="text-right py-1">Gold $/oz</th>
                      </tr>
                    </thead>
                    <tbody>
                      {lockHistory.map((r) => {
                        const isOrderDate = r.date === po.po_date;
                        // Parse YYYY-MM-DD as local date (avoid UTC shift)
                        const [yy, mm, dd] = r.date.split("-").map(Number);
                        const dayName = new Date(yy, mm - 1, dd).toLocaleDateString("en-US", { weekday: "short" });
                        const isWeekend = dayName === "Sat" || dayName === "Sun";
                        return (
                          <tr
                            key={r.date}
                            className={
                              isOrderDate
                                ? "bg-amber-50 font-semibold text-gray-900"
                                : isWeekend
                                ? "text-gray-400"
                                : "text-gray-700"
                            }
                          >
                            <td className="font-mono py-0.5">
                              {r.date}
                              {isOrderDate && (
                                <span className="ml-2 text-amber-700 text-[10px] uppercase">
                                  order date
                                </span>
                              )}
                            </td>
                            <td className="py-0.5">{dayName}</td>
                            <td className="text-right py-0.5">
                              {r.silver_lock != null ? `$${Number(r.silver_lock).toFixed(2)}` : "—"}
                            </td>
                            <td className="text-right py-0.5">
                              {r.gold_lock != null ? `$${Number(r.gold_lock).toFixed(2)}` : "—"}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </div>
        )}

        {/* Re-bill controls */}
        <div className="p-4 border-b flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-xs text-gray-600 mb-1">
              Lock date
              <span className="text-gray-400 ml-1">(fills silver/gold)</span>
            </label>
            <input
              type="date"
              value={lockDate}
              onChange={(e) => {
                setLockDate(e.target.value);
                saveLockDate(e.target.value);
              }}
              className="input w-40"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-600 mb-1">New silver $/oz</label>
            <input
              type="number"
              value={newSilver}
              onChange={(e) => setNewSilver(Number(e.target.value) || 0)}
              className="input w-32"
              step="0.01"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-600 mb-1">New gold $/oz</label>
            <input
              type="number"
              value={newGold}
              onChange={(e) => setNewGold(Number(e.target.value) || 0)}
              className="input w-32"
              step="0.01"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-600 mb-1">Upcharge %</label>
            <input
              type="number"
              value={upchargePct}
              onChange={(e) => setUpchargePct(Number(e.target.value) || 0)}
              className="input w-24"
              step="0.1"
            />
          </div>
          {isReverse && (
            <div>
              <label className="block text-xs text-gray-600 mb-1">Rebill baseline</label>
              <div className="flex gap-1 text-xs">
                <button
                  onClick={() => setBaselineMode("signet")}
                  className={`px-2 py-1.5 rounded border ${
                    baselineMode === "signet"
                      ? "bg-[#C5A572] text-white border-[#C5A572]"
                      : "bg-white text-gray-700 border-gray-300"
                  }`}
                >
                  Signet's price
                </button>
                <button
                  onClick={() => setBaselineMode("ssp")}
                  className={`px-2 py-1.5 rounded border ${
                    baselineMode === "ssp"
                      ? "bg-[#C5A572] text-white border-[#C5A572]"
                      : "bg-white text-gray-700 border-gray-300"
                  }`}
                >
                  Our SSP data
                </button>
              </div>
            </div>
          )}
          <div className="ml-auto max-md:ml-0 max-md:w-full">
            <button
              onClick={handleDownloadCSV}
              className="px-4 py-2 bg-[#C5A572] hover:bg-[#B89660] text-white rounded text-sm flex items-center gap-2 max-md:w-full max-md:justify-center"
            >
              <Download className="w-4 h-4" />
              Download CSV
            </button>
          </div>
        </div>

        {/* Lines table */}
        {loading ? (
          <div className="p-8 text-center text-gray-500">loading...</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs uppercase tracking-wider text-gray-500">
                <tr>
                  <th className="px-3 py-2">SKU</th>
                  <th className="px-3 py-2">Style #</th>
                  <th className="px-3 py-2">Metal</th>
                  <th className="px-3 py-2 text-right">Qty</th>
                  <th className="px-3 py-2 text-right">Signet Unit</th>
                  <th className="px-3 py-2 text-right">Predicted (ours)</th>
                  <th className="px-3 py-2 text-right">Signet vs Ours</th>
                  <th className="px-3 py-2 text-right">Implied $/oz</th>
                  <th className="px-3 py-2 text-center">Reconcile</th>
                  <th className="px-3 py-2 text-right">New Unit</th>
                  <th className="px-3 py-2 text-right">Δ Unit</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {reconciled.map((r) => {
                  const rowLock = r.metal ? lockForLine(r.metal.metalType) : null;
                  const impliedPct =
                    rowLock != null && r.impliedRate != null
                      ? ((r.impliedRate - rowLock) / rowLock) * 100
                      : null;
                  return (
                    <tr key={r.line.id} className="hover:bg-gray-50">
                      <td className="px-3 py-2 font-mono">{r.line.sku_number || "—"}</td>
                      <td className="px-3 py-2 font-mono">{r.line.vendor_style_number || "—"}</td>
                      <td className="px-3 py-2 text-xs text-gray-600">
                        {r.metal ? `${r.metal.metalType} ${r.metal.karat ?? ""}`.trim() : "?"}
                      </td>
                      <td className="px-3 py-2 text-right">{r.line.quantity ?? "—"}</td>
                      <td className="px-3 py-2 text-right">{dollar(r.line.unit_price)}</td>
                      <td className="px-3 py-2 text-right text-gray-700">
                        {dollar(r.predictedAtLock)}
                      </td>
                      <td
                        className={`px-3 py-2 text-right ${
                          r.signetVsOurs == null
                            ? ""
                            : Math.abs(r.signetVsOurs) < 0.05
                            ? "text-gray-500"
                            : r.signetVsOurs > 0
                            ? "text-green-600"
                            : "text-red-600"
                        }`}
                      >
                        {r.signetVsOurs == null
                          ? "—"
                          : `${r.signetVsOurs >= 0 ? "+" : ""}${dollar(r.signetVsOurs)}`}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {r.impliedRate ? `$${r.impliedRate.toFixed(2)}` : "—"}
                        {impliedPct != null && Math.abs(impliedPct) > 0.01 && (
                          <span
                            className={`block text-xs ${
                              Math.abs(impliedPct) < 1 ? "text-gray-500" : "text-red-500"
                            }`}
                          >
                            {impliedPct >= 0 ? "+" : ""}
                            {pct(impliedPct)} vs lock
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-center">
                        {!r.sku ? (
                          <span className="text-xs text-amber-600 inline-flex items-center gap-1">
                            <AlertTriangle className="w-3 h-3" /> no match
                          </span>
                        ) : r.reconcile === true ? (
                          <span className="text-xs text-green-600 inline-flex items-center gap-1">
                            <CheckCircle2 className="w-3 h-3" /> ok
                          </span>
                        ) : r.sku?.known_issue ? (
                          <span className="relative inline-block">
                            <button
                              type="button"
                              onClick={() => setOpenIssue(openIssue === r ? null : r)}
                              className="text-xs text-amber-600 inline-flex items-center gap-1 underline decoration-dotted cursor-pointer"
                            >
                              <AlertTriangle className="w-3 h-3" /> known issue
                            </button>
                            {openIssue === r && (
                              <div className="absolute z-50 right-0 top-5 w-64 max-md:w-56 max-md:max-w-[75vw] p-2 bg-amber-50 border border-amber-300 rounded shadow-lg text-left text-xs text-amber-900 whitespace-normal">
                                {r.sku.known_issue_exact
                                  ? r.sku.known_issue
                                  : "Known issue — flagged; root cause not confirmed to the penny yet"}
                              </div>
                            )}
                          </span>
                        ) : (
                          <span className="text-xs text-red-600 inline-flex items-center gap-1">
                            <AlertTriangle className="w-3 h-3" /> mismatch
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {dollar(r.newBill)}
                        {r.flooredToSignet && (
                          <span
                            className="text-amber-600 cursor-help"
                            title="Floored to Signet's billed price (their number was higher than our computed bill)"
                          >
                            *
                          </span>
                        )}
                      </td>
                      <td
                        className={`px-3 py-2 text-right ${
                          r.deltaPerUnit == null
                            ? ""
                            : r.deltaPerUnit > 0
                            ? "text-green-600"
                            : "text-red-600"
                        }`}
                      >
                        {r.deltaPerUnit == null
                          ? "—"
                          : `${r.deltaPerUnit >= 0 ? "+" : ""}${dollar(r.deltaPerUnit)}`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="p-4 border-t flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

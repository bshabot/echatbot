import React, { useState } from "react";
import { Flag, ExternalLink, StickyNote, AlertTriangle, Plus } from "lucide-react";

const dollar = (n) =>
  n == null || !Number.isFinite(Number(n))
    ? "—"
    : Number(n).toLocaleString("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 2,
      });

const dbHost = process.env.VITE_DB_HOST_URL || "";

function resolveImage(url) {
  if (!url) return null;
  if (url.startsWith("http")) return url;
  return `${dbHost}${url}`;
}

export default function SkuCard({ sku, onToggleFlag, onSaveNote, onCreateSample }) {
  const [showNote, setShowNote] = useState(false);
  const [noteDraft, setNoteDraft] = useState(sku.note || "");
  const [showDetail, setShowDetail] = useState(false);

  const matched = !!sku.sample;
  const marginPositive = (sku.margin ?? 0) > 0;
  const marginColor =
    sku.margin == null
      ? "text-gray-400"
      : marginPositive
      ? "text-green-600"
      : "text-red-600";

  return (
    <div
      className={`bg-white rounded-lg shadow-sm border p-4 flex flex-col gap-3 ${
        sku.flagged ? "border-amber-400" : "border-gray-200"
      }`}
    >
      {/* Header row */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-gray-900 truncate">
            {sku.sku_number || sku.vendor_style_number || sku.ssp_number}
          </div>
          <div className="text-xs text-gray-500 truncate">
            {sku.ssp_number}
            {sku.vendor_style_number ? ` · ${sku.vendor_style_number}` : ""}
            {sku.metal?.metalType
              ? ` · ${sku.metal.metalType}${sku.metal.karat ? ` ${sku.metal.karat}` : ""}`
              : ""}
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            title={sku.flagged ? "Unflag" : "Flag for follow-up"}
            onClick={onToggleFlag}
            className={`p-1 rounded hover:bg-gray-100 ${
              sku.flagged ? "text-amber-500" : "text-gray-400"
            }`}
          >
            <Flag className="w-4 h-4" />
          </button>
          <button
            title="Add note"
            onClick={() => setShowNote((v) => !v)}
            className={`p-1 rounded hover:bg-gray-100 ${
              sku.note ? "text-blue-500" : "text-gray-400"
            }`}
          >
            <StickyNote className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Image */}
      <div className="aspect-square w-full bg-gray-50 rounded flex items-center justify-center overflow-hidden">
        {sku.image_url ? (
          <img
            src={resolveImage(sku.image_url)}
            alt={sku.sku_number || sku.ssp_number}
            className="w-full h-full object-contain"
            onError={(e) => {
              e.currentTarget.style.display = "none";
            }}
          />
        ) : (
          <div className="text-xs text-gray-400">no image</div>
        )}
      </div>

      {/* Cost rows */}
      <div className="space-y-1 text-sm">
        <div className="flex justify-between">
          <span className="text-gray-500">Factory</span>
          {matched ? (
            <span className="text-gray-900">{dollar(sku.factoryCost)}</span>
          ) : (
            <button
              onClick={onCreateSample}
              className="text-xs text-blue-600 hover:text-blue-700 underline flex items-center gap-1"
            >
              <Plus className="w-3 h-3" /> create sample
            </button>
          )}
        </div>
        <div className="flex justify-between">
          <span className="text-gray-500">Signet bill</span>
          <span className="text-gray-900">{dollar(sku.signetBill)}</span>
        </div>
        <div className="flex justify-between items-baseline border-t pt-1 mt-1">
          <span className="text-gray-700 font-medium">Margin</span>
          <span className={`font-semibold ${marginColor}`}>
            {sku.margin == null ? "—" : (sku.margin >= 0 ? "+" : "") + dollar(sku.margin)}
          </span>
        </div>
      </div>

      {/* Unmatched warning */}
      {!matched && (
        <div className="flex items-center gap-1 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
          <AlertTriangle className="w-3 h-3" />
          no sample match — margin can't be computed
        </div>
      )}

      {/* Note editor */}
      {showNote && (
        <div className="space-y-1">
          <textarea
            value={noteDraft}
            onChange={(e) => setNoteDraft(e.target.value)}
            placeholder="Note..."
            className="input w-full text-sm"
            rows={2}
          />
          <button
            onClick={() => {
              onSaveNote(noteDraft);
              setShowNote(false);
            }}
            className="text-xs text-blue-600 hover:text-blue-700"
          >
            Save note
          </button>
        </div>
      )}

      {/* Detail toggle */}
      <button
        onClick={() => setShowDetail((v) => !v)}
        className="text-xs text-gray-500 hover:text-gray-700 self-start"
      >
        {showDetail ? "hide" : "show"} SSP detail
      </button>
      {showDetail && (
        <div className="text-xs text-gray-600 space-y-0.5 border-t pt-2">
          <div className="flex justify-between">
            <span>Weight</span>
            <span>{sku.total_net_weight ?? "—"} g</span>
          </div>
          <div className="flex justify-between">
            <span>Labor</span>
            <span>{dollar(sku.total_labor_cost)}</span>
          </div>
          <div className="flex justify-between">
            <span>Stone</span>
            <span>{dollar(sku.total_stone_cost)}</span>
          </div>
          <div className="flex justify-between">
            <span>Plating</span>
            <span>{dollar(sku.total_plating_cost)}</span>
          </div>
          <div className="flex justify-between">
            <span>Tag</span>
            <span>{dollar(sku.tag_cost)}</span>
          </div>
          <div className="flex justify-between">
            <span>Duty</span>
            <span>{sku.duty_rate ?? "—"}%</span>
          </div>
          <div className="flex justify-between border-t pt-1 mt-1">
            <span>SSP-stored SPC</span>
            <span>{dollar(sku.vendor_purch_cost)}</span>
          </div>
          <div className="flex justify-between">
            <span>Variance vs SSP</span>
            <span
              className={(sku.variance ?? 0) >= 0 ? "text-green-600" : "text-red-600"}
            >
              {(sku.variance ?? 0) >= 0 ? "+" : ""}
              {dollar(sku.variance)}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

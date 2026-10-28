// Bulk "beefed up excel" sample entry -- Kevin, 2026-09-30.
//
// Paste many new samples at once, straight from Excel/Sheets, then save
// them all in one pass.
//
// v3 (Kevin, 2026-09-30): the columns here are now the SAME fields, with
// the SAME header names, as the existing xlsx/csv Import flow's "samples"
// template (formatImportRow.js) AND the Excel Export (exportUtils.js) --
// Style Number, Sku, Manufacturer Code, Vendor, Metal Type, Karat, Color,
// Weight (g), Quote Description, Type, Category, Selling Pair, Back Type,
// Sales Price, Location, In Stock, Qty On Hand. Type and Category are two
// different fields (Type = the bigint FK into the "category" dropdown
// table, what Add Sample calls "Type"; Category = free SSP sub-category
// text) -- Export always wrote them as two separate columns, but Import
// used to conflate them; both are fixed together in this same change so
// export -> edit -> reimport, and this grid, all agree on the same
// structure. One template covers all three: fill this grid directly, or
// build the same columns in Excel and paste the whole block in (header
// row optional, any column order -- recognized by name). Saving runs every
// row through the exact same formatImportRow() + insertFormattedSampleRows()
// that file import uses (src/utils/insertSampleRows.js), so there is one
// save path for "new sample" no matter which door it came through.
//
// Kevin, 2026-09-30: paste and file-upload must behave the same -- if a
// real exported sheet (117 columns: stones, dimensions, costs, plating,
// etc.) works as a file Import, pasting that exact same sheet into this
// grid, or using "Upload filled sheet" below, works too. Only the 17
// columns above render as editable cells, but both paths recognize every
// OTHER header formatImportRow.js reads as well (EXPORT_TEMPLATE_HEADERS
// below -- Collection, Plating, Length/Width/Height, Misc/Labor Cost,
// Necklace fields, all 10 Stone slots, etc.) and carry that value straight
// through to the save, unedited. Those fields just aren't individually
// editable here -- fix them on the sample afterward, or in the source
// sheet before uploading/pasting again.
//
// Kevin, 2026-10-01: a row can't be lost just because the modal closes --
// see DRAFT_STORAGE_KEY below -- and closing by clicking outside the
// panel is disabled (with an explanation) for the same reason. A Save All
// that fully succeeds doesn't auto-close either; it swaps the footer to a
// single OK button so finishing is a deliberate click, not an auto-exit.

import { Component, Fragment, useEffect, useMemo, useRef, useState } from "react";
import useEscapeKey from "../../Hooks/useEscapeKey";
import { Dialog, Transition, Portal } from "@headlessui/react";
import { X, Plus, Trash2, Download, Upload, GripVertical } from "lucide-react";
import StoneForm from "../Products/StoneForm";
import ExcelJS from "exceljs";
import { metalTypes } from "../../utils/MetalTypeUtil";
import { useSupabase } from "../SupaBaseProvider";
import { useMetalPriceStore } from "../../store/MetalPrices";
import { useMessage } from "../Messages/MessageContext";
import { formatImportRow } from "../../utils/formatImportRow";
import { insertFormattedSampleRows, updateFormattedSampleRow, friendlyDbError, checkIfKaratIsValid } from "../../utils/insertSampleRows";
import { logImportBatch } from "../../utils/tags/tagData";
import { handleImportFile } from "../../utils/importUtils";

// Columns = the exact header strings formatImportRow.js reads for
// type==='samples'. Keep these header keys and formatImportRow.js in sync
// -- that's what makes "paste from the xlsx template" and "fill the grid"
// the same thing.
const COLUMNS = [
  { key: "Style Number", label: "Style Number", type: "text", required: true, width: "w-32" },
  { key: "Sku", label: "Sku", type: "text", width: "w-24" },
  { key: "Manufacturer Code", label: "Mfr Code", type: "text", required: true, width: "w-28" },
  { key: "Vendor", label: "Vendor", type: "vendor", required: true, width: "w-32" },
  { key: "Metal Type", label: "Metal Type", type: "metalType", width: "w-24" },
  { key: "Karat", label: "Karat", type: "karat", width: "w-20" },
  { key: "Color", label: "Color", type: "color", width: "w-24" },
  { key: "Plating", label: "Plating", type: "plating", width: "w-32" },
  { key: "Weight (g)", label: "Weight (g)", type: "number", required: true, width: "w-24" },
  { key: "Sales Weight", label: "Sales Weight", type: "number", width: "w-24" },
  { key: "Length (in)", label: "Length (in)", type: "number", width: "w-20" },
  // Necklaces: length plus the extender. Saved to starting_info.extension
  // (migration 20261028000000); only sent when filled in.
  { key: "Extension (in)", label: "Extension (in)", type: "number", width: "w-24" },
  { key: "Width (in)", label: "Width (in)", type: "number", width: "w-20" },
  // Rings have no height: on a ring row this column holds the ring size
  // instead (stored in the "Ring Size" key -> starting_info.ring_size).
  { key: "Height (in)", label: "Height / Ring Size", type: "number", width: "w-24" },
  { key: "Labor Cost", label: "Labor Cost", type: "number", width: "w-24" },
  // Virtual column: reads/writes the same flat "Stone 1 Type" ... "Stone 10
  // Notes" keys the xlsx Import template uses (see rowToStones/stonesToRow),
  // so stones added here, pasted from a real export, or uploaded all agree.
  { key: "Stones", label: "Stones", type: "stones", width: "w-56" },
  // Extra words (e.g. "Bow", "Open Heart") worked into the auto-description so
  // similar rows don't all read the same. Grid-only: not saved on its own.
  { key: "Detail", label: "Detail", type: "text", width: "w-32" },
  { key: "Quote Description", label: "Description", type: "text", width: "w-56" },
  { key: "Type", label: "Type", type: "sampleType", width: "w-32" },
  { key: "Category", label: "Category", type: "text", width: "w-32" },
  { key: "Selling Pair", label: "Selling Pair", type: "sellingType", width: "w-24" },
  { key: "Finding", label: "Finding", type: "finding", width: "w-48" },
  { key: "Sales Price", label: "Sales Price", type: "number", width: "w-24" },
  { key: "Location", label: "Location", type: "text", width: "w-24" },
  { key: "In Stock", label: "In Stock", type: "checkbox", width: "w-16" },
  { key: "Qty On Hand", label: "Qty On Hand", type: "number", width: "w-20" },
];

// Every OTHER header formatImportRow.js reads for type==='samples' that
// isn't one of the 17 visible grid columns above (stones, dimensions,
// plating, etc. -- see EXPORT_TEMPLATE_HEADERS below for the full list).
// These never render as an editable cell, but a paste that includes one
// of these headers still carries that value straight through to the save
// (same field, same name, same formatImportRow() call the xlsx Import
// path uses) -- so pasting a rich real export works the same as
// uploading that file would.
const STONE_FIELDS = ["ID", "Type", "Color", "Shape", "Size", "Quantity", "Cost", "Notes"];
// The exact column order of the real xlsx Export/Import template
// (headersExport.samples in exportUtils.js), plus three fields this grid
// also saves that the Export sheet doesn't produce (Location, In Stock,
// Qty On Hand) tacked on at the end. This is what "Download sheet" below
// hands you -- blank if the grid's empty, or whatever's already filled in
// if it's not -- and "Upload filled sheet" brings it back in, so a real
// exported file and a sheet built off this button are interchangeable.
const EXPORT_TEMPLATE_HEADERS = [
  "ID (Sample)",
  "Sku",
  "Style Number",
  "CAD Files",
  "Sales Weight",
  "Selling Pair",
  "Finding",
  "Custom Back Type",
  "Back Type Quantity",
  "Sample Status",
  "Notes",
  "Created At",
  "Updated At",
  "Type",
  "Category",
  "Collection",
  "Manufacturer Code",
  "Quote Description",
  "Detail",
  "Metal Type",
  "Karat",
  "Color",
  "Vendor",
  "Plating",
  "Plating Charge",
  "Length (in)",
  "Extension (in)",
  "Width (in)",
  "Height (in)",
  "Ring Size",
  "Weight (g)",
  "Misc Cost",
  "Labor Cost",
  "Necklace True Or False",
  "Necklace Cost",
  "Starting Info Id",
  "Total Cost",
  "Sales Price",
  "Quote Images",
  ...Array.from({ length: 10 }, (_, i) => STONE_FIELDS.map((f) => `Stone ${i + 1} ${f}`)).flat(),
  "Design Id",
  "Location",
  "In Stock",
  "Qty On Hand",
];

// Same set of headers formatImportRow.js recognizes, used for paste's
// header-row detection -- kept as its own name since that's what matters
// for parsing (order doesn't), while EXPORT_TEMPLATE_HEADERS above is
// about matching the real file's column order for the copy button.
const ALL_HEADER_KEYS = EXPORT_TEMPLATE_HEADERS;

// Kevin: typed-in data can't be lost just because this modal closes (or
// the tab reloads/crashes) -- it has to live until it's either saved to
// the DB or the row is explicitly deleted. The grid's own React state
// already survives opening/closing the modal (Samples.jsx keeps this
// component mounted the whole time, only toggling isOpen), but this is a
// second line of defense for a real reload/crash: every row that isn't
// blank and isn't already saved gets mirrored to localStorage on every
// change, and restored the next time this component mounts.
const DRAFT_STORAGE_KEY = "echabot_bulk_add_samples_draft_v1";

const loadDraftRows = () => {
  try {
    const raw = window.localStorage.getItem(DRAFT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : null;
  } catch {
    return null; // private browsing, storage disabled, corrupted JSON, etc.
  }
};

const saveDraftRows = (rows) => {
  try {
    const worthKeeping = rows.filter((row) => row.status !== "saved" && !row._sampleId && !isRowBlank(row));
    if (worthKeeping.length === 0) {
      window.localStorage.removeItem(DRAFT_STORAGE_KEY);
    } else {
      window.localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(worthKeeping));
    }
  } catch {
    // Storage unavailable -- the in-memory grid still works for this
    // session, it just won't survive a reload. Nothing to surface to the
    // user over; this is a safety net, not the primary mechanism.
  }
};

const emptyRow = (sticky = {}) => ({
  _key: Math.random().toString(36).slice(2),
  status: "idle", // idle | saving | saved | error
  error: null,
  "Style Number": "",
  Sku: "",
  "Manufacturer Code": "",
  Vendor: sticky.Vendor ?? "",
  "Metal Type": sticky["Metal Type"] ?? "Gold",
  Karat: sticky.Karat ?? "10K",
  Color: sticky.Color ?? "Yellow",
  Plating: sticky.Plating ?? "",
  "Weight (g)": "",
  "Sales Weight": "",
  "Length (in)": "",
  "Extension (in)": "",
  "Width (in)": "",
  "Height (in)": "",
  "Ring Size": "",
  "Labor Cost": "",
  Detail: "",
  "Quote Description": "",
  Type: "",
  Category: "",
  "Selling Pair": sticky["Selling Pair"] ?? "pairs",
  Finding: sticky["Finding"] ?? "",
  "Sales Price": "",
  Location: "",
  "In Stock": false,
  "Qty On Hand": "",
});

const isRowBlank = (row) =>
  !row["Style Number"].trim() &&
  !row["Manufacturer Code"].trim() &&
  !row["Weight (g)"].toString().trim() &&
  (!row["Quote Description"].trim() || row["Quote Description"] === row._autoDesc);

// Fixed pixel widths so columns never resize to fit what is typed (Kevin,
// 2026-10-26: "columns autoadjust when entering fields ... distracting").
const COL_PX = { "w-16": 64, "w-20": 80, "w-24": 96, "w-28": 112, "w-32": 128, "w-40": 160, "w-48": 192, "w-56": 224 };
const colPx = (col) => COL_PX[col.width] || 128;
const ROWNUM_PX = 36;
const STATUS_PX = 144;
const TRASH_PX = 32;
const GRID_WIDTH_PX = ROWNUM_PX + COLUMNS.reduce((n, c) => n + colPx(c), 0) + STATUS_PX + TRASH_PX;

// Ring rows swap the Height cell for Ring Size.
const isRingRow = (row) => /^rings?$/i.test(((row && row.Type) || "").toString().trim());
const effKey = (row, col) => (col.key === "Height (in)" && isRingRow(row) ? "Ring Size" : col.key);

const normalize = (s) => (s || "").toString().trim().toLowerCase();

// 0-indexed column number -> Excel column letters ("A", "B", ... "AA").
// Same helper exportUtils.js uses for its own dropdown validation; not
// exported from there, so duplicated here rather than reaching into that
// module's internals.
const getExcelColumnName = (index) => {
  let name = "";
  let i = index;
  while (i >= 0) {
    name = String.fromCharCode((i % 26) + 65) + name;
    i = Math.floor(i / 26) - 1;
  }
  return name;
};

// A pasted cell's raw text -> the value the column's <select> actually
// needs, so typing "Aoxin" or "Gold" in Excel resolves the dropdown instead
// of landing as unmatched text the select shows blank for.
const resolveCellValue = (col, raw, ctx) => {
  const text = (raw ?? "").toString().trim();
  if (col.type === "checkbox") return /^(true|yes|1|x)$/i.test(text);
  if (text === "") return "";
  switch (col.type) {
    case "vendor": {
      const match =
        ctx.dropdown.vendors?.find((v) => normalize(v.name) === normalize(text)) ||
        ctx.dropdown.vendors?.find((v) => normalize(v.name).includes(normalize(text)));
      return match ? match.name : text;
    }
    case "plating": {
      const match =
        ctx.dropdown.plating?.find((v) => normalize(v.name ?? v) === normalize(text)) ||
        ctx.dropdown.plating?.find((v) => normalize(v.name ?? v).includes(normalize(text)));
      return match ? match.name ?? match : text;
    }
    case "sampleType": {
      const match =
        ctx.dropdown.category?.find((c) => normalize(c.name) === normalize(text)) ||
        ctx.dropdown.category?.find((c) => normalize(c.name).includes(normalize(text)));
      return match ? match.name : text;
    }
    case "metalType": {
      const match = metalTypes.find((m) => normalize(m.type) === normalize(text));
      return match ? match.type : text;
    }
    case "karat": {
      const metal = metalTypes.find((m) => normalize(m.type) === normalize(ctx.rowMetalType)) || metalTypes[0];
      const match = metal.karat.find((k) => normalize(k) === normalize(text));
      return match || text.toUpperCase();
    }
    case "color": {
      const match = metalTypes[0].color.find((c) => normalize(c) === normalize(text));
      return match || text;
    }
    case "sellingType": {
      const match = ctx.sellingTypeOptions.find((t) => normalize(t) === normalize(text));
      return (match || text).toLowerCase();
    }
    case "finding": {
      const match = ctx.findingOptions.find((t) => normalize(t) === normalize(text));
      return match || text;
    }
    default:
      return text;
  }
};

// ---- Stones (Kevin, 2026-10-15) ---------------------------------------------
// Stones live on the grid row as the same flat "Stone N <Field>" keys the xlsx
// Import template uses (up to 10 stones) -- that is exactly what
// formatImportRow() reads on save. These two helpers convert between that flat
// shape and the stone objects StoneForm works with.
const MAX_STONES = 10;
const STONE_KEY_FIELDS = [...STONE_FIELDS, "Custom Type", "Setting Type"];

const rowToStones = (row) => {
  const out = [];
  for (let i = 1; i <= MAX_STONES; i++) {
    const g = (f) => row[`Stone ${i} ${f}`];
    const has = ["Type", "Color", "Size", "Shape", "Quantity", "Cost"].some(
      (f) => g(f) !== undefined && g(f) !== null && g(f) !== ""
    );
    if (!has) continue;
    out.push({
      id: g("ID") || undefined,
      type: g("Type") ?? "",
      color: g("Color") ?? "",
      shape: g("Shape") ?? "",
      size: g("Size") ?? "",
      quantity: g("Quantity") === undefined || g("Quantity") === "" ? 1 : g("Quantity"),
      cost: g("Cost") === undefined || g("Cost") === "" ? 0 : g("Cost"),
      customType: g("Custom Type") ?? "",
      setting_type: g("Setting Type") ?? "",
      notes: g("Notes") ?? "",
    });
  }
  return out;
};

const stonesToRow = (row, stones) => {
  const next = { ...row };
  for (let i = 1; i <= MAX_STONES; i++) STONE_KEY_FIELDS.forEach((f) => delete next[`Stone ${i} ${f}`]);
  (stones || []).slice(0, MAX_STONES).forEach((s, idx) => {
    const i = idx + 1;
    if (s.id) next[`Stone ${i} ID`] = s.id;
    next[`Stone ${i} Type`] = s.type ?? "";
    next[`Stone ${i} Color`] = s.color ?? "";
    next[`Stone ${i} Shape`] = s.shape ?? "";
    next[`Stone ${i} Size`] = s.size ?? "";
    next[`Stone ${i} Quantity`] = s.quantity === "" || s.quantity === undefined ? 1 : s.quantity;
    next[`Stone ${i} Cost`] = s.cost === "" || s.cost === undefined ? 0 : s.cost;
    if (s.notes) next[`Stone ${i} Notes`] = s.notes;
    if (s.customType) next[`Stone ${i} Custom Type`] = s.customType;
    if (s.setting_type) next[`Stone ${i} Setting Type`] = s.setting_type;
  });
  return next;
};

const stoneTypeLabel = (t) => {
  const s = String(t || "");
  if (!s) return "Stone";
  if (s.toLowerCase() === "cz") return "CZ";
  return s.replace(/-cz/i, " CZ");
};

const stoneLabel = (s) =>
  [
    `${s.quantity || 1}×`,
    s.size ? `${s.size}mm` : null,
    stoneTypeLabel(s.type === "other" ? s.customType : s.type),
    s.shape,
    s.color,
  ]
    .filter(Boolean)
    .join(" ");

const STONE_DOT_COLORS = { ruby: "#9b111e", multi: "#c084fc", clear: "#ffffff" };
const stoneDotColor = (color) => STONE_DOT_COLORS[String(color || "").toLowerCase()] || String(color || "") || "#d1d5db";

// What the Stones cell shows: one small chip per stone, clipped to the cell.
const StoneChips = ({ stones, disabled }) => {
  if (stones.length === 0) {
    return (
      <div className={`min-h-[26px] px-1 py-1 text-xs ${disabled ? "text-gray-300" : "text-gray-400"}`}>+ Add stone</div>
    );
  }
  return (
    <div className="flex items-center gap-1 min-h-[26px] overflow-hidden">
      {stones.map((s, i) => (
        <span
          key={i}
          title={stoneLabel(s)}
          className="inline-flex items-center gap-1 shrink-0 px-1.5 py-0.5 bg-gray-100 border border-gray-300 rounded text-[10px] text-gray-800 whitespace-nowrap"
        >
          <span
            className="inline-block w-2.5 h-2.5 rounded-full border border-gray-400"
            style={{ background: stoneDotColor(s.color) }}
          />
          {stoneLabel(s)}
        </span>
      ))}
    </div>
  );
};

// If the stone form ever throws (it reads app settings from the shared store),
// show a message in the popover instead of taking the whole page down.
class StoneFormBoundary extends Component {
  state = { error: null };
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error) {
    console.error("Stone form crashed:", error);
  }
  render() {
    if (this.state.error) {
      return (
        <div className="text-sm text-red-600 space-y-2">
          <div>Couldn&apos;t open the stone form: {String(this.state.error?.message || this.state.error)}</div>
          <button type="button" onClick={this.props.onCancel} className="px-3 py-1 border border-gray-300 rounded-md text-gray-700">
            Close
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

// The popover a Stones cell opens: every stone already on the row (click to
// edit, X to remove, grip to reorder), "Clear all", and "Add stone", which
// opens the same StoneForm the Add Sample window uses.
const StonesPopover = ({ anchorRect, stones, disabled, onChange, onClose }) => {
  const popRef = useRef(null);
  const [form, setForm] = useState(null); // null | { index: number | null }
  const [dragIdx, setDragIdx] = useState(null);

  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    popRef.current?.focus({ preventScroll: true });
    const onDown = (e) => {
      if (popRef.current && !popRef.current.contains(e.target)) onCloseRef.current();
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, []);

  const width = form ? 440 : 330;
  const top = Math.min((anchorRect?.bottom ?? 80) + 4, window.innerHeight - 160);
  const left = Math.max(8, Math.min(anchorRect?.left ?? 8, window.innerWidth - width - 8));

  return (
    <Portal>
      <div
        ref={popRef}
        tabIndex={-1}
        style={{ position: "fixed", top, left, width, maxHeight: window.innerHeight - top - 16 }}
        className="z-[60] bg-white rounded-xl shadow-xl border border-gray-200 p-3 overflow-y-auto outline-none"
        onMouseDown={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") {
            e.preventDefault();
            if (form) setForm(null);
            else onClose();
          }
        }}
      >
        <div className="flex items-center justify-between mb-2">
          <button
            type="button"
            disabled={disabled || stones.length >= MAX_STONES}
            onClick={() => setForm({ index: null })}
            className="px-3 py-1.5 text-sm rounded-full bg-gray-100 border border-gray-300 text-gray-800 hover:bg-gray-200 inline-flex items-center disabled:opacity-50"
            title={stones.length >= MAX_STONES ? `Up to ${MAX_STONES} stones per sample` : undefined}
          >
            <Plus className="w-3.5 h-3.5 mr-1" />
            Add stone
          </button>
          {stones.length > 0 && !disabled && (
            <button
              type="button"
              onClick={() => {
                setForm(null);
                onChange([]);
              }}
              className="text-sm text-blue-600 hover:underline"
            >
              Clear all
            </button>
          )}
        </div>

        {form && (
          <div className="mb-2 border rounded-lg p-3 bg-gray-50">
            <StoneFormBoundary onCancel={() => setForm(null)}>
              <StoneForm
                initialStone={form.index !== null ? stones[form.index] : null}
                isEditing={form.index !== null}
                onSubmit={(s) => {
                  onChange(form.index !== null ? stones.map((x, i) => (i === form.index ? { ...x, ...s } : x)) : [...stones, s]);
                  setForm(null);
                }}
                onCancel={() => setForm(null)}
              />
            </StoneFormBoundary>
          </div>
        )}

        {stones.length === 0 ? (
          <div className="text-sm text-gray-500 italic px-1 py-2">No stones added yet</div>
        ) : (
          stones.map((s, i) => (
            <div
              key={i}
              draggable={!disabled}
              onDragStart={() => setDragIdx(i)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => {
                if (dragIdx === null || dragIdx === i) return;
                const next = [...stones];
                const [moved] = next.splice(dragIdx, 1);
                next.splice(i, 0, moved);
                setDragIdx(null);
                onChange(next);
              }}
              onDragEnd={() => setDragIdx(null)}
              className="flex items-center gap-2 py-2 border-b border-gray-100 last:border-0"
            >
              <GripVertical className="w-4 h-4 text-gray-400 cursor-grab shrink-0" />
              <span
                className="inline-block w-4 h-4 rounded-full border border-gray-300 shrink-0"
                style={{ background: stoneDotColor(s.color) }}
              />
              <button
                type="button"
                disabled={disabled}
                onClick={() => setForm({ index: i })}
                className="flex-1 text-left text-sm text-gray-900 hover:text-blue-700 truncate"
                title="Edit stone"
              >
                {stoneLabel(s)}
              </button>
              <span className="text-xs text-gray-500 shrink-0">${Number(s.cost || 0).toFixed(2)}</span>
              {!disabled && (
                <button
                  type="button"
                  onClick={() => {
                    setForm(null);
                    onChange(stones.filter((_, j) => j !== i));
                  }}
                  className="text-gray-400 hover:text-gray-600 shrink-0"
                  title="Remove stone"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>
          ))
        )}
      </div>
    </Portal>
  );
};

// ---- Auto-description (Kevin, 2026-10-15) ------------------------------------
// House style, one line: metal -> CZ -> shape -> setting -> type -> plating spec
// ("925 Solid Sterling Silver CZ Oval Bezel Studs 14k Gold plated .5 MICRON 10k
// hamilton color"). Shape and setting come from the first stone on the row.
// It only ever fills an EMPTY Description, or one it wrote itself and nobody has
// touched since (tracked in row._autoDesc) -- typing your own text turns it off
// for that row, and clearing the cell turns it back on.
const GOLD_PLATING_SPEC = "14k Gold plated .5 MICRON 10k hamilton color";
const STYLE_TYPE_LABELS = {
  E: "Earrings",
  HE: "Huggie Hoops",
  R: "Ring",
  NK: "Necklace",
  BR: "Bracelet",
  C: "Charm",
  P: "Pendant",
  BN: "Bangle",
  NR: "Nose Ring",
  SET: "Set",
};
const titleCase = (t) =>
  String(t || "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\b([a-z])/g, (m) => m.toUpperCase());
const singularType = (t) => {
  const v = titleCase(t);
  return /^(Necklaces|Rings|Bracelets|Charms|Bangles|Pendants)$/.test(v) ? v.slice(0, -1) : v;
};

const buildDescription = (row) => {
  const metal = String(row["Metal Type"] || "").trim();
  const karat = String(row.Karat || "").trim();
  const color = String(row.Color || "").trim();
  const style = String(row["Style Number"] || "").trim();
  const parts = [];

  if (/^silver$/i.test(metal)) parts.push("925 Solid Sterling Silver");
  else if (/^gold$/i.test(metal)) parts.push([karat, titleCase(color), "Gold"].filter(Boolean).join(" "));
  else if (metal) parts.push(titleCase(metal));

  const stones = rowToStones(row);
  const types = [...new Set(stones.map((st) => (String(st.type || "").toLowerCase() === "cz" ? "CZ" : titleCase(st.type))).filter(Boolean))];
  parts.push(...types);
  const first = stones[0];
  if (first && first.shape) parts.push(titleCase(first.shape));
  if (first && first.setting_type) parts.push(titleCase(first.setting_type));
  const detail = titleCase(row.Detail);
  if (detail) parts.push(detail);

  const letters = (style.match(/^[A-Za-z]*\d+([A-Za-z]+)/) || [])[1];
  const letterKey = letters ? letters.toUpperCase() : "";
  let typeLabel = "";
  if (letterKey === "HE") typeLabel = STYLE_TYPE_LABELS.HE;
  else if (row.Type) typeLabel = singularType(row.Type);
  else if (STYLE_TYPE_LABELS[letterKey]) typeLabel = STYLE_TYPE_LABELS[letterKey];
  if (typeLabel) parts.push(typeLabel);

  const plating = String(row.Plating || "");
  if (/rhod/i.test(plating)) parts.push("Rhodium plated");
  else if (/gold|14k|vermeil|micron/i.test(plating) || /-GP(?![A-Za-z])/i.test(style)) parts.push(GOLD_PLATING_SPEC);

  return parts.join(" ").replace(/\s+/g, " ").trim();
};

// Returns the row with its Description auto-filled/refreshed when allowed.
const withAutoDescription = (row) => {
  const cur = String(row["Quote Description"] ?? "").trim();
  const auto = row._autoDesc;
  if (cur !== "" && cur !== auto) return row; // the user wrote it -- leave it alone
  const hasContent =
    String(row["Style Number"] ?? "").trim() ||
    String(row["Manufacturer Code"] ?? "").trim() ||
    String(row["Weight (g)"] ?? "").trim();
  if (!hasContent) return row;
  const desc = buildDescription(row);
  if (!desc || desc === cur) return row;
  return { ...row, "Quote Description": desc, _autoDesc: desc };
};

// Inline text/number editor for one grid cell (Excel-style): opens on typing,
// F2 or double-click; Enter/Tab/blur commit, Escape cancels. Uncontrolled on
// purpose -- the value only reaches the grid (and the undo history) when the
// edit is committed, so one edit = one undo step.
const CellInput = ({ initial, numeric, onCommit, onCancel, onPasteBlock }) => {
  const ref = useRef(null);
  const doneRef = useRef(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    const len = el.value.length;
    try {
      el.setSelectionRange(len, len);
    } catch {
      // not all input types support selection ranges -- harmless
    }
  }, []);
  const finish = (value, move) => {
    if (doneRef.current) return;
    doneRef.current = true;
    onCommit(value, move);
  };
  return (
    <input
      ref={ref}
      type="text"
      inputMode={numeric ? "decimal" : undefined}
      defaultValue={initial}
      className="w-full border border-blue-400 rounded p-1 text-xs bg-white select-text"
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          finish(e.currentTarget.value, e.shiftKey ? "up" : "down");
        } else if (e.key === "Tab") {
          e.preventDefault();
          finish(e.currentTarget.value, e.shiftKey ? "backtab" : "tab");
        } else if (e.key === "Escape") {
          e.preventDefault();
          if (!doneRef.current) {
            doneRef.current = true;
            onCancel();
          }
        }
      }}
      onBlur={(e) => finish(e.currentTarget.value, null)}
      onPaste={(e) => {
        const t = e.clipboardData?.getData("text/plain") || "";
        // A multi-cell block (tabs or several lines) spreads over the grid;
        // a single value just pastes into the input like normal.
        if (t.includes("\t") || t.replace(/\r?\n$/, "").includes("\n")) {
          e.preventDefault();
          doneRef.current = true;
          onPasteBlock(t);
        }
      }}
    />
  );
};

// pendingImportRows / onPendingImportConsumed: Kevin wants the Samples
// page's "Import" button left as-is (same ImportModal drag-and-drop
// dialog), but for samples it should hand its parsed rows here instead of
// saving them straight to the DB -- see the useEffect below that watches
// pendingImportRows and calls onPendingImportConsumed once they're loaded
// into the grid, so the parent can clear its copy.
const BulkAddSamplesModal = ({ isOpen, onClose, onSaved, pendingImportRows, onPendingImportConsumed }) => {
  const { supabase, session } = useSupabase();
  const { showMessage } = useMessage();
  const { prices } = useMetalPriceStore();

  const [dropdown, setDropdown] = useState({ vendors: [], plating: [], collection: [], category: [] });
  const [formFields, setFormFields] = useState({});
  // Restore whatever wasn't saved last time (see DRAFT_STORAGE_KEY above)
  // instead of always starting from 6 blank rows -- this only runs once,
  // on mount, since this component stays mounted the whole time Samples.jsx
  // is open and just toggles isOpen.
  const [rows, setRows] = useState(() => {
    const draft = loadDraftRows();
    return draft ? [...draft, emptyRow()] : Array.from({ length: 6 }, emptyRow);
  });
  // Carries forward the last value typed/selected for these columns so a
  // new row (manual "+Add row" or auto-appended below) starts pre-filled
  // instead of making you re-pick the same vendor/metal/etc. every time --
  // Kevin: "it shouldn't take so much time ... simple and easy."
  const stickyDefaultsRef = useRef({});
  const [isSaving, setIsSaving] = useState(false);
  // True once a Save All has fully succeeded (no failed rows) -- while
  // true the footer shows a single "OK" button instead of Close/Save All,
  // so finishing is a deliberate, explicit step rather than an auto-close.
  const [saveComplete, setSaveComplete] = useState(false);
  const fileInputRef = useRef(null);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    (async () => {
      const [{ data: dropdownData, error: dropdownError }, { data: settingsRow }] = await Promise.all([
        supabase.rpc("get_dropdown_options"),
        supabase.from("settings").select("options").limit(1).maybeSingle(),
      ]);
      if (cancelled) return;
      if (dropdownError) console.error("Error fetching dropdown options:", dropdownError);
      setDropdown(dropdownData || { vendors: [], plating: [], collection: [], category: [] });
      setFormFields(settingsRow?.options?.formFields || {});
      const { data: fd } = await supabase.from("ssp_finding_defaults").select("finding_type");
      if (!cancelled) setFindingOptions([...new Set((fd || []).map((d) => d.finding_type).filter(Boolean))].sort());
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen, supabase]);

  // Mirror every row change to localStorage (see saveDraftRows above) --
  // deliberately NOT gated on isOpen, so a row keeps being protected even
  // while the modal happens to be closed, right up until it's saved or
  // removed.
  useEffect(() => {
    saveDraftRows(rows);
  }, [rows]);

  const [findingOptions, setFindingOptions] = useState([]);
  const sellingTypeOptions = formFields?.sellingType || ["pairs"];

  const STICKY_KEYS = ["Vendor", "Metal Type", "Karat", "Color", "Plating", "Selling Pair", "Finding"];

  // ---- Excel-style grid (Kevin, 2026-10-15) ---------------------------------
  // Cells behave like a spreadsheet: click/drag/Shift+arrows to select, type to
  // replace, F2 or double-click to edit, Enter/Tab/arrows to move, Ctrl+C / X /
  // V (paste a block from Excel and it fills rows/columns from the selected
  // cell), a single pasted value fills the whole selection, Delete clears,
  // drag the corner handle (or Ctrl+D) to fill down, Ctrl+Z / Ctrl+Y undo/redo.
  // Every change goes through setCells() -> applyRows(), so it is one undo step.
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const undoRef = useRef([]);
  const redoRef = useRef([]);
  const gridRef = useRef(null);
  const draggingRef = useRef(false);
  const fillRef = useRef(null);
  const pointerRef = useRef(null);
  const dragStartRef = useRef(null);
  const draggedFarRef = useRef(false);
  const typeAheadRef = useRef({ text: "", at: 0 });
  const [active, setActive] = useState({ r: 0, c: 0 });
  const [selEnd, setSelEnd] = useState(null);
  const [editing, setEditing] = useState(null); // { r, c, initial }
  const [fillTo, setFillTo] = useState(null);

  const clampR = (r) => Math.max(0, Math.min(r, rows.length - 1));
  const clampC = (c) => Math.max(0, Math.min(c, COLUMNS.length - 1));
  const selRect = (() => {
    const a = { r: clampR(active.r), c: clampC(active.c) };
    const e = selEnd ? { r: clampR(selEnd.r), c: clampC(selEnd.c) } : a;
    return {
      r1: Math.min(a.r, e.r),
      r2: Math.max(a.r, e.r),
      c1: Math.min(a.c, e.c),
      c2: Math.max(a.c, e.c),
      ar: a.r,
      ac: a.c,
    };
  })();

  const clearHistory = () => {
    undoRef.current = [];
    redoRef.current = [];
  };
  const applyRows = (updater) => {
    const prev = rowsRef.current;
    const next = updater(prev);
    if (next === prev) return;
    undoRef.current.push(prev);
    if (undoRef.current.length > 100) undoRef.current.shift();
    redoRef.current = [];
    rowsRef.current = next;
    setRows(next);
  };
  const undo = () => {
    const prev = undoRef.current.pop();
    if (!prev) return;
    redoRef.current.push(rowsRef.current);
    rowsRef.current = prev;
    setRows(prev);
  };
  const redo = () => {
    const next = redoRef.current.pop();
    if (!next) return;
    undoRef.current.push(rowsRef.current);
    rowsRef.current = next;
    setRows(next);
  };

  // Option strings a dropdown-type column accepts (used for type-ahead).
  const optionsFor = (col, row) => {
    switch (col.type) {
      case "vendor":
        return (dropdown.vendors || []).map((v) => v.name);
      case "sampleType":
        return (dropdown.category || []).map((c) => c.name);
      case "plating":
        return (dropdown.plating || []).map((p) => p.name ?? p);
      case "metalType":
        return metalTypes.map((m) => m.type);
      case "karat":
        return (metalTypes.find((m) => m.type === row["Metal Type"]) || metalTypes[0]).karat;
      case "color":
        return metalTypes[0].color;
      case "sellingType":
        return sellingTypeOptions;
      case "finding":
        return findingOptions;
      default:
        return null;
    }
  };

  // One cell's raw text -> a new row with that value resolved the same way a
  // paste always has (dropdown matching, karat follows metal, etc.).
  const withCellValue = (row, key, raw) => {
    if (key === "Height (in)" && isRingRow(row)) {
      const size = (raw ?? "").toString().replace(/[^0-9.]/g, "");
      const next = { ...row, "Ring Size": size };
      if (row.status === "error") {
        next.status = row._sampleId ? "saved" : "idle";
        next.error = null;
      }
      return next;
    }
    if (key === "Stones") {
      // Array = a new stone list; "" = clear them all; any other text (e.g. the
      // summary from a copy) can't be turned into stones, so it's ignored.
      if (!Array.isArray(raw) && raw !== "") return row;
      const updated = stonesToRow(row, Array.isArray(raw) ? raw : []);
      if (row.status === "error") {
        updated.status = row._sampleId ? "saved" : "idle";
        updated.error = null;
      }
      return updated;
    }
    const col = COLUMNS.find((c) => c.key === key);
    let value;
    if (col) {
      let input = raw;
      if (col.type === "number") input = (raw ?? "").toString().replace(/[$,\s]/g, "");
      value = resolveCellValue(col, input, {
        dropdown,
        sellingTypeOptions,
        findingOptions,
        rowMetalType: row["Metal Type"],
      });
    } else {
      value = (raw ?? "").toString().trim();
    }
    const next = { ...row, [key]: value };
    if (row.status === "error") {
      next.status = row._sampleId ? "saved" : "idle";
      next.error = null;
    }
    if (key === "Metal Type") {
      const metal = metalTypes.find((m) => m.type === value);
      if (metal && !metal.karat.includes(next.Karat)) next.Karat = metal.karat[0];
    }
    return next;
  };

  // The single write path for cell edits: [{ r, key, raw }] -> one undo step.
  const setCells = (changes) => {
    if (!changes || changes.length === 0) return;
    // Metal Type first, so Karat/Color pasted in the same batch resolve
    // against the metal that is actually going to be on the row.
    const ordered = [...changes].sort(
      (a, b) => (a.key === "Metal Type" ? 0 : 1) - (b.key === "Metal Type" ? 0 : 1)
    );
    applyRows((prev) => {
      const next = [...prev];
      let touched = false;
      const keysByRow = new Map();
      for (const { r, key, raw } of ordered) {
        while (next.length <= r) next.push(emptyRow(stickyDefaultsRef.current));
        next[r] = withCellValue(next[r], key, raw);
        if (!keysByRow.has(r)) keysByRow.set(r, new Set());
        keysByRow.get(r).add(key);
        if (STICKY_KEYS.includes(key)) {
          stickyDefaultsRef.current = { ...stickyDefaultsRef.current, [key]: next[r][key] };
        }
        touched = true;
      }
      if (!touched) return prev;
      // Refresh auto-descriptions -- except when the only thing that changed on
      // a row was its Description (so you can clear one without it coming back).
      keysByRow.forEach((keys, r) => {
        if (keys.size === 1 && keys.has("Quote Description")) return;
        next[r] = withAutoDescription(next[r]);
      });
      // Always keep one blank row at the bottom, ready for the next entry.
      if (!isRowBlank(next[next.length - 1])) next.push(emptyRow(stickyDefaultsRef.current));
      return next;
    });
  };

  const addRow = () => applyRows((prev) => [...prev, emptyRow(stickyDefaultsRef.current)]);
  const addRows = (n) =>
    applyRows((prev) => [...prev, ...Array.from({ length: n }, () => emptyRow(stickyDefaultsRef.current))]);
  const removeRow = (rowIndex) =>
    applyRows((prev) => {
      const next = prev.filter((_, i) => i !== rowIndex);
      return next.length > 0 ? next : [emptyRow(stickyDefaultsRef.current)];
    });

  // Mouse-up anywhere ends a drag-select or a fill-handle drag. Re-subscribed
  // every render on purpose so fillRange() below is never stale.
  useEffect(() => {
    const up = () => {
      draggingRef.current = false;
      draggedFarRef.current = false;
      const f = fillRef.current;
      if (f) {
        fillRef.current = null;
        setFillTo(null);
        fillRange(f.rect, f.to);
      }
    };
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  });

  // Dragging a selection (or the fill handle) toward the edge of the grid scrolls
  // it, like a spreadsheet, and keeps the selection following the pointer.
  useEffect(() => {
    let raf = 0;
    let lastCell = "";
    const onMove = (e) => {
      pointerRef.current = { x: e.clientX, y: e.clientY };
    };
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const el = gridRef.current;
      const p = pointerRef.current;
      const filling = !!fillRef.current;
      if (!el || !p || !(draggingRef.current || filling)) {
        lastCell = "";
        return;
      }
      if (!filling && !draggedFarRef.current) {
        const o = dragStartRef.current;
        if (o && Math.hypot(p.x - o.x, p.y - o.y) < 4) return; // still just a click
        draggedFarRef.current = true;
      }
      const box = el.getBoundingClientRect();
      const zone = 48;
      const maxStep = 32;
      const speed = (d) => Math.ceil(maxStep * Math.min(1, Math.max(0, d) / zone));
      let dx = 0;
      let dy = 0;
      if (p.y < box.top + 36 + zone) dy = -speed(box.top + 36 + zone - p.y);
      else if (p.y > box.bottom - zone) dy = speed(p.y - (box.bottom - zone));
      if (p.x < box.left + zone) dx = -speed(box.left + zone - p.x);
      else if (p.x > box.right - zone) dx = speed(p.x - (box.right - zone));
      if (dx || dy) el.scrollBy(dx, dy);
      const px = Math.min(Math.max(p.x, box.left + 4), box.right - 4);
      const py = Math.min(Math.max(p.y, box.top + 40), box.bottom - 4);
      const hit = document.elementFromPoint(px, py)?.closest?.("[data-cell]");
      if (!hit || hit.dataset.cell === lastCell) return;
      lastCell = hit.dataset.cell;
      const [r, c] = hit.dataset.cell.split("-").map(Number);
      if (fillRef.current) {
        const to = Math.max(r, fillRef.current.rect.r2);
        fillRef.current.to = to;
        setFillTo(to);
      } else {
        setSelEnd({ r, c });
      }
    };
    window.addEventListener("mousemove", onMove);
    raf = requestAnimationFrame(tick);
    return () => {
      window.removeEventListener("mousemove", onMove);
      cancelAnimationFrame(raf);
    };
  }, []);

  // Keep the active cell in view as the arrow keys move it.
  useEffect(() => {
    const el = gridRef.current?.querySelector(`[data-cell="${active.r}-${active.c}"]`);
    el?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [active]);

  // One grid row -> one line of the download, in EXPORT_TEMPLATE_HEADERS
  // order -- pulls straight off the row object, so passthrough fields a
  // paste or upload set (stones, plating, dimensions, etc.) come along
  // too, not just the 17 visible columns.
  // Saved rows carry the id the database gave them, so the downloaded sheet
  // has "ID (Sample)" filled for anything already created, plus a trailing
  // Status column (Saved / Edited / Ready / the error text). Status is
  // informational -- the importer ignores columns it doesn't know.
  const statusText = (row) => {
    const d = getRowDisplayStatus(row);
    if (d.kind === "saved") return "Saved";
    if (d.kind === "modified") return "Edited (not saved)";
    if (d.kind === "ready") return "Ready";
    if (d.kind === "error") return d.message || "Error";
    if (d.kind === "saving") return "Saving";
    return "";
  };
  const EXPORT_SHEET_HEADERS = [...EXPORT_TEMPLATE_HEADERS, "Status"];
  const rowToExportLine = (row) =>
    EXPORT_SHEET_HEADERS.map((header) => {
      if (header === "ID (Sample)" && row._sampleId) return row._sampleId;
      if (header === "Status") return statusText(row);
      const value = row[header];
      if (value === undefined || value === null) return "";
      if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
      return value;
    });

  const toOptionNames = (list) =>
    (list || []).map((v) => (v && typeof v === "object" ? v.name ?? v.label ?? "" : v)).filter((v) => v !== "");

  // Downloads a .xlsx in the real Export/Import column order (all 117
  // columns, plus the 3 extra fields this grid also saves that Export
  // doesn't produce -- Location, In Stock, Qty On Hand). Kevin: if
  // anything's already filled in here, download THAT -- not an empty
  // sheet -- so this doubles as "export what I've got so far" and as a
  // from-scratch template when the grid is still empty.
  //
  // Every column this grid actually has a fixed set of options for gets
  // the same in-cell Excel dropdown the real Export puts on its own
  // columns (same technique: inline list if it's short, a hidden "Lists"
  // sheet + range reference if it's long) -- so filling the downloaded
  // sheet by hand is constrained the same way typing into this grid is.
  // Stone sub-fields aren't included: this component doesn't have a
  // stone-type/shape option list to pull from (those live on the Add
  // Sample form, not here), so they stay free text same as today.
  const downloadSheet = async () => {
    const filledRows = rows.filter((row) => !isRowBlank(row));

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Import");
    sheet.addRow(EXPORT_SHEET_HEADERS);
    filledRows.forEach((row) => sheet.addRow(rowToExportLine(row)));
    sheet.columns = EXPORT_SHEET_HEADERS.map((h) => ({ width: Math.max(10, h.length) }));

    const allKarats = [...new Set(metalTypes.flatMap((m) => m.karat))];
    const dropdownColumns = [
      { header: "Vendor", values: toOptionNames(dropdown.vendors) },
      { header: "Type", values: toOptionNames(dropdown.category) },
      { header: "Collection", values: toOptionNames(dropdown.collection) },
      { header: "Plating", values: toOptionNames(dropdown.plating) },
      { header: "Metal Type", values: metalTypes.map((m) => m.type) },
      { header: "Karat", values: allKarats },
      { header: "Color", values: metalTypes[0]?.color || [] },
      { header: "Selling Pair", values: toOptionNames(sellingTypeOptions) },
      { header: "Finding", values: toOptionNames(findingOptions) },
      { header: "In Stock", values: ["TRUE", "FALSE"] },
    ];

    // Validate a generous number of rows beyond whatever's already
    // filled in, not just the actual data rows -- a blank template has
    // zero data rows, and the whole point there is giving the dropdown to
    // rows that don't exist yet.
    const validatedRowCount = Math.max(filledRows.length + 50, 100);

    let listsSheet = null;
    const listRangeFor = (values) => {
      if (!listsSheet) listsSheet = workbook.addWorksheet("Lists", { state: "veryHidden" });
      const col = listsSheet.columnCount + 1;
      values.forEach((v, i) => {
        listsSheet.getCell(i + 1, col).value = v;
      });
      const colLetter = getExcelColumnName(col - 1);
      return `Lists!$${colLetter}$1:$${colLetter}$${values.length}`;
    };

    for (const { header, values } of dropdownColumns) {
      if (!values || values.length === 0) continue;
      const headerIndex = EXPORT_TEMPLATE_HEADERS.indexOf(header);
      if (headerIndex === -1) continue;
      const inline = values.join(",");
      const formula = inline.length > 250 ? listRangeFor(values) : `"${inline}"`;
      const columnLetter = getExcelColumnName(headerIndex);
      for (let rowNum = 2; rowNum <= validatedRowCount + 1; rowNum++) {
        sheet.getCell(`${columnLetter}${rowNum}`).dataValidation = {
          type: "list",
          allowBlank: true,
          formulae: [formula],
        };
      }
    }

    const buffer = await workbook.xlsx.writeBuffer();
    const blob = new Blob([buffer], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filledRows.length > 0 ? "bulk_add_samples.xlsx" : "bulk_add_samples_blank_template.xlsx";
    a.click();
    URL.revokeObjectURL(url);
  };

  // Turns one parsed file row (an object keyed by its column header, from
  // handleImportFile -- the exact same parser the xlsx/csv Import flow
  // uses) into a grid row, resolving each visible column's text the same
  // way a paste does and passing everything else straight through.
  const rowObjectToGridRow = (obj) => {
    let row = emptyRow(stickyDefaultsRef.current);
    Object.keys(obj).forEach((headerCell) => {
      const matchedKey = ALL_HEADER_KEYS.find((h) => normalize(h) === normalize(headerCell));
      if (!matchedKey) return;
      const rawValue = obj[headerCell];
      const col = COLUMNS.find((c) => c.key === matchedKey);
      row[matchedKey] = col
        ? resolveCellValue(col, rawValue, {
            dropdown,
            sellingTypeOptions,
            findingOptions,
            rowMetalType: row["Metal Type"],
          })
        : (rawValue ?? "").toString().trim();
    });
    return row;
  };

  // Appends a batch of parsed rows (objects keyed by column header, from
  // handleImportFile) into the grid -- never overwrites whatever's
  // already here -- and every appended row is validated immediately (see
  // getRowDisplayStatus below) so errors show red right away instead of
  // waiting for a Save All click. Shared by "Upload filled sheet" below
  // AND by the Samples page's "Import" button (see pendingImportRows),
  // which now hands its parsed file here for review instead of saving it
  // straight to the DB.
  const ingestParsedRows = (parsedRows, { sourceLabel } = {}) => {
    if (!parsedRows || parsedRows.length === 0) {
      showMessage("No rows found in that file.");
      return;
    }
    clearHistory();
    const appended = parsedRows.map((obj) => withAutoDescription(rowObjectToGridRow(obj)));
    setRows((prev) => {
      const kept = prev.filter((r) => !isRowBlank(r));
      return [...kept, ...appended, emptyRow(stickyDefaultsRef.current)];
    });
    showMessage(
      `Loaded ${appended.length} row${appended.length === 1 ? "" : "s"}${
        sourceLabel ? ` from ${sourceLabel}` : ""
      } -- check the highlighted rows below before saving.`
    );
  };

  // Upload the filled-in template (or any real Export) back in.
  const handleFileUpload = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // let the same filename be chosen again later
    if (!file) return;
    let parsedRows;
    try {
      parsedRows = await handleImportFile(file, "samples");
    } catch (err) {
      showMessage(`Couldn't read that file: ${err?.message || err}`);
      return;
    }
    ingestParsedRows(parsedRows, { sourceLabel: "the file" });
  };

  // The Samples page's "Import" button: ImportModal still does the actual
  // file picking/parsing (unchanged UI), but for samples it now hands the
  // parsed rows here instead of saving them to the DB -- they land in
  // this grid for the same review/validate/Save-All step as everything
  // else, rather than going straight in.
  useEffect(() => {
    if (isOpen && pendingImportRows && pendingImportRows.length > 0) {
      ingestParsedRows(pendingImportRows, { sourceLabel: "Import" });
      onPendingImportConsumed?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, pendingImportRows]);

  // ---- selection / editing / clipboard handlers -----------------------------
  const focusGrid = () => setTimeout(() => gridRef.current?.focus({ preventScroll: true }), 0);

  const moveActive = (dr, dc, extend) => {
    const maxR = rowsRef.current.length - 1;
    const bound = (p) => ({
      r: Math.max(0, Math.min(p.r + dr, maxR)),
      c: Math.max(0, Math.min(p.c + dc, COLUMNS.length - 1)),
    });
    if (extend) {
      setSelEnd((e) => bound(e || active));
    } else {
      setActive((p) => bound(p));
      setSelEnd(null);
    }
  };

  // Tab / Shift+Tab: next/previous cell, wrapping to the next/previous row.
  const tabMove = (back) => {
    const maxR = rowsRef.current.length - 1;
    setActive((p) => {
      let { r, c } = p;
      if (!back) {
        if (c < COLUMNS.length - 1) c += 1;
        else if (r < maxR) {
          r += 1;
          c = 0;
        }
      } else if (c > 0) c -= 1;
      else if (r > 0) {
        r -= 1;
        c = COLUMNS.length - 1;
      }
      return { r, c };
    });
    setSelEnd(null);
  };

  const startEdit = (r, c, initial) => {
    const row = rowsRef.current[r];
    const col = COLUMNS[c];
    if (!row || !col || col.type === "checkbox") return;
    setActive({ r, c });
    setSelEnd(null);
    setEditing({ r, c, initial: initial !== undefined ? initial : (row[effKey(row, col)] ?? "").toString() });
  };

  const commitEdit = (r, c, value, move) => {
    setEditing(null);
    const row = rowsRef.current[r];
    const col = COLUMNS[c];
    if (
      row &&
      value !== undefined &&
      value !== null &&
      value.toString().trim() !== (row[effKey(row, col)] ?? "").toString().trim()
    ) {
      setCells([{ r, key: col.key, raw: value }]);
    }
    if (move === "down") moveActive(1, 0, false);
    else if (move === "up") moveActive(-1, 0, false);
    else if (move === "tab") tabMove(false);
    else if (move === "backtab") tabMove(true);
    focusGrid();
  };

  // Typing on a dropdown cell jumps to the first option starting with what
  // you typed (Vendor "Ao" -> Aoxin), like type-ahead in a native select.
  const typeAhead = (r, c, ch) => {
    const col = COLUMNS[c];
    const row = rowsRef.current[r];
    const opts = row && optionsFor(col, row);
    if (!opts) return;
    const now = Date.now();
    const prevTA = typeAheadRef.current;
    const sameCell = prevTA.r === r && prevTA.c === c;
    const buf = !sameCell || now - prevTA.at > 900 ? ch : prevTA.text + ch;
    typeAheadRef.current = { text: buf, at: now, r, c };
    if (normalize(buf) === "") return;
    const hit = opts.find((o) => normalize(o).startsWith(normalize(buf)));
    if (hit !== undefined) setCells([{ r, key: col.key, raw: hit }]);
  };

  const cellText = (row, col) => {
    if (col.type === "stones") return rowToStones(row || {}).map(stoneLabel).join("; ");
    const v = row?.[effKey(row, col)];
    if (col.type === "checkbox") return v ? "TRUE" : "FALSE";
    return v === undefined || v === null ? "" : v.toString();
  };

  // What fill/fill-down carries into a cell: the stone list itself for the
  // Stones column, plain text for everything else.
  const cellRaw = (row, col) => (col.type === "stones" ? rowToStones(row || {}) : cellText(row, col));

  // Remembers what was copied from the grid, with the real values (stone
  // lists, not their label text), so pasting into another cell -- Stones
  // included -- carries the actual data.
  const clipRef = useRef(null);
  const selectionToMatrix = () => {
    const out = [];
    for (let r = selRect.r1; r <= selRect.r2; r++) {
      const line = [];
      for (let c = selRect.c1; c <= selRect.c2; c++) line.push(cellRaw(rowsRef.current[r], COLUMNS[c]));
      out.push(line);
    }
    return out;
  };

  const selectionToTsv = () => {
    const out = [];
    for (let r = selRect.r1; r <= selRect.r2; r++) {
      const line = [];
      for (let c = selRect.c1; c <= selRect.c2; c++) line.push(cellText(rowsRef.current[r], COLUMNS[c]));
      out.push(line.join("\t"));
    }
    return out.join("\n");
  };

  const clearSelection = () => {
    const changes = [];
    for (let r = selRect.r1; r <= selRect.r2; r++)
      for (let c = selRect.c1; c <= selRect.c2; c++) changes.push({ r, key: COLUMNS[c].key, raw: "" });
    setCells(changes);
  };

  // Fill handle / Ctrl+D: repeat the selected block's rows downward.
  const fillRange = (rect, toRow) => {
    if (toRow <= rect.r2) return;
    const rowsNow = rowsRef.current;
    const h = rect.r2 - rect.r1 + 1;
    const changes = [];
    for (let r = rect.r2 + 1; r <= toRow; r++) {
      for (let c = rect.c1; c <= rect.c2; c++) {
        const srcRow = rowsNow[rect.r1 + ((r - rect.r2 - 1) % h)];
        changes.push({ r, key: COLUMNS[c].key, raw: cellRaw(srcRow, COLUMNS[c]) });
      }
    }
    setCells(changes);
    setActive({ r: rect.r1, c: rect.c1 });
    setSelEnd({ r: toRow, c: rect.c2 });
  };

  const fillDownSelection = () => {
    const rowsNow = rowsRef.current;
    const changes = [];
    if (selRect.r2 > selRect.r1) {
      for (let r = selRect.r1 + 1; r <= selRect.r2; r++)
        for (let c = selRect.c1; c <= selRect.c2; c++)
          changes.push({ r, key: COLUMNS[c].key, raw: cellRaw(rowsNow[selRect.r1], COLUMNS[c]) });
    } else if (selRect.r1 > 0) {
      for (let c = selRect.c1; c <= selRect.c2; c++)
        changes.push({ r: selRect.r1, key: COLUMNS[c].key, raw: cellRaw(rowsNow[selRect.r1 - 1], COLUMNS[c]) });
    }
    setCells(changes);
  };

  // Paste a block copied from Excel/Sheets (tab-separated columns, newline-
  // separated rows) starting at the selected cell. If the first pasted line
  // looks like a header (matches the column names), columns are matched by
  // name -- any order, including the full xlsx Import template -- and the
  // data lands starting at the selected row. Otherwise it is positional from
  // the selected cell. A single value pasted onto a multi-cell selection
  // fills every selected cell, same as Excel.
  const pasteText = (text) => {
    const lines = text
      .replace(/\r/g, "")
      .split("\n")
      .filter((line, i, arr) => !(i === arr.length - 1 && line === ""));
    if (lines.length === 0) return;
    const grid = lines.map((line) => line.split("\t"));
    const r0 = selRect.r1;
    const c0 = selRect.c1;
    const multiSel = selRect.r2 > selRect.r1 || selRect.c2 > selRect.c1;
    const changes = [];

    // Pasting what was just copied from this grid: use the real values.
    const clip = clipRef.current;
    if (clip && clip.text === lines.join("\n")) {
      const m = clip.cells;
      if (m.length === 1 && m[0].length === 1 && multiSel) {
        for (let r = selRect.r1; r <= selRect.r2; r++)
          for (let c = selRect.c1; c <= selRect.c2; c++) changes.push({ r, key: COLUMNS[c].key, raw: m[0][0] });
        setCells(changes);
        return;
      }
      m.forEach((line, i) =>
        line.forEach((raw, j) => {
          const col = COLUMNS[c0 + j];
          if (col) changes.push({ r: r0 + i, key: col.key, raw });
        })
      );
      setCells(changes);
      setActive({ r: r0, c: c0 });
      setSelEnd(m.length * m[0].length > 1 ? { r: r0 + m.length - 1, c: Math.min(c0 + m[0].length - 1, COLUMNS.length - 1) } : null);
      return;
    }

    if (grid.length === 1 && grid[0].length === 1 && multiSel) {
      for (let r = selRect.r1; r <= selRect.r2; r++)
        for (let c = selRect.c1; c <= selRect.c2; c++)
          changes.push({ r, key: COLUMNS[c].key, raw: grid[0][0] });
      setCells(changes);
      return;
    }

    const firstRowHeaderKeys = grid[0].map(
      (cell) => ALL_HEADER_KEYS.find((h) => normalize(cell) === normalize(h)) || null
    );
    const hasHeader = firstRowHeaderKeys.filter((h) => h !== null).length >= 2;
    const dataLines = hasHeader ? grid.slice(1) : grid;
    const maxCols = Math.max(...grid.map((line) => line.length));
    // Without a header there's no way to tell which of the 100+ possible
    // fields a column is, so positional paste only targets the visible columns.
    const colForCell = hasHeader
      ? firstRowHeaderKeys
      : Array.from({ length: maxCols }, (_, j) => COLUMNS[c0 + j]?.key ?? null);

    dataLines.forEach((cells, gi) => {
      cells.forEach((cellValue, gj) => {
        const key = colForCell[gj];
        if (key) changes.push({ r: r0 + gi, key, raw: cellValue });
      });
    });
    setCells(changes);

    if (dataLines.length > 0) {
      setActive({ r: r0, c: c0 });
      const endC = hasHeader ? c0 : Math.min(c0 + maxCols - 1, COLUMNS.length - 1);
      setSelEnd(dataLines.length * maxCols > 1 ? { r: r0 + dataLines.length - 1, c: endC } : null);
    }
  };

  const onGridCopy = (e) => {
    if (editing) return;
    e.preventDefault();
    const text = selectionToTsv();
    clipRef.current = { text, cells: selectionToMatrix() };
    e.clipboardData.setData("text/plain", text);
  };
  const onGridCut = (e) => {
    if (editing) return;
    onGridCopy(e);
    clearSelection();
  };
  const onGridPaste = (e) => {
    if (editing) return;
    const text = e.clipboardData?.getData("text/plain");
    if (!text) return;
    e.preventDefault();
    pasteText(text);
  };

  // Fallback: if focus is on the page body rather than the grid (after
  // closing a popover, say), Ctrl+C / X / V still reach the grid.
  const clipHandlersRef = useRef({});
  clipHandlersRef.current = { copy: onGridCopy, cut: onGridCut, paste: onGridPaste };
  useEffect(() => {
    if (!isOpen) return undefined;
    const viaDoc = (name) => (e) => {
      if (e.defaultPrevented) return;
      const t = e.target;
      if (t && t.closest && t.closest("input, textarea, select, [contenteditable='true']")) return;
      clipHandlersRef.current[name](e);
    };
    const handlers = { copy: viaDoc("copy"), cut: viaDoc("cut"), paste: viaDoc("paste") };
    Object.entries(handlers).forEach(([n, h]) => document.addEventListener(n, h));
    return () => Object.entries(handlers).forEach(([n, h]) => document.removeEventListener(n, h));
  }, [isOpen]);

  const onGridKeyDown = (e) => {
    if (editing || e.target !== e.currentTarget) return;
    const k = e.key;
    if (e.ctrlKey || e.metaKey) {
      const lk = k.toLowerCase();
      if (lk === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (lk === "y") {
        e.preventDefault();
        redo();
      } else if (lk === "a") {
        e.preventDefault();
        setActive({ r: 0, c: 0 });
        setSelEnd({ r: rowsRef.current.length - 1, c: COLUMNS.length - 1 });
      } else if (lk === "d") {
        e.preventDefault();
        fillDownSelection();
      } else if (lk === "s" || (k === "Enter" && !e.shiftKey)) {
        // Ctrl+S / Ctrl+Enter: Save All
        e.preventDefault();
        if (!isSaving) saveAll();
      } else if (k === "Enter" && e.shiftKey) {
        // Ctrl+Shift+Enter: add a row at the bottom
        e.preventDefault();
        addRow();
      } else if (e.shiftKey && (k === "Delete" || k === "Backspace")) {
        // Ctrl+Shift+Delete: remove the selected rows (saved rows stay)
        e.preventDefault();
        const { r1, r2 } = selRect;
        applyRows((prev) => {
          const next = prev.filter((row, i) => i < r1 || i > r2 || row._sampleId);
          return next.length > 0 ? next : [emptyRow(stickyDefaultsRef.current)];
        });
        setSelEnd(null);
      } else if (k === "ArrowDown" || k === "ArrowUp" || k === "ArrowLeft" || k === "ArrowRight") {
        // Ctrl+arrows: jump to the edge of the grid (Shift extends the selection)
        e.preventDefault();
        const big = 1000000;
        moveActive(k === "ArrowDown" ? big : k === "ArrowUp" ? -big : 0, k === "ArrowRight" ? big : k === "ArrowLeft" ? -big : 0, e.shiftKey);
      } else if (k === "Home") {
        e.preventDefault();
        moveActive(-1000000, -1000000, e.shiftKey);
      } else if (k === "End") {
        e.preventDefault();
        moveActive(1000000, 1000000, e.shiftKey);
      }
      return; // Ctrl+C / X / V arrive as clipboard events (onGridCopy etc.)
    }
    if (e.altKey && k === "ArrowDown") {
      e.preventDefault();
      startEdit(selRect.ar, selRect.ac); // opens a dropdown cell's list
      return;
    }
    const extend = e.shiftKey;
    switch (k) {
      case "ArrowDown":
        e.preventDefault();
        moveActive(1, 0, extend);
        break;
      case "ArrowUp":
        e.preventDefault();
        moveActive(-1, 0, extend);
        break;
      case "ArrowRight":
        e.preventDefault();
        moveActive(0, 1, extend);
        break;
      case "ArrowLeft":
        e.preventDefault();
        moveActive(0, -1, extend);
        break;
      case "Tab":
        e.preventDefault();
        tabMove(e.shiftKey);
        break;
      case "Enter":
        e.preventDefault();
        moveActive(e.shiftKey ? -1 : 1, 0, false);
        break;
      case "F2":
        e.preventDefault();
        startEdit(selRect.ar, selRect.ac);
        break;
      case "Home":
        e.preventDefault();
        moveActive(0, -1000000, extend);
        break;
      case "End":
        e.preventDefault();
        moveActive(0, 1000000, extend);
        break;
      case "PageDown":
        e.preventDefault();
        moveActive(10, 0, extend);
        break;
      case "PageUp":
        e.preventDefault();
        moveActive(-10, 0, extend);
        break;
      case "Delete":
      case "Backspace":
        e.preventDefault();
        clearSelection();
        break;
      case "Escape":
        if (selEnd) {
          e.preventDefault(); // collapse the range instead of closing the modal
          setSelEnd(null);
        }
        break;
      default:
        if (k.length === 1 && !e.altKey) {
          const col = COLUMNS[selRect.ac];
          const row = rowsRef.current[selRect.ar];
          e.preventDefault();
          if (col.type === "checkbox") {
            if (k === " " && row) setCells([{ r: selRect.ar, key: col.key, raw: !row[col.key] }]);
          } else if (col.type === "text" || col.type === "number") {
            startEdit(selRect.ar, selRect.ac, k);
          } else {
            typeAhead(selRect.ar, selRect.ac, k);
          }
        }
    }
  };

  const onCellMouseDown = (e, r, c) => {
    if (e.button !== 0) return;
    if (editing && editing.r === r && editing.c === c) return;
    gridRef.current?.focus({ preventScroll: true });
    // Stones cell: the first click just selects it (so it can be copied,
    // pasted into, or drag-filled like any other cell). Clicking it again
    // while it is the only selected cell -- or double-click / Enter / F2 --
    // opens the stones popover.
    if (COLUMNS[c].type === "stones" && !e.shiftKey && active.r === r && active.c === c && !selEnd) {
      startEdit(r, c);
      return;
    }
    if (e.shiftKey) {
      setSelEnd({ r, c });
    } else {
      setActive({ r, c });
      setSelEnd(null);
    }
    draggingRef.current = true;
    dragStartRef.current = { x: e.clientX, y: e.clientY };
    pointerRef.current = { x: e.clientX, y: e.clientY };
    draggedFarRef.current = false;
  };
  const onCellMouseEnter = (r) => {
    if (fillRef.current) {
      const to = Math.max(r, fillRef.current.rect.r2);
      fillRef.current.to = to;
      setFillTo(to);
    }
  };
  const onCellMouseEnterSelect = (r, c) => {
    if (draggingRef.current && !fillRef.current) setSelEnd({ r, c });
  };
  // Dropdown cells: a plain click only SELECTS the cell (so the fill handle, copy
  // and drag-select stay usable). The list opens from the small arrow in the
  // cell, on double-click, or with Enter / F2 / typing.
  const SELECT_TYPES = ["vendor", "sampleType", "metalType", "karat", "color", "plating", "sellingType", "finding"];
  const onCellClick = (e, r, c) => {
    if (e.shiftKey || e.ctrlKey || e.metaKey) return;
    if (!SELECT_TYPES.includes(COLUMNS[c].type)) return;
    if (!e.target.closest || !e.target.closest("[data-dd]")) return; // only the arrow opens it
    if (selEnd) return; // a range was dragged out
    if (editing && editing.r === r && editing.c === c) return;
    startEdit(r, c);
  };

  // Double-click the fill handle: fill the column down as far as the data next
  // to it goes (the neighbouring column's contiguous run, like Excel), or to the
  // last row that has anything in it when the neighbours are empty.
  const autoFillDown = () => {
    const rowsNow = rowsRef.current;
    const isFilled = (r, c) => {
      const row = rowsNow[r];
      if (!row || isRowBlank(row)) return false; // default-filled blank rows aren't data
      const col = COLUMNS[c];
      if (col.type === "checkbox") return !!row[col.key];
      if (col.type === "stones") return rowToStones(row).length > 0;
      return cellText(row, col).trim() !== "";
    };
    const below = selRect.r2 + 1;
    const side = [selRect.c1 - 1, selRect.c2 + 1]
      .filter((c) => c >= 0 && c < COLUMNS.length)
      .find((c) => isFilled(below, c));
    let last = selRect.r2;
    if (side !== undefined) {
      while (isFilled(last + 1, side)) last += 1;
    } else {
      for (let r = rowsNow.length - 1; r > selRect.r2; r--) {
        if (!isRowBlank(rowsNow[r])) {
          last = r;
          break;
        }
      }
    }
    if (last > selRect.r2) fillRange(selRect, last);
  };

  const startFillDrag = (e) => {
    e.stopPropagation();
    e.preventDefault();
    fillRef.current = { rect: selRect, to: selRect.r2 };
    setFillTo(selRect.r2);
  };

  const missingLabelsFor = (row) => {
    const missing = [];
    if (!row["Style Number"].trim()) missing.push("Style Number");
    if (!row["Manufacturer Code"].trim()) missing.push("Mfr Code");
    if (row["Weight (g)"] === "" || row["Weight (g)"] === null || Number.isNaN(Number(row["Weight (g)"])))
      missing.push("Weight");
    ["Sales Weight", "Length (in)", "Width (in)", "Height (in)", "Ring Size", "Labor Cost"].forEach((k) => {
      if (row[k] !== undefined && row[k] !== null && row[k] !== "" && Number.isNaN(Number(row[k]))) missing.push(k);
    });
    if (!row.Vendor) missing.push("Vendor");
    if (!checkIfKaratIsValid(row.Karat)) missing.push("Karat");
    return missing;
  };

  // What a row's row/cell coloring and Status column should show RIGHT
  // NOW -- live, on every render, not just after a Save All click. A
  // blank row stays neutral; a row with something in it is checked
  // against the exact same required-field rules saveAll uses (unchanged
  // -- Style Number, Mfr Code, Vendor, Weight, a valid Karat) and shows
  // red immediately if any are missing, green once they're all there.
  // "saving"/"saved" from an actual save attempt always take priority,
  // and a row that failed to save for a reason beyond those required
  // fields (a DB error) keeps showing red with that message until edited.
  // A saved row keeps its database ids and a snapshot of what was saved
  // (_baseline), so editing it later sends only what actually changed.
  const rowData = (row) => {
    const out = {};
    Object.keys(row).forEach((k) => {
      if (k.startsWith("_") || k === "status" || k === "error") return;
      out[k] = row[k];
    });
    return out;
  };
  const isDirtySaved = (row) =>
    !!row._sampleId && JSON.stringify(rowData(row)) !== JSON.stringify(row._baseline || {});

  const getRowDisplayStatus = (row) => {
    if (row.status === "saving") return { kind: "saving" };
    if (row._sampleId) {
      if (row.status === "error" && row.error) return { kind: "error", message: row.error };
      return isDirtySaved(row) ? { kind: "modified" } : { kind: "saved" };
    }
    if (row.status === "saved") return { kind: "saved" };
    if (isRowBlank(row)) return { kind: "idle" };
    const missing = missingLabelsFor(row);
    if (missing.length > 0) return { kind: "error", message: `Missing: ${missing.join(", ")}` };
    if (row.status === "error" && row.error) return { kind: "error", message: row.error };
    return { kind: "ready" };
  };

  const saveAll = async () => {
    setSaveComplete(false);
    clearHistory(); // never let undo resurrect rows that have been saved
    // Only rows that still need saving: skip blank rows AND rows that already
    // saved on an earlier Save All -- a retry after a failure must never
    // re-insert the ones that went through (that would create duplicates).
    const candidateRows = rows
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => !isRowBlank(row) && (row._sampleId ? isDirtySaved(row) : row.status !== "saved"));

    if (candidateRows.length === 0) {
      if (rows.some((row) => row.status === "saved")) {
        showMessage("Everything here is already saved.");
        setSaveComplete(true);
      } else {
        showMessage("Nothing to save -- every row is empty.");
      }
      return;
    }

    const problems = [];
    candidateRows.forEach(({ row, index }) => {
      const missing = missingLabelsFor(row);
      if (missing.length > 0) problems.push(`Row ${index + 1}: missing ${missing.join(", ")}`);
    });
    if (problems.length > 0) {
      setRows((prev) => {
        const next = [...prev];
        candidateRows.forEach(({ row, index }) => {
          const missing = missingLabelsFor(row);
          if (missing.length > 0) {
            next[index] = { ...next[index], status: "error", error: `Missing: ${missing.join(", ")}` };
          }
        });
        return next;
      });
      showMessage(`Fix these rows before saving:\n${problems.join("\n")}`);
      return;
    }

    setIsSaving(true);
    setRows((prev) =>
      prev.map((row, i) => (candidateRows.some((c) => c.index === i) ? { ...row, status: "saving", error: null } : row))
    );

    // New rows: run through the SAME formatImportRow() the xlsx Import flow
    // uses, then the SAME insert function -- "one template, one save path".
    // Rows saved earlier and edited since: only the changed fields go out.
    const newCands = candidateRows.filter(({ row }) => !row._sampleId);
    const updCands = candidateRows.filter(({ row }) => row._sampleId);
    const formatted = newCands.map(({ row }) => formatImportRow(row, "samples", dropdown, prices));
    const { successfulRows: newOk, failedRows: newFailed } = formatted.length
      ? await insertFormattedSampleRows(supabase, formatted)
      : { successfulRows: [], failedRows: [] };

    const updatedOk = new Map(); // grid index -> fresh saved row (or null if nothing changed)
    const updatedFailed = new Map(); // grid index -> message
    for (const { row, index } of updCands) {
      try {
        const res = await updateFormattedSampleRow(supabase, {
          sampleId: row._sampleId,
          startingInfoId: row._siId,
          before: formatImportRow(row._baseline || {}, "samples", dropdown, prices),
          after: formatImportRow(row, "samples", dropdown, prices),
        });
        updatedOk.set(index, res.savedRow);
      } catch (err) {
        console.error("Update failed", err);
        updatedFailed.set(index, friendlyDbError(err.message));
      }
    }

    setIsSaving(false);
    clearHistory();

    const failedByPosition = new Map(newFailed.map((f) => [f.row - 1, f.error]));
    setRows((prev) => {
      const next = [...prev];
      let okIdx = 0;
      newCands.forEach(({ row, index }, i) => {
        if (failedByPosition.has(i)) {
          next[index] = { ...next[index], status: "error", error: failedByPosition.get(i) };
        } else {
          const saved = newOk[okIdx++];
          next[index] = {
            ...next[index],
            status: "saved",
            error: null,
            _sampleId: saved?.id,
            _siId: saved?.starting_info_id ?? saved?.starting_info?.id,
            _baseline: rowData(row),
          };
        }
      });
      updCands.forEach(({ row, index }) => {
        if (updatedFailed.has(index)) {
          next[index] = { ...next[index], status: "error", error: updatedFailed.get(index) };
        } else {
          next[index] = { ...next[index], status: "saved", error: null, _baseline: rowData(row) };
        }
      });
      return next;
    });

    const updatedRows = [...updatedOk.values()].filter(Boolean);
    if (newOk.length > 0 || updatedRows.length > 0) {
      onSaved([...newOk, ...updatedRows]);
    }
    if (newOk.length > 0) {
      logImportBatch(supabase, {
        type: "samples",
        sourceFilename: "Bulk Add grid",
        sampleIds: newOk.map((r) => r.id).filter(Boolean),
        createdBy: session?.user?.email || null,
      });
    }
    const failCount = newFailed.length + updatedFailed.size;
    const summary = [
      newOk.length > 0 ? `${newOk.length} new` : null,
      updatedOk.size > 0 ? `${updatedOk.size} updated` : null,
    ]
      .filter(Boolean)
      .join(", ");
    if (failCount > 0) {
      showMessage(`Saved ${summary || "0"}. ${failCount} row(s) need fixing -- see the red rows below.`);
    } else {
      showMessage(`Saved: ${summary}.`);
      // Don't auto-close -- Kevin wants a deliberate confirmation step:
      // the footer swaps to a single OK button, and closing only happens
      // when that's clicked (handleOk below). Editing a saved row again
      // brings the Save button back.
      setSaveComplete(true);
    }
  };

  // The OK button after a full, no-errors Save All -- resets the grid for
  // the next batch and actually closes the modal. This is the only place
  // that clears a completed batch; nothing else silently drops rows.
  const handleOk = () => {
    setRows(Array.from({ length: 6 }, emptyRow));
    clearHistory();
    setActive({ r: 0, c: 0 });
    setSelEnd(null);
    setEditing(null);
    stickyDefaultsRef.current = {};
    setSaveComplete(false);
    onClose();
  };

  // Clicking outside the panel or pressing Escape must not silently
  // discard whatever's been typed -- Kevin wants that path disabled, with
  // an explanation, rather than exiting quietly.
  const handleDialogAttemptClose = () => {
    showMessage('Use "Close" or "Save All" to exit -- clicking outside the window won\'t close it, so in-progress rows are never lost by accident.');
  };

  // Rows are mirrored to localStorage as you type (saveDraftRows), so closing
  // never loses them -- say so, instead of a scary discard prompt.
  const closeKeepingDraft = () => {
    const pending = rows.filter((r) => r.status !== "saved" && !isRowBlank(r)).length;
    if (pending > 0 && !saveComplete) {
      showMessage(`${pending} unsaved row${pending === 1 ? "" : "s"} kept as a draft. They'll be here when you reopen.`, { type: "info" });
    }
    onClose();
  };
  useEscapeKey(() => closeKeepingDraft(), isOpen && !isSaving);

  // Editing a saved row (or adding a new one) after a completed save brings
  // the Save button back in place of OK.
  useEffect(() => {
    if (!saveComplete) return;
    if (rows.some((r) => (r._sampleId ? isDirtySaved(r) : r.status !== "saved" && !isRowBlank(r)))) {
      setSaveComplete(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, saveComplete]);

  const savedCount = useMemo(() => rows.filter((r) => r.status === "saved").length, [rows]);

  // Non-editing cells are plain text (fast, and they can be selected like a
  // spreadsheet); the active cell swaps to a real input/select while editing.
  const renderEditor = (row, r, c, col) => {
    const cancel = () => {
      setEditing(null);
      focusGrid();
    };
    if (col.type === "text" || col.type === "number") {
      return (
        <CellInput
          initial={editing.initial}
          numeric={col.type === "number"}
          onCommit={(v, move) => commitEdit(r, c, v, move)}
          onCancel={cancel}
          onPasteBlock={(t) => {
            setEditing(null);
            pasteText(t);
            focusGrid();
          }}
        />
      );
    }
    const lower = col.type === "sellingType";
    const withBlank = col.type === "vendor" || col.type === "sampleType" || col.type === "plating";
    const opts = optionsFor(col, row) || [];
    return (
      <select
        ref={(el) => {
          if (el && !el.dataset.opened) {
            el.dataset.opened = "1";
            el.focus();
            try {
              el.showPicker?.();
            } catch {
              // showPicker needs a user gesture; the select is still focused
            }
          }
        }}
        className="w-full border border-blue-400 rounded p-1 text-xs bg-white"
        value={row[col.key] ?? ""}
        onChange={(e) => commitEdit(r, c, e.target.value, null)}
        onBlur={() => setEditing(null)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") {
            e.preventDefault();
            cancel();
          } else if (e.key === "Tab") {
            e.preventDefault();
            commitEdit(r, c, undefined, e.shiftKey ? "backtab" : "tab");
          } else if (e.key === "Enter") {
            e.preventDefault();
            commitEdit(r, c, undefined, "down");
          }
        }}
      >
        {withBlank && <option value="">--</option>}
        {opts.map((o, i) => (
          <option key={`${o}-${i}`} value={lower ? o.toLowerCase() : o}>
            {o}
          </option>
        ))}
      </select>
    );
  };

  const renderCellContent = (row, r, c, col, display) => {
    const disabled = row.status === "saving";
    if (col.type === "stones") {
      const stones = rowToStones(row);
      const open = editing && editing.r === r && editing.c === c;
      const anchorEl = open ? gridRef.current?.querySelector(`[data-cell="${r}-${c}"]`) : null;
      return (
        <>
          <StoneChips stones={stones} disabled={disabled} />
          {open && (
            <StonesPopover
              anchorRect={anchorEl?.getBoundingClientRect()}
              stones={stones}
              disabled={disabled}
              onChange={(next) => setCells([{ r, key: "Stones", raw: next }])}
              onClose={() => {
                setEditing(null);
                focusGrid();
              }}
            />
          )}
        </>
      );
    }
    if (editing && editing.r === r && editing.c === c) return renderEditor(row, r, c, col);
    if (col.type === "checkbox") {
      return (
        <input
          type="checkbox"
          tabIndex={-1}
          checked={!!row[col.key]}
          disabled={disabled}
          onMouseDown={(e) => e.preventDefault()}
          onChange={(e) => setCells([{ r, key: col.key, raw: e.target.checked }])}
          className="h-4 w-4"
        />
      );
    }
    const cellBorder =
      display.kind === "error"
        ? "border-red-400"
        : display.kind === "saved" || display.kind === "ready"
        ? "border-green-300"
        : "border-gray-200";
    const text = (row[effKey(row, col)] ?? "").toString();
    const isDropdown = SELECT_TYPES.includes(col.type);
    return (
      <div
        title={text}
        className={`relative w-full min-h-[26px] border ${cellBorder} rounded px-1 py-1 text-xs truncate ${
          isDropdown ? "pr-4" : ""
        } ${disabled ? "text-gray-400" : "text-gray-900"}`}
      >
        {text}
        {isDropdown && (
          <span
            data-dd="1"
            title="Open list"
            className="absolute right-0 top-0 h-full w-4 flex items-center justify-center text-[10px] text-gray-400 hover:text-gray-800 hover:bg-gray-200 rounded-r cursor-pointer"
          >
            ▾
          </span>
        )}
      </div>
    );
  };

  return (
    <Transition appear show={isOpen} as={Fragment}>
      <Dialog as="div" className="relative z-50" onClose={handleDialogAttemptClose}>
        <Transition.Child
          as={Fragment}
          enter="ease-out duration-300"
          enterFrom="opacity-0"
          enterTo="opacity-100"
          leave="ease-in duration-200"
          leaveFrom="opacity-100"
          leaveTo="opacity-0"
        >
          <div className="fixed inset-0 bg-black/30" />
        </Transition.Child>

        <div className="fixed inset-0 overflow-y-auto">
          <div className="flex min-h-full items-center justify-center p-4">
            <Transition.Child
              as={Fragment}
              enter="ease-out duration-300"
              enterFrom="opacity-0 scale-95"
              enterTo="opacity-100 scale-100"
              leave="ease-in duration-200"
              leaveFrom="opacity-100 scale-100"
              leaveTo="opacity-0 scale-95"
            >
              <Dialog.Panel className="w-full max-w-[95vw] transform overflow-hidden rounded-2xl bg-white p-6 text-left align-middle shadow-xl transition-all">
                <div className="flex justify-between items-center mb-3">
                  <Dialog.Title className="text-lg font-medium text-gray-900">Bulk Add Samples</Dialog.Title>
                  <div className="flex items-center gap-3">
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".csv,.xlsx"
                      onChange={handleFileUpload}
                      className="hidden"
                    />
                    <button
                      onClick={downloadSheet}
                      className="text-xs text-gray-600 hover:text-gray-900 inline-flex items-center border border-gray-300 rounded-md px-2 py-1"
                    >
                      <Download className="w-3.5 h-3.5 mr-1" />
                      Download sheet
                    </button>
                    <button
                      onClick={() => fileInputRef.current?.click()}
                      className="text-xs text-gray-600 hover:text-gray-900 inline-flex items-center border border-gray-300 rounded-md px-2 py-1"
                    >
                      <Upload className="w-3.5 h-3.5 mr-1" />
                      Upload filled sheet
                    </button>
                    <button onClick={closeKeepingDraft} className="text-gray-400 hover:text-gray-500">
                      <X className="w-5 h-5" />
                    </button>
                  </div>
                </div>

                <div
                  ref={gridRef}
                  tabIndex={0}
                  onKeyDown={onGridKeyDown}
                  onCopy={onGridCopy}
                  onCut={onGridCut}
                  onPaste={onGridPaste}
                  className="overflow-auto max-h-[65vh] border border-gray-200 rounded-lg outline-none select-none"
                >
                  <table className="table-fixed text-xs border-collapse" style={{ width: GRID_WIDTH_PX }}>
                    <colgroup>
                      <col style={{ width: ROWNUM_PX }} />
                      {COLUMNS.map((col) => (
                        <col key={col.key} style={{ width: colPx(col) }} />
                      ))}
                      <col style={{ width: STATUS_PX }} />
                      <col style={{ width: TRASH_PX }} />
                    </colgroup>
                    <thead className="bg-gray-50 sticky top-0 z-10">
                      <tr>
                        <th className="p-1 border border-gray-200"></th>
                        {COLUMNS.map((col) => (
                          <th
                            key={col.key}
                            className="p-1 border border-gray-200 text-left font-medium text-gray-600 overflow-hidden whitespace-nowrap text-ellipsis"
                          >
                            {col.label}
                            {col.required && <span className="text-red-500">*</span>}
                          </th>
                        ))}
                        <th className="p-1 border border-gray-200">Status</th>
                        <th className="p-1 border border-gray-200"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row, rowIndex) => {
                        const display = getRowDisplayStatus(row);
                        const rowBg =
                          display.kind === "saved"
                            ? "bg-green-50"
                            : display.kind === "modified"
                            ? "bg-amber-50"
                            : display.kind === "error"
                            ? "bg-red-50/40"
                            : display.kind === "saving"
                            ? "bg-blue-50/40"
                            : undefined;
                        return (
                          <tr key={row._key} className={`${rowBg || (rowIndex % 2 === 1 ? "bg-gray-100" : "bg-white")} hover:bg-sky-100`}>
                            <td className="p-1 border border-gray-200 text-center text-gray-400">{rowIndex + 1}</td>
                            {COLUMNS.map((col, colIndex) => {
                              const inSel =
                                rowIndex >= selRect.r1 &&
                                rowIndex <= selRect.r2 &&
                                colIndex >= selRect.c1 &&
                                colIndex <= selRect.c2;
                              const isActive = rowIndex === selRect.ar && colIndex === selRect.ac;
                              const inFill =
                                fillTo !== null &&
                                rowIndex > selRect.r2 &&
                                rowIndex <= fillTo &&
                                colIndex >= selRect.c1 &&
                                colIndex <= selRect.c2;
                              const isHandle = rowIndex === selRect.r2 && colIndex === selRect.c2 && !editing;
                              return (
                                <td
                                  key={col.key}
                                  data-cell={`${rowIndex}-${colIndex}`}
                                  className={`relative p-1 border border-gray-200 scroll-mt-8 overflow-hidden ${
                                    inSel && !isActive ? "bg-blue-100/70" : ""
                                  } ${isActive ? "ring-2 ring-inset ring-blue-500" : ""} ${
                                    inFill ? "bg-blue-50 ring-1 ring-inset ring-blue-300" : ""
                                  }`}
                                  onMouseDown={(e) => onCellMouseDown(e, rowIndex, colIndex)}
                                  onMouseEnter={() => {
                                    onCellMouseEnter(rowIndex);
                                    onCellMouseEnterSelect(rowIndex, colIndex);
                                  }}
                                  onClick={(e) => onCellClick(e, rowIndex, colIndex)}
                                  onDoubleClick={() => startEdit(rowIndex, colIndex)}
                                >
                                  {renderCellContent(row, rowIndex, colIndex, col, display)}
                                  {isHandle && (
                                    <div
                                      onMouseDown={startFillDrag}
                                      onDoubleClick={(e) => {
                                        e.stopPropagation();
                                        autoFillDown();
                                      }}
                                      title="Drag to fill down, double-click to fill the column"
                                      className="absolute -bottom-1 -right-1 w-2 h-2 bg-blue-600 border border-white cursor-crosshair z-20"
                                    />
                                  )}
                                </td>
                              );
                            })}
                            <td className="p-1 border border-gray-200 text-[11px] overflow-hidden whitespace-nowrap text-ellipsis">
                              {display.kind === "saving" && <span className="text-blue-600">Saving…</span>}
                              {display.kind === "saved" && <span className="text-green-700">Saved</span>}
                              {display.kind === "modified" && <span className="text-amber-700">Edited — save to update</span>}
                              {display.kind === "ready" && <span className="text-green-700">Ready</span>}
                              {display.kind === "error" && (
                                <span className="text-red-600 block truncate" title={display.message}>
                                  {display.message}
                                </span>
                              )}
                            </td>
                            <td className="p-1 border border-gray-200 text-center">
                              {!row._sampleId && row.status !== "saved" && (
                                <button
                                  onClick={() => removeRow(rowIndex)}
                                  className="text-gray-400 hover:text-red-600"
                                  title="Remove row"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                <p className="mt-2 text-[11px] text-gray-500">
                  Click or drag to select (dropdown cells open from their little arrow, or double-click); click a Stones cell again (or double-click) to add or remove stones; Stones copy, paste and drag-fill like any cell. Type to replace, F2 or double-click to edit. Enter / Tab / arrows move. Paste
                  from Excel with Ctrl+V (fills from the selected cell); one value fills the whole selection. Ctrl+C / X
                  copy / cut, Delete clears, drag the blue corner or press Ctrl+D to fill down, Ctrl+Z / Ctrl+Y undo / redo. Keyboard: arrows / Tab / Enter move, Shift+arrows select, Ctrl+arrows / Home / End / Page Up / Page Down jump, Ctrl+A selects all, F2 or Alt+Down opens a list, Ctrl+S or Ctrl+Enter saves, Ctrl+Shift+Enter adds a row, Ctrl+Shift+Delete removes the selected unsaved rows.
                </p>
                <div className="mt-3 flex items-center justify-between">
                  <div className="flex gap-2">
                    <button
                      onClick={() => addRow()}
                      className="px-3 py-1.5 text-xs font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 inline-flex items-center"
                    >
                      <Plus className="w-3.5 h-3.5 mr-1" />
                      Add row
                    </button>
                    <button
                      onClick={() => addRows(10)}
                      className="px-3 py-1.5 text-xs font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
                    >
                      +10 rows
                    </button>
                  </div>
                  <div className="flex items-center gap-3">
                    {savedCount > 0 && <span className="text-xs text-green-700">{savedCount} saved</span>}
                    {saveComplete ? (
                      <button
                        onClick={handleOk}
                        className="px-4 py-2 text-sm font-medium text-white bg-chabot-gold rounded-md hover:bg-opacity-90"
                      >
                        OK
                      </button>
                    ) : (
                      <>
                        <button
                          onClick={closeKeepingDraft}
                          className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
                        >
                          Close
                        </button>
                        <button
                          onClick={saveAll}
                          disabled={isSaving}
                          className="px-4 py-2 text-sm font-medium text-white bg-chabot-gold rounded-md hover:bg-opacity-90 disabled:opacity-60"
                        >
                          {isSaving ? "Saving…" : "Save All"}
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </Dialog.Panel>
            </Transition.Child>
          </div>
        </div>
      </Dialog>
    </Transition>
  );
};

export default BulkAddSamplesModal;

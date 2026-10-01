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
// grid works too. Only the 16 columns above render as editable cells, but
// pasting a header row recognizes every OTHER header formatImportRow.js
// reads as well (PASSTHROUGH_HEADERS below -- Collection, Plating, Length/
// Width/Height, Misc/Labor Cost, Necklace fields, all 10 Stone slots,
// etc.) and carries that value straight through to the save, unedited.
// Those fields just aren't individually editable here -- fix them on the
// sample afterward, or in the source sheet before pasting again.

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Dialog, Transition } from "@headlessui/react";
import { X, Plus, Trash2, ClipboardPaste, Copy } from "lucide-react";
import { metalTypes } from "../../utils/MetalTypeUtil";
import { useSupabase } from "../SupaBaseProvider";
import { useMetalPriceStore } from "../../store/MetalPrices";
import { useMessage } from "../Messages/MessageContext";
import { formatImportRow } from "../../utils/formatImportRow";
import { insertFormattedSampleRows, checkIfKaratIsValid } from "../../utils/insertSampleRows";
import { logImportBatch } from "../../utils/tags/tagData";

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
  { key: "Weight (g)", label: "Weight (g)", type: "number", required: true, width: "w-24" },
  { key: "Quote Description", label: "Description", type: "text", width: "w-56" },
  { key: "Type", label: "Type", type: "sampleType", width: "w-32" },
  { key: "Category", label: "Category", type: "text", width: "w-32" },
  { key: "Selling Pair", label: "Selling Pair", type: "sellingType", width: "w-24" },
  { key: "Back Type", label: "Back Type", type: "backType", width: "w-24" },
  { key: "Sales Price", label: "Sales Price", type: "number", width: "w-24" },
  { key: "Location", label: "Location", type: "text", width: "w-24" },
  { key: "In Stock", label: "In Stock", type: "checkbox", width: "w-16" },
  { key: "Qty On Hand", label: "Qty On Hand", type: "number", width: "w-20" },
];

// Every OTHER header formatImportRow.js reads for type==='samples' that
// isn't a visible grid column above. These never render as an editable
// cell, but a paste that includes one of these headers still carries that
// value straight through to the save (same field, same name, same
// formatImportRow() call the xlsx Import path uses) -- so pasting a rich
// real export works the same as uploading that file would.
const STONE_FIELDS = ["ID", "Type", "Color", "Shape", "Size", "Quantity", "Cost", "Notes"];
const PASSTHROUGH_HEADERS = [
  "ID (Sample)",
  "CAD Files",
  "Sales Weight",
  "Custom Back Type",
  "Back Type Quantity",
  "Sample Status",
  "Starting Info Id",
  "Collection",
  "Plating",
  "Plating Charge",
  "Length (in)",
  "Width (in)",
  "Height (in)",
  "Misc Cost",
  "Labor Cost",
  "Necklace True Or False",
  "Necklace Cost",
  "Total Cost",
  "Quote Images",
  "Design Id",
  ...Array.from({ length: 10 }, (_, i) => STONE_FIELDS.map((f) => `Stone ${i + 1} ${f}`)).flat(),
];
const ALL_HEADER_KEYS = [...COLUMNS.map((c) => c.key), ...PASSTHROUGH_HEADERS];

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
  "Weight (g)": "",
  "Quote Description": "",
  Type: "",
  Category: "",
  "Selling Pair": sticky["Selling Pair"] ?? "pairs",
  "Back Type": sticky["Back Type"] ?? "none",
  "Sales Price": "",
  Location: "",
  "In Stock": false,
  "Qty On Hand": "",
});

const isRowBlank = (row) =>
  !row["Style Number"].trim() &&
  !row["Manufacturer Code"].trim() &&
  !row["Weight (g)"].toString().trim() &&
  !row["Quote Description"].trim();

const normalize = (s) => (s || "").toString().trim().toLowerCase();

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
    case "backType": {
      const match = ctx.backTypeOptions.find((t) => normalize(t) === normalize(text));
      return (match || text).toLowerCase();
    }
    default:
      return text;
  }
};

const BulkAddSamplesModal = ({ isOpen, onClose, onSaved }) => {
  const { supabase, session } = useSupabase();
  const { showMessage } = useMessage();
  const { prices } = useMetalPriceStore();

  const [dropdown, setDropdown] = useState({ vendors: [], plating: [], collection: [], category: [] });
  const [formFields, setFormFields] = useState({});
  const [rows, setRows] = useState(() => Array.from({ length: 6 }, emptyRow));
  // Carries forward the last value typed/selected for these columns so a
  // new row (manual "+Add row" or auto-appended below) starts pre-filled
  // instead of making you re-pick the same vendor/metal/etc. every time --
  // Kevin: "it shouldn't take so much time ... simple and easy."
  const stickyDefaultsRef = useRef({});
  const [isSaving, setIsSaving] = useState(false);

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
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen, supabase]);

  useEffect(() => {
    if (isOpen) {
      setRows(Array.from({ length: 6 }, emptyRow));
    }
  }, [isOpen]);

  const backTypeOptions = formFields?.backType || ["none"];
  const sellingTypeOptions = formFields?.sellingType || ["pairs"];

  const STICKY_KEYS = ["Vendor", "Metal Type", "Karat", "Color", "Selling Pair", "Back Type"];

  const updateCell = (rowIndex, key, value) => {
    if (STICKY_KEYS.includes(key)) {
      stickyDefaultsRef.current = { ...stickyDefaultsRef.current, [key]: value };
    }
    setRows((prev) => {
      const next = [...prev];
      const wasBlank = isRowBlank(next[rowIndex]);
      const row = { ...next[rowIndex], [key]: value };
      if (key === "Metal Type") {
        const metal = metalTypes.find((m) => m.type === value);
        if (metal && !metal.karat.includes(row.Karat)) {
          row.Karat = metal.karat[0];
        }
      }
      next[rowIndex] = row;
      // Auto-append: once the bottom row picks up its first real value,
      // add a fresh blank one after it so there's always an empty row
      // ready -- no "Add row" click needed for straight-line entry.
      if (wasBlank && !isRowBlank(row) && rowIndex === next.length - 1) {
        next.push(emptyRow(stickyDefaultsRef.current));
      }
      return next;
    });
  };

  const addRow = () => setRows((prev) => [...prev, emptyRow(stickyDefaultsRef.current)]);
  const addRows = (n) =>
    setRows((prev) => [...prev, ...Array.from({ length: n }, () => emptyRow(stickyDefaultsRef.current))]);
  const removeRow = (rowIndex) => setRows((prev) => prev.filter((_, i) => i !== rowIndex));

  const copyHeaderRow = async () => {
    const headerLine = COLUMNS.map((c) => c.key).join("\t");
    try {
      await navigator.clipboard.writeText(headerLine);
      showMessage(
        "Column headers copied -- these are the same columns as the xlsx Import template. Paste as row 1 in Excel, fill it in, then copy everything (including that header row) back in here."
      );
    } catch {
      showMessage("Couldn't access the clipboard. Columns, in order: " + COLUMNS.map((c) => c.key).join(", "));
    }
  };

  // Paste a whole block copied from Excel/Sheets (tab-separated columns,
  // newline-separated rows). If the first pasted line looks like a header
  // (matches this grid's column names), columns are matched up by name --
  // paste in whatever order your sheet happens to be in, including the
  // exact xlsx Import template. Otherwise falls back to positional: column
  // order starting at the cell you pasted into.
  const handlePaste = (rowIndex, colIndex, e) => {
    const text = e.clipboardData?.getData("text/plain");
    if (!text || (!text.includes("\t") && !text.includes("\n"))) return; // single-cell paste behaves normally
    e.preventDefault();
    const lines = text
      .replace(/\r/g, "")
      .split("\n")
      .filter((line, i, arr) => !(i === arr.length - 1 && line === ""));
    if (lines.length === 0) return;

    const grid = lines.map((line) => line.split("\t"));
    // Match each header cell against every header formatImportRow.js
    // reads -- not just the 16 visible columns -- so a real exported sheet
    // (117 columns: stones, dimensions, costs, plating...) is recognized
    // the same way the xlsx Import path reads it.
    const firstRowHeaderKeys = grid[0].map(
      (cell) => ALL_HEADER_KEYS.find((h) => normalize(cell) === normalize(h)) || null
    );
    const recognizedCount = firstRowHeaderKeys.filter((h) => h !== null).length;
    const hasHeader = recognizedCount >= 2;
    const dataLines = hasHeader ? grid.slice(1) : grid;
    // Without a header row there's no way to tell which of the 117
    // possible fields an arbitrary column is, so positional paste (no
    // header) only ever targets the visible columns, same as before.
    const colForCell = hasHeader
      ? firstRowHeaderKeys
      : grid[0].map((_, j) => COLUMNS[colIndex + j]?.key ?? null);

    setRows((prev) => {
      const next = [...prev];
      dataLines.forEach((lineCells, gi) => {
        const targetRowIndex = rowIndex + gi;
        while (next.length <= targetRowIndex) next.push(emptyRow());
        let row = { ...next[targetRowIndex] };
        lineCells.forEach((cellValue, gj) => {
          const headerKey = colForCell[gj];
          if (!headerKey) return;
          const col = COLUMNS.find((c) => c.key === headerKey);
          row[headerKey] = col
            ? resolveCellValue(col, cellValue, {
                dropdown,
                sellingTypeOptions,
                backTypeOptions,
                rowMetalType: row["Metal Type"],
              })
            : (cellValue ?? "").toString().trim();
        });
        next[targetRowIndex] = row;
      });
      return next;
    });
  };

  const missingLabelsFor = (row) => {
    const missing = [];
    if (!row["Style Number"].trim()) missing.push("Style Number");
    if (!row["Manufacturer Code"].trim()) missing.push("Mfr Code");
    if (row["Weight (g)"] === "" || row["Weight (g)"] === null) missing.push("Weight");
    if (!row.Vendor) missing.push("Vendor");
    if (!checkIfKaratIsValid(row.Karat)) missing.push("Karat");
    return missing;
  };

  const saveAll = async () => {
    const candidateRows = rows
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => !isRowBlank(row));

    if (candidateRows.length === 0) {
      showMessage("Nothing to save -- every row is empty.");
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

    // Run every row through the SAME formatImportRow() the xlsx Import flow
    // uses, then the SAME insert function -- this is what "one template,
    // one save path" actually means.
    const formatted = candidateRows.map(({ row }) => formatImportRow(row, "samples", dropdown, prices));
    const { successfulRows, failedRows } = await insertFormattedSampleRows(supabase, formatted);

    setIsSaving(false);

    const failedByPosition = new Map(failedRows.map((f) => [f.row - 1, f.error]));
    setRows((prev) => {
      const next = [...prev];
      candidateRows.forEach(({ index }, i) => {
        if (failedByPosition.has(i)) {
          next[index] = { ...next[index], status: "error", error: failedByPosition.get(i) };
        } else {
          next[index] = { ...next[index], status: "saved", error: null };
        }
      });
      return next;
    });

    if (successfulRows.length > 0) {
      onSaved(successfulRows);
      logImportBatch(supabase, {
        type: "samples",
        sourceFilename: "Bulk Add grid",
        sampleIds: successfulRows.map((r) => r.id).filter(Boolean),
        createdBy: session?.user?.email || null,
      });
    }
    if (failedRows.length > 0) {
      showMessage(
        `Saved ${successfulRows.length} of ${candidateRows.length}. ${failedRows.length} row(s) need fixing -- see the red rows below.`
      );
    } else {
      showMessage(`Saved ${successfulRows.length} new sample${successfulRows.length === 1 ? "" : "s"}.`);
      setRows(Array.from({ length: 6 }, emptyRow));
      onClose();
    }
  };

  const savedCount = useMemo(() => rows.filter((r) => r.status === "saved").length, [rows]);

  const renderCell = (row, rowIndex, col, colIndex) => {
    const disabled = row.status === "saved";
    const cellBorder =
      row.status === "error" ? "border-red-400" : row.status === "saved" ? "border-green-300" : "border-gray-200";
    const commonProps = {
      disabled,
      onPaste: (e) => handlePaste(rowIndex, colIndex, e),
      className: `w-full border ${cellBorder} rounded p-1 text-xs`,
    };

    if (col.type === "checkbox") {
      return (
        <input
          type="checkbox"
          checked={!!row[col.key]}
          disabled={disabled}
          onChange={(e) => updateCell(rowIndex, col.key, e.target.checked)}
          className="h-4 w-4"
        />
      );
    }
    if (col.type === "vendor") {
      return (
        <select {...commonProps} value={row.Vendor} onChange={(e) => updateCell(rowIndex, "Vendor", e.target.value)}>
          <option value="">-- select --</option>
          {(dropdown.vendors || []).map((v) => (
            <option key={v.id} value={v.name}>
              {v.name}
            </option>
          ))}
        </select>
      );
    }
    if (col.type === "sampleType") {
      return (
        <select {...commonProps} value={row.Type} onChange={(e) => updateCell(rowIndex, "Type", e.target.value)}>
          <option value="">--</option>
          {(dropdown.category || []).map((c) => (
            <option key={c.id} value={c.name}>
              {c.name}
            </option>
          ))}
        </select>
      );
    }
    if (col.type === "metalType") {
      return (
        <select {...commonProps} value={row["Metal Type"]} onChange={(e) => updateCell(rowIndex, "Metal Type", e.target.value)}>
          {metalTypes.map((m) => (
            <option key={m.type} value={m.type}>
              {m.type}
            </option>
          ))}
        </select>
      );
    }
    if (col.type === "karat") {
      const metal = metalTypes.find((m) => m.type === row["Metal Type"]) || metalTypes[0];
      return (
        <select {...commonProps} value={row.Karat} onChange={(e) => updateCell(rowIndex, "Karat", e.target.value)}>
          {metal.karat.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
      );
    }
    if (col.type === "color") {
      return (
        <select {...commonProps} value={row.Color} onChange={(e) => updateCell(rowIndex, "Color", e.target.value)}>
          {metalTypes[0].color.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      );
    }
    if (col.type === "sellingType") {
      return (
        <select {...commonProps} value={row["Selling Pair"]} onChange={(e) => updateCell(rowIndex, "Selling Pair", e.target.value)}>
          {sellingTypeOptions.map((t) => (
            <option key={t} value={t.toLowerCase()}>
              {t}
            </option>
          ))}
        </select>
      );
    }
    if (col.type === "backType") {
      return (
        <select {...commonProps} value={row["Back Type"]} onChange={(e) => updateCell(rowIndex, "Back Type", e.target.value)}>
          {backTypeOptions.map((b) => (
            <option key={b} value={b.toLowerCase()}>
              {b}
            </option>
          ))}
        </select>
      );
    }
    return (
      <input
        {...commonProps}
        type={col.type === "number" ? "number" : "text"}
        value={row[col.key]}
        onChange={(e) => updateCell(rowIndex, col.key, e.target.value)}
      />
    );
  };

  return (
    <Transition appear show={isOpen} as={Fragment}>
      <Dialog as="div" className="relative z-50" onClose={() => {}}>
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
                  <div>
                    <Dialog.Title className="text-lg font-medium text-gray-900">
                      Bulk Add Samples
                    </Dialog.Title>
                    <p className="text-xs text-gray-500 mt-0.5 flex items-center gap-1">
                      <ClipboardPaste className="w-3.5 h-3.5" />
                      Same columns as the xlsx Import template -- fill in here, or build it in Excel and paste the
                      whole block in (header row optional, any order). Style Number, Mfr Code, Vendor and Weight are
                      required.
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <button
                      onClick={copyHeaderRow}
                      className="text-xs text-gray-600 hover:text-gray-900 inline-flex items-center border border-gray-300 rounded-md px-2 py-1"
                    >
                      <Copy className="w-3.5 h-3.5 mr-1" />
                      Copy headers for Excel
                    </button>
                    <button onClick={onClose} className="text-gray-400 hover:text-gray-500">
                      <X className="w-5 h-5" />
                    </button>
                  </div>
                </div>

                <div className="overflow-auto max-h-[65vh] border border-gray-200 rounded-lg">
                  <table className="min-w-full text-xs border-collapse">
                    <thead className="bg-gray-50 sticky top-0 z-10">
                      <tr>
                        <th className="p-1 border border-gray-200 w-6"></th>
                        {COLUMNS.map((col) => (
                          <th
                            key={col.key}
                            className={`p-1 border border-gray-200 text-left font-medium text-gray-600 ${col.width}`}
                          >
                            {col.label}
                            {col.required && <span className="text-red-500">*</span>}
                          </th>
                        ))}
                        <th className="p-1 border border-gray-200 w-32">Status</th>
                        <th className="p-1 border border-gray-200 w-8"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row, rowIndex) => (
                        <tr key={row._key} className={row.status === "saved" ? "bg-green-50" : undefined}>
                          <td className="p-1 border border-gray-200 text-center text-gray-400">{rowIndex + 1}</td>
                          {COLUMNS.map((col, colIndex) => (
                            <td key={col.key} className="p-1 border border-gray-200">
                              {renderCell(row, rowIndex, col, colIndex)}
                            </td>
                          ))}
                          <td className="p-1 border border-gray-200 text-[11px]">
                            {row.status === "saving" && <span className="text-blue-600">Saving…</span>}
                            {row.status === "saved" && <span className="text-green-700">Saved</span>}
                            {row.status === "error" && (
                              <span className="text-red-600" title={row.error}>
                                {row.error}
                              </span>
                            )}
                          </td>
                          <td className="p-1 border border-gray-200 text-center">
                            {row.status !== "saved" && (
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
                      ))}
                    </tbody>
                  </table>
                </div>

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
                    <button
                      onClick={onClose}
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

// Bulk "beefed up excel" sample entry -- Kevin, 2026-09-30.
//
// Paste or type many new samples at once, Excel-style, then save them all
// in one pass. Each row runs the exact same insert sequence AddSampleModal
// uses (starting_info insert -> samples insert, referencing the new
// starting_info id) so bulk-added rows are indistinguishable from ones
// added one at a time -- same required fields, same sanitization, same
// re-fetch into `sample_with_stones_export` shape before handing the row
// back to the caller.
//
// This intentionally does NOT cover every AddSampleModal field (no images,
// stones, CAD, SSP finding/sub-category, or "Board"/collection picker --
// those are edit-tiered fields you can fill in on the sample afterward).
// It covers the fields you fill in for every new item, fast.

import { Fragment, useEffect, useMemo, useState } from "react";
import { Dialog, Transition } from "@headlessui/react";
import { X, Plus, Trash2, ClipboardPaste } from "lucide-react";
import { metalTypes } from "../../utils/MetalTypeUtil";
import { useSupabase } from "../SupaBaseProvider";
import { useGenericStore } from "../../store/VendorStore";
import { useMessage } from "../Messages/MessageContext";
import { logError } from "../../utils/logEvent";


const emptyRow = () => ({
  _key: Math.random().toString(36).slice(2),
  status: "idle", // idle | saving | saved | error
  error: null,
  styleNumber: "",
  manufacturerCode: "",
  vendor: "",
  metalType: "Gold",
  karat: "10K",
  color: "Yellow",
  weight: "",
  description: "",
  type: "",
  selling_pair: "pairs",
  back_type: "none",
  salesPrice: "",
  location: "",
  qty_on_hand: "",
  in_stock: false,
});

const isRowBlank = (row) =>
  !row.styleNumber.trim() &&
  !row.manufacturerCode.trim() &&
  !row.weight.toString().trim() &&
  !row.description.trim();

// Columns in grid order. `key` matches the row field above.
const COLUMNS = [
  { key: "styleNumber", label: "Style Number", type: "text", required: true, width: "w-32" },
  { key: "manufacturerCode", label: "Mfr Code", type: "text", required: true, width: "w-28" },
  { key: "vendor", label: "Vendor", type: "vendor", required: true, width: "w-32" },
  { key: "metalType", label: "Metal", type: "metalType", width: "w-24" },
  { key: "karat", label: "Karat", type: "karat", width: "w-20" },
  { key: "color", label: "Color", type: "color", width: "w-24" },
  { key: "weight", label: "Weight (g)", type: "number", required: true, width: "w-24" },
  { key: "description", label: "Description", type: "text", width: "w-56" },
  { key: "type", label: "Type", type: "sampleType", width: "w-32" },
  { key: "selling_pair", label: "Selling type", type: "sellingType", width: "w-24" },
  { key: "back_type", label: "Back Type", type: "backType", width: "w-24" },
  { key: "salesPrice", label: "Sales Price", type: "number", width: "w-24" },
  { key: "location", label: "Location", type: "text", width: "w-24" },
  { key: "qty_on_hand", label: "Qty on hand", type: "number", width: "w-20" },
  { key: "in_stock", label: "In stock", type: "checkbox", width: "w-16" },
];

const BulkAddSamplesModal = ({ isOpen, onClose, onSaved }) => {
  const { supabase } = useSupabase();
  const { showMessage } = useMessage();
  const { getEntity } = useGenericStore();
  const vendors = getEntity("vendors") || [];
  const { formFields } = getEntity("settings")?.options || {};

  const [typeRows, setTypeRows] = useState([]);
  const [rows, setRows] = useState(() => Array.from({ length: 6 }, emptyRow));
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from("category")
        .select("id,name,ssp_product_type,ssp_category");
      if (cancelled) return;
      if (error) console.error("Error fetching types:", error);
      setTypeRows(data || []);
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

  const updateCell = (rowIndex, key, value) => {
    setRows((prev) => {
      const next = [...prev];
      const row = { ...next[rowIndex], [key]: value };
      if (key === "metalType") {
        // Reset karat to the first valid option for the newly chosen metal,
        // same as AddSampleModal's own metal/karat coupling.
        const metal = metalTypes.find((m) => m.type === value);
        if (metal && !metal.karat.includes(row.karat)) {
          row.karat = metal.karat[0];
        }
      }
      next[rowIndex] = row;
      return next;
    });
  };

  const addRow = () => setRows((prev) => [...prev, emptyRow()]);
  const addRows = (n) => setRows((prev) => [...prev, ...Array.from({ length: n }, emptyRow)]);
  const removeRow = (rowIndex) =>
    setRows((prev) => prev.filter((_, i) => i !== rowIndex));

  // Paste tab/newline-delimited text (an Excel/Sheets copy) starting at the
  // pasted cell, same shape as pasting directly into a spreadsheet. Rows
  // are added automatically if the paste runs past the bottom of the grid.
  const handlePaste = (rowIndex, colIndex, e) => {
    const text = e.clipboardData?.getData("text/plain");
    if (!text || !text.includes("\t") && !text.includes("\n")) return; // let a single-cell paste behave normally
    e.preventDefault();
    const grid = text
      .replace(/\r/g, "")
      .split("\n")
      .filter((line, i, arr) => !(i === arr.length - 1 && line === ""))
      .map((line) => line.split("\t"));

    setRows((prev) => {
      const next = [...prev];
      grid.forEach((lineCells, gi) => {
        const targetRowIndex = rowIndex + gi;
        while (next.length <= targetRowIndex) next.push(emptyRow());
        let row = { ...next[targetRowIndex] };
        lineCells.forEach((cellValue, gj) => {
          const col = COLUMNS[colIndex + gj];
          if (!col) return;
          if (col.type === "checkbox") {
            row[col.key] = /^(true|yes|1|x)$/i.test(cellValue.trim());
          } else {
            row[col.key] = cellValue.trim();
          }
        });
        next[targetRowIndex] = row;
      });
      return next;
    });
  };

  const missingLabelsFor = (row) => {
    const missing = [];
    if (!row.styleNumber.trim()) missing.push("Style Number");
    if (!row.manufacturerCode.trim()) missing.push("Mfr Code");
    if (row.weight === "" || row.weight === null) missing.push("Weight");
    if (!row.vendor) missing.push("Vendor");
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

    // Validate up front so nothing partially saves on an obviously bad sheet.
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
    const savedRows = [];
    // Sequential, not parallel -- keeps error attribution per-row honest and
    // avoids hammering Supabase with dozens of simultaneous inserts.
    for (const { row, index } of candidateRows) {
      setRows((prev) => {
        const next = [...prev];
        next[index] = { ...next[index], status: "saving", error: null };
        return next;
      });

      try {
        const sanitizedStartingInfo = {
          description: row.description || "",
          metalType: row.metalType,
          karat: row.karat,
          color: row.color,
          height: null,
          length: null,
          width: null,
          weight: row.weight !== "" ? parseFloat(row.weight) : null,
          ring_size: null,
          finding_type: null,
          manufacturerCode: row.manufacturerCode,
          platingCharge: null,
          vendor: row.vendor ? Number(row.vendor) : null,
          plating: 1,
          necklace: false,
          necklaceCost: null,
          salesPrice: row.salesPrice !== "" ? parseFloat(row.salesPrice) : null,
          collection: null,
          type: row.type ? Number(row.type) : null,
          category: null,
          status: "Working_on_it:yellow",
        };

        const { data: startingInfoData, error: startingInfoError } = await supabase
          .from("starting_info")
          .insert([sanitizedStartingInfo])
          .select("id");

        if (startingInfoError) {
          await logError(supabase, {
            source: "samples",
            action: "bulk-create-starting_info",
            message: `Failed to save starting info for ${row.styleNumber || "(no style #)"}: ${startingInfoError.message}`,
            details: { payload: sanitizedStartingInfo, error: startingInfoError, styleNumber: row.styleNumber },
          });
          throw new Error(startingInfoError.message);
        }

        const startingInfoId = startingInfoData[0]?.id;

        const sanitizedFormData = {
          collection: null,
          selling_pair: row.selling_pair || "pairs",
          back_type: row.back_type || "none",
          custom_back_type: "",
          back_type_quantity: 0,
          styleNumber: row.styleNumber,
          salesWeight: null,
          location: (row.location || "").trim() || null,
          in_stock: !!row.in_stock,
          qty_on_hand: row.qty_on_hand !== "" ? Number(row.qty_on_hand) : 0,
          status: "Working_on_it:yellow",
        };

        const { data: sampleData, error: sampleError } = await supabase
          .from("samples")
          .insert([{ ...sanitizedFormData, starting_info_id: startingInfoId }])
          .select("*, starting_info(*)");

        if (sampleError) {
          await logError(supabase, {
            source: "samples",
            action: "bulk-create-sample",
            message: `Failed to save sample ${row.styleNumber || "(no style #)"}: ${sampleError.message}`,
            details: { payload: { ...sanitizedFormData, starting_info_id: startingInfoId }, error: sampleError, styleNumber: row.styleNumber },
          });
          throw new Error(sampleError.message);
        }

        // Re-fetch in the shape SampleList/SampleCard expect, same reason
        // AddSampleModal does this -- the raw insert result is keyed by
        // `id`, but the rest of the app expects `sample_id`.
        const newSampleId = sampleData[0]?.id;
        let newRowForList = sampleData[0] ? { ...sampleData[0], sample_id: newSampleId } : sampleData[0];
        if (newSampleId != null) {
          const { data: exportedRow, error: exportError } = await supabase
            .from("sample_with_stones_export")
            .select("*")
            .eq("sample_id", newSampleId)
            .maybeSingle();
          if (!exportError && exportedRow) newRowForList = exportedRow;
        }

        savedRows.push(newRowForList);
        setRows((prev) => {
          const next = [...prev];
          next[index] = { ...next[index], status: "saved", error: null };
          return next;
        });
      } catch (err) {
        setRows((prev) => {
          const next = [...prev];
          next[index] = { ...next[index], status: "error", error: err?.message || String(err) };
          return next;
        });
      }
    }

    setIsSaving(false);

    if (savedRows.length > 0) {
      onSaved(savedRows);
    }
    const failedCount = candidateRows.length - savedRows.length;
    if (failedCount > 0) {
      showMessage(`Saved ${savedRows.length} of ${candidateRows.length}. ${failedCount} row(s) need fixing -- see the red rows below.`);
    } else {
      showMessage(`Saved ${savedRows.length} new sample${savedRows.length === 1 ? "" : "s"}.`);
      // A clean sweep -- close and reset, same as AddSampleModal after a
      // single successful save.
      setRows(Array.from({ length: 6 }, emptyRow));
      onClose();
    }
  };

  const savedCount = useMemo(() => rows.filter((r) => r.status === "saved").length, [rows]);

  const renderCell = (row, rowIndex, col, colIndex) => {
    const commonPasteProps = { onPaste: (e) => handlePaste(rowIndex, colIndex, e) };
    const cellBorder =
      row.status === "error"
        ? "border-red-400"
        : row.status === "saved"
        ? "border-green-300"
        : "border-gray-200";

    if (col.type === "checkbox") {
      return (
        <input
          type="checkbox"
          checked={!!row[col.key]}
          disabled={row.status === "saved"}
          onChange={(e) => updateCell(rowIndex, col.key, e.target.checked)}
          className="h-4 w-4"
        />
      );
    }
    if (col.type === "vendor") {
      return (
        <select
          {...commonPasteProps}
          value={row.vendor}
          disabled={row.status === "saved"}
          onChange={(e) => updateCell(rowIndex, "vendor", e.target.value)}
          className={`w-full border ${cellBorder} rounded p-1 text-xs`}
        >
          <option value="">-- select --</option>
          {vendors.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
        </select>
      );
    }
    if (col.type === "metalType") {
      return (
        <select
          {...commonPasteProps}
          value={row.metalType}
          disabled={row.status === "saved"}
          onChange={(e) => updateCell(rowIndex, "metalType", e.target.value)}
          className={`w-full border ${cellBorder} rounded p-1 text-xs`}
        >
          {metalTypes.map((m) => (
            <option key={m.type} value={m.type}>
              {m.type}
            </option>
          ))}
        </select>
      );
    }
    if (col.type === "karat") {
      const metal = metalTypes.find((m) => m.type === row.metalType) || metalTypes[0];
      return (
        <select
          {...commonPasteProps}
          value={row.karat}
          disabled={row.status === "saved"}
          onChange={(e) => updateCell(rowIndex, "karat", e.target.value)}
          className={`w-full border ${cellBorder} rounded p-1 text-xs`}
        >
          {metal.karat.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
      );
    }
    if (col.type === "color") {
      const metal = metalTypes.find((m) => m.type === row.metalType) || metalTypes[0];
      return (
        <select
          {...commonPasteProps}
          value={row.color}
          disabled={row.status === "saved"}
          onChange={(e) => updateCell(rowIndex, "color", e.target.value)}
          className={`w-full border ${cellBorder} rounded p-1 text-xs`}
        >
          {metal.color.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      );
    }
    if (col.type === "sampleType") {
      return (
        <select
          {...commonPasteProps}
          value={row.type}
          disabled={row.status === "saved"}
          onChange={(e) => updateCell(rowIndex, "type", e.target.value)}
          className={`w-full border ${cellBorder} rounded p-1 text-xs`}
        >
          <option value="">--</option>
          {typeRows.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      );
    }
    if (col.type === "sellingType") {
      return (
        <select
          {...commonPasteProps}
          value={row.selling_pair}
          disabled={row.status === "saved"}
          onChange={(e) => updateCell(rowIndex, "selling_pair", e.target.value)}
          className={`w-full border ${cellBorder} rounded p-1 text-xs`}
        >
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
        <select
          {...commonPasteProps}
          value={row.back_type}
          disabled={row.status === "saved"}
          onChange={(e) => updateCell(rowIndex, "back_type", e.target.value)}
          className={`w-full border ${cellBorder} rounded p-1 text-xs`}
        >
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
        {...commonPasteProps}
        type={col.type === "number" ? "number" : "text"}
        value={row[col.key]}
        disabled={row.status === "saved"}
        onChange={(e) => updateCell(rowIndex, col.key, e.target.value)}
        className={`w-full border ${cellBorder} rounded p-1 text-xs`}
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
                      Paste straight from Excel/Sheets into any cell, or type row by row. Style Number, Mfr Code, Vendor and Weight are required.
                    </p>
                  </div>
                  <button onClick={onClose} className="text-gray-400 hover:text-gray-500">
                    <X className="w-5 h-5" />
                  </button>
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
                          <td className="p-1 border border-gray-200 text-center text-gray-400">
                            {rowIndex + 1}
                          </td>
                          {COLUMNS.map((col, colIndex) => (
                            <td key={col.key} className="p-1 border border-gray-200">
                              {renderCell(row, rowIndex, col, colIndex)}
                            </td>
                          ))}
                          <td className="p-1 border border-gray-200 text-[11px]">
                            {row.status === "saving" && <span className="text-blue-600">Saving…</span>}
                            {row.status === "saved" && <span className="text-green-700">Saved</span>}
                            {row.status === "error" && (
                              <span className="text-red-600" title={row.error}>{row.error}</span>
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
                    {savedCount > 0 && (
                      <span className="text-xs text-green-700">{savedCount} saved</span>
                    )}
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

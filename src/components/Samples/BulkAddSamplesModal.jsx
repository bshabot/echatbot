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

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Dialog, Transition } from "@headlessui/react";
import { X, Plus, Trash2, Download, Upload } from "lucide-react";
import * as XLSX from "xlsx";
import { metalTypes } from "../../utils/MetalTypeUtil";
import { useSupabase } from "../SupaBaseProvider";
import { useMetalPriceStore } from "../../store/MetalPrices";
import { useMessage } from "../Messages/MessageContext";
import { formatImportRow } from "../../utils/formatImportRow";
import { insertFormattedSampleRows, checkIfKaratIsValid } from "../../utils/insertSampleRows";
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
  "Back Type",
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
  "Metal Type",
  "Karat",
  "Color",
  "Vendor",
  "Plating",
  "Plating Charge",
  "Length (in)",
  "Width (in)",
  "Height (in)",
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
    const worthKeeping = rows.filter((row) => row.status !== "saved" && !isRowBlank(row));
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

  // One grid row -> one line of the download, in EXPORT_TEMPLATE_HEADERS
  // order -- pulls straight off the row object, so passthrough fields a
  // paste or upload set (stones, plating, dimensions, etc.) come along
  // too, not just the 17 visible columns.
  const rowToExportLine = (row) =>
    EXPORT_TEMPLATE_HEADERS.map((header) => {
      const value = row[header];
      if (value === undefined || value === null) return "";
      if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
      return value;
    });

  // Downloads a .xlsx in the real Export/Import column order (all 117
  // columns, plus the 3 extra fields this grid also saves that Export
  // doesn't produce -- Location, In Stock, Qty On Hand). Kevin: if
  // anything's already filled in here, download THAT -- not an empty
  // sheet -- so this doubles as "export what I've got so far" and as a
  // from-scratch template when the grid is still empty. Either way, use
  // "Upload filled sheet" below to bring it back in.
  const downloadSheet = () => {
    const filledRows = rows.filter((row) => !isRowBlank(row));
    const sheetRows = [EXPORT_TEMPLATE_HEADERS, ...filledRows.map(rowToExportLine)];
    const worksheet = XLSX.utils.aoa_to_sheet(sheetRows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Import");
    const filename =
      filledRows.length > 0 ? "bulk_add_samples.xlsx" : "bulk_add_samples_blank_template.xlsx";
    XLSX.writeFile(workbook, filename);
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
            backTypeOptions,
            rowMetalType: row["Metal Type"],
          })
        : (rawValue ?? "").toString().trim();
    });
    return row;
  };

  // Upload the filled-in template (or any real Export) back in. Appends
  // after whatever's already here -- never silently overwrites rows you
  // were already in the middle of -- and every appended row is validated
  // immediately (see getRowDisplayStatus below) so errors show red right
  // away instead of waiting for a Save All click.
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
    if (!parsedRows || parsedRows.length === 0) {
      showMessage("No rows found in that file.");
      return;
    }
    const appended = parsedRows.map((obj) => rowObjectToGridRow(obj));
    setRows((prev) => {
      const kept = prev.filter((r) => !isRowBlank(r));
      return [...kept, ...appended, emptyRow(stickyDefaultsRef.current)];
    });
    showMessage(
      `Loaded ${appended.length} row${appended.length === 1 ? "" : "s"} from the file -- check the highlighted rows below before saving.`
    );
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

  // What a row's row/cell coloring and Status column should show RIGHT
  // NOW -- live, on every render, not just after a Save All click. A
  // blank row stays neutral; a row with something in it is checked
  // against the exact same required-field rules saveAll uses (unchanged
  // -- Style Number, Mfr Code, Vendor, Weight, a valid Karat) and shows
  // red immediately if any are missing, green once they're all there.
  // "saving"/"saved" from an actual save attempt always take priority,
  // and a row that failed to save for a reason beyond those required
  // fields (a DB error) keeps showing red with that message until edited.
  const getRowDisplayStatus = (row) => {
    if (row.status === "saving") return { kind: "saving" };
    if (row.status === "saved") return { kind: "saved" };
    if (isRowBlank(row)) return { kind: "idle" };
    const missing = missingLabelsFor(row);
    if (missing.length > 0) return { kind: "error", message: `Missing: ${missing.join(", ")}` };
    if (row.status === "error" && row.error) return { kind: "error", message: row.error };
    return { kind: "ready" };
  };

  const saveAll = async () => {
    setSaveComplete(false);
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
      // Don't auto-close -- Kevin wants a deliberate confirmation step:
      // the footer swaps to a single OK button, and closing only happens
      // when that's clicked (handleOk below).
      setSaveComplete(true);
    }
  };

  // The OK button after a full, no-errors Save All -- resets the grid for
  // the next batch and actually closes the modal. This is the only place
  // that clears a completed batch; nothing else silently drops rows.
  const handleOk = () => {
    setRows(Array.from({ length: 6 }, emptyRow));
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

  const savedCount = useMemo(() => rows.filter((r) => r.status === "saved").length, [rows]);

  const renderCell = (row, rowIndex, col, colIndex) => {
    const disabled = row.status === "saved";
    const display = getRowDisplayStatus(row);
    const cellBorder =
      display.kind === "error"
        ? "border-red-400"
        : display.kind === "saved"
        ? "border-green-300"
        : display.kind === "ready"
        ? "border-green-300"
        : "border-gray-200";
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
                      {rows.map((row, rowIndex) => {
                        const display = getRowDisplayStatus(row);
                        const rowBg =
                          display.kind === "saved"
                            ? "bg-green-50"
                            : display.kind === "ready"
                            ? "bg-green-50/40"
                            : display.kind === "error"
                            ? "bg-red-50/40"
                            : display.kind === "saving"
                            ? "bg-blue-50/40"
                            : undefined;
                        return (
                          <tr key={row._key} className={rowBg}>
                            <td className="p-1 border border-gray-200 text-center text-gray-400">{rowIndex + 1}</td>
                            {COLUMNS.map((col, colIndex) => (
                              <td key={col.key} className="p-1 border border-gray-200">
                                {renderCell(row, rowIndex, col, colIndex)}
                              </td>
                            ))}
                            <td className="p-1 border border-gray-200 text-[11px]">
                              {display.kind === "saving" && <span className="text-blue-600">Saving…</span>}
                              {display.kind === "saved" && <span className="text-green-700">Saved</span>}
                              {display.kind === "ready" && <span className="text-green-700">Ready</span>}
                              {display.kind === "error" && (
                                <span className="text-red-600" title={display.message}>
                                  {display.message}
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
                        );
                      })}
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

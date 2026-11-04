// Bulk upload: a filled-in Excel/CSV template becomes item cards the vendor can review before submitting.
// Runs entirely in the browser; nothing is sent until they press Submit. The spreadsheet library is
// loaded only when this is used.
import { emptyRow } from "./fields.js";
import { parseStoneCodes } from "./stones.js";

// [header shown in the template, field key]
const COLUMNS = [
  ["Manufacturer code *", "manufacturer_code"],
  ["Type", "type"],
  ["Metal", "metal_type"],
  ["Karat", "karat"],
  ["Metal color", "color"],
  ["Plating", "plating"],
  ["Weight (g) *", "weight"],
  ["Total weight (g)", "sales_weight"],
  ["Length (mm)", "length"],
  ["Width (mm)", "width"],
  ["Height (mm)", "height"],
  ["Ring size", "ring_size"],
  ["Extension (mm)", "extension"],
  ["Factory cost *", "factory_cost"],
  ["Currency (USD or RMB) *", "cost_currency"],
  ["Detail", "detail"],
  ["Description", "description"],
  ["Stones", "stones_text"],
];

const norm = (h) => String(h ?? "").toLowerCase().replace(/\(.*?\)/g, "").replace(/[*$#:]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
const HEADER_TO_KEY = new Map(COLUMNS.map(([h, k]) => [norm(h), k]));
// A few extra spellings people use
[["code", "manufacturer_code"], ["mfr code", "manufacturer_code"], ["item code", "manufacturer_code"], ["weight", "weight"], ["metal type", "metal_type"],
 ["color", "color"], ["cost", "factory_cost"], ["factory cost", "factory_cost"], ["cost each", "factory_cost"], ["sales weight", "sales_weight"], ["total weight", "sales_weight"], ["currency", "cost_currency"], ["stone", "stones_text"], ["stone codes", "stones_text"], ["notes", "detail"]].forEach(([h, k]) => HEADER_TO_KEY.set(h, k));

const pick = (value, options) => {
  const v = String(value ?? "").trim().toLowerCase();
  if (!v) return "";
  return (options || []).find((o) => String(o).toLowerCase() === v) ?? null;
};

export function templateHeaders() {
  return COLUMNS.map(([h]) => h);
}

// Excel template with real dropdowns on every column that has a pick list (type, metal, karat, color,
// plating, stone type, stone color), fed from an "Allowed values" sheet.
export async function downloadTemplate(info) {
  const ExcelJS = (await import("exceljs")).default ?? (await import("exceljs"));
  const headers = templateHeaders();
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Items", { views: [{ state: "frozen", ySplit: 1 }] });
  const lists = wb.addWorksheet("Allowed values");

  const karats = [...new Set(Object.values(info.metals ?? {}).flat())];
  const listDefs = {
    type: info.types ?? [],
    metal: Object.keys(info.metals ?? {}),
    karat: karats,
    color: info.colors ?? [],
    plating: info.plating ?? [],
    currency: ["USD", "RMB"],
  };
  const listNames = Object.keys(listDefs);
  lists.addRow(["Type", "Metal", "Karat", "Metal color", "Plating", "Currency"]);
  const maxLen = Math.max(...Object.values(listDefs).map((l) => l.length));
  for (let i = 0; i < maxLen; i++) lists.addRow(listNames.map((n) => listDefs[n][i] ?? ""));
  lists.getRow(1).font = { bold: true };
  lists.columns.forEach((c) => (c.width = 18));
  const ref = (name) => {
    const col = String.fromCharCode(65 + listNames.indexOf(name));
    return `'Allowed values'!$${col}$2:$${col}$${Math.max(2, listDefs[name].length + 1)}`;
  };

  ws.addRow(headers);
  ws.getRow(1).font = { bold: true };
  headers.forEach((h, i) => (ws.getColumn(i + 1).width = Math.max(13, h.length + 3)));
  const example = {
    "Manufacturer code *": "AX-1001", Type: (info.types ?? [])[0] ?? "", Metal: "Silver", Karat: "925", "Metal color": "Silver",
    "Weight (g) *": 1.25, "Total weight (g)": 1.3, "Length (mm)": 10, "Width (mm)": 10, "Factory cost *": 1.8, "Currency (USD or RMB) *": "USD",
    Description: "Example row, delete it", Stones: "RS1.65-10, pearl6.0-1",
  };
  ws.addRow(headers.map((h) => example[h] ?? ""));

  // Which header gets which dropdown
  const dropdownFor = (h) => {
    const n = norm(h);
    if (n === "type") return "type";
    if (n === "metal") return "metal";
    if (n === "karat") return "karat";
    if (n === "metal color") return "color";
    if (n === "plating") return "plating";
    if (n === "currency") return "currency";
    return null;
  };
  headers.forEach((h, c) => {
    const name = dropdownFor(h);
    if (!name || !listDefs[name].length) return;
    for (let r = 2; r <= 201; r++) {
      ws.getCell(r, c + 1).dataValidation = {
        type: "list",
        allowBlank: true,
        formulae: [ref(name)],
        showErrorMessage: true,
        errorStyle: "stop",
        errorTitle: "Pick from the list",
        error: "Please choose one of the values in the dropdown.",
      };
    }
  });

  const buf = await wb.xlsx.writeBuffer();
  const url = URL.createObjectURL(new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = "item-upload-template.xlsx";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// File -> { rows, notes, skipped }. Rows use the same shape as the form; notes say what could not be matched.
export async function parseUpload(file, info, maxRows = 100) {
  const XLSX = await import("xlsx");
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array", cellDates: false });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) return { rows: [], notes: ["The file has no sheet to read."], skipped: 0 };
  const table = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: "", blankrows: false });
  if (table.length < 2) return { rows: [], notes: ["No items found. Fill in the template and try again."], skipped: 0 };

  const headers = table[0].map((h) => norm(h));
  const colKey = headers.map((h) => HEADER_TO_KEY.get(h) ?? null);
  if (!colKey.includes("manufacturer_code")) {
    return { rows: [], notes: ['Could not find the "Manufacturer code" column. Use the template headers.'], skipped: 0 };
  }

  const notes = [];
  const rows = [];
  let skipped = 0;
  for (let r = 1; r < table.length; r++) {
    const cells = table[r];
    if (!cells.some((c) => String(c).trim() !== "")) continue;
    if (rows.length >= maxRows) { skipped++; continue; }
    const row = emptyRow(info);
    row.cost_currency = ""; // no silent default: the vendor must say USD or RMB
    const rowNo = r + 1; // spreadsheet row number
    cells.forEach((cell, c) => {
      const v = String(cell ?? "").trim();
      if (!v) return;
      if (colKey[c]) row[colKey[c]] = colKey[c] === "stones_text" ? v.replace(/\r/g, "") : v;
    });
    if (String(row.manufacturer_code).toLowerCase() === "ax-1001" && /delete it/i.test(row.description)) { continue; } // the sample row

    for (const k of ["weight", "sales_weight", "length", "width", "height", "ring_size", "extension", "factory_cost"]) {
      if (row[k] !== "") row[k] = String(row[k]).replace(/[$¥,\s]/g, "");
    }
    // Pick lists: match ignoring case, otherwise leave blank and say so.
    const t = pick(row.type, info.types); if (t === null) { notes.push(`Row ${rowNo}: type "${row.type}" is not in the list`); row.type = ""; } else row.type = t;
    const pl = pick(row.plating, info.plating); if (pl === null) { notes.push(`Row ${rowNo}: plating "${row.plating}" is not in the list`); row.plating = ""; } else row.plating = pl;
    const metals = info.metals ?? {};
    const m = pick(row.metal_type, Object.keys(metals));
    if (m === null) { notes.push(`Row ${rowNo}: metal "${row.metal_type}" is not Gold, Silver or Brass`); row.metal_type = "Silver"; row.karat = (metals.Silver ?? ["925"])[0]; }
    else if (m) row.metal_type = m;
    const karatOptions = metals[row.metal_type] ?? [];
    let k = pick(row.karat, karatOptions) ?? pick(`${String(row.karat).replace(/k$/i, "")}K`, karatOptions);
    if (k === null || (k === "" && row.karat)) { notes.push(`Row ${rowNo}: karat "${row.karat}" does not fit ${row.metal_type}`); k = karatOptions[0] ?? ""; }
    row.karat = k || karatOptions[0] || "";
    const col = pick(row.color, info.colors); if (col === null) { notes.push(`Row ${rowNo}: color "${row.color}" is not in the list`); row.color = ""; } else row.color = col;
    // Currency: USD or RMB (also accepts $, ¥, CNY, yuan)
    const cur = String(row.cost_currency ?? "").trim().toLowerCase();
    if (!cur) { row.cost_currency = ""; notes.push(`Row ${rowNo}: currency is missing (USD or RMB)`); }
    else if (["usd", "$", "us$", "dollar", "dollars"].includes(cur)) row.cost_currency = "USD";
    else if (["rmb", "cny", "¥", "yuan", "rmb¥", "cn¥"].includes(cur)) row.cost_currency = "RMB";
    else { notes.push(`Row ${rowNo}: currency "${row.cost_currency}" must be USD or RMB`); row.cost_currency = ""; }
    // Stones: codes like RS1.65-10; ones we do not know yet are kept as written
    parseStoneCodes(row.stones_text).unknown.forEach((u) => notes.push(`Row ${rowNo}: stone code "${u}" is not one we know yet, it will be sent as written`));
    rows.push(row);
  }
  if (skipped) notes.push(`Only the first ${maxRows} items were loaded. ${skipped} more were left out; upload them in a second batch.`);
  return { rows, notes, skipped };
}

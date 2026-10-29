// Bulk upload: a filled-in Excel/CSV template becomes item cards the vendor can review before submitting.
// Runs entirely in the browser; nothing is sent until they press Submit. The spreadsheet library is
// loaded only when this is used.
import { emptyRow, STONE_TYPES, STONE_COLORS } from "./fields.js";

const STONE_SLOTS_IN_TEMPLATE = 3;

// [header shown in the template, field key]
const COLUMNS = [
  ["Manufacturer code *", "manufacturer_code"],
  ["Type", "type"],
  ["Metal", "metal_type"],
  ["Karat", "karat"],
  ["Metal color", "color"],
  ["Plating", "plating"],
  ["Weight (g) *", "weight"],
  ["Length (in)", "length"],
  ["Width (in)", "width"],
  ["Height (in)", "height"],
  ["Ring size", "ring_size"],
  ["Extension (in)", "extension"],
  ["Factory cost ($ each)", "factory_cost"],
  ["Detail", "detail"],
  ["Description", "description"],
];

const norm = (h) => String(h ?? "").toLowerCase().replace(/\(.*?\)/g, "").replace(/[*$#:]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
const HEADER_TO_KEY = new Map(COLUMNS.map(([h, k]) => [norm(h), k]));
// A few extra spellings people use
[["code", "manufacturer_code"], ["mfr code", "manufacturer_code"], ["item code", "manufacturer_code"], ["weight", "weight"], ["metal type", "metal_type"],
 ["color", "color"], ["cost", "factory_cost"], ["factory cost", "factory_cost"], ["notes", "detail"]].forEach(([h, k]) => HEADER_TO_KEY.set(h, k));

const pick = (value, options) => {
  const v = String(value ?? "").trim().toLowerCase();
  if (!v) return "";
  return (options || []).find((o) => String(o).toLowerCase() === v) ?? null;
};

export function templateHeaders() {
  const stones = [];
  for (let i = 1; i <= STONE_SLOTS_IN_TEMPLATE; i++) stones.push(`Stone ${i} type`, `Stone ${i} shape`, `Stone ${i} color`, `Stone ${i} size`, `Stone ${i} qty`);
  return [...COLUMNS.map(([h]) => h), ...stones];
}

export async function downloadTemplate(info) {
  const XLSX = await import("xlsx");
  const headers = templateHeaders();
  const example = {
    "Manufacturer code *": "AX-1001", Type: (info.types ?? [])[0] ?? "", Metal: "Silver", Karat: "925", "Metal color": "Silver",
    "Weight (g) *": 1.25, "Length (in)": 0.4, "Width (in)": 0.4, "Factory cost ($ each)": 1.8, Description: "Example row, delete it",
    "Stone 1 type": "CZ", "Stone 1 shape": "Round", "Stone 1 color": "White", "Stone 1 size": "4mm", "Stone 1 qty": 1,
  };
  const ws = XLSX.utils.json_to_sheet([example], { header: headers });
  ws["!cols"] = headers.map((h) => ({ wch: Math.max(12, h.length + 2) }));
  const lists = XLSX.utils.aoa_to_sheet([
    ["Type", "Metal", "Karat", "Metal color", "Plating", "Stone type", "Stone color"],
    ...Array.from({ length: Math.max((info.types ?? []).length, (info.plating ?? []).length, 12) }, (_, i) => [
      (info.types ?? [])[i] ?? "",
      Object.keys(info.metals ?? {})[i] ?? "",
      [...new Set(Object.values(info.metals ?? {}).flat())][i] ?? "",
      (info.colors ?? [])[i] ?? "",
      (info.plating ?? [])[i] ?? "",
      STONE_TYPES[i] ?? "",
      STONE_COLORS[i] ?? "",
    ]),
  ]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Items");
  XLSX.utils.book_append_sheet(wb, lists, "Allowed values");
  XLSX.writeFile(wb, "item-upload-template.xlsx");
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
  const stoneCols = headers.map((h) => {
    const m = /^stone (\d{1,2}) (type|shape|color|size|qty|quantity|notes)$/.exec(h);
    return m ? { slot: Number(m[1]) - 1, field: m[2] === "qty" ? "quantity" : m[2] } : null;
  });
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
    const stones = [];
    const rowNo = r + 1; // spreadsheet row number
    cells.forEach((cell, c) => {
      const v = String(cell ?? "").trim();
      if (!v) return;
      if (colKey[c]) row[colKey[c]] = v;
      else if (stoneCols[c]) {
        const { slot, field } = stoneCols[c];
        if (slot < 10) stones[slot] = { ...(stones[slot] || {}), [field]: v };
      }
    });
    if (String(row.manufacturer_code).toLowerCase() === "ax-1001" && /delete it/i.test(row.description)) { continue; } // the sample row

    for (const k of ["weight", "length", "width", "height", "ring_size", "extension", "factory_cost"]) {
      if (row[k] !== "") row[k] = String(row[k]).replace(/[$,\s]/g, "");
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
    row.stones = stones.filter(Boolean).map((s) => {
      const st = pick(s.type, STONE_TYPES); const sc = pick(s.color, STONE_COLORS);
      if (st === null) notes.push(`Row ${rowNo}: stone type "${s.type}" is not in the list`);
      if (sc === null) notes.push(`Row ${rowNo}: stone color "${s.color}" is not in the list`);
      return { ...s, type: st ?? "", color: sc ?? "" };
    });
    rows.push(row);
  }
  if (skipped) notes.push(`Only the first ${maxRows} items were loaded. ${skipped} more were left out; upload them in a second batch.`);
  return { rows, notes, skipped };
}

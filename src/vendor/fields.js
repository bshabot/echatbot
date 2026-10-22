// Technical fields a vendor can fill in. No price, labor, location or stock.
// Keys match the database allow-list in vendor_portal_submit.

export const EMPTY_ROW = {
  style_number: "",
  manufacturer_code: "",
  type: "",
  metal_type: "Silver",
  karat: "925",
  color: "Silver",
  weight: "",
  length: "",
  width: "",
  height: "",
  plating: "",
  selling_pair: "",
  back_type: "",
  detail: "",
  description: "",
  stones: [],
};

// Same choices as the stone form staff use (Settings > Product options).
export const STONE_TYPES = ["CZ", "Opal", "Sapphire"];
export const STONE_COLORS = ["White", "Yellow", "Blue", "Green", "Red", "Pink", "Purple", "Orange", "Brown", "Black"];

// Order used by the paste box (tab-separated, no stones).
export const PASTE_ORDER = [
  "style_number", "manufacturer_code", "type", "metal_type", "karat", "color",
  "weight", "length", "width", "height", "plating", "selling_pair", "back_type", "detail", "description",
];

export const NUMERIC = ["weight", "length", "width", "height"];

export function emptyRow(info) {
  const metal = "Silver";
  return { ...EMPTY_ROW, stones: [], metal_type: metal, karat: info?.metals?.[metal]?.[0] ?? "925" };
}

// Row -> what the server expects. Blank values are dropped.
export function toPayload(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (k === "stones") continue;
    const s = typeof v === "string" ? v.trim() : v;
    if (s === "" || s === null || s === undefined) continue;
    out[k] = s;
  }
  const stones = (row.stones || [])
    .map((st) => Object.fromEntries(Object.entries(st).filter(([, v]) => String(v ?? "").trim() !== "")))
    .filter((st) => Object.keys(st).length > 0);
  if (stones.length) out.stones = stones;
  return out;
}

export const isBlank = (row) => !row.style_number.trim() && !String(row.weight).trim();

// Stored data -> editable row.
export function fromData(data = {}) {
  const row = { ...EMPTY_ROW, stones: [] };
  for (const k of Object.keys(EMPTY_ROW)) {
    if (k === "stones") continue;
    if (data[k] !== undefined && data[k] !== null) row[k] = String(data[k]);
  }
  row.stones = Array.isArray(data.stones) ? data.stones.map((s) => ({ ...s })) : [];
  return row;
}

// Tab-separated text (copied from Excel) -> rows. A header row is skipped
// when its first cell reads like "style".
export function parsePaste(text, info) {
  const lines = text.replace(/\r/g, "").split("\n").filter((l) => l.trim() !== "");
  const rows = [];
  lines.forEach((line, i) => {
    const cells = line.split("\t");
    if (i === 0 && /^style/i.test(cells[0].trim())) return;
    const row = emptyRow(info);
    PASTE_ORDER.forEach((key, c) => {
      if (cells[c] !== undefined && cells[c].trim() !== "") row[key] = cells[c].trim();
    });
    rows.push(row);
  });
  return rows;
}

// Same rules the server applies, so mistakes show up next to the field before submit.
const NUM = /^[0-9]{1,6}(\.[0-9]{1,4})?$/;
export function validateRow(row) {
  const e = {};
  const style = String(row.style_number ?? "").trim();
  if (!style) e.style_number = "Required";
  else if (style.length > 40) e.style_number = "Too long (40 max)";
  const w = String(row.weight ?? "").trim();
  if (!w) e.weight = "Required";
  else if (!NUM.test(w) || Number(w) <= 0) e.weight = "Enter a number above 0";
  else if (Number(w) > 10000) e.weight = "Too large";
  for (const k of ["length", "width", "height"]) {
    const v = String(row[k] ?? "").trim();
    if (!v) continue;
    if (!NUM.test(v)) e[k] = "Enter a number";
    else if (Number(v) > 1000) e[k] = "Too large";
  }
  const bad = (row.stones || []).some((s) => {
    const q = String(s.quantity ?? "").trim();
    return q !== "" && !/^[0-9]{1,4}$/.test(q);
  });
  if (bad) e.stones = "Stone quantity must be a whole number";
  return e;
}

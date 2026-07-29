// src/utils/qbMapping.js
//
// A general "paste a mapping, we build the QB payload" mechanism — instead of
// hardcoding which PLM field feeds which QuickBooks field, the mapping is a
// plain two-column text block Chaim edits in Settings:
//
//   QB Field,Source
//   Customer,Static:Zales Corporation   -ZALES
//   Transaction Date,Order Date
//   RefNumber,PO Number
//   ...
//
// Each line is "QB Field,Source". Source is either a literal value
// (Static:<anything after the colon, verbatim>) or a lookup key resolved
// against that row's data. This file starts with ONE interaction — Sales
// Order Create for Purchase Orders — but the parse/resolve pieces
// (parseMappingText, resolveMappingSource) are generic and meant to be
// reused for the other interactions (Sales Order Update, Items) later.
//
// ── WHERE "SOURCE" LOOKUPS COME FROM ────────────────────────────────────────
// Two kinds of QB fields exist for a Sales Order: header fields (one value
// per PO — Customer, RefNumber, Ship Date, ...) and line fields (one value
// per PO line — Item, Quantity, Price, ...). Each gets its own lookup
// context built from the PLM's PO record (running_line_purchase_orders) and
// PO line record (running_line_po_items):
//   - A curated set of friendly aliases for the columns Chaim actually
//     named in his own company memory — "Order Date" = po_date, "No
//     Delivery Before" = ship_date, "No Delivery After" = due_date, "SKU" =
//     sku_number, "Order QTY" = quantity, "Unit Cost($)" = unit_price,
//     "Manufacturer's Model #" = vendor_style_number (Signet's own style
//     number for the item — the same value used as the QB Item's FullName,
//     NOT the SKU; SKU is Signet's internal 8-digit item number instead).
//   - Every key from running_line_po_items.raw_data — the exact literal
//     column headers from Signet's own PO export (confirmed live: "SKU",
//     "DEPT", "CLASS", "Vendor", "Order QTY", "PO Number", "Order Date",
//     "Unit Cost($)", "No Delivery After", "No Delivery Before",
//     "Manufacturer's Model #", "Merchandise Description", and more) — so
//     ANY column from the original Signet export is usable as a source,
//     not just the ones this file curates a friendly name for.
// A source that matches neither is left unresolved (the field is omitted
// from the payload rather than sent as garbage).

import { toQbAmount } from "./qbClient";

// ---------- generic mapping-text parsing ----------

/**
 * Parse "Field,Source" lines into [{ field, source }]. Blank lines and
 * lines starting with # are skipped (comments). Only the FIRST comma on a
 * line splits it — a source value is free to contain its own commas.
 */
export function parseMappingText(text) {
  return String(text || "")
    .split("\n")
    .map((line) => line.replace(/\r$/, "").trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const idx = line.indexOf(",");
      if (idx === -1) return null;
      return {
        field: line.slice(0, idx).trim(),
        // Strip only leading whitespace right after the comma — a Static:
        // value's own internal spacing (e.g. "Zales Corporation   -ZALES")
        // must survive exactly as typed.
        source: line.slice(idx + 1).replace(/^\s+/, ""),
      };
    })
    .filter(Boolean);
}

/**
 * Resolve one "source" against a lookup context object. "Static:<value>"
 * (case-insensitive prefix) returns <value> verbatim, whatever it is —
 * that's how a fixed constant (Customer, Class, Template Name, ...) gets
 * into the mapping. Anything else is looked up in `context` by key,
 * case-insensitively (so "sku" or "SKU" both find the same value).
 */
export function resolveMappingSource(source, context) {
  if (source == null) return undefined;
  const s = String(source);
  const staticMatch = s.match(/^static:(.*)$/i);
  if (staticMatch) return staticMatch[1];
  const trimmed = s.trim();
  if (!trimmed) return undefined;
  if (Object.prototype.hasOwnProperty.call(context, trimmed)) return context[trimmed];
  const foundKey = Object.keys(context).find(
    (k) => k.toLowerCase() === trimmed.toLowerCase()
  );
  return foundKey ? context[foundKey] : undefined;
}

// ---------- Sales Order Create: field vocabulary ----------

// Friendly QB field name (left column, matched case-insensitively) -> the
// connector's actual SalesOrderCreate field name. "Other" (header) and
// "Other1"/"Other2" (line) are genuinely different fields — QB's header
// custom field vs. a line custom field — so both are safe to have here
// without colliding.
export const SO_CREATE_HEADER_FIELD_KEYS = {
  customer: "customer",
  "transaction date": "txn_date",
  refnumber: "ref_number",
  "po number": "po_number",
  "due date": "due_date",
  "ship date": "ship_date",
  memo: "memo",
  class: "class_name",
  "template name": "template",
  "ship method": "ship_method",
  "to be printed": "to_be_printed",
  other: "other",
};

export const SO_CREATE_LINE_FIELD_KEYS = {
  item: "item",
  "manufacturer part number": "manufacturer_part_number",
  description: "description",
  quantity: "quantity",
  price: "rate",
  other1: "other1",
  other2: "other2",
};

// The exact mapping Chaim specified — used as both the Settings page's
// seeded default (so saving with zero edits reproduces this) and the
// fallback when nothing's configured yet.
export const DEFAULT_SO_CREATE_MAPPING_TEXT = `Customer,Static:Zales Corporation   -ZALES
Transaction Date,Order Date
RefNumber,PO Number
PO Number,PO Number
Class,Static:office
Template Name,Static:Zales Order
To Be Printed,Static:Y
Ship Date,No Delivery Before
Due Date,No Delivery After
Ship Method,Static:Titan
Item,Manufacturer's Model #
Quantity,Order QTY
Price,Unit Cost($)
Other,Order Date
Other1,SKU`;

export function getSoCreateMappingText(settings) {
  return (
    settings?.options?.qbIntegration?.mappings?.salesOrderCreate ||
    DEFAULT_SO_CREATE_MAPPING_TEXT
  );
}

// ---------- lookup contexts ----------

// Header-level source context: a PO's own columns under their friendly
// names, plus the first line's raw_data as a fallback (Order Date/PO Number
// duplicate onto every line in the original Signet export, so this covers a
// PO with zero recognized header columns some day too).
function soHeaderContext(po, firstLine) {
  return {
    ...((firstLine && firstLine.raw_data) || {}),
    "Order Date": po?.po_date,
    "PO Number": po?.po_number,
    "No Delivery Before": po?.ship_date,
    "No Delivery After": po?.due_date,
    "Lock Date": po?.lock_date,
    Memo: po?.memo,
    Notes: po?.notes,
  };
}

// Line-level source context: the exact original Signet columns (raw_data)
// spread first, then curated friendly aliases for the columns this app
// already parses cleanly (so e.g. "Order QTY" resolves to the real integer
// quantity column, not the raw scraped text).
function soLineContext(line, po) {
  return {
    ...((line && line.raw_data) || {}),
    SKU: line?.sku_number,
    "Order QTY": line?.quantity,
    "Unit Cost($)": line?.unit_price,
    "Manufacturer's Model #": line?.vendor_style_number,
    "Merchandise Description": line?.description,
    Description: line?.description,
    Quantity: line?.quantity,
    Price: line?.unit_price,
    "Order Date": po?.po_date,
    "PO Number": po?.po_number,
    "No Delivery Before": po?.ship_date,
    "No Delivery After": po?.due_date,
  };
}

// QB's own field types dictate how a resolved raw value gets coerced.
function coerceForApiField(apiField, value) {
  if (value == null || value === "") return undefined;
  if (apiField === "to_be_printed") {
    const s = String(value).trim().toLowerCase();
    return ["y", "yes", "true", "1"].includes(s);
  }
  if (apiField === "rate") return toQbAmount(value);
  return String(value);
}

/**
 * Build a SalesOrderCreate-shape payload (see qbClient.js/main.py) from a PO
 * row, its line items, and a mapping text (Field,Source per line — see file
 * header). Header rows evaluate once against the PO; line rows evaluate
 * once per PO line. other1 falls back to the SKU number when the mapping
 * doesn't set it, preserving the existing "match an SO line to a PLM line by
 * SKU" convention the update flow depends on.
 *
 * Returns { payload, unrecognizedFields } — unrecognizedFields lists any
 * "QB Field" name in the mapping that isn't in SO_CREATE_HEADER_FIELD_KEYS
 * or SO_CREATE_LINE_FIELD_KEYS, so a typo can be surfaced instead of
 * silently doing nothing.
 */
export function buildSalesOrderCreatePayloadFromMapping(po, lines, mappingText) {
  const pairs = parseMappingText(mappingText);
  const list = (lines || []).slice().sort((a, b) => (a.line_number || 0) - (b.line_number || 0));
  const firstLine = list[0];
  const hCtx = soHeaderContext(po, firstLine);

  const header = {};
  const lineRules = [];
  const unrecognizedFields = [];

  for (const { field, source } of pairs) {
    const key = field.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(SO_CREATE_HEADER_FIELD_KEYS, key)) {
      const apiField = SO_CREATE_HEADER_FIELD_KEYS[key];
      const raw = resolveMappingSource(source, hCtx);
      const val = coerceForApiField(apiField, raw);
      if (val !== undefined) header[apiField] = val;
    } else if (Object.prototype.hasOwnProperty.call(SO_CREATE_LINE_FIELD_KEYS, key)) {
      lineRules.push({ apiField: SO_CREATE_LINE_FIELD_KEYS[key], source });
    } else {
      unrecognizedFields.push(field);
    }
  }

  const builtLines = list
    .filter((l) => l && l.sku_number)
    .map((l) => {
      const ctx = soLineContext(l, po);
      const lineObj = {};
      for (const { apiField, source } of lineRules) {
        const raw = resolveMappingSource(source, ctx);
        const val = coerceForApiField(apiField, raw);
        if (val !== undefined) lineObj[apiField] = val;
      }
      if (lineObj.other1 == null) lineObj.other1 = String(l.sku_number);
      return lineObj;
    });

  return { payload: { ...header, lines: builtLines }, unrecognizedFields };
}

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
  if (apiField === "to_be_printed" || apiField === "is_manually_closed") {
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

// ---------- Sales Order Update: field vocabulary ----------

// SalesOrderUpdate's header fields (main.py) — everything SalesOrderCreate
// has EXCEPT `customer` (the connector has no way to reassign a Sales
// Order's customer after creation), plus `is_manually_closed` (update-only —
// closes the SO; not meaningful at create time). Line fields are identical
// in shape to Create's (item/manufacturer_part_number/description/quantity/
// rate/other1/other2 — see SalesOrderLineUpdate and SalesOrderNewLine in
// main.py), so Update reuses SO_CREATE_LINE_FIELD_KEYS directly rather than
// keeping a second copy of the same vocabulary in sync.
export const SO_UPDATE_HEADER_FIELD_KEYS = {
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
  "manually closed": "is_manually_closed",
};

export const SO_UPDATE_LINE_FIELD_KEYS = SO_CREATE_LINE_FIELD_KEYS;

// A conservative default — re-send the identifying/date/memo fields plus the
// line item/qty/price, matching what the old fixed-shape updater used to
// send. Chaim can broaden this in Settings the same way as the Create
// mapping.
export const DEFAULT_SO_UPDATE_MAPPING_TEXT = `PO Number,PO Number
Ship Date,No Delivery Before
Due Date,No Delivery After
Item,Manufacturer's Model #
Quantity,Order QTY
Price,Unit Cost($)
Other1,SKU`;

export function getSoUpdateMappingText(settings) {
  return (
    settings?.options?.qbIntegration?.mappings?.salesOrderUpdate ||
    DEFAULT_SO_UPDATE_MAPPING_TEXT
  );
}

function normKey(v) {
  return v == null ? "" : String(v).trim().toLowerCase();
}

/**
 * Match the lines on an existing QB Sales Order to the PLM's current PO
 * lines, so an update can target each one by its `txn_line_id` (the ONLY way
 * QuickBooks lets you modify an existing line — see SalesOrderLineUpdate in
 * the connector's main.py; a line sent without one is a brand-new line).
 *
 * ── WHY NOT MATCH ON other1 ────────────────────────────────────────────────
 * We DO stamp other1 with the SKU when creating a line, and the connector's
 * update schema accepts other1 — but its READ path doesn't return it. See
 * _so_to_dict in qb-connector/qb_connector.py: a SalesOrderLineRet is mapped
 * to { txn_line_id, item, description, quantity, rate, amount, invoiced,
 * is_manually_closed } and Other1 is never pulled off the XML. So a real SO
 * fetched from QuickBooks looks like this (PO 168578, live):
 *   { "txn_line_id": "227AE3-1784734846", "item": "N1638NK-NEW",
 *     "quantity": "50", "rate": "11.91", ... }         // no other1 at all
 * Matching on other1 therefore NEVER hits, which would send every line as an
 * add_line and DUPLICATE the whole SO instead of repricing it. `item` (the QB
 * Item FullName) is the only value QuickBooks actually gives back that we can
 * join on.
 *
 * Candidate keys per PLM line, in priority order:
 *   1. sku_number vs. the QB line's other1  — if a future connector build
 *      does return it, that's the most precise key, so it stays first.
 *   2. vendor_style_number vs. the QB line's item — the normal path today
 *      (Signet's "Manufacturer's Model #" is what we send as Item).
 *   3. sku_number vs. the QB line's item — the fallback that matters for SOs
 *      created BEFORE the Item source was fixed, when the 8-digit SKU was
 *      being written into the item field. Without this, repricing an older SO
 *      would silently duplicate its lines.
 * Comparison is trimmed + case-insensitive.
 *
 * A QB line is consumed once matched, so two PLM lines can't both claim the
 * same txn_line_id when a style appears twice on one SO.
 *
 * Returns { matches, unmatched, orphanQbLines }:
 *   matches       Map(plmLine -> { qbLine, matchedOn })
 *   unmatched     PLM lines with no QB counterpart (become add_lines)
 *   orphanQbLines QB lines with no PLM counterpart — left completely alone,
 *                 this never deletes a line
 */
export function matchSoLinesToPlmLines(existingSo, plmLines) {
  const qbLines = (existingSo?.lines || []).filter((l) => l && l.txn_line_id);
  const byOther1 = new Map();
  const byItem = new Map();
  for (const l of qbLines) {
    const o = normKey(l.other1);
    if (o) {
      if (!byOther1.has(o)) byOther1.set(o, []);
      byOther1.get(o).push(l);
    }
    const it = normKey(l.item);
    if (it) {
      if (!byItem.has(it)) byItem.set(it, []);
      byItem.get(it).push(l);
    }
  }

  const consumed = new Set();
  const take = (bucket) => {
    if (!bucket) return null;
    for (const l of bucket) if (!consumed.has(l.txn_line_id)) return l;
    return null;
  };

  const matches = new Map();
  const unmatched = [];
  for (const pl of plmLines || []) {
    if (!pl || !pl.sku_number) continue;
    const sku = normKey(pl.sku_number);
    const style = normKey(pl.vendor_style_number);
    let hit = null;
    let matchedOn = null;
    if (sku) {
      hit = take(byOther1.get(sku));
      if (hit) matchedOn = "other1=sku";
    }
    if (!hit && style) {
      hit = take(byItem.get(style));
      if (hit) matchedOn = "item=style";
    }
    if (!hit && sku) {
      hit = take(byItem.get(sku));
      if (hit) matchedOn = "item=sku";
    }
    if (hit) {
      consumed.add(hit.txn_line_id);
      matches.set(pl, { qbLine: hit, matchedOn });
    } else {
      unmatched.push(pl);
    }
  }

  return {
    matches,
    unmatched,
    orphanQbLines: qbLines.filter((l) => !consumed.has(l.txn_line_id)),
  };
}

/**
 * Build a SalesOrderUpdate-shape payload from a PO row, its current line
 * items, the SO QuickBooks already has on file (from findSalesOrder — needed
 * to map a PLM line onto QB's txn_line_id), and a mapping text (same
 * Field,Source DSL as Create — see file header). Uses the SAME mapping
 * mechanism as buildSalesOrderCreatePayloadFromMapping, just against the
 * Update field vocabulary above.
 *
 * Existing QB lines are matched to PLM lines by matchSoLinesToPlmLines above
 * (item/style first — QuickBooks doesn't return other1). A match becomes a
 * line update carrying that line's txn_line_id; a PLM line with no match
 * (added to the PO since the SO was created) is appended via add_lines. A QB
 * line with no matching PLM line is left alone — this never deletes a line.
 *
 * `priceOverrides` (optional): Map of sku_number -> new unit price — the
 * rebill calculator's price at whatever lock date is currently chosen (see
 * POLinesView.jsx's handleUpdateThisSoInQb). When a line's SKU has an entry,
 * THAT price is sent as `rate` instead of whatever the mapping's Price
 * source resolved to — the whole point of updating after choosing a new
 * lock is to push the freshly computed price, not the stale mapped one.
 *
 * Returns { payload, unrecognizedFields, matchReport, addedCount,
 * unmatchedPlmLines }. matchReport is one entry per line that matched an
 * existing QB line — { sku, style, txn_line_id, matchedOn, oldRate, newRate }
 * — so a caller can show "repriced 11.91 -> 12.40 on line 227AE3-…" instead
 * of a bare success, and spot a wrong-key match before it becomes a
 * duplicated SO.
 */
export function buildSalesOrderUpdatePayloadFromMapping(
  po,
  lines,
  existingSo,
  mappingText,
  priceOverrides
) {
  const pairs = parseMappingText(mappingText);
  const list = (lines || []).slice().sort((a, b) => (a.line_number || 0) - (b.line_number || 0));
  const firstLine = list[0];
  const hCtx = soHeaderContext(po, firstLine);

  const header = {};
  const lineRules = [];
  const unrecognizedFields = [];

  for (const { field, source } of pairs) {
    const key = field.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(SO_UPDATE_HEADER_FIELD_KEYS, key)) {
      const apiField = SO_UPDATE_HEADER_FIELD_KEYS[key];
      const raw = resolveMappingSource(source, hCtx);
      const val = coerceForApiField(apiField, raw);
      if (val !== undefined) header[apiField] = val;
    } else if (Object.prototype.hasOwnProperty.call(SO_UPDATE_LINE_FIELD_KEYS, key)) {
      lineRules.push({ apiField: SO_UPDATE_LINE_FIELD_KEYS[key], source });
    } else {
      unrecognizedFields.push(field);
    }
  }

  const { matches, unmatched } = matchSoLinesToPlmLines(existingSo, list);

  const lineUpdates = [];
  const addLines = [];
  const matchReport = [];
  for (const l of list) {
    if (!l || !l.sku_number) continue;
    const sku = String(l.sku_number);
    const ctx = soLineContext(l, po);
    const lineObj = {};
    for (const { apiField, source } of lineRules) {
      const raw = resolveMappingSource(source, ctx);
      const val = coerceForApiField(apiField, raw);
      if (val !== undefined) lineObj[apiField] = val;
    }
    // Always stamp other1 with the SKU, even though QB won't read it back —
    // it costs nothing and makes the SO carry our own key for anyone looking
    // at it in QuickBooks (and would let a future connector read it).
    if (lineObj.other1 == null) lineObj.other1 = sku;
    const override = priceOverrides?.get(sku);
    if (override != null) lineObj.rate = toQbAmount(override);

    const hit = matches.get(l);
    if (hit) {
      lineUpdates.push({ txn_line_id: hit.qbLine.txn_line_id, ...lineObj });
      matchReport.push({
        sku,
        style: l.vendor_style_number || null,
        txn_line_id: hit.qbLine.txn_line_id,
        matchedOn: hit.matchedOn,
        oldRate: hit.qbLine.rate ?? null,
        newRate: lineObj.rate ?? null,
      });
    } else {
      addLines.push(lineObj);
    }
  }

  return {
    payload: { ...header, lines: lineUpdates, add_lines: addLines },
    unrecognizedFields,
    matchReport,
    addedCount: addLines.length,
    unmatchedPlmLines: unmatched.length,
  };
}

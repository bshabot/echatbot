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
// connector's actual SalesOrderCreate field name.
//
// ── THE THREE "OTHER"s — DON'T MIX THEM UP ─────────────────────────────────
// QuickBooks has several distinct fields whose names all look alike, and
// writing to the wrong one silently puts data where nobody's looking:
//   Other      -> the BUILT-IN header field (qbXML's <Other>, <=29 chars).
//                 This is what the connector's `other` parameter writes.
//   Other1 /   -> LINE-level custom fields, per line item.
//   Other2
//   Custom:X   -> a header DATA EXTENSION named X. Written through QB's
//                 separate DataExt request (see set_txn_custom_field in
//                 qb_connector.py) — NOT the built-in Other, even when the
//                 data extension happens to also be named "Other", which is
//                 exactly the case on E. Chabot's SOs:
//                   "custom_fields": { "Other": "7/21/2026" }
//   Silver Lock Date -> shorthand for the data extension the connector calls
//                 SILVER_LOCK_FIELD (env QB_SILVER_LOCK_FIELD, default
//                 "Silver Lock Date"). Equivalent to Custom:<that name>.
// The silver lock date is a HEADER data extension, so it belongs on one of
// the last two — never on Other (built-in) or Other1 (a line field).
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
  "silver lock date": "silver_lock_date",
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
function soHeaderContext(po, firstLine, lockInfo) {
  return {
    ...((firstLine && firstLine.raw_data) || {}),
    "Order Date": po?.po_date,
    "PO Number": po?.po_number,
    "No Delivery Before": po?.ship_date,
    "No Delivery After": po?.due_date,
    Memo: po?.memo,
    Notes: po?.notes,
    ...lockSources(po, lockInfo),
  };
}

// The metal lock a PO's price was computed at — the values behind "update at
// the new lock date". `lockInfo` is the metal_lock_history row for the PO's
// chosen lock_date (fetched in qbSalesOrders.js); the date falls back to the
// PO's own lock_date so "Lock Date" resolves even without that row.
// "Silver Lock Date" is an alias for the date, since that's what Chaim calls
// the value QuickBooks carries in a line's Other1 field.
function lockSources(po, lockInfo) {
  const date = lockInfo?.date ?? po?.lock_date;
  return {
    "Lock Date": date,
    "Silver Lock Date": date,
    "Silver Lock": lockInfo?.silver_lock,
    "Gold Lock": lockInfo?.gold_lock,
  };
}

// Line-level source context: the exact original Signet columns (raw_data)
// spread first, then curated friendly aliases for the columns this app
// already parses cleanly (so e.g. "Order QTY" resolves to the real integer
// quantity column, not the raw scraped text).
function soLineContext(line, po, lockInfo) {
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
    ...lockSources(po, lockInfo),
  };
}

// ---------- dates: QuickBooks' format wins, everything converts to it ----------
//
// QuickBooks wants a date in two DIFFERENT shapes depending on where it
// lands, so there's no single "date format" to standardise on — the
// destination field decides and the source value is converted to match:
//
//   qbXML date ELEMENTS (TxnDate, ShipDate, DueDate) -> "YYYY-MM-DD".
//     qbXML's DATETYPE is ISO, and the connector interpolates these straight
//     into the XML (`<TxnDate>{txn_date}</TxnDate>` in qb_connector.py, no
//     conversion), so anything else is rejected by QuickBooks outright.
//   Custom fields / data extensions (DataExtValue) -> "M/D/YYYY".
//     These are free text and QuickBooks displays them in the company file's
//     own format, which is what E. Chabot's SOs already carry:
//     custom_fields { "Other": "7/21/2026" } — no leading zeros.
//
// Sources vary (PLM columns are ISO; Signet's raw export columns are often
// M/D/YYYY), so both parsers accept either and normalise on the way out.

// Pull {y, m, d} off a date-ish value WITHOUT going through `new Date(...)`,
// which would shift a bare "2026-07-24" by the local timezone offset and can
// land the wrong day. Returns null when the value isn't a date at all.
function dateParts(v) {
  if (v instanceof Date && !isNaN(v)) {
    return { y: v.getFullYear(), m: v.getMonth() + 1, d: v.getDate() };
  }
  const s = String(v ?? "").trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ]|$)/);
  if (m) return { y: +m[1], m: +m[2], d: +m[3] };
  m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (m) return { y: +m[3], m: +m[1], d: +m[2] };
  return null;
}

const pad2 = (n) => String(n).padStart(2, "0");

/** Date for a qbXML date element — "YYYY-MM-DD". null if not a date. */
export function toQbDate(v) {
  const p = dateParts(v);
  return p ? `${p.y}-${pad2(p.m)}-${pad2(p.d)}` : null;
}

/** Date for a QB custom field / data extension — "M/D/YYYY". null if not a date. */
export function toQbDisplayDate(v) {
  const p = dateParts(v);
  return p ? `${p.m}/${p.d}/${p.y}` : null;
}

// qbXML date elements — these must be ISO or QuickBooks rejects the request.
const QB_ISO_DATE_FIELDS = new Set(["txn_date", "due_date", "ship_date"]);

// QB's own field types dictate how a resolved raw value gets coerced.
function coerceForApiField(apiField, value) {
  if (value == null || value === "") return undefined;
  if (
    apiField === "to_be_printed" ||
    apiField === "is_manually_closed" ||
    apiField === "is_active"
  ) {
    const s = String(value).trim().toLowerCase();
    return ["y", "yes", "true", "1"].includes(s);
  }
  // Money fields go out as 2-decimal strings — QuickBooks rejects a raw float
  // with more precision (error 3045).
  if (apiField === "rate" || apiField === "price" || apiField === "cost") {
    return toQbAmount(value);
  }
  if (QB_ISO_DATE_FIELDS.has(apiField)) return toQbDate(value) ?? String(value);
  // Free-text fields QuickBooks displays verbatim — the built-in Other
  // header field and custom fields/data extensions. A date goes out the way
  // QB shows dates (M/D/YYYY, matching the "7/21/2026" convention already
  // in the file); a non-date (a memo, a code) passes through untouched.
  if (apiField === "custom" || apiField === "silver_lock_date" || apiField === "other") {
    return toQbDisplayDate(value) ?? String(value);
  }
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
  const customFields = {};
  const lineRules = [];
  const unrecognizedFields = [];

  for (const { field, source } of pairs) {
    const key = field.toLowerCase();
    const custom = customFieldName(field);
    if (custom) {
      const val = coerceForApiField("custom", resolveMappingSource(source, hCtx));
      if (val !== undefined) customFields[custom] = val;
    } else if (Object.prototype.hasOwnProperty.call(SO_CREATE_HEADER_FIELD_KEYS, key)) {
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
      // Sales-order CREATE lines never carry a description, no matter what
      // the configured mapping resolves — when a line's item doesn't exist
      // in QuickBooks yet, it gets auto-created using this line's text, and
      // a mapped Description would leak straight into that new item's own
      // description field. The item's real description is set separately,
      // deliberately, by the Samples "Create/Update in QB" flow (qbItems.js).
      // Kevin 8/12: leave it blank on create.
      delete lineObj.description;
      if (lineObj.other1 == null) lineObj.other1 = String(l.sku_number);
      return lineObj;
    });

  const payload = { ...header, lines: builtLines };
  if (Object.keys(customFields).length) payload.custom_fields = customFields;
  return { payload, unrecognizedFields };
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
  "silver lock date": "silver_lock_date",
  "manually closed": "is_manually_closed",
};

export const SO_UPDATE_LINE_FIELD_KEYS = SO_CREATE_LINE_FIELD_KEYS;

// A conservative default — re-send the identifying/date fields plus the line
// item/qty/price, and stamp the HEADER's Silver Lock Date data extension with
// the lock the price was computed at.
//
// The lock date goes to `Other` — QuickBooks' BUILT-IN header field, written
// inline in the SalesOrderMod itself (<Other>, <=29 chars). Settled
// empirically on PO 168578: writing it as a data extension (Custom:Other or
// the silver_lock_date shortcut) fails with QB error 3180 "the attribute
// definition could not be found" for BOTH names, because this company file
// has no DEFINED custom fields at all — the "Other" on the Zales form is
// the built-in field, and the custom_fields{Other:...} seen on reads is
// just how the connector surfaces it. Same name, three destinations; only
// the built-in one exists here.
//
// The update touches this header field plus line item/qty/price only —
// line-level custom fields (Other1/Other2) are deliberately left alone, so
// whatever a line's Other1 already carries in QB survives every update.
export const DEFAULT_SO_UPDATE_MAPPING_TEXT = `PO Number,PO Number
Ship Date,No Delivery Before
Due Date,No Delivery After
Other,Lock Date
Item,Manufacturer's Model #
Quantity,Order QTY
Price,Unit Cost($)`;

export function getSoUpdateMappingText(settings) {
  return (
    settings?.options?.qbIntegration?.mappings?.salesOrderUpdate ||
    DEFAULT_SO_UPDATE_MAPPING_TEXT
  );
}

// ---------- Items: field vocabulary ----------
//
// Same Field,Source DSL as the sales-order mappings, against the connector's
// ItemCreate / ItemUpdate schemas (qb-connector/main.py).
//
// `Name` is deliberately NOT mappable. The item's QuickBooks FullName is
// always the style number, because that's the value every find / update /
// exists-check addresses the item by — letting it come from somewhere else
// would break those lookups everywhere.
//
// The two schemas differ in what they accept, and the difference is not
// cosmetic: ItemUpdate has NO item_type and NO account fields at all, so
// type and accounts are create-time only. QuickBooks won't repoint an
// existing item's accounts through this connector.
export const ITEM_CREATE_FIELD_KEYS = {
  "item type": "item_type",
  description: "description",
  price: "price",
  cost: "cost",
  "income account": "account",
  "expense account": "expense_account",
  "cogs account": "cogs_account",
  "asset account": "asset_account",
  "manufacturer part number": "manufacturer_part_number",
  "preferred vendor": "preferred_vendor",
};

export const ITEM_UPDATE_FIELD_KEYS = {
  description: "description",
  price: "price",
  cost: "cost",
  "manufacturer part number": "manufacturer_part_number",
  "preferred vendor": "preferred_vendor",
  active: "is_active",
};

// Verified against the live item N3065R-7 and its PLM row: description and
// manufacturerCode already match QuickBooks exactly (R30055, and the
// description down to its double space), so those sources are confirmed, not
// assumed.
//
// Accounts are Static: on purpose — they're chart-of-accounts names, not
// per-sample data — and use the values the real item posts to. QuickBooks
// rejects a create referencing an account that doesn't exist (error 3140),
// so these must match the company file exactly.
//
// Price is intentionally absent. QuickBooks carries 72.68 on that item and
// nothing in the PLM holds that value, so sending anything would overwrite a
// price maintained in QB. Add `Price,<field>` here once there's a field that
// should own it.
export const DEFAULT_ITEM_CREATE_MAPPING_TEXT = `Item Type,Static:Inventory
Description,starting_description
Cost,totalCost
Income Account,Static:Brian
COGS Account,Static:Cost of Goods Sold
Asset Account,Static:Inventory
Manufacturer Part Number,manufacturerCode
Preferred Vendor,vendorName`;

// Update carries only what should keep tracking the PLM. No accounts or item
// type (ItemUpdate can't set them), and no Price for the reason above.
export const DEFAULT_ITEM_UPDATE_MAPPING_TEXT = `Description,starting_description
Cost,totalCost
Manufacturer Part Number,manufacturerCode
Preferred Vendor,vendorName`;

export function getItemCreateMappingText(settings) {
  return (
    settings?.options?.qbIntegration?.mappings?.itemCreate ||
    DEFAULT_ITEM_CREATE_MAPPING_TEXT
  );
}

export function getItemUpdateMappingText(settings) {
  return (
    settings?.options?.qbIntegration?.mappings?.itemUpdate ||
    DEFAULT_ITEM_UPDATE_MAPPING_TEXT
  );
}

// A sample's own flattened fields ARE the lookup context (see
// normalizeSampleForQb in qbItems.js), so any column name works as a source.
// Friendly aliases are layered on top for the ones worth naming twice.
function itemContext(rec) {
  return {
    ...(rec || {}),
    "Style Number": rec?.styleNumber,
    Description: rec?.starting_description,
    Cost: rec?.totalCost,
    "Manufacturer Code": rec?.manufacturerCode,
    // vendorName is resolved from starting_info.vendor (an integer FK) against
    // the vendors table — see attachVendorName in qbItems.js. QuickBooks needs
    // the vendor's exact name and rejects one it doesn't know, which fails the
    // WHOLE item write, so an unresolved id yields nothing rather than an id.
    Vendor: rec?.vendorName,
    "Preferred Vendor": rec?.vendorName,
  };
}

/**
 * Build an ItemCreate / ItemUpdate payload from a normalized sample record and
 * a mapping text. `name` is set by the caller from the style number, never
 * from the mapping. Returns { payload, unrecognizedFields }.
 */
export function buildItemPayloadFromMapping(rec, mappingText, { mode = "create" } = {}) {
  const keys = mode === "update" ? ITEM_UPDATE_FIELD_KEYS : ITEM_CREATE_FIELD_KEYS;
  const ctx = itemContext(rec);
  const payload = {};
  const unrecognizedFields = [];

  for (const { field, source } of parseMappingText(mappingText)) {
    const key = field.toLowerCase();
    if (key === "name") {
      // Ignored rather than flagged: it's a reasonable thing to try, and the
      // style number is applied by the caller regardless.
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(keys, key)) {
      unrecognizedFields.push(field);
      continue;
    }
    const apiField = keys[key];
    const val = coerceForApiField(apiField, resolveMappingSource(source, ctx));
    if (val !== undefined) payload[apiField] = val;
  }

  return { payload, unrecognizedFields };
}

function normKey(v) {
  return v == null ? "" : String(v).trim().toLowerCase();
}

/**
 * "Custom:Silver Lock Date" -> "Silver Lock Date"; anything else -> null.
 * A mapping row whose QB Field starts with Custom: targets a header data
 * extension BY ITS EXACT QB NAME (case and spacing preserved — QB matches
 * DataExtName literally), sent via the connector's `custom_fields` map
 * rather than any built-in field. This is the escape hatch for a custom
 * field whose name collides with a built-in one, e.g. Custom:Other.
 */
export function customFieldName(field) {
  const m = String(field || "").match(/^custom:(.+)$/i);
  return m ? m[1].trim() : null;
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
 * other1 is ALSO not a usable key for a second reason: on a Zales SO line it
 * carries the silver lock date the line was priced at, not our SKU — so it
 * isn't an identity field at all and is never compared against here.
 *
 * Candidate keys per PLM line, in priority order:
 *   1. vendor_style_number vs. the QB line's item — the normal path
 *      (Signet's "Manufacturer's Model #" is what we send as Item).
 *   2. sku_number vs. the QB line's item — the fallback that matters for SOs
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
  const byItem = new Map();
  for (const l of qbLines) {
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
    if (style) {
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
  priceOverrides,
  lockInfo
) {
  const pairs = parseMappingText(mappingText);
  const list = (lines || []).slice().sort((a, b) => (a.line_number || 0) - (b.line_number || 0));
  const firstLine = list[0];
  const hCtx = soHeaderContext(po, firstLine, lockInfo);

  const header = {};
  const customFields = {};
  const lineRules = [];
  const unrecognizedFields = [];

  for (const { field, source } of pairs) {
    const key = field.toLowerCase();
    const custom = customFieldName(field);
    if (custom) {
      const val = coerceForApiField("custom", resolveMappingSource(source, hCtx));
      if (val !== undefined) customFields[custom] = val;
    } else if (Object.prototype.hasOwnProperty.call(SO_UPDATE_HEADER_FIELD_KEYS, key)) {
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

  const { matches, unmatched, orphanQbLines } = matchSoLinesToPlmLines(existingSo, list);

  const lineUpdates = [];
  const addLines = [];
  const matchReport = [];
  for (const l of list) {
    if (!l || !l.sku_number) continue;
    const sku = String(l.sku_number);
    const ctx = soLineContext(l, po, lockInfo);
    const lineObj = {};
    for (const { apiField, source } of lineRules) {
      const raw = resolveMappingSource(source, ctx);
      const val = coerceForApiField(apiField, raw);
      if (val !== undefined) lineObj[apiField] = val;
    }
    // NOTE: no automatic other1 fallback here, unlike the create builder.
    // On a Zales SO line, Other1 holds the silver lock date — stamping the
    // SKU into it would wipe that. Other1 is written ONLY when the mapping
    // says to (the default maps it to Silver Lock Date).
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

  const payload = { ...header, lines: lineUpdates, add_lines: addLines };
  if (Object.keys(customFields).length) payload.custom_fields = customFields;

  return {
    payload,
    unrecognizedFields,
    matchReport,
    addedCount: addLines.length,
    unmatchedPlmLines: unmatched.length,
    // QB lines with no PLM counterpart. Left untouched (this never deletes),
    // but surfaced because the usual cause is a line that got duplicated by
    // an earlier bad run — e.g. PO 168578 carrying the same style twice at
    // two different rates. Seeing the count is how that gets noticed.
    //
    // Blanked-out lines are NOT reported: once a duplicate is cleared in
    // QuickBooks it comes back as { item: null, quantity: null, rate: "0.00" }
    // rather than disappearing, and nagging about an already-handled line
    // would train the warning to be ignored.
    orphanQbLines: (orphanQbLines || [])
      .filter((l) => {
        if (normKey(l.item)) return true;
        const rate = parseFloat(l.rate);
        const qty = parseFloat(l.quantity);
        return (Number.isFinite(rate) && rate !== 0) || (Number.isFinite(qty) && qty !== 0);
      })
      .map((l) => ({
        txn_line_id: l.txn_line_id,
        item: l.item ?? null,
        quantity: l.quantity ?? null,
        rate: l.rate ?? null,
      })),
  };
}

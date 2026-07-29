import React, { useState, useEffect, useMemo } from "react";
import { Link } from "react-router-dom";
import {
  Activity,
  History,
  Images,
  Landmark,
  Plus,
  Printer,
  Settings as SettingsIcon,
  Users,
  X,
} from "lucide-react";
import { useSupabase } from "../components/SupaBaseProvider";
import { useGenericStore } from "../store/VendorStore";
import { useMessage } from "../components/Messages/MessageContext";
import Loading from "../components/Loading";
import { calibratePrinter } from "../utils/tags/browserPrint";
import { normalizeModel, stripModel } from "../utils/labelOrderUtils";
import {
  DEFAULT_ITEM_DEFAULTS,
  DEFAULT_ITEM_FIELD_MAPPING,
  MAPPABLE_SAMPLE_FIELDS,
  QB_ITEM_TYPES,
} from "../utils/qbItems";
import {
  DEFAULT_SO_CREATE_MAPPING_TEXT,
  DEFAULT_SO_UPDATE_MAPPING_TEXT,
  parseMappingText,
  SO_CREATE_HEADER_FIELD_KEYS,
  SO_CREATE_LINE_FIELD_KEYS,
  SO_UPDATE_HEADER_FIELD_KEYS,
  SO_UPDATE_LINE_FIELD_KEYS,
} from "../utils/qbMapping";

// Friendly labels for known option fields; anything unknown gets auto-prettified.
const FRIENDLY_NAMES = {
  backType: "Back types",
  sellingType: "Selling types",
  color: "Colors",
  type: "Types",
  shape: "Shapes",
  size: "Sizes",
  stoneColor: "Stone colors",
  stoneType: "Stone types",
};
const prettify = (key) =>
  FRIENDLY_NAMES[key] ||
  key
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (c) => c.toUpperCase())
    .trim();

const SECTION_TITLES = {
  formFields: "Sample form options",
  stonePropertiesForm: "Stone options",
};

// Labels for the QB Item fields the mapping dropdowns below cover. `name`
// (FullName) isn't one of them on purpose — it's always the style number,
// since that's the exact value every find/update/exists-check in qbItems.js
// uses to locate the item in QuickBooks; letting it come from a different
// field would break that lookup everywhere else.
const QB_ITEM_FIELD_LABELS = {
  description: "Description",
  cost: "Cost",
  price: "Price",
  manufacturer_part_number: "Manufacturer part number",
};

// Item-create defaults — same for every item, not sourced from a sample.
// account/cogs_account/asset_account must be the EXACT FullName of an
// existing account in the QuickBooks chart of accounts (case-sensitive) —
// GET /accounts on the connector lists the real names. expense_account is
// only used when item_type isn't Inventory (a two-sided NonInventory/Service
// item); it's ignored for Inventory.
const QB_ITEM_DEFAULT_FIELDS = [
  { key: "account", label: "Income account", placeholder: "e.g. Sales" },
  { key: "cogs_account", label: "COGS account", placeholder: "e.g. Cost of Goods Sold" },
  { key: "asset_account", label: "Asset account (Inventory only)", placeholder: "e.g. Inventory Asset" },
  { key: "expense_account", label: "Expense account (non-Inventory only)", placeholder: "leave blank if item type is Inventory" },
];

const daysAgo = (dateStr) => {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d)) return null;
  return Math.floor((Date.now() - d.getTime()) / 86400000);
};

function HealthBadge({ label, value, detail, ok }) {
  const color =
    ok === null
      ? "bg-gray-100 text-gray-500"
      : ok
        ? "bg-green-100 text-green-800"
        : "bg-red-100 text-red-700";
  return (
    <div className="bg-white border rounded-md p-3 flex-1 min-w-[150px]">
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`inline-block mt-1 px-2 py-0.5 rounded text-sm font-medium ${color}`}>
        {value}
      </div>
      {detail && <div className="text-xs text-gray-400 mt-1">{detail}</div>}
    </div>
  );
}

function ChipField({ label, values, onChange }) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const v = draft.trim();
    if (!v) return;
    if (values.some((x) => x.toLowerCase() === v.toLowerCase())) {
      setDraft("");
      return;
    }
    onChange([...values, v]);
    setDraft("");
  };
  return (
    <div className="mb-4">
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      <div className="flex flex-wrap gap-2 border border-gray-300 rounded-md p-2 bg-white">
        {values.map((v, i) => (
          <span
            key={`${v}-${i}`}
            className="flex items-center gap-1 bg-gray-100 rounded-full px-3 py-1 text-sm"
          >
            {v}
            <button
              type="button"
              onClick={() => onChange(values.filter((_, j) => j !== i))}
              className="text-gray-400 hover:text-red-600"
              title={`Remove ${v}`}
            >
              <X className="w-3 h-3" />
            </button>
          </span>
        ))}
        <div className="flex items-center gap-1">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              }
            }}
            placeholder="Add..."
            className="border-0 outline-none text-sm min-w-[80px] py-1"
          />
          <button
            type="button"
            onClick={add}
            className="text-gray-400 hover:text-gray-700"
            title="Add"
          >
            <Plus className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

export default function Settings() {
  const settingsEntity = useGenericStore((state) => state.getEntity("settings"));
  const options = settingsEntity?.options || null; // null-safe: no white screen while loading
  const updateEntity = useGenericStore((state) => state.updateEntity);
  const isLoading = useGenericStore((state) => state.isLoading.settings);

  const { supabase } = useSupabase();
  const { showMessage } = useMessage();

  const [formData, setFormData] = useState(null);
  const [calibrating, setCalibrating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [health, setHealth] = useState(null);

  useEffect(() => {
    if (options && !formData) setFormData(options);
  }, [options, formData]);

  // ---------- system health ----------
  useEffect(() => {
    if (!supabase) return;
    (async () => {
      try {
        const [scrapeRes, memoRes, lockRes, linesRes, sampRes, aliasRes] =
          await Promise.all([
            supabase
              .from("signet_pos_latest")
              .select("scraped_at")
              .order("scraped_at", { ascending: false })
              .limit(1),
            supabase
              .from("running_line_purchase_orders")
              .select("memo_updated_at")
              .not("memo_updated_at", "is", null)
              .order("memo_updated_at", { ascending: false })
              .limit(1),
            supabase
              .from("metal_lock_history")
              .select("date")
              .order("date", { ascending: false })
              .limit(1),
            supabase
              .from("signet_pos_latest")
              .select("model")
              .in("order_status", ["ACKNOWLEDGED", "MODIFIED", "NEW"]),
            supabase.from("samples").select("styleNumber"),
            supabase.from("model_aliases").select("alias"),
          ]);

        const known = new Set();
        for (const s of sampRes.data || []) {
          if (!s.styleNumber) continue;
          known.add(normalizeModel(s.styleNumber));
          known.add(stripModel(s.styleNumber));
        }
        for (const a of aliasRes.data || []) known.add(normalizeModel(a.alias));
        const unmatchedSet = new Set();
        for (const l of linesRes.data || []) {
          if (!l.model) continue;
          if (!known.has(normalizeModel(l.model)) && !known.has(stripModel(l.model)))
            unmatchedSet.add(normalizeModel(l.model));
        }

        setHealth({
          scrapeDays: daysAgo(scrapeRes.data?.[0]?.scraped_at),
          memoDays: daysAgo(memoRes.data?.[0]?.memo_updated_at),
          lockDays: daysAgo(lockRes.data?.[0]?.date),
          unmatched: unmatchedSet.size,
        });
      } catch (e) {
        console.log("health check failed", e);
        setHealth({ scrapeDays: null, memoDays: null, lockDays: null, unmatched: null });
      }
    })();
  }, [supabase]);

  const dirty = useMemo(
    () => formData && options && JSON.stringify(formData) !== JSON.stringify(options),
    [formData, options]
  );

  const saveFormData = async () => {
    if (!formData) return;
    setSaving(true);
    const { error } = await supabase
      .from("settings")
      .update({ options: { ...formData } })
      .eq("id", 1);
    if (error) {
      showMessage("Save failed: " + error.message);
    } else {
      showMessage("Settings saved");
      await updateEntity("settings", { options: { ...formData } });
    }
    setSaving(false);
  };

  const handleCalibrate = async () => {
    setCalibrating(true);
    try {
      await calibratePrinter();
      showMessage(
        "Calibration sent - the printer will feed a few tags, then it's locked in"
      );
    } catch (err) {
      showMessage(
        err && err.message ? err.message : "Printer not reachable from this computer"
      );
    } finally {
      setCalibrating(false);
    }
  };

  if (isLoading || (!options && !formData)) return <Loading />;

  // QuickBooks integration master switch. Stored on the settings row as
  // options.qbIntegration.enabled and persisted through the existing "Save
  // changes" bar (toggling makes the form dirty). Default OFF — the app makes
  // no QuickBooks calls until this is turned on and saved.
  const qbEnabled = Boolean(formData?.qbIntegration?.enabled);
  const toggleQb = () =>
    setFormData((prev) => ({
      ...prev,
      qbIntegration: { ...(prev?.qbIntegration || {}), enabled: !qbEnabled },
    }));
  // Which PLM data field feeds each configurable QB Item field (description,
  // cost, price, manufacturer_part_number) when a sample gets created/updated
  // in QuickBooks — see qbItems.js's normalizeSampleForQb / getItemFieldMapping.
  // A blank selection means "don't send that field", same as leaving it out
  // entirely used to mean before this was configurable.
  const itemFieldMapping = {
    ...DEFAULT_ITEM_FIELD_MAPPING,
    ...(formData?.qbIntegration?.itemFieldMapping || {}),
  };
  const setItemFieldMapping = (field, value) =>
    setFormData((prev) => ({
      ...prev,
      qbIntegration: {
        ...(prev?.qbIntegration || {}),
        itemFieldMapping: {
          ...DEFAULT_ITEM_FIELD_MAPPING,
          ...(prev?.qbIntegration?.itemFieldMapping || {}),
          [field]: value,
        },
      },
    }));
  // Item-create defaults: item_type + the QB accounts a new item is filed
  // under. Global, not per-sample — see qbItems.js's getItemDefaults(). Only
  // ever used on CREATE (QuickBooks' ItemUpdate has no item_type/account
  // fields, so these never apply to an item that already exists).
  const itemDefaults = {
    ...DEFAULT_ITEM_DEFAULTS,
    ...(formData?.qbIntegration?.itemDefaults || {}),
  };
  const setItemDefault = (field, value) =>
    setFormData((prev) => ({
      ...prev,
      qbIntegration: {
        ...(prev?.qbIntegration || {}),
        itemDefaults: {
          ...DEFAULT_ITEM_DEFAULTS,
          ...(prev?.qbIntegration?.itemDefaults || {}),
          [field]: value,
        },
      },
    }));
  // PO -> Sales Order Create mapping: a "QB Field,Source" text block edited
  // here and consumed by qbSalesOrders.js's createSalesOrdersForPos via
  // qbMapping.js's getSoCreateMappingText/buildSalesOrderCreatePayloadFromMapping.
  // Unset (never edited) falls back to the built-in default text.
  const soCreateMappingText =
    formData?.qbIntegration?.mappings?.salesOrderCreate ?? DEFAULT_SO_CREATE_MAPPING_TEXT;
  const setSoCreateMappingText = (value) =>
    setFormData((prev) => ({
      ...prev,
      qbIntegration: {
        ...(prev?.qbIntegration || {}),
        mappings: {
          ...(prev?.qbIntegration?.mappings || {}),
          salesOrderCreate: value,
        },
      },
    }));
  // Live check for a typo'd "QB Field" name (anything not in either field
  // vocabulary) so a bad line surfaces here instead of silently doing nothing
  // the next time a Sales Order gets created.
  const soCreateUnrecognizedFields = useMemo(() => {
    const bad = [];
    for (const { field } of parseMappingText(soCreateMappingText)) {
      const key = field.toLowerCase();
      if (
        !Object.prototype.hasOwnProperty.call(SO_CREATE_HEADER_FIELD_KEYS, key) &&
        !Object.prototype.hasOwnProperty.call(SO_CREATE_LINE_FIELD_KEYS, key)
      ) {
        bad.push(field);
      }
    }
    return bad;
  }, [soCreateMappingText]);
  // PO -> Sales Order Update mapping: same DSL/mechanism as Create, against
  // the Update field vocabulary (no Customer; adds "manually closed") — see
  // qbMapping.js's getSoUpdateMappingText/buildSalesOrderUpdatePayloadFromMapping
  // and qbSalesOrders.js's updateSalesOrdersForPos. The Price this resolves
  // to is only what's SENT when no fresher lock-date price is available for
  // that line — POLinesView's "Update in QB" button always overrides it with
  // the rebill calculator's price at the chosen lock date.
  const soUpdateMappingText =
    formData?.qbIntegration?.mappings?.salesOrderUpdate ?? DEFAULT_SO_UPDATE_MAPPING_TEXT;
  const setSoUpdateMappingText = (value) =>
    setFormData((prev) => ({
      ...prev,
      qbIntegration: {
        ...(prev?.qbIntegration || {}),
        mappings: {
          ...(prev?.qbIntegration?.mappings || {}),
          salesOrderUpdate: value,
        },
      },
    }));
  const soUpdateUnrecognizedFields = useMemo(() => {
    const bad = [];
    for (const { field } of parseMappingText(soUpdateMappingText)) {
      const key = field.toLowerCase();
      if (
        !Object.prototype.hasOwnProperty.call(SO_UPDATE_HEADER_FIELD_KEYS, key) &&
        !Object.prototype.hasOwnProperty.call(SO_UPDATE_LINE_FIELD_KEYS, key)
      ) {
        bad.push(field);
      }
    }
    return bad;
  }, [soUpdateMappingText]);
  const fmtDays = (d) =>
    d == null ? "no data" : d === 0 ? "today" : d === 1 ? "yesterday" : `${d} days ago`;

  return (
    <div className="p-6 max-w-3xl mx-auto pb-24">
      <h1 className="text-2xl font-semibold mb-6 flex items-center gap-2">
        <SettingsIcon className="w-6 h-6 text-[#C5A572]" /> Settings
      </h1>

      {/* system health */}
      <div className="mb-8">
        <h2 className="text-lg font-medium mb-2 flex items-center gap-2">
          <Activity className="w-5 h-5 text-[#C5A572]" /> System health
        </h2>
        <div className="flex gap-3 flex-wrap">
          <HealthBadge
            label="PO scrape (Tuesdays)"
            value={health ? fmtDays(health.scrapeDays) : "checking..."}
            ok={health ? (health.scrapeDays == null ? null : health.scrapeDays <= 8) : null}
            detail={
              health && health.scrapeDays > 8 ? "overdue — check the Tuesday task" : null
            }
          />
          <HealthBadge
            label="QB memo import (Mondays)"
            value={health ? fmtDays(health.memoDays) : "checking..."}
            ok={health ? (health.memoDays == null ? null : health.memoDays <= 8) : null}
            detail={health && health.memoDays > 8 ? "overdue — check the Monday import" : null}
          />
          <HealthBadge
            label="Metal lock sync (daily)"
            value={health ? fmtDays(health.lockDays) : "checking..."}
            ok={health ? (health.lockDays == null ? null : health.lockDays <= 3) : null}
            detail={health && health.lockDays > 3 ? "stale — pg_cron may be down" : null}
          />
          <HealthBadge
            label="Unmatched styles on open SOs"
            value={health ? (health.unmatched == null ? "no data" : String(health.unmatched)) : "checking..."}
            ok={health ? (health.unmatched == null ? null : health.unmatched === 0) : null}
            detail={
              health && health.unmatched > 0
                ? "styles with no sample or alias — Labels/Factory Costs will ask"
                : null
            }
          />
        </div>
      </div>

      {/* product options */}
      {formData &&
        Object.keys(formData).map((sectionKey) => {
          if (sectionKey === "qbIntegration") return null;
          const section = formData[sectionKey];
          if (!section || typeof section !== "object" || Array.isArray(section))
            return null;
          return (
            <div key={sectionKey} className="mb-8">
              <h2 className="text-lg font-medium mb-3">
                {SECTION_TITLES[sectionKey] || prettify(sectionKey)}
              </h2>
              <div className="bg-gray-50 border rounded-md p-4">
                {Object.keys(section).map((field) =>
                  Array.isArray(section[field]) ? (
                    <ChipField
                      key={field}
                      label={prettify(field)}
                      values={section[field]}
                      onChange={(vals) =>
                        setFormData((prev) => ({
                          ...prev,
                          [sectionKey]: { ...prev[sectionKey], [field]: vals },
                        }))
                      }
                    />
                  ) : null
                )}
              </div>
            </div>
          );
        })}

      {/* quickbooks integration */}
      <div className="mb-8">
        <h2 className="text-lg font-medium mb-2 flex items-center gap-2">
          <Landmark className="w-5 h-5 text-[#C5A572]" /> QuickBooks integration
        </h2>
        <div className="bg-gray-50 border rounded-md p-4">
          <div className="flex items-start justify-between gap-4">
            <p className="text-sm text-gray-600">
              When <strong>on</strong>, automated syncs may create records in
              QuickBooks that don't exist yet (via the QB connector). When{" "}
              <strong>off</strong>, the app never calls QuickBooks. Leave this
              off until the integration is approved to go live — nothing runs
              against QuickBooks while it's off.
            </p>
            <button
              type="button"
              role="switch"
              aria-checked={qbEnabled}
              onClick={toggleQb}
              title={qbEnabled ? "Turn QuickBooks integration off" : "Turn QuickBooks integration on"}
              className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors ${
                qbEnabled ? "bg-[#C5A572]" : "bg-gray-300"
              }`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
                  qbEnabled ? "translate-x-6" : "translate-x-1"
                }`}
              />
            </button>
          </div>
          <div className="mt-3">
            <span
              className={`inline-block px-2 py-0.5 rounded text-sm font-medium ${
                qbEnabled ? "bg-green-100 text-green-800" : "bg-gray-100 text-gray-500"
              }`}
            >
              {qbEnabled ? "On — live" : "Off — inactive"}
            </span>
          </div>

          {/* item field mapping */}
          <div className="mt-5 pt-4 border-t border-gray-200">
            <h3 className="text-sm font-semibold text-gray-800 mb-1">
              Item field mapping
            </h3>
            <p className="text-sm text-gray-600 mb-3">
              Which PLM data field feeds each QuickBooks Item field when a
              sample is created or updated in QuickBooks (Samples list, the
              sample's detail modal, and its card menu). The item's name in
              QuickBooks always stays the style number — not editable here,
              since that's the exact value used to find an existing item.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {Object.entries(QB_ITEM_FIELD_LABELS).map(([field, label]) => (
                <div key={field}>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    {label}
                  </label>
                  <select
                    value={itemFieldMapping[field] ?? ""}
                    onChange={(e) => setItemFieldMapping(field, e.target.value)}
                    className="block w-full border border-gray-300 rounded-md p-2 bg-white text-sm"
                  >
                    <option value="">— not mapped —</option>
                    {MAPPABLE_SAMPLE_FIELDS.map((f) => (
                      <option key={f.value} value={f.value}>
                        {f.label}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
          </div>

          {/* item create defaults: type + accounts */}
          <div className="mt-5 pt-4 border-t border-gray-200">
            <h3 className="text-sm font-semibold text-gray-800 mb-1">
              Item defaults (new items only)
            </h3>
            <p className="text-sm text-gray-600 mb-3">
              Applied only when a QuickBooks Item is first created — item type
              and its accounts can't be changed afterward through this
              connector (or QuickBooks itself, for most type changes), so
              these don't do anything for an item that already exists.
              Account names must match an existing account's exact name in
              your QuickBooks chart of accounts.
            </p>
            <div className="mb-3">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Item type
              </label>
              <select
                value={itemDefaults.item_type}
                onChange={(e) => setItemDefault("item_type", e.target.value)}
                className="block w-full sm:w-64 border border-gray-300 rounded-md p-2 bg-white text-sm"
              >
                {QB_ITEM_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {QB_ITEM_DEFAULT_FIELDS.map(({ key, label, placeholder }) => (
                <div key={key}>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    {label}
                  </label>
                  <input
                    type="text"
                    value={itemDefaults[key] ?? ""}
                    onChange={(e) => setItemDefault(key, e.target.value)}
                    placeholder={placeholder}
                    className="block w-full border border-gray-300 rounded-md p-2 bg-white text-sm"
                  />
                </div>
              ))}
            </div>
          </div>

          {/* PO -> Sales Order Create mapping */}
          <div className="mt-5 pt-4 border-t border-gray-200">
            <div className="flex items-center justify-between gap-4 mb-1">
              <h3 className="text-sm font-semibold text-gray-800">
                Purchase Order → Sales Order mapping (Create)
              </h3>
              <button
                type="button"
                onClick={() => setSoCreateMappingText(DEFAULT_SO_CREATE_MAPPING_TEXT)}
                className="text-xs text-gray-500 hover:text-gray-800 underline flex-shrink-0"
              >
                Reset to default
              </button>
            </div>
            <p className="text-sm text-gray-600 mb-3">
              One <code>QB Field,Source</code> pair per line, used when
              creating a QuickBooks Sales Order from a Signet PO (Purchase
              Orders page, "Create in QB"). <code>Static:value</code> sends a
              fixed value; anything else is looked up against the PO and its
              lines — curated names like <code>Order QTY</code> or{" "}
              <code>No Delivery Before</code>, plus every column from the
              original Signet PO export (e.g.{" "}
              <code>Manufacturer's Model #</code>, <code>SKU</code>,{" "}
              <code>Unit Cost($)</code>). Header fields (Customer, RefNumber,
              Class, Template Name, Ship Method, To Be Printed, Other, ...)
              apply once per PO; line fields (Item, Description, Quantity,
              Price, Other1, Other2) apply once per PO line.
            </p>
            <textarea
              value={soCreateMappingText}
              onChange={(e) => setSoCreateMappingText(e.target.value)}
              rows={14}
              spellCheck={false}
              className="block w-full border border-gray-300 rounded-md p-2 bg-white text-sm font-mono"
            />
            {soCreateUnrecognizedFields.length > 0 && (
              <p className="text-sm text-red-600 mt-2">
                Unrecognized QB field name(s) — these line(s) will be ignored
                when the Sales Order is built: {soCreateUnrecognizedFields.join(", ")}
              </p>
            )}
          </div>

          {/* PO -> Sales Order Update mapping */}
          <div className="mt-5 pt-4 border-t border-gray-200">
            <div className="flex items-center justify-between gap-4 mb-1">
              <h3 className="text-sm font-semibold text-gray-800">
                Purchase Order → Sales Order mapping (Update)
              </h3>
              <button
                type="button"
                onClick={() => setSoUpdateMappingText(DEFAULT_SO_UPDATE_MAPPING_TEXT)}
                className="text-xs text-gray-500 hover:text-gray-800 underline flex-shrink-0"
              >
                Reset to default
              </button>
            </div>
            <p className="text-sm text-gray-600 mb-3">
              Same <code>QB Field,Source</code> mapping as above, used instead
              when pushing changes onto a Sales Order QuickBooks already has
              (Purchase Orders page, "Update in QB"). There's no{" "}
              <code>Customer</code> field here — QuickBooks won't let this
              connector reassign an SO's customer after it's created — and{" "}
              <code>Manually Closed</code> (Static:Y / Static:N) is available
              here only. Whatever this mapping resolves for{" "}
              <code>Price</code> is sent as a fallback only: the "Update in
              QB" button on a PO's line-item view always sends that line's
              freshly recomputed price at the lock date you choose there
              instead, when one's available.
            </p>
            <textarea
              value={soUpdateMappingText}
              onChange={(e) => setSoUpdateMappingText(e.target.value)}
              rows={8}
              spellCheck={false}
              className="block w-full border border-gray-300 rounded-md p-2 bg-white text-sm font-mono"
            />
            {soUpdateUnrecognizedFields.length > 0 && (
              <p className="text-sm text-red-600 mt-2">
                Unrecognized QB field name(s) — these line(s) will be ignored
                when the Sales Order is updated: {soUpdateUnrecognizedFields.join(", ")}
              </p>
            )}
          </div>
        </div>
      </div>
      {/* equipment */}
      <div className="mb-8">
        <h2 className="text-lg font-medium mb-2 flex items-center gap-2">
          <Printer className="w-5 h-5 text-[#C5A572]" /> Equipment
        </h2>
        <div className="bg-gray-50 border rounded-md p-4">
          <p className="text-sm text-gray-600 mb-3">
            Re-calibrates the Zebra to the tag stock (it will feed a few blank
            tags), then saves the setup inside the printer so it re-syncs itself
            after every power-off, label change, or ribbon change. Run once after
            loading a new roll type, or if tags start printing shifted. Works
            only on the computer the printer is plugged into.
          </p>
          <button
            type="button"
            onClick={handleCalibrate}
            disabled={calibrating}
            className="px-5 py-2 bg-gray-800 text-white rounded-md hover:bg-gray-700 disabled:opacity-60"
          >
            {calibrating ? "Calibrating..." : "Calibrate tag printer"}
          </button>
        </div>
      </div>

      {/* manage */}
      <div className="mb-8">
        <h2 className="text-lg font-medium mb-2 flex items-center gap-2">
          <History className="w-5 h-5 text-[#C5A572]" /> Manage
        </h2>
        <div className="bg-gray-50 border rounded-md p-4 flex gap-3 flex-wrap">
          <Link
            to="/vendors"
            className="flex items-center gap-2 px-4 py-2 bg-white border rounded-md hover:bg-gray-100 text-gray-700 w-fit"
          >
            <Users className="w-4 h-4" />
            Vendors
          </Link>
          <Link
            to="/images"
            className="flex items-center gap-2 px-4 py-2 bg-white border rounded-md hover:bg-gray-100 text-gray-700 w-fit"
          >
            <Images className="w-4 h-4" />
            Images
          </Link>
          <Link
            to="/import-history"
            className="flex items-center gap-2 px-4 py-2 bg-white border rounded-md hover:bg-gray-100 text-gray-700 w-fit"
          >
            <History className="w-4 h-4" />
            Import History
          </Link>
        </div>
      </div>

      {/* unsaved-changes bar */}
      {dirty && (
        <div className="fixed bottom-0 left-64 right-0 max-md:left-14 bg-white border-t shadow-lg p-3 flex items-center justify-between z-40">
          <span className="text-sm text-gray-600 ml-4">Unsaved changes</span>
          <div className="flex gap-3 mr-4">
            <button
              onClick={() => setFormData(options)}
              className="px-4 py-2 rounded border text-sm"
            >
              Discard
            </button>
            <button
              onClick={saveFormData}
              disabled={saving}
              className="px-5 py-2 rounded bg-[#C5A572] text-white text-sm disabled:opacity-50"
            >
              {saving ? "Saving..." : "Save changes"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

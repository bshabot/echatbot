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
import SyncLogsCard from "../components/Settings/SyncLogsCard";
import { calibratePrinter } from "../utils/tags/browserPrint";
import { normalizeModel, stripModel } from "../utils/labelOrderUtils";
import { MAPPABLE_SAMPLE_FIELDS } from "../utils/qbItems";
import {
  checkQbApiUrl,
  configureQb,
  getQbApiUrlOverride,
  getQbConfig,
  qbHealth,
  setQbApiUrlOverride,
} from "../utils/qbClient";
import {
  DEFAULT_ITEM_CREATE_MAPPING_TEXT,
  DEFAULT_ITEM_UPDATE_MAPPING_TEXT,
  DEFAULT_SO_CREATE_MAPPING_TEXT,
  DEFAULT_SO_UPDATE_MAPPING_TEXT,
  ITEM_CREATE_FIELD_KEYS,
  ITEM_UPDATE_FIELD_KEYS,
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
  // Sample -> Item mappings: same "QB Field,Source" text blocks as the sales
  // order mappings, consumed by qbItems.js via qbMapping.js. Create and
  // update are separate because QuickBooks accepts different fields for each
  // (ItemUpdate has no item type and no accounts at all).
  const itemCreateMappingText =
    formData?.qbIntegration?.mappings?.itemCreate ?? DEFAULT_ITEM_CREATE_MAPPING_TEXT;
  const itemUpdateMappingText =
    formData?.qbIntegration?.mappings?.itemUpdate ?? DEFAULT_ITEM_UPDATE_MAPPING_TEXT;
  const setMappingText = (key, value) =>
    setFormData((prev) => ({
      ...prev,
      qbIntegration: {
        ...(prev?.qbIntegration || {}),
        mappings: { ...(prev?.qbIntegration?.mappings || {}), [key]: value },
      },
    }));
  // Where the QB connector lives. The URL is on the shared settings row so
  // every user hits the machine actually running QuickBooks, instead of their
  // own localhost. A per-machine override (localStorage) wins over it.
  const qbApiUrl = formData?.qbIntegration?.apiUrl ?? "";
  const setQbField = (key, value) =>
    setFormData((prev) => ({
      ...prev,
      qbIntegration: { ...(prev?.qbIntegration || {}), [key]: value },
    }));
  const qbUrlCheck = checkQbApiUrl(qbApiUrl);

  /**
   * B1 — test ONE specific address, in isolation.
   *
   * The old button called applyQbSettings({ options: { qbIntegration:
   * { apiUrl } } }) — which (a) still routed through the per-machine
   * localStorage override, so it tested that address instead of the one in
   * the box, and (b) passed an object with no apiKey, wiping the runtime API
   * key for the rest of the session (every later call 401'd until reload).
   * This points the client at exactly the given URL, keeps the configured
   * key, and restores the previous config either way.
   */
  async function testConnectorAt(url, what) {
    const prev = getQbConfig();
    const target =
      String(url || "").trim().replace(/\/+$/, "") || "http://localhost:8055";
    try {
      configureQb({ baseUrl: target });
      const h = await qbHealth();
      const bits = [`Connector reachable ✓ ${what}: ${target}`];
      if (h?.version) bits.push(`v${h.version}`);
      if (h && h.wc_alive === false) {
        bits.push("but the QuickBooks Web Connector isn't polling — open it on the QB machine");
      }
      showMessage(bits.join(" — "));
    } catch (e) {
      showMessage(`${what} ${target}: ${e?.message || e}`);
    } finally {
      configureQb(prev);
    }
  }

  const setItemCreateMappingText = (v) => setMappingText("itemCreate", v);
  const setItemUpdateMappingText = (v) => setMappingText("itemUpdate", v);
  const unrecognizedFor = (text, keys) =>
    parseMappingText(text)
      .map((r) => r.field)
      .filter(
        (f) =>
          f.toLowerCase() !== "name" &&
          !Object.prototype.hasOwnProperty.call(keys, f.toLowerCase())
      );
  const itemCreateUnrecognized = useMemo(
    () => unrecognizedFor(itemCreateMappingText, ITEM_CREATE_FIELD_KEYS),
    [itemCreateMappingText]
  );
  const itemUpdateUnrecognized = useMemo(
    () => unrecognizedFor(itemUpdateMappingText, ITEM_UPDATE_FIELD_KEYS),
    [itemUpdateMappingText]
  );
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

          {/* Connector address */}
          <div className="mt-5 pt-4 border-t border-gray-200">
            <h3 className="text-sm font-semibold text-gray-800 mb-1">
              Connector address
            </h3>
            <p className="text-xs text-gray-500 mb-2">
              The machine running QuickBooks and the QB connector. Everyone on
              the network points here. Leave blank for{" "}
              <code>http://localhost:8055</code> — which only works on that
              machine itself.
            </p>
            <div className="flex items-center gap-2 flex-wrap">
              <input
                type="text"
                value={qbApiUrl}
                onChange={(e) => setQbField("apiUrl", e.target.value)}
                placeholder="http://192.168.1.50:8055"
                spellCheck={false}
                className="border rounded px-2 py-1 text-sm font-mono w-72"
              />
              <button
                type="button"
                onClick={() => testConnectorAt(qbApiUrl, "shared address")}
                className="text-xs px-3 py-1.5 rounded border border-gray-300 text-gray-600 hover:bg-gray-50"
              >
                Test connection
              </button>
            </div>
            {qbUrlCheck.warning && (
              <p
                className={`text-xs mt-2 ${
                  qbUrlCheck.ok ? "text-amber-700" : "text-red-600"
                }`}
              >
                {qbUrlCheck.warning}
              </p>
            )}
            <div className="mt-3">
              <label className="text-xs text-gray-500 block mb-1">
                This machine only (overrides the address above, stays in this
                browser)
              </label>
              <div className="flex items-center gap-2 flex-wrap">
                <input
                  type="text"
                  defaultValue={getQbApiUrlOverride()}
                  onBlur={(e) => setQbApiUrlOverride(e.target.value)}
                  placeholder="e.g. http://localhost:8055 on the QuickBooks machine"
                  spellCheck={false}
                  className="border rounded px-2 py-1 text-sm font-mono w-72"
                />
                {/* B1 — the override is what this machine actually uses, so it
                    needs its own test. The button above tests the shared row. */}
                <button
                  type="button"
                  onClick={() =>
                    testConnectorAt(getQbApiUrlOverride() || qbApiUrl, "this machine")
                  }
                  className="text-xs px-3 py-1.5 rounded border border-gray-300 text-gray-600 hover:bg-gray-50"
                >
                  Test this machine
                </button>
              </div>
            </div>
          </div>

          {/* Item mappings */}
          <div className="mt-5 pt-4 border-t border-gray-200">
            <div className="flex items-center justify-between gap-4 mb-1">
              <h3 className="text-sm font-semibold text-gray-800">
                Sample → Item mapping (Create)
              </h3>
              <button
                type="button"
                onClick={() => setItemCreateMappingText(DEFAULT_ITEM_CREATE_MAPPING_TEXT)}
                className="text-xs text-gray-500 hover:text-gray-800 underline flex-shrink-0"
              >
                Reset to default
              </button>
            </div>
            <p className="text-sm text-gray-600 mb-3">
              Used when a sample is first created as a QuickBooks Item
              (Samples list, the sample's detail modal, its card menu, and
              Factory Costs). The item's <strong>name is always the style
              number</strong> and isn't mappable — that's the value used to
              find an existing item. Item type and the account fields are
              accepted here only: QuickBooks can't change an existing item's
              type or accounts, so they apply on create and never again.
              Account names must match your chart of accounts exactly.
            </p>
            <textarea
              value={itemCreateMappingText}
              onChange={(e) => setItemCreateMappingText(e.target.value)}
              rows={8}
              spellCheck={false}
              className="block w-full border border-gray-300 rounded-md p-2 bg-white text-sm font-mono"
            />
            {itemCreateUnrecognized.length > 0 && (
              <p className="text-sm text-red-600 mt-2">
                Unrecognized QB field name(s), these lines are ignored:{" "}
                {itemCreateUnrecognized.join(", ")}
              </p>
            )}
          </div>

          <div className="mt-5 pt-4 border-t border-gray-200">
            <div className="flex items-center justify-between gap-4 mb-1">
              <h3 className="text-sm font-semibold text-gray-800">
                Sample → Item mapping (Update)
              </h3>
              <button
                type="button"
                onClick={() => setItemUpdateMappingText(DEFAULT_ITEM_UPDATE_MAPPING_TEXT)}
                className="text-xs text-gray-500 hover:text-gray-800 underline flex-shrink-0"
              >
                Reset to default
              </button>
            </div>
            <p className="text-sm text-gray-600 mb-3">
              Used when a sample is pushed onto an Item that already exists.
              QuickBooks accepts far less here — only{" "}
              <code>Description</code>, <code>Price</code>, <code>Cost</code>,{" "}
              <code>Manufacturer Part Number</code> and <code>Active</code>.
              Anything left out keeps whatever is already in QuickBooks, so
              omit a field you maintain by hand there.
            </p>
            <textarea
              value={itemUpdateMappingText}
              onChange={(e) => setItemUpdateMappingText(e.target.value)}
              rows={6}
              spellCheck={false}
              className="block w-full border border-gray-300 rounded-md p-2 bg-white text-sm font-mono"
            />
            {itemUpdateUnrecognized.length > 0 && (
              <p className="text-sm text-red-600 mt-2">
                Unrecognized QB field name(s), these lines are ignored:{" "}
                {itemUpdateUnrecognized.join(", ")}
              </p>
            )}
            <p className="text-xs text-gray-500 mt-2">
              Sources available from a sample:{" "}
              {MAPPABLE_SAMPLE_FIELDS.map((f) => f.value).join(", ")} — or{" "}
              <code>Static:</code> for a fixed value.
            </p>
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
              instead, when one's available. The lock itself is available as{" "}
              <code>Lock Date</code>, <code>Silver Lock</code> ($/oz) and{" "}
              <code>Gold Lock</code>.
            </p>
            <p className="text-sm text-gray-600 mb-3">
              <strong>Careful with the "Other" fields</strong> — QuickBooks has
              several and they're not the same place.{" "}
              <code>Other</code> is the built-in header field.{" "}
              <code>Other1</code>/<code>Other2</code> are per-line fields.{" "}
              <code>Custom:Name</code> writes a header custom field (data
              extension) by its exact QuickBooks name, and{" "}
              <code>Silver Lock Date</code> is shorthand for the one the
              connector is configured to use. The silver lock date is a header
              custom field, so it belongs on one of those last two — writing
              it to plain <code>Other</code> puts it somewhere else entirely.
              If this company file's field is named "Other", use{" "}
              <code>Custom:Other,Lock Date</code>.
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

      <SyncLogsCard />

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

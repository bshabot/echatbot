import React, { useState, useEffect, useMemo } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Check,
  ChevronRight,
  History,
  Images,
  Landmark,
  Plus,
  Printer,
  ScrollText,
  Settings as SettingsIcon,
  SlidersHorizontal,
  UploadCloud,
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
  fetchQbTransport,
  getQbApiUrlOverride,
  getQbConfig,
  isQbApiUrlOverrideEnabled,
  qbHealth,
  releaseQbConnection,
  setQbApiUrlOverride,
  setQbApiUrlOverrideEnabled,
  setQbTransport,
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

const GOLD = "#C5A572";

/* ------------------------------------------------------------------ */
/* naming                                                              */
/* ------------------------------------------------------------------ */

// Friendly labels for known option fields; anything unknown gets auto-prettified.
const FRIENDLY_NAMES = {
  backType: "Back types",
  sellingType: "Selling types",
  color: "Stone colors",
  type: "Stone types",
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
  formFields: "Sample form",
  stonePropertiesForm: "Stones",
};

const SECTION_HINTS = {
  formFields: "Choices that appear in the dropdowns when adding a sample",
  stonePropertiesForm: "Stone type and color choices",
};

// Sections that own a tab of their own, so they must not fall through to the
// generic option-list renderer.
const INTEGRATION_SECTIONS = new Set(["qbIntegration", "sspIntegration"]);

// Kept in sync with the TABS ids further down — used to validate/read the
// ?tab= URL param so a refresh (or a shared link) lands back on the same
// tab instead of always resetting to Overview.
const SETTINGS_TAB_IDS = ["overview", "options", "quickbooks", "ssp", "logs", "printer"];

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

const daysAgo = (dateStr) => {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d)) return null;
  return Math.floor((Date.now() - d.getTime()) / 86400000);
};

const fmtDays = (d) =>
  d == null ? "No data" : d === 0 ? "Today" : d === 1 ? "Yesterday" : `${d} days ago`;

// Drops blank/whitespace-only entries that crept into the option lists — they
// used to render as unlabelled chips nobody could tell apart. Only touches
// arrays, so integration settings (booleans, URLs, mapping text) pass through
// untouched.
const cleanOptions = (raw) => {
  if (!raw || typeof raw !== "object") return raw;
  const out = {};
  for (const [sectionKey, section] of Object.entries(raw)) {
    if (!section || typeof section !== "object" || Array.isArray(section)) {
      out[sectionKey] = section;
      continue;
    }
    const cleaned = {};
    for (const [field, value] of Object.entries(section)) {
      cleaned[field] = Array.isArray(value)
        ? value.map((v) => (typeof v === "string" ? v.trim() : v)).filter(Boolean)
        : value;
    }
    out[sectionKey] = cleaned;
  }
  return out;
};

/* ------------------------------------------------------------------ */
/* small presentational pieces                                         */
/* ------------------------------------------------------------------ */

function Card({ title, hint, right, children, bodyClass = "p-4" }) {
  return (
    <div className="bg-white border border-gray-200 rounded-xl mb-4 overflow-hidden">
      {title && (
        <div className="px-4 py-3 border-b border-gray-200 flex items-start justify-between gap-4">
          <div>
            <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
            {hint && <p className="text-xs text-gray-500 mt-0.5">{hint}</p>}
          </div>
          {right}
        </div>
      )}
      <div className={bodyClass}>{children}</div>
    </div>
  );
}

// Collapsed by default. Holds the long "what can go in here" explanations so
// the mapping editors aren't buried under three paragraphs of prose.
function Disclosure({ label, children }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mb-3">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1 text-xs font-medium text-gray-500 hover:text-gray-800"
      >
        <ChevronRight
          className={`w-3.5 h-3.5 transition-transform ${open ? "rotate-90" : ""}`}
        />
        {label}
      </button>
      {open && (
        <div className="text-[13px] text-gray-600 mt-2 pl-[18px] space-y-2 max-w-[72ch]">
          {children}
        </div>
      )}
    </div>
  );
}

function Toggle({ checked, onChange, title }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      title={title}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors ${
        checked ? "bg-[#C5A572]" : "bg-gray-300"
      }`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
          checked ? "translate-x-6" : "translate-x-1"
        }`}
      />
    </button>
  );
}

function StatusPill({ ok, children }) {
  return (
    <span
      className={`inline-block px-2 py-0.5 rounded text-[12.5px] font-medium ${
        ok ? "bg-green-100 text-green-800" : "bg-gray-100 text-gray-500"
      }`}
    >
      {children}
    </span>
  );
}

function HealthTile({ label, days, threshold, cadence }) {
  const ok = days == null ? null : days <= threshold;
  const warn = ok === false;
  return (
    <div
      className={`rounded-xl border p-3.5 ${
        warn ? "border-red-200 bg-red-50" : "border-gray-200 bg-white"
      }`}
    >
      <div className="text-[11px] uppercase tracking-wide text-gray-500">{label}</div>
      <div className="mt-2 flex items-center gap-2 text-[15px] font-semibold text-gray-900">
        <span
          className={`w-2 h-2 rounded-full shrink-0 ${
            ok === null ? "bg-gray-300" : warn ? "bg-red-500" : "bg-green-500"
          }`}
        />
        {fmtDays(days)}
      </div>
      <div className={`text-[11px] mt-1.5 ${warn ? "text-red-700" : "text-gray-400"}`}>
        {ok === null
          ? "nothing recorded yet"
          : warn
            ? `overdue — runs ${cadence}`
            : `on schedule · ${cadence}`}
      </div>
    </div>
  );
}

function UnmatchedTile({ count }) {
  const warn = count != null && count > 0;
  return (
    <div
      className={`rounded-xl border p-3.5 ${
        warn ? "border-red-200 bg-red-50" : "border-gray-200 bg-white"
      }`}
    >
      <div className="text-[11px] uppercase tracking-wide text-gray-500">
        Unmatched styles
      </div>
      <div className="mt-2 flex items-center gap-2 text-[15px] font-semibold text-gray-900">
        <span
          className={`w-2 h-2 rounded-full shrink-0 ${
            count == null ? "bg-gray-300" : warn ? "bg-red-500" : "bg-green-500"
          }`}
        />
        {count == null ? "No data" : count === 0 ? "All matched" : `${count} styles`}
      </div>
      <div className={`text-[11px] mt-1.5 ${warn ? "text-red-700" : "text-gray-400"}`}>
        {count == null
          ? "nothing recorded yet"
          : warn
            ? "no sample or alias — Labels will ask"
            : "on open sales orders"}
      </div>
    </div>
  );
}

function ChipField({ label, values, onChange }) {
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);

  const add = () => {
    const v = draft.trim();
    if (!v) {
      setDraft("");
      setAdding(false);
      return;
    }
    if (!values.some((x) => String(x).toLowerCase() === v.toLowerCase())) {
      onChange([...values, v]);
    }
    setDraft("");
  };

  return (
    <div className="mb-5 last:mb-0">
      <div className="flex items-baseline gap-2 mb-2">
        <span className="text-[13px] font-semibold text-gray-900">{label}</span>
        <span className="text-[11px] text-gray-400">
          {values.length} {values.length === 1 ? "option" : "options"}
        </span>
      </div>
      <div className="flex flex-wrap gap-1.5 items-center">
        {values.map((v, i) => (
          <span
            key={`${v}-${i}`}
            className="inline-flex items-center gap-1.5 bg-gray-100 border border-gray-200 rounded-full pl-3 pr-2 py-1 text-[12.5px] text-gray-800"
          >
            {v}
            <button
              type="button"
              onClick={() => onChange(values.filter((_, j) => j !== i))}
              className="text-gray-400 hover:text-red-600"
              title={`Remove ${v}`}
              aria-label={`Remove ${v}`}
            >
              <X className="w-3 h-3" />
            </button>
          </span>
        ))}

        {adding ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => {
              add();
              setAdding(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              }
              if (e.key === "Escape") {
                setDraft("");
                setAdding(false);
              }
            }}
            placeholder="Type and press Enter"
            className="rounded-full border border-gray-300 px-3 py-1 text-[12.5px] outline-none focus:border-[#C5A572] min-w-[150px]"
          />
        ) : (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="inline-flex items-center gap-1 rounded-full border border-dashed border-gray-300 px-3 py-1 text-[12.5px] text-gray-500 hover:border-gray-400 hover:text-gray-700"
          >
            <Plus className="w-3 h-3" /> Add
          </button>
        )}
      </div>
    </div>
  );
}

// One QB "Field,Source" text block. Starts collapsed; a bad field name shows in
// the header so a problem can't hide behind a closed panel.
function MappingEditor({
  title,
  summary,
  value,
  onChange,
  onReset,
  rows,
  unrecognized,
  children,
}) {
  const [open, setOpen] = useState(false);
  const bad = unrecognized.length > 0;
  return (
    <div
      className={`border rounded-xl mb-3 overflow-hidden ${
        bad ? "border-red-200" : "border-gray-200"
      }`}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-gray-50"
      >
        <ChevronRight
          className={`w-4 h-4 text-gray-400 shrink-0 transition-transform ${
            open ? "rotate-90" : ""
          }`}
        />
        <span className="min-w-0 flex-1">
          <span className="block text-[13.5px] font-semibold text-gray-900">{title}</span>
          <span className="block text-xs text-gray-500 mt-0.5">{summary}</span>
        </span>
        {bad && (
          <span className="inline-flex items-center gap-1 text-[11px] font-medium text-red-700 bg-red-50 border border-red-200 rounded-full px-2 py-0.5 shrink-0">
            <AlertTriangle className="w-3 h-3" />
            {unrecognized.length} bad {unrecognized.length === 1 ? "field" : "fields"}
          </span>
        )}
      </button>

      {open && (
        <div className="px-4 pb-4 pt-1 border-t border-gray-100">
          {children}
          <div className="flex items-center justify-between gap-4 mb-1.5 mt-1">
            <span className="text-[11px] uppercase tracking-wide text-gray-400">
              QB Field, Source
            </span>
            <button
              type="button"
              onClick={onReset}
              className="text-xs text-gray-500 hover:text-gray-800 underline flex-shrink-0"
            >
              Reset to default
            </button>
          </div>
          <textarea
            value={value}
            onChange={(e) => onChange(e.target.value)}
            rows={rows}
            spellCheck={false}
            className="block w-full border border-gray-300 rounded-lg p-2.5 bg-white text-[12.5px] font-mono outline-none focus:border-[#C5A572]"
          />
          {bad && (
            <p className="text-[12.5px] text-red-600 mt-2">
              Unrecognized QB field name(s) — these lines are ignored:{" "}
              {unrecognized.join(", ")}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function Field({ label, hint, children, className = "" }) {
  return (
    <div className={className}>
      <label className="block text-[13px] font-semibold text-gray-800 mb-1">{label}</label>
      {children}
      {hint && <p className="text-xs text-gray-500 mt-1">{hint}</p>}
    </div>
  );
}

function JumpLink({ to, icon: Icon, title, hint }) {
  return (
    <Link
      to={to}
      className="flex items-start gap-3 bg-white border border-gray-200 rounded-xl p-3.5 hover:border-[#C5A572] hover:bg-[#fdfbf7] transition-colors"
    >
      <Icon className="w-4 h-4 mt-0.5 text-[#C5A572] shrink-0" />
      <div className="min-w-0">
        <div className="text-[13.5px] font-semibold text-gray-900 flex items-center gap-1">
          {title} <ArrowRight className="w-3 h-3 text-gray-300" />
        </div>
        <div className="text-xs text-gray-500 mt-0.5">{hint}</div>
      </div>
    </Link>
  );
}

/* ------------------------------------------------------------------ */
/* page                                                                */
/* ------------------------------------------------------------------ */

export default function Settings() {
  const settingsEntity = useGenericStore((state) => state.getEntity("settings"));
  const options = settingsEntity?.options || null; // null-safe: no white screen while loading
  const updateEntity = useGenericStore((state) => state.updateEntity);
  const isLoading = useGenericStore((state) => state.isLoading.settings);

  const { supabase } = useSupabase();
  const { showMessage } = useMessage();

  const [searchParams, setSearchParams] = useSearchParams();
  const tabFromUrl = searchParams.get("tab");
  const [tab, setTabState] = useState(
    SETTINGS_TAB_IDS.includes(tabFromUrl) ? tabFromUrl : "overview"
  );
  // Wraps setTabState so switching tabs also writes ?tab= to the URL —
  // that's what survives a page refresh (React state alone doesn't).
  const setTab = (id) => {
    setTabState(id);
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set("tab", id);
        return next;
      },
      { replace: true }
    );
  };
  const [formData, setFormData] = useState(null);
  const [calibrating, setCalibrating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [health, setHealth] = useState(null);

  // Baseline is the stored settings with blank option entries stripped, so a
  // legacy empty string doesn't make the page look dirty the moment it loads.
  const baseline = useMemo(() => cleanOptions(options), [options]);

  useEffect(() => {
    if (baseline && !formData) setFormData(baseline);
  }, [baseline, formData]);

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
    () => formData && baseline && JSON.stringify(formData) !== JSON.stringify(baseline),
    [formData, baseline]
  );

  const saveFormData = async () => {
    if (!formData) return;
    setSaving(true);
    const payload = cleanOptions(formData);
    const { error } = await supabase
      .from("settings")
      .update({ options: payload })
      .eq("id", 1);
    if (error) {
      showMessage("Save failed: " + error.message);
    } else {
      showMessage("Settings saved");
      await updateEntity("settings", { options: payload });
      setFormData(payload);
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
  // Signet SSP integration — same gate pattern as QuickBooks. The token is
  // the short-lived Entra bearer token (same one the ssp-scraper uses);
  // paste a fresh one right before creating items. Stored on the settings
  // row as options.sspIntegration.{enabled,token,userName,defaults}.
  const sspEnabled = Boolean(formData?.sspIntegration?.enabled);
  const setSspField = (key, value) =>
    setFormData((prev) => ({
      ...prev,
      sspIntegration: { ...(prev?.sspIntegration || {}), [key]: value },
    }));
  const setSspDefault = (key, value) =>
    setFormData((prev) => ({
      ...prev,
      sspIntegration: {
        ...(prev?.sspIntegration || {}),
        defaults: { ...(prev?.sspIntegration?.defaults || {}), [key]: value },
      },
    }));
  const sspToken = formData?.sspIntegration?.token ?? "";
  const sspRefreshToken = formData?.sspIntegration?.refreshToken ?? "";
  const sspTokenExpiresAt = Number(formData?.sspIntegration?.tokenExpiresAt) || 0;
  const sspUserName = formData?.sspIntegration?.userName ?? "Brian@echabot.com";
  const sspBuyer = formData?.sspIntegration?.defaults?.buyer ?? "";
  const sspCountry = formData?.sspIntegration?.defaults?.countryOfOrigin ?? "VIETNAM";
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
  // own localhost. A per-machine override (localStorage) can win over it,
  // but only when explicitly enabled on that browser (see the checkbox
  // below) — otherwise this shared address is what everyone gets, so
  // changing it here is an actual global switch.
  const qbApiUrl = formData?.qbIntegration?.apiUrl ?? "";
  const [qbOverrideEnabled, setQbOverrideEnabledState] = useState(isQbApiUrlOverrideEnabled());
  const toggleQbOverrideEnabled = (checked) => {
    setQbApiUrlOverrideEnabled(checked);
    setQbOverrideEnabledState(checked);
  };
  const setQbField = (key, value) =>
    setFormData((prev) => ({
      ...prev,
      qbIntegration: { ...(prev?.qbIntegration || {}), [key]: value },
    }));
  const qbUrlCheck = checkQbApiUrl(qbApiUrl);

  // The connector's shared API key. Must match QB_API_KEY in the connector's
  // .env on the QuickBooks machine — qbClient's fetch layer sends it as the
  // X-API-Key header on every request. Sits on the shared row for the same
  // reason apiUrl does: one place, everyone gets it. Not a secret from PLM
  // users (a browser app ships it to the client) — what it buys is stopping
  // any other machine on the LAN from writing to the company file.
  const qbApiKey = formData?.qbIntegration?.apiKey ?? "";
  // Reveal toggle for the API key field — masked by default so it isn't read
  // over someone's shoulder on a shared screen.
  const [showQbKey, setShowQbKey] = useState(false);

  // Connection mode (COM vs Web Connector) lives on the connector machine,
  // not in this settings row — it describes how THAT box reaches QuickBooks.
  // Read on demand so opening Settings never pokes QuickBooks.
  const [transportInfo, setTransportInfo] = useState(null);
  const [transportBusy, setTransportBusy] = useState(false);

  // Run one call against whichever connector address THIS machine uses,
  // restoring the client config afterwards so Settings never leaves the
  // shared runtime config pointed somewhere the rest of the app didn't ask for.
  async function withConnector(fn) {
    const prev = getQbConfig();
    const target =
      String((qbOverrideEnabled && getQbApiUrlOverride()) || qbApiUrl || "")
        .trim()
        .replace(/\/+$/, "") || "http://localhost:8055";
    try {
      // Use the key currently in the box, not the last-saved one, so these
      // buttons test what you're about to save rather than what's on the row.
      configureQb({ baseUrl: target, apiKey: qbApiKey });
      return await fn();
    } finally {
      configureQb(prev);
    }
  }

  async function loadTransport() {
    setTransportBusy(true);
    try {
      setTransportInfo(await withConnector(() => fetchQbTransport()));
    } catch (e) {
      setTransportInfo(null);
      showMessage(`Could not read the connector's mode: ${e?.message || e}`);
    } finally {
      setTransportBusy(false);
    }
  }

  async function switchTransport(mode) {
    setTransportBusy(true);
    try {
      const res = await withConnector(() => setQbTransport(mode));
      setTransportInfo(await withConnector(() => fetchQbTransport()));
      showMessage(
        res.changed
          ? `Connector switched to ${mode === "com" ? "Direct (COM)" : "Web Connector"}.`
          : `Already using ${mode === "com" ? "Direct (COM)" : "Web Connector"}.`
      );
    } catch (e) {
      showMessage(`Could not switch: ${e?.message || e}`);
    } finally {
      setTransportBusy(false);
    }
  }

  async function releaseQb() {
    setTransportBusy(true);
    try {
      const res = await withConnector(() => releaseQbConnection());
      setTransportInfo(await withConnector(() => fetchQbTransport()));
      showMessage(res.detail || "Released.");
    } catch (e) {
      showMessage(`Could not release: ${e?.message || e}`);
    } finally {
      setTransportBusy(false);
    }
  }

  // Test ONE specific address, in isolation — points the client at exactly
  // the given URL with the key currently in the box, then restores whatever
  // was configured before, either way.
  async function testConnectorAt(url, what) {
    const prev = getQbConfig();
    const target = String(url || "").trim().replace(/\/+$/, "") || "http://localhost:8055";
    try {
      configureQb({ baseUrl: target, apiKey: qbApiKey });
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

  const qbProblemCount =
    itemCreateUnrecognized.length +
    itemUpdateUnrecognized.length +
    soCreateUnrecognizedFields.length +
    soUpdateUnrecognizedFields.length;

  // Only sections that actually hold option lists get a card. A section with
  // no arrays (an integration block, say) renders nothing rather than an empty
  // grey box.
  const optionSections = useMemo(() => {
    if (!formData) return [];
    return Object.keys(formData)
      .filter((k) => !INTEGRATION_SECTIONS.has(k))
      .map((sectionKey) => {
        const section = formData[sectionKey];
        if (!section || typeof section !== "object" || Array.isArray(section)) return null;
        const fields = Object.keys(section).filter((f) => Array.isArray(section[f]));
        return fields.length ? { sectionKey, fields } : null;
      })
      .filter(Boolean);
  }, [formData]);

  const optionCount = optionSections.reduce((n, s) => n + s.fields.length, 0);

  // Every hook is above this line — the loading bail-out has to come after them
  // so the hook order stays stable between renders.
  if (isLoading || (!options && !formData)) return <Loading />;

  const problems = health
    ? [
        health.scrapeDays != null && health.scrapeDays > 8 && "the PO scrape is overdue",
        health.memoDays != null &&
          health.memoDays > 8 &&
          "the QuickBooks memo import is overdue",
        health.lockDays != null && health.lockDays > 3 && "metal locks are stale",
        health.unmatched > 0 &&
          `${health.unmatched} ${
            health.unmatched === 1 ? "style has" : "styles have"
          } no sample or alias`,
      ].filter(Boolean)
    : [];

  const TABS = [
    { id: "overview", label: "Overview", short: "Overview", icon: Activity },
    {
      id: "options",
      label: "Product options",
      short: "Options",
      icon: SlidersHorizontal,
      count: optionCount,
    },
    {
      id: "quickbooks",
      label: "QuickBooks",
      short: "QB",
      icon: Landmark,
      alert: qbProblemCount > 0,
    },
    { id: "ssp", label: "Signet SSP", short: "SSP", icon: UploadCloud },
    { id: "logs", label: "Sync logs", short: "Logs", icon: ScrollText },
    { id: "printer", label: "Printer", short: "Printer", icon: Printer },
  ];

  return (
    <div className="p-6 max-md:p-3 max-w-4xl mx-auto pb-28">
      <div className="flex items-center gap-2">
        <SettingsIcon className="w-5 h-5 text-[#C5A572]" />
        <h1 className="text-xl font-semibold text-gray-900">Settings</h1>
      </div>
      <p className="text-[12.5px] text-gray-500 mt-1 mb-5">
        Dropdown options, the QuickBooks connection, printer setup, and how the scheduled
        jobs are doing.
      </p>

      {/* tabs */}
      <div className="flex gap-1 border-b border-gray-200 mb-5 overflow-x-auto">
        {TABS.map((t) => {
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`flex items-center gap-2 px-4 max-md:px-2.5 py-2.5 text-[13.5px] font-medium whitespace-nowrap border-b-2 -mb-px transition-colors ${
                active
                  ? "text-gray-900 border-[#C5A572]"
                  : "text-gray-500 border-transparent hover:text-gray-800"
              }`}
            >
              <t.icon className="w-4 h-4 max-md:hidden" />
              <span className="max-md:hidden">{t.label}</span>
              <span className="hidden max-md:inline">{t.short}</span>
              {t.count > 0 && (
                <span className="bg-gray-100 text-gray-600 rounded-full text-[10.5px] px-1.5 py-px">
                  {t.count}
                </span>
              )}
              {t.alert && <span className="w-1.5 h-1.5 rounded-full bg-red-500" />}
            </button>
          );
        })}
      </div>

      {/* ---------------- overview ---------------- */}
      {tab === "overview" && (
        <div>
          <div
            className={`flex items-center gap-2.5 rounded-xl border px-4 py-3 text-[13.5px] font-medium mb-4 ${
              !health
                ? "bg-gray-50 border-gray-200 text-gray-500"
                : problems.length
                  ? "bg-red-50 border-red-200 text-red-800"
                  : "bg-green-50 border-green-200 text-green-800"
            }`}
          >
            {!health ? (
              "Checking the scheduled jobs..."
            ) : problems.length ? (
              <>
                <span className="w-2 h-2 rounded-full bg-red-500 shrink-0" />
                {problems.length === 1
                  ? `Needs a look — ${problems[0]}.`
                  : `${problems.length} things need a look — ${problems.join(", ")}.`}
              </>
            ) : (
              <>
                <Check className="w-4 h-4 shrink-0" />
                Everything is running on schedule.
              </>
            )}
          </div>

          <div className="grid grid-cols-4 max-lg:grid-cols-2 gap-2.5 mb-6">
            <HealthTile
              label="PO scrape"
              days={health?.scrapeDays}
              threshold={8}
              cadence="Tuesdays"
            />
            <HealthTile
              label="QB memo import"
              days={health?.memoDays}
              threshold={8}
              cadence="Mondays"
            />
            <HealthTile
              label="Metal lock sync"
              days={health?.lockDays}
              threshold={3}
              cadence="daily"
            />
            <UnmatchedTile count={health?.unmatched} />
          </div>

          <h2 className="text-[13px] font-semibold text-gray-900 mb-2.5">Jump to</h2>
          <div className="grid grid-cols-3 max-md:grid-cols-1 gap-2.5">
            <JumpLink
              to="/vendors"
              icon={Users}
              title="Vendors"
              hint="Factories and contacts"
            />
            <JumpLink
              to="/images"
              icon={Images}
              title="Images"
              hint="Product photo library"
            />
            <JumpLink
              to="/import-history"
              icon={History}
              title="Import history"
              hint="Every upload, with results"
            />
          </div>
        </div>
      )}

      {/* ---------------- product options ---------------- */}
      {tab === "options" && (
        <div>
          {optionSections.length === 0 && (
            <p className="text-sm text-gray-500">No option lists are configured yet.</p>
          )}
          {optionSections.map(({ sectionKey, fields }) => (
            <Card
              key={sectionKey}
              title={SECTION_TITLES[sectionKey] || prettify(sectionKey)}
              hint={SECTION_HINTS[sectionKey]}
            >
              {fields.map((field) => (
                <ChipField
                  key={field}
                  label={prettify(field)}
                  values={formData[sectionKey][field]}
                  onChange={(vals) =>
                    setFormData((prev) => ({
                      ...prev,
                      [sectionKey]: { ...prev[sectionKey], [field]: vals },
                    }))
                  }
                />
              ))}
            </Card>
          ))}
        </div>
      )}

      {/* ---------------- quickbooks ---------------- */}
      {tab === "quickbooks" && (
        <div>
          <Card
            title="QuickBooks integration"
            hint="Master switch for every call the app makes to QuickBooks"
            right={
              <Toggle
                checked={qbEnabled}
                onChange={toggleQb}
                title={
                  qbEnabled
                    ? "Turn QuickBooks integration off"
                    : "Turn QuickBooks integration on"
                }
              />
            }
          >
            <StatusPill ok={qbEnabled}>
              {qbEnabled ? "On — live" : "Off — inactive"}
            </StatusPill>
            <p className="text-[13px] text-gray-600 mt-3 max-w-[72ch]">
              When <strong>on</strong>, automated syncs may create records in QuickBooks
              that don&apos;t exist yet (via the QB connector). When <strong>off</strong>,
              the app never calls QuickBooks. Leave this off until the integration is
              approved to go live — nothing runs against QuickBooks while it&apos;s off.
            </p>
          </Card>

          <Card
            title="Connector address"
            hint="The machine running QuickBooks and the QB connector"
          >
            <p className="text-[13px] text-gray-600 mb-3 max-w-[72ch]">
              Everyone on the network points here. Leave blank for{" "}
              <code>http://localhost:8055</code> — which only works on that machine
              itself.
            </p>
            <div className="flex items-center gap-2 flex-wrap">
              <input
                type="text"
                value={qbApiUrl}
                onChange={(e) => setQbField("apiUrl", e.target.value)}
                placeholder="http://192.168.1.50:8055"
                spellCheck={false}
                className="border border-gray-300 rounded-lg px-3 py-2 text-[13px] font-mono w-80 max-md:w-full outline-none focus:border-[#C5A572]"
              />
              <button
                type="button"
                onClick={() => testConnectorAt(qbApiUrl, "shared address")}
                className="px-4 py-2 rounded-lg border border-gray-300 text-[13px] text-gray-700 hover:bg-gray-50 disabled:opacity-60"
              >
                Test connection
              </button>
            </div>
            {qbUrlCheck.warning && (
              <p
                className={`text-[12.5px] mt-2 ${
                  qbUrlCheck.ok ? "text-amber-700" : "text-red-600"
                }`}
              >
                {qbUrlCheck.warning}
              </p>
            )}

            <div className="mt-4 pt-4 border-t border-gray-100">
              <label className="block text-[13px] font-semibold text-gray-800 mb-1">
                This machine only
              </label>
              <p className="text-xs text-gray-500 mb-2">
                Stays in this browser and is <strong>off by default</strong> — leave
                it off and this machine follows the shared address above like
                everyone else. Turn it on only on the actual QuickBooks machine, if
                it needs to reach the connector at <code>localhost</code> instead of
                its own LAN address.
              </p>
              <label className="flex items-center gap-2 text-[13px] text-gray-700 mb-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={qbOverrideEnabled}
                  onChange={(e) => toggleQbOverrideEnabled(e.target.checked)}
                  className="accent-[#C5A572]"
                />
                Use the override below on this machine
              </label>
              <div className="flex items-center gap-2 flex-wrap">
                <input
                  type="text"
                  defaultValue={getQbApiUrlOverride()}
                  onBlur={(e) => setQbApiUrlOverride(e.target.value)}
                  placeholder="e.g. http://localhost:8055"
                  spellCheck={false}
                  disabled={!qbOverrideEnabled}
                  className="border border-gray-300 rounded-lg px-3 py-2 text-[13px] font-mono w-80 max-md:w-full outline-none focus:border-[#C5A572] disabled:bg-gray-50 disabled:text-gray-400"
                />
                {/* The override is what this machine actually uses (when the
                    checkbox above is on), so it gets its own test — the button
                    above tests the shared row. */}
                <button
                  type="button"
                  onClick={() =>
                    testConnectorAt(
                      (qbOverrideEnabled && getQbApiUrlOverride()) || qbApiUrl,
                      "this machine"
                    )
                  }
                  className="px-4 py-2 rounded-lg border border-gray-300 text-[13px] text-gray-700 hover:bg-gray-50"
                >
                  Test this machine
                </button>
              </div>
            </div>
          </Card>

          <Card
            title="API key"
            hint="Matches QB_API_KEY on the connector machine"
          >
            <p className="text-[13px] text-gray-600 mb-3 max-w-[72ch]">
              Sent as the <code>X-API-Key</code> header on every request. Leave blank only
              if the connector runs without a key set — with the connector listening on{" "}
              <code>0.0.0.0</code>, no key means anything on the network can write to the
              company file.
            </p>
            <div className="flex items-center gap-2 flex-wrap">
              <input
                type={showQbKey ? "text" : "password"}
                value={qbApiKey}
                onChange={(e) => setQbField("apiKey", e.target.value.trim())}
                placeholder="paste the value of QB_API_KEY"
                spellCheck={false}
                autoComplete="off"
                className="border border-gray-300 rounded-lg px-3 py-2 text-[13px] font-mono w-80 max-md:w-full outline-none focus:border-[#C5A572]"
              />
              <button
                type="button"
                onClick={() => setShowQbKey((v) => !v)}
                className="px-4 py-2 rounded-lg border border-gray-300 text-[13px] text-gray-700 hover:bg-gray-50"
              >
                {showQbKey ? "Hide" : "Show"}
              </button>
            </div>
            <p className="text-xs text-gray-500 mt-2">
              {qbApiKey
                ? `Set — ${qbApiKey.length} characters. Sent on every connector request.`
                : "Not set — requests go out with no X-API-Key header."}{" "}
              The Test buttons above use whatever is in this box, so you can check a key
              before saving — a 401 or 403 means it doesn&apos;t match the connector&apos;s.
            </p>
          </Card>

          <Card
            title="Connection mode"
            hint="How the connector machine talks to QuickBooks"
            right={
              <button
                type="button"
                onClick={loadTransport}
                disabled={transportBusy}
                className="text-[12.5px] px-3 py-1.5 rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50 disabled:opacity-50"
              >
                {transportBusy ? "Checking…" : transportInfo ? "Refresh" : "Check"}
              </button>
            }
          >
            <p className="text-[13px] text-gray-600 mb-3 max-w-[72ch]">
              A setting on the connector machine itself, not this row — everyone sees the
              same value.
            </p>
            {!transportInfo ? (
              <p className="text-[13px] text-gray-400">
                Press Check to read the current mode from the connector.
              </p>
            ) : (
              <>
                <div className="flex gap-2 flex-wrap">
                  {[
                    {
                      id: "com",
                      title: "Direct (COM)",
                      blurb: "Sub-second. Needs QuickBooks OPEN on the connector machine.",
                    },
                    {
                      id: "qbwc",
                      title: "Web Connector",
                      blurb: "1–3s. Works with QuickBooks closed — work queues until it runs.",
                    },
                  ].map((m) => {
                    const active = transportInfo.transport === m.id;
                    return (
                      <button
                        key={m.id}
                        type="button"
                        disabled={transportBusy || active}
                        onClick={() => switchTransport(m.id)}
                        className={`text-left px-3 py-2 rounded-lg border w-64 transition-colors ${
                          active
                            ? "border-[#C5A572] bg-[#C5A572]/10"
                            : "border-gray-300 hover:bg-gray-50"
                        } disabled:cursor-default`}
                      >
                        <div className="text-[13px] font-medium text-gray-800">
                          {m.title}
                          {active && (
                            <span className="ml-2 text-[11px] font-semibold text-[#8a6d3b]">
                              ACTIVE
                            </span>
                          )}
                        </div>
                        <div className="text-[11px] text-gray-500 mt-0.5">{m.blurb}</div>
                      </button>
                    );
                  })}
                </div>

                <div className="mt-3 flex items-center gap-2 flex-wrap text-[12.5px]">
                  {transportInfo.transport === "com" ? (
                    <>
                      <span
                        className={`px-2 py-0.5 rounded font-medium ${
                          transportInfo.com_connected
                            ? "bg-green-100 text-green-800"
                            : "bg-gray-100 text-gray-600"
                        }`}
                      >
                        {transportInfo.com_connected ? "Holding a QuickBooks session" : "No session held"}
                      </span>
                      {/* An open COM session is what stops QuickBooks from closing —
                          this hands it back without a restart. */}
                      <button
                        type="button"
                        onClick={releaseQb}
                        disabled={transportBusy || !transportInfo.com_connected}
                        className="px-3 py-1.5 rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50 disabled:opacity-50"
                      >
                        Let go of QuickBooks
                      </button>
                      <span className="text-gray-400">
                        Auto-releases after{" "}
                        {transportInfo.com_idle_release_seconds
                          ? `${transportInfo.com_idle_release_seconds}s idle`
                          : "never (idle release off)"}
                      </span>
                    </>
                  ) : (
                    <>
                      <span
                        className={`px-2 py-0.5 rounded font-medium ${
                          transportInfo.wc_alive ? "bg-green-100 text-green-800" : "bg-amber-100 text-amber-800"
                        }`}
                      >
                        {transportInfo.wc_alive
                          ? "Web Connector polling"
                          : "Web Connector not polling — open it on the QB machine"}
                      </span>
                      {transportInfo.pending_jobs > 0 && (
                        <span className="text-gray-500">{transportInfo.pending_jobs} request(s) queued</span>
                      )}
                    </>
                  )}
                </div>

                <p className="text-[11px] text-gray-400 mt-2">
                  Switching takes effect immediately and is remembered across restarts.
                  Leaving Direct mode releases the QuickBooks session first, so the company
                  file isn&apos;t left held open.
                </p>
              </>
            )}
          </Card>

          <h2 className="text-[13px] font-semibold text-gray-900 mb-2.5 mt-6">
            Field mappings
            {qbProblemCount > 0 && (
              <span className="ml-2 text-[12px] font-medium text-red-700">
                {qbProblemCount} unrecognized field
                {qbProblemCount === 1 ? "" : "s"} — those lines are ignored
              </span>
            )}
          </h2>

          <MappingEditor
            title="Sample → Item (Create)"
            summary="Used the first time a sample becomes a QuickBooks item"
            value={itemCreateMappingText}
            onChange={setItemCreateMappingText}
            onReset={() => setItemCreateMappingText(DEFAULT_ITEM_CREATE_MAPPING_TEXT)}
            rows={8}
            unrecognized={itemCreateUnrecognized}
          >
            <Disclosure label="What goes in here">
              <p>
                Used when a sample is first created as a QuickBooks Item (Samples list,
                the sample&apos;s detail modal, its card menu, and Factory Costs). The
                item&apos;s <strong>name is always the style number</strong> and
                isn&apos;t mappable — that&apos;s the value used to find an existing
                item.
              </p>
              <p>
                Item type and the account fields are accepted here only: QuickBooks
                can&apos;t change an existing item&apos;s type or accounts, so they apply
                on create and never again. Account names must match your chart of
                accounts exactly.
              </p>
            </Disclosure>
          </MappingEditor>

          <MappingEditor
            title="Sample → Item (Update)"
            summary="Used when pushing onto an item QuickBooks already has"
            value={itemUpdateMappingText}
            onChange={setItemUpdateMappingText}
            onReset={() => setItemUpdateMappingText(DEFAULT_ITEM_UPDATE_MAPPING_TEXT)}
            rows={6}
            unrecognized={itemUpdateUnrecognized}
          >
            <Disclosure label="What goes in here">
              <p>
                QuickBooks accepts far less on update — only <code>Description</code>,{" "}
                <code>Price</code>, <code>Cost</code>,{" "}
                <code>Manufacturer Part Number</code> and <code>Active</code>. Anything
                left out keeps whatever is already in QuickBooks, so omit a field you
                maintain by hand there.
              </p>
              <p>
                Sources available from a sample:{" "}
                {MAPPABLE_SAMPLE_FIELDS.map((f) => f.value).join(", ")} — or{" "}
                <code>Static:</code> for a fixed value.
              </p>
            </Disclosure>
          </MappingEditor>

          <MappingEditor
            title="Purchase Order → Sales Order (Create)"
            summary={'Used by "Create in QB" on the Purchase Orders page'}
            value={soCreateMappingText}
            onChange={setSoCreateMappingText}
            onReset={() => setSoCreateMappingText(DEFAULT_SO_CREATE_MAPPING_TEXT)}
            rows={14}
            unrecognized={soCreateUnrecognizedFields}
          >
            <Disclosure label="What goes in here">
              <p>
                One <code>QB Field,Source</code> pair per line, used when creating a
                QuickBooks Sales Order from a Signet PO. <code>Static:value</code> sends a
                fixed value; anything else is looked up against the PO and its lines —
                curated names like <code>Order QTY</code> or <code>No Delivery Before</code>
                , plus every column from the original Signet PO export (e.g.{" "}
                <code>Manufacturer&apos;s Model #</code>, <code>SKU</code>,{" "}
                <code>Unit Cost($)</code>).
              </p>
              <p>
                Header fields (Customer, RefNumber, Class, Template Name, Ship Method, To
                Be Printed, Other, ...) apply once per PO; line fields (Item, Description,
                Quantity, Price, Other1, Other2) apply once per PO line.
              </p>
            </Disclosure>
          </MappingEditor>

          <MappingEditor
            title="Purchase Order → Sales Order (Update)"
            summary={'Used by "Update in QB" — no Customer field, adds Manually Closed'}
            value={soUpdateMappingText}
            onChange={setSoUpdateMappingText}
            onReset={() => setSoUpdateMappingText(DEFAULT_SO_UPDATE_MAPPING_TEXT)}
            rows={8}
            unrecognized={soUpdateUnrecognizedFields}
          >
            <Disclosure label="What goes in here">
              <p>
                Same <code>QB Field,Source</code> mapping as Create, used instead when
                pushing changes onto a Sales Order QuickBooks already has. There&apos;s no{" "}
                <code>Customer</code> field here — QuickBooks won&apos;t let this
                connector reassign an SO&apos;s customer after it&apos;s created — and{" "}
                <code>Manually Closed</code> (Static:Y / Static:N) is available here only.
              </p>
              <p>
                Whatever this mapping resolves for <code>Price</code> is sent as a
                fallback only: the &quot;Update in QB&quot; button on a PO&apos;s
                line-item view always sends that line&apos;s freshly recomputed price at
                the lock date you choose there instead, when one&apos;s available. The
                lock itself is available as <code>Lock Date</code>,{" "}
                <code>Silver Lock</code> ($/oz) and <code>Gold Lock</code>.
              </p>
              <p>
                <strong>Careful with the &quot;Other&quot; fields</strong> — QuickBooks
                has several and they&apos;re not the same place. <code>Other</code> is the
                built-in header field. <code>Other1</code>/<code>Other2</code> are
                per-line fields. <code>Custom:Name</code> writes a header custom field
                (data extension) by its exact QuickBooks name, and{" "}
                <code>Silver Lock Date</code> is shorthand for the one the connector is
                configured to use. The silver lock date is a header custom field, so it
                belongs on one of those last two — writing it to plain <code>Other</code>{" "}
                puts it somewhere else entirely. If this company file&apos;s field is
                named &quot;Other&quot;, use <code>Custom:Other,Lock Date</code>.
              </p>
            </Disclosure>
          </MappingEditor>
        </div>
      )}

      {/* ---------------- signet ssp ---------------- */}
      {tab === "ssp" && (
        <div>
          <Card
            title="Signet SSP integration"
            hint="Powers Create in SSP on the Samples page"
            right={
              <Toggle
                checked={sspEnabled}
                onChange={(v) => setSspField("enabled", v)}
                title={sspEnabled ? "Turn SSP integration off" : "Turn SSP integration on"}
              />
            }
          >
            <StatusPill ok={sspEnabled && Boolean(String(sspToken).trim())}>
              {sspEnabled
                ? String(sspToken).trim()
                  ? String(sspRefreshToken).trim()
                    ? "On — live, auto-renews itself"
                    : "On — live, but no refresh token so this will need re-pasting hourly"
                  : "On — but no token pasted, so still inactive"
                : "Off — inactive"}
            </StatusPill>
            {sspEnabled && sspTokenExpiresAt ? (
              <p className="text-[12px] text-gray-500 mt-1.5">
                Current token expires {new Date(sspTokenExpiresAt).toLocaleString()}
                {String(sspRefreshToken).trim() ? " — will refresh itself before then." : "."}
              </p>
            ) : null}
            <p className="text-[13px] text-gray-600 mt-3 max-w-[72ch]">
              Creates the sample as a new item in SKU Manager&apos;s hold queue, filling
              the header, item, material, and (when the sample has them) stones and
              photos; findings and labor are finished in SKU Manager. When{" "}
              <strong>off</strong>, or when no token is pasted, the app never calls SSP.
              Every create mints a <strong>new</strong> SSP number — there is no
              overwrite.
            </p>
          </Card>

          <Card title="Credentials and defaults">
            <Field
              label="SSP bearer token"
              hint={
                String(sspRefreshToken).trim()
                  ? "Expires after about an hour, but with a refresh token saved below the app renews it automatically — this box is just a starting point."
                  : "Expires after about an hour — paste a fresh one right before creating items, then Save. Add a refresh token below to stop doing this by hand."
              }
              className="mb-4"
            >
              <textarea
                value={sspToken}
                onChange={(e) => setSspField("token", e.target.value.trim())}
                rows={3}
                spellCheck={false}
                placeholder="eyJ0eXAiOiJKV1QiLCJhbGciOi…"
                className="block w-full border border-gray-300 rounded-lg p-2.5 bg-white text-[12px] font-mono outline-none focus:border-[#C5A572]"
              />
            </Field>

            <Field
              label="SSP refresh token"
              hint="Optional, but recommended: paste this once (from the same sign-in response as the bearer token above) and the app will use it to silently mint a new bearer token whenever the old one is about to expire — no more re-pasting hourly."
              className="mb-4"
            >
              <textarea
                value={sspRefreshToken}
                onChange={(e) => setSspField("refreshToken", e.target.value.trim())}
                rows={3}
                spellCheck={false}
                placeholder="1.AUUAf_-jOkMuvU60hELoCy78q…"
                className="block w-full border border-gray-300 rounded-lg p-2.5 bg-white text-[12px] font-mono outline-none focus:border-[#C5A572]"
              />
            </Field>

            <div className="grid grid-cols-3 max-md:grid-cols-1 gap-4">
              <Field label="SSP user" hint="Sent as the acting user on every SSP call.">
                <input
                  type="text"
                  value={sspUserName}
                  onChange={(e) => setSspField("userName", e.target.value)}
                  className="block w-full border border-gray-300 rounded-lg p-2 bg-white text-[13px] outline-none focus:border-[#C5A572]"
                />
              </Field>
              <Field label="Default buyer" hint="Used on every created item's header.">
                <input
                  type="text"
                  value={sspBuyer}
                  onChange={(e) => setSspDefault("buyer", e.target.value)}
                  placeholder="e.g. AMBER MULLALLY"
                  className="block w-full border border-gray-300 rounded-lg p-2 bg-white text-[13px] outline-none focus:border-[#C5A572]"
                />
              </Field>
              <Field label="Default country of origin" hint="VIETNAM or CHINA for most lines.">
                <input
                  type="text"
                  value={sspCountry}
                  onChange={(e) => setSspDefault("countryOfOrigin", e.target.value.toUpperCase())}
                  className="block w-full border border-gray-300 rounded-lg p-2 bg-white text-[13px] outline-none focus:border-[#C5A572]"
                />
              </Field>
            </div>
          </Card>
        </div>
      )}

      {/* ---------------- sync logs ---------------- */}
      {tab === "logs" && <SyncLogsCard />}

      {/* ---------------- printer ---------------- */}
      {tab === "printer" && (
        <Card
          title="Zebra tag printer"
          hint="Only works on the computer the printer is plugged into"
        >
          <p className="text-[13px] text-gray-600 max-w-[62ch]">
            Calibration feeds a few blank tags, then saves the setup inside the printer so
            it re-syncs itself after every power-off, roll change, or ribbon change.
          </p>
          <p className="text-[12.5px] text-gray-500 mt-2.5 mb-4">
            <span className="font-semibold text-gray-700">Run it when:</span> you load a
            new roll type, or tags start printing shifted.
          </p>
          <button
            type="button"
            onClick={handleCalibrate}
            disabled={calibrating}
            className="inline-flex items-center gap-2 px-5 py-2.5 bg-gray-800 text-white rounded-lg text-[13px] font-medium hover:bg-gray-700 disabled:opacity-60"
          >
            <Printer className="w-4 h-4" />
            {calibrating ? "Calibrating..." : "Calibrate printer"}
          </button>
        </Card>
      )}

      {/* ---------------- unsaved-changes bar ---------------- */}
      {dirty && (
        <div className="fixed bottom-0 left-64 right-0 max-md:left-14 bg-white border-t border-gray-200 shadow-lg px-6 py-3 max-md:px-3 flex items-center justify-between z-40">
          <span className="text-[13px] text-gray-600 flex items-center gap-2 whitespace-nowrap">
            <span
              className="w-1.5 h-1.5 rounded-full shrink-0"
              style={{ backgroundColor: GOLD }}
            />
            <span className="max-sm:hidden">Unsaved changes</span>
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setFormData(baseline)}
              className="px-4 py-2 rounded-lg border border-gray-200 text-[13px] text-gray-700 hover:bg-gray-50"
            >
              Discard
            </button>
            <button
              type="button"
              onClick={saveFormData}
              disabled={saving}
              className="px-5 py-2 rounded-lg bg-[#C5A572] text-white text-[13px] font-medium whitespace-nowrap hover:opacity-90 disabled:opacity-50"
            >
              {saving ? "Saving..." : "Save changes"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

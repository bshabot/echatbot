import React, { useState, useEffect, useMemo } from "react";
import { Link } from "react-router-dom";
import {
  Activity,
  History,
  Images,
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

import React, { useState, useEffect,useMemo } from "react";
import { useSupabase } from "../components/SupaBaseProvider";
import { useGenericStore } from "../store/VendorStore";
import { useMessage } from "../components/Messages/MessageContext";
import Loading from "../components/Loading";
import { calibratePrinter } from "../utils/tags/browserPrint";
import { qbHealth } from "../utils/qbClient";

export default function DynamicForm() {
  const {options} = useGenericStore(state => state.getEntity('settings'));
  const updateEntity = useGenericStore(state => state.updateEntity);
  const isLoading = useGenericStore(state => state.isLoading.settings);
  const errors = useGenericStore(state => state.errors.settings);



  const { supabase } = useSupabase();
  const { showMessage } = useMessage();

  const [formData, setFormData] = useState(null);
  const [calibrating, setCalibrating] = useState(false);
  const [qbSaving, setQbSaving] = useState(false);
  const [qbTest, setQbTest] = useState(null); // { testing } | { ok, msg }

  // Initialize formData only once when data is loaded
useEffect(() => {
  if (!options) {
    console.warn("No options available yet from getEntity('settings')");
    return;
  }

  if (!formData) {
    // Ensure the QuickBooks-integration flag always has a shape, defaulting
    // to OFF. This is the safety gate: the integration stays dormant until
    // someone explicitly turns it on here.
    setFormData({
      ...options,
      qbIntegration: options.qbIntegration ?? { enabled: false },
    });
  }
}, [options]);

if(isLoading){
  return <Loading />
}
//   // Handle input changes
    const handleChange = (section, field, value) => {
    setFormData({
      ...formData,

      [section]: {
        ...formData[section],
        [field]: value.split(",").map((item) => item.trim()), // Convert comma-separated values to an array
      },
    });
  };

//   // Save to DB and update store
  const saveFormData = async () => {
    if (!formData) return;

    const { error } = await supabase
      .from("settings")
      .update({ options: {...formData} })
      .eq("id", 1);

    if (error) {
      console.error("Error saving form data:", error);
    } else {
      showMessage("Settings Saved");
      await updateEntity("settings", {options:{...formData}});
    }
  };

//   // Prevent rendering until data is ready
//   if (isLoading || !formData) return <Loading />;

  // Tag printer maintenance - calibrate + persist config on the Zebra.
  // Only works from the computer the printer is connected to (Browser Print).
  const handleCalibrate = async () => {
    setCalibrating(true);
    try {
      await calibratePrinter();
      showMessage("Calibration sent - the printer will feed a few tags, then it's locked in");
    } catch (err) {
      showMessage(err && err.message ? err.message : "Printer not reachable from this computer");
    } finally {
      setCalibrating(false);
    }
  };

  // QuickBooks integration on/off. Persists immediately (not tied to the
  // "Save Changes" button) so the master switch is atomic, and keeps it in
  // formData so a later Save Changes doesn't clobber it. OFF = the app never
  // calls the QB connector; ON = the scrape flow may create missing items in
  // QuickBooks. Default OFF — nothing takes effect until this is turned on.
  const qbEnabled = Boolean(formData?.qbIntegration?.enabled);

  const setQbIntegration = async (enabled) => {
    if (!formData) return;
    setQbSaving(true);
    const nextOptions = {
      ...formData,
      qbIntegration: { ...(formData.qbIntegration || {}), enabled },
    };
    const { error } = await supabase
      .from("settings")
      .update({ options: nextOptions })
      .eq("id", 1);
    if (error) {
      console.error("Error saving QuickBooks setting:", error);
      showMessage("Couldn't save the QuickBooks setting");
      setQbSaving(false);
      return;
    }
    setFormData(nextOptions);
    await updateEntity("settings", { options: nextOptions });
    showMessage(
      enabled ? "QuickBooks integration turned ON" : "QuickBooks integration turned OFF"
    );
    setQbSaving(false);
  };

  // Ping the connector's /health so it's easy to confirm QuickBooks is
  // reachable before turning the integration on. Read-only — never touches
  // QB data.
  const testQbConnection = async () => {
    setQbTest({ testing: true });
    try {
      const h = await qbHealth();
      const bits = [`transport ${h.transport}`];
      if (h.pending_jobs != null) bits.push(`${h.pending_jobs} queued`);
      setQbTest({ ok: true, msg: `Reachable (${bits.join(", ")})` });
    } catch (e) {
      setQbTest({ ok: false, msg: e && e.message ? e.message : "Not reachable" });
    }
  };

  const renderSection = (title, sectionKey) => {
    console.log('title',title,sectionKey,formData)
    const sectionData = formData?.[sectionKey];
    if (!sectionData) return null;

    return (
      <div className="mb-6">
        <h2 className="text-xl font-semibold mb-2">{title}</h2>
        {Object.keys(sectionData).map((field) => (
          <div key={field} className="mb-4">
            <label className="block text-sm font-medium text-gray-700">
              {field.charAt(0).toUpperCase() + field.slice(1)}:
            </label>
            <input
              type="text"
              value={sectionData[field]?.join(", ") ?? ""}
              onChange={(e) =>
                handleChange(sectionKey, field, e.target.value)
              }
              className="mt-1 block w-full border border-gray-300 rounded-md p-2"
              placeholder={`Enter ${field} (comma-separated)`}
            />
          </div>
        ))}
      </div>
    );
  };

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <h1 className="text-2xl font-bold mb-6">Edit Settings</h1>

      {renderSection("Stone Properties", "stonePropertiesForm")}
      {renderSection("Form Fields", "formFields")}
      {/* Uncomment this if customers section should be editable */}
      {/* {renderSection("Customers", "customers")} */}

      <div className="mt-6">
        <button
          onClick={saveFormData}
          className="px-6 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700"
        >
          Save Changes
        </button>
      </div>

      {/* QuickBooks integration master switch */}
      <div className="mb-6 mt-10 border-t pt-6">
        <div className="flex items-center justify-between">
          <div className="pr-6">
            <h2 className="text-xl font-semibold mb-1">QuickBooks Integration</h2>
            <p className="text-sm text-gray-600">
              When <strong>ON</strong>, automated syncs may create records in
              QuickBooks that don't exist yet (via the QB connector). When{" "}
              <strong>OFF</strong>, the app never calls QuickBooks. Leave this{" "}
              <strong>OFF</strong> until the integration is approved to go live —
              nothing runs against QuickBooks while it's off.
            </p>
          </div>

          {/* Toggle switch */}
          <button
            type="button"
            role="switch"
            aria-checked={qbEnabled}
            disabled={qbSaving}
            onClick={() => setQbIntegration(!qbEnabled)}
            className={
              "relative inline-flex h-7 w-12 flex-shrink-0 items-center rounded-full transition-colors focus:outline-none disabled:opacity-60 " +
              (qbEnabled ? "bg-green-600" : "bg-gray-300")
            }
          >
            <span
              className={
                "inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform " +
                (qbEnabled ? "translate-x-6" : "translate-x-1")
              }
            />
          </button>
        </div>

        <div className="mt-3 flex items-center gap-3">
          <span
            className={
              "inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold " +
              (qbEnabled
                ? "bg-green-100 text-green-800"
                : "bg-gray-200 text-gray-700")
            }
          >
            {qbSaving ? "Saving…" : qbEnabled ? "ON — live" : "OFF — inactive"}
          </span>

          <button
            type="button"
            onClick={testQbConnection}
            disabled={qbTest?.testing}
            className="px-4 py-1.5 text-sm bg-gray-800 text-white rounded-md hover:bg-gray-700 disabled:opacity-60"
          >
            {qbTest?.testing ? "Testing…" : "Test connection"}
          </button>

          {qbTest && !qbTest.testing && (
            <span
              className={
                "text-sm " + (qbTest.ok ? "text-green-700" : "text-red-600")
              }
            >
              {qbTest.ok ? "✓ " : "✕ "}
              {qbTest.msg}
            </span>
          )}
        </div>
      </div>

      <div className="mb-6 mt-10 border-t pt-6">
        <h2 className="text-xl font-semibold mb-2">Tag Printer</h2>
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
          className="px-6 py-2 bg-gray-800 text-white rounded-md hover:bg-gray-700 disabled:opacity-60"
        >
          {calibrating ? "Calibrating…" : "Calibrate tag printer"}
        </button>
      </div>
    </div>
  );
}

import React, { useState, useEffect,useMemo } from "react";
import { Link } from "react-router-dom";
import { History } from "lucide-react";
import { useSupabase } from "../components/SupaBaseProvider";
import { useGenericStore } from "../store/VendorStore";
import { useMessage } from "../components/Messages/MessageContext";
import Loading from "../components/Loading";
import { calibratePrinter } from "../utils/tags/browserPrint";

export default function DynamicForm() {
  const {options} = useGenericStore(state => state.getEntity('settings'));
  const updateEntity = useGenericStore(state => state.updateEntity);
  const isLoading = useGenericStore(state => state.isLoading.settings);
  const errors = useGenericStore(state => state.errors.settings);



  const { supabase } = useSupabase();
  const { showMessage } = useMessage();

  const [formData, setFormData] = useState(null);
  const [calibrating, setCalibrating] = useState(false);

  // Initialize formData only once when data is loaded
useEffect(() => {
  if (!options) {
    console.warn("No options available yet from getEntity('settings')");
    return;
  }

  if (!formData) {
    setFormData(options);
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

      <Link
        to="/import-history"
        className="flex items-center gap-2 mb-6 px-4 py-3 bg-white border rounded-md hover:bg-gray-50 text-gray-700 w-fit"
      >
        <History className="w-4 h-4" />
        Import History
      </Link>

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


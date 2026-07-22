import React, { useState } from "react";
import { Link } from "react-router-dom";
import { X, ExternalLink, AlertTriangle, CheckCircle2 } from "lucide-react";
import { useSupabase } from "../SupaBaseProvider";

// Create a sample from a running-line SKU. Inserts a starting_info row then a
// samples row pointing at it. Stones + vendor are left blank (filled in later
// from /samples since the SSP scrape doesn't have reliable stone data).
export default function CreateSamplePanel({ prefill, onClose, onCreated }) {
  const { supabase } = useSupabase();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [createdSampleId, setCreatedSampleId] = useState(null);

  // Editable copies of the prefill values (hooks must run unconditionally,
  // so we initialize from prefill even though we guard rendering below).
  const safe = prefill || {};
  const [name, setName] = useState(safe.name ?? "");
  const [styleNumber, setStyleNumber] = useState(safe.styleNumber ?? "");
  const [metalType, setMetalType] = useState(safe.metalType ?? "Silver");
  const [karat, setKarat] = useState(safe.karat ?? "925");
  const [weight, setWeight] = useState(safe.weight ?? "");
  const [laborCost, setLaborCost] = useState(safe.laborCost ?? "");
  const [platingCharge, setPlatingCharge] = useState(safe.platingCharge ?? "");

  if (!prefill) return null;

  async function handleCreate() {
    if (!styleNumber || String(styleNumber).trim() === "") {
      setError("Style number is required");
      return;
    }
    setSaving(true);
    setError("");
    try {
      // Check style number isn't already taken
      const { data: existing, error: checkErr } = await supabase
        .from("samples")
        .select("id")
        .eq("styleNumber", styleNumber)
        .limit(1);
      if (checkErr) throw checkErr;
      if (existing?.length > 0) {
        throw new Error(`Style number "${styleNumber}" is already in use`);
      }

      // Insert starting_info
      const startingInfoPayload = {
        weight: weight ? parseFloat(weight) : null,
        laborCost: laborCost ? parseFloat(laborCost) : null,
        platingCharge: platingCharge ? parseFloat(platingCharge) : null,
      };
      const { data: siRow, error: siErr } = await supabase
        .from("starting_info")
        .insert([startingInfoPayload])
        .select("id")
        .single();
      if (siErr) throw siErr;

      // Insert samples
      const samplePayload = {
        name: name || null,
        styleNumber: String(styleNumber).trim(),
        metalType: metalType || null,
        karat: karat || null,
        starting_info_id: siRow.id,
      };
      const { data: sampleRow, error: sErr } = await supabase
        .from("samples")
        .insert([samplePayload])
        .select("id")
        .single();
      if (sErr) throw sErr;

      setCreatedSampleId(sampleRow.id);
      onCreated?.({ sampleId: sampleRow.id, styleNumber, startingInfoId: siRow.id, sspNumber: prefill.sspNumber });
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/30 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg shadow-xl max-w-lg w-full p-6 space-y-4">
        <div className="flex items-start justify-between">
          <div>
            <h3 className="text-lg font-semibold text-gray-900">
              Create sample from SSP {prefill.sspNumber}
            </h3>
            <p className="text-sm text-gray-500 mt-1">
              Values pre-filled from the SSP scrape. Vendor + stones can be added
              later in /samples.
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X className="w-5 h-5" />
          </button>
        </div>

        {createdSampleId ? (
          <div className="bg-green-50 border border-green-200 rounded p-4 text-sm space-y-2">
            <div className="flex items-center gap-2 text-green-700 font-medium">
              <CheckCircle2 className="w-5 h-5" />
              Sample created
            </div>
            <div className="text-gray-700">
              {name} · {styleNumber}
            </div>
            <div className="flex gap-2 pt-2">
              <Link
                to={`/samples?sampleId=${createdSampleId}`}
                className="flex items-center gap-1 px-3 py-1.5 bg-[#C5A572] hover:bg-[#B89660] text-white rounded text-sm"
              >
                Open in Samples
                <ExternalLink className="w-4 h-4" />
              </Link>
              <button
                onClick={onClose}
                className="ml-auto px-3 py-1.5 text-sm text-gray-600 hover:text-gray-900"
              >
                Close
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 text-sm max-md:grid-cols-1">
              <Field label="Name (Product SKU)" value={name} onChange={setName} />
              <Field label="Style Number *" value={styleNumber} onChange={setStyleNumber} />
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Metal Type</label>
                <select
                  value={metalType}
                  onChange={(e) => setMetalType(e.target.value)}
                  className="input w-full"
                >
                  <option value="Silver">Silver</option>
                  <option value="Gold">Gold</option>
                  <option value="Brass">Brass</option>
                </select>
              </div>
              <Field label="Karat / Purity" value={karat} onChange={setKarat} />
              <Field label="Weight (g)" value={weight} onChange={setWeight} type="number" />
              <Field label="Labor Cost" value={laborCost} onChange={setLaborCost} type="number" />
              <Field label="Plating Charge" value={platingCharge} onChange={setPlatingCharge} type="number" />
            </div>

            {error && (
              <div className="flex items-start gap-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded p-3">
                <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                {error}
              </div>
            )}

            <div className="flex gap-2 pt-2">
              <button
                onClick={handleCreate}
                disabled={saving}
                className="px-4 py-2 bg-[#C5A572] hover:bg-[#B89660] text-white rounded text-sm disabled:opacity-50"
              >
                {saving ? "Creating..." : "Create Sample"}
              </button>
              <button
                onClick={onClose}
                className="ml-auto px-3 py-1.5 text-sm text-gray-600 hover:text-gray-900"
              >
                Cancel
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Field({ label, value, onChange, type = "text" }) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-700 mb-1">{label}</label>
      <input
        type={type}
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
        className="input w-full"
        step={type === "number" ? "any" : undefined}
      />
    </div>
  );
}

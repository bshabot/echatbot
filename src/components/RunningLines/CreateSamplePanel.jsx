import React from "react";
import { Link } from "react-router-dom";
import { X, ExternalLink, Copy } from "lucide-react";

// Lightweight "here are the values to copy into the sample form" panel.
// Auto-prefill into AddSampleModal is phase 2 — for v1 we keep AddSampleModal
// untouched and let Brian paste these into the existing form.
export default function CreateSamplePanel({ prefill, onClose }) {
  if (!prefill) return null;

  const copyAll = async () => {
    const text = [
      `Product Sku (name): ${prefill.name ?? ""}`,
      `Style Number: ${prefill.styleNumber ?? ""}`,
      `Metal Type: ${prefill.metalType ?? ""}`,
      `Karat: ${prefill.karat ?? ""}`,
      `Weight (g): ${prefill.weight ?? ""}`,
      `Labor Cost: ${prefill.laborCost ?? ""}`,
      `Plating Charge: ${prefill.platingCharge ?? ""}`,
      `(source: SSP ${prefill.sspNumber ?? ""})`,
    ].join("\n");
    try {
      await navigator.clipboard.writeText(text);
    } catch {}
  };

  const rows = [
    ["Product Sku (name)", prefill.name],
    ["Style Number", prefill.styleNumber],
    ["Metal Type", prefill.metalType],
    ["Karat", prefill.karat],
    ["Weight (g)", prefill.weight],
    ["Labor Cost", prefill.laborCost],
    ["Plating Charge", prefill.platingCharge],
  ];

  return (
    <div className="fixed inset-0 bg-black/30 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg shadow-xl max-w-lg w-full p-6 space-y-4">
        <div className="flex items-start justify-between">
          <div>
            <h3 className="text-lg font-semibold text-gray-900">
              Create sample from SSP {prefill.sspNumber}
            </h3>
            <p className="text-sm text-gray-500 mt-1">
              Copy these values into the Add Sample form. Vendor and stones still need to be filled
              in manually — they aren't reliable from the SSP scrape.
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="border rounded divide-y text-sm">
          {rows.map(([label, value]) => (
            <div key={label} className="flex items-baseline justify-between px-3 py-2">
              <span className="text-gray-500">{label}</span>
              <span className="font-mono text-gray-900 text-right break-all">
                {value === "" || value == null ? "—" : String(value)}
              </span>
            </div>
          ))}
        </div>

        <div className="flex gap-2">
          <button
            onClick={copyAll}
            className="flex items-center gap-1 px-3 py-1.5 bg-gray-100 hover:bg-gray-200 rounded text-sm"
          >
            <Copy className="w-4 h-4" />
            Copy all
          </button>
          <Link
            to="/samples"
            className="flex items-center gap-1 px-3 py-1.5 bg-[#C5A572] hover:bg-[#B89660] text-white rounded text-sm"
          >
            Open Samples
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
    </div>
  );
}

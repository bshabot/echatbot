import React, { useState } from "react";
import { Plus } from "lucide-react";
import { useSupabase } from "../SupaBaseProvider";
import { useGenericStore } from "../../store/VendorStore";
import { useMessage } from "../Messages/MessageContext";
import VendorAccounts from "../Vendor/VendorAccounts";

// Settings > Vendor portal. Two jobs: add a vendor (the factory record) and give
// that vendor a portal login. Logins are created by the vendor-admin Netlify
// function (see VendorAccounts); this card only adds the vendor row.
const EMPTY = { name: "", email: "", phone: "" };

export default function VendorPortalCard() {
  const { supabase } = useSupabase();
  const { showMessage } = useMessage();
  const { getEntity, updateEntity } = useGenericStore();
  const vendors = getEntity("vendors");
  const list = Array.isArray(vendors) ? vendors : [];
  const [form, setForm] = useState(EMPTY);
  const [busy, setBusy] = useState(false);

  const addVendor = async (e) => {
    e.preventDefault();
    const name = form.name.trim();
    if (!name) return;
    if (list.some((v) => (v.name || "").trim().toLowerCase() === name.toLowerCase())) {
      return showMessage("A vendor with that name already exists", { type: "error" });
    }
    setBusy(true);
    const { data, error } = await supabase
      .from("vendors")
      .insert([
        {
          name,
          email: form.email.trim(),
          phone: form.phone.trim(),
          address: "",
          paymentterms: "",
          notes: "",
          pricingsetting: { lossPercentage: 0, markupPercentage: 0, laborMultiplier: 1, additionalcharges: [] },
        },
      ])
      .select();
    setBusy(false);
    if (error) {
      console.error("Error adding vendor:", error);
      return showMessage("Could not add the vendor", { type: "error" });
    }
    updateEntity("vendors", [...list, ...data]);
    setForm(EMPTY);
    showMessage(`${name} added. Create a login for them below.`);
  };

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <div>
      <div className="bg-white border border-gray-200 rounded-xl mb-4 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-200">
          <h3 className="text-sm font-semibold text-gray-900">Add a vendor</h3>
          <p className="text-xs text-gray-500 mt-0.5">
            The factory record. Pricing and address can be filled in later on the Vendors page.
          </p>
        </div>
        <form onSubmit={addVendor} className="p-4 flex flex-wrap gap-3 items-end">
          <label className="text-sm">
            <span className="block text-xs text-gray-600 mb-1">Name</span>
            <input className="input !p-1.5" value={form.name} onChange={set("name")} required maxLength={120} />
          </label>
          <label className="text-sm">
            <span className="block text-xs text-gray-600 mb-1">Contact email</span>
            <input className="input !p-1.5" type="email" value={form.email} onChange={set("email")} />
          </label>
          <label className="text-sm">
            <span className="block text-xs text-gray-600 mb-1">Phone</span>
            <input className="input !p-1.5" value={form.phone} onChange={set("phone")} maxLength={40} />
          </label>
          <button
            disabled={busy}
            className="flex items-center px-3 py-2 text-sm text-white rounded-lg bg-chabot-gold disabled:opacity-50"
          >
            <Plus className="w-4 h-4 mr-1" />
            Add vendor
          </button>
        </form>
      </div>

      <div className="bg-white border border-gray-200 rounded-xl p-4 -mt-6">
        <VendorAccounts vendors={list} />
      </div>
    </div>
  );
}

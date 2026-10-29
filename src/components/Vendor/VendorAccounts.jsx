import { useCallback, useEffect, useState } from "react";
import { useSupabase } from "../SupaBaseProvider";
import { useMessage } from "../Messages/MessageContext";
import { vendorAdmin } from "../../utils/vendorAdminApi";

// Vendor portal logins: create, reset password, disable, end sessions.
// Passwords are hashed server-side; staff see a temporary one exactly once.
// Reads use an explicit column list: password_hash is not readable by staff.
const ACCOUNT_COLUMNS = "id,vendor_id,email,enabled,must_change_password,failed_attempts,locked_until,last_login_at,created_at";

const fmt = (d) => (d ? new Date(d).toLocaleString() : "never");

export default function VendorAccounts({ vendors = [] }) {
  const { supabase, session } = useSupabase();
  const { showMessage } = useMessage();
  const [accounts, setAccounts] = useState([]);
  const [activity, setActivity] = useState([]);
  const [vendorId, setVendorId] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [temp, setTemp] = useState(null); // { email, password }

  const load = useCallback(async () => {
    const [{ data: a }, { data: log }] = await Promise.all([
      supabase.from("vendor_accounts").select(ACCOUNT_COLUMNS).order("created_at", { ascending: false }),
      supabase.from("vendor_audit_log").select("at,account_id,action,outcome").order("at", { ascending: false }).limit(30),
    ]);
    setAccounts(a ?? []);
    setActivity(log ?? []);
  }, [supabase]);

  useEffect(() => {
    load();
  }, [load]);

  const vendorName = (id) => vendors.find((v) => v.id === id)?.name ?? `Vendor ${id}`;
  const emailFor = (id) => accounts.find((a) => a.id === id)?.email ?? "unknown";

  const run = async (action, payload, done) => {
    setBusy(true);
    const res = await vendorAdmin(session, action, payload);
    setBusy(false);
    if (!res.ok) return showMessage(res.message || "That did not work", { type: "error" });
    done?.(res);
    await load();
  };

  const create = (e) => {
    e.preventDefault();
    run("createAccount", { vendorId: Number(vendorId), email }, (res) => {
      setTemp({ email: res.email, password: res.tempPassword });
      setEmail("");
    });
  };

  return (
    <div className="mt-10">
      <h2 className="text-xl font-bold text-gray-900 mb-1">Vendor portal logins</h2>
      <p className="text-sm text-gray-500 mb-4">Vendors sign in at /vendor. Passwords are never visible; reset issues a new temporary one.</p>

      {temp && (
        <div className="mb-4 p-3 rounded-lg border border-yellow-300 bg-yellow-50 text-sm">
          <div className="font-medium">Temporary password for {temp.email} (shown once)</div>
          <div className="font-mono text-base my-1 select-all">{temp.password}</div>
          <div className="text-gray-600">They must choose their own at first sign-in.</div>
          <button className="mt-2 text-chabot-gold" onClick={() => setTemp(null)}>
            Done, hide it
          </button>
        </div>
      )}

      <form onSubmit={create} className="flex flex-wrap gap-2 items-end mb-5">
        <label className="text-sm">
          <span className="block text-xs text-gray-600 mb-1">Vendor</span>
          <select className="input !p-1.5" value={vendorId} onChange={(e) => setVendorId(e.target.value)} required>
            <option value="" />
            {vendors.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="block text-xs text-gray-600 mb-1">Login email</span>
          <input className="input !p-1.5" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <button disabled={busy} className="px-3 py-2 text-sm text-white rounded-lg bg-chabot-gold disabled:opacity-50">
          Create login
        </button>
      </form>

      <div className="bg-white border rounded-lg overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="text-left text-xs text-gray-500">
            <tr>
              <th className="p-2">Vendor</th>
              <th className="p-2">Email</th>
              <th className="p-2">Status</th>
              <th className="p-2">Last login</th>
              <th className="p-2" />
            </tr>
          </thead>
          <tbody>
            {accounts.map((a) => {
              const locked = a.locked_until && new Date(a.locked_until) > new Date();
              return (
                <tr key={a.id} className="border-t">
                  <td className="p-2">{vendorName(a.vendor_id)}</td>
                  <td className="p-2">{a.email}</td>
                  <td className="p-2">
                    {!a.enabled ? "Disabled" : locked ? "Locked" : a.must_change_password ? "Awaiting first login" : "Active"}
                  </td>
                  <td className="p-2">{fmt(a.last_login_at)}</td>
                  <td className="p-2 text-right whitespace-nowrap space-x-3">
                    <button disabled={busy} className="text-chabot-gold" onClick={() => run("resetPassword", { accountId: a.id }, (res) => setTemp({ email: a.email, password: res.tempPassword }))}>
                      Reset password
                    </button>
                    <button disabled={busy} className="text-gray-600" onClick={() => run("revokeSessions", { accountId: a.id }, () => showMessage("Signed out everywhere"))}>
                      End sessions
                    </button>
                    <button disabled={busy} className={a.enabled ? "text-red-600" : "text-green-700"} onClick={() => run("setEnabled", { accountId: a.id, enabled: !a.enabled })}>
                      {a.enabled ? "Disable" : "Enable"}
                    </button>
                  </td>
                </tr>
              );
            })}
            {accounts.length === 0 && (
              <tr>
                <td className="p-3 text-gray-500" colSpan={5}>
                  No vendor logins yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {activity.length > 0 && (
        <details className="mt-4 text-sm">
          <summary className="cursor-pointer text-gray-600">Recent activity</summary>
          <ul className="mt-2 space-y-1 text-gray-600">
            {activity.map((l, i) => (
              <li key={i}>
                {fmt(l.at)} · {l.account_id ? emailFor(l.account_id) : "unknown email"} · {l.action} · {l.outcome}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

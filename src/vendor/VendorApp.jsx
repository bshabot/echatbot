import { useCallback, useEffect, useState } from "react";
import { portal } from "./api.js";
import AddItems from "./AddItems.jsx";
import MySubmissions from "./MySubmissions.jsx";

function Shell({ children, right }) {
  return (
    <div className="min-h-screen bg-gray-100">
      <header className="bg-white border-b">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="font-semibold text-gray-900">E. Chabot Vendor Portal</div>
          {right}
        </div>
      </header>
      <main className="max-w-5xl mx-auto px-4 py-6">{children}</main>
    </div>
  );
}

function Login({ onDone }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await portal("login", { email, password });
    setBusy(false);
    setPassword("");
    if (!res.ok) return setError(res.message || "Invalid email or password.");
    onDone();
  };

  return (
    <Shell>
      <form onSubmit={submit} className="max-w-sm mx-auto bg-white border rounded-lg p-6 space-y-4">
        <h1 className="text-lg font-semibold">Sign in</h1>
        <label className="block text-sm">
          Email
          <input className="input mt-1" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label className="block text-sm">
          Password
          <input className="input mt-1" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button disabled={busy} className="w-full px-4 py-2 text-white rounded-lg bg-chabot-gold disabled:opacity-50">
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </Shell>
  );
}

function ChangePassword({ email, onDone, onSessionLost }) {
  const [pw, setPw] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (pw !== again) return setError("The two passwords don't match.");
    setBusy(true);
    setError(null);
    const res = await portal("changePassword", { newPassword: pw, email });
    setBusy(false);
    if (res.status === 401) return onSessionLost();
    if (!res.ok) return setError(res.message || "Could not change the password.");
    onDone();
  };

  return (
    <Shell>
      <form onSubmit={submit} className="max-w-sm mx-auto bg-white border rounded-lg p-6 space-y-4">
        <h1 className="text-lg font-semibold">Choose your password</h1>
        <p className="text-sm text-gray-600">Use at least 12 characters. A few random words works well.</p>
        <input className="input" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="New password" required />
        <input className="input" type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} placeholder="Repeat password" required />
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button disabled={busy} className="w-full px-4 py-2 text-white rounded-lg bg-chabot-gold disabled:opacity-50">
          Save password
        </button>
      </form>
    </Shell>
  );
}

export default function VendorApp() {
  const [stage, setStage] = useState("loading"); // loading | login | password | portal
  const [email, setEmail] = useState("");
  const [info, setInfo] = useState(null);
  const [tab, setTab] = useState("add");
  const [notice, setNotice] = useState(null);

  const lost = useCallback(() => {
    setInfo(null);
    setStage("login");
  }, []);

  const boot = useCallback(async () => {
    setStage("loading");
    const s = await portal("session");
    if (!s.ok) return setStage("login");
    setEmail(s.session?.email ?? "");
    if (s.session?.mustChange) return setStage("password");
    const i = await portal("info");
    if (!i.ok) return setStage("login");
    setInfo(i.info);
    setStage("portal");
  }, []);

  useEffect(() => {
    boot();
  }, [boot]);

  const logout = async () => {
    await portal("logout");
    lost();
  };

  if (stage === "loading") return <Shell>{null}</Shell>;
  if (stage === "login") return <Login onDone={boot} />;
  if (stage === "password") return <ChangePassword email={email} onDone={boot} onSessionLost={lost} />;

  return (
    <Shell
      right={
        <div className="flex items-center gap-4 text-sm">
          <span className="text-gray-600">{info.vendor}</span>
          <button className="text-chabot-gold" onClick={logout}>
            Sign out
          </button>
        </div>
      }
    >
      <div className="flex gap-2 mb-5">
        {[["add", "Add items"], ["mine", "My submissions"]].map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`px-4 py-2 text-sm rounded-lg border ${tab === key ? "bg-chabot-gold text-white border-chabot-gold" : "bg-white"}`}
          >
            {label}
          </button>
        ))}
      </div>
      {notice && <p className="mb-4 text-sm text-green-700">{notice}</p>}
      {tab === "add" ? (
        <AddItems
          info={info}
          onSessionLost={lost}
          onSubmitted={(n) => {
            setNotice(`Submitted ${n} item${n === 1 ? "" : "s"} for review.`);
            setTab("mine");
          }}
        />
      ) : (
        <MySubmissions info={info} onSessionLost={lost} />
      )}
    </Shell>
  );
}

// docFolder.js — optional "save generated files to a folder" (File System
// Access API, Chrome/Edge). Pick a folder once — e.g. the OneDrive
// "Shipments manifests" folder — and files write straight there instead of
// the browser Downloads folder. Handles are remembered per browser profile
// (IndexedDB), so Brian / Ezra / Esther each pick once on their own machine.
// Chrome may re-ask permission once per session (one click). Anything
// unsupported, denied, or cancelled falls back to a normal download — files
// can never get lost.
//
// SLOTS: each doc family gets its own remembered folder.
//   "shipments" — manifest / pickup docs (Shipments page)
//   "rebills"   — rebill + PO line CSVs (Sales Orders page)
//   "labels"    — FineLine upload files (Label Orders page)

const DB_NAME = "echabot_doc_folder";
const STORE = "kv";

const SLOTS = {
  shipments: { key: "dir_handle", pickerId: "shipment-docs" }, // key predates slots — don't rename
  rebills: { key: "rebills_dir_handle", pickerId: "rebills" },
  labels: { key: "labels_dir_handle", pickerId: "labels" },
};
const slotOf = (slot) => SLOTS[slot] || SLOTS.shipments;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function kvGet(key) {
  try {
    const db = await openDb();
    return await new Promise((resolve) => {
      const r = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
      r.onsuccess = () => resolve(r.result || null);
      r.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

async function kvSet(key, value) {
  try {
    const db = await openDb();
    await new Promise((resolve) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = resolve;
      tx.onerror = resolve;
    });
  } catch {
    /* ignore — worst case we fall back to downloads */
  }
}

export function folderApiSupported() {
  return typeof window !== "undefined" && "showDirectoryPicker" in window;
}

export async function pickDocFolder(slot = "shipments") {
  const s = slotOf(slot);
  const handle = await window.showDirectoryPicker({ id: s.pickerId, mode: "readwrite" });
  await kvSet(s.key, handle);
  return handle;
}

export async function clearDocFolder(slot = "shipments") {
  await kvSet(slotOf(slot).key, null);
}

export async function getDocFolderName(slot = "shipments") {
  const h = await kvGet(slotOf(slot).key);
  return h ? h.name : null;
}

// Resolve a writable handle NOW — call this first inside the click handler,
// BEFORE any slow fetching / PDF rendering: the permission re-prompt needs
// the user gesture to still be fresh. Returns null when no folder is set /
// permission denied / API unsupported — caller downloads instead.
export async function getWritableDocFolder(slot = "shipments") {
  if (!folderApiSupported()) return null;
  try {
    const h = await kvGet(slotOf(slot).key);
    if (!h) return null;
    let p = await h.queryPermission({ mode: "readwrite" });
    if (p === "prompt") p = await h.requestPermission({ mode: "readwrite" });
    return p === "granted" ? h : null;
  } catch {
    return null;
  }
}

// true = written into the folder; false = caller should download instead.
// Same filename overwrites — re-exports don't pile up "(1) (2)" copies.
export async function writeToFolder(dir, filename, blob) {
  if (!dir) return false;
  try {
    const fh = await dir.getFileHandle(filename, { create: true });
    const w = await fh.createWritable();
    await w.write(blob);
    await w.close();
    return true;
  } catch (err) {
    console.error("doc folder write failed:", err);
    return false;
  }
}

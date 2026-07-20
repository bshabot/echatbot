// docFolder.js — optional "save shipment docs to a folder" (File System
// Access API, Chrome/Edge). Pick the folder once — e.g. the OneDrive
// "Shipments manifests" folder — and every manifest / pickup doc writes
// straight there instead of the browser Downloads folder. The handle is
// remembered per browser profile (IndexedDB), so Brian and Ezra each pick
// once on their own machine. Chrome may re-ask permission once per session
// (one click). Anything unsupported, denied, or cancelled falls back to a
// normal download — docs can never get lost.

const DB_NAME = "echabot_doc_folder";
const STORE = "kv";
const KEY = "dir_handle";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function kvGet() {
  try {
    const db = await openDb();
    return await new Promise((resolve) => {
      const r = db.transaction(STORE, "readonly").objectStore(STORE).get(KEY);
      r.onsuccess = () => resolve(r.result || null);
      r.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

async function kvSet(value) {
  try {
    const db = await openDb();
    await new Promise((resolve) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(value, KEY);
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

export async function pickDocFolder() {
  const handle = await window.showDirectoryPicker({ id: "shipment-docs", mode: "readwrite" });
  await kvSet(handle);
  return handle;
}

export async function clearDocFolder() {
  await kvSet(null);
}

export async function getDocFolderName() {
  const h = await kvGet();
  return h ? h.name : null;
}

// Resolve a writable handle NOW — call this first inside the click handler,
// BEFORE any slow PDF rendering: the permission re-prompt needs the user
// gesture to still be fresh. Returns null when no folder is set / permission
// denied / API unsupported — caller downloads instead.
export async function getWritableDocFolder() {
  if (!folderApiSupported()) return null;
  try {
    const h = await kvGet();
    if (!h) return null;
    let p = await h.queryPermission({ mode: "readwrite" });
    if (p === "prompt") p = await h.requestPermission({ mode: "readwrite" });
    return p === "granted" ? h : null;
  } catch {
    return null;
  }
}

// true = written into the folder; false = caller should download instead.
// Same filename overwrites — reprints don't pile up "(1) (2)" copies.
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

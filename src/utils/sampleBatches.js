// src/utils/sampleBatches.js
//
// "Batches": a saved snapshot of the samples you had selected, so you can come
// back to exactly that group (to fix things) after a refresh, and only remove
// it once you've confirmed it's good. A batch is created two ways: explicitly
// ("Save as batch" in the selection Actions menu) or automatically whenever a
// bulk action (print tags, QB, SSP, duplicate) is run on a selection.
//
// Stored in this browser's localStorage (so it survives refresh and is shared
// across your tabs), NOT in the database -- another computer won't see it.
// Style numbers are snapshotted at save time, so a batch still reads properly
// if a sample is later renamed or deleted.

import { useEffect, useState } from "react";

const KEY = "plm.sample_batches";
const CHANGED = "plm-sample-batches-changed";
const MAX_BATCHES = 200;

export function loadBatches() {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persist(list) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX_BATCHES)));
  } catch (e) {
    console.warn("Could not save sample batches:", e);
  }
  // `storage` only fires in OTHER tabs; tell this tab's listeners too.
  window.dispatchEvent(new Event(CHANGED));
}

export function getBatch(id) {
  return loadBatches().find((b) => b.id === id) || null;
}

const sameIds = (a, b) => a.length === b.length && [...a].sort().join(",") === [...b].sort().join(",");

// First batch that already holds every one of these samples (or null).
export function findCoveringBatch(sampleIds) {
  const ids = [...new Set(sampleIds)];
  if (!ids.length) return null;
  return loadBatches().find((b) => ids.every((id) => b.sampleIds.includes(id))) || null;
}

// batch = { name, sampleIds: number[], styleNumbers: string[], source, unitCount }
// Returns { batch, duplicate }. Idempotent: the exact same set of samples is
// never saved twice (the existing batch is returned). With `skipIfCovered`
// (used by automatic saves from bulk actions) a selection whose samples are
// already all inside existing batches isn't saved again either.
export function addBatch({ name, sampleIds, styleNumbers = [], source = "Saved", unitCount, skipIfCovered = false }) {
  const ids = [...new Set(sampleIds)];
  const all = loadBatches();
  const now = Date.now();
  const same = all.find((b) => sameIds(b.sampleIds, ids));
  if (same) return { batch: same, duplicate: true };
  if (skipIfCovered) {
    const covering = findCoveringBatch(ids);
    if (covering) return { batch: covering, duplicate: true };
  }
  const batch = {
    id: `b${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name: name || `Batch ${new Date(now).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`,
    createdAt: now,
    source,
    sampleIds: ids,
    styleNumbers,
    unitCount: unitCount ?? ids.length,
  };
  persist([batch, ...all]);
  return { batch, duplicate: false };
}

export function renameBatch(id, name) {
  const n = (name || "").trim();
  if (!n) return;
  persist(loadBatches().map((b) => (b.id === id ? { ...b, name: n } : b)));
}

export function removeBatch(id) {
  persist(loadBatches().filter((b) => b.id !== id));
}

// Live list: updates on changes in this tab and in other tabs.
export function useBatches() {
  const [batches, setBatches] = useState(loadBatches);
  useEffect(() => {
    const refresh = () => setBatches(loadBatches());
    const onStorage = (e) => { if (e.key === KEY) refresh(); };
    window.addEventListener(CHANGED, refresh);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(CHANGED, refresh);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  return batches;
}

// Bulk Add batches (browser-local). Every Save All in the Bulk Add grid files
// ALL of its rows -- saved ones and ones that failed or had missing fields --
// into one numbered batch, so the whole set can be reopened and bulk edited
// together. Kept in localStorage because rows that never saved aren't in the
// database yet.
const KEY = "bulkAddBatches_v1";
const COUNTER_KEY = "bulkAddBatchCounter_v1";
const MAX_BATCHES = 40;

export const loadBatches = () => {
  try {
    const raw = window.localStorage.getItem(KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
};

const writeBatches = (list) => {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX_BATCHES)));
  } catch {
    // storage full or unavailable -- batches are a convenience, never block a save
  }
};

export const nextBatchNumber = () => {
  try {
    const n = (parseInt(window.localStorage.getItem(COUNTER_KEY) || "0", 10) || 0) + 1;
    window.localStorage.setItem(COUNTER_KEY, String(n));
    return n;
  } catch {
    return Date.now() % 100000;
  }
};

// batch = { id, number, createdAt, updatedAt, rows: [...] }
export const upsertBatch = (batch) => {
  const list = loadBatches().filter((b) => b.id !== batch.id);
  list.unshift({ ...batch, updatedAt: new Date().toISOString() });
  list.sort((a, b) => (b.number || 0) - (a.number || 0));
  writeBatches(list);
  return list;
};

export const removeBatch = (id) => {
  const list = loadBatches().filter((b) => b.id !== id);
  writeBatches(list);
  return list;
};

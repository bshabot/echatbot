// Which outside systems a style has been on: QuickBooks, Signet SSP, OrderStream.
// Rows live in sample_connections (style_number + system). Best effort: a failed write never breaks the real action.
export const baseStyle = (s) => String(s || "").split("/")[0].trim();

export async function recordConnections(supabase, styles, system, ref = null) {
  try {
    const seen = new Set();
    const rows = [];
    for (const s of styles || []) {
      const style_number = baseStyle(s);
      if (!style_number || seen.has(style_number)) continue;
      seen.add(style_number);
      rows.push({ style_number, system, ref, at: new Date().toISOString() });
    }
    if (!rows.length) return;
    const { error } = await supabase.from("sample_connections").upsert(rows, { onConflict: "style_number,system" });
    if (error) throw error;
    if (typeof window !== "undefined") window.dispatchEvent(new Event("sample-connections-changed"));
  } catch (e) {
    console.warn("[connections] not recorded:", e?.message || e);
  }
}

export async function fetchConnections(supabase, styles) {
  const list = [...new Set((styles || []).map(baseStyle).filter(Boolean))];
  const map = {};
  for (let i = 0; i < list.length; i += 200) {
    const { data } = await supabase.from("sample_connections").select("style_number,system,ref,at").in("style_number", list.slice(i, i + 200));
    for (const r of data || []) (map[r.style_number] ||= {})[r.system] = { ref: r.ref, at: r.at };
  }
  return map;
}

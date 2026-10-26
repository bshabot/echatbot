// Suggests the next style number for a vendor submission, following the house rules:
//   <prefix><next number><type letters><suffix>
//   prefix: N = silver, G = gold, B = brass
//   type letters: E earring, HE huggie/hoop, NK necklace, R ring, BR bracelet, BN bangle, C charm, P pendant, NR nose ring
//   suffix: -GP when gold plated; solid gold takes karat + colour (e.g. -10Y, -14W)
// The number is the highest existing number for that prefix plus one. Staff can always edit it.
// Flatbacks and other special lines use their own prefixes, so no suggestion is made for them.

const PREFIX = { silver: "N", gold: "G", brass: "B" };

export function typeLetters(type) {
  const t = String(type || "").toLowerCase();
  if (!t || /flatback/.test(t)) return null;
  if (/nose/.test(t)) return "NR";
  if (/huggie|hoop/.test(t) && !/charm/.test(t)) return "HE";
  if (/hoop charm|charm/.test(t)) return "C";
  if (/earring|stud/.test(t)) return "E";
  if (/necklace|chain/.test(t)) return "NK";
  if (/bangle/.test(t)) return "BN";
  if (/bracelet/.test(t)) return "BR";
  if (/ring/.test(t)) return "R";
  if (/pendant/.test(t)) return "P";
  return null;
}

export function styleParts(d) {
  const prefix = PREFIX[String(d?.metal_type || "").toLowerCase()];
  const letters = typeLetters(d?.type);
  if (!prefix || !letters) return null;
  let suffix = "";
  if (prefix === "G") {
    const k = String(d.karat || "").replace(/[^0-9]/g, "");
    const c = { yellow: "Y", white: "W", rose: "R" }[String(d.color || "").toLowerCase()] || "";
    if (k) suffix = `-${k}${c}`;
  } else if (/gold|vermeil|yellow/i.test(String(d.plating || ""))) {
    suffix = "-GP";
  }
  return { prefix, letters, suffix };
}

// Highest number in use for a prefix (e.g. N8133E -> 8133). Pages through samples.
export async function maxNumberFor(supabase, prefix) {
  const re = new RegExp(`^${prefix}(\\d+)[A-Za-z]*(?:-|$)`);
  let max = 0;
  for (let from = 0; from < 20000; from += 1000) {
    const { data, error } = await supabase
      .from("samples")
      .select("styleNumber")
      .like("styleNumber", `${prefix}%`)
      .range(from, from + 999);
    if (error) throw error;
    for (const r of data ?? []) {
      const m = re.exec(String(r.styleNumber || ""));
      if (m) max = Math.max(max, Number(m[1]));
    }
    if (!data || data.length < 1000) break;
  }
  return max;
}

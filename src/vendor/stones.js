// Stones are entered the way vendors already send them: one code per stone, size then "-" then quantity.
//   RS1.65-10   -> round stone, 1.65 mm, 10 pieces
//   pearl6.0-1  -> pearl, 6.0 mm, 1 piece
// Separate several stones with commas, semicolons or new lines. Codes we do not know yet are kept
// as written (type "Other") so staff can read them.

export const STONE_CODES = {
  rs: { type: "CZ", shape: "Round", label: "Round stone (CZ)" },
  pearl: { type: "Pearl", shape: "Round", label: "Pearl" },
};

const TOKEN = /^([a-z]+)\s*([0-9]*\.?[0-9]+)?\s*(?:mm)?\s*[-x*]\s*([0-9]{1,4})$/i;

export function splitCodes(text) {
  return String(text ?? "")
    .split(/[\n,;]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

export function parseStoneCodes(text) {
  const stones = [];
  const unknown = [];
  for (const raw of splitCodes(text)) {
    const m = TOKEN.exec(raw);
    const def = m ? STONE_CODES[m[1].toLowerCase()] : null;
    if (m && def) {
      stones.push({ type: def.type, shape: def.shape, ...(m[2] ? { size: m[2] } : {}), quantity: Number(m[3]), notes: raw });
    } else {
      unknown.push(raw);
      stones.push({ type: "Other", notes: raw.slice(0, 60) });
    }
  }
  return { stones, unknown };
}

export function describeStone(s) {
  const code = Object.values(STONE_CODES).find((d) => d.type === s.type && d.shape === s.shape);
  return [s.quantity ? `${s.quantity}×` : null, code ? code.label : s.type, s.size ? `${s.size} mm` : null].filter(Boolean).join(" ");
}

// src/utils/fuzzy.js
//
// Small typo-tolerant matcher for the Ctrl+K box. Not every character has to
// match: "gpfb154" finds "GPFB154-10KYG", "ord" finds "Sales Orders",
// "shpmnts" finds "Shipments".

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// Score one query word against one text. null = no match; higher = better.
function scoreWord(word, text) {
  if (!word) return 0;
  const idx = text.indexOf(word);
  if (idx >= 0) {
    // Exact substring: best when it starts the text or a word.
    const atWordStart = idx === 0 || text[idx - 1] === " ";
    return 100 + (atWordStart ? 40 : 0) - idx * 0.5 + word.length;
  }
  // Subsequence: every letter appears, in order (gaps allowed).
  let ti = 0;
  let score = 0;
  let streak = 0;
  for (let qi = 0; qi < word.length; qi++) {
    const c = word[qi];
    let found = -1;
    for (let k = ti; k < text.length; k++) {
      if (text[k] === c) {
        found = k;
        break;
      }
    }
    if (found < 0) return null;
    streak = found === ti ? streak + 1 : 0;
    score += 4 + streak * 3 + (found === 0 || text[found - 1] === " " ? 6 : 0);
    ti = found + 1;
  }
  // Tighter matches (less spread out) rank higher.
  return score - (ti - word.length) * 0.4;
}

/**
 * Score `query` against `text`. Every space-separated word of the query must
 * match somewhere (in any order); returns null if any word fails.
 */
export function fuzzyScore(query, text) {
  const t = norm(text);
  const words = norm(query).split(" ").filter(Boolean);
  if (words.length === 0) return 0;
  let total = 0;
  for (const w of words) {
    const s = scoreWord(w, t);
    if (s == null) return null;
    total += s;
  }
  return total;
}

/** Rank `items` by their best-scoring text; drops non-matches. */
export function fuzzyFilter(query, items, getTexts) {
  const out = [];
  for (const item of items) {
    let best = null;
    for (const text of getTexts(item)) {
      const s = fuzzyScore(query, text);
      if (s != null && (best == null || s > best)) best = s;
    }
    if (best != null) out.push({ item, score: best });
  }
  return out.sort((a, b) => b.score - a.score).map((x) => x.item);
}

/** "gpfb-154" -> "%g%p%f%b%1%5%4%" : a database-side "contains these letters in order" pattern. */
export function looseLikePattern(query) {
  const chars = String(query || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return chars ? `%${chars.split("").join("%")}%` : null;
}

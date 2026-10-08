// Maps a Create-in-SSP warning / failure message to the part of the sample
// that needs fixing, so the Fix button can open the edit modal at the right
// section. Matching is by keyword on the human-readable message, so new SSP
// messages simply fall back to the first section.
//
// section ids are the SectionNav ids in SampleInfoModal.
// settings: true when the message says the fix lives in Settings -> Signet SSP.
const RULES = [
  { re: /Settings\s*(→|->)\s*Signet SSP|Settings\s*(→|->)\s*SSP/i, section: null, settings: true },
  { re: /metal loss/i, section: "plating" },
  { re: /plating|micron|colour|color on at least/i, section: "plating" },
  { re: /stone|setting charge/i, section: "stones" },
  { re: /length|height|width|dimension|ring size/i, section: "size" },
  { re: /weight|karat|metal data|metalType|metal price/i, section: "metal" },
  { re: /assembly|ticket|labor|vendor cost|sales price|total cost|cost/i, section: "costs" },
  { re: /selling type|sells as|pairs|back/i, section: "backs" },
  { re: /type\s+"|product type|category|finding|SSP mapping|buyer/i, section: "category" },
  { re: /image|photo/i, section: "basics" },
];

export function classifySspIssue(text) {
  const t = String(text || "");
  let settings = false;
  let section = null;
  for (const r of RULES) {
    if (r.re.test(t)) {
      if (r.settings) settings = true;
      else if (!section) section = r.section;
    }
  }
  return { text: t, section: section || "basics", settings };
}

export const SSP_SECTION_LABELS = {
  basics: "Basics",
  metal: "Metal & weight",
  plating: "Loss & plating",
  stones: "Stones",
  costs: "Costs",
  backs: "Backs & stock",
  category: "Category",
  size: "Size & notes",
};

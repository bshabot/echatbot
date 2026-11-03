// src/utils/quoteSave.js
//
// The save logic for the quote page (NewQuote.jsx), kept free of React so it can be
// unit-tested (test/quoteSave.test.mjs runs on every push via .github/workflows/test.yml).
//
// Why this exists: saving an edited quote once tried to INSERT a new quote row with the
// loaded quote's id ("duplicate key value violates unique constraint quotes_pkey") because
// the page decided create-vs-update from the ?quote= URL param alone. The rules below are
// what the tests pin down:
//   1. If a quote is loaded in the form, saving UPDATES it, even if ?quote= is gone.
//   2. A create never sends id / quoteNumber / created_at (the database assigns them).
//   3. Every part of an update reports success/failure so a partial save is never
//      reported as "Quote Updated" (the page then keeps the edits as a draft).
//   4. Drafts only show on the page they belong to.

/** Columns that must never be sent when inserting a brand-new quote. */
const NEW_QUOTE_STRIPPED_FIELDS = ["lineItems", "lineitems", "id", "quoteNumber", "created_at"];

/** The quote being edited: the ?quote= param, else the quote already loaded in the form. */
export function getActiveQuote(urlQuote, formData) {
  return urlQuote || formData?.quoteNumber || null;
}

/** The quotes-table row to save: form data minus identity columns, plus total + timestamp. */
export function buildQuoteHeader(formData, lineItems, nowIso = new Date().toISOString()) {
  const header = { ...formData };
  for (const key of NEW_QUOTE_STRIPPED_FIELDS) delete header[key];
  return {
    ...header,
    updated_at: nowIso,
    quoteTotal: (lineItems || []).reduce((acc, item) => acc + Number(item.totalCost || 0), 0),
  };
}

/** Drafts that belong to this page: this quote's, or (on a blank page) new-quote ones. */
export function visibleDrafts(drafts, urlQuote) {
  return (drafts || []).filter((d) => (d.quoteNumber || null) === (urlQuote || null));
}

/**
 * Save changes to an existing quote. Runs the four steps in order and returns one boolean
 * per step: [header, existing lines, new lines, deleted lines]. `false` = that step failed.
 * `prepareLine(item)` turns a page line into a lineItems-table row (field filter + defaults).
 */
export async function saveQuoteChanges({
  supabase,
  quoteNumber,
  submitForm,
  lineItems = [],
  lineItemsToDelete = [],
  prepareLine = (x) => x,
  log = () => {},
}) {
  const results = [];

  // 1. header: send only the fields that changed
  {
    const { data: current, error: fetchError } = await supabase
      .from("quotes")
      .select("*")
      .eq("quoteNumber", quoteNumber)
      .single();
    if (fetchError || !current) {
      log("Error fetching current quote:", fetchError);
      results.push(false);
    } else {
      const changed = Object.keys(submitForm).reduce((acc, key) => {
        if (submitForm[key] !== current[key]) acc[key] = submitForm[key];
        return acc;
      }, {});
      if (Object.keys(changed).length === 0) {
        results.push(true);
      } else {
        const { error } = await supabase.from("quotes").update(changed).eq("quoteNumber", quoteNumber).select();
        if (error) log("Error updating quote:", error);
        results.push(!error);
      }
    }
  }

  // 2. existing lines: upsert by id
  {
    const rows = lineItems
      .filter((l) => l.id)
      .map((l) => ({ ...prepareLine(l), quoteNumber }));
    if (rows.length === 0) {
      results.push(true);
    } else {
      const { error } = await supabase.from("lineItems").upsert(rows, { onConflict: "id" });
      if (error) log("Error updating lines:", error);
      results.push(!error);
    }
  }

  // 3. new lines (no id yet): insert
  {
    const rows = lineItems
      .filter((l) => !l.id)
      .map((l) => ({ ...prepareLine(l), quoteNumber }));
    if (rows.length === 0) {
      results.push(true);
    } else {
      const { error } = await supabase.from("lineItems").insert(rows);
      if (error) log("Error adding lines:", error);
      results.push(!error);
    }
  }

  // 4. lines removed on the page
  if (lineItemsToDelete.length === 0) {
    results.push(true);
  } else {
    const { error } = await supabase.from("lineItems").delete().in("id", lineItemsToDelete);
    if (error) log("Error deleting lines:", error);
    results.push(!error);
  }

  return results;
}

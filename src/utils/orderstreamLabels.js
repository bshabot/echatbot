// Labels for OrderStream (Signet / Banter.com / Zales e-comm) dropship orders.
// Uses the ups-ship edge function, preset zales_customer: ShipTo = the customer from the
// order, 3rd-party billed to Zales (Y81323), label shipper = SJIX Processing, no signature.
// Rules (see project notes): always real weight + dims (defaults would bill Signet 20 lb),
// test:true first, never label a PO twice, one box per customer with all their POs on the
// reference line, then ship-confirm on OrderStream (a later step).

import { createUpsLabels, loadJsPdf, gifToLandscapePng } from "./upsLabels";

// Packaging by product type. Only rings are known: single ring = 1 lb, 6x4x2.
// Anything else is refused so nothing is billed on a guessed weight.
const RING_BOX = { weightLbs: 1, dims: { l: 6, w: 4, h: 2 } };
export function packagingFor(items) {
  const rings = items.filter((i) => /\dR-/.test(i.vendor_sku || "") || /\bring\b/i.test(i.description || ""));
  if (rings.length !== items.length) {
    const odd = items.filter((i) => !rings.includes(i)).map((i) => i.vendor_sku).join(", ");
    throw new Error(`No packaging rule for ${odd} (only rings are set up). Add weight and box size first.`);
  }
  const qty = items.reduce((n, i) => n + (Number(i.qty) || 1), 0);
  // one ring = 1 lb; extra rings in the same box add 0.25 lb each
  return { weightLbs: +(RING_BOX.weightLbs + 0.25 * (qty - 1)).toFixed(2), dims: RING_BOX.dims };
}

export function customerShipTo(job) {
  const s = job.ship_to || {};
  const lines = Array.isArray(s.lines) ? s.lines : [];
  if (!s.name || !lines[0] || !s.city || !s.state || !s.zip) {
    throw new Error(`PO ${job.po_number}: ship-to not fully parsed (need name, street, city, state, zip)`);
  }
  return { name: s.name, address1: lines[0], address2: lines.slice(1).join(" ") || undefined, city: s.city, state: s.state, zip: s.zip, residential: true };
}

const groupKey = (j) => {
  const s = j.ship_to || {};
  return [s.name, ...(s.lines || []), s.city, s.state, s.zip].join("|").toLowerCase();
};

// "B2742R-GP/9" -> "9", "B2744R-GP/7-DS" -> "7"
export const ringSizeOf = (sku) => (String(sku || "").match(/\/(\d+(?:\.\d+)?)/) || [])[1] || "";

// Same customer + address = one box. Returns [{ jobs, shipTo, items, pos }]
export function planBoxes(jobs) {
  const groups = new Map();
  for (const j of jobs) {
    if (j.problems?.length) throw new Error(`PO ${j.po_number} has parse problems: ${j.problems.join("; ")}`);
    const k = groupKey(j);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(j);
  }
  return [...groups.values()].map((js) => {
    const items = js.flatMap((j) => (j.items || []).map((i) => ({ ...i, po: j.po_number })));
    const pos = [...new Set(js.map((j) => j.po_number))];
    return { jobs: js, shipTo: customerShipTo(js[0]), items, pos, ...packagingFor(items) };
  });
}

// Refuse a PO that already has a live (non-voided) label.
export async function findExistingLabels(supabase, pos) {
  const hits = [];
  for (const po of pos) {
    const { data, error } = await supabase
      .from("ups_labels")
      .select("tracking, zales_po")
      .ilike("zales_po", `%${po}%`)
      .is("voided_at", null)
      .limit(1);
    if (error) throw new Error("duplicate check failed: " + error.message);
    if (data?.length) hits.push({ po, tracking: data[0].tracking });
  }
  return hits;
}

// Create labels for the given dropship_jobs rows.
//   test:true  -> UPS sandbox, fake labels, nothing stored, jobs untouched
//   test:false -> real labels; each job becomes status "labeled" with its tracking number
// Returns { test, boxes: [{ shipTo, pos, items, tracking, labelB64, jobs }], jobUpdateErrors }
export async function createOrderLabels(supabase, jobs, { test = true } = {}) {
  const plan = planBoxes(jobs);

  // fresh status check so a stale screen can't relabel an order
  const { data: fresh, error: fe } = await supabase
    .from("dropship_jobs")
    .select("order_id,status")
    .in("order_id", jobs.map((j) => j.order_id));
  if (fe) throw new Error(fe.message);
  const bad = (fresh || []).filter((r) => !["new", "error"].includes(r.status));
  if (bad.length) throw new Error(`Already processed: ${bad.map((b) => `${b.order_id} (${b.status})`).join(", ")}. Refresh the page.`);

  if (!test) {
    const dupes = await findExistingLabels(supabase, plan.flatMap((p) => p.pos));
    if (dupes.length) throw new Error(`Label already exists: ${dupes.map((d) => `PO ${d.po} (${d.tracking})`).join(", ")}`);
  }

  const boxes = [];
  const jobUpdateErrors = [];
  for (const [idx, box] of plan.entries()) {
    const res = await createUpsLabels(supabase, {
      boxes: [{ boxNumber: idx + 1, zalesPo: box.pos.join(" "), weightLbs: box.weightLbs, dims: box.dims }],
      service: "03", // UPS Ground (OrderStream code UG)
      test,
      shipToPreset: "zales_customer",
      customerShipTo: box.shipTo,
    });
    const pkg = res.packages[0];
    const made = { ...box, tracking: pkg.tracking, labelB64: pkg.labelB64 };
    boxes.push(made);
    if (!test) {
      for (const j of box.jobs) {
        const { error } = await supabase
          .from("dropship_jobs")
          .update({ status: "labeled", tracking: pkg.tracking, ship_method: "UG", error: null, updated_at: new Date().toISOString() })
          .eq("order_id", j.order_id)
          .in("status", ["new", "error"]);
        if (error) jobUpdateErrors.push(`${j.order_id}: ${error.message}`);
      }
    }
  }
  return { test, boxes, jobUpdateErrors };
}

// Reprint source for orders already labeled: rebuild boxes from stored labels.
export async function boxesFromStored(supabase, jobs) {
  const trackings = [...new Set(jobs.map((j) => j.tracking).filter(Boolean))];
  const { data, error } = await supabase.from("ups_labels").select("tracking, label_b64").in("tracking", trackings).is("voided_at", null);
  if (error) throw new Error(error.message);
  const labels = Object.fromEntries((data || []).map((r) => [r.tracking, r.label_b64]));
  const byTracking = new Map();
  for (const j of jobs) if (j.tracking) byTracking.set(j.tracking, [...(byTracking.get(j.tracking) || []), j]);
  return [...byTracking.entries()].map(([tracking, js]) => ({
    jobs: js,
    shipTo: customerShipTo(js[0]),
    items: js.flatMap((j) => (j.items || []).map((i) => ({ ...i, po: j.po_number }))),
    pos: [...new Set(js.map((j) => j.po_number))],
    tracking,
    labelB64: labels[tracking] || null,
  }));
}

// Approved pack sheet: one letter page per box. Top = label at 6x4 in landscape with a dashed
// fold line under it; bottom = "ITEMS IN THIS BOX" table + pack-out checklist; footer = customer,
// tracking, PO(s), "no signature, no declared value". No billing account, no "Box x of y".
export async function packSheetPdf(boxes, filename = "OrderStream pack sheet.pdf") {
  const withLabel = boxes.filter((b) => b.labelB64);
  if (!withLabel.length) throw new Error("no label images to print");
  const jsPDF = await loadJsPdf();
  const doc = new jsPDF({ unit: "in", format: "letter", orientation: "portrait" });
  for (let n = 0; n < withLabel.length; n++) {
    const b = withLabel[n];
    if (n > 0) doc.addPage("letter", "portrait");
    const png = await gifToLandscapePng(b.labelB64);
    doc.addImage(png, "PNG", 1.25, 0.35, 6, 4);

    doc.setDrawColor(150);
    doc.setLineDashPattern([0.08, 0.06], 0);
    doc.line(0.4, 4.6, 8.1, 4.6);
    doc.setLineDashPattern([], 0);

    doc.setFont("helvetica", "bold");
    doc.setFontSize(12);
    doc.setTextColor(0);
    doc.text("ITEMS IN THIS BOX", 0.5, 4.95);

    // table
    const cols = [
      ["PO", 0.5], ["QTY", 1.45], ["ITEM NO", 1.95], ["SKU", 3.05], ["DESCRIPTION", 4.75], ["RING SIZE", 7.3],
    ];
    let y = 5.25;
    doc.setFontSize(8);
    doc.setTextColor(110);
    cols.forEach(([h, x]) => doc.text(h, x, y));
    doc.setDrawColor(200);
    doc.line(0.5, y + 0.06, 8.0, y + 0.06);
    y += 0.28;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.setTextColor(0);
    for (const it of b.items.slice(0, 8)) {
      const row = [String(it.po || ""), String(it.qty ?? ""), String(it.merchant_sku || ""), String(it.vendor_sku || ""), "", ringSizeOf(it.vendor_sku)];
      cols.forEach(([, x], i) => i !== 4 && doc.text(row[i], x, y));
      const desc = doc.splitTextToSize(String(it.description || ""), 2.45);
      doc.text(desc.slice(0, 2), cols[4][1], y);
      y += 0.18 * Math.max(1, Math.min(2, desc.length)) + 0.1;
    }

    // pack-out checklist
    y = Math.max(y + 0.2, 7.3);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);
    doc.setTextColor(110);
    doc.text("PACK-OUT CHECK", 0.5, y);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.setTextColor(0);
    ["Item matches SKU and ring size", "Piece clean, stones secure, no defects", "Packed in pouch and box, no prices or invoice inside", "Label applied, old labels covered"]
      .forEach((t, i) => {
        doc.rect(0.5, y + 0.15 + i * 0.27 - 0.1, 0.13, 0.13);
        doc.text(t, 0.75, y + 0.15 + i * 0.27);
      });

    // footer
    doc.setDrawColor(200);
    doc.line(0.5, 10.1, 8.0, 10.1);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.text(String(b.shipTo.name || ""), 0.5, 10.4);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.text(`Tracking ${b.tracking}   PO ${b.pos.join(", ")}`, 0.5, 10.62);
    doc.setTextColor(110);
    doc.text("No signature. No declared value.", 8.0, 10.62, { align: "right" });
  }
  doc.save(filename);
}

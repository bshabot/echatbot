// Labels for OrderStream (Signet / Banter.com / Zales e-comm) dropship orders.
// Port of zales_labels.py (the tested reference) to the PLM. Same rules:
//  - ups-ship preset zales_customer (3rd-party bill Zales Y81323, shipper SJIX Akron, no
//    signature, no declared value, residential), customer from the order's SHIP TO
//  - one carton per customer, all their POs on the reference line ("8403049, 8403050")
//  - sandbox (test:true) for EVERY box first; if any box fails, nothing live is created
//  - explicit confirmation before live; never default weight/box (unknown type = error)
//  - never label a PO twice (ups_labels check)
//  - pack sheet: label top half 6x4 in (left 1200x800 px of the UPS GIF), items bottom half

import { createUpsLabels, loadJsPdf } from "./upsLabels";

export const SERVICES = [
  { code: "03", label: "UPS Ground", osCode: "UG" },
  { code: "13", label: "Next Day Air Saver", osCode: "UPSN_PM" },
  { code: "01", label: "Next Day Air", osCode: "UR" },
];
export const osShipMethod = (code) => SERVICES.find((s) => s.code === code)?.osCode || "UG";

// Weight / box by item type. Unknown types throw: never fall back to the server's 20 lb default.
// Ring is from the SOP. Pendant and necklace are carried over from the reference script and are
// UNCONFIRMED (confirmed:false shows a warning before any live purchase).
export const PACKING = {
  ring: { weightLbs: 1, dims: { l: 6, w: 4, h: 2 }, confirmed: true },
  pendant: { weightLbs: 1, dims: { l: 6, w: 4, h: 2 }, confirmed: false },
  necklace: { weightLbs: 1, dims: { l: 6, w: 4, h: 2 }, confirmed: false },
};

function kindOf(item) {
  const d = String(item.description || "").toLowerCase();
  const k = Object.keys(PACKING).find((x) => d.includes(x));
  if (k) return k;
  if (/\dR-/.test(item.vendor_sku || "")) return "ring"; // style numbers like B2742R-GP/9
  return null;
}

// Heaviest item decides the box (same as the reference).
export function packagingFor(items) {
  let best = null;
  let unconfirmed = false;
  for (const it of items) {
    const kind = kindOf(it);
    if (!kind) {
      throw new Error(`No weight/box defined for ${it.vendor_sku} (${it.description}). Add it to PACKING, never let ups-ship default to 20 lbs.`);
    }
    if (!PACKING[kind].confirmed) unconfirmed = true;
    if (!best || PACKING[kind].weightLbs > best.weightLbs) best = PACKING[kind];
  }
  return { weightLbs: best.weightLbs, dims: best.dims, unconfirmed };
}

export function customerShipTo(job) {
  const s = job.ship_to || {};
  const lines = Array.isArray(s.lines) ? s.lines : [];
  if (!s.name || !lines[0] || !s.city || !s.state || !s.zip) {
    throw new Error(`PO ${job.po_number}: ship-to not fully parsed (need name, street, city, state, zip)`);
  }
  return {
    name: s.name,
    address1: lines[0],
    address2: lines.slice(1).join(" ") || "", // "Apt 210" stays in address2
    city: s.city,
    state: s.state,
    zip: s.zip,
    residential: true,
  };
}

const groupKey = (j) => {
  const s = j.ship_to || {};
  const [a1, ...rest] = s.lines || [];
  return [s.name, a1, rest.join(" "), String(s.zip || "").slice(0, 5)].join("|").toLowerCase();
};

// "B2742R-GP/9" -> "9", "B2744R-GP/7-DS" -> "7"
export const ringSizeOf = (sku) => (String(sku || "").match(/\/(\d+(?:\.\d+)?)/) || [])[1] || "";

// Same customer + address = one box. Returns [{ jobs, shipTo, items, pos, weightLbs, dims, unconfirmed }]
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
    const pos = [...new Set(js.map((j) => j.po_number))].sort();
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

const upsBox = (box, idx) => ({
  boxNumber: idx + 1,
  zalesPo: box.pos.join(", "), // reference line carries every PO in the carton
  weightLbs: box.weightLbs,
  dims: box.dims,
});

// Step 1 of every run: sandbox every box. Any failure throws and nothing live is created.
export async function sandboxCheck(supabase, plan, service = "03") {
  for (const [idx, box] of plan.entries()) {
    try {
      await createUpsLabels(supabase, { boxes: [upsBox(box, idx)], service, test: true, shipToPreset: "zales_customer", customerShipTo: box.shipTo });
    } catch (e) {
      throw new Error(`Sandbox failed for PO ${box.pos.join(", ")}: ${e.message}`);
    }
  }
}

// Create labels for planned boxes.
//   test:true  -> UPS sandbox, fake labels, nothing stored, jobs untouched
//   test:false -> real labels; each job becomes "labeled" with its tracking number.
//                 Caller must have run sandboxCheck and got an explicit yes first.
export async function createOrderLabels(supabase, plan, { test = true, service = "03" } = {}) {
  const jobs = plan.flatMap((p) => p.jobs);
  const { data: fresh, error: fe } = await supabase.from("dropship_jobs").select("order_id,status").in("order_id", jobs.map((j) => j.order_id));
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
      boxes: [upsBox(box, idx)],
      service,
      test,
      shipToPreset: "zales_customer",
      customerShipTo: box.shipTo,
    });
    const pkg = res.packages[0];
    boxes.push({ ...box, tracking: pkg.tracking, labelB64: pkg.labelB64, shipmentId: res.shipmentId });
    if (!test) {
      for (const j of box.jobs) {
        const { error } = await supabase
          .from("dropship_jobs")
          .update({ status: "labeled", tracking: pkg.tracking, ship_method: osShipMethod(service), error: null, updated_at: new Date().toISOString() })
          .eq("order_id", j.order_id)
          .in("status", ["new", "error"]);
        if (error) jobUpdateErrors.push(`${j.order_id}: ${error.message}`);
      }
    }
  }
  return { test, boxes, jobUpdateErrors };
}

// Reprint source for orders already labeled: rebuild boxes from stored labels (same PO set = one box).
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
    pos: [...new Set(js.map((j) => j.po_number))].sort(),
    tracking,
    labelB64: labels[tracking] || null,
  }));
}

// UPS returns a 1400x800 landscape GIF; the real 4x6 label is the left 1200x800 (6in x 4in at 200 dpi).
async function labelPng(b64) {
  const img = new Image();
  img.src = "data:image/gif;base64," + b64;
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = 1200;
  canvas.height = 800;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, 1200, 800);
  if (img.height > img.width) {
    // portrait (not expected): rotate to landscape first
    ctx.translate(1200, 0);
    ctx.rotate(Math.PI / 2);
    ctx.drawImage(img, 0, 0, 800, 1200);
  } else {
    ctx.drawImage(img, 0, 0, 1200, 800, 0, 0, 1200, 800); // crop: left 1200x800 only
  }
  return canvas.toDataURL("image/png");
}

// Pack sheet, ported 1:1 from zales_labels.py build_pack_sheets (points, letter, one page per box).
// Never shows prices, the billing account or "Box x of y".
export async function packSheetPdf(boxes, filename = "Zales dropship pack sheets.pdf") {
  const withLabel = boxes.filter((b) => b.labelB64);
  if (!withLabel.length) throw new Error("no label images to print");
  const jsPDF = await loadJsPdf();
  const doc = new jsPDF({ unit: "pt", format: "letter", orientation: "portrait" });
  doc.setProperties({ title: "Zales dropship pack sheets" });
  const PW = 612, PH = 792, M = 36, half = PH / 2;
  const Y = (y) => PH - y; // reportlab y (from bottom) -> jsPDF y (from top)
  const gray = (g) => doc.setTextColor(g * 255, g * 255, g * 255);

  for (let n = 0; n < withLabel.length; n++) {
    const r = withLabel[n];
    if (n > 0) doc.addPage("letter", "portrait");

    // TOP HALF: label exactly 6in x 4in
    const lw = 6 * 72, lh = 4 * 72;
    doc.addImage(await labelPng(r.labelB64), "PNG", M, M, lw, lh);
    doc.setDrawColor(153).setLineWidth(0.5);
    doc.rect(M, M, lw, lh);
    doc.setLineDashPattern([4, 3], 0);
    doc.line(M, half, PW - M, half);
    doc.setLineDashPattern([], 0);
    doc.setFont("helvetica", "normal").setFontSize(7);
    gray(0.5);
    doc.text("fold / cut", M, half - 3);

    // BOTTOM HALF: items
    let y = half - 30;
    doc.setTextColor(0, 0, 0).setFont("helvetica", "bold").setFontSize(14);
    doc.text("ITEMS IN THIS BOX", M, Y(y));
    y -= 26;
    const cols = [["PO", M], ["QTY", M + 78], ["ITEM NO", M + 112], ["SKU", M + 225], ["DESCRIPTION", M + 285], ["SIZE", PW - M - 34]];
    doc.setFont("helvetica", "bold").setFontSize(8);
    gray(0.35);
    cols.forEach(([t, x]) => doc.text(t, x, Y(y)));
    y -= 6;
    doc.setDrawColor(0).line(M, Y(y), PW - M, Y(y));
    doc.setTextColor(0, 0, 0);
    for (const it of r.items) {
      y -= 20;
      doc.setFont("helvetica", "bold").setFontSize(11).text(String(it.po || ""), M, Y(y));
      doc.setFont("helvetica", "normal").setFontSize(11).text(String(it.qty ?? ""), M + 78, Y(y));
      doc.setFontSize(9.5).text(String(it.vendor_sku || ""), M + 112, Y(y)); // ITEM NO = our style number
      doc.setFontSize(11).text(String(it.merchant_sku || ""), M + 225, Y(y)); // SKU = Signet 8-digit
      doc.setFontSize(8.5).text(String(it.description || "").slice(0, 38), M + 285, Y(y));
      doc.setFont("helvetica", "bold").setFontSize(11).text(ringSizeOf(it.vendor_sku) || "-", PW - M - 34, Y(y));
      y -= 6;
      doc.setDrawColor(204).line(M, Y(y), PW - M, Y(y));
      doc.setDrawColor(0);
    }
    y = 140;
    doc.setFont("helvetica", "bold").setFontSize(9).setTextColor(0, 0, 0).text("BEFORE IT GOES OUT", M, Y(y));
    doc.setFont("helvetica", "normal").setFontSize(9);
    [
      "[  ] Piece in Signet-branded box, then courier box with Zales packing slip and butcher paper or bubble wrap",
      "[  ] No poly bags. No Zales, Signet or jewelry text on the outside",
      "[  ] Label on box at 4x6, reads BILLING: 3RD PARTY, PO on the reference line",
      "[  ] UPS pickup (Mon to Fri), then Confirm Shipment in OrderStream for each PO",
    ].forEach((line) => {
      y -= 14;
      doc.text(line, M, Y(y));
    });

    // FOOTER: customer, tracking, PO(s), signature note
    doc.setDrawColor(153).line(M, Y(70), PW - M, Y(70));
    doc.setTextColor(0, 0, 0).setFont("helvetica", "bold").setFontSize(12).text(String(r.shipTo.name || ""), M, Y(54));
    doc.setFont("courier", "bold").setFontSize(10).text(String(r.tracking || ""), M + 190, Y(54));
    doc.setFont("helvetica", "normal").setFontSize(9);
    gray(0.3);
    doc.text(`PO ${r.pos.join(", ")}   |   no signature, no declared value`, M, Y(40));
  }
  doc.save(filename);
}

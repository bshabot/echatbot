// ── UPS label creation (7/30/26) ────────────────────────────────────────────
// Talks to the ups-ship edge function: create = one UPS shipment for the
// whole batch (every box its own package + tracking + label, billed to the
// customer's UPS account — Zales Y814R1), void = cancel by shipment id.
// Labels come back as base64 GIFs; we rotate to portrait and stack them into
// one 4x6 PDF via jspdf (dynamic import — keeps the page bundle light).
// Created labels are stored server-side in ups_labels for reprints.

export async function createUpsLabels(supabase, { boxes, service = "02", test = false, shipToPreset = "zales", attention }) {
  const { data, error } = await supabase.functions.invoke("ups-ship", {
    body: { action: "create", boxes, service, test, shipToPreset, ...(attention ? { attention } : {}) },
  });
  if (error) throw new Error(error.message || "ups-ship failed");
  if (data?.error) throw new Error(data.error);
  if (!data?.packages?.length) throw new Error("UPS returned no packages");
  return data; // { shipmentId, packages: [{boxNumber, tracking, labelB64, ...}] }
}

// One-click buyer sample (Brian 7/30): Texoma sample room, 8×3×6 in, 1 lb,
// 2nd Day Air, ATTN = the buyer's name. Creates the label AND downloads the
// PDF in one shot.
export async function createSampleLabel(supabase, buyer) {
  const res = await createUpsLabels(supabase, {
    boxes: [{ boxNumber: 1, zalesPo: "SAMPLES", invoiceNumber: "", weightLbs: 1, dims: { l: 8, w: 3, h: 6 } }],
    service: "02",
    shipToPreset: "texoma",
    attention: buyer,
  });
  const safe = String(buyer).replace(/[^\w -]/g, "").trim() || "buyer";
  await labelsPdf(res.packages, `UPS sample label ${safe}.pdf`);
  return res;
}

export async function voidUpsShipment(supabase, shipmentId, test = false) {
  const { data, error } = await supabase.functions.invoke("ups-ship", {
    body: { action: "void", shipmentId, test },
  });
  if (error) throw new Error(error.message || "ups-ship void failed");
  if (data?.error) throw new Error(data.error);
  return data;
}

// Stored labels for a set of tracking numbers (reprint path).
export async function fetchStoredLabels(supabase, trackings) {
  const nums = [...new Set((trackings || []).map((t) => String(t || "").trim().toUpperCase()).filter(Boolean))];
  if (!nums.length) return [];
  const { data, error } = await supabase
    .from("ups_labels")
    .select("tracking, box_number, zales_po, invoice_number, label_b64, voided_at")
    .in("tracking", nums)
    .is("voided_at", null)
    .order("box_number", { ascending: true });
  if (error) throw new Error(error.message);
  return (data || []).map((r) => ({
    boxNumber: r.box_number,
    tracking: r.tracking,
    zalesPo: r.zales_po,
    invoiceNumber: r.invoice_number,
    labelB64: r.label_b64,
  }));
}

// Browsers decode GIF natively, jspdf doesn't — draw to a canvas and hand
// jspdf a PNG. Kept LANDSCAPE (UPS renders labels that way natively); rotate
// only if one ever arrives portrait.
async function gifToLandscapePng(b64) {
  const img = new Image();
  img.src = "data:image/gif;base64," + b64;
  await img.decode();
  const rotate = img.height > img.width;
  const canvas = document.createElement("canvas");
  canvas.width = rotate ? img.height : img.width;
  canvas.height = rotate ? img.width : img.height;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (rotate) {
    ctx.translate(canvas.width, 0);
    ctx.rotate(Math.PI / 2);
  }
  ctx.drawImage(img, 0, 0);
  return canvas.toDataURL("image/png");
}

// UPS-style half-page printout (Brian 7/30): the label fills the TOP half of
// a regular letter sheet; the BOTTOM half carries the shipment info (invoice
// biggest, then Zales PO, then vendor PO) so a folded sheet shows the label
// on one face and the info on the other. One label per page.
export async function labelsPdf(packages, filename = "UPS labels.pdf") {
  const withLabels = (packages || []).filter((p) => p.labelB64);
  if (!withLabels.length) throw new Error("no label images");
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({ unit: "in", format: "letter", orientation: "portrait" });
  // 6×4 landscape label scaled to fill the 8.5×5.5 top half (small margin)
  const M = 0.2;
  const s = Math.min((8.5 - 2 * M) / 6, (5.5 - 2 * M) / 4);
  const w = 6 * s;
  const h = 4 * s;
  const x = (8.5 - w) / 2;
  const y = (5.5 - h) / 2;
  // Multi-box POs get a "1/2, 2/2" note on the info side
  const totals = {};
  for (const p of withLabels) {
    if (p.vendorPo) totals[p.vendorPo] = (totals[p.vendorPo] || 0) + 1;
  }
  const seen = {};
  for (let i = 0; i < withLabels.length; i++) {
    const p = withLabels[i];
    if (i > 0) doc.addPage("letter", "portrait");
    const png = await gifToLandscapePng(p.labelB64);
    doc.addImage(png, "PNG", x, y, w, h);
    doc.setDrawColor(180, 180, 180);
    doc.line(0.4, 5.5, 8.1, 5.5); // fold line at the page's middle
    // Info side — invoice + Zales PO captioned, vendor PO bare (Brian 7/30).
    // When the same number is both (no SO linked), it prints once.
    const t = p.vendorPo ? totals[p.vendorPo] : 0;
    const idx = p.vendorPo ? (seen[p.vendorPo] = (seen[p.vendorPo] || 0) + 1) : 0;
    const boxNote = t > 1 ? `  ${idx}/${t}` : "";
    const samePo = p.vendorPo && String(p.zalesPo || "") === String(p.vendorPo);
    const rows = [
      p.invoiceNumber ? ["INVOICE", String(p.invoiceNumber), 46] : null,
      p.zalesPo ? ["ZALES PO", String(p.zalesPo) + (samePo ? boxNote : ""), 30] : null,
      p.vendorPo && !samePo ? [null, String(p.vendorPo) + boxNote, 30] : null,
    ].filter(Boolean);
    let ty = 7.0;
    for (const [cap, val, size] of rows) {
      if (cap) {
        doc.setFont("helvetica", "normal");
        doc.setFontSize(13);
        doc.setTextColor(130, 130, 130);
        doc.text(cap, 4.25, ty, { align: "center" });
      }
      doc.setFont("helvetica", "bold");
      doc.setFontSize(size);
      doc.setTextColor(0, 0, 0);
      doc.text(val, 4.25, ty + (size >= 40 ? 0.75 : 0.55), { align: "center" });
      ty += size >= 40 ? 1.6 : 1.3;
    }
  }
  doc.save(filename);
}

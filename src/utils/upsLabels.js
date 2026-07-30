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
    labelB64: r.label_b64,
  }));
}

// UPS GIFs are landscape; browsers decode GIF natively, jspdf doesn't —
// draw to a canvas (rotating to portrait) and hand jspdf a PNG.
async function gifToPortraitPng(b64) {
  const img = new Image();
  img.src = "data:image/gif;base64," + b64;
  await img.decode();
  const rotate = img.width > img.height;
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

// One 4x6 page per label → download. Print at 100% on 4x6 stock or plain
// paper ("actual size").
export async function labelsPdf(packages, filename = "UPS labels.pdf") {
  const withLabels = (packages || []).filter((p) => p.labelB64);
  if (!withLabels.length) throw new Error("no label images");
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({ unit: "in", format: [4, 6], orientation: "portrait" });
  for (let i = 0; i < withLabels.length; i++) {
    if (i > 0) doc.addPage([4, 6], "portrait");
    const png = await gifToPortraitPng(withLabels[i].labelB64);
    doc.addImage(png, "PNG", 0, 0, 4, 6);
  }
  doc.save(filename);
}

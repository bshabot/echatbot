// shipmentDocs.js — warehouse manifest (PDF + Excel) and Titan pickup request (PDF).
// House style: white, minimal, clean premium. No images -> no canvas-taint concerns.

import html2pdf from "html2pdf.js";
import * as XLSX from "xlsx";

const fmtDate = (d) => {
  if (!d) return "—";
  const parts = String(d).slice(0, 10).split("-");
  if (parts.length !== 3) return String(d);
  return `${Number(parts[1])}/${Number(parts[2])}/${parts[0].slice(2)}`;
};

const dollar = (n) =>
  n == null ? "—" : Number(n).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

const esc = (s) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const BASE_CSS = `
  font-family: Arial, Helvetica, sans-serif; color:#111; background:#fff;
`;
const TABLE_CSS = `width:100%; border-collapse:collapse; font-size:12px;`;
const TH_CSS = `text-align:left; border-bottom:2px solid #111; padding:6px 8px; font-size:11px; letter-spacing:0.05em; text-transform:uppercase;`;
const TD_CSS = `border-bottom:1px solid #ddd; padding:6px 8px;`;

// boxes: [{ boxNumber, invoiceNumber, vendorPo, signetPo, tracking }]
// batch: { carrier, masterTracking, shippedDate, totalBoxes }
export function manifestHtml(batch, boxes) {
  const perBox = boxes.some((b) => b.tracking);
  const rows = boxes
    .map(
      (b) => `<tr>
        <td style="${TD_CSS} font-weight:bold;">${b.boxNumber} of ${batch.totalBoxes}</td>
        <td style="${TD_CSS} font-weight:bold; font-size:14px;">${esc(b.invoiceNumber || "—")}</td>
        <td style="${TD_CSS}">${esc(b.vendorPo)}</td>
        <td style="${TD_CSS}">${esc(b.signetPo)}</td>
        ${perBox ? `<td style="${TD_CSS}">${esc(b.tracking || batch.masterTracking || "—")}</td>` : ""}
      </tr>`
    )
    .join("");
  return `
  <div style="${BASE_CSS} padding:28px;">
    <div style="display:flex; justify-content:space-between; align-items:baseline; border-bottom:3px solid #111; padding-bottom:10px;">
      <div>
        <div style="font-size:22px; letter-spacing:0.12em; font-weight:bold;">E CHABOT</div>
        <div style="font-size:12px; color:#666;">Warehouse shipping manifest</div>
      </div>
      <div style="text-align:right; font-size:12px;">
        <div><b>${esc(batch.carrier)}</b>${batch.masterTracking ? " — " + esc(batch.masterTracking) : ""}</div>
        <div>${batch.totalBoxes} box${batch.totalBoxes === 1 ? "" : "es"} · ${fmtDate(batch.shippedDate)}</div>
      </div>
    </div>
    <table style="${TABLE_CSS} margin-top:14px;">
      <thead><tr>
        <th style="${TH_CSS}">Box</th>
        <th style="${TH_CSS}">Invoice # (on box)</th>
        <th style="${TH_CSS}">Vendor PO</th>
        <th style="${TH_CSS}">Sales Order</th>
        ${perBox ? `<th style="${TH_CSS}">Tracking</th>` : ""}
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

// request: { pickupDate, windowText, totalBoxes, declaredValue, reference }
export function pickupRequestHtml(request) {
  return `
  <div style="${BASE_CSS} padding:40px; font-size:14px; line-height:1.7;">
    <div style="font-size:22px; letter-spacing:0.12em; font-weight:bold;">E CHABOT LTD.</div>
    <div style="font-size:13px; color:#666; margin-bottom:26px;">Pickup request</div>
    <table style="font-size:14px; border-collapse:collapse;">
      <tr><td style="padding:4px 18px 4px 0; color:#666;">Pickup date</td><td style="padding:4px 0;"><b>${esc(fmtDate(request.pickupDate))}</b></td></tr>
      <tr><td style="padding:4px 18px 4px 0; color:#666;">Window</td><td style="padding:4px 0;"><b>${esc(request.windowText || "—")}</b></td></tr>
      <tr><td style="padding:4px 18px 4px 0; color:#666;">Boxes</td><td style="padding:4px 0;"><b>${request.totalBoxes}</b></td></tr>
      <tr><td style="padding:4px 18px 4px 0; color:#666;">Value</td><td style="padding:4px 0;"><b>${dollar(request.declaredValue)}</b></td></tr>
      ${request.reference ? `<tr><td style="padding:4px 18px 4px 0; color:#666;">Reference</td><td style="padding:4px 0;">${esc(request.reference)}</td></tr>` : ""}
    </table>
  </div>`;
}

async function htmlToPdf(html, filename) {
  const host = document.createElement("div");
  host.style.position = "fixed";
  host.style.left = "-10000px";
  host.style.top = "0";
  host.style.width = "800px";
  host.innerHTML = html;
  document.body.appendChild(host);
  try {
    await html2pdf()
      .set({
        filename,
        margin: 8,
        html2canvas: { scale: 2, allowTaint: false },
        jsPDF: { unit: "mm", format: "letter", orientation: "portrait" },
        pagebreak: { mode: ["avoid-all", "css"] },
      })
      .from(host)
      .save();
  } finally {
    document.body.removeChild(host);
  }
}

export async function downloadManifestPdf(batch, boxes) {
  const name = `manifest_${String(batch.shippedDate || "").slice(0, 10) || "today"}.pdf`;
  await htmlToPdf(manifestHtml(batch, boxes), name);
}

export async function downloadPickupRequestPdf(request) {
  const name = `titan_pickup_request_${String(request.pickupDate || "").slice(0, 10) || "today"}.pdf`;
  await htmlToPdf(pickupRequestHtml(request), name);
}

export function downloadManifestExcel(batch, boxes) {
  const rows = boxes.map((b) => ({
    Box: `${b.boxNumber} of ${batch.totalBoxes}`,
    "Invoice # (on box)": b.invoiceNumber || "",
    "Vendor PO": b.vendorPo,
    "Sales Order": b.signetPo,
    Carrier: batch.carrier,
    Tracking: b.tracking || batch.masterTracking || "",
    "Ship date": fmtDate(batch.shippedDate),
    "Checked off": "",
  }));
  const ws = XLSX.utils.json_to_sheet(rows);
  ws["!cols"] = [{ wch: 10 }, { wch: 18 }, { wch: 12 }, { wch: 12 }, { wch: 10 }, { wch: 24 }, { wch: 10 }, { wch: 12 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Manifest");
  XLSX.writeFile(wb, `manifest_${String(batch.shippedDate || "").slice(0, 10) || "today"}.xlsx`);
}

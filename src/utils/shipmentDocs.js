// shipmentDocs.js — warehouse manifest (PDF + Excel) and Titan pickup request (PDF).
// House style: white, minimal, clean premium. No images -> no canvas-taint concerns.
//
// Delivery (added 7/20): if a docs folder was picked (see docFolder.js — the
// OneDrive "Shipments manifests" folder), files write straight there and the
// functions resolve "folder". Otherwise a normal browser download, "download".
// Callers may pass a pre-resolved dir handle so the permission prompt happens
// at the very start of the click (before slow DB writes / PDF rendering).

import html2pdf from "html2pdf.js";
import * as XLSX from "xlsx";
import { getWritableDocFolder, writeToFolder } from "./docFolder";

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
  const anyNotes = boxes.some((b) => b.note);
  const rows = boxes
    .map(
      (b) => `<tr>
        <td style="${TD_CSS} font-weight:bold;">${b.boxNumber} of ${batch.totalBoxes}</td>
        <td style="${TD_CSS} font-weight:bold; font-size:14px;">${esc(b.invoiceNumber || "—")}</td>
        <td style="${TD_CSS}">${esc(b.vendorPo)}</td>
        <td style="${TD_CSS}">${esc(b.signetPo)}</td>
        ${perBox ? `<td style="${TD_CSS}">${esc(b.tracking || batch.masterTracking || "—")}</td>` : ""}
        ${anyNotes ? `<td style="${TD_CSS} font-size:11px; font-style:italic; color:#555;">${esc(b.note || "")}</td>` : ""}
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
        ${anyNotes ? `<th style="${TH_CSS}">Note</th>` : ""}
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

async function htmlToPdfBlob(html) {
  // html2canvas renders BLANK for position:fixed offscreen hosts, and shifts
  // content out of frame when the page is scrolled. Keep the host in normal
  // flow at the top of <body>, hidden by a zero-height overflow wrapper, and
  // pin the capture scroll to 0.
  const wrapper = document.createElement("div");
  wrapper.style.height = "0";
  wrapper.style.overflow = "hidden";
  const host = document.createElement("div");
  host.style.width = "800px";
  host.style.background = "#fff";
  host.innerHTML = html;
  wrapper.appendChild(host);
  document.body.prepend(wrapper);
  try {
    return await html2pdf()
      .set({
        margin: 8,
        html2canvas: { scale: 2, allowTaint: false, scrollY: 0, scrollX: 0, windowWidth: 900 },
        jsPDF: { unit: "mm", format: "letter", orientation: "portrait" },
        pagebreak: { mode: ["avoid-all", "css"] },
      })
      .from(host)
      .outputPdf("blob");
  } finally {
    document.body.removeChild(wrapper);
  }
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// Folder first, Downloads as the fallback. Returns "folder" | "download".
async function deliver(dir, blob, filename) {
  if (await writeToFolder(dir, filename, blob)) return "folder";
  triggerDownload(blob, filename);
  return "download";
}

// dirOpt: pass a pre-resolved handle (or null to force download); leave
// undefined to resolve here.
export async function downloadManifestPdf(batch, boxes, dirOpt) {
  const name = `manifest_${String(batch.shippedDate || "").slice(0, 10) || "today"}.pdf`;
  const dir = dirOpt !== undefined ? dirOpt : await getWritableDocFolder();
  const blob = await htmlToPdfBlob(manifestHtml(batch, boxes));
  return deliver(dir, blob, name);
}

export async function downloadPickupRequestPdf(request, dirOpt) {
  const name = `titan_pickup_request_${String(request.pickupDate || "").slice(0, 10) || "today"}.pdf`;
  const dir = dirOpt !== undefined ? dirOpt : await getWritableDocFolder();
  const blob = await htmlToPdfBlob(pickupRequestHtml(request));
  return deliver(dir, blob, name);
}

export async function downloadManifestExcel(batch, boxes, dirOpt) {
  const rows = boxes.map((b) => ({
    Box: `${b.boxNumber} of ${batch.totalBoxes}`,
    "Invoice # (on box)": b.invoiceNumber || "",
    "Vendor PO": b.vendorPo,
    "Sales Order": b.signetPo,
    Carrier: batch.carrier,
    Tracking: b.tracking || batch.masterTracking || "",
    Note: b.note || "",
    "Ship date": fmtDate(batch.shippedDate),
    "Checked off": "",
  }));
  const ws = XLSX.utils.json_to_sheet(rows);
  ws["!cols"] = [{ wch: 10 }, { wch: 18 }, { wch: 12 }, { wch: 12 }, { wch: 10 }, { wch: 24 }, { wch: 30 }, { wch: 10 }, { wch: 12 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Manifest");
  const name = `manifest_${String(batch.shippedDate || "").slice(0, 10) || "today"}.xlsx`;
  const dir = dirOpt !== undefined ? dirOpt : await getWritableDocFolder();
  const arr = XLSX.write(wb, { bookType: "xlsx", type: "array" });
  const blob = new Blob([arr], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  return deliver(dir, blob, name);
}

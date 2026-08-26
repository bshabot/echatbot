// efwPickupSheet.js — EFW pickup sheet generator (replaces the Titan pickup doc)
// Drop into webapp/src/lib/. Requires: npm i docx file-saver (docx works in-browser via Packer.toBlob)
//
// Usage from the ship-out flow:
//   import { generateEfwPickupSheet } from "./lib/efwPickupSheet";
//   const blob = await generateEfwPickupSheet({
//     pickupDate:   batch.shipped_date,            // requested pickup date
//     dueDate:      earliestDueDate,               // optional; omit to leave blank
//     pickupWindow: batch.pickup_window,           // e.g. "11AM-2PM" — falls back to "3PM-5PM"
//     boxCount:     boxes.length,                  // outbound_boxes for the batch
//     declaredValue: batch.declared_value,
//     weightLbs:    null,                          // null → estimate: boxes*20 + 40 pallet
//     poNumbers:    [...new Set(contents.map(c => c.signet_po_number))],
//   });
//   saveAs(blob, `EFW PICKUP REQUEST ${fmtDate(batch.shipped_date).replace(/\//g, "-")}.docx`);
//
// Send the file to Signet@efwnow.com (EFW Signet ops desk). EFW replies with the BOL
// for the driver. Ops phone 404-891-1672 · tracking www.efwtrack.com

import {
  Document, Packer, Paragraph, TextRun, ImageRun, AlignmentType, UnderlineType, TabStopType,
} from "docx";

// Signet logo (216x86 png) — baked in so the doc matches the official sheet
import { SIGNET_LOGO_B64 } from "./signetLogo.js";

const COMPANY = {
  billToBrand: "Banter",
  construction: "No",
  expedite: "No",
  shipperType: "Vendor",
  company: "E. Chabot LTD",
  pickupCompany: "E. Chabot LTD",
  pickupAddress: "195 Carter Drive, Unit 2R",
  pickupCityStateZip: "Edison, NJ 08817",
  phone: "212-575-1026",
  contacts: "Esther Hammer, Ketty Shabot, Brian Shabot, Ezra Shabot",
  appointment: "No",
  receiverType: "Distribution",
  deliveryTo: "Signet Jewelers - Banter by Piercing Pagoda",
  deliveryAddress: "375 Ghent Rd",
  deliveryCityStateZip: "Akron, OH 44333",
  deliveryPhone: "330-665-5000",
  brandStore: "Banter by Piercing Pagoda",
  product: "Jewelry",
  palletDims: '48" x 40" x 48" (standard)',
};

export function fmtDate(d) {
  if (!d) return "";
  const dt = typeof d === "string" ? new Date(d + "T00:00:00") : d;
  return `${dt.getMonth() + 1}/${dt.getDate()}/${dt.getFullYear()}`;
}

const fmtMoney = (n) =>
  n == null ? "" : "$" + Math.round(Number(n)).toLocaleString("en-US");

const line = (label, value = "") =>
  new Paragraph({
    children: [new TextRun({ text: `${label} ${value}`.trimEnd(), size: 22 })], // 11pt
    spacing: { after: 40 },
  });

const twoCol = (l1, v1, l2, v2) =>
  new Paragraph({
    tabStops: [{ type: TabStopType.LEFT, position: 4320 }], // 3" — second column
    children: [
      new TextRun({ text: `${l1} ${v1}`.trimEnd(), size: 22 }),
      new TextRun({ text: `\t${l2} ${v2}`.trimEnd(), size: 22 }),
    ],
    spacing: { after: 40 },
  });

const blank = () => new Paragraph({ spacing: { after: 40 } });

export async function generateEfwPickupSheet({
  todayDate = new Date(),
  pickupDate,
  dueDate = null,
  pickupWindow = "3PM-5PM",
  boxCount,
  declaredValue,
  weightLbs = null,
  poNumbers = [],
}) {
  const weight = weightLbs != null ? weightLbs : boxCount * 20 + 40; // 20 lbs/box + 40 lb pallet
  const logoBytes = Uint8Array.from(atob(SIGNET_LOGO_B64), (c) => c.charCodeAt(0));

  const doc = new Document({
    sections: [
      {
        page: { size: { width: 12240, height: 15840 } }, // US Letter
        children: [
          new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [
              new ImageRun({ type: "png", data: logoBytes, transformation: { width: 162, height: 64 } }),
            ],
            spacing: { after: 120 },
          }),
          new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [
              new TextRun({
                text: "PICKUP SHEET FOR SUPPLIERS/VENDORS",
                size: 24, bold: true, underline: { type: UnderlineType.SINGLE },
              }),
            ],
            spacing: { after: 200 },
          }),
          twoCol("Bill to Brand:", COMPANY.billToBrand, "Construction:", COMPANY.construction),
          twoCol("CLP Contact:", "", "Expedite Needed:", COMPANY.expedite),
          blank(),
          line("Shipper Type:", COMPANY.shipperType),
          line("Company’s Name:", COMPANY.company),
          line("Today’s Date:", fmtDate(todayDate)),
          line("Requested Pickup Date:", fmtDate(pickupDate)),
          line("Delivery Due Date:", fmtDate(dueDate)),
          line("PO:", poNumbers.join(", ")),
          line("Pickup Company Name:", COMPANY.pickupCompany),
          line("Pickup Address:", COMPANY.pickupAddress),
          line("Pickup City, State, and Zip:", COMPANY.pickupCityStateZip),
          line("Phone:", COMPANY.phone),
          line("Contact Name:", COMPANY.contacts),
          line("Hours:", pickupWindow),
          line("Appointment Required:", COMPANY.appointment),
          blank(),
          line("Receiver Type:", COMPANY.receiverType),
          line("Delivery to:", COMPANY.deliveryTo),
          line("Delivery Address:", COMPANY.deliveryAddress),
          line("Delivery City, State and Zip:", COMPANY.deliveryCityStateZip),
          line("Phone:", COMPANY.deliveryPhone),
          line("Brand and Store # Related to:", COMPANY.brandStore),
          blank(),
          line("Product:", COMPANY.product),
          line("Total # of Pallets:", "0"),
          line("Total # of Cases:", String(boxCount ?? "")),
          line("Dimensions of Pallets:", COMPANY.palletDims),
          line("Total Weight including Pallet:", weight ? `${weight} LBS` : ""),
          blank(),
          line("Special Instructions:", ""),
          blank(),
          line("Value of Shipment (Must be provided):", fmtMoney(declaredValue)),
          blank(),
          new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [new TextRun({ text: "This form must be filled out, or it will be sent back.", size: 22 })],
            spacing: { after: 120 },
          }),
          new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [new TextRun({ text: "EFW will send a BOL to be given to the driver.", size: 22 })],
          }),
        ],
      },
    ],
  });

  return Packer.toBlob(doc);
}

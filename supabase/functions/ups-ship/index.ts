// ups-ship — create + void UPS labels for outbound shipments.
// Signet NA Vendor Shipping Guide v2026.3 (eff 3/1/2026) compliance:
// 3rd-party billing to Signet accounts only, DC-code ship-tos, signature on
// DC parcels (never adult — Section E lists adult signature as a chargeback),
// no declared value, 70lb/130" caps.
// Flows: zales (#8407 Akron DC) · texoma (samples, SJI Coppell TX,
// attention=buyer — 2026 Section B puts Coppell under Y814R1) ·
// zales_customer (Banter.com / Zales e-comm drop ship: dynamic customer
// ShipTo, label shipper address = SJIX Processing Akron per Section F #4,
// bill Y81323 per Section F #1, NO signature on residential) ·
// custom (v7: samples to an arbitrary address — dynamic ShipTo, bill Y814R1;
// NOTE an arbitrary address is neither the Akron DC nor SJI Coppell, so this
// preset's account may not be guide-correct — confirm with Signet transportation) ·
// custom_own (v8: same as custom but billed to OUR account 71A562, signature
// REQUIRED by default, optional declaredValue. Use for non-Signet sends where
// we eat the freight. NOTE: UPS tariff caps jewelry declared value at $500/pkg
// — declaring more buys fees, not coverage.)
// v10 (9/2/26, Brian): UPS renders the SHIPPER block on the label, not
// ShipFrom — the sandbox proved it. A preset's overridden address now goes
// into Shipper so Section F #4 ("the shipper address that must appear on the
// UPS label is SJIX Processing 375 Ghent Rd Akron OH 44333") is actually met.
// ShipFrom is pinned to the physical Edison origin so UPS rates and scans the
// real pickup point.
// v12 (11/2/26): hardening per ZALES_LABELS_SPEC.md —
//   1. a real signed-in user is required (supa.auth.getUser on the request JWT);
//      the public anon key no longer works. Optional allow-list: secret
//      UPS_SHIP_ALLOWED_EMAILS (comma separated); unset = any signed-in user.
//   2. zales_customer inputs are validated server side: weight, all three
//      dimensions, PO and a complete address are required (never defaulted),
//      service only 03/13/01, no declared value, no signature options,
//      residential forced on.
//   3. zales_customer live labels refuse a PO that already has a live label.
// test:true → UPS CIE sandbox (fake labels, nothing stored).
import { createClient } from "npm:@supabase/supabase-js@2";

const supa = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

class HttpError extends Error {
  status: number;
  constructor(status: number, msg: string) {
    super(msg);
    this.status = status;
  }
}

const PROD = "https://onlinetools.ups.com";
const CIE = "https://wwwcie.ups.com";
const SHIPPER_NUMBER = "71A562";

// Physical origin = Edison warehouse (same place EFW picks up).
const SHIP_FROM = {
  Name: "E Chabot Ltd",
  AttentionName: "Shipping Dept",
  Phone: { Number: "2125751026" },
  Address: {
    AddressLine: ["195 Carter Drive", "Unit 2R"],
    City: "Edison",
    StateProvinceCode: "NJ",
    PostalCode: "08817",
    CountryCode: "US",
  },
};

// Guide Section F #4: customer shipments must show SJIX Processing as the
// shipper address on the label (customer never sees the vendor; returns route
// to Signet).
const SJIX_FROM = {
  Name: "SJIX Processing",
  AttentionName: "SJIX Processing",
  Phone: { Number: "2125751026" },
  Address: {
    AddressLine: ["375 Ghent Rd"],
    City: "Akron",
    StateProvinceCode: "OH",
    PostalCode: "44333",
    CountryCode: "US",
  },
};

const BILL_DC = { AccountNumber: "Y814R1", Address: { PostalCode: "44333", CountryCode: "US" } };
const BILL_CUSTOMER = { AccountNumber: "Y81323", Address: { PostalCode: "44333", CountryCode: "US" } };

const PRESETS: Record<string, any> = {
  zales: {
    shipTo: {
      Name: "#8407",
      AttentionName: "8407",
      Address: {
        AddressLine: ["375 Ghent Rd"],
        City: "Akron",
        StateProvinceCode: "OH",
        PostalCode: "44333",
        CountryCode: "US",
      },
    },
    billThirdParty: BILL_DC,
  },
  texoma: {
    shipTo: {
      Name: "Texoma BNTR",
      AttentionName: "BNTR",
      Address: {
        AddressLine: ["9797 Rombauer Rd"],
        City: "Coppell",
        StateProvinceCode: "TX",
        PostalCode: "75019",
        CountryCode: "US",
      },
    },
    billThirdParty: BILL_DC,
  },
  zales_customer: {
    customer: true, // ShipTo comes from body.customerShipTo
    billThirdParty: BILL_CUSTOMER, // Y81323 — Section F #1
    shipperAddress: SJIX_FROM, // v10: this is what prints — Section F #4
    noSignature: true, // residential — signature would fail deliveries
  },
  custom: {
    customer: true, // ShipTo comes from body.customerShipTo
    billThirdParty: BILL_DC, // samples billing, same as texoma
    noSignature: true, // residential/personal address — signature would fail deliveries
  },
  // v8: our own freight, signature on, declared value allowed.
  custom_own: {
    customer: true,
    billShipper: true, // PaymentInformation → BillShipper 71A562
    allowDeclaredValue: true,
    // signature ON by default; pass noSignature:true in the body to turn it off
  },
};

// ── v12: who may call this ──────────────────────────────────────────────────
// verify_jwt lets the public anon key through, and that key ships in the PLM
// front end. Require a real signed-in user instead.
async function requireUser(req: Request) {
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) throw new HttpError(401, "sign in required");
  const { data, error } = await supa.auth.getUser(token);
  if (error || !data?.user) throw new HttpError(401, "sign in required (the public anon key is not accepted)");
  const allowed = (Deno.env.get("UPS_SHIP_ALLOWED_EMAILS") || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (allowed.length && !allowed.includes(String(data.user.email || "").toLowerCase())) {
    throw new HttpError(403, "this account is not allowed to create labels");
  }
  return data.user;
}

// ── v12: zales_customer input rules (spec: never default, never trust the caller) ──
const CUSTOMER_SERVICES = ["03", "13", "01"];
const PO_RE = /^[A-Za-z0-9-]{3,20}$/;

function poListOf(box: any): string[] {
  return String(box?.zalesPo ?? "")
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function validateZalesCustomer(body: any) {
  const service = String(body.service || "03");
  if (!CUSTOMER_SERVICES.includes(service)) {
    throw new Error(`service ${service} is not allowed for zales_customer (use 03 Ground, 13 Next Day Air Saver or 01 Next Day Air)`);
  }
  if (body.noSignature !== undefined || body.signature !== undefined) {
    throw new Error("signature options are not allowed for zales_customer (no signature on residential)");
  }
  const c = body.customerShipTo;
  if (!c?.name || !c?.address1 || !c?.city || !c?.state || !c?.zip) {
    throw new Error("customer address incomplete — need name, address1, city, state, zip");
  }
  if (!/^[A-Za-z]{2}$/.test(String(c.state))) throw new Error("customer state must be a 2-letter code");
  if (!/^\d{5}(-\d{4})?$/.test(String(c.zip).trim())) throw new Error("customer zip must be 5 digits or ZIP+4");
  c.residential = true; // forced
  const boxes: any[] = Array.isArray(body.boxes) ? body.boxes : [];
  if (boxes.length === 0) throw new Error("no boxes");
  for (const b of boxes) {
    const label = `box ${b?.boxNumber ?? "?"}`;
    const w = Number(b?.weightLbs);
    if (!Number.isFinite(w) || w <= 0) throw new Error(`${label}: weightLbs is required (no default allowed)`);
    for (const k of ["l", "w", "h"]) {
      const d = Number(b?.dims?.[k]);
      if (!Number.isFinite(d) || d <= 0) throw new Error(`${label}: dims.${k} is required (no default allowed)`);
    }
    const pos = poListOf(b);
    if (!pos.length) throw new Error(`${label}: zalesPo (the PO) is required`);
    if (pos.some((p) => !PO_RE.test(p))) throw new Error(`${label}: zalesPo contains an invalid PO`);
    if (b.declaredValue) throw new Error(`${label}: declared value is not allowed for zales_customer`);
  }
}

// ── v12: never label the same PO twice (live labels only) ──
async function assertNoLiveLabel(boxes: any[]) {
  for (const b of boxes) {
    for (const po of poListOf(b)) {
      const { data, error } = await supa
        .from("ups_labels")
        .select("tracking")
        .ilike("zales_po", `%${po}%`)
        .is("voided_at", null)
        .limit(1);
      if (error) throw new Error("duplicate check failed: " + error.message);
      if (data?.length) throw new Error(`PO ${po} already has a live label (${data[0].tracking}). Void it first if this is a redo.`);
    }
  }
}

async function getToken(base: string): Promise<string> {
  const { data, error } = await supa.rpc("get_ups_creds");
  if (error || !data) throw new Error("vault creds: " + (error?.message ?? "empty"));
  const c = JSON.parse(data);
  const b64 = btoa(`${c.client_id}:${c.client_secret}`);
  const r = await fetch(`${base}/security/v1/oauth/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${b64}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  const j = await r.json();
  if (!j.access_token) throw new Error("UPS token failed: " + JSON.stringify(j));
  return j.access_token;
}

function num(x: unknown, dflt: number): number {
  const n = Number(x);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

function upsErrText(status: number, j: any): string {
  const errs = j?.response?.errors?.map((e: any) => e.message).join("; ");
  return `UPS ${status}: ${errs || JSON.stringify(j).slice(0, 400)}`;
}

function customerShipTo(c: any) {
  if (!c?.name || !c?.address1 || !c?.city || !c?.state || !c?.zip) {
    throw new Error("customer address incomplete — need name, address, city, state, zip");
  }
  return {
    Name: String(c.name).slice(0, 35),
    AttentionName: String(c.name).slice(0, 35),
    ...(c.phone
      ? { Phone: { Number: String(c.phone).replace(/\D/g, "").slice(0, 15) } }
      : {}),
    Address: {
      AddressLine: [c.address1, c.address2].filter(Boolean).map((a: any) => String(a).slice(0, 35)),
      City: String(c.city).slice(0, 30),
      StateProvinceCode: String(c.state).toUpperCase().slice(0, 2),
      PostalCode: String(c.zip).slice(0, 10),
      CountryCode: "US",
      ...(c.residential ? { ResidentialAddressIndicator: "Y" } : {}),
    },
  };
}

async function createShipment(body: any) {
  const test = body.test === true;
  const base = test ? CIE : PROD;
  const presetName = body.shipToPreset || "zales";
  const preset = PRESETS[presetName];
  if (!preset) throw new Error("unknown shipToPreset");
  if (presetName === "zales_customer") {
    validateZalesCustomer(body); // v12: throws before anything reaches UPS
    if (!test) await assertNoLiveLabel(body.boxes);
  }
  const shipTo = preset.customer
    ? customerShipTo(body.customerShipTo)
    : body.attention
      ? { ...preset.shipTo, AttentionName: String(body.attention).slice(0, 35) }
      : preset.shipTo;
  // v10: Shipper is the block UPS renders on the label. Presets that must show
  // a different return address (customer drop ships → SJIX) override it here.
  // ShipFrom stays the real Edison origin for rating and the origin scan.
  const shipper = { ...(preset.shipperAddress || SHIP_FROM), ShipperNumber: SHIPPER_NUMBER };
  const shipFrom = SHIP_FROM;
  const boxes: any[] = Array.isArray(body.boxes) ? body.boxes : [];
  if (boxes.length === 0) throw new Error("no boxes");
  if (boxes.length > 20) throw new Error("UPS caps one shipment at 20 packages — split the batch");
  const service = String(body.service || (preset.customer ? "03" : "02"));
  // signature: presets decide the default, body.noSignature can force it off.
  const noSignature = body.noSignature === true ? true : !!preset.noSignature;

  for (const b of boxes) {
    const w = num(b.weightLbs, 20);
    if (w > 70) throw new Error(`box ${b.boxNumber}: ${w} lbs — Signet caps UPS parcels at 70 lbs (palletize via freight instead)`);
    const [L, W, H] = [num(b.dims?.l, 12), num(b.dims?.w, 12), num(b.dims?.h, 8)].sort((a, z) => z - a);
    if (L + 2 * (W + H) > 130) throw new Error(`box ${b.boxNumber}: length + girth over 130" — too big for UPS parcel per the Signet guide`);
    if (b.declaredValue && !preset.allowDeclaredValue) {
      throw new Error("declared value is a Signet chargeback on 3rd-party-billed shipments — use shipToPreset 'custom_own'");
    }
  }

  const payment = preset.billShipper
    ? { ShipmentCharge: { Type: "01", BillShipper: { AccountNumber: SHIPPER_NUMBER } } }
    : { ShipmentCharge: { Type: "01", BillThirdParty: preset.billThirdParty } };

  const payload = {
    ShipmentRequest: {
      Request: { RequestOption: "nonvalidate", TransactionReference: { CustomerContext: "EchabotPLM" } },
      Shipment: {
        Shipper: shipper,
        ShipTo: shipTo,
        ShipFrom: shipFrom,
        PaymentInformation: payment,
        Service: { Code: service },
        Package: boxes.map((b: any) => {
          const dv = preset.allowDeclaredValue && b.declaredValue
            ? { DeclaredValue: { CurrencyCode: "USD", MonetaryValue: String(num(b.declaredValue, 0)) } }
            : {};
          const sig = noSignature ? {} : { DeliveryConfirmation: { DCISType: "2" } };
          const pso = { ...dv, ...sig };
          return {
            Packaging: { Code: "02" },
            Dimensions: {
              UnitOfMeasurement: { Code: "IN" },
              Length: String(num(b.dims?.l, 12)),
              Width: String(num(b.dims?.w, 12)),
              Height: String(num(b.dims?.h, 8)),
            },
            PackageWeight: { UnitOfMeasurement: { Code: "LBS" }, Weight: String(num(b.weightLbs, 20)) },
            ...(Object.keys(pso).length ? { PackageServiceOptions: pso } : {}),
            ReferenceNumber: [
              ...(b.zalesPo ? [{ Value: String(b.zalesPo).slice(0, 35) }] : []),
              ...(b.invoiceNumber ? [{ Value: String(b.invoiceNumber).slice(0, 35) }] : []),
            ],
          };
        }),
      },
      LabelSpecification: {
        LabelImageFormat: { Code: "GIF" },
        HTTPUserAgent: "Mozilla/4.5",
      },
    },
  };

  const token = await getToken(base);
  const r = await fetch(`${base}/api/shipments/v2409/ship`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      transId: crypto.randomUUID(),
      transactionSrc: "EchabotPLM",
    },
    body: JSON.stringify(payload),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(upsErrText(r.status, j));
  const res = j?.ShipmentResponse?.ShipmentResults;
  if (!res) throw new Error("UPS ship: empty results " + JSON.stringify(j).slice(0, 300));
  const pkgResults = Array.isArray(res.PackageResults)
    ? res.PackageResults
    : [res.PackageResults].filter(Boolean);
  const packages = pkgResults.map((p: any, i: number) => ({
    boxNumber: boxes[i]?.boxNumber ?? i + 1,
    zalesPo: boxes[i]?.zalesPo ?? null,
    vendorPo: boxes[i]?.vendorPo ?? null,
    orderNo: boxes[i]?.orderNo ?? null,
    invoiceNumber: boxes[i]?.invoiceNumber ?? null,
    tracking: p.TrackingNumber,
    labelB64: p.ShippingLabel?.GraphicImage ?? null,
  }));
  const shipmentId = res.ShipmentIdentificationNumber;

  if (!test) {
    const rows = packages
      .filter((p: any) => p.tracking && p.labelB64)
      .map((p: any) => ({
        tracking: p.tracking,
        shipment_ups_id: shipmentId,
        box_number: p.boxNumber,
        zales_po: p.zalesPo,
        invoice_number: p.invoiceNumber,
        label_b64: p.labelB64,
        format: "GIF",
      }));
    if (rows.length) {
      const { error } = await supa.from("ups_labels").upsert(rows, { onConflict: "tracking" });
      if (error) throw new Error("label store: " + error.message);
    }
  }
  return { test, shipmentId, service, packages, charges: res.ShipmentCharges ?? null };
}

async function voidShipment(body: any) {
  const test = body.test === true;
  const base = test ? CIE : PROD;
  const id = String(body.shipmentId || "").trim().toUpperCase();
  if (!/^1Z[A-Z0-9]{16}$/.test(id)) throw new Error("shipmentId must be the 1Z shipment id");
  const token = await getToken(base);
  const r = await fetch(`${base}/api/shipments/v1/void/cancel/${id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}`, transId: crypto.randomUUID(), transactionSrc: "EchabotPLM" },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(upsErrText(r.status, j));
  if (!test) {
    await supa.from("ups_labels").update({ voided_at: new Date().toISOString() }).eq("shipment_ups_id", id);
  }
  return {
    voided: true,
    shipmentId: id,
    status: j?.VoidShipmentResponse?.SummaryResult?.Status?.Description ?? "ok",
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS });
  }
  try {
    await requireUser(req); // v12
    const body = await req.json().catch(() => ({}));
    const action = body.action || "create";
    const out = action === "void" ? await voidShipment(body) : await createShipment(body);
    return new Response(JSON.stringify(out), { headers: { ...CORS, "Content-Type": "application/json" } });
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    return new Response(JSON.stringify({ error: String((e as Error)?.message ?? e) }), {
      status,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});

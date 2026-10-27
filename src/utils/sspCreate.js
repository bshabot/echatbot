// src/utils/sspCreate.js
//
// Sample -> SSP item creation (the Samples page's "Create in SSP" actions).
//
// BEST-EFFORT V1: a sample row (sample_with_stones_export shape) carries the
// header/item basics, enough metal data for a first-pass material row, its
// own stones array (id/type/color/shape/size/quantity/cost), and its R2
// image(s). Findings and labor are still NOT sent — this module creates
// the header + item + material + stones + images and stops there; the
// rest is finished by hand in SKU Manager, where the new product sits in
// the hold queue as "Pending Vendor Submission".
//
// Everything adjustable lives at the top of this file (category map,
// defaults) or in Settings (buyer, country, userName) — the intended
// workflow is to refine these together as real samples go through.
//
// Payload field names mirror the recorded HAR exactly — see
// tools/ssp-item-creator/docs/API-NOTES.md.

import {
  isSspEnabled,
  ensureFreshSspToken,
  sspSaveHeader,
  sspGetGlobalMetalLock,
  sspSetCostingMethod,
  sspSetTethers,
  sspCreateItem,
  sspUpdateItem,
  sspAddMaterial,
  sspUpdateMaterial,
  sspGetItemMaterials,
  sspAddFinding,
  sspUpdateFinding,
  sspGetItemFindings,
  sspUpdateLaborCost,
  sspGetLaborCost,
  sspUpdateVendorCost,
  sspGetVendorCost,
  sspAddStone,
  sspGetItemStones,
  sspStageImagesForSample,
  sspStageImage,
  sspGetHeader,
} from "./sspClient";
// The pure payload builder lives in sspPayloads.js so the Netlify function
// behind the SSP Chrome extension can reuse it. Re-exported for existing callers.
import {
  s,
  n,
  round2,
  stoneFloorMap,
  fetchMetalPrices,
  buildSspPayloadsForSample,
} from "./sspPayloads";
export { CATEGORY_TO_SSP, SSP_CREATE_DEFAULTS, buildSspPayloadsForSample } from "./sspPayloads";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Pulls the HTTP status back out of sspRequest's own error message
// ("SSP GET ... -> HTTP 502: ...") so the failure log has it as a real
// column instead of just free text.
function httpStatusFromError(e) {
  const m = /-> HTTP (\d+)/.exec(e?.message || "");
  return m ? Number(m[1]) : null;
}

// Best-effort: logging a failure must never itself break Create in SSP.
// Feeds ssp_api_failures (added 2026-09-10) so recurring materials-GET
// 502s can be checked for a pattern -- timing since the item step,
// freshly-created vs pre-existing item, which of the two materials reads
// it was -- rather than guessed at.
async function logSspApiFailure(supabase, row) {
  if (!supabase) return;
  try {
    await supabase.from("ssp_api_failures").insert(row);
  } catch {
    /* logging is best-effort only */
  }
}
// Like n(), but SSP treats a literal 0 as "not provided" on mandatory
// physical fields (dims/weight) -- confirmed 2026-08-27: a sample with
// height/width/length stored as 0 in the PLM sent itemSize/Height/Width
// as "0"/0/0 and item-create came back "Mandatory Fields are missing",
// even though every field NAME was present. Falls back to `fallback`
/**
 * PREPARE — build every payload up front (no SSP calls except reading the
 * live metal locks from the PLM's own DB) so the batch can be confirmed
 * before anything is sent. NOTE: SSP has no overwrite — every send mints a
 * NEW SSP number, so don't re-run a batch that already succeeded.
 *
 * Returns { enabled, prepared[], failed[], total } where each prepared
 * entry is { sample, label, payloads, warnings }.
 */
export async function prepareSspCreatesForSamples(rows, { supabase, settings } = {}) {
  if (!isSspEnabled(settings)) return { enabled: false, prepared: [], failed: [], total: 0 };
  const metalPrices = await fetchMetalPrices(supabase);
  const prepared = [];
  const failed = [];
  for (const sample of rows || []) {
    const label = s(sample.styleNumber) || String(sample.sample_id || "?");
    try {
      if (!s(sample.styleNumber)) throw new Error("sample has no style number");
      const { payloads, warnings } = buildSspPayloadsForSample(sample, { settings, metalPrices });
      prepared.push({ sample, label, payloads, warnings });
    } catch (e) {
      failed.push({ sample: label, error: e?.message || String(e) });
    }
  }
  return { enabled: true, prepared, failed, total: (rows || []).length };
}

/**
 * Which progress steps one prepared entry will report. Shared by the sender
 * (so the ring knows how many slices make up 100%) and by the UI (which
 * flattens a whole set's steps up front). Members of a set after the first
 * skip the header (it already exists) and the sales-price balancing (the
 * SKU-level cost spans both items, so it is not applied to sets yet).
 */
export function sspStepsForPrepared({ payloads, sample, group }) {
  const follower = !!group && group.position > 0;
  return [
    ...(follower ? [] : ["header"]),
    "item",
    ...(payloads.material ? ["material"] : []),
    ...(payloads.finding ? ["finding"] : []),
    ...(payloads.labor ? ["labor"] : []),
    "vendorCost",
    ...(n(sample.salesPrice) > 0 ? ["balance"] : []),
  ];
}

/**
 * PREPARE A SET — two (or more) linked samples that become ONE SSP number
 * with one item each. `rows` must be in set order (position 1 first): the
 * first row creates the SSP header, the rest add their item to it. The
 * header carries the set's own style number, and the photos of every member.
 */
// `extend` ({ sspCode, startPosition }) adds NEW members to a set that already
// has an SSP number: only `rows` (the new ones) are prepared, each becomes a
// follower item under that SSP number -- no header, costing method or tether.
export async function prepareSspSetCreate(rows, setStyleNumber, { supabase, settings, extend = null } = {}) {
  const prep = await prepareSspCreatesForSamples(rows, { supabase, settings });
  if (!prep.enabled) return prep;
  // A set is all-or-nothing: if any member fails validation, send nothing.
  if (prep.failed.length) return { ...prep, prepared: [] };
  const setStyle = s(setStyleNumber);
  // SSP's header takes 2 to 4 photos. Members that have photos each contribute
  // (first photo of each member, then second photos, ...) up to 4; a member with
  // none adds none, and if only one member has a photo only that one is used.
  const allImageUrls = [];
  {
    const per = prep.prepared.map((p) => [...new Set(p.payloads.imageSourceUrls || [])]);
    for (let k = 0; allImageUrls.length < 4 && per.some((l) => k < l.length); k++) {
      for (const l of per) {
        if (k < l.length && allImageUrls.length < 4) allImageUrls.push(l[k]); // same photo on several members still counts once per member
      }
    }
  }
  const costingMethods = new Set(prep.prepared.map((p) => p.payloads.item.costingMethod));
  prep.prepared.forEach((p, position) => {
    p.group = {
      key: setStyle,
      position: extend ? extend.startPosition + position : position,
      size: prep.prepared.length + (extend ? extend.startPosition : 0),
      setStyle,
      imageUrls: allImageUrls,
      ...(extend ? { sspCode: extend.sspCode } : {}),
    };
    if (position === 0 && !extend) {
      p.payloads.header.vendorStyleNumber = setStyle;
      if (costingMethods.size > 1)
        p.warnings.push(
          `the items use different costing methods (${[...costingMethods].join(" / ")}) but SSP sets one per SSP number -- using ${p.payloads.item.costingMethod} from item 1`
        );
    }
    // Each member is priced toward ITS OWN sales price (see the balance step).
  });
  return prep;
}

/**
 * SEND — create each prepared sample in SSP: header -> costing method ->
 * tethers -> item -> material. One sample failing never stops the rest;
 * a partial failure reports the minted SSP number so it can be finished by
 * hand in SKU Manager.
 *
 * Returns { enabled, created[], failed[], total } — created entries are
 * { sample, sspCode, itemId, warnings }.
 */
// ── Resume progress (survives a retry after a partial failure) ──────────
// header/save always mints a brand-new SSP number — there's no overwrite —
// so retrying a sample that already got as far as, say, item-create would
// otherwise mint a SECOND orphaned product every time. Remember how far
// each sample got (keyed by its style number/label) in localStorage so a
// retry picks up from the first step that actually failed instead of
// starting over — costing-method/tethers are cheap + idempotent so they
// just always re-run once sspCode exists; header/save, item-create,
// material, and each stone are the steps actually guarded.
const SSP_PROGRESS_VERSION = 1;

function sspProgressKey(label) {
  return `ssp-create-progress:v${SSP_PROGRESS_VERSION}:${label}`;
}

function loadSspProgress(label) {
  try {
    const raw = localStorage.getItem(sspProgressKey(label));
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveSspProgress(label, patch) {
  try {
    const current = loadSspProgress(label);
    localStorage.setItem(
      sspProgressKey(label),
      JSON.stringify({ ...current, ...patch, updatedAt: Date.now() })
    );
  } catch {
    /* best-effort — resuming is a convenience, not a requirement */
  }
}

function clearSspProgress(label) {
  try {
    localStorage.removeItem(sspProgressKey(label));
  } catch {
    /* no-op */
  }
}

/** Manually clear one sample's (or, with no arg, every sample's) resume
 * progress — e.g. to force a genuinely new product instead of continuing
 * a previous partial one. */
export function clearSspCreateProgress(label) {
  if (label) return clearSspProgress(label);
  try {
    const keys = Object.keys(localStorage).filter((k) => k.startsWith("ssp-create-progress:"));
    keys.forEach((k) => localStorage.removeItem(k));
    return keys.length;
  } catch {
    return 0;
  }
}

// Writes the SSP link straight to the sample's own row (samples.ssp_code /
// ssp_item_id, surfaced back through sample_with_stones_export as
// sample.ssp_code/ssp_item_id) so it survives forever — not just within one
// browser's localStorage. Without this, a sample that was already fully
// created went right back to "no memory of it" the moment sspProgress got
// cleared on success, so the NEXT "Create in SSP" click had nothing to
// resume from and minted a brand new SSP product every single time
// (2026-08-31: reported as "added a new item" / "not updating the current
// item" on a sample that had already been created earlier).
async function persistSspLink(supabase, sample, link) {
  if (!supabase || sample?.sample_id == null) return;
  try {
    const patch = {};
    if ("sspCode" in link) patch.ssp_code = link.sspCode ?? null;
    if ("itemId" in link) patch.ssp_item_id = link.itemId ?? null;
    if ("materialId" in link) patch.ssp_material_id = link.materialId ?? null;
    if ("stoneIds" in link) patch.ssp_stone_ids = link.stoneIds ?? null;
    const { error } = await supabase.from("samples").update(patch).eq("id", sample.sample_id);
    if (error) throw error;
  } catch (e) {
    console.error("Failed to persist SSP link to sample row:", e);
  }
}

export async function sendPreparedSspCreates(prepared, { settings, supabase, onProgress } = {}) {
  if (!isSspEnabled(settings)) return { enabled: false, created: [], failed: [], total: 0 };
  // Renew the SSP token up front (if a refresh token is on file and it's
  // expiring soon) instead of letting it die partway through a batch —
  // every call below uses this returned settings object, not the one
  // passed in, so the fresh token reaches every step.
  try {
    settings = await ensureFreshSspToken(settings, supabase);
  } catch (e) {
    console.error("SSP token refresh failed, continuing with existing token:", e);
  }
  const created = [];
  const failed = [];
  const list = prepared || [];
  // For a set: the SSP number minted by (or already on) the first member,
  // shared by every later member.
  let groupSspCode = list.find((p) => p.group?.sspCode)?.group.sspCode || null;
  for (let i = 0; i < list.length; i++) {
    const { label, payloads, warnings, sample, group } = list[i];
    const isFollower = !!group && group.position > 0;
    if (isFollower && !groupSspCode) {
      failed.push({
        sample: label,
        sspCode: null,
        error: `skipped -- the first item of set "${group.setStyle}" did not get an SSP number`,
      });
      continue;
    }
    const progress = loadSspProgress(label);
    // Step list this item actually needs -- header/item always run;
    // material/finding/labor only if this item has that payload. Reported
    // to onProgress so the UI's progress ring knows how many slices make
    // up 100% for THIS item (2 to 5, not a fixed 5).
    const sspSteps = sspStepsForPrepared(list[i]);
    const reportStep = (step, status, error) => {
      if (typeof onProgress === "function") {
        onProgress({ index: i, total: list.length, label, steps: sspSteps, step, status, error });
      }
    };
    let currentStep = "header";
    // The DB link (sample.ssp_code/ssp_item_id) is the durable memory of an
    // already-created product; localStorage progress is only for resuming
    // a batch that failed partway through THIS browser session. Either can
    // supply the starting point — DB wins when both somehow disagree, since
    // it's the one every user/browser actually sees.
    let sspCode = sample?.ssp_code || progress.sspCode || null;
    let itemId = sample?.ssp_item_id || progress.itemId || null;
    let materialId = sample?.ssp_material_id || progress.materialId || null;
    // A later member of a set always lives under the set's SSP number. If
    // this sample was linked to a DIFFERENT SSP before it joined the set,
    // those item/material/stone ids belong to that other SSP -- drop them
    // so a new item is created here instead of updating a stranger's row.
    const ownIdsMatchGroup = isFollower && sample?.ssp_code && sample.ssp_code === groupSspCode;
    if (isFollower) {
      sspCode = groupSspCode;
      if (!ownIdsMatchGroup) {
        itemId = null;
        materialId = null;
      }
    }
    // Stone ids line up with payloads.stones by INDEX (the order the
    // sample's own stones array is built in, which is stable run to run
    // unless someone adds/removes/reorders a stone row on the sample
    // itself). A new stone beyond what we have an id for just gets created;
    // one that was removed leaves its old SSP row untouched (no delete
    // endpoint here) rather than guessing which id to reuse for it.
    let stoneIds = Array.isArray(sample?.ssp_stone_ids)
      ? sample.ssp_stone_ids
      : Array.isArray(progress.stoneIds)
        ? progress.stoneIds
        : [];
    if (isFollower && !ownIdsMatchGroup) stoneIds = [];
    try {
      // Report "active" before ANYTHING else runs, not after image
      // staging -- Kevin, 2026-09-14: the ring looked like it didn't
      // start until right as the header save happened, because staging
      // (up to 5 network round-trips per photo, 2+ photos) used to run
      // silently before the first reportStep call. Now the very first
      // thing this item does is light up, covering the whole staging +
      // save stretch instead of just the last instant of it.
      if (!isFollower) reportStep("header", "active");

      // Images first — cached by sspStageImage itself, so a retry doesn't
      // re-run the 5-request pipeline. Once we have a real sspCode (a
      // resumed sample), stage under it instead of "NEW_<ts>".
      if (isFollower) {
        // The SSP number already exists (first member made it): just record
        // it on this sample too and go straight to this member's item.
        await persistSspLink(supabase, sample, { sspCode });
        // Joining a set that was ALREADY created in SSP: the header (and its
        // photos) exist, so attach THIS member's own photos to it. Only the
        // photos this sample actually has are added (none = nothing to do);
        // the photos already on the header are kept as they are. A failure
        // here only warns -- the item itself is still created below.
        if (group?.sspCode && payloads.imageSourceUrls?.length) {
          try {
            const got = await sspGetHeader(settings, sspCode);
            const existing = got?.json?.data?.header || got?.json?.data || {};
            const headerFields = { ...existing };
            const oldImages = headerFields.images || [];
            delete headerFields.images;
            delete headerFields.sspCode;
            const added = [];
            // header holds at most 4 photos in total
            const room = Math.max(0, 4 - (oldImages || []).length);
            if (room === 0)
              warnings.push("the set's SSP header already has 4 photos (the maximum), so this item's photo was not added");
            for (let k = 0; k < Math.min(room, payloads.imageSourceUrls.length); k++) {
              const url = payloads.imageSourceUrls[k];
              const ext = (url.split("?")[0].split(".").pop() || "jpg").slice(0, 5);
              added.push(
                await sspStageImage(settings, {
                  sspCode,
                  sourceUrl: url,
                  filename: `${label}${k ? `-${k + 1}` : ""}.${ext}`,
                  isPrimary: false,
                })
              );
            }
            // header GET hands back a presigned https URL for each photo, but
            // header/save wants the bare S3 key (what staging returns). Saving
            // the presigned URL back would break every photo on the header
            // ("Unable to load image") -- so turn each one back into its key.
            const keepOld = (oldImages || []).map((img) => {
              const u = String(img?.imageUrl || "");
              if (!/^https?:\/\//i.test(u)) return img;
              try {
                return { ...img, imageUrl: decodeURIComponent(new URL(u).pathname.replace(/^\/+/, "")) };
              } catch {
                return img;
              }
            });
            if (added.length) await sspSaveHeader(settings, headerFields, [...keepOld, ...added], sspCode);
          } catch (e) {
            warnings.push(
              `could not add this item's photo(s) to the set's SSP header (${String(e?.message || e).slice(0, 120)}) -- add them in SKU Manager`
            );
          }
        }
      } else {
        // A set's header carries the photos of EVERY member, staged under the
        // set's own name; a single sample stages just its own.
        const headerImageUrls = group ? group.imageUrls : payloads.imageSourceUrls;
        const images = headerImageUrls?.length
          ? await sspStageImagesForSample(settings, {
              sspCode,
              sourceUrls: headerImageUrls,
              baseFilename: group ? group.key : label,
            })
          : [];

        // Kevin, 2026-09-16: SSP runs its own AI photo-QA scorer on every
        // staged image and can mark one "fail" without rejecting the
        // upload -- the image still attaches and the item still saves, it
        // just sits in the hold queue with a quality flag. That's easy to
        // mistake for a real bug (images "not working") when someone spots
        // it later in SKU Manager. Surface it here, quietly, in the same
        // per-item warnings list Kevin already reads after a send -- no
        // popup, no blocking dialog, just a heads-up so a QA "fail" chip
        // in the hold queue isn't a surprise.
        const failedQaImages = images.filter((img) => img?.qaStatus === "fail");
        if (failedQaImages.length) {
          const reason = s(failedQaImages[0]?.QADetailedResponse).slice(0, 140);
          warnings.push(
            `SSP's photo-QA flagged ${failedQaImages.length} of ${images.length} photo(s) as "fail"` +
              (reason ? ` (${reason}${reason.length >= 140 ? "…" : ""})` : "") +
              " -- the item still saved and the photo still attached, just check it in the SKU Manager hold queue before this goes live."
          );
        }

        // Always call header/save, not just on the first attempt: it's the
        // ONLY call that attaches images, and a confirmed-real payload shows
        // it accepts an EXISTING sspCode to update a product rather than
        // requiring "" for create-only. Skipping this once sspCode was known
        // used to mean a sample whose first attempt got a broken image
        // reference (e.g. the tempSspImages/ path bug) stayed stuck with it
        // forever, since nothing ever re-attached the now-correctly-staged
        // photos on a retry.
        const head = await sspSaveHeader(settings, payloads.header, images, sspCode || "");
        sspCode = head.sspCode;
        if (group) groupSspCode = sspCode; // later members of the set add their item to this SSP
        saveSspProgress(label, { sspCode });
        await persistSspLink(supabase, sample, { sspCode });
        // Kevin, 2026-09-22: this call (POST .../costing-method/update-
        // costing-method/{sspCode}/{method}) WIPES the item's existing
        // material/finding/stone data on SSP's side when the value actually
        // changes -- confirmed by Kevin from real use. Harmless on a brand
        // new sspCode (nothing exists yet to wipe, which is the normal path
        // here since this runs before item/material/finding/stones are
        // sent), but re-running Create in SSP on an ALREADY-created item
        // whose costing method is changing will wipe stones too -- and
        // stones have no update endpoint, so the follow-on resend in this
        // same function just re-adds them, risking duplicate stone rows in
        // SSP. Silver/gold now resolve to "labor per piece" (was "fixed
        // with metal lock") via ssp_metal_defaults.costing_method -- any
        // already-created silver/gold item should be spot-checked in SKU
        // Manager after its next Create in SSP run.
        await sspSetCostingMethod(settings, sspCode, payloads.item.costingMethod);
        await sspSetTethers(settings, sspCode, {});
        reportStep("header", "success");
      }
      // Price the metal at SIGNET'S Global Lock, not our market (LBMA) price:
      // SSP saves the numbers we send and doesn't re-price on submit, so a
      // 60.20 silver price against Signet's 65 lock fails approval (Kevin,
      // 2026-10-12). Needs the SSP number, so it runs here, after the header.
      // If the lock can't be read we stop -- never fall back to market.
      if (payloads.material || payloads.finding) {
        let lockRows;
        try {
          lockRows = await sspGetGlobalMetalLock(settings, sspCode);
        } catch (e) {
          throw new Error(`Could not read Signet's Global Metal Lock for ${sspCode}, so the metal price was not set: ${e?.message || e}`);
        }
        const lockPrices = { gold: lockRows.gold?.lock ?? null, silver: lockRows.silver?.lock ?? null };
        const rebuilt = buildSspPayloadsForSample(sample, { settings, metalPrices: lockPrices }).payloads;
        payloads.material = rebuilt.material;
        payloads.finding = rebuilt.finding;
        const metalKey = s(sample.metalType).toLowerCase();
        const used = lockRows[metalKey];
        if (used) {
          warnings.push(
            `Metal priced at Signet's Global Lock: ${metalKey} $${used.lock.toFixed(2)}` +
              (used.live != null ? ` (market $${used.live.toFixed(2)})` : "")
          );
        }
      }
      currentStep = "item";
      const itemFreshlyCreated = !itemId;
      if (!itemId) {
        const createdItem = await sspCreateItem(settings, sspCode, payloads.item);
        itemId = createdItem.itemId;
      } else {
        // Update the existing item in place — CONFIRMED 2026-08-31 via a
        // real HAR (S189443/item 1): the update call is `PUT
        // /item/{itemId}` (id in the URL), not the create POST with an
        // itemId in the body — that just makes a duplicate item, which is
        // exactly what happened before this fix. See sspUpdateItem.
        const updatedItem = await sspUpdateItem(settings, sspCode, itemId, payloads.item);
        if (updatedItem.itemId && updatedItem.itemId !== itemId) {
          warnings.push(
            `SSP returned itemId ${updatedItem.itemId}, not the expected ${itemId} on ${sspCode} — double check SKU Manager for a duplicate.`
          );
          itemId = updatedItem.itemId;
        }
      }
      saveSspProgress(label, { sspCode, itemId });
      await persistSspLink(supabase, sample, { sspCode, itemId });
      reportStep("item", "success");
      currentStep = "material";
      const itemStepDoneAt = Date.now();
      if (itemFreshlyCreated) await sleep(800);

      // Material — ask SSP what is actually there before choosing
      // create-vs-update, then confirm the write landed.
      //
      // Never branch on the stored materialId alone. SSP's
      // `PUT .../material/{id}` against an id that does not exist answers
      // HTTP 200 `success: true` and echoes the payload back while
      // persisting nothing (CONFIRMED 2026-09-01 on S189748/item 1). A
      // stored id that has gone stale therefore traps us in a loop: every
      // resend "succeeds", writes the phantom id back to Supabase, and the
      // item stays materially empty — SSP's own validator kept reporting
      // "Item indicates it should have 1 or more Material components, but
      // none were found" while our sends all came back green.
      if (payloads.material) {
        reportStep("material", "active");
        let liveMaterials = [];
        try {
          liveMaterials = await sspGetItemMaterials(settings, sspCode, itemId);
        } catch (e) {
          warnings.push(
            `Could not read existing materials on item ${itemId} (${sspCode}): ${e.message} — falling back to the stored id.`
          );
          logSspApiFailure(supabase, {
            sample_label: label,
            ssp_code: sspCode,
            item_id: itemId,
            endpoint: "materials",
            method: "GET",
            call_kind: "materials_read_before_write",
            item_freshly_created: itemFreshlyCreated,
            ms_since_item_step: Date.now() - itemStepDoneAt,
            http_status: httpStatusFromError(e),
            error_message: e.message,
          });
          liveMaterials = materialId ? [{ materialId }] : [];
        }

        const liveMaterialId = liveMaterials[0]?.materialId ?? null;
        if (materialId && !liveMaterialId) {
          warnings.push(
            `Stored materialId ${materialId} does not exist on item ${itemId} (${sspCode}) — creating a fresh material instead of updating a phantom row.`
          );
        }

        if (!liveMaterialId) {
          const addedMaterial = await sspAddMaterial(settings, sspCode, itemId, payloads.material);
          materialId = addedMaterial.materialId ?? null;
        } else {
          const updatedMaterial = await sspUpdateMaterial(
            settings,
            sspCode,
            itemId,
            liveMaterialId,
            payloads.material
          );
          materialId = updatedMaterial.materialId ?? liveMaterialId;
        }

        // Confirm it actually landed — a green response is not proof.
        let confirmedMaterialId = materialId;
        try {
          const afterMaterials = await sspGetItemMaterials(settings, sspCode, itemId);
          confirmedMaterialId = afterMaterials[0]?.materialId ?? null;
          if (!confirmedMaterialId) {
            throw new Error(
              `SSP reported success but item ${itemId} (${sspCode}) still has no material — nothing was saved.`
            );
          }
          if (materialId && confirmedMaterialId !== materialId) {
            warnings.push(
              `SSP returned materialId ${materialId} but item ${itemId} (${sspCode}) actually holds ${confirmedMaterialId} — using the live id.`
            );
          }
          materialId = confirmedMaterialId;
        } catch (e) {
          logSspApiFailure(supabase, {
            sample_label: label,
            ssp_code: sspCode,
            item_id: itemId,
            endpoint: "materials",
            method: "GET",
            call_kind: "materials_verify_after_write",
            item_freshly_created: itemFreshlyCreated,
            ms_since_item_step: Date.now() - itemStepDoneAt,
            http_status: httpStatusFromError(e),
            error_message: e.message,
          });
          // Do not persist an id we could not verify: a phantom pointer is
          // what causes the silent-no-op loop in the first place.
          materialId = null;
          saveSspProgress(label, { sspCode, itemId, materialId });
          await persistSspLink(supabase, sample, { sspCode, itemId, materialId });
          throw e;
        }

        saveSspProgress(label, { sspCode, itemId, materialId });
        await persistSspLink(supabase, sample, { sspCode, itemId, materialId });
        reportStep("material", "success");
      }
      currentStep = "finding";

      // Finding — GET first, same rule as material: SSP's PUT against an id
      // that does not exist answers 200 success while saving nothing, so the
      // live rows decide create-vs-update, never a stored id.
      if (payloads.finding) {
        reportStep("finding", "active");
        let liveFindings = [];
        try {
          liveFindings = await sspGetItemFindings(settings, sspCode, itemId);
        } catch (e) {
          warnings.push(`Could not read existing findings on item ${itemId} (${sspCode}): ${e.message}`);
        }
        const liveFindingId = liveFindings[0]?.findingId ?? null;
        try {
          if (!liveFindingId) {
            await sspAddFinding(settings, sspCode, itemId, payloads.finding);
          } else {
            await sspUpdateFinding(settings, sspCode, itemId, liveFindingId, payloads.finding);
          }
          const after = await sspGetItemFindings(settings, sspCode, itemId);
          if (!after.length)
            throw new Error(
              `SSP reported success but item ${itemId} (${sspCode}) still has no finding — nothing was saved.`
            );
          reportStep("finding", "success");
        } catch (e) {
          warnings.push(`finding on ${sspCode}: ${e.message}`);
          reportStep("finding", "error", e.message);
        }
      }
      currentStep = "labor";

      // Labor — one record per item, upsert, no id. Verify by reading the
      // computed total back.
      if (payloads.labor) {
        reportStep("labor", "active");
        try {
          await sspUpdateLaborCost(settings, sspCode, itemId, payloads.labor);
          const after = await sspGetLaborCost(settings, sspCode, itemId);
          if (after && after.ttlAllLaborCosts == null) {
            warnings.push(`labor cost saved on ${sspCode} but SSP returned no total — check the finish row`);
            reportStep("labor", "error", "SSP returned no total");
          } else {
            reportStep("labor", "success");
          }
        } catch (e) {
          warnings.push(`labor cost on ${sspCode}: ${e.message}`);
          reportStep("labor", "error", e.message);
        }
      }

      // Vendor cost — one record per item, upsert, no id, sent on every
      // item. GET first and merge our overrides on top of SSP's own
      // current record rather than sending a payload built from scratch,
      // so every field we don't have a real source for (overcost, vendor
      // discount, dropship fee, gem/cert fields, the read-only toggles)
      // stays exactly what SSP already has instead of getting guessed at
      // or blanked out.
      currentStep = "vendorCost";
      reportStep("vendorCost", "active");
      try {
        const liveVendorCost = await sspGetVendorCost(settings, sspCode, itemId);
        const mergedVendorCost = { ...(liveVendorCost || {}), ...(payloads.vendorCost || {}) };
        await sspUpdateVendorCost(settings, sspCode, itemId, mergedVendorCost);
        const afterVendorCost = await sspGetVendorCost(settings, sspCode, itemId);
        if (!afterVendorCost) {
          warnings.push(`vendor cost saved on ${sspCode} but re-GET returned nothing`);
          reportStep("vendorCost", "error", "re-GET returned nothing");
        } else {
          reportStep("vendorCost", "success");
        }
      } catch (e) {
        warnings.push(`vendor cost on ${sspCode}: ${e.message}`);
        reportStep("vendorCost", "error", e.message);
      }

      // Price to sales price — Kevin, 2026-09-14: "its basically using the
      // ones we are already filling out with the system. so simple
      // fields... change those fields that are the ones of the filled
      // out ones and try to get as close as you can to the sales price."
      // Every vendor-cost-tab field tried (overcostCcy, fixedCost,
      // vendorDiscountPerc/Ccy, vdrPackagingCost) was rejected -- the
      // real lever is stone cost, a field this flow already fills in
      // normally, adjusted BEFORE it's first sent rather than patched
      // after the fact. Only stones with no existing stoneId are
      // touched (about to be CREATED this run) -- an already-created
      // stone is never rewritten, same caution as everywhere else in
      // this file. Best-effort: gets as close as the available new
      // stones allow, nothing more.
      const stones = payloads.stones || [];
      const nextStoneIds = stoneIds.slice(0, stones.length);
      const newStoneIndexes = stones
        .map((_, idx) => idx)
        .filter((idx) => !(nextStoneIds[idx] || 0));

      // A set member is priced toward its OWN sales price, so the set totals the
      // sum of its members. Kevin, 2026-10-07: for a set the sales price is the
      // cost BEFORE the vendor rate, and SSP's figure should be price x (1 + rate)
      // (silver 16.25% -> 4.00 becomes 4.65). The figure compared is the item's
      // own discounted cost -- SSP's Signet Purchase Cost is those added up, so
      // it can't be read straight off a member. Too low: raise new stone cost
      // (as for single items). Too high: trim casting, then assembly, on this
      // member and re-save labor.
      const targetSalesPrice = n(sample.salesPrice);
      const setRate = n(payloads.vendorCost?.vendorDiscountPerc) ?? 0;
      const setTarget =
        group && targetSalesPrice > 0 ? round2(targetSalesPrice * (1 + setRate / 100)) : null;
      const memberCostOf = (vc) => {
        const disc = n(vc?.discountPieceCostSubtotal);
        if (disc != null) return disc;
        const piece = n(vc?.pieceCostSubtotal);
        return piece != null ? round2(piece * (1 - setRate / 100)) : null;
      };
      if (targetSalesPrice != null && targetSalesPrice > 0) {
        currentStep = "balance";
        reportStep("balance", "active");
        try {
          const baseVendorCost = await sspGetVendorCost(settings, sspCode, itemId);
          const baseCost = group ? memberCostOf(baseVendorCost) : n(baseVendorCost?.vendorPurchCost);
          // Kevin, 2026-09-23: the vendor reimbursement rate (a tariff-like
          // markup -- vendorDiscountPerc, now sent per-metal: silver
          // 16.25%, gold 17.05%, brass 11%) is NOT part of vendorPurchCost.
          // Sales price is the final price the item sells for, which
          // implies cost x (1 + rate) -- e.g. a $10.25 cost at 16.25%
          // prices out to $11.92, not $10.25. Compare the sales price
          // against that inflated number, not the raw cost, or every item
          // looks short by roughly the reimbursement rate's worth.
          const reimbursementRate = n(payloads.vendorCost?.vendorDiscountPerc);
          const effectiveBaseCost =
            !group && baseCost != null && reimbursementRate != null
              ? round2(baseCost * (1 + reimbursementRate / 100))
              : baseCost;
          const priceTarget = group ? setTarget : targetSalesPrice;
          const newStoneQty = newStoneIndexes.reduce(
            (sum, idx) => sum + (n(stones[idx].quantity) || 0),
            0
          );
          // Stones about to be created are NOT in the cost just read, so count
          // them in before comparing. For a set member each stone dollar is
          // worth (1 + duty) x (1 - rate) once SSP has applied duty and the
          // discount; a single item counts them 1:1.
          const dutyRate = (n(baseVendorCost?.vendorDutyRate) ?? 5) / 100;
          const scale = group ? (1 + dutyRate) * (1 - setRate / 100) : 1;
          const newStoneTotal = newStoneIndexes.reduce(
            (sum, idx) => sum + (n(stones[idx].cost) || 0) * (n(stones[idx].quantity) || 1),
            0
          );
          let remainingOver = 0; // item-cost dollars still over target after stones
          if (effectiveBaseCost != null) {
            const gap = priceTarget - (effectiveBaseCost + newStoneTotal * scale);
            const setStoneCost = (st, c) => {
              const qty = n(st.quantity) || 1;
              st.cost = c;
              st.settingChargePerStone = c;
              st.totalStoneCost = round2(c * qty);
              st.totalSettingCost = round2(c * qty);
            };
            if (gap > 0.01 && newStoneQty > 0) {
              const perStoneAdd = gap / scale / newStoneQty;
              for (const idx of newStoneIndexes) {
                setStoneCost(stones[idx], round2((n(stones[idx].cost) || 0) + perStoneAdd));
              }
              warnings.push(
                `Raised new stone cost on ${sspCode} by ~${round2(perStoneAdd)}/stone to close the gap to sales price ${targetSalesPrice} (cost was ${baseCost}, ${effectiveBaseCost} after the ${reimbursementRate}% reimbursement rate, before stones).`
              );
            } else if (gap < -0.01) {
              // Over target: bring new stone costs down, never below the
              // per-size floors (1 cent for the smallest size, +1 cent per
              // larger size), then whatever is left comes off labor (sets).
              const floors = stoneFloorMap(stones.map((st) => n(st.stoneMillimeter)));
              let need = round2(-gap / scale);
              let lowered = 0;
              for (const idx of newStoneIndexes) {
                if (need <= 0) break;
                const st = stones[idx];
                const qty = n(st.quantity) || 1;
                const floor = floors.get(n(st.stoneMillimeter) || 0) ?? 0.01;
                const room = round2(((n(st.cost) || floor) - floor) * qty);
                const take = Math.min(room, need);
                if (take > 0) {
                  setStoneCost(st, Math.max(floor, round2((n(st.cost) || floor) - take / qty)));
                  need = round2(need - take);
                  lowered = round2(lowered + take);
                }
              }
              if (lowered > 0)
                warnings.push(`Lowered new stone cost on ${sspCode} by ${lowered} in total toward the sales price (never below 1 cent, sizes kept a cent apart).`);
              remainingOver = round2(need * scale);
            }
          }
          if (group && effectiveBaseCost != null && remainingOver > 0.01 && payloads.labor) {
            // Still over after stones: take the difference out of casting, then assembly.
            const duty = dutyRate;
            let need = round2(remainingOver / ((1 - setRate / 100) * (1 + duty)));
            const lab = payloads.labor;
            const trimmed = [];
            const cTot = n(lab.ttlLaborCastingCost) || 0;
            const takeC = Math.min(cTot, need);
            if (takeC > 0) {
              lab.ttlLaborCastingCost = round2(cTot - takeC);
              need = round2(need - takeC);
              trimmed.push(`casting -${round2(takeC)}`);
            }
            const nA = n(lab.noOfAssembly) || 0;
            const aTot = (n(lab.assemblyCharge) || 0) * nA;
            const takeA = Math.min(aTot, need);
            if (takeA > 0 && nA > 0) {
              lab.assemblyCharge = round2((aTot - takeA) / nA);
              need = round2(need - takeA);
              trimmed.push(`assembly -${round2(takeA)}`);
            }
            if (trimmed.length) {
              await sspUpdateLaborCost(settings, sspCode, itemId, lab);
              const liveVc = await sspGetVendorCost(settings, sspCode, itemId);
              await sspUpdateVendorCost(settings, sspCode, itemId, { ...(liveVc || {}), ...(payloads.vendorCost || {}) });
              warnings.push(
                `Over the sales-price target on ${sspCode}: trimmed ${trimmed.join(", ")} on this item to get toward ${priceTarget} (${targetSalesPrice} + the ${setRate}% rate).` +
                  (need > 0.01 ? ` Casting and assembly are used up, still about ${need} over before duty and rate.` : "")
              );
            } else {
              warnings.push(
                `${sspCode} item costs ${effectiveBaseCost} against a target of ${priceTarget} (${targetSalesPrice} + the ${setRate}% rate) and there is no casting or assembly cost on this sample to trim.`
              );
            }
          } else if (effectiveBaseCost == null) {
            warnings.push(`Could not read vendor cost on ${sspCode} to price toward sales price ${targetSalesPrice} — stones sent unchanged.`);
          } else if (newStoneQty === 0) {
            warnings.push(
              `${sspCode} has no new stones to adjust this run (all already created) — nothing available to price toward sales price ${targetSalesPrice}.`
            );
          }
        } catch (e) {
          warnings.push(`pricing stones toward sales price on ${sspCode}: ${e.message}`);
        }
      }

      // Stones — Kevin, 2026-09-16: "send a request to see if there is
      // stones and if not then resend them." Do one live GET up front so a
      // recorded stoneId is trusted only when it's actually confirmed on
      // the item right now, not just because we saved an id for it once.
      // sspGetItemStones is still an unconfirmed-guess endpoint, so if the
      // GET itself fails we fall back to the old cautious behaviour
      // (leave a recorded id alone rather than risk a duplicate add).
      let liveStonesForItem = null;
      let liveStonesError = null;
      try {
        liveStonesForItem = await sspGetItemStones(settings, sspCode, itemId);
      } catch (e) {
        liveStonesError = e;
      }

      for (let si = 0; si < stones.length; si++) {
        const existingStoneId = nextStoneIds[si] || 0;
        const confirmedLive =
          existingStoneId && Array.isArray(liveStonesForItem)
            ? liveStonesForItem.some((ls) => ls?.stoneId === existingStoneId)
            : null; // null = couldn't check either way

        if (existingStoneId && confirmedLive) {
          // Recorded id checks out live — nothing to do, no warning needed.
          continue;
        }
        if (existingStoneId && confirmedLive === null) {
          // Couldn't verify (GET itself failed) — keep the old cautious
          // skip rather than risk a duplicate add on a guess.
          warnings.push(
            `Stone ${existingStoneId} on item ${itemId} (${sspCode}) is recorded but could not be verified (${liveStonesError?.message || "get-stones failed"}) — left as-is, NOT resent.`
          );
          continue;
        }
        if (existingStoneId && confirmedLive === false) {
          warnings.push(
            `Stone ${existingStoneId} on item ${itemId} (${sspCode}) was recorded but a live check does not show it on the item — resending it now.`
          );
        }

        const addedStone = await sspAddStone(settings, sspCode, itemId, stones[si], 0);
        let newStoneId = addedStone.stoneId ?? 0;

        // Verify the resend itself -- Kevin, 2026-09-15: do NOT auto-clear
        // and retry within this same run just because a same-call re-GET
        // doesn't show it yet (that guess is exactly what created
        // duplicate ITEMs before). Keep the id SSP gave us; if it truly
        // isn't there, the NEXT run's live-check-before-skip above will
        // see that for real and resend it then, off a fresh GET rather
        // than a same-run guess.
        if (newStoneId) {
          try {
            const liveStones = await sspGetItemStones(settings, sspCode, itemId);
            const stillThere = liveStones.some((ls) => ls?.stoneId === newStoneId);
            if (!stillThere) {
              warnings.push(
                `SSP returned stoneId ${newStoneId} on ${sspCode} but a re-GET does not show it on item ${itemId} yet — it will be re-checked (and resent if still missing) on the next "Create in SSP" run for this item.`
              );
            }
          } catch (e) {
            warnings.push(
              `Could not verify stone ${newStoneId} on ${sspCode} (${e.message}) — the get-stones endpoint is unconfirmed, so this is not proof either way.`
            );
          }
        }

        nextStoneIds[si] = newStoneId;
        saveSspProgress(label, { sspCode, itemId, materialId, stoneIds: nextStoneIds });
        await persistSspLink(supabase, sample, { sspCode, itemId, materialId, stoneIds: nextStoneIds });
      }
      stoneIds = nextStoneIds;

      // Read-only check, no further write: report how close the final
      // number landed once stones (with their adjusted cost, if any) are
      // actually in. A miss here is just information -- there is nothing
      // left to automatically adjust once stones are exhausted.
      if (targetSalesPrice != null && targetSalesPrice > 0) {
        try {
          const finalVendorCost = await sspGetVendorCost(settings, sspCode, itemId);
          const finalCost = group ? memberCostOf(finalVendorCost) : n(finalVendorCost?.vendorPurchCost);
          // Same reimbursement-rate inflation as the first pass above --
          // finalCost is raw vendorPurchCost, sales price implies cost x
          // (1 + rate).
          const finalReimbursementRate = n(payloads.vendorCost?.vendorDiscountPerc);
          const finalEffectiveCost =
            !group && finalCost != null && finalReimbursementRate != null
              ? round2(finalCost * (1 + finalReimbursementRate / 100))
              : finalCost;
          const finalTarget = group ? setTarget : targetSalesPrice;
          if (finalEffectiveCost != null && Math.abs(finalTarget - finalEffectiveCost) > 0.01) {
            warnings.push(
              group
                ? `${sspCode} item cost is ${finalEffectiveCost}, target is ${finalTarget} (${targetSalesPrice} + the ${setRate}% rate) -- off by ${round2(finalTarget - finalEffectiveCost)}. Nothing left to adjust automatically.`
                : `${sspCode} vendorPurchCost is ${finalCost} (${finalEffectiveCost} after the ${finalReimbursementRate}% reimbursement rate), sales price is ${targetSalesPrice} -- off by ${round2(targetSalesPrice - finalEffectiveCost)}. No more already-filled fields available to close this automatically.`
            );
            reportStep("balance", "error", `off by ${round2(finalTarget - finalEffectiveCost)}`);
          } else {
            reportStep("balance", "success");
          }
        } catch (e) {
          warnings.push(`checking final vendor cost against sales price on ${sspCode}: ${e.message}`);
          reportStep("balance", "error", e.message);
        }
      }

      clearSspProgress(label); // fully created/updated — nothing left to resume
      created.push({ sample: label, sspCode, itemId, warnings });
    } catch (e) {
      reportStep(currentStep, "error", e?.message || String(e));
      failed.push({
        sample: label,
        sspCode, // non-null = partially created; a retry resumes from here
        error: e?.message || String(e),
      });
    }
  }
  return { enabled: true, created, failed, total: list.length };
}

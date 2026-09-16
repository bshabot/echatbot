import React, { Fragment, useState, useEffect, useRef } from "react";
import { ChevronDown, X, Upload } from "lucide-react";
import { Dialog, Transition } from "@headlessui/react";
import { metalTypes, getMetalType } from "../../utils/MetalTypeUtil";
import CalculatePrice from "./CalculatePrice";
import TotalCost from "./TotalCost";
import { getStatusColor } from "../../utils/designUtils";
import CustomSelect from "../CustomSelect";
import CategorySelect from "./SspCategorySelect";
import ImageUpload from "../ImageUpload";
import { useSupabase } from "../SupaBaseProvider";
import StonePropertiesForm from "../Products/StonePropertiesForm";
import { useGenericStore } from "../../store/VendorStore";
import { useMessage } from "../Messages/MessageContext";
import SampleLocationOptions from "./SampleLocationOptions";
import { logError } from "../../utils/logEvent";
const AddSampleModal = ({ isOpen, onClose, onSave, initialValues = null }) => {
  const { supabase } = useSupabase();

  // The type row supplies the SSP product type and the default category.
  // `category` here is the table of types (renamed on the record side only).
  const [typeRows, setTypeRows] = useState([]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from("category")
        .select("id,name,ssp_product_type,ssp_category");
      if (cancelled) return;
      if (error) console.error("Error fetching types:", error);
      setTypeRows(data || []);
    })();
    return () => {
      cancelled = true;
    };
  }, [supabase]);

  const vendorLossRef = useRef();
  const { getEntityItemById, getEntity } = useGenericStore();
  const vendors = getEntity("vendors");
  const { formFields } = getEntity("settings")?.options || {};

  // console.log(vendors, "vendors from add sample modal");
  const [lossPercent, setLossPercent] = useState(0);
  const [metalCost, setMetalCost] = useState(0);
  const { showMessage } = useMessage();
  // Fields the UI marks with a red "*" (Style Number, Manufacturer Code,
  // Weight) plus vendor (a hard NOT NULL in starting_info). Populated on a
  // failed submit attempt so each empty required input gets a red outline
  // and the message names exactly what's missing, instead of a generic
  // "please fill in the form" / only the first missing field.
  const [missingFields, setMissingFields] = useState(new Set());
  const fieldClass = (key, base = "mt-1 block input shadow-sm") =>
    missingFields.has(key) ? `${base} border-red-500 ring-1 ring-red-500` : base;
  const clearMissing = (key) => {
    if (!missingFields.has(key)) return;
    setMissingFields((prev) => {
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  };

  // Recover-unsaved-work: if a save fails after everything reaches the DB
  // (a bad connection, an unexpected constraint, a browser tab closed mid-
  // insert), the styleNumber/description/stones typed in are stashed here so
  // they aren't lost -- the error path calls saveDraft() before returning.
  // Kept as a LIST, not a single slot: each failed attempt adds its own
  // entry (so trying and failing twice doesn't clobber the first draft),
  // and a draft only goes away when the user explicitly deletes it or when
  // it's the one just restored and the resulting save actually succeeds --
  // never just because a new failure happened or the modal reopened.
  const DRAFT_KEY = "echatbot_add_sample_drafts";
  const [drafts, setDrafts] = useState([]); // [{ id, savedAt, formData, starting_info }]
  const [showDraftList, setShowDraftList] = useState(false);
  // Which draft (by id) is currently loaded into the form, if any -- only
  // this one gets cleared automatically on a successful save.
  const [activeDraftId, setActiveDraftId] = useState(null);
  const readDrafts = () => {
    try {
      const raw = window.localStorage.getItem(DRAFT_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      return [];
    }
  };
  const writeDrafts = (list) => {
    try {
      window.localStorage.setItem(DRAFT_KEY, JSON.stringify(list));
    } catch (e) {
      console.warn("Could not stash draft to localStorage", e);
    }
    setDrafts(list);
  };
  const saveDraft = () => {
    const list = readDrafts();
    list.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      savedAt: new Date().toISOString(),
      formData,
      starting_info,
    });
    writeDrafts(list);
  };
  const deleteDraft = (id) => {
    writeDrafts(readDrafts().filter((d) => d.id !== id));
    if (activeDraftId === id) setActiveDraftId(null);
  };
  // Only called after a save that actually reached the database, and only
  // for the specific draft that was restored into this attempt.
  const clearActiveDraftOnSave = () => {
    if (!activeDraftId) return;
    deleteDraft(activeDraftId);
  };
  useEffect(() => {
    if (!isOpen || initialValues) return; // don't fight a caller-supplied prefill
    setDrafts(readDrafts());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, initialValues]);
  const restoreDraft = (d) => {
    setFormData((prev) => ({ ...prev, ...d.formData }));
    setStarting_info((prev) => ({ ...prev, ...d.starting_info }));
    setActiveDraftId(d.id);
    setShowDraftList(false);
    showMessage("Draft restored — review and save.");
  };
  // Manual "Save Draft" button -- lets the user stash current progress into
  // the same draft history used for failed-save recovery, on demand.
  const handleSaveDraftClick = () => {
    saveDraft();
    setShowDraftList(true);
    showMessage("Draft saved to history.");
  };
  const finalizeImageRef = useRef(null);
  const finalizeCadRef = useRef(null);

  let starting_info_object = {
    description: "",
    metalType: "Gold",
    karat: "10K",
    color: "Yellow",
    height: 0,
    length: 0,
    width: 0,
    weight: "",
    ring_size: null,
    manufacturerCode: "",
    platingCharge: 0,
    stones: [],
    vendor: "",
    plating: 1,
    necklace: false,
    necklaceCost: 0,
    salesPrice: null,
    collection: null,
    type: null,
    category: null,
    status: "Working_on_it:yellow",
  };
  let starting_formData = {
    category: "",
    collection: "",
    selling_pair: "pairs",
    back_type: "none",
    custom_back_type: "",
    back_type_quantity: 0,
    // cost: 0,    name: "",
    styleNumber: "",
    salesWeight: 0,
    location: "",
    status: "Working_on_it:yellow",
  };
  const [formData, setFormData] = useState({ ...starting_formData });
  const [starting_info, setStarting_info] = useState({
    ...starting_info_object,
  });

  const typeRow =
    typeRows.find((t) => t.id === Number(starting_info?.type)) || null;

  useEffect(() => {
    if (!vendors || vendors.length === 0) return; // store not loaded yet
    setLossPercent(vendors[0]?.pricingsetting?.lossPercentage ?? 0);
    setStarting_info({ ...starting_info, vendor: vendors[0].id });
    // vendorLossRef.current.textContent = data[0].pricingsetting.lossPercentage
  }, [isOpen, vendors]);

  // Prefill from caller (e.g. Factory Costs / Labels "create sample" for a
  // PO line whose style isn't in the PLM yet). Only applied when the modal opens.
  useEffect(() => {
    if (isOpen && initialValues) {
      setFormData((prev) => ({ ...prev, ...initialValues }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

const finalizeMediaUpload = async (entity, entityId, styleNumber) => {
  const promises = [];

  if (finalizeImageRef.current) {
    promises.push(finalizeImageRef.current.finalizeUpload(entity, entityId, styleNumber));
  }
  if (finalizeCadRef.current) {
    promises.push(finalizeCadRef.current.finalizeUpload(entity, entityId, styleNumber));
  }

  await Promise.all(promises);
  // Both uploads are finished here
}
  const handleClose = () => {
    setFormData({
      cad: [],
      category: "",
      collection: "",
      selling_pair: "pairs",
      back_type: "none",
      custom_back_type: "",
      back_type_quantity: 0,
      // cost: 0,
      name: "",
      styleNumber: "",
      salesWeight: 0,
      location: "",
      status: "Working_on_it:yellow",
    });
    setStarting_info({
      description: "",
      images: [],
      metalType: "Gold",
      karat: "10K",
      color: "Yellow",
      height: 0,
      length: 0,
      width: 0,
      weight: "",
      manufacturerCode: "",
      platingCharge: 0,
      stones: [],
      vendor: "",
      plating: 1,
      status: "Working_on_it:yellow",
    });
    onClose();
  };
  const handleSubmit = async (e) => {
  e.preventDefault();

  // Validate required fields -- collect every empty one (not just the
  // first) so the message and the red outlines cover everything that
  // needs fixing in one pass.
  const missing = [];
  if (!formData.styleNumber) missing.push({ key: "styleNumber", label: "Style Number" });
  if (!starting_info.manufacturerCode) missing.push({ key: "manufacturerCode", label: "Manufacturer Code" });
  if (starting_info.weight === "" || starting_info.weight === null || starting_info.weight === undefined) {
    missing.push({ key: "weight", label: "Weight" });
  }
  if (!starting_info.vendor) missing.push({ key: "vendor", label: "Vendor" });
  if (missing.length > 0) {
    setMissingFields(new Set(missing.map((m) => m.key)));
    showMessage(`Please fill in: ${missing.map((m) => m.label).join(", ")}`);
    return;
  }
  setMissingFields(new Set());

  console.log("Form Data:", formData);

  // Destructure and sanitize starting_info
  const { stones, images, cad, ...startingInfo } = starting_info;

  const sanitizedStartingInfo = {
    ...startingInfo,
    // `type` is the bigint FK into the type list; `category` is SSP's
    // category as free text. Postgres rejects "" for a bigint column.
    type: startingInfo.type ? Number(startingInfo.type) : null,
    category: startingInfo.category || null,
    vendor: startingInfo.vendor ? Number(startingInfo.vendor) : null,
    weight: startingInfo.weight ? parseFloat(startingInfo.weight) : null,
    length: startingInfo.length ? parseFloat(startingInfo.length) : null,
    width: startingInfo.width ? parseFloat(startingInfo.width) : null,
    height: startingInfo.height ? parseFloat(startingInfo.height) : null,
    ring_size: startingInfo.ring_size ? parseFloat(startingInfo.ring_size) : null,
    platingCharge: startingInfo.platingCharge
      ? parseFloat(startingInfo.platingCharge)
      : null,
    laborCost: startingInfo.laborCost ? parseFloat(startingInfo.laborCost) : null,
    miscCost: startingInfo.miscCost ? parseFloat(startingInfo.miscCost) : null,
    necklaceCost: startingInfo.necklaceCost
      ? parseFloat(startingInfo.necklaceCost)
      : null,
    salesPrice: startingInfo.salesPrice
      ? parseFloat(startingInfo.salesPrice)
      : null,
    necklace:
      startingInfo.necklace === "true"
        ? true
        : startingInfo.necklace === "false"
        ? false
        : !!startingInfo.necklace,
  };

  // Sanitize formData
  // `category` on formData is a dead field -- never set by any UI control
  // (the actual picker writes to starting_info.category instead) -- and the
  // `samples` table has no `category` column at all, so sending it (even as
  // null) makes every insert fail with "Could not find the 'category'
  // column of 'samples' in the schema cache". Strip it out rather than
  // sanitize it.
  const { category: _deadCategoryField, ...formDataWithoutCategory } = formData;
  const sanitizedFormData = {
    ...formDataWithoutCategory,
    back_type_quantity: formData.back_type_quantity
      ? Number(formData.back_type_quantity)
      : null,
    salesWeight: formData.salesWeight ? parseFloat(formData.salesWeight) : null,
    // samples.collection is a bigint column, and Postgres rejects "" for
    // bigint -- null is what an unset value should mean.
    collection: formData.collection ? Number(formData.collection) : null,
    // Where the physical sample lives (tray number / shelf). Free text, and
    // blank means "not put away yet" — store null, not "", so the tray
    // dropdown in the filter bar never lists an empty entry.
    location: (formData.location || "").trim() || null,
  };

  try {
    // Insert sanitized starting_info
    const { data: startingInfoData, error: startingInfoError } = await supabase
      .from("starting_info")
      .insert([sanitizedStartingInfo])
      .select("id");

    if (startingInfoError) {
      console.error("Error inserting starting_info:", startingInfoError);
      // Log the exact attempted payload so Chaim/Ketty can retrieve it from
      // Settings > Sync Logs and re-save without re-typing the whole form.
      await logError(supabase, {
        source: "samples",
        action: "create-starting_info",
        message: `Failed to save starting info for ${formData.styleNumber || "(no style #)"}: ${startingInfoError.message}`,
        details: { payload: sanitizedStartingInfo, error: startingInfoError, styleNumber: formData.styleNumber },
      });
      showMessage(`Failed to save starting info: ${startingInfoError.message}`);
      saveDraft();
      return;
    }

    const startingInfoId = startingInfoData[0]?.id;

    // Insert stones if any. `stones` only has type/customType/color/shape/
    // size/quantity/cost/notes -- no `count` or `weight` columns, so those
    // must never be sent (Postgres rejects unknown columns on insert).
    if (stones && stones.length > 0) {
      const sanitizedStones = stones.map((stone) => ({
        type: stone.type,
        customType: stone.customType ?? null,
        color: stone.color ?? null,
        shape: stone.shape ?? null,
        size: stone.size !== "" && stone.size !== null && stone.size !== undefined ? String(stone.size) : null,
        quantity: stone.quantity ? Number(stone.quantity) : 1,
        cost: stone.cost ? parseFloat(stone.cost) : 0,
        notes: stone.notes ?? null,
        starting_info_id: startingInfoId,
      }));

      const { error: stoneError } = await supabase
        .from("stones")
        .insert(sanitizedStones);

      if (stoneError) {
        console.error("Error inserting stones:", stoneError);
        await logError(supabase, {
          source: "samples",
          action: "create-stones",
          message: `Failed to save stones for ${formData.styleNumber || "(no style #)"}: ${stoneError.message}`,
          details: { payload: sanitizedStones, error: stoneError, styleNumber: formData.styleNumber, startingInfoId },
        });
        showMessage(`Failed to save stones: ${stoneError.message}`);
        saveDraft();
        return;
      }
    }

    // Insert sanitized formData into samples
    const { data: sampleData, error: sampleError } = await supabase
      .from("samples")
      .insert([{ ...sanitizedFormData, starting_info_id: startingInfoId }])
      .select("*, starting_info(*)");

    if (sampleError) {
      console.error("Error inserting sample:", sampleError);
      await logError(supabase, {
        source: "samples",
        action: "create-sample",
        message: `Failed to save sample ${formData.styleNumber || "(no style #)"}: ${sampleError.message}`,
        details: { payload: { ...sanitizedFormData, starting_info_id: startingInfoId }, error: sampleError, styleNumber: formData.styleNumber },
      });
      showMessage(`Failed to save sample: ${sampleError.message}`);
      saveDraft();
      return;
    }

    // Finalize media uploads
    await finalizeMediaUpload("starting_info", startingInfoId, formData.styleNumber);

    // The rest of the app (SampleList/SampleCard, and Samples.jsx's
    // handleClick) works with rows shaped like `sample_with_stones_export`
    // (keyed by `sample_id`, with images/status flattened in) -- not the
    // raw `samples` row this insert returns (keyed by `id`, no images).
    // Passing the raw row through made the freshly-added card look right
    // but crash when clicked: handleClick reads `sample.sample_id`, found
    // undefined, and queried `...eq("id", undefined)`, which Postgres
    // rejects with `invalid input syntax for type integer: "undefined"` --
    // and the crash, not just a failed fetch, came from the code after
    // that call assuming the fetch had succeeded. Re-fetch in the shape
    // the list actually expects so the new card behaves exactly like every
    // other one; fall back to the raw row (aliased) only if that fails, so
    // a save that already succeeded never gets stuck here.
    const newSampleId = sampleData[0]?.id;
    let newRowForList = sampleData[0] ? { ...sampleData[0], sample_id: newSampleId } : sampleData[0];
    if (newSampleId != null) {
      const { data: exportedRow, error: exportError } = await supabase
        .from("sample_with_stones_export")
        .select("*")
        .eq("sample_id", newSampleId)
        .maybeSingle();
      if (exportError) {
        console.warn("Could not re-fetch new sample in list shape:", exportError);
      } else if (exportedRow) {
        newRowForList = exportedRow;
      }
    }

    // Reset form and close modal
    onSave(newRowForList);
    setFormData({ ...starting_formData });
    setStarting_info({ ...starting_info_object });
    clearActiveDraftOnSave();
    setActiveDraftId(null);
    showMessage("Sample added successfully!");
  } catch (error) {
    console.error("Unexpected error:", error);
    await logError(supabase, {
      source: "samples",
      action: "create-sample",
      message: `Unexpected error saving sample ${formData.styleNumber || "(no style #)"}: ${error?.message || error}`,
      details: {
        payload: { starting_info: sanitizedStartingInfo, stones, sample: sanitizedFormData },
        error: error?.message || String(error),
        styleNumber: formData.styleNumber,
      },
    });
    showMessage(`An unexpected error occurred: ${error?.message || error}`);
    saveDraft();
  }
};
  const handleCustomSelect = (option) => {
    console.log(option, "option from custom select");
    const { categories, value } = option;
    setStarting_info({ ...starting_info, [categories]: value });
    console.log(starting_info, "form data from custom select");
  };
  const limitInput = (e) => {
    let value = e.target.value;

    if (value.includes(".") && value.split(".")[1].length > 2) {
      console.log(value.slice(0, value.indexOf(".") + 3));
      setStarting_info({
        ...starting_info,
        [e.target.name]: parseFloat(value.slice(0, value.indexOf(".") + 3)),
      });
    } else {
      setStarting_info({
        ...starting_info,
        [e.target.name]: parseFloat(value),
      });
    }
  };
  const handleInputChange = (e) => {
    const { name, value } = e.target;
    setFormData({ ...formData, [name]: value });
  };

  // console.log(
  //   Array.isArray(starting_info.images),
  //   "images from form data in add smaple modal"
  // );

  return (
    <Transition appear show={isOpen} as={Fragment}>
            {/* onClose left as a no-op deliberately: headlessui fires it on
          BOTH an outside/backdrop click AND Escape, which was silently
          discarding in-progress form edits on a stray click. Only the
          explicit close/cancel button in this modal closes it now. */}
      <Dialog as="div" className="relative z-50" onClose={() => {}}>
        <Transition.Child
          as={Fragment}
          enter="ease-out duration-300"
          enterFrom="opacity-0"
          enterTo="opacity-100"
          leave="ease-in duration-200"
          leaveFrom="opacity-100"
          leaveTo="opacity-0"
        >
          <div className="fixed inset-0 bg-black/30" />
        </Transition.Child>

        <div className="fixed inset-0 overflow-y-auto">
          <div className="flex min-h-full items-center justify-center p-4">
            <Transition.Child
              as={Fragment}
              enter="ease-out duration-300"
              enterFrom="opacity-0 scale-95"
              enterTo="opacity-100 scale-100"
              leave="ease-in duration-200"
              leaveFrom="opacity-100 scale-100"
              leaveTo="opacity-0 scale-95"
            >
              <Dialog.Panel className="w-full max-w-6xl max-h-[90vh] flex flex-col transform overflow-hidden rounded-2xl bg-white shadow-2xl">
                <div className="flex justify-between items-center p-6 border-b shrink-0">
                  <Dialog.Title className="text-xl font-semibold text-gray-900">
                    Add Sample
                  </Dialog.Title>
                  <button
                    onClick={handleClose}
                    className="text-gray-400 hover:text-gray-500"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>

                <form onSubmit={handleSubmit} className="flex flex-col flex-1 min-h-0">
                  {drafts.length > 0 && (
                    <div className="mx-6 mt-4 rounded-md border border-amber-300 bg-amber-50 text-sm text-amber-800">
                      <div className="flex items-center justify-between gap-3 px-3 py-2">
                        <span>
                          {drafts.length} unsaved draft{drafts.length === 1 ? "" : "s"} recovered from a save that never reached the database.
                        </span>
                        <button
                          type="button"
                          onClick={() => setShowDraftList((v) => !v)}
                          className="rounded bg-amber-600 px-2.5 py-1 text-white hover:bg-amber-700 shrink-0"
                        >
                          Restore
                        </button>
                      </div>
                      {showDraftList && (
                        <div className="border-t border-amber-200 divide-y divide-amber-200">
                          {drafts
                            .slice()
                            .sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt))
                            .map((d) => (
                              <div key={d.id} className="flex items-center justify-between gap-3 px-3 py-2">
                                <span>
                                  {new Date(d.savedAt).toLocaleString()}
                                  {d.formData?.styleNumber ? ` — Style ${d.formData.styleNumber}` : " — (no style #)"}
                                  {activeDraftId === d.id ? " (loaded in form)" : ""}
                                </span>
                                <span className="flex gap-2 shrink-0">
                                  <button
                                    type="button"
                                    onClick={() => restoreDraft(d)}
                                    className="rounded bg-amber-600 px-2 py-1 text-white hover:bg-amber-700"
                                  >
                                    Restore
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => deleteDraft(d.id)}
                                    className="rounded border border-amber-400 px-2 py-1 text-amber-700 hover:bg-amber-100"
                                  >
                                    Delete
                                  </button>
                                </span>
                              </div>
                            ))}
                        </div>
                      )}
                    </div>
                  )}
                  <div className="flex-1 min-h-0 overflow-y-auto p-6">
                  <div className="flex flex-row max-md:flex-col">
                    <div className=" pr-6 max-md:pr-0">
                      <div className="flex justify-between items-start flex-col min-h-[70vh] max-md:min-h-0 overflow-y-auto">
                        {/* this is the image upload  */}
                        <div>
                          <label className="block text-sm font-medium text-gray-700">
                            Images
                          </label>
                          <ImageUpload
                            collection="image"
                            images={starting_info.images || []}
                            // onUpload={(newImages) =>
                            //   setUploadedImages([
                            //     ...uploadedImages,
                            //     ...newImages,
                            //   ])
                            // }
                            ref={finalizeImageRef}
                            // onChange={async (images) => {
                            //   setStarting_info({
                            //     ...starting_info,
                            //     images: images,
                            //   });
                            //   // await updateDataBaseWithImages(images, sample.id)
                            // }}
                          />
                          <ImageUpload
                            collection="cad"
                            ref={finalizeCadRef}
                            // onUpload={(newImages) =>
                            //   setUploadedImages([
                            //     ...uploadedImages,
                            //     ...newImages,
                            //   ])
                            // }
                            images={starting_info.cad || []}
                            // onChange={(cad) =>
                            //   setFormData({ ...starting_info, cad: cad })
                            // }
                          />
                        </div>
                        {/* this is the status function */}
                        <div className="mt-6 mb-2 flex justify-center w-full ">
                          <div className="flex flex-col ">
                            <label htmlFor="status" className="self-start">
                              Status:
                            </label>
                            <select
                              name="status"
                              onChange={(e) =>
                                setFormData({
                                  ...formData,
                                  status: e.target.value,
                                })
                              }
                              value={formData.status}
                              className={`${getStatusColor(
                                formData.status
                              )} mt-1  border border-gray-300 rounded-md p-2 appearance-none focus:outline-none focus:ring-2 focus:ring-blue-500`}
                            >
                              <option value="Working_on_it:yellow">
                                Working on it
                              </option>
                              <option value="Quote_created:blue">
                                Quote Created
                              </option>
                              <option value="Running_line:green">
                                Running Line
                              </option>
                              <option value="Dead:red">Dead</option>
                            </select>
                          </div>
                        </div>
                        <div className="w-full">
                          <TotalCost
                            metalCost={metalCost}
                            miscCost={starting_info.miscCost}
                            laborCost={starting_info.laborCost}
                            stones={starting_info.stones}
                            platingCharge={starting_info.platingCharge}
                            updateTotalCost={(cost) =>
                              setStarting_info({
                                ...starting_info,
                                totalCost: cost,
                              })
                            }
                          />
                        </div>
                      </div>
                    </div>

                    <div className=" flex-1 space-y-6">
                      <div className="flex flex-row gap-2 w-full max-md:flex-col">
                        <div className="w-full ">
                          <label className="block text-sm font-medium text-gray-700">
                            Style Number <span className="text-red-500">*</span>
                          </label>
                          <input
                            required
                            type="text"
                            className={fieldClass("styleNumber")}
                            value={formData.styleNumber}
                            onChange={(e) => {
                              setFormData({
                                ...formData,
                                styleNumber: e.target.value,
                              });
                              clearMissing("styleNumber");
                            }}
                          />
                        </div>

                        <div className="w-full ">
                          <label className="block text-sm font-medium text-gray-700">
                            Manufacturer Code{" "}
                            <span className="text-red-500">*</span>
                          </label>
                          <input
                            required
                            type="text"
                            className={fieldClass("manufacturerCode")}
                            value={starting_info.manufacturerCode}
                            onChange={(e) => {
                              setStarting_info({
                                ...starting_info,
                                manufacturerCode: e.target.value,
                              });
                              clearMissing("manufacturerCode");
                            }}
                          />
                        </div>
                      </div>

                      <div className="flex flex-row gap-2 w-full max-md:flex-col">
                        <div className="w-full">
                          <label className="block text-sm font-medium text-gray-700">
                            Product Sku
                          </label>
                          <input
                            // required
                            type="text"
                            className="mt-1 block input shadow-sm  flex-1"
                            value={formData.name}
                            onChange={(e) =>
                              setFormData({ ...formData, name: e.target.value })
                            }
                          />
                        </div>
                        <div className="w-full">
                          <label className="block  text-sm font-medium text-gray-700">
                            Vendor
                          </label>
                          <div className="relative w-full">
                            <select
                              name="vendor"
                              onChange={(e) => {
                                setStarting_info({
                                  ...starting_info,
                                  vendor: e.target.value,
                                });
                                setLossPercent(
                                  getEntityItemById(
                                    "vendors",
                                    Number(e.target.value)
                                  )?.pricingsetting?.lossPercentage ?? 0
                                );
                                clearMissing("vendor");
                              }}
                              value={starting_info.vendor}
                              className={fieldClass("vendor", "mt-1 border input p-2 appearance-none")}
                            >
                              {vendors.map((vendor, index) => {
                                return (
                                  <option key={index} value={vendor.id}>
                                    {vendor.name}
                                  </option>
                                );
                              })}
                            </select>
                            <ChevronDown className="absolute top-4 right-3 text-gray-500 pointer-events-none" />
                          </div>
                        </div>
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700">
                          Description
                        </label>
                        <textarea
                          rows={2}
                          className="mt-1 block input shadow-sm focus:border-blue-500 focus:ring-blue-500"
                          value={starting_info.description}
                          onChange={(e) =>
                            setStarting_info({
                              ...starting_info,
                              description: e.target.value,
                            })
                          }
                        />
                      </div>

                      {/* this is metal properties div */}
                      <div>
                        <label htmlFor=""> Metal Propeties</label>
                        <br className="border-2 border-gray-300 w-full" />

                        <div className="flex flex-col">
                          <label htmlFor=""> Metal Type</label>
                          <div className="relative w-full">
                            <select
                              name="metalType"
                              id=""
                              onChange={(e) => {
                                const selectedMetalType = e.target.value;
                                const metal = getMetalType(selectedMetalType);

                                setStarting_info({
                                  ...starting_info,
                                  metalType: selectedMetalType,
                                  karat: metal.karat[0], // default to first karat
                                  color: metal.color[0], // default to first color
                                });
                              }}
                              value={starting_info.metalType}
                              className={` mt-1  border border-gray-300 rounded-md p-2 appearance-none focus:outline-none focus:ring-2 focus:ring-blue-500 w-full`}
                            >
                              {metalTypes.map((metalType, index) => {
                                return (
                                  <option key={index} value={metalType.type}>
                                    {metalType.type}
                                  </option>
                                );
                              })}
                            </select>
                            <ChevronDown className="absolute top-4 right-3 text-gray-500 pointer-events-none" />
                          </div>
                        </div>
                        <div className="flex flex-col w-full">
                          <label htmlFor=""> Karat</label>
                          <div className="relative w-full">
                            <select
                              name="karat"
                              id=""
                              onChange={(e) =>
                                setStarting_info({
                                  ...starting_info,
                                  karat: e.target.value,
                                })
                              }
                              value={starting_info.karat}
                              className={` mt-1  border border-gray-300 rounded-md p-2 appearance-none focus:outline-none focus:ring-2 focus:ring-blue-500 w-full`}
                            >
                              {getMetalType(starting_info.metalType).karat.map(
                                (karat, index) => {
                                  return (
                                    <option key={index} value={karat}>
                                      {karat}
                                    </option>
                                  );
                                }
                              )}
                            </select>
                            <ChevronDown className="absolute top-4 right-3 text-gray-500 pointer-events-none" />
                          </div>
                        </div>
                        <div className="flex flex-col">
                          <label htmlFor=""> Color</label>
                          <div className="relative w-full">
                            <select
                              name="color"
                              id=""
                              onChange={(e) =>
                                setStarting_info({
                                  ...starting_info,
                                  color: e.target.value,
                                })
                              }
                              value={formData.color}
                              className={` mt-1  border border-gray-300 rounded-md p-2 appearance-none focus:outline-none focus:ring-2 focus:ring-blue-500 w-full`}
                            >
                              {getMetalType(starting_info.metalType).color.map(
                                (color, index) => {
                                  return (
                                    <option key={index} value={color}>
                                      {color}
                                    </option>
                                  );
                                }
                              )}
                            </select>
                            <ChevronDown className="absolute top-4 right-3 text-gray-500 pointer-events-none" />
                          </div>
                        </div>
                      </div>
                      {/*this is weight sectiion  */}

                      <div className="flex flex-row gap-2 w-full max-md:flex-col">
                        <div className="w-full">
                          <label htmlFor="">
                            Weight <span className="text-red-500">*</span>
                          </label>
                          <div className="relative flex items-center gap-1 ">
                            <span className="w-full relative">
                              <input
                                type="text"
                                inputMode="decimal"
                                placeholder="Enter Weight"
                                className={fieldClass("weight", "mt-1 block input shadow-sm focus:border-blue-500 focus:ring-blue-500 w-full pr-14")}
                                value={starting_info.weight}
                                required={true}
                                onChange={(e) => {
                                  setStarting_info({
                                    ...starting_info,
                                    weight: e.target.value,
                                  });
                                  clearMissing("weight");
                                }}
                              />
                            </span>
                            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 text-sm pointer-events-none">
                              grams
                            </span>
                          </div>
                        </div>
                        <div className="w-full">
                          <label htmlFor="">Sales Weight</label>
                          <div className="relative flex items-center gap-1 ">
                            <span className="w-full relative">
                              <input
                                type="text"
                                inputMode="decimal"
                                placeholder="Enter Weight"
                                className="mt-1 block input shadow-sm focus:border-blue-500 focus:ring-blue-500 w-full pr-14"
                                value={formData.salesWeight}
                                onChange={(e) =>
                                  setFormData({
                                    ...formData,
                                    salesWeight: e.target.value,
                                  })
                                }
                              />
                            </span>
                            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 text-sm pointer-events-none">
                              grams
                            </span>
                          </div>
                        </div>
                      </div>

                      <div className="w-full">
                        <CalculatePrice
                          type={starting_info.metalType}
                          weight={starting_info.weight}
                          karat={starting_info.karat}
                          lossPercent={lossPercent}
                          onMetalCostChange={setMetalCost}
                        />
                      </div>

                      {/* this is loss section */}
                      <div className="flex flex-row w-full flex-1 justify-between max-md:flex-col max-md:gap-2">
                        <div className="w-md">
                          <label htmlFor="loss">Loss Percent</label>
                          <div className="flex items-center gap-1 flex-1">
                            <span
                              ref={vendorLossRef}
                              className="mt-1 block input shadow-sm focus:border-blue-500 focus:ring-blue-500"
                            >
                              {lossPercent}
                            </span>
                            <span>%</span>
                          </div>
                        </div>

                        {/* this is the separation between loss and plating input fields */}
                        <div className="flex flex-row gap-2 justify-center max-md:flex-col">
                          <div className="flex flex-col justify-center flex-1">
                            <label htmlFor="plating">Plating</label>
                            <CustomSelect
                              onSelect={handleCustomSelect}
                              version={"plating"}
                              informationFromDataBase={starting_info.plating}
                            />
                          </div>
                          <div className="flex-1">
                            <label htmlFor="plating_charge">
                              Plating Charge
                            </label>
                            <input
                              type="number"
                              value={starting_info.platingCharge}
                              name="platingCharge"
                              onChange={limitInput}
                              className="mt-1 block input shadow-sm focus:border-blue-500 focus:ring-blue-500 flex-1"
                            />
                          </div>
                        </div>
                      </div>

                      {/* this is the stone properties */}
                      <div>
                        <StonePropertiesForm
                          stones={starting_info.stones || []}
                          onChange={(stones) => {
                            setStarting_info({ ...starting_info, stones });
                          }}
                        />
                      </div>

                      <div className="flex flex-row gap-2 max-md:flex-col">
                        <div>
                          <label className="block text-sm font-medium text-gray-700">
                            Labor Cost
                          </label>
                          <div className="mt-1 relative rounded-md shadow-sm">
                            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                              <span className="text-gray-500 sm:text-sm">
                                $
                              </span>
                            </div>
                            <input
                              type="number"
                              step="0.01"
                              min="0"
                              name="laborCost"
                              value={starting_info.laborCost || 0}
                              onChange={limitInput}
                              className="w-full input pl-7 pr-3 py-2"
                            />
                          </div>
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-gray-700">
                            Misc Cost
                          </label>
                          <div className="mt-1 relative rounded-md shadow-sm">
                            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                              <span className="text-gray-500 sm:text-sm">
                                $
                              </span>
                            </div>
                            <input
                              type="number"
                              step="0.01"
                              min="0"
                              name="miscCost"
                              value={starting_info.miscCost || 0}
                              onChange={limitInput}
                              className="w-full input pl-7 pr-3 py-2"
                            />
                          </div>
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-gray-700">
                            Sales Price
                          </label>
                          <div className="mt-1 relative rounded-md shadow-sm">
                            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                              <span className="text-gray-500 sm:text-sm">
                                $
                              </span>
                            </div>
                            <input
                              type="number"
                              step="0.01"
                              min="0"
                              name="salesPrice"
                              value={starting_info.salesPrice ?? ""}
                              onChange={limitInput}
                              placeholder="0.00"
                              className="w-full input pl-7 pr-3 py-2"
                            />
                          </div>
                        </div>
                      </div>

                      <div className="flex flex-row justify-center gap-2 max-md:flex-col ">
                        <div className="flex w-full flex-col">
                          <label htmlFor="back_type">Back Type</label>
                          <div className="flex flex-row gap-2 max-md:flex-col">
                            <div className="relative w-full">
                              <select
                                name="back_type"
                                id=""
                                className="mt-1  border border-gray-300 rounded-md p-2 appearance-none focus:outline-none focus:ring-2 focus:ring-blue-500 w-full"
                                value={formData.back_type}
                                onChange={(e) =>
                                  setFormData({
                                    ...formData,
                                    back_type: e.target.value,
                                  })
                                }
                              >
                                {formFields?.backType?.map((backType, index) => (
                                  <option
                                    key={index}
                                    value={backType.toLowerCase()}
                                  >
                                    {backType}
                                  </option>
                                ))}
                              </select>
                              <ChevronDown className="absolute top-4 right-3 text-gray-500 pointer-events-none" />
                              {formData.back_type === "other" && (
                                <input
                                  type="text"
                                  className="mt-1  input pr-7 pl-3 py-2"
                                  placeholder="Enter custom back type"
                                  value={formData.custom_back_type}
                                  onChange={(e) =>
                                    setFormData({
                                      ...formData,
                                      custom_back_type: e.target.value,
                                    })
                                  }
                                />
                              )}
                            </div>
                          </div>
                        </div>
                        <div className=" w-full">
                          <label htmlFor="back_type_quantity">
                            Back Type Quantity
                          </label>
                          <input
                            type="number"
                            className="mt-1  input pr-7 pl-3 py-2"
                            value={formData.back_type_quantity}
                            onChange={(e) =>
                              setFormData({
                                ...formData,
                                back_type_quantity: e.target.value,
                              })
                            }
                          />
                        </div>
                      </div>
                      <div className="flex flex-col ">
                        <label htmlFor="selling_pair">Selling type</label>
                        <div className="relative w-full">
                          <select
                            name="selling_pair"
                            id=""
                            className="mt-1  border border-gray-300 rounded-md p-2 appearance-none focus:outline-none focus:ring-2 focus:ring-blue-500 w-full"
                            value={formData.selling_pair}
                            onChange={(e) =>
                              setFormData({
                                ...formData,
                                selling_pair: e.target.value,
                              })
                            }
                          >
                            {formFields?.sellingType?.map((type, index) => (
                              <option key={index} value={type.toLowerCase()}>
                                {type}
                              </option>
                            ))}
                            {/* <option value="pair">Pair</option>
                            <option value="single">Single</option> */}
                          </select>
                          <ChevronDown className="absolute top-4 right-3 text-gray-500 pointer-events-none" />
                        </div>
                      </div>
                      <div className="flex flex-col">
                        <label htmlFor="location">Location</label>
                        <input
                          id="location"
                          name="location"
                          type="text"
                          list="sample-location-options"
                          placeholder="e.g. Tray 12"
                          className="mt-1 input pr-7 pl-3 py-2"
                          value={formData.location ?? ""}
                          onChange={(e) =>
                            setFormData({
                              ...formData,
                              location: e.target.value,
                            })
                          }
                        />
                        <SampleLocationOptions />
                      </div>
                      <div className="flex flex-row gap-2 max-md:flex-col">
                        <div>
                          <label
                            htmlFor="board"
                            className="text-sm font-medium text-gray-700"
                          >
                            Board
                          </label>
                          <CustomSelect
                            onSelect={handleCustomSelect}
                            informationFromDataBase={starting_info.collection}
                            version={"collection"}
                            hidden={true}
                          />
                        </div>

                        <div className="mb-10">
                          <label
                            htmlFor="type"
                            className="text-sm font-medium text-gray-700"
                          >
                            Type
                          </label>
                          <CustomSelect
                            onSelect={handleCustomSelect}
                            informationFromDataBase={starting_info.type}
                            version={"category"}
                            field={"type"}
                            hidden={false}
                          />
                        </div>

                        <div className="mb-10">
                          <CategorySelect
                            productType={typeRow?.ssp_product_type}
                            value={starting_info.category}
                            defaultValue={typeRow?.ssp_category}
                            onChange={(next) =>
                              setStarting_info((prev) => ({ ...prev, category: next }))
                            }
                          />
                        </div>

                      </div>
                      {/* necklace */}
                      <div className="flex flex-row gap-2 items-center max-md:flex-col">
                        <div className="w-full">
                          <label className="block text-sm font-medium text-gray-700">
                            Necklace
                          </label>
                          <div className="mt-1 relative rounded-md shadow-sm ">
                            <select
                              name="necklace"
                              value={starting_info.necklace || false}
                              onChange={(e) =>
                                setStarting_info({
                                  ...starting_info,
                                  necklace: e.target.value,
                                })
                              }
                              //   className="w-full input pl-7 pr-3 py-2"
                              className={` mt-1  border border-gray-300 rounded-md p-2 appearance-none focus:outline-none focus:ring-2 focus:ring-blue-500 w-full`}
                            >
                              <option value="false">No</option>
                              <option value="true">Yes</option>
                            </select>

                            <ChevronDown className="absolute top-4 right-3 text-gray-500 pointer-events-none" />
                          </div>
                        </div>
                        <div className="w-full">
                          <label className="block text-sm font-medium text-gray-700">
                            Necklase Cost
                          </label>
                          <div className="mt-1 relative rounded-md shadow-sm  ">
                            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                              <span className="text-gray-500 sm:text-sm">
                                $
                              </span>
                            </div>
                            <input
                              type="number"
                              step="0.01"
                              min="0"
                              name="necklaceCost"
                              value={starting_info.necklaceCost || 0}
                              onChange={limitInput}
                              className="w-full input pl-7 pr-3 py-2"
                            />
                          </div>
                        </div>
                      </div>
                      {/* dimensions */}
                      <div>
                        <label htmlFor="dims">Dimensions</label>
                        <div className="flex flex-row gap-2 ">
                          <div className=" relative rounded-md shadow-sm w-full">
                            <label htmlFor="length">Length</label>
                            <div className="absolute inset-y-0 right-0 pr-3 flex items-center justify-center pointer-events-none">
                              <span className="text-gray-500 sm:text-sm">
                                mm
                              </span>
                            </div>
                            <input
                              type="number"
                              className="mt-1  input pr-7 pl-3 py-2"
                              value={starting_info.length}
                              onChange={(e) => {
                                setStarting_info({
                                  ...starting_info,
                                  length: e.target.value,
                                });
                              }}
                            />
                          </div>
                          <div className=" relative rounded-md shadow-sm w-full">
                            <label htmlFor="width">Width</label>
                            <div className="absolute inset-y-0 right-0 pr-3 flex items-center justify-center pointer-events-none">
                              <span className="text-gray-500 sm:text-sm">
                                mm
                              </span>
                            </div>
                            <input
                              type="number"
                              className="mt-1  input pr-7 pl-3 py-2"
                              value={starting_info.width}
                              onChange={(e) => {
                                setStarting_info({
                                  ...starting_info,
                                  width: e.target.value,
                                });
                              }}
                            />
                          </div>
                          <div className=" relative rounded-md shadow-sm w-full">
                            <label htmlFor="height">Height</label>
                            <div className="absolute inset-y-0 right-0 pr-3 flex items-center justify-center pointer-events-none">
                              <span className="text-gray-500 sm:text-sm">
                                mm
                              </span>
                            </div>
                            <input
                              type="number"
                              className="mt-1  input pr-7 pl-3 py-2"
                              value={starting_info.height}
                              onChange={(e) => {
                                setStarting_info({
                                  ...starting_info,
                                  height: e.target.value,
                                });
                              }}
                            />
                          </div>
                        </div>
                        {typeRow?.ssp_product_type === "rings" && (
                          <div className="mt-2 relative rounded-md shadow-sm w-full max-w-[200px]">
                            <label htmlFor="ring_size">Ring Size</label>
                            <input
                              type="number"
                              step="0.25"
                              min="0"
                              className="mt-1 input pr-3 pl-3 py-2"
                              value={starting_info.ring_size ?? ""}
                              onChange={(e) => {
                                setStarting_info({
                                  ...starting_info,
                                  ring_size: e.target.value,
                                });
                              }}
                            />
                          </div>
                        )}
                      </div>

                      <div className="flex flex-col w-full">
                        <label htmlFor="notes">Notes</label>
                        <textarea
                          value={formData.notes}
                          onChange={(e) =>
                            setFormData({ ...formData, notes: e.target.value })
                          }
                          rows={3}
                          placeholder="Optional notes"
                          className="mt-1 input w-full "
                        />
                      </div>
                      {/* <TotalCost
                        metalCost={metalCost}
                        miscCost={starting_info.miscCost}
                        laborCost={starting_info.laborCost}
                        stones={starting_info.stones}
                        updateTotalCost={(cost) =>
                          setStarting_info({
                            ...starting_info,
                            totalCost: cost,
                          })
                        }
                      /> */}
                    </div>
                  </div>

                  </div>

                  <div className="flex justify-end space-x-3 border-t px-6 py-4 shrink-0 bg-white">
                    <button
                      type="button"
                      onClick={handleClose}
                      className="px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 border border-gray-300 rounded-md"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={handleSaveDraftClick}
                      className="px-4 py-2 text-sm font-medium text-amber-700 hover:bg-amber-50 border border-amber-400 rounded-md"
                    >
                      Save Draft
                    </button>
                    <button
                      type="submit"
                      className="px-4 py-2 text-sm font-medium text-white bg-chabot-gold hover:bg-opacity-90 rounded-md"
                    >
                      Add Sample
                    </button>
                  </div>
                </form>
              </Dialog.Panel>
            </Transition.Child>
          </div>
        </div>
      </Dialog>
    </Transition>
  );
};

export default AddSampleModal;

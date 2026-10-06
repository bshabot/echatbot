import React, { useEffect, Fragment, useState } from "react";
import useEscapeKey from "../../Hooks/useEscapeKey";
import { Dialog, Transition } from "@headlessui/react";
import {getMetalCost} from "../Samples/CalculatePrice";
import TotalCost from "../Samples/TotalCost";
import { formatDate } from "../../utils/dateUtils";
import { X, Pencil, ImageIcon } from 'lucide-react';
import { useSupabase } from "../SupaBaseProvider";
import { useGenericStore } from "../../store/VendorStore";
import { useMetalPriceStore } from "../../store/MetalPrices";
import { useMessage } from "../Messages/MessageContext";
const STATUS_BADGE = {
  green: "bg-green-100 text-green-800",
  yellow: "bg-yellow-100 text-yellow-800",
  red: "bg-red-100 text-red-800",
  blue: "bg-blue-100 text-blue-800",
  grey: "bg-gray-200 text-gray-700",
};

export default function DesignApprovalForm({ design, openEditModal, isOpen, onClose,updateDesign }) {
  useEscapeKey(onClose, isOpen);
  const {getEntityItemById,getEntity}= useGenericStore()
  const vendors = getEntity('vendors');
  const [styleNumber,setStyleNumber] = useState('')
  const {prices}=useMetalPriceStore()
  const { supabase } = useSupabase();
  const {showMessage } =useMessage()
  let totalCost = 0
  useEffect(() => {
    console.log("design in design approval form", design);
  }, [design]);
  
 const handleUpdateStatus = async (status) => {
   if(status === "Approved:green") {
     if(styleNumber===''){
       showMessage('Style Number is required')
       return
     }

      const { data: existingSample, error: sampleCheckError } = await supabase
      .from("samples")
      .select("*")
      .eq("designId", design.designId)
      .single();

    if (sampleCheckError && sampleCheckError.code !== "PGRST116") {
      // Handle unexpected errors (e.g., database issues)
      console.error("Error checking for existing sample:", sampleCheckError);
      showMessage("An error occurred while checking for existing samples.");
      return;
    }

    if (existingSample) {
      // If a sample already exists, prevent further approval
      showMessage("A sample already exists for this design. Approval denied.");
      return;
    }

      const { data, error } = await supabase
        .from("samples")
        .insert([{
          designId:design.designId,
          starting_info_id: parseInt(design.id),
          status: "Working_on_it:yellow",
          styleNumber: styleNumber
          // totalCost: totalCost
        }])
        .select()
        const {data:updateStartingInfoCost} = await supabase
        .from('starting_info')
        .update({totalCost:totalCost,status:'Approved:green'})
        .eq('id',design.id)
        const {error:designUpdateError} = await supabase
        .from('designs')
        .update({ sample_id: data[0].id })
        .eq('id', data[0].designId);

      if (error||designUpdateError) {
        console.error("Error updating design status:", error||designUpdateError);
        // showMessage('A Sample Already Exists With This Quote')
        return;
      }
    }

    const { data, error } = await supabase
      .from("starting_info")
      .update({ status: status })
      .eq("id", design.id)
      .select("*");

    if (error) {
      console.error("Error updating design status:", error);
      return;
    }
    console.log(data, "data from click");
    updateDesign(data[0]);
    // setIsDetailsOpen(true);
  }
  return (
    <Transition appear show={isOpen} as={Fragment}>
            {/* onClose left as a no-op deliberately: headlessui fires it on
          BOTH an outside/backdrop click AND Escape, which was silently
          discarding in-progress form edits on a stray click. Only the
          explicit close/cancel button in this modal closes it now. */}
      <Dialog as="div" className="relative z-50" onClose={() => {}}>
        <Transition.Child
          as={Fragment}
          enter="ease-out duration-300" leave="ease-in duration-200"
          enterFrom="opacity-0" enterTo="opacity-100"
          leaveFrom="opacity-100" leaveTo="opacity-0"
        >
          <div className="fixed inset-0 bg-black bg-opacity-50" />
        </Transition.Child>

        <div className="fixed inset-0 overflow-y-auto">
          <div className="flex min-h-full items-center justify-center p-4">
            <Transition.Child
              as={Fragment}
              enter="ease-out duration-300" leave="ease-in duration-200"
              enterFrom="opacity-0 scale-95" enterTo="opacity-100 scale-100"
              leaveFrom="opacity-100 scale-100" leaveTo="opacity-0 scale-95"
            >
              <Dialog.Panel className="w-full max-w-lg max-h-[90vh] flex flex-col transform overflow-hidden rounded-2xl bg-white text-left align-middle shadow-2xl transition-all">
                {/* Header */}
                <div className="flex items-start justify-between gap-3 px-6 py-4 border-b shrink-0">
                  <div className="min-w-0">
                    <Dialog.Title className="text-lg font-semibold text-gray-900">
                      Review design quote
                    </Dialog.Title>
                    {design.name && (
                      <p className="text-sm text-gray-500 truncate">{design.name}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      onClick={() => {
                        openEditModal(design); // Open the edit modal
                        onClose(); // Close the approval form
                      }}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[13px] text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={onClose}
                      aria-label="Close"
                      className="p-1.5 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100"
                    >
                      <X className="w-5 h-5" />
                    </button>
                  </div>
                </div>

                {/* Body */}
                <div className="flex-1 min-h-0 overflow-y-auto p-6 bg-white space-y-5">
                  {/* Summary */}
                  <div className="pt-5 first:pt-0 border-t border-gray-200 first:border-t-0">
                    <div className="flex gap-4">
                      <div className="w-24 h-24 shrink-0 rounded-lg border border-gray-200 bg-white flex items-center justify-center overflow-hidden">
                        {design.images?.[0] ? (
                          <img
                            src={`${process.env.VITE_DB_HOST_URL}${design.images[0]}`}
                            alt="Design"
                            className="w-full h-full object-contain"
                          />
                        ) : (
                          <ImageIcon className="w-7 h-7 text-gray-300" />
                        )}
                      </div>
                      <div className="flex-1 min-w-0 text-sm">
                        <span
                          className={`inline-block text-xs font-medium px-2.5 py-0.5 rounded-full ${
                            STATUS_BADGE[String(design.status || "").split(":")[1]] || "bg-gray-100 text-gray-700"
                          }`}
                        >
                          {String(design.status || "No status").split(":")[0].replaceAll("_", " ")}
                        </span>
                        <p className="mt-2 text-gray-800 break-words">
                          {design.description || <span className="text-gray-400">No description</span>}
                        </p>
                      </div>
                    </div>
                    <div className="mt-4 pt-3 border-t border-gray-100 grid grid-cols-2 gap-3 text-xs text-gray-500">
                      <div>
                        <div className="uppercase tracking-wide text-[10px] text-gray-400">Created</div>
                        <div className="text-gray-700 text-[13px]">{formatDate(design.created_at)}</div>
                      </div>
                      <div>
                        <div className="uppercase tracking-wide text-[10px] text-gray-400">Last updated</div>
                        <div className="text-gray-700 text-[13px]">{formatDate(design.updated_at)}</div>
                      </div>
                    </div>
                  </div>

                  {/* Cost */}
                  <div className="pt-5 first:pt-0 border-t border-gray-200 first:border-t-0">
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-3">Cost</h3>
                    <TotalCost
                      metalCost={getMetalCost(prices?.[String(design.metalType || "").toLowerCase()]?.price ?? 0,design.weight,design.karat,getEntityItemById("vendors",design.vendor)?.pricingsetting?.lossPercentage)}
                      miscCost={design.miscCost}
                      laborCost={design.laborCost}
                      stones={design.stones}
                      platingCharge={design.platingCharge}
                      updateTotalCost={(cost) => (totalCost = cost)}
                    />
                  </div>

                  {/* Approval */}
                  <div className="pt-5 first:pt-0 border-t border-gray-200 first:border-t-0">
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500">Approve as a sample</h3>
                    <p className="text-xs text-gray-500 mt-0.5">
                      Approving creates a sample with this style number. Declining or requesting a revision doesn&apos;t need one.
                    </p>
                    <label htmlFor="approval-style-number" className="block text-sm font-medium text-gray-700 mt-3">
                      Style number <span className="text-red-500">*</span>
                    </label>
                    <input
                      id="approval-style-number"
                      type="text"
                      className="mt-1 block input shadow-sm"
                      placeholder="e.g. GPFB154-10KYG"
                      value={styleNumber}
                      onChange={(e) => setStyleNumber(e.target.value)}
                    />
                  </div>
                </div>

                {/* Actions */}
                <div className="flex flex-wrap items-center justify-end gap-2 border-t px-6 py-4 shrink-0 bg-white text-sm font-medium">
                  <button
                    type="button"
                    className="px-4 py-2 rounded-lg border border-red-300 text-red-700 hover:bg-red-50"
                    onClick={() => {
                      handleUpdateStatus("Declined:red");
                      onClose();
                    }}
                  >
                    Decline
                  </button>
                  <button
                    type="button"
                    className="px-4 py-2 rounded-lg border border-amber-400 text-amber-800 hover:bg-amber-50"
                    onClick={() => {
                      handleUpdateStatus("Revision_Requested:yellow");
                      onClose();
                    }}
                  >
                    Request revision
                  </button>
                  <button
                    type="button"
                    className={`px-4 py-2 rounded-lg text-white ${
                      styleNumber.trim().length === 0
                        ? "bg-gray-300 cursor-not-allowed"
                        : "bg-green-600 hover:bg-green-700"
                    }`}
                    title={styleNumber.trim().length === 0 ? "Enter a style number first" : undefined}
                    onClick={() => {
                      handleUpdateStatus("Approved:green");
                      onClose();
                    }}
                    disabled={styleNumber.trim().length === 0}
                  >
                    Approve &amp; create sample
                  </button>
                </div>
              </Dialog.Panel>
            </Transition.Child>
          </div>
        </div>
      </Dialog>
    </Transition>
  );
}

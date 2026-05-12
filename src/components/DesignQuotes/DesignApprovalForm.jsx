import React, { useEffect, Fragment, useState } from "react";
import { Dialog, Transition } from "@headlessui/react";
import {getMetalCost} from "../Samples/CalculatePrice";
import TotalCost from "../Samples/TotalCost";
import { formatDate } from "../../utils/dateUtils";
import { ChevronDown, X,Upload } from 'lucide-react';
import { useSupabase } from "../SupaBaseProvider";
import { useGenericStore } from "../../store/VendorStore";
import { useMetalPriceStore } from "../../store/MetalPrices";
import { useMessage } from "../Messages/MessageContext";
export default function DesignApprovalForm({ design, openEditModal, isOpen, onClose,updateDesign }) {
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
  console.log(getEntityItemById('vendors',design.vendor)?.pricingsetting?.lossPercentage,design)
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
      <Dialog as="div" className="relative z-50" onClose={onClose}>
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
              <Dialog.Panel className="w-full max-w-md transform overflow-hidden rounded-2xl bg-white p-6 text-left align-middle shadow-xl transition-all">
                
                <div className="flex justify-between items-center p-6 border-b">
                                              <Dialog.Title className="text-xl font-semibold text-gray-900">
                                                Approval Form
                                              </Dialog.Title>
                                              <button
                                                onClick={onClose}
                                                className="text-gray-400 hover:text-gray-500"
                                              >
                                                <X className="w-5 h-5" />
                                              </button>
                                            </div>
                  <div className="p-2 flex"> <button
  onClick={() => {
    openEditModal(design); // Open the edit modal
    onClose(); // Close the approval form
  }}
  className="hover:text-black text-gray-500 text-sm self-end justify-self-end"
>
  ✏️
</button></div>

                {/* Status & Description */}
                <div className="mb-4 text-sm">
                  <div className="flex justify-between">
                    <span className="text-gray-500">Status</span>
                    <span className="bg-gray-200 text-xs px-2 py-0.5 rounded">{design.status.split(':')[0].replaceAll('_',' ')}</span>
                  </div>
                  <div className="flex justify-between mt-1">
                    <span className="text-gray-500">Description</span>
                    <span className="font-medium">{design.description}</span>
                  </div>
                </div>

                {/* Timestamps */}
                <div className="text-sm text-gray-500 mb-4">
                  <div className="flex justify-between">
                    <span>Created</span>
                    <span>{formatDate(design.created_at)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Last Updated</span>
                    <span>{formatDate(design.updated_at)}</span>
                  </div>
                </div>

                {/* Cost */}
                <div className="mb-4 w-full">
                  
                  <TotalCost
                    metalCost={getMetalCost(prices[design.metalType.toLowerCase()].price,design.weight,design.karat,getEntityItemById("vendors",design.vendor)?.pricingsetting?.lossPercentage)}
                    miscCost={design.miscCost}
                    laborCost={design.laborCost}
                    stones={design.stones}
                    updateTotalCost={(cost)=> totalCost=cost}
                   />
                </div>

                {/* Image */}
                <div className="mb-4">
                  <h3 className="text-sm font-semibold mb-2">Images</h3>
                  <img
                    src={`${process.env.VITE_DB_HOST_URL}${design.images[0]|| ''}`}
                    alt="Sample"
                    className="w-20 h-20 object-contain"
                  />
                </div>
                <form action="">
                  <div className="mb-4">
                    <h3 className="text-sm font-semibold mb-2">Style Number (Required)</h3>
                    <input type="text"
                              className="mt-1 block input shadow-sm "
                              required={true}
                      value={styleNumber}
                      onChange={(e)=> setStyleNumber(e.target.value)}
                    />
                  </div>
                </form>

                {/* Action Buttons */}
                <div className="flex gap-2 justify-end text-sm font-medium mt-6">
                <button className="bg-red-500 text-white px-3 py-1 rounded hover:bg-red-600"
                    onClick={() => {handleUpdateStatus("Declined:red")
                      onClose()
                    }}>
                    Decline
                  </button>
                  <button className="bg-yellow-400 text-black px-3 py-1 rounded hover:bg-yellow-500"
                  onClick={() => {handleUpdateStatus("Revision_Requested:yellow")
                    onClose()
                  }}>

                    Request Revision
                  </button>
                  
                  <button className={` text-white px-3 py-1 rounded  ${styleNumber.length===0? 'bg-gray-500 hover:cursor-not-allowed ': 'bg-green-500 hover:bg-green-600'}`}
                    onClick={() => {handleUpdateStatus("Approved:green")
                      
                        onClose()
                    }}
                    disabled={styleNumber.length===0}
                  >
                    Approve And Create Sample
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

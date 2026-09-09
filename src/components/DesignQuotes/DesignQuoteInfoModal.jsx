import { useState, useEffect ,useRef} from "react";

import DesignQuoteForm from "./DesignQuoteForm";

import { useSupabase } from "../SupaBaseProvider";

import { useGenericStore } from "../../store/VendorStore";

const DesignQuoteInfoModal = ({ isOpen, onClose, design, updateDesign }) => {
  const { getEntityItemById, getEntity } = useGenericStore();
  const vendors = getEntity("vendors");
  const { supabase } = useSupabase();
    const finalizeUploadRef = useRef(null)
  
  const [lossPercent, setLossPercent] = useState(0);
    const [uploadedImages,setUploadedImages]= useState([])
  
  const [originalData, setOriginalData] = useState({
    ...design,
    images: design.images || [],
  });
  const [formData, setFormData] = useState({
    ...design,
    images: design.images || [],
  });


  useEffect(() => {
    console.log(formData.images, "formData images");
  }, [formData.images]);

  useEffect(() => {
    setLossPercent(vendors[0].pricingsetting.lossPercentage);
  }, [isOpen]);
  const getRemovedImages = (originalImages, currentImages) => {
    return originalImages.filter((image) => !currentImages.includes(image));
  };
  
  const areObjectsEqual = (obj1, obj2) => {
    return JSON.stringify(obj1) === JSON.stringify(obj2);
  };
  const arraysEqual = (arr1, arr2) => {
    if (!Array.isArray(arr1) || !Array.isArray(arr2)) return false;
    if (arr1.length !== arr2.length) return false;

    return arr1.every(
      (item, index) => JSON.stringify(item) === JSON.stringify(arr2[index])
    );
  };

  const getObjectDifferences = (formData, originalData) => {
    const changes = {};

    Object.keys(formData).forEach((key) => {
      const formValue = formData[key];
      const originalValue = originalData[key];

      // Handle arrays (like images and cad)
      if (Array.isArray(formValue) && Array.isArray(originalValue)) {
        if (!arraysEqual(formValue, originalValue)) {
          changes[key] = formValue;
        }
      } else if (JSON.stringify(formValue) !== JSON.stringify(originalValue)) {
        changes[key] = formValue;
      }
    });

    return changes;
  };

  const handleEditSubmit = async (e) => {
    e.preventDefault();
    if (areObjectsEqual(formData, originalData)) {
      console.log("No field changes detected — finalizing any staged media");
      // Staged image uploads aren't part of formData, so an image-only edit
      // lands here — link them before closing or the upload is dropped.
      if (finalizeUploadRef.current?.finalizeUpload) {
        await finalizeUploadRef.current.finalizeUpload(
          "starting_info",
          design.id,
          formData.manufacturerCode,
          uploadedImages
        );
      }
      onClose();
      return;
    }
    console.log("Changes detected");
    const updates = getObjectDifferences(formData, originalData);
    console.log("updates:", updates);
    // Proceed with the update logic'

    const removedImages = getRemovedImages(
      originalData.images,
      formData.images
    );
    if(updates.hasOwnProperty('manufacturerCode')){
      await handleUpdateImageManufactoreCode(design.id,updates.manufacturerCode)
    }
    const { data, error } = await supabase
      .from("starting_info")
      .update(updates)
      .eq("id", design.id)
      .select();

    if (error) {
      console.error("Error updating design:", error);
    } else {
      console.log("design updated:", data);
      updateDesign({ ...data[0] });
    }
      if (finalizeUploadRef.current?.finalizeUpload) {
      await finalizeUploadRef.current.finalizeUpload(
      'starting_info',data[0].id,data[0].manufacturerCode,uploadedImages)
    }
    onClose();
  };
  const handleUpdateImageManufactoreCode= async(designQuotesId,manufacturerCode)=>{
    const {data,error} = await supabase.from('image_link').update({styleNumber:manufacturerCode}).eq('entityId',designQuotesId).eq('entity','designQuote').select('styleNumber')
    if(error){
      console.error('style code was not updated');
    }
    console.log('style number was updated :',data[0].styleNumber)
  }
 
  return (
    
         <DesignQuoteForm
              isOpen={isOpen}
              onClose={onClose}
              formData={formData}
              setFormData={setFormData}
              handleSubmit={handleEditSubmit}
              lossPercent={lossPercent}
              setLossPercent={setLossPercent}
              finalizeUploadRef={finalizeUploadRef}
              onUpload={(newImages)=> setUploadedImages([...uploadedImages,...newImages])}
              isEditing
            />
    // <Transition appear show={isOpen} as={Fragment}>
    //   <Dialog as="div" className="relative z-50" onClose={onClose}>
    //     <Transition.Child
    //       as={Fragment}
    //       enter="ease-out duration-300"
    //       enterFrom="opacity-0"
    //       enterTo="opacity-100"
    //       leave="ease-in duration-200"
    //       leaveFrom="opacity-100"
    //       leaveTo="opacity-0"
    //     >
    //       <div className="fixed inset-0 bg-black/30" />
    //     </Transition.Child>

    //     <div className="fixed inset-0 overflow-y-auto">
    //       <div className="flex min-h-full items-center justify-center p-4">
    //         <Transition.Child
    //           as={Fragment}
    //           enter="ease-out duration-300"
    //           enterFrom="opacity-0 scale-95"
    //           enterTo="opacity-100 scale-100"
    //           leave="ease-in duration-200"
    //           leaveFrom="opacity-100 scale-100"
    //           leaveTo="opacity-0 scale-95"
    //         >
    //           <Dialog.Panel className="w-full  transform overflow-hidden rounded-2xl bg-white shadow-xl">
    //             <div className="flex justify-between items-center p-6 border-b">
    //               <Dialog.Title className="text-xl font-semibold text-gray-900">
    //                 Edit Design
    //               </Dialog.Title>
    //               <button
    //                 onClick={onClose}
    //                 className="text-gray-400 hover:text-gray-500"
    //               >
    //                 <X className="w-5 h-5" />
    //               </button>
    //             </div>

    //             <form onSubmit={handleSubmit} className="p-6">
    //               <div className="flex flex-row">
    //                 <div className=" pr-6 ">
    //                   <div className="flex justify-between items-start flex flex-col min-h-[70vh] overflow-y-auto">
    //                     {/* this is the image upload  */}
    //                     <div>
    //                       <label className="block text-sm font-medium text-gray-700">
    //                         Images
    //                       </label>
    //                       <ImageUpload
    //                         images={formData.images}
    //                         onChange={
    //                           (images) => setFormData({ ...formData, images })
    //                           // console.log(images, "images from onchange")
    //                         }
    //                       />
    //                     </div>
    //                     {/* this is the status function */}
    //                     <div className="mt-6 mb-2 flex justify-center w-full ">
    //                       <div className="flex flex-col ">
    //                         <label htmlFor="status" className="self-start">
    //                           Status:
    //                         </label>
    //                         <select
    //                           name="status"
    //                           onChange={(e) =>
    //                             setFormData({
    //                               ...formData,
    //                               status: e.target.value,
    //                             })
    //                           }
    //                           value={formData.status}
    //                           className={`${getStatusColor(
    //                             formData.status
    //                           )} mt-1  border border-gray-300 rounded-md p-2 appearance-none focus:outline-none focus:ring-2 focus:ring-blue-500`}
    //                         >
    //                           <option value="Working_On_It:yellow">
    //                             Working on it
    //                           </option>
    //                           <option value="Waiting_On_Cads:grey">
    //                             Waiting on cads
    //                           </option>
    //                           <option value="Sample_Created:green">
    //                             Sample created
    //                           </option>
    //                           <option value="Received_Quote:blue">
    //                             Receieved quote
    //                           </option>
    //                           <option value="Dead:red">Dead</option>
    //                         </select>
    //                       </div>
    //                     </div>
    //                   </div>
    //                 </div>

    //                 <div className=" flex-1 space-y-6">
    //                   <div className="w-full flex flex-row gap-2">
    //                     <div className="w-full">
    //                       <label className="block  text-sm font-medium text-gray-700">
    //                         Vendor
    //                       </label>
    //                       <div className="relative w-full">
    //                         <select
    //                           name="vendor"
    //                           onChange={(e) => {
    //                             setFormData({
    //                               ...formData,
    //                               vendor: e.target.value,
    //                             });
    //                             setLossPercent(
    //                               getEntityItemById('vendors',Number(e.target.value))
    //                                 .pricingsetting.lossPercentage
    //                             );
    //                           }}
    //                           value={formData.vendor}
    //                           className={` mt-1 border input  p-2 appearance-none `}
    //                         >
    //                           {vendors.map((vendor, index) => {
    //                             return (
    //                               <option key={index} value={vendor.id}>
    //                                 {vendor.name}
    //                               </option>
    //                             );
    //                           })}
    //                         </select>
    //                         <ChevronDown className="absolute top-4 right-3 text-gray-500 pointer-events-none" />
    //                       </div>
    //                     </div>
    //                     <div className="w-full ">
    //                       <label className="block text-sm font-medium text-gray-700">
    //                         Manufacturer Code
    //                       </label>
    //                       <input
    //                         required
    //                         type="text"
    //                         className="mt-1 block input shadow-sm  "
    //                         value={formData.manufacturerCode}
    //                         onChange={(e) =>
    //                           setFormData({
    //                             ...formData,
    //                             manufacturerCode: e.target.value,
    //                           })
    //                         }
    //                       />
    //                     </div>
    //                   </div>
    //                   <div>
    //                     <label className="block text-sm font-medium text-gray-700">
    //                       Description
    //                     </label>
    //                     <textarea
    //                       rows={3}
    //                       className="mt-1 block input shadow-sm focus:border-blue-500 focus:ring-blue-500"
    //                       value={formData.description}
    //                       onChange={(e) =>
    //                         setFormData({
    //                           ...formData,
    //                           description: e.target.value,
    //                         })
    //                       }
    //                     />
    //                   </div>
    //                   {/* this is metal properties div */}
    //                   <div>
    //                                           <label htmlFor=""> Metal Propeties</label>
    //                                           <br className="border-2 border-gray-300 w-full" />
                      
    //                                           <div className="flex flex-col">
    //                                             <label htmlFor=""> Metal Type</label>
    //                                             <div className="relative w-full">
                      
    //                                             <select
    //                                               name="metalType"
    //                                               id=""
    //                                               onChange={(e) => {
    //                                                 const selectedMetalType = e.target.value;
    //                                                 const metal = getMetalType(selectedMetalType);
                      
    //                                                 setFormData({
    //                                                   ...formData,
    //                                                   metalType: selectedMetalType,
    //                                                   karat: metal.karat[0], // default to first karat
    //                                                   color: metal.color[0], // default to first color
    //                                                 });
    //                                               }}
    //                                               value={formData.metalType}
    //                                               className={` mt-1  border border-gray-300 rounded-md p-2 appearance-none focus:outline-none focus:ring-2 focus:ring-blue-500 w-full`}
                      
    //                                             >
    //                                               {metalTypes.map((metalType, index) => {
    //                                                 return (
    //                                                   <option key={index} value={metalType.type}>
    //                                                     {metalType.type}
    //                                                   </option>
    //                                                 );
    //                                               })}
    //                                             </select>
    //                                             <ChevronDown className="absolute top-4 right-3 text-gray-500 pointer-events-none" />
    //                                             </div>
    //                                           </div>
    //                                           <div className="flex flex-col">
    //                                             <label htmlFor=""> Karat</label>
    //                                             <div className="relative w-full">
                      
    //                                             <select
    //                                               name="karat"
    //                                               id=""
    //                                               onChange={(e) =>
    //                                                 setFormData({
    //                                                   ...formData,
    //                                                   karat: e.target.value,
    //                                                 })
    //                                               }
    //                                               value={formData.karat}
    //                                               className={` mt-1  border border-gray-300 rounded-md p-2 appearance-none focus:outline-none focus:ring-2 focus:ring-blue-500 w-full`}
    //                                               >
    //                                               {getMetalType(formData.metalType).karat.map(
    //                                                 (karat, index) => {
    //                                                   return (
    //                                                     <option key={index} value={karat}>
    //                                                       {karat}
    //                                                     </option>
    //                                                   );
    //                                                 }
    //                                               )}
    //                                             </select>
    //                                             <ChevronDown className="absolute top-4 right-3 text-gray-500 pointer-events-none" />
    //                                             </div>
    //                                           </div>
    //                                           <div className="flex flex-col">
    //                                             <label htmlFor=""> Color</label>
    //                                             <div className="relative w-full">
                      
    //                                             <select
    //                                               name="color"
    //                                               id=""
    //                                               onChange={(e) =>
    //                                                 setFormData({
    //                                                   ...formData,
    //                                                   color: e.target.value,
    //                                                 })
    //                                               }
    //                                               value={formData.color}
    //                                               className={` mt-1  border border-gray-300 rounded-md p-2 appearance-none focus:outline-none focus:ring-2 focus:ring-blue-500 w-full`}
    //                                               >
    //                                               {getMetalType(formData.metalType).color.map(
    //                                                 (color, index) => {
    //                                                   return (
    //                                                     <option key={index} value={color}>
    //                                                       {color}
    //                                                     </option>
    //                                                   );
    //                                                 }
    //                                               )}
    //                                             </select>
    //                                             <ChevronDown className="absolute top-4 right-3 text-gray-500 pointer-events-none" />
    //                                             </div>
    //                                           </div>
    //                                         </div>
    //                   <div className="w-full">
    //                     <label htmlFor="">Weight</label>
    //                     <div className="flex items-center gap-1 ">
    //                       <span className="w-full relative">
    //                         <input
    //                           type="text"
    //                           placeholder="Enter Weight"
    //                           className="mt-1 block input shadow-sm focus:border-blue-500 focus:ring-blue-500 w-full "
    //                           value={formData.weight}
    //                           onChange={(e) =>
    //                             setFormData({
    //                               ...formData,
    //                               weight: e.target.value,
    //                             })
    //                           }
    //                         />
    //                       </span>
    //                       <span className="absolute right-10 text-gray-500 pointer-events-none">
    //                         grams
    //                       </span>
    //                     </div>
    //                   </div>
    //                   {/* this is loss section */}
    //                   <div className="flex flex-row w-full flex-1 justify-between">
    //                     <div className="w-md">
    //                       <label htmlFor="loss">Loss Percent</label>
    //                       <div className="flex items-center gap-1 flex-1">
    //                         <span
    //                           ref={vendorLossRef}
    //                           className="mt-1 block input shadow-sm focus:border-blue-500 focus:ring-blue-500"
    //                         >
    //                           {lossPercent}
    //                         </span>
    //                         <span>%</span>
    //                       </div>
    //                     </div>

    //                     {/* this is the separation between loss and plating input fields */}
    //                     <div className="flex flex-row gap-2 justify-center">
    //                       <div className="flex flex-col justify-center flex-1">
    //                         <label htmlFor="plating">Plating</label>
    //                         <CustomSelect
    //                           onSelect={handleCustomSelect}
    //                           version={"plating"}
    //                           informationFromDataBase={formData.plating}
    //                         />
    //                       </div>
    //                       <div className="flex-1">
    //                         <label htmlFor="plating_charge">
    //                           Plating Charge
    //                         </label>
    //                         <input
    //                           type="number"
    //                           value={formData.platingCharge}
    //                           name="platingCharge"
    //                           onChange={limitInput}
    //                           className="mt-1 block input shadow-sm focus:border-blue-500 focus:ring-blue-500 flex-1"
    //                         />
    //                       </div>
    //                     </div>
    //                   </div>
    //                   {/* this is the stone properties */}
    //                   <div>
    //                     <StonePropertiesForm
    //                       stones={formData.stones || []}
    //                       onChange={(stones) => {
    //                         setFormData({ ...formData, stones });
    //                       }}
    //                     />
    //                   </div>
    //                   <div className="flex flex-row gap-2">
    //                     <div>
    //                       <label className="block text-sm font-medium text-gray-700">
    //                         Labor Cost
    //                       </label>
    //                       <div className="mt-1 relative rounded-md shadow-sm">
    //                         <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
    //                           <span className="text-gray-500 sm:text-sm">
    //                             $
    //                           </span>
    //                         </div>
    //                         <input
    //                           type="number"
    //                           step="0.01"
    //                           min="0"
    //                           name="laborCost"
    //                           value={formData.laborCost || 0}
    //                           onChange={limitInput}
    //                           className="w-full input pl-7 pr-3 py-2"
    //                         />
    //                       </div>
    //                     </div>
    //                     <div>
    //                       <label className="block text-sm font-medium text-gray-700">
    //                         Misc Cost
    //                       </label>
    //                       <div className="mt-1 relative rounded-md shadow-sm">
    //                         <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
    //                           <span className="text-gray-500 sm:text-sm">
    //                             $
    //                           </span>
    //                         </div>
    //                         <input
    //                           type="number"
    //                           step="0.01"
    //                           min="0"
    //                           name="miscCost"
    //                           value={formData.miscCost || 0}
    //                           onChange={limitInput}
    //                           className="w-full input pl-7 pr-3 py-2"
    //                         />
    //                       </div>
    //                     </div>
    //                   </div>
    //                   <div>
    //                     <label htmlFor="dims">Dimensions</label>
    //                     <div className="flex flex-row gap-2 ">
    //                       <div className=" relative rounded-md shadow-sm w-full">
    //                         <label htmlFor="length">Length</label>
    //                         <div className="absolute inset-y-0 right-0 pr-3 flex items-center justify-center pointer-events-none">
    //                           <span className="text-gray-500 sm:text-sm">
    //                             mm
    //                           </span>
    //                         </div>
    //                         <input
    //                           type="number"
    //                           className="mt-1  input pr-7 pl-3 py-2"
    //                           value={formData.length}
    //                           onChange={(e) => {
    //                             setFormData({
    //                               ...formData,
    //                               length: e.target.value,
    //                             });
    //                           }}
    //                         />
    //                       </div>
    //                       <div className=" relative rounded-md shadow-sm w-full">
    //                         <label htmlFor="width">Width</label>
    //                         <div className="absolute inset-y-0 right-0 pr-3 flex items-center justify-center pointer-events-none">
    //                           <span className="text-gray-500 sm:text-sm">
    //                             mm
    //                           </span>
    //                         </div>
    //                         <input
    //                           type="number"
    //                           className="mt-1  input pr-7 pl-3 py-2"
    //                           value={formData.width}
    //                           onChange={(e) => {
    //                             setFormData({
    //                               ...formData,
    //                               width: e.target.value,
    //                             });
    //                           }}
    //                         />
    //                       </div>
    //                       <div className=" relative rounded-md shadow-sm w-full">
    //                         <label htmlFor="height">Height</label>
    //                         <div className="absolute inset-y-0 right-0 pr-3 flex items-center justify-center pointer-events-none">
    //                           <span className="text-gray-500 sm:text-sm">
    //                             mm
    //                           </span>
    //                         </div>
    //                         <input
    //                           type="number"
    //                           className="mt-1  input pr-7 pl-3 py-2"
    //                           value={formData.height}
    //                           onChange={(e) => {
    //                             setFormData({
    //                               ...formData,
    //                               height: e.target.value,
    //                             });
    //                           }}
    //                         />
    //                       </div>
    //                     </div>
    //                   </div>
    //                 </div>
    //               </div>

    //               <div className="mt-6 flex justify-end space-x-3">
    //                 <button
    //                   type="button"
    //                   onClick={onClose}
    //                   className="px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 border border-gray-300 rounded-md"
    //                 >
    //                   Cancel
    //                 </button>
    //                 <button
    //                   type="submit"
    //                   className="px-4 py-2 text-sm font-medium text-white bg-chabot-gold hover:bg-opacity-90 rounded-md"
    //                 >
    //                   Edit Design Quote
    //                 </button>
    //               </div>
    //             </form>
    //           </Dialog.Panel>
    //         </Transition.Child>
    //       </div>
    //     </div>
    //   </Dialog>
    // </Transition>
  );
};

export default DesignQuoteInfoModal;

import React, { Fragment, useState, useEffect, useRef } from "react";
import { ChevronDown, X, Upload } from "lucide-react";
import { Dialog, Transition } from "@headlessui/react";
import { metalTypes, getMetalType } from "../../utils/MetalTypeUtil";
import CalculatePrice from "./CalculatePrice";
import TotalCost from "./TotalCost";
import { getStatusColor } from "../../utils/designUtils";
import CustomSelect from "../CustomSelect";
import ImageUpload from "../ImageUpload";
import { useSupabase } from "../SupaBaseProvider";
import StonePropertiesForm from "../Products/StonePropertiesForm";
import { useGenericStore } from "../../store/VendorStore";
import { useMessage } from "../Messages/MessageContext";
const AddSampleModal = ({ isOpen, onClose, onSave }) => {
  const { supabase } = useSupabase();
  const vendorLossRef = useRef();
  const { getEntityItemById, getEntity } = useGenericStore();
  const vendors = getEntity("vendors");
  const { formFields } = getEntity("settings")?.options || {};

  // console.log(vendors, "vendors from add sample modal");
  const [lossPercent, setLossPercent] = useState(0);
  const [metalCost, setMetalCost] = useState(0);
  const { showMessage } = useMessage();
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
    weight: 0,
    manufacturerCode: "",
    platingCharge: 0,
    stones: [],
    vendor: "",
    plating: 1,
    necklace: false,
    necklaceCost: 0,
    collection: null,
    category: null,
    status: "Working_on_it:yellow",
  };
  let starting_formData = {
    category: "",
    collection: "",
    selling_pair: "pair",
    back_type: "none",
    custom_back_type: "",
    back_type_quantity: 0,
    // cost: 0,    name: "",
    styleNumber: "",
    salesWeight: 0,
    status: "Working_on_it:yellow",
  };
  const [formData, setFormData] = useState({ ...starting_formData });
  const [starting_info, setStarting_info] = useState({
    ...starting_info_object,
  });

  useEffect(() => {
    setLossPercent(vendors[0].pricingsetting.lossPercentage);
    setStarting_info({ ...starting_info, vendor: vendors[0].id });
    // vendorLossRef.current.textContent = data[0].pricingsetting.lossPercentage
  }, [isOpen, vendors]);

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
      selling_pair: "pair",
      back_type: "none",
      custom_back_type: "",
      back_type_quantity: 0,
      // cost: 0,
      name: "",
      styleNumber: "",
      salesWeight: 0,
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
      weight: 0,
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

  // Validate required fields
  if (!formData.styleNumber) {
    showMessage("Please add a styleNumber");
    return;
  }

  console.log("Form Data:", formData);

  // Destructure and sanitize starting_info
  const { stones, images, cad, ...startingInfo } = starting_info;

  const sanitizedStartingInfo = {
    ...startingInfo,
    vendor: startingInfo.vendor ? Number(startingInfo.vendor) : null,
    weight: startingInfo.weight ? parseFloat(startingInfo.weight) : null,
    length: startingInfo.length ? parseFloat(startingInfo.length) : null,
    width: startingInfo.width ? parseFloat(startingInfo.width) : null,
    height: startingInfo.height ? parseFloat(startingInfo.height) : null,
    platingCharge: startingInfo.platingCharge
      ? parseFloat(startingInfo.platingCharge)
      : null,
    laborCost: startingInfo.laborCost ? parseFloat(startingInfo.laborCost) : null,
    miscCost: startingInfo.miscCost ? parseFloat(startingInfo.miscCost) : null,
    necklaceCost: startingInfo.necklaceCost
      ? parseFloat(startingInfo.necklaceCost)
      : null,
    necklace:
      startingInfo.necklace === "true"
        ? true
        : startingInfo.necklace === "false"
        ? false
        : !!startingInfo.necklace,
  };

  // Sanitize formData
  const sanitizedFormData = {
    ...formData,
    back_type_quantity: formData.back_type_quantity
      ? Number(formData.back_type_quantity)
      : null,
    salesWeight: formData.salesWeight ? parseFloat(formData.salesWeight) : null,
  };

  try {
    // Insert sanitized starting_info
    const { data: startingInfoData, error: startingInfoError } = await supabase
      .from("starting_info")
      .insert([sanitizedStartingInfo])
      .select("id");

    if (startingInfoError) {
      console.error("Error inserting starting_info:", startingInfoError);
      showMessage("Failed to save starting info.");
      return;
    }

    const startingInfoId = startingInfoData[0]?.id;

    // Insert stones if any
    if (stones && stones.length > 0) {
      const sanitizedStones = stones.map((stone) => ({
        ...stone,
        starting_info_id: startingInfoId,
        size: stone.size ? parseFloat(stone.size) : null,
        weight: stone.weight ? parseFloat(stone.weight) : null,
        count: stone.count ? Number(stone.count) : null,
      }));

      const { error: stoneError } = await supabase
        .from("stones")
        .insert(sanitizedStones);

      if (stoneError) {
        console.error("Error inserting stones:", stoneError);
        showMessage("Failed to save stones.");
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
      showMessage("Failed to save sample.");
      return;
    }

    // Finalize media uploads
    await finalizeMediaUpload("starting_info", startingInfoId, formData.styleNumber);

    // Reset form and close modal
    onSave(sampleData[0]);
    setFormData({ ...starting_formData });
    setStarting_info({ ...starting_info_object });
    showMessage("Sample added successfully!");
  } catch (error) {
    console.error("Unexpected error:", error);
    showMessage("An unexpected error occurred.");
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
      <Dialog as="div" className="relative z-50" onClose={handleClose}>
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
              <Dialog.Panel className="w-full  transform overflow-hidden rounded-2xl bg-white shadow-xl">
                <div className="flex justify-between items-center p-6 border-b">
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

                <form onSubmit={handleSubmit} className="p-6">
                  <div className="flex flex-row">
                    <div className=" pr-6 ">
                      <div className="flex justify-between items-start flex-col min-h-[70vh] overflow-y-auto">
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
                      <div className="flex flex-row gap-2 w-full">
                        <div className="w-full ">
                          <label className="block text-sm font-medium text-gray-700">
                            Style Number <span className="text-red-500">*</span>
                          </label>
                          <input
                            required="true"
                            type="text"
                            className="mt-1 block input shadow-sm "
                            value={formData.styleNumber}
                            onChange={(e) =>
                              setFormData({
                                ...formData,
                                styleNumber: e.target.value,
                              })
                            }
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
                            className="mt-1 block input shadow-sm  "
                            value={starting_info.manufacturerCode}
                            onChange={(e) =>
                              setStarting_info({
                                ...starting_info,
                                manufacturerCode: e.target.value,
                              })
                            }
                          />
                        </div>
                      </div>

                      <div className="flex flex-row gap-2 w-full">
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
                                  ).pricingsetting.lossPercentage
                                );
                              }}
                              value={starting_info.vendor}
                              className={` mt-1 border input  p-2 appearance-none `}
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

                      <div className="flex flex-row gap-2 w-full">
                        <div className="w-full">
                          <label htmlFor="">
                            Weight <span className="text-red-500">*</span>
                          </label>
                          <div className="flex items-center gap-1 ">
                            <span className="w-full relative">
                              <input
                                type="text"
                                placeholder="Enter Weight"
                                className="mt-1 block input shadow-sm focus:border-blue-500 focus:ring-blue-500 w-full "
                                value={starting_info.weight}
                                required={true}
                                onChange={(e) =>
                                  setStarting_info({
                                    ...starting_info,
                                    weight: e.target.value,
                                  })
                                }
                              />
                            </span>
                            <span className="absolute right-10 text-gray-500 pointer-events-none">
                              grams
                            </span>
                          </div>
                        </div>
                        <div className="w-full">
                          <label htmlFor="">Sales Weight</label>
                          <div className="flex items-center gap-1 ">
                            <span className="w-full relative">
                              <input
                                type="text"
                                placeholder="Enter Weight"
                                className="mt-1 block input shadow-sm focus:border-blue-500 focus:ring-blue-500 w-full "
                                value={formData.salesWeight}
                                onChange={(e) =>
                                  setFormData({
                                    ...formData,
                                    salesWeight: e.target.value,
                                  })
                                }
                              />
                            </span>
                            <span className="absolute right-10 text-gray-500 pointer-events-none">
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
                      <div className="flex flex-row w-full flex-1 justify-between">
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
                        <div className="flex flex-row gap-2 justify-center">
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

                      <div className="flex flex-row gap-2">
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
                      </div>

                      <div className="flex flex-row justify-center gap-2  ">
                        <div className="flex w-full flex-col">
                          <label htmlFor="back_type">Back Type</label>
                          <div className="flex flex-row gap-2">
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
                      <div className="flex flex-row gap-2">
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
                            htmlFor="category"
                            className="text-sm font-medium text-gray-700"
                          >
                            Category
                          </label>
                          <CustomSelect
                            onSelect={handleCustomSelect}
                            informationFromDataBase={starting_info.category}
                            version={"category"}
                            hidden={false}
                          />
                        </div>
                      </div>
                      {/* necklace */}
                      <div className="flex flex-row gap-2 items-center">
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

                  <div className="mt-6 flex justify-end space-x-3">
                    <button
                      type="button"
                      onClick={handleClose}
                      className="px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 border border-gray-300 rounded-md"
                    >
                      Cancel
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

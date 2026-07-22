import React, { Fragment, useState, useEffect, useRef } from "react";
import { ChevronDown, X, Upload } from "lucide-react";
import { Dialog, Transition } from "@headlessui/react";
import { getStatusColor } from "../../utils/designUtils";
import CustomSelect from "../CustomSelect";
import ImageUpload from "../ImageUpload";
import { useSupabase } from "../SupaBaseProvider";
import { useGenericStore } from "../../store/VendorStore";
import StonePropertiesForm from "../Products/StonePropertiesForm";

// import ImageUpload from '../ImageUpload';
import CalculatePrice from "../Samples/CalculatePrice";
import TotalCost from "../Samples/TotalCost";
import { metalTypes, getMetalType } from "../../utils/MetalTypeUtil";

export default function DesignQuoteForm({
  isOpen,
  onClose,
  formData,
  setFormData,
  lossPercent,
  setLossPercent,
  handleSubmit,
  finalizeUploadRef,
  onUpload,
  isEditing = false,
}) {
  console.log(isOpen);
  const { getEntityItemById, getEntity } = useGenericStore();
  const vendors = getEntity("vendors");
  const vendorLossRef = useRef();

  const handleCustomSelect = (option) => {
    const { categories, value } = option;
    setFormData({ ...formData, [categories]: value });
  };

  const limitInput = (e) => {
    let value = e.target.value;

    if (value.includes(".") && value.split(".")[1].length > 2) {
      console.log(value.slice(0, value.indexOf(".") + 3));
      setFormData({
        ...formData,
        [e.target.name]: parseFloat(value.slice(0, value.indexOf(".") + 3)),
      });
    } else {
      setFormData({ ...formData, [e.target.name]: parseFloat(value) });
    }
  };

  const handleInputChange = (e) => {
    const { name, value } = e.target;
    setFormData({ ...formData, [name]: value });
  };

  return (
    <Transition appear show={isOpen} as={Fragment}>
      <Dialog as="div" className="relative z-50" onClose={onClose}>
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
                    {isEditing ? "Edit" : "Add New"} Design Quote
                  </Dialog.Title>
                  <button
                    onClick={onClose}
                    className="text-gray-400 hover:text-gray-500"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>

                <form onSubmit={handleSubmit} className="p-6">
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
                            images={formData.images || []}
                            onUpload={onUpload}
                            ref={finalizeUploadRef}
                            // onChange={async (images) => {
                            //   setFormData({ ...formData, images });
                            //   // await updateDataBaseWithImages(images, sample.id)
                            // }}
                          />
                          <ImageUpload
                            collection="cad"
                            // finalizeUpload={finalizeUploadRef}
                            onUpload={(newImages) =>
                              setUploadedImages([
                                ...uploadedImages,
                                ...newImages,
                              ])
                            }
                            images={formData.cad || []}
                            // onChange={(cad) =>
                            //   setFormData({ ...formData, cad: cad })
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
                              onChange={handleInputChange}
                              value={formData.status}
                              className={`${getStatusColor(
                                formData.status
                              )} mt-1  border border-gray-300 rounded-md p-2 appearance-none focus:outline-none focus:ring-2 focus:ring-blue-500`}
                            >
                              <option value="Working_On_It:yellow">
                                Working on it
                              </option>
                              <option value="Waiting_On_Cads:grey">
                                Waiting on cads
                              </option>
                              <option value="Sample_Created:green">
                                Sample created
                              </option>
                              <option value="Received_Quote:blue">
                                Receieved quote
                              </option>
                              <option value="Dead:red">Dead</option>
                            </select>
                          </div>
                        </div>

                        {/* if i want total cost in this form  */}
                        {/* <div className="w-full">
                              <TotalCost
                                metalCost={metalCost}
                                miscCost={formData.miscCost}
                                laborCost={formData.laborCost}
                                stones={formData.stones}
                                updateTotalCost={(cost) =>
                                  setFormData({
                                    ...formData,
                                    totalCost: cost,
                                  })
                                }
                              />
                            </div> */}
                      </div>
                    </div>

                    <div className=" flex-1 space-y-6">
                      <div className="w-full flex flex-row gap-2 max-md:flex-col">
                        <div className="w-full">
                          <label className="block  text-sm font-medium text-gray-700">
                            Vendor
                          </label>
                          <div className="relative w-full">
                            <select
                              name="vendor"
                              required
                              onChange={(e) => {
                                setFormData({
                                  ...formData,
                                  vendor: e.target.value,
                                });

                                setLossPercent(
                                  getEntityItemById(
                                    "vendors",
                                    Number(e.target.value)
                                  ).pricingsetting.lossPercentage
                                );
                              }}
                              value={formData.vendor || ""}
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
                        <div className="w-full ">
                          <label className="block text-sm font-medium text-gray-700">
                            Manufacturer Code
                          </label>
                          <input
                            required
                            type="text"
                            name="manufacturerCode"
                            className="mt-1 block input shadow-sm  "
                            value={formData.manufacturerCode}
                            onChange={handleInputChange}
                          />
                        </div>
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700">
                          Description
                        </label>
                        <textarea
                          rows={3}
                          name="description"
                          className="mt-1 block input shadow-sm focus:border-blue-500 focus:ring-blue-500"
                          value={formData.description}
                          onChange={handleInputChange}
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

                                setFormData({
                                  ...formData,
                                  metalType: selectedMetalType,
                                  karat: metal.karat[0], // default to first karat
                                  color: metal.color[0], // default to first color
                                });
                              }}
                              value={formData.metalType}
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
                        <div className="flex flex-col">
                          <label htmlFor=""> Karat</label>
                          <div className="relative w-full">
                            <select
                              name="karat"
                              id=""
                              onChange={handleInputChange}
                              value={formData.karat}
                              className={` mt-1  border border-gray-300 rounded-md p-2 appearance-none focus:outline-none focus:ring-2 focus:ring-blue-500 w-full`}
                            >
                              {getMetalType(formData.metalType).karat.map(
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
                              onChange={handleInputChange}
                              value={formData.color}
                              className={` mt-1  border border-gray-300 rounded-md p-2 appearance-none focus:outline-none focus:ring-2 focus:ring-blue-500 w-full`}
                            >
                              {getMetalType(formData.metalType).color.map(
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
                      <div className="w-full">
                        <label htmlFor="">Weight</label>
                        <div className="flex items-center gap-1 ">
                          <span className="w-full relative">
                            <input
                              type="number"
                              name="weight"
                              required
                              placeholder="Enter Weight"
                              className="mt-1 block input shadow-sm focus:border-blue-500 focus:ring-blue-500 w-full "
                              value={formData.weight}
                              onChange={handleInputChange}
                            />
                          </span>
                          <span className="absolute right-10 text-gray-500 pointer-events-none">
                            grams
                          </span>
                        </div>
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
                              informationFromDataBase={formData.plating}
                              required
                            />
                          </div>
                          <div className="flex-1">
                            <label htmlFor="plating_charge">
                              Plating Charge
                            </label>
                            <input
                              type="number"
                              value={formData.platingCharge}
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
                          stones={formData.stones || []}
                          onChange={(stones) => {
                            setFormData({ ...formData, stones });
                          }}
                        />
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
                              name="length"
                              className="mt-1  input pr-7 pl-3 py-2"
                              value={formData.length}
                              onChange={handleInputChange}
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
                              name="width"
                              className="mt-1  input pr-7 pl-3 py-2"
                              value={formData.width}
                              onChange={handleInputChange}
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
                              name="height"
                              value={formData.height}
                              onChange={handleInputChange}
                            />
                          </div>
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
                              value={formData.necklace || false}
                              onChange={handleInputChange}
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
                              value={formData.necklaceCost || 0}
                              onChange={limitInput}
                              className="w-full input pl-7 pr-3 py-2"
                            />
                          </div>
                        </div>
                      </div>
                      {/* labor cost */}
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
                              value={formData.laborCost || 0}
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
                              value={formData.miscCost || 0}
                              onChange={limitInput}
                              className="w-full input pl-7 pr-3 py-2"
                            />
                          </div>
                        </div>
                      </div>
                      {/* category and ideas selections */}
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
                            version={"category"}
                            hidden={false}
                          />
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="mt-6 flex justify-end space-x-3">
                    <button
                      type="button"
                      onClick={onClose}
                      className="px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 border border-gray-300 rounded-md"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      className="px-4 py-2 text-sm font-medium text-white bg-chabot-gold hover:bg-opacity-90 rounded-md"
                    >
                      {isEditing ? "Edit" : "Add"} Design Quote
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
}

import React, { useState, Fragment, useEffect, useRef } from "react";
import { Dialog, Transition } from "@headlessui/react";
import ImageUpload from "../ImageUpload";
import { useSupabase } from "../SupaBaseProvider";
import { X } from "lucide-react";
import { getStatusColor } from "../../utils/designUtils";
import CustomSelect from "../CustomSelect";
import { useNavigate } from "react-router-dom";

const DesignInfoModal = ({ isOpen, onClose, design, updateDesign }) => {
  console.log(design, "design in modal");
  const { supabase } = useSupabase();
  const navigate = useNavigate();
  const [hasQuotes, setHasQuotes] = useState(false);
  const [uploadedImages, setUploadedImages] = useState([]);
  const finalizeUploadRef = useRef(null);
  const [originalData, setOriginalData] = useState({
    id: design.id,
    name: design.name,
    description: design.description,
    link: design.link,
    collection: design.collection,
    category: design.category,
    images: design.images,
    cad: design.cad,
    status: design.status,
  });
  const [formData, setFormData] = useState({ ...originalData });

  useEffect(() => {
    setOriginalData({
      id: design.id,
      name: design.name,
      description: design.description,
      link: design.link,
      collection: design.collection,
      category: design.category,
      images: design.images,
      status: design.status,
    });
    setFormData({
      id: design.id,
      name: design.name,
      description: design.description,
      link: design.link,
      collection: design.collection,
      category: design.category,
      images: design.images,
      status: design.status,
    });
  }, [design]);
  useEffect(() => {
    const checkForQuotes = async () => {
      const { data, error } = await supabase
        .from("starting_info")
        .select("*")
        .eq("designId", design.id);
      if (error) {
        console.error("Error fetching quotes:", error);
        return;
      }
      if (data.length > 0) {
        setHasQuotes(true);
      }
    };
    checkForQuotes();
  }, [design]);

  const handleInputChange = (e) => {
    const { name, value } = e.target;
    setFormData({ ...formData, [name]: value });
  };
  const handleCustomSelect = (option) => {
    // console.log(option,'from handle select in edit')
    const { categories, value } = option;
    setFormData({ ...formData, [categories]: value });
    // console.log(formData,'formdata')
  };

  // const getRemovedImages = (originalImages, currentImages) => {
  //   return originalImages.filter((image) => !currentImages.includes(image));
  // };
  const handleUpdateImageManufactoreCode = async (
    designQuotesId,
    manufacturerCode
  ) => {
    const { data, error } = await supabase
      .from("image_link")
      .update({ styleNumber: manufacturerCode })
      .eq("entityId", designQuotesId)
      .eq("entity", "design")
      .select("styleNumber");
    if (error) {
      console.error("style code was not updated");
    }
    console.log("style number was updated :", data[0].styleNumber);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    const updates = {};
    if (formData.name !== originalData.name) {
      updates.name = formData.name;
      await handleUpdateImageStyleNumber(design.id, design.name);
    }
    if (formData.description !== originalData.description)
      updates.description = formData.description;
    if (formData.images !== originalData.images)
      updates.images = formData.images;
    if (formData.status !== originalData.status)
      updates.status = formData.status;
    if (formData.link !== originalData.link) updates.link = formData.link;
    if (formData.collection !== originalData.collection)
      updates.collection = formData.collection;
    if (formData.category !== originalData.category)
      updates.category = formData.category;

    // const removedImages = getRemovedImages(
    //   originalData.images,
    //   formData.images
    // );

    // need to remove any photos that are deleted from an edited idea
    // ^ This is the function that will get the image urls that are removed
    if (Object.keys(updates).length > 0) {
      console.log(updates, "updates");
      const { data, error } = await supabase
        .from("designs")
        .update(updates)
        .eq("id", design.id)
        .single()
        .select();

      if (error) {
        console.error("Error updating design:", error);
      }

      console.log("design updated:", data);
      updateDesign({ ...data });
      setOriginalData({ ...formData });
    }

    // Call the update function to update the idea in the parent component
    if (finalizeUploadRef.current?.finalizeUpload) {
      console.log("finalizing upload with images:", uploadedImages);
      await finalizeUploadRef.current.finalizeUpload(
        "design",
        design.id,
        formData.name
      );
    }
    onClose();
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
          <div className="flex min-h-full items-start sm:items-center justify-center p-2 sm:p-4">
            <Transition.Child
              as={Fragment}
              enter="ease-out duration-300"
              enterFrom="opacity-0 scale-95"
              enterTo="opacity-100 scale-100"
              leave="ease-in duration-200"
              leaveFrom="opacity-100 scale-100"
              leaveTo="opacity-0 scale-95"
            >
              <Dialog.Panel className="w-full max-h-[95vh] overflow-y-auto transform overflow-x-hidden rounded-2xl bg-white shadow-xl">
                <div className="flex justify-between items-center p-6 border-b">
                  <Dialog.Title className="text-xl font-semibold text-gray-900">
                    Edit Design
                  </Dialog.Title>
                  <button
                    onClick={onClose}
                    className="text-gray-400 hover:text-gray-500"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>

                <form onSubmit={handleSubmit} className="p-6">
                  <div className="flex flex-col lg:flex-row">
                    <div className="lg:pr-6">
                      <div className="flex justify-between items-start flex-col lg:min-h-[70vh] overflow-y-auto">
                        {/* this is the image upload  */}
                        <div>
                          <label className="block text-sm font-medium text-gray-700">
                            Images
                          </label>
                          <ImageUpload
                            collection="image"
                            images={formData.images || []}
                            onUpload={(newImages) =>
                              setUploadedImages([
                                ...uploadedImages,
                                ...newImages,
                              ])
                            }
                            ref={finalizeUploadRef}
                            // onChange={async (images) => {
                            //   setFormData({ ...formData, images });
                            // }}
                          />
                        </div>
                        {/* this is the status function */}
                        <div className="mt-6 mb-2 flex items-center justify-evenly w-full flex-row ">
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
                              )} mt-1 border border-gray-300 rounded-md p-2 appearance-none focus:outline-none focus:ring-2 focus:ring-blue-500`}
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
                          <div className=" flex flex-col">
                            <label htmlFor="status" className="self-start">
                              View Quote(s){" "}
                            </label>

                            <button
                              className="bg-chabot-gold text-white px-4 py-2 rounded-lg flex items-center hover:bg-opacity-90 transition-colors"
                              onClick={() =>
                                navigate(`/designQuote?designId=${design.id}`)
                              }
                            >
                              View Quote(s)
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className=" flex-1 space-y-6">
                      <div>
                        <label className="block text-sm font-medium text-gray-700">
                          Name <span className="text-red-500">*</span>
                        </label>
                        <input
                          required={true}
                          type="text"
                          className="mt-1 block input shadow-sm focus:border-blue-500 focus:ring-blue-500"
                          value={formData.name}
                          onChange={(e) =>
                            setFormData({ ...formData, name: e.target.value })
                          }
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700">
                          Description
                        </label>
                        <textarea
                          rows={3}
                          className="mt-1 block input shadow-sm focus:border-blue-500 focus:ring-blue-500"
                          value={formData.description}
                          onChange={(e) =>
                            setFormData({
                              ...formData,
                              description: e.target.value,
                            })
                          }
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700">
                          Link
                        </label>
                        <input
                          type="url"
                          className="mt-1 block input  shadow-sm focus:border-blue-500 focus:ring-blue-500"
                          value={formData.link}
                          onChange={(e) =>
                            setFormData({ ...formData, link: e.target.value })
                          }
                        />
                      </div>

                      <div className=" mb-10">
                        <label
                          htmlFor="board"
                          className=" text-sm font-medium text-gray-700"
                        >
                          Board
                        </label>
                        <CustomSelect
                          onSelect={handleCustomSelect}
                          version={"collection"}
                          informationFromDataBase={originalData.collection}
                        />
                      </div>

                      <div className=" mb-10">
                        <label
                          htmlFor="category"
                          className=" text-sm font-medium text-gray-700"
                        >
                          Category
                        </label>
                        <CustomSelect
                          onSelect={handleCustomSelect}
                          version={"category"}
                          informationFromDataBase={originalData.category}
                        />
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
                      Edit Design
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

export default DesignInfoModal;

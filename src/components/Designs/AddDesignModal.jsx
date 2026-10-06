import React, { Fragment, useState,useRef } from 'react';
import useEscapeKey from "../../Hooks/useEscapeKey";
import { useDiscardGuard } from "../../Hooks/useUnsavedChanges";
import { ChevronDown, X,Upload } from 'lucide-react';
import { Dialog, Transition } from '@headlessui/react';
import { getStatusColor } from '../../utils/designUtils';
import CustomSelect from '../CustomSelect';
import ImageUpload from '../ImageUpload';
import { SectionCard, StatusPills, DESIGN_STATUS_OPTIONS } from "../FormSections";
import { useSupabase } from '../SupaBaseProvider';
// import ImageUpload from '../ImageUpload';



const AddDesignModal = ({ isOpen, onClose,onSave }) => {
  useEscapeKey(() => requestClose(), isOpen);
    const {supabase} = useSupabase();
    const [formData, setFormData] = useState({
        name: '',
        description: '',
        link:'',
        collection: null,
        category: null,
        images: [],
        status: 'Working_on_it:yellow',
    })
      const [uploadedImages,setUploadedImages]= useState([])
      const finalizeUploadRef = useRef(null)
    
    const handleSubmit = async (e) => {
        e.preventDefault();
        const newDesign = {
            name: formData.name,
            description: formData.description,
            link: formData.link,
            collection: formData.collection,
            category: formData.category,
            images: formData.images,
            status: formData.status,
        }
    const { data, error } = await supabase
    .from('designs')
    .insert([newDesign])
    .select();

    if(error) {
        console.log(error);
    }
    console.log(data, 'data from insert designs ');

      if (finalizeUploadRef.current?.finalizeUpload) {
      await finalizeUploadRef.current.finalizeUpload(
      'design',data[0].id,data[0].name,uploadedImages)
      }
    onSave(data[0]);
    setFormData({
        name: '',
        description: '',
        link:'',
        collection: '',
        category: '',
        status: 'Working_on_it:yellow',
    })
}
// const handleFileChange = (e) => {
    
// }
const handleCustomSelect = (option) => {
  const {categories,value} = option
  setFormData({...formData, [categories]:value})
}
  

  const requestClose = useDiscardGuard({ isOpen, value: { formData, uploadedImages }, onClose });

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
              <Dialog.Panel className="w-full max-w-4xl max-h-[90vh] flex flex-col transform overflow-hidden rounded-2xl bg-white shadow-2xl">
                <div className="flex justify-between items-center p-6 border-b shrink-0">
                  <Dialog.Title className="text-xl font-semibold text-gray-900">
                    Add New Design
                  </Dialog.Title>
                  <button
                    onClick={requestClose}
                    className="text-gray-400 hover:text-gray-500"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>

                <form onSubmit={handleSubmit } className="flex flex-col flex-1 min-h-0">
                  <div className="flex-1 min-h-0 overflow-y-auto p-6 bg-gray-50">
                  
                  <div className="flex flex-row max-md:flex-col">
                    <div className=" pr-6 max-md:pr-0">
                        <div className="flex justify-between items-start flex-col min-h-[70vh] max-md:min-h-0 overflow-y-auto">
                            {/* this is the image upload  */}
                            <div>
                      <ImageUpload
                            collection="image"
                            images={formData.images || []}
                            onUpload={(newImages)=> setUploadedImages([...uploadedImages,...newImages])}
                            ref={finalizeUploadRef}
                            // onChange={async (images) => {
                            //   setFormData({ ...formData, images });
                            // }}
                          />
                     
                    </div>
                        </div>
                    </div>

                      <div className=" flex-1 space-y-6">
                        <SectionCard prefix="add-design" id="details" title="Details" hint="Name is required.">
                        <StatusPills
                          options={DESIGN_STATUS_OPTIONS}
                          value={formData.status}
                          onChange={(v) => setFormData({ ...formData, status: v })}
                        />
                        <div>
                          <label className="block text-sm font-medium text-gray-700">
                            Name
                          </label>
                          <input
                            required
                            type="text"
                            className="mt-1 block input shadow-sm focus:border-blue-500 focus:ring-blue-500"
                            value={formData.name}
                            onChange={(e) => setFormData({ ...formData, name: e.target.value })}
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
                            onChange={(e) => setFormData({ ...formData, description: e.target.value })}
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
                            onChange={(e) => setFormData({ ...formData, link: e.target.value })}
                          />
                        </div>
                      
                        </SectionCard>
                        <SectionCard prefix="add-design" id="category" title="Category" hint="Board and category">
                        <div>
                            <label htmlFor="board" className="text-sm font-medium text-gray-700">Board</label>
                            <CustomSelect onSelect={handleCustomSelect} version={'collection'} hidden={true}/>
                        </div>

                        <div className='mb-4'>
                            <label htmlFor="category" className="text-sm font-medium text-gray-700">Category</label>
                            <CustomSelect  onSelect={handleCustomSelect} version={'category'}   />
                        </div>
                        </SectionCard>
                      </div>
                  </div>

                  </div>

                  <div className="flex justify-end space-x-3 border-t px-6 py-4 shrink-0 bg-white">
                    <button
                      type="button"
                      onClick={requestClose}
                      className="px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 border border-gray-300 rounded-md"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      className="px-4 py-2 text-sm font-medium text-white bg-chabot-gold hover:bg-opacity-90 rounded-md"
                      >
                      Add Design
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

export default AddDesignModal;

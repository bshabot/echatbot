import React, { useState, useEffect } from 'react';
import { Dialog, Transition } from '@headlessui/react';
import { Fragment } from 'react';
import { X } from 'lucide-react';
import ImageUpload from '../ImageUpload';
import MetalPropertiesForm from './MetalPropertiesForm';
import StonePropertiesForm from './StonePropertiesForm';

const EditProductModal= ({ isOpen, onClose, product }) => {
  const [formData, setFormData] = useState(product);

  // Reset form data when product changes
  useEffect(() => {
    setFormData(product);
  }, [product]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      let update = {
        ...formData,
        updated_at: new Date().toISOString()
      };
      console.log('Updating product: (in editProductModal)', update);
      onClose();
    } catch (error) {
      console.error('Error updating product:', error);
    }
  };

  const handleInputChange = (field, value) => {
    setFormData(prev => ({
      ...prev,
      [field]: value
    }));
  };

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
              <Dialog.Panel className="w-full max-w-2xl max-h-[90vh] flex flex-col transform overflow-hidden rounded-2xl bg-white shadow-2xl">
                <div className="flex justify-between items-center p-6 border-b shrink-0">
                  <Dialog.Title className="text-xl font-semibold text-gray-900">
                    Edit Product - {formData.itemNumber}
                  </Dialog.Title>
                  <button
                    onClick={onClose}
                    className="text-gray-400 hover:text-gray-500"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>

                <form onSubmit={handleSubmit} className="flex flex-col flex-1 min-h-0">
                  <div className="flex-1 min-h-0 overflow-y-auto p-6">
                  <div className="space-y-6">
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="block text-sm font-medium text-gray-700">
                          Item Number
                        </label>
                        <input
                          type="text"
                          value={formData.itemNumber}
                          onChange={(e) => handleInputChange('itemNumber', e.target.value)}
                          className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-chabot-gold focus:ring-chabot-gold"
                        />
                      </div>

                      <div>
                        <label className="block text-sm font-medium text-gray-700">
                          Manufacturer Code
                        </label>
                        <input
                          type="text"
                          value={formData.manufacturerCode}
                          onChange={(e) => handleInputChange('manufacturerCode', e.target.value)}
                          className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-chabot-gold focus:ring-chabot-gold"
                        />
                      </div>
                    </div>
                    <div>
                      <h3 className="text-sm font-medium text-gray-700 mb-2">
                        Metal Properties
                      </h3>
                      <MetalPropertiesForm
                        value={formData.metalProperties}
                        onChange={(value) => handleInputChange('metalProperties', value)}
                      />
                    </div>
                    <div>
                      <h3 className="text-sm font-medium text-gray-700 mb-2">
                        Stones
                      </h3>
                      <StonePropertiesForm
                        stones={formData.stones || []}
                        onChange={(value) => handleInputChange('stones', value)}
                      />
                    </div>

                    <div>
                      <h3 className="text-sm font-medium text-gray-700 mb-2">
                        Product Images
                      </h3>
                      <ImageUpload
                        images={formData.images}
                        // onChange={(value) => handleInputChange('images', value)}
                      />
                    </div>
                  </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700">
                        Description
                      </label>
                      <textarea
                        rows={3}
                        value={formData.description}
                        onChange={(e) => handleInputChange('description', e.target.value)}
                        className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-chabot-gold focus:ring-chabot-gold"
                      />
                    </div>
                    </div>

                  <div className="flex justify-end space-x-3 border-t px-6 py-4 shrink-0 bg-white">
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
                      Save Changes
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

export default EditProductModal;
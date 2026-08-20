import React, { useState } from 'react';
import { Dialog, Transition } from '@headlessui/react';
import { Fragment } from 'react';
import { X } from 'lucide-react';
import ImageUpload from '../ImageUpload';
import MetalPropertiesForm from './MetalPropertiesForm';
import StonePropertiesForm from './StonePropertiesForm';
import LaborCostForm from './LaborCostForm';


const AddProductModal = ({ isOpen, onClose }) => {
    const [formData, setFormData] = useState({
        name: '',
        itemNumber: '',
        manufacturerCode: '',
        description: '',
        images: [],
        metalProperties: {
          type: 'gold',
          karatType: '14k',
          weightInGrams: 0,
          color: 'YG',
        },
        stones: [],
        laborCost: 0,
        dimensions: {
          width: '',
          height: '',
          depth: '',
        },
        quantity: 1,
        unit: 'PCS',
        isPair: false,
        totalWeight: 0,
        goldWeight: 0,
        goldAmount: 0,
        stoneAmount: 0,
        unitPrice: 0,
        rhodiumCharge: 0,
        miscCost: 0,
        remarks: '',
      });
      
      const handleSubmit = async (e) => {
        e.preventDefault();
        const newProduct = {
          id: crypto.randomUUID(),
          status: 'draft',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          ...formData ,
        };
        console.log('Adding new product: (add product modal)', newProduct);
        onClose();
        setFormData({
            name: '',
            itemNumber: '',
            manufacturerCode: '',
            description: '',
            images: [],
            metalProperties: {
              type: 'gold',
              karatType: '14k',
              weightInGrams: 0,
              color: 'YG',
            },
            stones: [],
            laborCost: 0,
            dimensions: {
              width: '',
              height: '',
              depth: '',
            },
            quantity: 1,
            unit: 'PCS',
            isPair: false,
            totalWeight: 0,
            goldWeight: 0,
            goldAmount: 0,
            stoneAmount: 0,
            unitPrice: 0,
            rhodiumCharge: 0,
            miscCost: 0,
            remarks: '',
          });
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
                            Add New Product
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
                                  required
                                  className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-chabot-gold focus:ring-chabot-gold"
                                  value={formData.itemNumber}
                                  onChange={(e) => setFormData({ ...formData, itemNumber: e.target.value })}
                                />
                              </div>
        
                              <div>
                                <label className="block text-sm font-medium text-gray-700">
                                  Manufacturer Code
                                </label>
                                <input
                                  type="text"
                                  className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-chabot-gold focus:ring-chabot-gold"
                                  value={formData.manufacturerCode}
                                  onChange={(e) => setFormData({ ...formData, manufacturerCode: e.target.value })}
                                />
                              </div>
                            </div>
        
                            <div>
                              <label className="block text-sm font-medium text-gray-700">
                                Product Name
                              </label>
                              <input
                                type="text"
                                className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-chabot-gold focus:ring-chabot-gold"
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
                                className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-chabot-gold focus:ring-chabot-gold"
                                value={formData.description}
                                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                              />
                            </div>
        
                            <div>
                              <h3 className="text-sm font-medium text-gray-700 mb-2">
                                Metal Properties
                              </h3>
                              <MetalPropertiesForm
                                value={formData.metalProperties}
                                onChange={(metalProperties) => setFormData({ ...formData, metalProperties })}
                              />
                            </div>
        
                            <div>
                              <h3 className="text-sm font-medium text-gray-700 mb-2">
                                Stones
                              </h3>
                              <StonePropertiesForm
                                stones={formData.stones || []}
                                onChange={(stones) => setFormData({ ...formData, stones })}
                              />
                            </div>
        
                            <div>
                              <h3 className="text-sm font-medium text-gray-700 mb-2">
                                Labor Cost
                              </h3>
                              <LaborCostForm
                                laborCost={formData.laborCost || 0}
                                onChange={(laborCost) => setFormData({ ...formData, laborCost })}
                              />
                            </div>
        
                            <div>
                              <h3 className="text-sm font-medium text-gray-700 mb-2">
                                Dimensions
                              </h3>
                              <div className="grid grid-cols-3 gap-4">
                                <div>
                                  <label className="block text-sm font-medium text-gray-700">
                                    Width (mm)
                                  </label>
                                  <input
                                    type="text"
                                    className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-chabot-gold focus:ring-chabot-gold"
                                    value={formData.dimensions?.width}
                                    onChange={(e) => setFormData({
                                      ...formData,
                                      dimensions: { ...formData.dimensions, width: e.target.value }
                                    })}
                                  />
                                </div>
                                <div>
                                  <label className="block text-sm font-medium text-gray-700">
                                    Height (mm)
                                  </label>
                                  <input
                                    type="text"
                                    className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-chabot-gold focus:ring-chabot-gold"
                                    value={formData.dimensions?.height}
                                    onChange={(e) => setFormData({
                                      ...formData,
                                      dimensions: { ...formData.dimensions, height: e.target.value }
                                    })}
                                  />
                                </div>
                                <div>
                                  <label className="block text-sm font-medium text-gray-700">
                                    Depth (mm)
                                  </label>
                                  <input
                                    type="text"
                                    className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-chabot-gold focus:ring-chabot-gold"
                                    value={formData.dimensions?.depth}
                                    onChange={(e) => setFormData({
                                      ...formData,
                                      dimensions: { ...formData.dimensions, depth: e.target.value }
                                    })}
                                  />
                                </div>
                              </div>
                            </div>
        
                            <div>
                              <h3 className="text-sm font-medium text-gray-700 mb-2">
                                Product Images
                              </h3>
                              <ImageUpload
                                images={formData.images || []}
                                // onChange={(images) => setFormData({ ...formData, images })}
                              />
                            </div>
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
                              Add Product
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
        
        export default AddProductModal;
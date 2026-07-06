import React, { useState } from 'react';
import { Dialog, Transition } from '@headlessui/react';
import { Fragment } from 'react';
import { X, Edit, Trash2 } from 'lucide-react';
import { getStatusColor, formatDate } from '../../utils/productUtils';
import TotalCostDisplay from './TotalCostDisplay';
import EditProductModal from './EditProductModal';
import { useAlert } from '../Alerts/AlertContext';


const ProductDetails = ({ isOpen, onClose, product }) => {
    const { showConfirm } = useAlert();
    const [isEditModalOpen, setIsEditModalOpen] = useState(false);
    const removeProduct = async (id) =>{
      console.log('Product to be removed', id);
    }
  const handleDelete = async () => {
    if (await showConfirm('Are you sure you want to delete this product?', { confirmText: 'Delete', variant: 'error' })) {
      await removeProduct(product.id);
      onClose();
    }
  };

  const calculateTotalCost = () => {
    const metalCost = product.metalProperties?.currentPrice || 0;
    const stoneCost = (product.stones || []).reduce((total, stone) => total + stone.cost, 0);
    const laborCost = product.laborCost || 0;
    return { metalCost, stoneCost, laborCost };
  };

  const { metalCost, stoneCost, laborCost } = calculateTotalCost();

  return (
    <>
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
                <Dialog.Panel className="w-full max-w-2xl transform overflow-hidden rounded-2xl bg-white shadow-xl">
                  <div className="flex justify-between items-center p-6 border-b">
                    <Dialog.Title className="text-xl font-semibold text-gray-900">
                      {product.itemNumber} - {product.name}
                    </Dialog.Title>
                    <div className="flex items-center space-x-2">
                      <button
                        onClick={() => setIsEditModalOpen(true)}
                        className="p-2 text-gray-400 hover:text-gray-500 rounded-full hover:bg-gray-100"
                      >
                        <Edit className="w-5 h-5" />
                      </button>
                      <button
                        onClick={handleDelete}
                        className="p-2 text-gray-400 hover:text-red-500 rounded-full hover:bg-gray-100"
                      >
                        <Trash2 className="w-5 h-5" />
                      </button>
                      <button
                        onClick={onClose}
                        className="p-2 text-gray-400 hover:text-gray-500 rounded-full hover:bg-gray-100"
                      >
                        <X className="w-5 h-5" />
                      </button>
                    </div>
                  </div>

                  <div className="p-6">
                    <div className="grid grid-cols-2 gap-6">
                      <div>
                        <h3 className="font-medium text-gray-900 mb-2">Details</h3>
                        <div className="space-y-4">
                          <div>
                            <p className="text-sm text-gray-500">Status</p>
                            <span
                              className={`mt-1 inline-block px-2 py-1 rounded-full text-xs font-medium ${getStatusColor(
                                product.status
                              )}`}
                            >
                              {product.status.replace('_', ' ')}
                            </span>
                          </div>
                          <div>
                            <p className="text-sm text-gray-500">Created</p>
                            <p className="mt-1 text-sm text-gray-900">
                              {formatDate(product.created_at)}
                            </p>
                          </div>
                          <div>
                            <p className="text-sm text-gray-500">Last Updated</p>
                            <p className="mt-1 text-sm text-gray-900">
                              {formatDate(product.updated_at)}
                            </p>
                          </div>
                        </div>
                      </div>

                      <div>
                        <h3 className="font-medium text-gray-900 mb-2">Description</h3>
                        <p className="text-sm text-gray-600">{product.description}</p>
                      </div>
                    </div>
                    <div className="mt-6">
                      <TotalCostDisplay
                        metalCost={metalCost}
                        stoneCost={stoneCost}
                        laborCost={laborCost}
                      />
                    </div>

                    <div className="mt-6">
                      <h3 className="font-medium text-gray-900 mb-2">Images</h3>
                      <div className="grid grid-cols-3 gap-4">
                        {product.images.map((image, index) => (
                          <img
                            key={index}
                            src={image}
                            alt={`Product ${product.itemNumber} - ${index + 1}`}
                            className="w-full h-32 object-cover rounded-lg"
                          />
                        ))}
                      </div>
                    </div>
                  </div>
                </Dialog.Panel>
              </Transition.Child>
            </div>
          </div>
        </Dialog>
      </Transition>
      <EditProductModal
        isOpen={isEditModalOpen}
        onClose={() => setIsEditModalOpen(false)}
        product={product}
      />
    </>
  
    )
};
export default ProductDetails;
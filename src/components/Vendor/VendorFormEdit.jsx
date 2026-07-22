import React, { useState,useEffect } from 'react';
import { Dialog } from '@headlessui/react';
import { X, Plus, Trash2 } from 'lucide-react';
import { useSupabase } from '../../components/SupaBaseProvider';

const VendorForm = ({  isOpen, onClose, vendor, updateVendor }) => {
    const {supabase} = useSupabase();
    const [originalData, setOriginalData] = useState({
        id: vendor.id,
        name: vendor.name,
        email: vendor.email,
        phone: vendor.phone,
        address: vendor.address,
        pricingsetting: vendor.pricingsetting,
        paymentterms: vendor.paymentterms,
        notes: vendor.notes,
    })
    const [formData,setFormData] = useState({
            ...originalData
    })
    useEffect(() => {
                    setOriginalData({
                        id: vendor.id,
                        name: vendor.name,
                        email: vendor.email,
                        phone: vendor.phone,
                        address: vendor.address,
                        pricingsetting: vendor.pricingsetting,
                        paymentterms: vendor.paymentterms,
                        notes: vendor.notes,
                    });
                    setFormData({
                        id: vendor.id,
                        name: vendor.name,
                        email: vendor.email,
                        phone: vendor.phone,
                        address: vendor.address,
                        pricingsetting: vendor.pricingsetting,
                        paymentterms: vendor.paymentterms,
                        notes: vendor.notes,
                    });
            }, [vendor]);
    
      
      const addCharge = () => {
        setFormData(prev => ({
          ...prev,
          pricingsetting: {
            ...prev.pricingsetting,
            additionalcharges
: [
              ...prev.pricingsetting.additionalcharges
  ,
              { id: crypto.randomUUID(), name: '', amount: 0, type: 'fixed' },
            ],
          },
        }));
      };
    const removeCharge = (id) => {
        setFormData(prev => ({
            ...prev,
            pricingsetting: {
              ...prev.pricingsetting,
              additionalcharges
  : prev.pricingsetting.additionalcharges
  .filter(
                charge => charge.id !== id
              ),
            },
          }));
    }
    const handleSubmit = async(e) => {
        e.preventDefault();
        const updates = {};
                if (formData.name !== originalData.name) updates.name = formData.name;
                if (formData.email !== originalData.email) updates.email = formData.email;
                if (formData.phone!==originalData.phone) updates.phone = formData.phone;
                if (formData.address !== originalData.address) updates.address = formData.address;
                if (formData.pricingsetting !== originalData.pricingsetting) updates.pricingsetting = formData.pricingsetting;
                if (formData.paymentterms !== originalData.paymentterms) updates.paymentterms = formData.paymentterms;
                if (formData.notes !== originalData.notes) updates.notes = formData.notes;

                const {data,error} = await supabase
                .from('vendors')
                .update(updates)
                .eq('id',vendor.id)
                .select()
                .single()
                
                if (error) {
                    console.error('Error updating vendor:', error);
                } else {
                    console.log('vendor updated:', data);
                    setOriginalData(data);
                    updateVendor(data)
                }
            onClose();
    }
    return (
        <Dialog open={isOpen} onClose={onClose} className="relative z-50">
          <div className="fixed inset-0 bg-black/30" aria-hidden="true" />
          
          <div className="fixed inset-0 flex items-center justify-center p-4">
            <Dialog.Panel className="w-full max-w-2xl bg-white rounded-xl shadow-lg">
              <div className="flex justify-between items-center p-6 border-b">
                <Dialog.Title className="text-xl font-semibold">
                  {vendor ? 'Edit Vendor' : 'Add Vendor'}
                </Dialog.Title>
                <button onClick={onClose} className="text-gray-400 hover:text-gray-500">
                  <X className="w-5 h-5" />
                </button>
              </div>
    
              <form onSubmit={handleSubmit} className="p-6 space-y-6">
                <div className="grid grid-cols-2 gap-4 max-md:grid-cols-1">
                  <div>
                    <label className="block text-sm font-medium text-gray-700">Name</label>
                    <input
                      type="text"
                      required
                      value={formData.name}
                      onChange={e => setFormData(prev => ({ ...prev, name: e.target.value }))}
                      className="input mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500"
                    />
                  </div>
    
                  <div>
                    <label className="block text-sm font-medium text-gray-700">Email</label>
                    <input
                      type="email"
                      required
                      value={formData.email}
                      onChange={e => setFormData(prev => ({ ...prev, email: e.target.value }))}
                      className="input mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500"
                    />
                  </div>
    
                  <div>
                    <label className="block text-sm font-medium text-gray-700">Phone</label>
                    <input
                      type="tel"
                      value={formData.phone}
                      onChange={e => setFormData(prev => ({ ...prev, phone: e.target.value }))}
                      className="input mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500"
                    />
                  </div>
    
                  <div>
                    <label className="block text-sm font-medium text-gray-700">Payment Terms</label>
                    <input
                      type="text"
                      value={formData.paymentterms}
                      onChange={e => setFormData(prev => ({ ...prev, paymentterms: e.target.value }))}
                      className="input mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500"
                    />
                  </div>
                </div>
    
                <div>
                  <label className="block text-sm font-medium text-gray-700">Address</label>
                  <textarea
                    value={formData.address}
                    onChange={e => setFormData(prev => ({ ...prev, address: e.target.value }))}
                    rows={2}
                    className="input mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500"
                  />
                </div>
    
                <div className="space-y-4">
                  <h3 className="text-lg font-medium text-gray-900">Pricing Settings</h3>
                  
                  <div className="grid grid-cols-3 gap-4 max-md:grid-cols-1">
                    <div>
                      <label className="block text-sm font-medium text-gray-700">Loss %</label>
                      <input
                        type="number"
                        step="0.01"
                        value={formData.pricingsetting.lossPercentage}
                        onChange={e => setFormData(prev => ({
                          ...prev,
                          pricingsetting: {
                            ...prev.pricingsetting,
                            lossPercentage: parseFloat(e.target.value),
                          },
                        }))}
                        className="input mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500"
                      />
                    </div>
    
                    <div>
                      <label className="block text-sm font-medium text-gray-700">Markup %</label>
                      <input
                        type="number"
                        step="0.01"
                        value={formData.pricingsetting.markupPercentage}
                        onChange={e => setFormData(prev => ({
                          ...prev,
                          pricingsetting: {
                            ...prev.pricingsetting,
                            markupPercentage: parseFloat(e.target.value),
                          },
                        }))}
                        className="input mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500"
                      />
                    </div>
    
                    <div>
                      <label className="block text-sm font-medium text-gray-700">Labor Multiplier</label>
                      <input
                        type="number"
                        step="0.01"
                        value={formData.pricingsetting.laborMultiplier}
                        onChange={e => setFormData(prev => ({
                          ...prev,
                          pricingsetting: {
                            ...prev.pricingsetting,
                            laborMultiplier: parseFloat(e.target.value),
                          },
                        }))}
                        className="input mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500"
                      />
                    </div>
                  </div>
    
                  <div>
                    <div className="flex justify-between items-center mb-2">
                      <h4 className="text-sm font-medium text-gray-900">Additional Charges</h4>
                      <button
                        type="button"
                        onClick={addCharge}
                        className="text-sm text-blue-600 hover:text-blue-700 flex items-center"
                      >
                        <Plus className="w-4 h-4 mr-1" />
                        Add Charge
                      </button>
                    </div>
    
                    <div className="space-y-2">
                      {formData.pricingsetting.additionalcharges
          .map((charge, index) => (
                        <div key={charge.id} className="flex items-center space-x-2">
                          <input
                            type="text"
                            placeholder="Charge name"
                            value={charge.name}
                            onChange={e => {
                              const newCharges = [...formData.pricingsetting.additionalcharges
                    
                              ];
                              newCharges[index] = { ...charge, name: e.target.value };
                              setFormData(prev => ({
                                ...prev,
                                pricingsetting: {
                                  ...prev.pricingsetting,
                                  additionalcharges
                      : newCharges,
                                },
                              }));
                            }}
                            className="input flex-1 rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500"
                          />
                          <input
                            type="number"
                            step="0.01"
                            placeholder="Amount"
                            value={charge.amount}
                            onChange={e => {
                              const newCharges = [...formData.pricingsetting.additionalcharges
                    
                              ];
                              newCharges[index] = { ...charge, amount: parseFloat(e.target.value) };
                              setFormData(prev => ({
                                ...prev,
                                pricingsetting: {
                                  ...prev.pricingsetting,
                                  additionalcharges
                      : newCharges,
                                },
                              }));
                            }}
                            className="input w-24 rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500"
                          />
                          <select
                            value={charge.type}
                            onChange={e => {
                              const newCharges = [...formData.pricingsetting.additionalcharges
                    
                              ];
                              newCharges[index] = { ...charge, type: e.target.value };
                              setFormData(prev => ({
                                ...prev,
                                pricingsetting: {
                                  ...prev.pricingsetting,
                                  additionalcharges
                      : newCharges,
                                },
                              }));
                            }}
                            className="input w-32 rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500"
                          >
                            <option value="fixed">Fixed</option>
                            <option value="percentage">Percentage</option>
                          </select>
                          <button
                            type="button"
                            onClick={() => removeCharge(charge.id)}
                            className="p-2 text-gray-400 hover:text-red-500"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
    
                <div>
                  <label className="block text-sm font-medium text-gray-700">Notes</label>
                  <textarea
                    value={formData.notes}
                    onChange={e => setFormData(prev => ({ ...prev, notes: e.target.value }))}
                    rows={3}
                    className="input mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500"
                  />
                </div>
    
                <div className="flex justify-end space-x-3">
                  <button
                    type="button"
                    onClick={onClose}
                    className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="px-4 py-2 text-sm font-medium text-white  rounded-md bg-chabot-gold hover:bg-opacity-90"
                  >
                    Save
                  </button>
                </div>
              </form>
            </Dialog.Panel>
          </div>
        </Dialog>
      );
}
export default VendorForm;
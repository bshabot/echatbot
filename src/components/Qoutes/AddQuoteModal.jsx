
import { useSupabase } from '../SupaBaseProvider';
import React, { Fragment, useState,useEffect,useRef } from 'react';
import { ChevronDown, X,Upload } from 'lucide-react';
import { Dialog,  Transition } from '@headlessui/react';
import CustomSelect from '../CustomSelect';

const AddQuoteModal = ({ isOpen, onClose, onSave }) => {
            const {supabase} = useSupabase();
            const [formData, setFormData] = useState(
              {date: 'may 5th 2000', quoteNumber: '624-0000102', agent:'Brian Shabot',buyer:'Maria Leon' ,tags:'test hello',status:'sent',gold:2300,silver:32,items:[]})

            const handleSubmit = (e) =>{
                e.preventDefault()
                onSave(formData);
            }
            const handleCustomSelect = (item)=>{
              setFormData({...formData, items:[...formData.items,item]})
            }
            useEffect(()=>{

            },[])
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
                                Add New Quote
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
                              
                              <div className="flex ">
                                
                                
                                  {/* <div className=" flex-1 space-y-6">
                                    <div>
                                      <label className="block text-sm font-medium text-gray-700">
                                        Title
                                      </label>
                                      <input
                                        required
                                        type="text"
                                        className="mt-1 block input shadow-sm focus:border-blue-500 focus:ring-blue-500"
                                        value={formData.title}
                                        onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                                      />
                                    </div>
                                    <div>
                                      <label className="block text-sm font-medium text-gray-700">
                                        Prepared For:
                                      </label>
                                      <input
                                        required
                                        type="text"
                                        className="mt-1 block input shadow-sm focus:border-blue-500 focus:ring-blue-500"
                                        value={formData.buyer}
                                        onChange={(e) => setFormData({ ...formData, buyer: e.target.value })}
                                      />
                                    </div>
                                    <div className='flex flex-row'>
                                      <div>
                                        <label className="block text-sm font-medium text-gray-700">
                                          Gold Price
                                        </label>
                                        <input
                                          type="url"
                                          className="mt-1 block input  shadow-sm focus:border-blue-500 focus:ring-blue-500"
                                          value={formData.link}
                                          onChange={(e) => setFormData({ ...formData, gold: e.target.value })}
                                        />
                                      </div>
                                      <div><label className="block text-sm font-medium text-gray-700">
                                        Silver Price
                                      </label>
                                      <input
                                        type="url"
                                        className="mt-1 block input  shadow-sm focus:border-blue-500 focus:ring-blue-500"
                                        value={formData.link}
                                        onChange={(e) => setFormData({ ...formData, silver: e.target.value })}
                                      />
                                      </div>
                                    </div>
                                    <div>
                                      <label htmlFor="items">Items</label>
                                      <CustomSelect />
                                    </div>
                                  
                                    
                                  </div> */}
                                  <div className="overflow-auto max-h-[600px] border border-gray-300">
        <table className="w-full border-collapse border border-gray-300 table-fixed">
        <thead className="bg-gray-200 sticky top-0 z-10">
            <tr className="bg-gray-200">
                <th className="border border-gray-300 p-2 w-20">Item</th>
                <th className="border border-gray-300 p-2 w-20">Image</th>
                <th className="border border-gray-300 p-2 w-20">Description By</th>
                <th className="border border-gray-300 p-2 w-20">Sales Weight</th>
                <th className="border border-gray-300 p-2 w-20">Price</th>
                <th className="border border-gray-300 p-2 w-20">Buyer Remark</th>
                <th className="border border-gray-300 p-2 w-20">Internal Note</th>
            </tr>
        </thead>
        <tbody>
            
                    <tr >
                        <td className="border border-gray-300 p-2 text-center">
                            <span className="flex flex-col">
                             <CustomSelect onSelect={handleCustomSelect} version={"samples"} informationFromDataBase={""} hidden={true}/>
                            </span>
                        </td>
                        <td className="border border-gray-300 p-2 text-center">{}</td>
                        <td className="border border-gray-300 p-2 text-center">{}</td>
                        <td className="border border-gray-300 p-2 text-center">{}</td>
                        {/* <td className="border border-gray-300 p-2 text-center">{row.tags}</td> */}
                        {/* <td
                            className="border border-gray-300 p-2 text-center cursor-pointer"
                            onClick={() => setEditingCell({ index, field: "tags" })}
                        >
                            {editingCell?.index === index && editingCell.field === "tags" ? (
                                <input
                                type="text"
                                value={row.tags}
                                onChange={(e) => handleChange(index, "tags", e.target.value)}
                                onBlur={() => setEditingCell(null)}
                                onKeyDown={(e) => e.key === "Enter" && setEditingCell(null)}
                                className="border border-gray-300 p-1 w-full text-center"
                                autoFocus
                                />
                            ) : (
                                row.tags || "Click to edit"
                            )}
                        </td> */}
                        {/* <EditableCell
                            handleChange={handleChange}
                            setEditingCell={setEditingCell}
                            editingCell={editingCell}
                            row={row}
                            index={index}
                            cellType={'tags'}
                        />
                        <EditableCell
                            handleChange={handleChange}
                            setEditingCell={setEditingCell}
                            editingCell={editingCell}
                            row={row}
                            index={index}
                            cellType={'status'}
                        /> */}
                        {/* <td
                            className="border border-gray-300 p-2 text-center cursor-pointer"
                            onClick={() => setEditingCell({ index, field: "status" })}
                        >
                            {editingCell?.index === index && editingCell.field === "status" ? (
                                <select
                                value={row.status}
                                onChange={(e) => handleChange(index, "status", e.target.value)}
                                onBlur={() => setEditingCell(null)}
                                className="border border-gray-300 p-1 w-full text-center"
                                autoFocus
                                >
                                <option value="Sent">Sent</option>
                                <option value="Pending">Pending</option>
                                <option value="Approved">Approved</option>
                                <option value="Rejected">Rejected</option>
                                </select>
                            ) : (
                                row.status || "Click to edit"
                            )}
                        </td> */}
                        {/* <td>
                            <div className="flex w-full h-full justify-around">
                                <div onClick={()=> ''} className="cursor-pointer">
                                    <Link />
                                </div>
                                <div onClick={()=> ''} className="cursor-pointer">
                                    <FontAwesomeIcon icon={faFilePdf} size='lg'/>
                                </div>
                                <div onClick={()=> ''} className="cursor-pointer">
                                    <FontAwesomeIcon icon={faFileExcel} size='lg'/>
                                </div>
                            </div>
                        </td> */}
                    </tr>
                    
            
        
        </tbody>
        </table>
    </div>
                              </div>
                              {/* dont touch  */}
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
                                  Add Quote
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

export default AddQuoteModal
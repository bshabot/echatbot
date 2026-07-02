
import { X } from 'lucide-react';
import React, { useState, Fragment,useEffect } from 'react';
import ImageUpload from '../ImageUpload';
import { Dialog, Transition } from '@headlessui/react';



 export default function MoreImageModel({images,onClose,isOpen}){

    return (
        <Transition appear show={isOpen
        } as={Fragment}>
          <Dialog as="div" className="relative z-[60]" onClose={onClose}>
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
                        More Photos
                      </Dialog.Title>
                      <button
                        onClick={onClose}
                        className="text-gray-400 hover:text-gray-500"
                      >
                        <X className="w-5 h-5" />
                      </button>
                    </div>
                    <div className="flex justify-center items-center">
                        <ImageUpload
                            images={images}
                            forDisplay
                        />
                    </div>
                  </Dialog.Panel>
                </Transition.Child>
              </div>
            </div>
          </Dialog>
        </Transition>
      );
}
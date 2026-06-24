// File: components/ImportModal.jsx

import React, { useEffect, useState,useRef } from 'react';
import { Dialog, Transition } from '@headlessui/react';
import { Fragment } from 'react';
import { Upload, X } from 'lucide-react';
import { getImages, useSupabase } from '../SupaBaseProvider';
import { useMetalPriceStore } from '../../store/MetalPrices';
import { useGenericStore } from '../../store/VendorStore';
import { handleImportFile } from '../../utils/importUtils';
import { formatImportRow } from '../../utils/formatImportRow';
import { purity } from '../../utils/MetalTypeUtil';

const ImportModal = ({ isOpen, onClose,onImport, type }) => {
  const { supabase } = useSupabase();
  const [progress, setProgress] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);

  const closeButtonRef = useRef(null);
  const { getEntity } = useGenericStore();
  const vendors = getEntity('vendors');
  const { prices } = useMetalPriceStore();
  const successfulRows = [];

  useEffect(() => {
    if (isOpen) {
      setProgress(0);
      setError(null);
      setIsLoading(false);
      setIsDragging(false);
      setSuccess(null);

      // if (closeButtonRef.current) {
      //   closeButtonRef.current = handleOnClose();
      // }
    }

  }, [isOpen]); 
  const handleOnClose = (successfullyUploaded) => {

    if( successfullyUploaded && successfullyUploaded.length > 0) {
      onImport(successfullyUploaded);
    }
    setProgress(0);
    setIsLoading(false);
    onClose();
  };

  const getDropDownData = async () => {
    const { data, error } = await supabase.rpc('get_dropdown_options');
    if (error) throw new Error('Dropdown fetch failed');
    return data;
  };
  const checkIfKaratIsValid = (karat) => {
    // Mirror the app's canonical metal list (Gold karats, 925 silver, Brass)
    // so the import accepts exactly what the product form allows.
    const valid = Object.keys(purity).map(k => k.toUpperCase().trim());
    return valid.includes(String(karat || '').toUpperCase().trim());
  }

  const handleFileChange = async (e) => {
    // console.log('File change event:', e);
    const file = e.target.files?.[0];
    if (!file) return;
    
    setError(null);
    setIsLoading(true);
    setProgress(0);
    try {
      const parsedRows = await handleImportFile(file, type);
      const dropdown = await getDropDownData();
      const formatted = parsedRows.map(row => formatImportRow(row, type, dropdown, prices)).filter(Boolean);

      const failedRows = [];
      for (let i = 0; i < formatted.length; i++) {
        try {
          let { starting_info, cad:dontUseCadOnSample, ...formData } = formatted[i];
          let { id:startingInfoIdFromImport,stones,images:dontUseImages,cad:dontUseCad, ...restOfStartingInfo } = starting_info || {};
          // console.log('Formatted Row:', formData, 'Starting Info:', restOfStartingInfo, 'Stones:', stones);
          if (type === 'designs') {
            const { id,...rest} = formData 
            const { data: inserted ,error:insertedError} =
            formData.id === '' || formData.id === null ?
             await supabase.from('designs').insert(rest).select() :  await supabase.from('designs').upsert(formData).select('*');
            if (insertedError) {
              throw new Error(`Insert error: ${insertedError.details}`);
            }
            

              if(starting_info.vendor) {
                const { data: startRow } = await supabase.from('starting_info').insert([restOfStartingInfo]).select('*');
                if (stones.length > 0) {
                  await supabase.from('stones').insert(stones.map(stone => ({ ...stone, starting_info_id: startRow[0].id })));
                }
                // throw new Error(`Vendor is missing`);

              }
              formatted[i] = {...inserted[0]}
            console.log(typeof  id, id)
            }
          

          if (type === 'samples') {
            if( formData.styleNumber.trim() === '') {
              throw new Error(`missing styleNumber`);
            }
            if(!restOfStartingInfo.weight) {
              console.log('weight is missing', formData.weight);
              throw new Error(`missing weight`);
            }
            if(!checkIfKaratIsValid(restOfStartingInfo.karat)) {
              console.log('invalid karat:', restOfStartingInfo.karat);
              throw new Error(`invalid karat: ${restOfStartingInfo.karat}`);
            }
            // console.log('formatted stylenumber:', formData.styleNumber, 'restOfStartingInfo:', restOfStartingInfo,'formData:', formData);
              const { id,...rest} = formData 
              const FormatedFormDataId = id && !isNaN(Number(id)) ? Number(id) : null;
            
           if (FormatedFormDataId) {
            try{
              const { data: existing } = await supabase.from('samples').select('*').eq('id',  FormatedFormDataId).single();
              restOfStartingInfo.id =  existing.starting_info_id
            } catch (error) {
              console.log('possibly a new sample, no existing found', error);
            }
           }
            
              console.log('starting_info_ to be submitted for update:', restOfStartingInfo);
              const { data: updatedStartingInfo } = await supabase.from('starting_info').upsert([{...restOfStartingInfo}], { onConflict: ['id'] }).select().single();


              console.log(typeof  id, id)

              // const {data:imageData,error:imageError} = await supabase
              // .from('sample_images')
              // .select("*")
              // .single()
              // .eq('sample_id',formData.id)
              // if (imageError) {
              //   throw new Error(`Sample update error: ${imageError.details}`);
              // }
              const {images,cad} = await getImages('starting_info',updatedStartingInfo.id);
              
              const updatedData = {
                ...rest,
                starting_info_id: updatedStartingInfo.id 
              }
              if(FormatedFormDataId){
                console.log('using existing id for sample update:', FormatedFormDataId);
                updatedData.id = FormatedFormDataId
              }

              const { data: updatedSample, error: updatedSampleError } =
                await supabase.from('samples').upsert([{...updatedData}], { onConflict: ['id'] }).select()

              if (updatedSampleError) {
                throw new Error(`Sample update error: ${updatedSampleError.message || updatedSampleError.details}`);
              }
              
              formatted[i] = { ...updatedSample[0], starting_info: updatedStartingInfo,images, cad};
              
              if (stones.length > 0) {
                await supabase.from('stones').upsert(stones.map(stone => ({ ...stone, starting_info_id: updatedStartingInfo.id })), { onConflict: ['id'] });
              }
            

            if (type === 'designQuote') {
              const { data: infoRow } = await supabase.from('starting_info').upsert([restOfStartingInfo], { onConflict: ['id'] }).select();
              if (stones.length > 0) {
                await supabase.from('stones').upsert(stones.map(stone => ({ ...stone, starting_info_id: infoRow[0].id })), { onConflict: ['id'] });
              }
            }
            successfulRows.push(formatted[i]);
          }
          // console.log('Successfully processed row:', successfulRows);
        } catch (err) {
          console.error(`Error processing row ${i + 2}:`, err);
          failedRows.push({ row: i + 2, error: err.message });
        }
        setProgress(Math.round(((i + 1) / formatted.length) * 100));
      }
      console.log('Import completed:', successfulRows, 'Failed Rows:', failedRows);
      onImport(successfulRows);
      if (failedRows.length > 0) {
        setSuccess(`Successfully imported ${successfulRows.length} ${type}.`);
        setError(failedRows.map(f => `Row ${f.row}: ${f.error}`).join('\n'));
      } else {
        setSuccess(`Successfully imported ${successfulRows.length} ${type}.`);
        
      }
    } catch (err) {
      setSuccess(successfulRows.length > 0 ? `Successfully imported ${successfulRows.length} ${type}.` : null);
      setError(err.message);
    }
    setIsLoading(false);
  };

  return (
    <Transition appear show={isOpen} as={Fragment}>
      <Dialog as="div" className="relative z-50" onClose={handleOnClose}>
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
              <Dialog.Panel className="w-full max-w-md transform overflow-hidden rounded-2xl bg-white p-6 text-left align-middle shadow-xl transition-all">
                <div className="flex justify-between items-center mb-4">
                  <Dialog.Title className="text-lg font-medium text-gray-900">
                    Import {`${type[0].toUpperCase()}${type.slice(1)}`}
                  </Dialog.Title>
                  <button onClick={() => handleOnClose(successfulRows)}  className="text-gray-400 hover:text-gray-500">
                    <X className="w-5 h-5" />
                  </button>
                </div>

                <div
                  onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
                  onDragLeave={(e) => { e.preventDefault(); setIsDragging(false); }}
                  onDrop={async (e) => { e.preventDefault(); setIsDragging(false); setError(null); await handleFileChange({ target: { files: e.dataTransfer.files } }); }}
                  className={`mt-4 p-6 border-2 border-dashed rounded-lg text-center ${isDragging ? 'border-blue-500 bg-blue-50' : 'border-gray-300'}`}
                >
                  <Upload className="w-8 h-8 mx-auto text-gray-400 mb-4" />
                  <p className="text-sm text-gray-600">
                      Drag and drop your CSV/XLSX file here, or{' '}
                      <label htmlFor="fileinput" className="text-blue-500 hover:text-blue-600 cursor-pointer">
                        browse
                      </label>
                      <input
                        type="file"
                        className="hidden"
                        accept=".csv, .xlsx"
                        id="fileinput" // Ensure this matches the htmlFor attribute in the label
                        onChange={handleFileChange}
                        disabled={isLoading}
                      />
                    </p>
                </div>

                {isLoading && (
                  <div className="my-4">
                    <div className="w-full bg-gray-200 rounded-full h-3">
                      <div
                        className="bg-blue-600 h-3 rounded-full transition-all duration-200"
                        style={{ width: `${progress}%` }}
                      />
                    </div>
                    <p className="text-xs text-gray-600 mt-1 text-center">{progress}% completed</p>
                  </div>
                )}

                {error && (
                  <div
                  className="mt-4 text-sm text-red-600 whitespace-pre-wrap overflow-y-auto max-h-40"
                >
                  {error}
                </div>
                )}
                {success && (
                  <div
                  className="mt-4 text-sm text-green-600 whitespace-pre-wrap overflow-y-auto max-h-40"
                >
                  {success}
                </div>
                )}

                <div className="mt-4 text-xs text-gray-500">
                  <p className="font-medium mb-1">CSV/Excel Format Requirements:</p>
                  <ul className="list-disc pl-4 space-y-1">
                    <li>File must be in CSV or XLSX format</li>
                    <li>First row must contain column headers</li>
                    <li>Use '|' for multiple images in a field</li>
                  </ul>
                </div>
              </Dialog.Panel>
            </Transition.Child>
          </div>
        </div>
      </Dialog>
    </Transition>
  );
};

export default ImportModal;

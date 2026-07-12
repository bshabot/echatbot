import React, { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { useSupabase } from '../components/SupaBaseProvider';
import VendorList from '../components/Vendor/VendorList';
import AddVendorForm from '../components/Vendor/VendorForm';
import VendorFormEdit from '../components/Vendor/VendorFormEdit';
import Loading from '../components/Loading';
import { useGenericStore } from '../store/VendorStore';

export default function Vendors() {
    const {getEntity,updateEntity} = useGenericStore()
    const vendors = getEntity('vendors');
    console.log(vendors,'vendors from store',) 
    const {supabase} = useSupabase();
    const [isFormOpen, setIsFormOpen] = useState(false);
    const [isEditFormOpen, setIsEditFormOpen] = useState(false);
    const [isLoading,setIsLoading] = useState(false)
    const [selectedVendor, setSelectedVendor] = useState(null);

    const handleUpdateVendor = async (vendorData) => {
      vendors.forEach((vendor) => {
        if(vendor.id === vendorData.id){
          Object.assign(vendor, vendorData);
        } 
      })
      updateEntity('vendors',vendors)
      
      
    }
    
    const handleClick = async (vendor) => {
      const { data, error } = await supabase
        .from('vendors')
        .select('*')
        .eq('id', vendor.id);

    if (error) {
      console.error('Error fetching vendor:', error);
      return;
    }
    console.log(data,'data from click');
      setSelectedVendor(data[0]);
      setIsEditFormOpen(true);
  }


    const handleSave = (vendorData) => {

          addVendor(vendorData);
          setIsFormOpen(false);
          setSelectedVendor(null);
    }
    if(isLoading){
      return <Loading/>
    }
    return (
        <div className="p-6 ">
          <div className="flex flex-wrap justify-between items-center mb-6 gap-2">
            <h1 className="text-2xl font-bold text-gray-900">Vendors</h1>
            <button
              onClick={() => {
                setSelectedVendor(null);
                setIsFormOpen(true);
              }}
              className="flex items-center px-4 py-2 text-white bg-chabot-gold rounded-lg hover:bg-opacity-90"
            >
              <Plus className="w-5 h-5 mr-2" />
              Add Vendor
            </button>
          </div>
    
          <VendorList
            vendors={vendors}
            onSelectVendor={handleClick}
          />
    
          <AddVendorForm
            isOpen={isFormOpen}
            onClose={() => {
              setIsFormOpen(false);
              setSelectedVendor(null);
            }}
            onSave={(vendor) => {
              console.log(vendor)
              setIsFormOpen(false);
              setSelectedVendor(null);
            }}
          />
          {selectedVendor &&
              <VendorFormEdit
                vendor={selectedVendor}
                isOpen={isEditFormOpen}
                onClose={() => {
                  setIsEditFormOpen(false);
                  setSelectedVendor(null);
                }}
                updateVendor={handleUpdateVendor}
            />
          }
        </div>
      );
    }
 


 
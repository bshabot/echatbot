
'use client'
import React, { useState, useEffect } from 'react';
import { useSupabase } from '../components/SupaBaseProvider';
import Loading from './Loading';
import useEscapeKey from '../Hooks/useEscapeKey';
import { useMessage } from './Messages/MessageContext';
import FolderBulkUpload from './FolderBulkUpload';
import PhotoTagSearch from './PhotoTagSearch';
export default function ImageManager (){
  const { supabase } = useSupabase();
  const [folders, setFolders] = useState(['idea-images', 'public']); // Available folders
  const [selectedFolder, setSelectedFolder] = useState('idea-images'); // Default folder
  const [images, setImages] = useState([]);
  const [filteredImages, setFileredImages] = useState([]);
  const [selectedImages, setSelectedImages] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const {showMessage} = useMessage()
  const [isFolderUploadOpen, setIsFolderUploadOpen] = useState(false);
  useEscapeKey(() => setIsFolderUploadOpen(false), isFolderUploadOpen);

  // Fetch images from the selected folder
  const fetchImages = async (folder) => {
    setLoading(true);
    setError(null);

    const { data, error } = await supabase.storage.from('echatbot').list(folder, {
    //   limit: 100, // Adjust the limit as needed
    });

    if (error) {
      setError('Error fetching images');
      console.error(error);
    } else {
      console.log(data)
      setImages(data || []);
    }

    setLoading(false);
  };

  // Delete selected images
  

  // Toggle image selection
  const toggleImageSelection = (imageName) => {
    setSelectedImages((prev) =>
      prev.includes(imageName)
        ? prev.filter((name) => name !== imageName)
        : [...prev, imageName]
    );
  };

  // Handle folder selection
  const handleFolderChange = (e) => {
    const folder = e.target.value;
    setSelectedFolder(folder);
    fetchImages(folder);
    setSelectedImages([])
  };
  const handleDelete = async (success)=>{
       
    if(!success)           {
          showMessage('Error occured while deleting')
      return
    }

setImages(images.filter(q => !Array.from(selectedImages).has(q.id)))
showMessage('Items have been deleted successfully')
setSelected(new Set())
}

  useEffect(() => {
    fetchImages(selectedFolder); // Fetch images when the folder changes
  }, [selectedFolder]);
  console.log(filteredImages)
  return (
    <div className="flex flex-col h-[calc(100vh-2.5rem)] min-h-0">
      <div className="flex justify-between items-center shrink-0 mb-3">
      <div className="flex flex-col">
          <h1 className="text-2xl font-bold text-gray-900">Image Manager</h1>
        </div>
        <div className="flex space-x-3">
          <button
            className="bg-white text-gray-700 px-4 py-2 rounded-lg flex items-center hover:bg-gray-50 border border-gray-300"
            onClick={() => setIsFolderUploadOpen(true)}
          >
            Bulk Upload
          </button>
        </div>
      </div>

      <PhotoTagSearch fileImages={images} />

      {isFolderUploadOpen && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-20">
          <div className="bg-black/40 absolute inset-0" onClick={() => setIsFolderUploadOpen(false)} />
          <div className="relative z-10 w-[90%] max-w-3xl bg-white rounded shadow-lg p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold">Bulk Upload Images</h3>
              <button className="text-sm text-gray-600" onClick={() => setIsFolderUploadOpen(false)}>Close</button>
            </div>
            <FolderBulkUpload
              bucket="echatbot"
              concurrency={5}
              onComplete={(result) => {
                console.log('Bulk upload complete', result);
                setIsFolderUploadOpen(false);
                // refresh current folder images
                fetchImages(selectedFolder);
              }}
            />
          </div>
        </div>
      )}
    </div>
     
     
  );
};


'use client'
import React, { useState, useEffect } from 'react';
import { useSupabase } from '../components/SupaBaseProvider';
import Loading from './Loading';
import { useMessage } from './Messages/MessageContext';
import SearchBar from './SearchBar';
import DeleteButton from './MiscComponenets/DeleteButton';
import FolderBulkUpload from './FolderBulkUpload';
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
    <div className="p-4">
      <div className="flex justify-between items-center">
      <div className="flex flex-col">
          <h1 className="text-2xl font-bold text-gray-900">Image Manager</h1>
          <SearchBar
            type={'image_link'}
            items={images}
            onSearch={(filteredItems) => {
              setFileredImages(filteredItems);
            }}
            isLoading={isLoading}
            setIsLoading={setIsLoading}
          />
        </div>
        <div className="flex space-x-3">
          <button
            className="bg-white text-gray-700 px-4 py-2 rounded-lg flex items-center hover:bg-gray-50 border border-gray-300"
            onClick={() => setIsFolderUploadOpen(true)}
          >
            Bulk Upload
          </button>
          {filteredImages.length > 0 && (
            <DeleteButton onDelete={handleDelete} type={'images'} selectedItems={selectedImages}  selectedFolder={selectedFolder}/>
          )}
        </div>
      </div>

      {loading && <Loading/>}
      {error && <p className="text-red-500">{error}</p>}

      <div className="mb-4">
        <label className="block text-sm font-medium text-gray-700 mb-2">Select Folder</label>
        <select
          value={selectedFolder}
          onChange={handleFolderChange}
          className="p-2 border rounded-md w-full"
        >
          {folders.map((folder) => (
            <option key={folder} value={folder}>
              {folder}
            </option>
          ))}
        </select>
      </div>

      {!loading && filteredImages.length === 0 && <p>No images found in this folder.</p>}

      <div className="grid grid-cols-3 gap-4 max-md:grid-cols-2">
      {filteredImages.map((image,index) => (
          <div
            key={image.name}
            className={`border rounded-lg p-2 cursor-pointer ${
              selectedImages.includes(image.name) ? 'border-blue-500' : 'border-gray-300'
            }`}
            onClick={() => toggleImageSelection(image.name)} // Toggle selection on div click
          >
            <img
              src={`${process.env.VITE_SUPABASE_URL}/storage/v1/object/public/echatbot/${selectedFolder}/${image.name}`}
              alt={image.name}
              loading={index>10?'lazy':''}
              className="w-full h-32 object-cover rounded-md"
            />
            <div className="flex justify-between items-center mt-2">
              <span className="text-sm truncate">{image.name}</span>
              <input
                type="checkbox"
                checked={selectedImages.includes(image.name)}
                onChange={() => toggleImageSelection(image.name)} // Keep checkbox in sync
                onClick={(e) => e.stopPropagation()} // Prevent div click when clicking checkbox
              />
            </div>
          </div>
        ))}
      </div>

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

import { useEffect, useState, useCallback } from "react";
import { Upload } from "lucide-react";
import { useSupabase } from "./SupaBaseProvider";
import { v4 as uuid  } from "uuid";
export default function ImageUpload({ images: inital, onChange, collection = "image", forDisplay, props, ref }) {

  // console.log(inital, "images from ImageUpload");
  const { supabase } = useSupabase();
  // const [deletingImage, setDeletingImage] = useState([]); // for per-image delete loading
  // const [uploading, setUploading] = useState(false);
  // const [uploads,setUploads] =useState([])
  const [imageToShow, setImageToShow] = useState();
  const [images, setImages] = useState(
    inital.filter((image) => image !== "").map((url) => ({
      id: uuid(),
      status: 'done',
      source:'inital',
      // type: collection,
      url: url,
    })) || []
  );
  // useEffect(() => {
  //   setImages(inital.filter((image) => image !== ""));
  //   setImageToShow(images[0] || null);
  // }, [inital]);
useEffect(() => {
  // if (finalizeUpload) {
  //   finalizeUpload.current = linkImagesToEntity;
  // }
  if(images.length>0 && images[0].status !== 'delete')
    setImageToShow(images[0].url)
  else
    setImageToShow(null)
}, [images]);

const linkImagesToEntity = useCallback(async (entity, entityId, styleNumber) => {
  // await removeImage(entity)
    
  console.log(`linking ${collection}:`, images) 
  const imageIds = images.filter( image => image.status ==='done' && image.source==='upload'); 
  console.log(`linking ${collection}:`, imageIds) 
  
  if (imageIds.length === 0) return;
  
  
  const { error } = await supabase.from("image_link").insert(
    imageIds.map((image) => ({
      imageId: image.id,
      styleNumber,
      entity,
      entityId,
      type: collection,
    }))
  )
  
  if (error) {
    console.error("Failed to link images:", error);
  } else {
    console.log("Images linked to entity successfully");
  }

  // const uniqueSuffix = Date.now();

  // const formatted = `${uniqueSuffix}`;
  // console.log(formatted); // Example: "7_4_2025"
  
  // await Promise.all(
  //   images.map(async (image) => {
  //     const decoded = decodeURIComponent(image.imageUrl);
  //     const oldPath = decoded.split('/echatbot/')[1]; // get the path inside bucket
  //     const extension = oldPath.split('.').pop(); // get file extension
  
  //     const newPath = `public/${styleNumber}_${formatted}.${extension}`;
  
  //     // Move the image in Supabase Storage
  //     const { error: moveError } = await supabase.storage
  //       .from('echatbot')
  //       .move(oldPath, `${newPath}`);
  
  //     if (moveError) {
  //       console.error(`Error moving ${oldPath}:`, moveError);
  //       return;
  //     }
  
  //     // Update the image metadata in the 'images' table
  //     const fullNewUrl = `${process.env.VITE_SUPABASE_URL}/storage/v1/object/public/echatbot/${newPath}`
  //     const {data, error: updateError } = await supabase
  //       .from('images')
  //       .update({ imageUrl: fullNewUrl, name: newPath })
  //       .eq('id', image.id)
  //       .select()
        
  //     if (updateError) {
  //       console.error(`Error updating image row for ${image.imageUrl}:`, updateError);
  //     }
  //     console.log(data[0])
  //   })
  // );
}, [images, supabase, collection]);

// Expose imperative API via ref-as-prop (React 19)
useEffect(() => {
  if (!ref) return;
  try {
    ref.current = { finalizeUpload: linkImagesToEntity };
  } catch (e) {
    /* ignore if ref isn't mutable */
  }
  return () => {
    try { if (ref) ref.current = null; } catch (e) {}
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [ref, linkImagesToEntity]);

const handleImageChange = async (e) => {
  const files = Array.from(e.target.files);
  if (!files || files.length === 0) return;

    console.log('added files:',files.length)
  const newUploads = files.map((file) => ({
    id: uuid(),
    file,
    status: 'uploading',
    source:'upload',
    url: null,
  }));
  console.log('new images:',newUploads)
  setImages(prev=> [...prev,...newUploads])
  const imageUrls = await  handleImageUpload(newUploads);
  // console.log(imageUrls, "imageUrls from upload");
  // setImages((prev)=> [... new Set([...inital,...prev, ...imageUrls])]);
};

const handleImageUpload = async (files) => {

  try {
    // const uploadedImages = [];

    for (const {id,file } of files) {
      const fileName = `${file.name.replace(/ /g, "_")             // spaces → underscores
    .replace(/[^a-zA-Z0-9_\-./:]/g, "")}`;
      
        // const safeUrl = imageUrl.replace(/'/g, "''"); // escape single quotes if any

      const { data, error: uploadError } = await supabase.storage
        .from("echatbot")
        .upload(`public/${fileName}`, file);

      if (uploadError) {
        console.error("Upload error:", uploadError);
        const imageUrl = supabase.storage
          .from("echatbot")
          .getPublicUrl(`public/${fileName}`).data.publicUrl;

        const { data, error } = await supabase
          .from('images')
          .select('*')
          .or(`imageUrl.eq.${imageUrl},originalUrl.eq.${imageUrl}`)
          .single()
        if(error){
          console.error(error)
          return
        }
        setImages((prev) =>
            prev.map((u) =>
              u.id === id ? { ...u,id:data.id, status: 'done',source:"upload", url: imageUrl } : u
            )
          );
       
        continue;
      }

      let imageUrl = supabase.storage
        .from("echatbot")
        .getPublicUrl(`public/${fileName}`).data.publicUrl;
      imageUrl = imageUrl.split('echatbot/')[1] // get the path inside bucket
      console.log(imageUrl, 'imageUrl after upload');
      // Save metadata to DB
      const { data: insertData, error: insertError } = await supabase
        .from("images")
        .insert([{ imageUrl, originalUrl: imageUrl }])
        .select("id, imageUrl")
        .single();

      if (insertError) {
        console.error("DB insert error:", insertError);
        continue;
      }
      console.log(images)
      // uploadedImages.push(insertData);
      setImages((prev) =>
          prev.map((u) =>
            u.id === id ? { ...u, status: 'done', url: `${process.env.VITE_DB_HOST_URL}${insertData.imageUrl}` ,id:insertData.id} : u
          )
        );
    }
    // const newImages = [...images, ...uploadedImages];
    // onChange?.(newImages);
  } finally {
  }
};
 




  const removeImage = async (entity) => {
    try {
      // Filter images with status === "delete"
      const imagesToDelete = images
            .filter(img => img.status === "delete" && img.source === "inital")
            .map(img => img.id);

      console.log(`Deleting ${collection}:`, imagesToDelete)
      // Delete image_link entries in Supabase
      
        
          const { error: linkDeleteError } = await supabase
            .from("image_link")
            .delete()
            .in("imageId", imagesToDelete)
            .eq('entity',entity)
            .eq('type',collection)
  
          if (linkDeleteError) {
            console.error("Link delete error for image ID",  linkDeleteError);
          }
        
  
      // Update local state
      const remainingImages = images.filter((img) => img.status !== "delete");
      setImages(remainingImages);
  
      // Update the imageToShow if it was deleted
      if (imagesToDelete.some((img) => img.imageUrl === imageToShow)) {
        setImageToShow(remainingImages[0]?.imageUrl || null);
      }
    } finally {
      // setDeletingImage(null);
    }
  };
  
  const handleDelete = (imageId) =>{
    setImages(prevImages =>
      prevImages.map(img =>
        img.id === imageId ? { ...img, status: 'delete' } : img
      )
    )
  }
//   const removeImage = async () => {
  
  

//   try {
//     const decoded = decodeURIComponent(image.imageUrl || image);
//     const pathInBucket = decoded.split("/echatbot/")[1];

//     // Delete from storage
//     const { error: storageError } = await supabase.storage
//       .from("echatbot")
//       .remove([pathInBucket]);

//     if (storageError) {
//       console.error("Storage delete error:", storageError);
//     }

//     // Delete from DB
//     if (image.id) {
//       const { error: dbError } = await supabase
//         .from("images")
//         .delete()
//         .eq("id", image.id);

//       if (dbError) {
//         console.error("DB delete error:", dbError);
//       }
//     }

//     const newImages = [...images];
//     newImages.splice(index, 1);
//     setImages(newImages);
//     onChange?.(newImages);

//     if (imageToShow === image.imageUrl) {
//       setImageToShow(newImages[0]?.imageUrl || null);
//     }
//   } finally {
//     setDeletingImage(null);
//   }
// };




  const handleDragOver = (e) => {
    e.preventDefault();
  };

  const handleDrop = (e) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files);
    onChange([...images, ...files]);
  };

  // console.log('imageToShow', );

  return (
    <div className="space-y-4 flex flex-col">
      {/* Fixed size container for the big image with a max size */}
      <div className="flex flex-wrap gap-2 w-full mb-4">
        <div className="relative w-full max-w-md max-h-64 min-h-64 mx-auto overflow-hidden ">
          {" "}
          {/* Slightly wider container */}
          {imageToShow ? (
            <img
              src={imageToShow}
              alt="Selected Image"
              className="object-contain w-full h-full rounded-lg" // Ensures image fits without distortion, cropping if necessary
            />
          ) : (
            "No Images Uploaded Yet"
          )}
        </div>
      </div>
      {/* {uploads.map((upload, i) => (
          <div
            key={i}
            className="relative flex h-32 w-full items-center justify-center rounded-lg border border-gray-300 bg-gray-100"
          >
            {upload.status === 'uploading' ? (
              <div className="animate-spin rounded-full border-4 border-blue-400 border-t-transparent h-8 w-8"></div>
            ) : upload.url ? (
              <img
                src={upload.url}
                alt="Uploaded thumbnail"
                className="h-full w-full rounded object-cover"
              />
            ) : (
              <span className="text-xs text-red-500">Error</span>
            )}
          </div>
        ))} */}

      {/* Thumbnails for preview */}
      {/* <div className="flex flex-wrap gap-2 pt-4 pr-4">
        {uploading && (
          <div className="text-center text-sm text-gray-500 my-2">Uploading...</div>
        )}
        {Array.isArray(images) &&
          images.map((image, index) => (
            <div
              key={index}
              className="relative"
              onClick={() => setImageToShow(image)}
            >
              <img
                src={image}
                alt={`Upload Preview ${index}`}
                className="w-24 h-24 object-contain rounded-md border-2 border-gray-300 cursor-pointer"
              />
              {!forDisplay ? (
                <button
                  type="button"
                  onClick={() => removeImage(index)}
                  className="absolute top-0 right-0 bg-red-500 text-white rounded-full p-1"
                >
                  &times;
                </button>
              ) : (
                ""
              )}
            </div>
          ))}
      </div> */}
      <div className="flex flex-wrap gap-2 pt-4 pr-4">
        {images.map((u, index) => {
  if (u.status === 'delete') return null;

  return (
    <div
      key={u.id || index}
      className="relative flex h-24 w-24 items-center justify-center rounded-md border-2 border-gray-300 bg-gray-100"
    >
      {u.status === 'uploading' ? (
        <div className="animate-spin rounded-full border-4 border-blue-400 border-t-transparent h-6 w-6"></div>
      ) : u.status === 'done' && u.url ? (
        <div
          className="relative w-full h-full"
          onClick={() => setImageToShow(u.url)}
        >
          <img
            src={u.url}
            alt={`Upload Preview ${index}`}
            className="w-full h-full object-contain rounded-md border-2 border-gray-300 cursor-pointer"
          />
          {!forDisplay && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation(); // ensure the image isn't selected on click
                handleDelete(u.id);
              }}
              className="absolute top-0 right-0 bg-red-500 text-white rounded-full p-1"
            >
              &times;
            </button>
          )}
        </div>
      ) : (
        <span className="text-xs text-red-500">Error</span>
      )}
    </div>
  );
})}

        </div>
      {/* Drag and drop area */}
      {!forDisplay ? (
        <div
          onDragOver={handleDragOver}
          onDrop={handleDrop}
          className="border-2 border-dashed border-gray-300 p-4 rounded-md"
        >
          <input
            type="file"
            multiple
            accept={
              collection === "image"
                ? "image/*"
                : "image/* , .dwg, .dxf, .step, .stp, .iges, .igs, .sat, .3dm, .stl"
            }
            onChange={handleImageChange}
            className="hidden"
            id={collection}
          />
          <label htmlFor={collection} className="cursor-pointer">
            <div className="flex justify-center items-center w-8 h-8 bg-gray-200 rounded-full mx-auto">
              <Upload className="text-gray-500 w-4 h-4" />
            </div>
            <p className="text-gray-700 text-sm font-medium mt-2">
              Choose a file or drag and drop it here
            </p>
            <p className="text-xs text-gray-500">
              We recommend using high quality .jpg files less than 20 MB or .mp4
              files less than 200 MB.
            </p>
          </label>
        </div>
      ) : (
        ""
      )}
    </div>
  );
};


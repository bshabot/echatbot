import { useEffect, useState, useCallback, useId } from "react";
import { Upload, Star, X, RotateCcw, FileBox, ImageIcon, Loader2, AlertCircle } from "lucide-react";
import { useMessage } from "./Messages/MessageContext";
import { useSupabase } from "./SupaBaseProvider";
import { v4 as uuid  } from "uuid";
import { uploadImageToR2 } from "../utils/r2Upload";
import { useAlert } from "./Alerts/AlertContext";
const IMAGE_EXT = /\.(jpe?g|png|gif|webp|avif|bmp|svg|heic|heif|tiff?)$/i;
const CAD_EXT = ["dwg", "dxf", "step", "stp", "iges", "igs", "sat", "3dm", "stl"];
const nameOf = (u) => {
  const raw = (u.file?.name || u.url || "file").split("?")[0].split("/").pop();
  try { return decodeURIComponent(raw); } catch { return raw; }
};
const extOf = (u) => (nameOf(u).split(".").pop() || "file").slice(0, 5).toUpperCase();
const isImageFile = (u) => IMAGE_EXT.test(nameOf(u)) || Boolean(u.file?.type?.startsWith("image/"));

export default function ImageUpload({ images: inital, onChange, collection = "image", forDisplay, entity, entityId, props, ref }) {
  const { showAlert, showConfirm } = useAlert();
  const { showMessage } = useMessage();
  const uid = useId();
  const [dragging, setDragging] = useState(false);
  const [selectedCadUrl, setSelectedCadUrl] = useState(null);
  const isCad = collection !== "image";

  // console.log(inital, "images from ImageUpload");
  const { supabase } = useSupabase();
  // const [deletingImage, setDeletingImage] = useState([]); // for per-image delete loading
  // const [uploading, setUploading] = useState(false);
  // const [uploads,setUploads] =useState([])
  const [imageToShow, setImageToShow] = useState();
  const [primaryUrl, setPrimaryUrl] = useState(null);
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
  const viewable = images.filter((i) => i.status === "done" && i.url && isImageFile(i));
  // Keep whatever the user is looking at; only fall back to the first image
  // when that one was removed (or nothing was selected yet).
  setImageToShow((cur) => (viewable.some((v) => v.url === cur) ? cur : viewable[0]?.url || null));
  // The array arrives primary-first from the DB view, so images[0] is the main image.
  if (images.length > 0 && images[0].status !== "delete" && primaryUrl == null && images[0].url) {
    setPrimaryUrl(images[0].url);
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
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

const [pendingPrimaryUrl, setPendingPrimaryUrl] = useState(null);

// Expose imperative API via ref-as-prop (React 19)
useEffect(() => {
  if (!ref) return;
  try {
    ref.current = { finalizeUpload: linkImagesToEntity, commitChanges };
  } catch (e) {
    /* ignore if ref isn't mutable */
  }
  return () => {
    try { if (ref) ref.current = null; } catch (e) {}
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [ref, linkImagesToEntity, images, pendingPrimaryUrl]);

// One entry point for picker + drag-and-drop: checks type and size, tells the
// user what was skipped, then uploads the rest.
const addFiles = (fileList) => {
  const files = Array.from(fileList || []);
  if (files.length === 0) return;
  const maxMb = isCad ? 100 : 25;
  const accepted = [];
  const skipped = [];
  for (const f of files) {
    const ext = (f.name.split(".").pop() || "").toLowerCase();
    const okType = f.type.startsWith("image/") || (isCad && CAD_EXT.includes(ext));
    if (!okType) { skipped.push(`${f.name} (${isCad ? "not an image or CAD file" : "not an image"})`); continue; }
    if (f.size > maxMb * 1024 * 1024) { skipped.push(`${f.name} (over ${maxMb} MB)`); continue; }
    accepted.push(f);
  }
  if (skipped.length) showMessage(`Skipped: ${skipped.join(", ")}`, { type: "error" });
  if (accepted.length === 0) return;
  const newUploads = accepted.map((file) => ({
    id: uuid(),
    file,
    status: "uploading",
    source: "upload",
    url: null,
  }));
  setImages((prev) => [...prev, ...newUploads]);
  handleImageUpload(newUploads);
};

const handleImageChange = (e) => {
  addFiles(e.target.files);
  e.target.value = ""; // lets the same file be picked again later
};

const retryUpload = (u) => {
  setImages((prev) => prev.map((x) => (x.id === u.id ? { ...x, status: "uploading" } : x)));
  handleImageUpload([u]);
};

const discardFailed = (u) => setImages((prev) => prev.filter((x) => x.id !== u.id));

const handleImageUpload = async (files) => {

  try {
    // const uploadedImages = [];

    for (const {id,file } of files) {
      const fileName = `${file.name.replace(/ /g, "_")             // spaces → underscores
    .replace(/[^a-zA-Z0-9_\-./:]/g, "")}`;
      
        // const safeUrl = imageUrl.replace(/'/g, "''"); // escape single quotes if any

      const dest = `public/${fileName}`;

      try {
        // Write the blob to R2 (where the app serves images from).
        await uploadImageToR2(supabase, dest, file);
      } catch (uploadError) {
        console.error("R2 upload error:", uploadError);
        setImages((prev) =>
          prev.map((u) => (u.id === id ? { ...u, status: "error" } : u))
        );
        continue;
      }

      // Reuse an existing images row for this path, else insert a new one.
      let row;
      const { data: existing } = await supabase
        .from("images")
        .select("id, imageUrl")
        .eq("imageUrl", dest)
        .maybeSingle();

      if (existing) {
        row = existing;
      } else {
        const { data: insertData, error: insertError } = await supabase
          .from("images")
          .insert([{ imageUrl: dest, originalUrl: dest }])
          .select("id, imageUrl")
          .single();
        if (insertError) {
          console.error("DB insert error:", insertError);
          setImages((prev) =>
            prev.map((u) => (u.id === id ? { ...u, status: "error" } : u))
          );
          continue;
        }
        row = insertData;
      }

      setImages((prev) =>
        prev.map((u) =>
          u.id === id
            ? {
                ...u,
                status: "done",
                source: "upload",
                url: `${process.env.VITE_DB_HOST_URL}${row.imageUrl}`,
                id: row.id,
              }
            : u
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
  
    const handleDelete = async (clickedImage) => {
    // Images that already belong to a saved item are only marked here. The
    // actual unlink happens in commitChanges() when the parent form is saved,
    // so Discard leaves the item exactly as it was.
    if (clickedImage.source === 'inital' && entity && entityId) {
      showMessage(`${isCad ? "File" : "Photo"} removed. It's deleted when you save.`, {
        action: {
          label: "Undo",
          onClick: () =>
            setImages((prev) => prev.map((img) => (img.id === clickedImage.id ? { ...img, status: "done" } : img))),
        },
      });
    }

    setImages(prevImages =>
      prevImages.map(img =>
        img.id === clickedImage.id ? { ...img, status: 'delete' } : img
      )
    );
  };

  // Resolve the images-table id for a displayed URL (R2 path or legacy Supabase URL).
  const resolveImageId = async (url) => {
    const host = process.env.VITE_DB_HOST_URL || '';
    let imagePath = url || '';
    if (host && imagePath.startsWith(host)) imagePath = imagePath.slice(host.length);
    else if (imagePath.includes('/echatbot/')) imagePath = imagePath.split('/echatbot/').pop();
    imagePath = imagePath.replace(/^\/+/, '');
    const { data, error } = await supabase
      .from('images')
      .select('id')
      .eq('imageUrl', imagePath)
      .limit(1)
      .maybeSingle();
    if (error || !data) return null;
    return data.id;
  };

  // Mark one image as the main/primary image. Shown immediately, but only
  // written to the database when the parent form is saved (commitChanges).
  const setAsMain = (clickedImage) => {
    if (forDisplay || !entity || !entityId) return;
    if (clickedImage.url === primaryUrl) return;
    setPendingPrimaryUrl(clickedImage.url);
    setPrimaryUrl(clickedImage.url);
    setImages(prev => [clickedImage, ...prev.filter(i => i.url !== clickedImage.url)]);
    setImageToShow(clickedImage.url);
    showMessage("Main image will change when you save.");
  };

  // Apply the removals and main-image choice made in this session. Called by
  // the parent's Save; never called on Discard.
  const commitChanges = async () => {
    if (!entity || !entityId) return;
    for (const img of images.filter((i) => i.status === 'delete' && i.source === 'inital')) {
      const imageId = await resolveImageId(img.url);
      if (!imageId) continue;
      const { error } = await supabase
        .from('image_link')
        .delete()
        .eq('imageId', imageId)
        .eq('entity', entity)
        .eq('entityId', entityId)
        .eq('type', collection);
      if (error) console.error('Image link delete failed:', error);
    }
    if (pendingPrimaryUrl) {
      const imageId = await resolveImageId(pendingPrimaryUrl);
      if (imageId) {
        await supabase
          .from('image_link')
          .update({ is_primary: false })
          .eq('entity', entity)
          .eq('entityId', entityId)
          .eq('type', collection);
        const { error } = await supabase
          .from('image_link')
          .update({ is_primary: true })
          .eq('imageId', imageId)
          .eq('entity', entity)
          .eq('entityId', entityId)
          .eq('type', collection);
        if (error) console.error('Set main failed:', error);
      }
      setPendingPrimaryUrl(null);
    }
  };
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

  // Kevin, 2026-09-23: "drag-and-drop doesn't work on image import." Root
  // cause -- this handler never ran the real upload pipeline. It just
  // called onChange() with raw File objects mixed into the images STATE
  // array (wrong shape either way, and onChange isn't wired to upload
  // anything). The file-picker path (handleImageChange, above) is the one
  // that actually works: it builds an {id, file, status:'uploading',
  // source:'upload', url:null} record per file, adds it to state, then
  // calls handleImageUpload to push to R2 and insert the DB row. Mirror
  // that here instead of the dead onChange call.
  const handleDrop = (e) => {
    e.preventDefault();
    setDragging(false);
    addFiles(e.dataTransfer.files);
  };

  const inputId = `upload-${collection}-${uid}`;
  const visible = images.filter((u) => u.status !== "delete");
  const label = isCad ? "CAD files" : "Photos";
  const cadSelected =
    visible.find((u) => u.status === "done" && u.url === selectedCadUrl) ||
    visible.find((u) => u.status === "done") ||
    null;
  // What the big preview shows: the picked CAD file, or the picked photo.
  const shown = isCad
    ? cadSelected
    : visible.find((u) => u.status === "done" && u.url === imageToShow) || null;
  
  const ThumbButtons = ({ u }) => (
    <>
      {!forDisplay && (
        <button
          type="button"
          aria-label="Remove"
          onClick={(e) => { e.stopPropagation(); handleDelete(u); }}
          className="absolute top-0.5 right-0.5 w-5 h-5 rounded-full bg-black/60 text-white flex items-center justify-center hover:bg-red-600 md:opacity-0 md:group-hover:opacity-100 transition-opacity"
        >
          <X className="w-3 h-3" />
        </button>
      )}
      {!forDisplay && entity && entityId && isImageFile(u) && (
        <button
          type="button"
          aria-label={u.url === primaryUrl ? "Main image" : "Set as main image"}
          title={u.url === primaryUrl ? "Main image" : "Set as main image"}
          onClick={(e) => { e.stopPropagation(); setAsMain(u); }}
          className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full flex items-center justify-center transition-opacity ${
            u.url === primaryUrl
              ? "bg-yellow-400 text-white"
              : "bg-white/90 text-gray-500 hover:bg-yellow-100 md:opacity-0 md:group-hover:opacity-100"
          }`}
        >
          <Star className="w-3 h-3" fill={u.url === primaryUrl ? "currentColor" : "none"} />
        </button>
      )}
    </>
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-gray-800">
          {label}
          {visible.length > 0 && (
            <span className="ml-2 text-xs font-normal text-gray-500">{visible.length}</span>
          )}
        </span>
      </div>

      {/* Preview: same fixed size whether or not anything is uploaded */}
      <div className="relative w-full h-44 rounded-xl border border-gray-200 bg-white overflow-hidden flex items-center justify-center">
        {shown ? (
          isImageFile(shown) ? (
            <>
              <img src={shown.url} alt={nameOf(shown)} className="object-contain w-full h-full" />
              {!isCad && entity && entityId && shown.url === primaryUrl && (
                <span className="absolute top-2 left-2 text-[11px] font-medium bg-yellow-400 text-white rounded-full px-2 py-0.5">
                  Main
                </span>
              )}
            </>
          ) : (
            <div className="flex flex-col items-center gap-1.5 px-3 text-center">
              <div className="w-16 h-16 rounded-xl bg-gray-100 border border-gray-200 flex flex-col items-center justify-center">
                <FileBox className="w-6 h-6 text-gray-400" />
                <span className="text-[11px] font-semibold text-gray-600 mt-0.5">{extOf(shown)}</span>
              </div>
              <span className="text-xs text-gray-700 max-w-full truncate">{nameOf(shown)}</span>
            </div>
          )
        ) : (
          <div className="flex flex-col items-center gap-1 text-gray-400">
            {isCad ? <FileBox className="w-7 h-7" /> : <ImageIcon className="w-7 h-7" />}
            <span className="text-sm">{isCad ? "No CAD files yet" : "No photos yet"}</span>
          </div>
        )}
      </div>

      {/* Thumbnail strip: one fixed-height row that scrolls sideways */}
      <div className="h-16 flex gap-2 overflow-x-auto items-center">
        {visible.length === 0 && (
          <span className="text-xs text-gray-400 px-1">
            {isCad ? "Added files appear here" : "Added photos appear here"}
          </span>
        )}
        {visible.map((u) => (
          <div
            key={u.id}
            className={`group relative shrink-0 w-14 h-14 rounded-lg border-2 bg-gray-50 overflow-hidden ${
              u.status === "error"
                ? "border-red-300"
                : u.url && u.url === shown?.url
                  ? "border-[#C5A572]"
                  : "border-gray-200"
            }`}
          >
            {u.status === "uploading" ? (
              <div className="w-full h-full flex items-center justify-center">
                <Loader2 className="w-5 h-5 animate-spin text-[#C5A572]" />
              </div>
            ) : u.status === "error" ? (
              <div className="w-full h-full flex items-center justify-center">
                <div className="flex gap-0.5">
                  <button type="button" onClick={() => retryUpload(u)} title="Try again" className="p-0.5 rounded bg-white border border-gray-300 hover:bg-gray-100">
                    <RotateCcw className="w-3 h-3" />
                  </button>
                  <button type="button" onClick={() => discardFailed(u)} title="Remove" className="p-0.5 rounded bg-white border border-gray-300 hover:bg-gray-100">
                    <X className="w-3 h-3" />
                  </button>
                </div>
              </div>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => (isCad ? setSelectedCadUrl(u.url) : setImageToShow(u.url))}
                  className="w-full h-full flex items-center justify-center"
                  aria-label={`Show ${nameOf(u)}`}
                  title={nameOf(u)}
                >
                  {isImageFile(u) ? (
                    <img src={u.url} alt="" className="w-full h-full object-contain" />
                  ) : (
                    <span className="flex flex-col items-center">
                      <FileBox className="w-4 h-4 text-gray-400" />
                      <span className="text-[10px] font-semibold text-gray-600">{extOf(u)}</span>
                    </span>
                  )}
                </button>
                <ThumbButtons u={u} />
              </>
            )}
          </div>
        ))}
      </div>

      {/* Drop zone */}
      {!forDisplay && (
        <div
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}
          className={`rounded-xl border-2 border-dashed px-4 py-3 text-center transition-colors ${
            dragging ? "border-[#C5A572] bg-[#C5A572]/10" : "border-gray-300 bg-white hover:bg-gray-50"
          }`}
        >
          <input
            type="file"
            multiple
            accept={isCad ? "image/*,.dwg,.dxf,.step,.stp,.iges,.igs,.sat,.3dm,.stl" : "image/*"}
            onChange={handleImageChange}
            className="hidden"
            id={inputId}
          />
          <div className="flex flex-col items-center gap-1.5">
            <label
              htmlFor={inputId}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-gray-900 text-white text-[13px] font-medium cursor-pointer hover:bg-black"
            >
              <Upload className="w-4 h-4" />
              Add {isCad ? "files" : "photos"}
            </label>
            <p className="text-gray-700 text-sm">
              {dragging ? "Drop to upload" : `or drop ${isCad ? "CAD files" : "photos"} here`}
            </p>
            <p className="text-xs text-gray-500">
              {isCad
                ? "DWG, DXF, STEP, IGES, STL, 3DM or images · up to 100 MB each"
                : "JPG, PNG or WEBP · up to 25 MB each"}
            </p>
          </div>
        </div>
      )}
    </div>
  );
};

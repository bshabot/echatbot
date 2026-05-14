import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from "react-router-dom";
import { useSupabase } from '../SupaBaseProvider';
import { useDrag, useDrop, DndProvider } from 'react-dnd';
import { HTML5Backend } from 'react-dnd-html5-backend';
import { v4 as uuidv4 } from 'uuid';

// Editable Text Component
const EditableText = ({ elementId, content, currentSlide, currentSlideId, setSlides }) => {
  const [isEditing, setIsEditing] = useState(false);
  const [text, setText] = useState(content);
  const inputRef = useRef(null);
  
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isEditing]);
  
  const handleDoubleClick = () => {
    setIsEditing(true);
  };
  
  const handleBlur = () => {
    setIsEditing(false);
    
    // Update the element with new text
    if (text !== content && currentSlide) {
      const updatedElements = currentSlide.elements.map(el => 
        el.id === elementId ? { ...el, content: text } : el
      );
      
      const updatedSlide = {
        ...currentSlide,
        elements: updatedElements
      };
      
      setSlides(slides => slides.map(s => 
        s.id === currentSlideId ? updatedSlide : s
      ));
    }
  };
  
  const handleChange = (e) => {
    setText(e.target.value);
  };
  
  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      handleBlur();
    }
  };
  
  return isEditing ? (
    <input
      ref={inputRef}
      type="text"
      value={text}
      onChange={handleChange}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
      className="bg-transparent border-b border-gray-400 outline-none w-full"
    />
  ) : (
    <div onDoubleClick={handleDoubleClick} className="cursor-text">
      {content}
    </div>
  );
};

// Create a wrapper component that provides the DndProvider
function SlideEditorWrapper({ onSave, initialData, setIdeaForm, readOnly=false,onExport }) {
  const [slides, setSlides] = useState([]);

  useEffect(() =>{
    if(setIdeaForm){
      setIdeaForm(slides)
    }
  },[slides])

  useEffect(() =>{
    console.log('Initial Data:', initialData);
    if(readOnly){
      setSlides(initialData);
      console.log('Setting slides for readOnly mode:', initialData.length > 0 ? initialData[0] : []);
      return
    }
    setSlides(initialData || [])
  },[initialData])

  
  return (
    <DndProvider backend={HTML5Backend}>
      <SlideEditor onSave={onSave} initialData={initialData} slides={slides} setSlides={setSlides} readOnly={readOnly} onExport={onExport} />
    </DndProvider>
  );
}

// Constants outside component
const ItemTypes = {
  ELEMENT: 'element',
};

// DraggableElement as a separate component outside SlideEditor
function DraggableElement(props) {
  const {
    id, left, top, type, content, src,
    width, height,
    onDelete, currentSlide, currentSlideId, setSlides, readOnly,
    isSelected, onSelect, onResize,
  } = props;
  const ref = useRef(null);
  const resizingRef = useRef(false);

  const [{ isDragging }, drag, preview] = useDrag({
    type: ItemTypes.ELEMENT,
    item: { id, left, top, type, content, src, width, height },
    collect: (monitor) => ({
      isDragging: monitor.isDragging(),
    }),
    canDrag: () => !readOnly && !resizingRef.current,
  });

  useEffect(() => {
    // Disable the default drag preview
    preview(null);
  }, [preview]);

  useEffect(() => {
    if (!readOnly) {
      drag(ref); // Attach drag behavior to the actual DOM element
    }
  }, [readOnly, drag]);

  // Default size when not set: 250×250 for images, content-fit for text.
  const effectiveWidth = width || (type === 'image' ? 250 : undefined);
  const effectiveHeight = height || (type === 'image' ? 250 : undefined);

  // Clean default styling — no debug yellow box. Selection state is the only visual chrome.
  const style = {
    position: 'absolute',
    left: `${left}px`,
    top: `${top}px`,
    cursor: readOnly ? 'default' : 'move',
    opacity: isDragging ? 0.5 : 1,
    padding: type === 'text' ? '4px 6px' : '0',
    border: isSelected && !readOnly ? '2px solid #2563eb' : '2px solid transparent',
    backgroundColor: 'transparent',
    width: effectiveWidth ? `${effectiveWidth}px` : undefined,
    height: effectiveHeight ? `${effectiveHeight}px` : undefined,
    minWidth: type === 'text' && !width ? '50px' : undefined,
    minHeight: type === 'text' && !height ? '20px' : undefined,
    zIndex: type === 'text' ? 20 : 10,
    borderRadius: '4px',
    boxShadow: isSelected && !readOnly ? '0 0 0 1px rgba(37, 99, 235, 0.2)' : 'none',
  };

  const handleClick = (e) => {
    if (readOnly) return;
    e.stopPropagation();
    onSelect && onSelect(id);
  };

  // Bottom-right resize handle. Updates width/height as user drags.
  const handleResizeMouseDown = (e) => {
    if (readOnly || !onResize) return;
    e.preventDefault();
    e.stopPropagation();
    resizingRef.current = true;
    const startX = e.clientX;
    const startY = e.clientY;
    const startW = effectiveWidth || (type === 'image' ? 250 : 100);
    const startH = effectiveHeight || (type === 'image' ? 250 : 50);

    const handleMove = (ev) => {
      const newW = Math.max(20, Math.round(startW + (ev.clientX - startX)));
      const newH = Math.max(20, Math.round(startH + (ev.clientY - startY)));
      onResize(id, { width: newW, height: newH });
    };
    const handleUp = () => {
      resizingRef.current = false;
      document.removeEventListener('mousemove', handleMove);
      document.removeEventListener('mouseup', handleUp);
    };
    document.addEventListener('mousemove', handleMove);
    document.addEventListener('mouseup', handleUp);
  };

  return (
    <div
      ref={ref}
      style={style}
      className="group"
      onClick={handleClick}
    >
      {/* Delete button — only shows when element is selected (less visual noise) */}
      {!readOnly && isSelected && (
        <button
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onDelete(id);
          }}
          className="absolute -right-2 -top-2 bg-red-500 text-white rounded-full w-6 h-6 flex items-center justify-center hover:bg-red-600 z-30 shadow"
          style={{ fontSize: '12px' }}
          title="Delete element"
        >
          ×
        </button>
      )}

      {/* Resize handle — bottom-right corner, only when selected. */}
      {!readOnly && isSelected && (
        <div
          onMouseDown={handleResizeMouseDown}
          className="absolute -right-1.5 -bottom-1.5 w-3 h-3 bg-blue-600 border-2 border-white z-30 hover:bg-blue-700"
          style={{ cursor: 'nwse-resize' }}
          title="Drag to resize"
        />
      )}

      {type === 'image' ? (
        <img
          src={src && src.startsWith('http') ? src : `${process.env.VITE_DB_HOST_URL}${src}`}
          alt={content || 'Draggable Image'}
          style={{
            width: effectiveWidth ? `${effectiveWidth}px` : '250px',
            height: effectiveHeight ? `${effectiveHeight}px` : '250px',
            objectFit: 'cover',
            display: 'block',
            pointerEvents: 'none', // let parent handle clicks for selection
          }}
        />
      ) : (
        <EditableText
          elementId={id}
          content={content}
          currentSlide={currentSlide}
          currentSlideId={currentSlideId}
          setSlides={setSlides}
        />
      )}
    </div>
  );
}

// Main SlideEditor component
function SlideEditor({ onSave, slides, setSlides,readOnly,onExport }) {
  // console.log(readOnly)

  // const [slides, setSlides] = useState([]);
  const [currentSlideId, setCurrentSlideId] = useState(null);
  const [showConfirmationModal, setShowConfirmationModal] = useState(false);
  const [slideToRemove, setSlideToRemove] = useState(null);
  // Track which element is currently selected — drives selection ring + delete button visibility
  const [selectedElementId, setSelectedElementId] = useState(null);

  const {supabase} = useSupabase();
  const fileInputRef = useRef(null);
  const importInputRef = useRef(null); // separate file input for "Import as slides"
  const slideContainerRef = useRef(null);
  const isInitialMount = useRef(true);

  useEffect(() => {
    if (currentSlideId===null) {
      isInitialMount.current = false;
      setCurrentSlideId(slides.length > 0 ? slides[0].id : null);
      console.log('Initial slides set:', slides);
    } else {
      console.log('Slides updated:', slides);
    }
  }, [slides]);

  // Clear selection when switching slides so the selection ring doesn't follow you across slides.
  useEffect(() => {
    setSelectedElementId(null);
  }, [currentSlideId]);

  // Keyboard shortcuts: Delete/Backspace = remove element, Esc = deselect, arrows = nudge.
  // Skipped when user is typing in an input/textarea so EditableText edit mode works normally.
  useEffect(() => {
    if (readOnly) return;
    const handleKeyDown = (e) => {
      const active = document.activeElement;
      if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) {
        return;
      }
      if (!selectedElementId) {
        if (e.key === 'Escape') setSelectedElementId(null);
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        if (!currentSlide) return;
        const updatedElements = (currentSlide.elements || []).filter(el => el.id !== selectedElementId);
        setSlides(slides.map(s =>
          s.id === currentSlideId ? { ...s, elements: updatedElements } : s
        ));
        setSelectedElementId(null);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        setSelectedElementId(null);
      } else if (e.key.startsWith('Arrow')) {
        e.preventDefault();
        const step = e.shiftKey ? 1 : 10;
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
        if ((dx !== 0 || dy !== 0) && currentSlide) {
          const updatedElements = (currentSlide.elements || []).map(el =>
            el.id === selectedElementId
              ? { ...el, left: (el.left || 0) + dx, top: (el.top || 0) + dy }
              : el
          );
          setSlides(slides.map(s =>
            s.id === currentSlideId ? { ...s, elements: updatedElements } : s
          ));
        }
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [selectedElementId, currentSlide, currentSlideId, slides, readOnly]);
  // Find current slide
  console.log(slides, 'slides in slide editor');
  const currentSlide = slides ? slides.find(slide => slide.id === currentSlideId)  : null;

  

  // Element Movement Function
  const moveElement = useCallback((id, left, top) => {
    if (!currentSlide) return;
  
    // Update element position without clamping
    const updatedElements = (currentSlide.elements || []).map((element) =>
      element.id === id ? { ...element, left, top } : element
    );
  
    const updatedSlide = { ...currentSlide, elements: updatedElements };
  
    // Update state
    setSlides(
      slides.map((slide) =>
        slide.id === currentSlideId ? updatedSlide : slide
      )
    );
  }, [currentSlide, currentSlideId, slides]);

  // Drop target handler
  const [{ isOver }, drop] = useDrop({
    accept: ItemTypes.ELEMENT,
    drop: (item, monitor) => {
      const offset = monitor.getClientOffset();
      const containerRect = slideContainerRef.current?.getBoundingClientRect();

      if (!offset || !containerRect) return;

      const newLeft = Math.round(offset.x - containerRect.left);
      const newTop = Math.round(offset.y - containerRect.top);

      moveElement(item.id, newLeft, newTop);
    },
    collect: monitor => ({
      isOver: !!monitor.isOver(),
    }),
  });

  // Ref combining function
  const setDropTargetRef = useCallback(node => {
    slideContainerRef.current = node;
    drop(node);
  }, [drop]);

  // Add a new slide
  const addSlide = async (e) => {
    e.preventDefault();
    
    const newSlide = { 
      id: uuidv4(), 
      elements: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    
    
    
    setSlides([...slides, newSlide]);
    setCurrentSlideId(newSlide.id);
  };

  // Remove a slide
  const removeSlide = async (e, id) => {
    e.preventDefault();
    
    const remainingSlides = slides.filter(slide => slide.id !== id);
    setSlides(remainingSlides);
    
    if (currentSlideId === id) {
      setCurrentSlideId(remainingSlides.length > 0 ? remainingSlides[0].id : null);
    }
  };

  // Add text element to slide
  const addTextElement = (e) => {
    e.preventDefault();

    if (!currentSlide) return;
    
    const newElement = {
      id: uuidv4(),
      type: 'text',
      content: 'New Text',
      left: 50,
      top: 50,
    };
    
    const updatedSlide = {
      ...currentSlide,
      elements: [...(currentSlide.elements || []), newElement]
    };
    
    setSlides(slides.map(s => 
      s.id === currentSlideId ? updatedSlide : s
    ));
  };

  // Upload a single File to Supabase Storage, return the storage PATH (not full URL).
  // DraggableElement and the thumbnail preview prepend VITE_DB_HOST_URL when rendering.
  const uploadImageFile = async (file) => {
    if (!supabase) return null;
    const fileName = `${uuidv4()}-${file.name}`;
    const filePath = `idea-images/${fileName}`;
    const { error: uploadError } = await supabase.storage
      .from('echatbot')
      .upload(filePath, file);
    if (uploadError) {
      console.error(`Error uploading ${file.name}:`, uploadError);
      return null;
    }
    return filePath;
  };

  // Handle image upload — multiple images auto-arrange in a grid on the current slide
  // (instead of stacking on top of each other at the same position).
  const handleImageUpload = async (event) => {
    if (!currentSlide || !event.target.files || event.target.files.length === 0 || !supabase) return;

    try {
      const files = Array.from(event.target.files);
      const uploadedElements = [];
      const IMAGE_W = 250;
      const IMAGE_H = 250;
      const PAD = 20;
      const COLS = 3; // 3 images per row, then wraps

      for (let i = 0; i < files.length; i++) {
        const publicUrl = await uploadImageFile(files[i]);
        if (!publicUrl) continue;
        const col = i % COLS;
        const row = Math.floor(i / COLS);
        uploadedElements.push({
          id: uuidv4(),
          type: 'image',
          src: publicUrl,
          content: files[i].name,
          left: PAD + col * (IMAGE_W + PAD),
          top: PAD + row * (IMAGE_H + PAD),
          width: IMAGE_W,
          height: IMAGE_H,
        });
      }

      const updatedSlide = {
        ...currentSlide,
        elements: [...(currentSlide.elements || []), ...uploadedElements]
      };
      setSlides(slides.map(s =>
        s.id === currentSlideId ? updatedSlide : s
      ));

      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    } catch (error) {
      console.error('Error uploading image:', error);
    }
  };

  // Import images as NEW slides — each image becomes its own slide with the image centered.
  const importImagesAsSlides = async (event) => {
    if (!event.target.files || event.target.files.length === 0 || !supabase) return;
    try {
      const files = Array.from(event.target.files);
      const SLIDE_W = 800;
      const SLIDE_H = 600;
      const IMG_W = 600;
      const IMG_H = 450;
      const newSlides = [];

      for (const file of files) {
        const publicUrl = await uploadImageFile(file);
        if (!publicUrl) continue;
        newSlides.push({
          id: uuidv4(),
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          elements: [{
            id: uuidv4(),
            type: 'image',
            src: publicUrl,
            content: file.name,
            left: Math.floor((SLIDE_W - IMG_W) / 2),
            top: Math.floor((SLIDE_H - IMG_H) / 2),
            width: IMG_W,
            height: IMG_H,
          }],
        });
      }

      if (newSlides.length > 0) {
        setSlides([...slides, ...newSlides]);
        setCurrentSlideId(newSlides[0].id);
      }
      if (importInputRef.current) {
        importInputRef.current.value = '';
      }
    } catch (error) {
      console.error('Error importing slides:', error);
    }
  };

  // Duplicate the current slide (with all its elements, fresh ids).
  const duplicateCurrentSlide = (e) => {
    e?.preventDefault?.();
    if (!currentSlide) return;
    const cloned = {
      id: uuidv4(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      elements: (currentSlide.elements || []).map(el => ({
        ...el,
        id: uuidv4(),
      })),
    };
    // Insert right after the current slide
    const idx = slides.findIndex(s => s.id === currentSlideId);
    const next = [...slides.slice(0, idx + 1), cloned, ...slides.slice(idx + 1)];
    setSlides(next);
    setCurrentSlideId(cloned.id);
  };

  // Trigger file input click
  const triggerImageUpload = (e) => {
    e.preventDefault();
    e.stopPropagation(); // Prevent event bubbling
    if (fileInputRef.current) {
      fileInputRef.current.click();
    }
  };

  // Add function to delete an element
  const deleteElement = (elementId) => {
    if (!currentSlide) return;

    // Filter out the element to be deleted
    const updatedElements = (currentSlide.elements || []).filter(
      element => element.id !== elementId
    );

    const updatedSlide = {
      ...currentSlide,
      elements: updatedElements
    };

    // Update state
    setSlides(slides.map(s =>
      s.id === currentSlideId ? updatedSlide : s
    ));
    // Clear selection if the deleted element was selected
    if (selectedElementId === elementId) {
      setSelectedElementId(null);
    }
  };



  // Export current design as a JSON object


  //confirmation messeage on delete
  const handleRemoveSlideClick = (e, id) => {
    e.preventDefault();
    setSlideToRemove(id);
    setShowConfirmationModal(true);
  };
  const confirmRemoveSlide = () => {
    if (slideToRemove) {
      // const slideToRemove = slides.find(slide => slide.id === slideToRemove);
      // const slideElements = slideToRemove.elements.length > 0 ? slideToRemove.elements : null;
      // If the slide has elements, we can proceed with removal of the elements 
      const remainingSlides = slides.filter(slide => slide.id !== slideToRemove);
      setSlides(remainingSlides);
  
      if (currentSlideId === slideToRemove) {
        setCurrentSlideId(remainingSlides.length > 0 ? remainingSlides[0].id : null);
      }
      
    }
  
    setShowConfirmationModal(false);
    setSlideToRemove(null);
  };
  const cancelRemoveSlide = () => {
    setShowConfirmationModal(false);
    setSlideToRemove(null);
  };

  // Resize callback used by DraggableElement when user drags the resize handle.
  const handleResize = (elementId, { width, height }) => {
    if (!currentSlide) return;
    const updatedElements = (currentSlide.elements || []).map(el =>
      el.id === elementId ? { ...el, width, height } : el
    );
    setSlides(slides.map(s =>
      s.id === currentSlideId ? { ...s, elements: updatedElements } : s
    ));
  };

  // Small helper: render a scaled-down preview of a slide for the thumbnail sidebar.
  const renderThumbnailPreview = (slide) => {
    const SLIDE_W = 800;
    const SLIDE_H = 600;
    const THUMB_W = 168; // sidebar item width minus padding
    const scale = THUMB_W / SLIDE_W;
    return (
      <div
        style={{
          position: 'relative',
          width: `${THUMB_W}px`,
          height: `${SLIDE_H * scale}px`,
          background: 'white',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            width: `${SLIDE_W}px`,
            height: `${SLIDE_H}px`,
            transform: `scale(${scale})`,
            transformOrigin: 'top left',
            pointerEvents: 'none',
          }}
        >
          {(slide.elements || []).map((el) => {
            const w = el.width || (el.type === 'image' ? 250 : 100);
            const h = el.height || (el.type === 'image' ? 250 : 24);
            return (
              <div
                key={el.id}
                style={{
                  position: 'absolute',
                  left: `${el.left || 0}px`,
                  top: `${el.top || 0}px`,
                  width: `${w}px`,
                  height: `${h}px`,
                }}
              >
                {el.type === 'image' && el.src ? (
                  <img
                    src={el.src.startsWith('http') ? el.src : `${process.env.VITE_DB_HOST_URL}${el.src}`}
                    alt=""
                    style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                  />
                ) : (
                  <div style={{ fontSize: '14px', lineHeight: 1.2, padding: '2px', whiteSpace: 'nowrap', overflow: 'hidden' }}>
                    {el.content}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <div className="slideshow-editor p-4 flex flex-col h-screen max-h-full">
      {/* Top Toolbar */}
      {!readOnly && (
        <div className="controls mb-3 flex items-center gap-2 flex-wrap">
          <h2 className="text-xl font-semibold mr-2">Slide Editor</h2>
          <button onClick={addSlide} className="bg-blue-500 text-white px-3 py-1 rounded hover:bg-blue-600">
            + Slide
          </button>
          <button
            onClick={duplicateCurrentSlide}
            disabled={!currentSlide}
            className="bg-blue-100 text-blue-800 px-3 py-1 rounded hover:bg-blue-200 disabled:opacity-50"
          >
            Duplicate Slide
          </button>
          <button
            onClick={(e) => currentSlide && handleRemoveSlideClick(e, currentSlide.id)}
            className="bg-red-500 text-white px-3 py-1 rounded hover:bg-red-600 disabled:opacity-50"
            disabled={!currentSlide || slides.length <= 1}
          >
            Remove Slide
          </button>
          <span className="mx-2 h-6 w-px bg-gray-300" />
          <button
            onClick={addTextElement}
            disabled={!currentSlide}
            className="bg-green-500 text-white px-3 py-1 rounded hover:bg-green-600 disabled:opacity-50"
          >
            Add Text
          </button>
          <button
            onClick={triggerImageUpload}
            disabled={!currentSlide}
            className="bg-purple-500 text-white px-3 py-1 rounded hover:bg-purple-600 disabled:opacity-50"
          >
            Add Image(s)
          </button>
          <span className="mx-2 h-6 w-px bg-gray-300" />
          <button
            onClick={(e) => { e.preventDefault(); importInputRef.current?.click(); }}
            className="bg-indigo-500 text-white px-3 py-1 rounded hover:bg-indigo-600"
            title="Pick multiple images — each becomes a new slide"
          >
            Import Slides
          </button>

          <input
            type="file"
            multiple={true}
            ref={fileInputRef}
            onChange={handleImageUpload}
            accept="image/*"
            style={{ display: 'none' }}
          />
          <input
            type="file"
            multiple={true}
            ref={importInputRef}
            onChange={importImagesAsSlides}
            accept="image/*"
            style={{ display: 'none' }}
          />

          {/* Remove-slide confirmation modal */}
          {showConfirmationModal && (
            <div className="fixed inset-0 bg-black bg-opacity-50 flex justify-center items-center z-50">
              <div className="bg-white rounded-lg shadow-lg p-6 w-96">
                <h3 className="text-lg font-semibold mb-4">Confirm Slide Removal</h3>
                <p className="text-gray-600 mb-6">
                  Are you sure you want to permanently remove this slide? This action cannot be undone.
                </p>
                <div className="flex justify-end space-x-2">
                  <button
                    onClick={cancelRemoveSlide}
                    className="px-4 py-2 bg-gray-200 text-gray-800 rounded-lg hover:bg-gray-300"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={confirmRemoveSlide}
                    className="px-4 py-2 bg-red-500 text-white rounded-lg hover:bg-red-600"
                  >
                    Remove
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Body: thumbnail sidebar + slide canvas */}
      <div className="flex flex-1 overflow-hidden border border-gray-300 rounded">
        {/* Thumbnail Sidebar */}
        {!readOnly && (
          <div className="w-52 flex-shrink-0 border-r border-gray-300 bg-gray-100 overflow-y-auto p-2">
            {slides.length === 0 ? (
              <p className="text-sm text-gray-500 text-center mt-4 px-2">
                No slides yet. Click "+ Slide" or "Import Slides" to start.
              </p>
            ) : (
              slides.map((slide, index) => {
                const isActive = currentSlideId === slide.id;
                return (
                  <div
                    key={slide.id}
                    onClick={() => setCurrentSlideId(slide.id)}
                    className={`mb-2 cursor-pointer rounded overflow-hidden relative transition-shadow ${
                      isActive
                        ? 'ring-2 ring-blue-500 shadow'
                        : 'ring-1 ring-gray-300 hover:ring-gray-400'
                    }`}
                    title={`Slide ${index + 1}`}
                  >
                    <div className="absolute top-1 left-1 bg-gray-800 text-white text-xs px-1.5 py-0.5 rounded z-10">
                      {index + 1}
                    </div>
                    {renderThumbnailPreview(slide)}
                  </div>
                );
              })
            )}
          </div>
        )}

        {/* Slide Canvas */}
        <div className="flex-1 overflow-auto bg-gray-50">
          {currentSlide ? (
            <div
              ref={setDropTargetRef}
              className="slide-content relative bg-white shadow-md mx-auto my-5"
              style={{
                width: '800px',
                height: '600px',
              }}
              onClick={(e) => {
                if (e.target === e.currentTarget) {
                  setSelectedElementId(null);
                }
              }}
            >
              {(currentSlide.elements || []).map((element) => (
                <DraggableElement
                  key={element.id}
                  id={element.id}
                  left={element.left}
                  top={element.top}
                  width={element.width}
                  height={element.height}
                  type={element.type}
                  content={element.content}
                  src={element.src}
                  onDelete={deleteElement}
                  currentSlide={currentSlide}
                  currentSlideId={currentSlideId}
                  setSlides={setSlides}
                  readOnly={readOnly}
                  isSelected={selectedElementId === element.id}
                  onSelect={setSelectedElementId}
                  onResize={handleResize}
                />
              ))}
            </div>
          ) : (
            <div className="flex items-center justify-center h-full text-gray-500">
              {slides.length > 0 ? "Select a slide on the left" : "No slides yet"}
            </div>
          )}
        </div>
      </div>

      {/* Helper text */}
      {!readOnly && currentSlide && (
        <div className="text-xs text-gray-500 mt-2 text-center">
          Click an element to select it. Drag to move. Drag the corner handle to resize. Delete key removes selected. Arrow keys nudge (Shift = 1px).
        </div>
      )}
    </div>
  );
}

// Export the wrapped version with DndProvider
export default SlideEditorWrapper;

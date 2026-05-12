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
  const { id, left, top, type, content, src, onDelete, currentSlide, currentSlideId, setSlides, readOnly } = props;
  const ref = useRef(null);

  const [{ isDragging }, drag, preview] = useDrag({
    type: ItemTypes.ELEMENT,
    item: { id, left, top, type, content, src },
    collect: (monitor) => ({
      isDragging: monitor.isDragging(),
    }),
    canDrag: !readOnly,
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

  const style = {
    position: 'absolute',
    left: `${left}px`,
    top: `${top}px`,
    cursor: 'move',
    opacity: isDragging ? 0.5 : 1,
    padding: '8px',
    border: type === 'text' ? '1px dashed gray' : 'none',
    backgroundColor: type === 'text' ? 'rgba(255, 255, 0, 0.7)' : 'transparent',
    minWidth: '50px',
    minHeight: '20px',
    zIndex: type === 'text' ? 20 : 10,
    borderRadius: '4px',
  };

  return (
    <div ref={ref} style={style} className="group">
      {/* Delete button - show on hover */}
      {readOnly?null:
      <button 
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onDelete(id);
      }}
      className="absolute right-0 top-0 bg-red-500 text-white rounded-full w-6 h-6 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity z-30"
      style={{ fontSize: '12px' }}
      >
        ×
      </button>
      }

      {type === 'image' ? (
        <img
          src={`${process.env.VITE_DB_HOST_URL}${src}`}
          alt={content || 'Draggable Image'}
          style={{
            width: '250px',
            height: '250px',
            objectFit: 'cover',
            display: 'block',
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

  const {supabase} = useSupabase();
  const fileInputRef = useRef(null);
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

  // Handle image upload
  const handleImageUpload = async (event) => {
    if (!currentSlide || !event.target.files || event.target.files.length === 0 || !supabase) return;
    
    try {
      const files = Array.from(event.target.files);
      const uploadedElements = [];

      for (const file of files) {
        const fileName = `${uuidv4()}-${file.name}`;
        const filePath = `idea-images/${fileName}`;
    
        // Upload to Supabase Storage
        const { error: uploadError } = await supabase.storage
          .from('echatbot')
          .upload(filePath, file);
    
        if (uploadError) {
          console.error(`Error uploading ${file.name}:`, uploadError);
          continue;
        }
    
        // Get public URL
        const { data: { publicUrl } } = supabase.storage
          .from('echatbot')
          .getPublicUrl(filePath);
    
        if (!publicUrl) {
          console.error(`Error getting URL for ${file.name}`);
          continue;
        }
    
        // Create draggable image element
        uploadedElements.push({
          id: uuidv4(),
          type: 'image',
          src: publicUrl,
          content: file.name,
          left: 100,
          top: 100,
        });
      }

      // Update current slide with new elements
      const updatedSlide = {
        ...currentSlide,
        elements: [...(currentSlide.elements || []), ...uploadedElements]
      };

      // Update slides state
      setSlides(slides.map(s => 
        s.id === currentSlideId ? updatedSlide : s
      ));

      // Reset file input
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    } catch (error) {
      console.error('Error uploading image:', error);
    }
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
  
  return (
    <div className="slideshow-editor p-4 flex flex-col h-screen max-h-full">
      {/* Controls */}
      {!readOnly &&(
      <div className="controls mb-4 flex items-center space-x-2 flex-wrap">
        <h2 className="text-xl font-semibold mr-4 w-full sm:w-auto mb-2 sm:mb-0">Slide Editor</h2>
        <button onClick={addSlide} className="bg-blue-500 text-white px-3 py-1 rounded hover:bg-blue-600 mb-2 sm:mb-0">Add Slide</button>
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
        {slides.length > 0 && currentSlide && (
          <>
            <button 
              onClick={(e) => handleRemoveSlideClick(e,currentSlide.id)} 
              className="bg-red-500 text-white px-3 py-1 rounded hover:bg-red-600 mb-2 sm:mb-0" 
              disabled={slides.length <= 1}
            >
              Remove Current Slide
            </button>
            <button onClick={addTextElement} className="bg-green-500 text-white px-3 py-1 rounded hover:bg-green-600 mb-2 sm:mb-0">
              Add Text
            </button>
            <button onClick={triggerImageUpload} className="bg-purple-500 text-white px-3 py-1 rounded hover:bg-purple-600 mb-2 sm:mb-0">
              Add Image
      </button>

            <input
              type="file"
              multiple={true}
              ref={fileInputRef}
              onChange={handleImageUpload}
              accept="image/*"
              style={{ display: 'none' }}
            />
            
            <select
              value={currentSlideId || ''}
              onChange={(e) => {
                const selectedId = e.target.value;
                if (slides.some(s => s.id === selectedId)) {
                  setCurrentSlideId(selectedId);
                }
              }}
              className="p-1 border rounded mb-2 sm:mb-0"
            >
              {slides.map((slide, index) => (
                <option key={slide.id} value={slide.id}>
                  Slide {index + 1}
                </option>
              ))}
            </select>
            
            {/* <button 
              onClick={exportDesign} 
              className="ml-auto bg-indigo-500 text-white px-3 py-1 rounded hover:bg-indigo-600 mb-2 sm:mb-0"
            >
              Save Design
            </button> */}
          </>
        )}
        
        {slides.length === 0 && (
          <p className="w-full text-center sm:w-auto sm:text-left mb-2 sm:mb-0">
            No slides yet. Add one to start!
          </p>
        )}
      </div>)
      }
      {/* Slide Canvas */}
      <div className="slides-container flex-grow border border-gray-300 rounded bg-gray-50 overflow-auto">
        {currentSlide ? (
          <div
            ref={setDropTargetRef}
            className="slide-content w-full h-full relative"
            style={{ 
              minHeight: '600px', 
              minWidth: '800px',
              backgroundColor: 'transparent',
            }}
          >
            {(currentSlide.elements || []).map((element) => (
              <DraggableElement
                key={element.id}
                id={element.id}
                left={element.left}
                top={element.top}
                type={element.type}
                content={element.content}
                src={ element.src}
                onDelete={deleteElement}
                currentSlide={currentSlide}
                currentSlideId={currentSlideId}
                setSlides={setSlides}
                readOnly={readOnly}
              />
              ))}
            </div>
        ) : (
          <div className="flex items-center justify-center h-full text-gray-500">
            {slides.length > 0 ? "Select or add a slide" : "No Slides Available"}
          </div>
        )}
      </div>
    </div>
  );
}

// Export the wrapped version with DndProvider
export default SlideEditorWrapper;

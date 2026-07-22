import React, { useState, useRef, useCallback, useEffect } from 'react';
import { useSupabase } from '../SupaBaseProvider';
import SlideEditorWrapper from './SlideEditor';
import { X,TagIcon } from 'lucide-react';

import { v4 as uuidv4 } from 'uuid';

export default function AddIdeaModal({ isOpen, onClose, onSave }) {
  const [loading, setLoading] = useState(false);
  const [tagInput,setTagInput] = useState('');
  const {supabase} = useSupabase();
  const modalRef = useRef(null);
  const [ideaForm, setIdeaForm] = useState({
    name: '',
    description: '',
    status: 'In_Review:yellow',
    slides: [],
    created_at: new Date().toISOString(),
    tags: []
  });

 
  // Handle form submission
  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!ideaForm.name.trim()) return;

    setLoading(true);
    try {
      // Add the idea with slides data included
      const newIdea = {
       ...ideaForm, 
        slides: ideaForm.slides ? ideaForm.slides : [],
      };

      const { data,error } = await supabase.from('ideas').insert(newIdea).select();
      
      if (error) throw error;
      
      // Reset form and close modal
      setIdeaForm({
        name: '',
        description: '',
        status: 'In_Review:yellow',
        slides: [],
        created_at: new Date().toISOString(),
        tags: []
      });

      onSave(data[0]); // Notify parent component
      // Refresh ideas list
    } catch (error) {
      console.error('Error adding idea:', error);
    } finally {
      setLoading(false);
    }
  };
  const removeTag = (tag) => {
    setIdeaForm({ ...ideaForm, tags: ideaForm.tags.filter((t) => t !== tag) });
  };
  const handleAddTag = (e) => {
    console.log(e,'e.target.value');
    if (e.key === 'Enter' && tagInput.trim()) {
      e.preventDefault();
      if (!ideaForm.tags?.includes(tagInput.trim())) {
        setIdeaForm({
          ...ideaForm,
          tags: [...(ideaForm.tags || []), tagInput.trim()],
        });
      }
      setTagInput('');
    }
  };

  // Handle design export when the design is saved
  const handleDesignExport = useCallback((designData) => {
    setSlideData(designData);
  }, []);

  // Close modal when clicking outside
  const handleClickOutside = (e) => {
    if (modalRef.current && !modalRef.current.contains(e.target)) {
      onClose();
    }
  };
  const handleFormChange = (e) => {
    const { name, value } = e.target;
    setIdeaForm(prev => ({ ...prev, [name]: value }));
  };

  if (!isOpen) return null;

  return (
    <div 
      className="fixed inset-0 bg-black bg-opacity-50 flex justify-center items-center p-4 z-50"
      onClick={handleClickOutside}
    >
      <div 
        ref={modalRef}
        className="bg-white rounded-2xl shadow-xl w-full max-w-6xl max-h-[90vh] overflow-auto relative"
        onClick={e => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          className="absolute top-4 right-4 p-2 rounded-full hover:bg-gray-100 transition-colors"
        >
          <X className="w-5 h-5 text-gray-500" />
        </button>
        
        <div className="p-6">
          <h2 className="text-2xl font-bold mb-4">Add New Idea</h2>
          
          <form onSubmit={handleSubmit}>
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Design Your Idea
              </label>
              <div className="border border-gray-300 rounded-lg h-[500px] overflow-hidden">
                <SlideEditorWrapper
                  setIdeaForm={(data) => setIdeaForm({...ideaForm, slides: data})}
                  onExport={handleDesignExport}
                />
              </div>
              <p className="hidden max-md:block text-xs text-gray-400 mt-1">
                Slide editing (drag &amp; drop) works best on desktop.
              </p>
            </div>
            
            <div className="mb-4">
              <label htmlFor="name" className="block text-sm font-medium text-gray-700 mb-1">
                Name
              </label>
              <input
                type="text"
                id="name"
                name="name"
                placeholder="Enter idea Name"
                value={ideaForm.name}
                onChange={handleFormChange}
                className="w-full p-2 border border-gray-300 rounded-lg"
                required
              />
            </div>
            
            <div className="mb-4">
              <label htmlFor="description" className="block text-sm font-medium text-gray-700 mb-1">
                Description
              </label>
              <textarea
                id="description"
                name="description"
                value={ideaForm.description}
                onChange={handleFormChange}
                className="w-full p-2 border border-gray-300 rounded-lg"
                rows="3"
              />
            </div>
            <div>
            <label className="block text-sm font-medium text-gray-700">
              Tags
            </label>
            <div className="mt-1">
              <div className="flex flex-wrap gap-2 mb-2">
                {ideaForm.tags?.map((tag) => (
                  <span
                    key={tag}
                    className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-700"
                    >
                    <TagIcon className="w-3 h-3 mr-1" />
                    {tag}
                    <button
                      type="button"
                      onClick={() => removeTag(tag)}
                      className="ml-1 text-gray-400 hover:text-gray-600"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                ))}
              </div>
              <input
                type="text"
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={handleAddTag}
                // onSubmit={handleAddTag}
                placeholder="Type a tag and press Enter"
                className="input block w-full rounded-md border-gray-300 shadow-sm focus:border-chabot-gold focus:ring-chabot-gold"
              />
            </div>
              
              </div>
            <div className="mb-4">
              <label htmlFor="status" className="block text-sm font-medium text-gray-700 mb-1">
                Status
              </label>
              <select
                id="status"
                name='status'
                value={ideaForm.status}
                onChange={handleFormChange}
                className="w-full p-2 border border-gray-300 rounded-lg"
              >
                  <option value="In_Review:yellow">In Review</option> 
                  <option value="Approved:green">Approved</option>
                  <option value="Rejected:red">Rejected</option> 
              </select>
            </div>
            
            <div className="flex justify-end space-x-2">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 bg-gray-200 text-gray-800 rounded-lg hover:bg-gray-300"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-2 bg-chabot-gold text-white rounded-lg hover:bg-opacity-90"
                disabled={loading}
              >
                {loading ? 'Adding...' : 'Add Idea'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
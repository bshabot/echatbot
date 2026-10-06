import React, { useState, useCallback } from 'react';
import useEscapeKey from '../../Hooks/useEscapeKey';
import { useMessage } from '../Messages/MessageContext';
import { useAlert } from '../Alerts/AlertContext';
import { StatusPills } from '../FormSections';
import { useSupabase } from '../SupaBaseProvider';
import SlideEditorWrapper from './SlideEditor';
import { X,TagIcon } from 'lucide-react';

const IDEA_STATUS_OPTIONS = [
  { value: 'In_Review:yellow', label: 'In review', dot: 'bg-yellow-500', on: 'border-yellow-400 bg-yellow-50 text-yellow-800' },
  { value: 'Approved:green', label: 'Approved', dot: 'bg-green-500', on: 'border-green-400 bg-green-50 text-green-800' },
  { value: 'Rejected:red', label: 'Rejected', dot: 'bg-red-500', on: 'border-red-400 bg-red-50 text-red-800' },
];

const SectionTitle = ({ children, hint }) => (
  <div className="flex items-baseline gap-2 mb-3">
    <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500">{children}</h3>
    {hint && <span className="text-xs text-gray-400">{hint}</span>}
  </div>
);

export default function AddIdeaModal({ isOpen, onClose, onSave }) {
  const [loading, setLoading] = useState(false);
  const [tagInput,setTagInput] = useState('');
  const {supabase} = useSupabase();
  const { showMessage } = useMessage();
  const { showConfirm } = useAlert();
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
      showMessage('Idea added', { type: 'success' });
      // Refresh ideas list
    } catch (error) {
      console.error('Error adding idea:', error);
      showMessage('Could not add the idea: ' + (error.message || 'unknown error'), { type: 'error' });
    } finally {
      setLoading(false);
    }
  };
  const removeTag = (tag) => {
    setIdeaForm({ ...ideaForm, tags: ideaForm.tags.filter((t) => t !== tag) });
  };
  const handleAddTag = (e) => {
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

  const isDirty =
    ideaForm.name.trim() !== '' ||
    ideaForm.description.trim() !== '' ||
    (ideaForm.tags?.length || 0) > 0 ||
    (ideaForm.slides?.length || 0) > 0;

  const requestClose = async () => {
    if (isDirty && !loading) {
      const ok = await showConfirm('Discard this new idea?');
      if (!ok) return;
    }
    onClose();
  };
  useEscapeKey(requestClose, isOpen);

  const handleFormChange = (e) => {
    const { name, value } = e.target;
    setIdeaForm(prev => ({ ...prev, [name]: value }));
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/40 flex justify-center items-center p-4 z-50">
      <div
        role="dialog"
        aria-modal="true"
        className="bg-white rounded-2xl shadow-xl w-full max-w-6xl max-h-[92vh] flex flex-col overflow-hidden"
      >
        <div className="flex justify-between items-center px-6 py-4 border-b shrink-0">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-gray-900">New idea</h2>
            {ideaForm.name && <p className="text-sm text-gray-500 truncate">{ideaForm.name}</p>}
          </div>
          <button
            type="button"
            onClick={requestClose}
            aria-label="Close"
            className="p-1.5 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col flex-1 min-h-0">
          <div className="flex-1 min-h-0 overflow-y-auto p-6 space-y-6 [&_label]:text-sm [&_label]:font-medium [&_label]:text-gray-700">
            <div>
              <SectionTitle hint="Drag and drop to arrange">Slide</SectionTitle>
              <div className="border border-gray-300 rounded-lg h-[500px] overflow-hidden">
                <SlideEditorWrapper
                  setIdeaForm={(data) => setIdeaForm((f) => ({ ...f, slides: data }))}
                  onExport={handleDesignExport}
                />
              </div>
              <p className="hidden max-md:block text-xs text-gray-400 mt-1">
                Slide editing (drag &amp; drop) works best on desktop.
              </p>
            </div>

            <div className="pt-6 border-t border-gray-200">
              <SectionTitle>Details</SectionTitle>
              <div className="space-y-4">
                <div>
                  <label htmlFor="name" className="block">
                    Name <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    id="name"
                    name="name"
                    placeholder="Enter idea name"
                    value={ideaForm.name}
                    onChange={handleFormChange}
                    className="input mt-1 block w-full rounded-md border-gray-300 shadow-sm"
                    required
                    autoFocus
                  />
                </div>
                <StatusPills
                  value={ideaForm.status}
                  onChange={(v) => setIdeaForm((f) => ({ ...f, status: v }))}
                  options={IDEA_STATUS_OPTIONS}
                />
                <div>
                  <label htmlFor="description" className="block">Description</label>
                  <textarea
                    id="description"
                    name="description"
                    value={ideaForm.description}
                    onChange={handleFormChange}
                    className="input mt-1 block w-full rounded-md border-gray-300 shadow-sm"
                    rows={4}
                  />
                </div>
                <div>
                  <label htmlFor="idea-tags" className="block">Tags</label>
                  {ideaForm.tags?.length > 0 && (
                    <div className="flex flex-wrap gap-2 mt-1">
                      {ideaForm.tags.map((tag) => (
                        <span key={tag} className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-700">
                          <TagIcon className="w-3 h-3 mr-1" />
                          {tag}
                          <button type="button" onClick={() => removeTag(tag)} aria-label={`Remove ${tag}`} className="ml-1 text-gray-400 hover:text-gray-600">
                            <X className="w-3 h-3" />
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                  <input
                    id="idea-tags"
                    type="text"
                    value={tagInput}
                    onChange={(e) => setTagInput(e.target.value)}
                    onKeyDown={handleAddTag}
                    placeholder="Type a tag and press Enter"
                    className="input mt-2 block w-full rounded-md border-gray-300 shadow-sm focus:border-chabot-gold focus:ring-chabot-gold"
                  />
                </div>
              </div>
            </div>
          </div>

          <div className="flex items-center justify-end gap-3 border-t px-6 py-4 shrink-0 bg-white">
            {isDirty && <span className="mr-auto text-xs text-amber-600">Unsaved idea</span>}
            <button
              type="button"
              onClick={requestClose}
              className="px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 border border-gray-300 rounded-lg"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-4 py-2 text-sm font-medium text-white bg-chabot-gold hover:bg-opacity-90 rounded-lg disabled:opacity-60"
              disabled={loading || !ideaForm.name.trim()}
            >
              {loading ? 'Adding…' : 'Add idea'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

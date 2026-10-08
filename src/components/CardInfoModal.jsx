'use client'
import useEscapeKey from "../Hooks/useEscapeKey";
import React, { useState, Fragment,useEffect } from 'react';
import { Dialog, Transition } from '@headlessui/react';
import { X,TagIcon } from 'lucide-react';
import ImageUpload from './ImageUpload';
import ConfirmationModal from './ConfirmationModal';
import { useSupabase,handleImageUpload } from './SupaBaseProvider';
import SlideEditorWrapper from './Ideas/SlideEditor';
import IdeaNotes from './Ideas/IdeaNotes';
import ExportIdeaButton from './Pdf/ExportIdeaButton';
import { useMessage } from './Messages/MessageContext';
import { useAlert } from './Alerts/AlertContext';
import { StatusPills } from './FormSections';

const IDEA_STATUS_OPTIONS = [
  { value: 'In_Review:yellow', label: 'In review', dot: 'bg-yellow-500', on: 'border-yellow-400 bg-yellow-50 text-yellow-800' },
  { value: 'Approved:green', label: 'Approved', dot: 'bg-green-500', on: 'border-green-400 bg-green-50 text-green-800' },
  { value: 'Rejected:red', label: 'Rejected', dot: 'bg-red-500', on: 'border-red-400 bg-red-50 text-red-800' },
];

const normStatus = (v) => {
  const k = String(v || '').split(':')[0].toLowerCase();
  return IDEA_STATUS_OPTIONS.find((o) => o.value.split(':')[0].toLowerCase() === k)?.value || v;
};

const SectionTitle = ({ children, hint }) => (
  <div className="flex items-baseline gap-2 mb-3">
    <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500">{children}</h3>
    {hint && <span className="text-xs text-gray-400">{hint}</span>}
  </div>
);

const CardInfoModal = ({ isOpen, onClose, idea,updateIdea}) => {
  const { showMessage } = useMessage();
  const { showConfirm } = useAlert();
  const [saving, setSaving] = useState(false);
    const {supabase} = useSupabase();
    const [tagInput, setTagInput] = useState('');
    const [confirmationModal, setConfirmationModal] = useState(false);
    
    const [originalData, setOriginalData] = useState({
        id: idea.id,
        name: idea.name,
        description: idea.description,
        tags: JSON.parse(idea.tags),
        slides: idea.slides,
        status: idea.status,
        comments: idea.comments,
        created_at: idea.created_at,  
      });
      const {slides ,...rest} = originalData
      const [formData, setFormData] = useState({ ...rest,slides: null });
    
      useEffect(() => {
        setOriginalData({
            id: idea.id,
            name: idea.name,
            description: idea.description,
            tags: JSON.parse(idea.tags),
            slides: idea.slides,
            status: idea.status,
            comments: idea.comments,
            created_at: idea.created_at,  
        });
        setFormData({
            id: idea.id,
            name: idea.name,
            description: idea.description,
            tags: JSON.parse(idea.tags),
            slides: null,
            status: idea.status,
            comments: idea.comments,
            created_at: idea.created_at,  
        });
      }, [idea,isOpen]);

  const isDirty =
    formData.name !== originalData.name ||
    formData.description !== originalData.description ||
    formData.status !== originalData.status ||
    formData.comments !== originalData.comments ||
    JSON.stringify(formData.tags) !== JSON.stringify(originalData.tags) ||
    !!formData.slides;

  const requestClose = async () => {
    if (isDirty && !saving) {
      const ok = await showConfirm('Discard your changes to this idea?');
      if (!ok) return;
    }
    onClose();
  };
  useEscapeKey(requestClose, isOpen);

  const handleInputChange = (e) => {
    const { name, value } = e.target;
    setFormData({ ...formData, [name]: value });
  };
  


  const handleAddTag = (e) => {
    if (e.key === 'Enter' && tagInput.trim()) {
      e.preventDefault();
      if (!formData.tags?.includes(tagInput.trim())) {
        setFormData({
          ...formData,
          tags: [...(formData.tags || []), tagInput.trim()],
        });
      }
      setTagInput('');
    }
  };
  
  const removeTag = (tag) => {
    setFormData({ ...formData, tags: formData.tags.filter((t) => t !== tag) });
  };
  

  const getRemovedImages = (originalImages, currentImages) => {
    return originalImages.filter(image => !currentImages.includes(image));
  };

  const handleSubmit = async () => {
    const updates = {};
    if (formData.name !== originalData.name) updates.name = formData.name;
    if (formData.description !== originalData.description) updates.description = formData.description;
    if (JSON.stringify(formData.tags) !== JSON.stringify(originalData.tags)) updates.tags = JSON.stringify(formData.tags);
    if (formData.status!==originalData.status) updates.status = formData.status;
    if (formData.comments !== originalData.comments) updates.comments = formData.comments;
    if (formData.slides) updates.slides = formData.slides;

    if (Object.keys(updates).length > 0) {
      setSaving(true);

      const { data, error } = await supabase
        .from('ideas')
        .update(updates)
        .eq('id', idea.id);

      setSaving(false);
      if (error) {
        console.error('Error updating idea:', error);
        showMessage('Could not save the idea: ' + error.message, { type: 'error' });
        return;
      }
      setOriginalData({ ...formData });
      // Call the update function to update the idea in the parent component
      updateIdea({ ...formData });
      showMessage('Idea saved', { type: 'success' });
    }

    onClose();
  };






  const handleOpenConfirmationModal = () => {
    setConfirmationModal(true);
  };

  const handleCloseConfirmationModal = () => {
    setConfirmationModal(false);
  };

  const handleConfirmAction = () => {
    console.log('Action confirmed');
    setConfirmationModal(false);
    setFormData({ ...formData, status: 'rejected' });
    handleSubmit();
    // Perform the action here
  };
  return (
    <Transition appear show={isOpen} as={Fragment}>
            {/* onClose left as a no-op deliberately: headlessui fires it on
          BOTH an outside/backdrop click AND Escape, which was silently
          discarding in-progress form edits on a stray click. Only the
          explicit close/cancel button in this modal closes it now. */}
      <Dialog as="div" className="relative z-50" onClose={() => {}}>
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
              <Dialog.Panel className="w-full max-w-6xl max-h-[92vh] flex flex-col transform overflow-hidden rounded-2xl bg-white shadow-xl">
                <div className="flex justify-between items-center px-6 py-4 border-b shrink-0">
                  <div className="min-w-0">
                    <Dialog.Title className="text-lg font-semibold text-gray-900">Edit idea</Dialog.Title>
                    {formData.name && <p className="text-sm text-gray-500 truncate">{formData.name}</p>}
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

                <div className="flex-1 min-h-0 overflow-y-auto p-6 space-y-6 [&_label]:text-sm [&_label]:font-medium [&_label]:text-gray-700">
                  <div>
                    <SectionTitle hint="Drag and drop to arrange">Slide</SectionTitle>
                    <SlideEditorWrapper initialData={originalData.slides} stageHeight="62vh" setIdeaForm={(data) => setFormData((f) => ({ ...f, slides: data }))} />
                    <p className="hidden max-md:block text-xs text-gray-400 mt-1">
                      Slide editing (drag &amp; drop) works best on desktop.
                    </p>
                  </div>

                  <div className="pt-6 border-t border-gray-200">
                    <SectionTitle>Details</SectionTitle>
                    <div className="space-y-4">
                      <div>
                        <label htmlFor="idea-name" className="block">Name</label>
                        <input
                          id="idea-name"
                          type="text"
                          name="name"
                          value={formData.name}
                          onChange={handleInputChange}
                          className="input mt-1 block w-full rounded-md border-gray-300 shadow-sm"
                        />
                      </div>
                      <StatusPills
                        value={normStatus(formData.status)}
                        onChange={(v) => setFormData((f) => ({ ...f, status: v }))}
                        options={IDEA_STATUS_OPTIONS}
                      />
                      <div>
                        <label htmlFor="idea-description" className="block">Description</label>
                        <textarea
                          id="idea-description"
                          name="description"
                          rows={4}
                          value={formData.description}
                          onChange={handleInputChange}
                          className="input mt-1 block w-full rounded-md border-gray-300 shadow-sm"
                        />
                      </div>
                      <div>
                        <label htmlFor="idea-tags" className="block">Tags</label>
                        {formData.tags?.length > 0 && (
                          <div className="flex flex-wrap gap-2 mt-1">
                            {formData.tags.map((tag) => (
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

                  <div className="pt-6 border-t border-gray-200">
                    <SectionTitle>Comments &amp; notes</SectionTitle>
                    <div className="space-y-4">
                      <div>
                        <label htmlFor="idea-comments" className="block">Comments</label>
                        <textarea
                          id="idea-comments"
                          name="comments"
                          rows={4}
                          value={formData.comments}
                          onChange={handleInputChange}
                          className="input mt-1 block w-full rounded-md border-gray-300 shadow-sm"
                        />
                      </div>
                      <IdeaNotes ideaId={idea.id} />
                    </div>
                  </div>
                </div>

                <div className="flex items-center justify-end gap-3 border-t px-6 py-4 shrink-0 bg-white">
                  <div className="mr-auto flex items-center gap-3">
                    <ExportIdeaButton idea={{ ...originalData, slides: formData.slides || originalData.slides }} />
                    {isDirty && <span className="text-xs text-amber-600">Unsaved changes</span>}
                  </div>
                  <button
                    type="button"
                    onClick={requestClose}
                    className="px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 border border-gray-300 rounded-lg"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleSubmit}
                    disabled={saving}
                    className="px-4 py-2 text-sm font-medium text-white bg-chabot-gold hover:bg-opacity-90 rounded-lg disabled:opacity-60"
                  >
                    {saving ? 'Saving…' : 'Save'}
                  </button>
                </div>
              </Dialog.Panel>
            </Transition.Child>
          </div>
        </div>
      </Dialog>
    </Transition>
  );
};

export default CardInfoModal;
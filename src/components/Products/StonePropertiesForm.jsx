import React, { useState } from 'react';
import { Plus } from 'lucide-react';
import StoneList from './StoneList';
import StoneForm from './StoneForm';

const StonePropertiesForm = ({ stones, onChange }) => {
    const [isAdding, setIsAdding] = useState(false);
    // Index of the stone currently being edited in `stones`, or null when
    // adding a brand-new one. Passed through to StoneForm as `initialStone`
    // so the fields open pre-filled instead of blank.
    const [editingIndex, setEditingIndex] = useState(null);

    const handleRemoveStone = (stone, idx) => {
        // Index-based, not id-based: new (not-yet-saved) stones share
        // `id === undefined`, so filtering by id equality removed every
        // unsaved stone at once instead of just the one that was clicked.
        const next = stones.filter((_, i) => i !== idx);
        onChange(next);
        if (editingIndex === idx) {
            setEditingIndex(null);
            setIsAdding(false);
        }
    };

    const handleEditStone = (stone, idx) => {
        setEditingIndex(idx);
        setIsAdding(true);
    };

    const handleSubmitStone = (stoneValues) => {
        if (editingIndex !== null) {
            const next = stones.map((s, i) => (i === editingIndex ? { ...s, ...stoneValues } : s));
            onChange(next);
        } else {
            onChange([...stones, stoneValues]);
        }
        setIsAdding(false);
        setEditingIndex(null);
    };

    const handleCancel = () => {
        setIsAdding(false);
        setEditingIndex(null);
    };

    return (
            <div className="space-y-4">
            <div className="flex justify-between items-center">
                <h4 className="text-sm font-medium text-gray-900">Stones</h4>
                <button
                type="button"
                onClick={() => { setEditingIndex(null); setIsAdding(true); }}
                className="text-sm text-chabot-gold hover:text-opacity-80 flex items-center"
                >
                <Plus className="w-4 h-4 mr-1" />
                Add Stone
                </button>
            </div>
            {isAdding && (
                <div className="border rounded-lg p-4 bg-gray-50">
                <StoneForm
                    initialStone={editingIndex !== null ? stones[editingIndex] : null}
                    isEditing={editingIndex !== null}
                    onSubmit={handleSubmitStone}
                    onCancel={handleCancel}
                />
                </div>
            )}
            <StoneList
                stones={stones}
                onRemoveStone={handleRemoveStone}
                onEditStone={handleEditStone}
            />
          </div>
          );
        };

        export default StonePropertiesForm;

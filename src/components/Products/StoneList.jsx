import React from 'react';
import { X, Pencil } from 'lucide-react';

// Renders each stone as a clickable row -- clicking (or the pencil) opens it
// for editing in StonePropertiesForm; the X still removes it outright. Stone
// fields (size/quantity/cost/shape/type/color) previously could only be set
// once at add-time -- there was no way back in to fix a typo without
// deleting the stone and re-entering everything.
const StoneList = ({ stones, onRemoveStone, onEditStone }) => {

    if (stones.length === 0) {
        return (
          <div className="text-sm text-gray-500 italic">
            No stones added yet
          </div>
        );
      }

      return (
        <div className="space-y-3">
          {stones.map((stone, idx) => (
            <div
              key={stone.id ?? idx}
              role={onEditStone ? "button" : undefined}
              tabIndex={onEditStone ? 0 : undefined}
              onClick={() => onEditStone && onEditStone(stone, idx)}
              onKeyDown={(e) => {
                if (onEditStone && (e.key === "Enter" || e.key === " ")) onEditStone(stone, idx);
              }}
              className={`flex items-center justify-between p-3 bg-white border rounded-lg hover:bg-gray-50 ${
                onEditStone ? "cursor-pointer" : ""
              }`}
            >
              <div className="flex-1">
                <div className="flex items-center justify-between">
                  <div>
                    <span className="text-sm font-medium text-gray-900">
                      {stone.quantity} x {stone.size}mm {String(stone.type || "").replace('-cz', ' CZ')}
                    </span>
                    <p className="text-sm text-gray-500">
                      {stone.shape} cut
                    </p>
                  </div>
                  <span className="text-sm font-medium text-gray-900">
                    ${Number(stone.cost || 0).toFixed(2)}
                  </span>
                </div>
                {stone.notes && (
                  <p className="mt-1 text-sm text-gray-500">{stone.notes}</p>
                )}
              </div>
              {onEditStone && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onEditStone(stone, idx);
                  }}
                  className="ml-2 p-1 text-gray-400 hover:text-chabot-gold hover:bg-gray-100 rounded"
                  title="Edit stone"
                >
                  <Pencil className="w-4 h-4" />
                </button>
              )}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onRemoveStone(stone, idx);
                }}
                className="ml-2 p-1 text-gray-400 hover:text-gray-500 hover:bg-gray-100 rounded"
                title="Remove stone"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          ))}
        </div>
      );
    };

    export default StoneList;

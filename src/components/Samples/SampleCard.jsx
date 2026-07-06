import { FileImage, CheckCircle, MoreVertical, Trash2, Copy, Printer } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import { getStatusColor } from '../../utils/designUtils';
import { formatShortDate } from '../../utils/dateUtils';
import { Calendar, Pencil } from 'lucide-react';

export default function SampleCard({
    sample,
    onClick,
    onDelete,
    onDuplicate,
    onPrintTag,
    selected = false,
    selectable = false,
  }) {
    const [menuOpen, setMenuOpen] = useState(false);
    const menuRef = useRef(null);
    // Close the actions menu on any click outside it (hover-friendly: the menu
    // stays open while the mouse moves from the button into the list).
    useEffect(() => {
      if (!menuOpen) return;
      const onOutside = (e) => {
        if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false);
      };
      document.addEventListener('mousedown', onOutside);
      return () => document.removeEventListener('mousedown', onOutside);
    }, [menuOpen]);
    const handleClick = (e) => {
      e.preventDefault();
      onClick(sample);
    };
    const images = sample.images || [];
    const status = sample.sample_status || sample.status || '';

    return (
      <div
        role="button"
        tabIndex={0}
        onClick={handleClick}
        onKeyDown={(e) => e.key === 'Enter' && handleClick(e)}
        className={`relative flex flex-col bg-white rounded-lg shadow-sm border overflow-hidden ${
          selected ? 'border-chabot-gold ring-1 ring-chabot-gold' : 'border-gray-200'
        } hover:shadow-md transition-shadow cursor-pointer focus:outline-none focus:ring-2 focus:ring-chabot-gold`}
      >
        {!selectable && (
          <div className="absolute top-2 right-2 z-10" ref={menuRef}>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setMenuOpen((o) => !o); }}
              className="p-1 rounded-full bg-white/90 hover:bg-white shadow-sm border border-gray-200"
              aria-label="Sample actions"
            >
              <MoreVertical className="w-4 h-4 text-gray-600" />
            </button>
            {menuOpen && (
              <div
                className="absolute right-0 mt-1 w-36 bg-white border border-gray-200 rounded-md shadow-lg py-1"
                onClick={(e) => e.stopPropagation()}
              >
                <button
                  type="button"
                  className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2"
                  onClick={(e) => { e.stopPropagation(); setMenuOpen(false); onDuplicate && onDuplicate(sample); }}
                >
                  <Copy className="w-4 h-4" /> Duplicate
                </button>
                <button
                  type="button"
                  className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2"
                  onClick={(e) => { e.stopPropagation(); setMenuOpen(false); onPrintTag && onPrintTag(sample); }}
                >
                  <Printer className="w-4 h-4" /> Print tag
                </button>
                <button
                  type="button"
                  className="w-full text-left px-3 py-2 text-sm text-red-600 hover:bg-red-50 flex items-center gap-2"
                  onClick={(e) => { e.stopPropagation(); setMenuOpen(false); onDelete && onDelete(sample); }}
                >
                  <Trash2 className="w-4 h-4" /> Delete
                </button>
              </div>
            )}
          </div>
        )}
        {selectable && (
          <div className="absolute top-2 right-2 z-10">
            <CheckCircle
              className={`w-6 h-6 drop-shadow-sm ${selected ? 'text-chabot-gold' : 'text-gray-300'}`}
            />
          </div>
        )}

        {/* Image — fixed-height box; whole piece always visible on white */}
        <div className="relative h-44 bg-white border-b border-gray-100">
          {images.length > 0 ? (
            <>
              <img
                src={`${process.env.VITE_DB_HOST_URL}${images[0]}`}
                alt={sample.styleNumber || sample.name || 'sample'}
                loading="lazy"
                className="w-full h-full object-contain p-3"
              />
              {images.length > 1 && (
                <span className="absolute bottom-2 right-2 text-[11px] font-medium text-gray-600 bg-white/90 border border-gray-200 rounded-full px-2 py-0.5 shadow-sm">
                  +{images.length - 1}
                </span>
              )}
            </>
          ) : (
            <div className="w-full h-full flex flex-col items-center justify-center bg-gray-50">
              <FileImage className="w-10 h-10 text-gray-300" />
              <span className="mt-1 text-xs text-gray-400">No image</span>
            </div>
          )}
        </div>

        {/* Body */}
        <div className="flex flex-col flex-1 p-4">
          <div className="flex justify-between items-start gap-2">
            <span className="text-sm font-semibold text-gray-900 truncate" title={sample.styleNumber}>
              {sample.styleNumber}
            </span>
            {status && (
              <span
                className={`shrink-0 px-2 py-0.5 rounded-full text-xs font-medium ${getStatusColor(status)}`}
              >
                {status.replaceAll('_', ' ').split(':')[0]}
              </span>
            )}
          </div>

          <p className="mt-1 text-sm text-gray-500 truncate min-h-[1.25rem]" title={sample.name}>
            {sample.name || ' '}
          </p>

          <div className="mt-auto pt-3 border-t border-gray-100 flex items-center justify-between text-xs text-gray-400">
            <div className="flex items-center" title="Created">
              <Calendar className="w-3.5 h-3.5 mr-1" />
              <span>{formatShortDate(sample.created_at)}</span>
            </div>
            <div className="flex items-center" title="Updated">
              <Pencil className="w-3.5 h-3.5 mr-1" />
              <span>{formatShortDate(sample.updated_at)}</span>
            </div>
          </div>
        </div>
      </div>
    );
}

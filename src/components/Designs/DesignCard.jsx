import { FileImage, CheckCircle } from 'lucide-react';
import React from 'react';
import { getStatusColor } from '../../utils/designUtils';
import { formatShortDate } from '../../utils/dateUtils';
import { Calendar, Pencil } from 'lucide-react';

// Same card format as SampleCard: fixed 4:3 white image frame (whole piece
// visible, no cropping), +N badge for extra shots, truncated text rows, and a
// pinned footer so all cards line up.
const DesignCard = ({
    design,
    onClick,
    selected = false,
    selectable = false,
  }) => {
    const handleClick = (e) => {
      e.preventDefault();
      onClick(design);
    };
    const images = design.images || [];
    const status = design.status || '';

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
        {selectable && (
          <div className="absolute top-2 right-2 z-10">
            <CheckCircle
              className={`w-6 h-6 drop-shadow-sm ${selected ? 'text-chabot-gold' : 'text-gray-300'}`}
            />
          </div>
        )}

        {/* Image — fixed aspect box; whole piece always visible on white */}
        <div className="relative aspect-[4/3] bg-white border-b border-gray-100">
          {images.length > 0 ? (
            <>
              <img
                src={`${images[0]}`}
                alt={design.name || design.title || 'design'}
                loading="lazy"
                className="absolute inset-0 w-full h-full object-contain p-3"
              />
              {images.length > 1 && (
                <span className="absolute bottom-2 right-2 text-[11px] font-medium text-gray-600 bg-white/90 border border-gray-200 rounded-full px-2 py-0.5 shadow-sm">
                  +{images.length - 1}
                </span>
              )}
            </>
          ) : (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-gray-50">
              <FileImage className="w-10 h-10 text-gray-300" />
              <span className="mt-1 text-xs text-gray-400">No image</span>
            </div>
          )}
        </div>

        {/* Body */}
        <div className="flex flex-col flex-1 p-4">
          <div className="flex justify-between items-start gap-2">
            <span className="text-sm font-semibold text-gray-900 truncate">
              Design #{design.id}
            </span>
            {status && (
              <span
                className={`shrink-0 px-2 py-0.5 rounded-full text-xs font-medium ${getStatusColor(status)}`}
              >
                {status.split(':')[0].replaceAll('_', ' ')}
              </span>
            )}
          </div>

          <p className="mt-1 text-sm text-gray-700 truncate min-h-[1.25rem]" title={design.name}>
            {design.name || ' '}
          </p>
          <p className="mt-1 text-sm text-gray-500 line-clamp-2 min-h-[2.5rem]" title={design.description}>
            {design.description || ' '}
          </p>

          <div className="mt-auto pt-3 border-t border-gray-100 flex items-center justify-between text-xs text-gray-400">
            <div className="flex items-center" title="Created">
              <Calendar className="w-3.5 h-3.5 mr-1" />
              <span>{formatShortDate(design.created_at)}</span>
            </div>
            <div className="flex items-center" title="Updated">
              <Pencil className="w-3.5 h-3.5 mr-1" />
              <span>{formatShortDate(design.updated_at)}</span>
            </div>
          </div>
        </div>
      </div>
    );
};

export default DesignCard;

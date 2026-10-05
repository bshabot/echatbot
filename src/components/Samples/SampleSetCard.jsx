import React, { useEffect, useRef, useState } from 'react';
import { FileImage, CheckCircle, MoreVertical, Unlink, ArrowLeftRight, Layers, Copy, Printer, RefreshCw, UploadCloud, Trash2 } from 'lucide-react';
import { getStatusColor } from '../../utils/designUtils';
import SspCreateProgress from '../SspCreateProgress';

// One card for a linked set (e.g. studs + necklace). Each half opens its own
// sample; the menu swaps item order (position = SSP itemId) or unlinks the set.
export default function SampleSetCard({
  set,
  members = [],
  onOpenSample,
  onUnlink,
  onSwap,
  onDuplicate,
  onPrintTag,
  qbOn = false,
  qbSyncing = false,
  onSyncToQb,
  sspOn = false,
  sspCreating = false,
  sspProgress = null,
  onCreateInSsp,
  onDelete,
  selected = false,
  selectable = false,
  onToggleSelect,
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);
  useEffect(() => {
    if (!menuOpen) return;
    const onOutside = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onOutside);
    return () => document.removeEventListener('mousedown', onOutside);
  }, [menuOpen]);

  const run = (fn) => { setMenuOpen(false); if (fn) fn(set, members); };

  const handleHalfClick = (e, sample) => {
    e.stopPropagation();
    if (selectable) onToggleSelect && onToggleSelect(set, members);
    else onOpenSample && onOpenSample(sample);
  };

  return (
    <div
      className={`relative flex flex-col bg-white rounded-lg shadow-sm border md:col-span-2 ${members.length > 2 ? 'lg:col-span-3' : ''} ${
        selected ? 'border-chabot-gold ring-1 ring-chabot-gold' : 'border-chabot-gold/60'
      } hover:shadow-md transition-shadow`}
    >
      {/* Header strip */}
      <div
        className={`flex items-center justify-between gap-2 px-4 py-2 bg-[#faf6ef] border-b border-gray-100 rounded-t-lg ${selectable ? 'cursor-pointer hover:bg-[#f5eedf]' : ''}`}
        onClick={selectable ? (e) => { e.stopPropagation(); onToggleSelect && onToggleSelect(set, members); } : undefined}
      >
        <div className="flex items-center gap-2 min-w-0">
          <Layers className="w-4 h-4 text-chabot-gold shrink-0" />
          <span className="text-sm font-semibold text-gray-900 truncate" title={set.style_number}>
            {set.style_number}
          </span>
          <span className="shrink-0 px-2 py-0.5 rounded-full text-xs font-medium bg-chabot-gold/15 text-gray-700">
            SET · {members.length} items
          </span>
        </div>
        {selectable ? (
          <CheckCircle className={`w-6 h-6 shrink-0 ${selected ? 'text-chabot-gold' : 'text-gray-300'}`} />
        ) : (
          <div className="relative shrink-0" ref={menuRef}>
            {/* Ring sized like a normal card's: 44px box, button inset 8px */}
            <div className="relative w-11 h-11 -my-2 -mr-2">
              <SspCreateProgress progress={sspProgress} size={44} />
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); setMenuOpen((o) => !o); }}
                className="absolute inset-2 flex items-center justify-center rounded-full bg-white/90 hover:bg-white shadow-sm border border-gray-200"
                aria-label="Set actions"
              >
                <MoreVertical className="w-4 h-4 text-gray-600" />
              </button>
            </div>
            {menuOpen && (
              <div
                className="absolute right-0 mt-1 w-48 z-40 bg-white border border-gray-200 rounded-md shadow-lg py-1"
                onClick={(e) => e.stopPropagation()}
              >
                <MenuItem icon={Copy} onClick={() => run(onDuplicate)}>Duplicate set</MenuItem>
                <MenuItem icon={Printer} onClick={() => run(onPrintTag)}>Print set tag</MenuItem>
                {qbOn && (
                  <MenuItem icon={RefreshCw} spin={qbSyncing} disabled={qbSyncing} onClick={() => run(onSyncToQb)}>
                    {qbSyncing ? 'Syncing…' : 'Sync to QB'}
                  </MenuItem>
                )}
                {sspOn && (
                  <MenuItem icon={UploadCloud} disabled={sspCreating} onClick={() => run(onCreateInSsp)}>
                    {sspCreating ? 'Creating…' : 'Create set in SSP'}
                  </MenuItem>
                )}
                {members.length > 1 && (
                  <MenuItem icon={ArrowLeftRight} onClick={() => run(onSwap)}>
                    {members.length === 2 ? 'Swap item order' : 'Rotate item order'}
                  </MenuItem>
                )}
                <MenuItem icon={Unlink} onClick={() => run(onUnlink)}>Unlink set</MenuItem>
                <MenuItem icon={Trash2} danger onClick={() => run(onDelete)}>Delete set</MenuItem>
              </div>
            )}
          </div>
        )}
      </div>

      {/* The linked items, side by side */}
      <div className={`grid ${members.length > 2 ? 'grid-cols-3' : 'grid-cols-2'} divide-x divide-gray-100`}>
        {members.map((sample, i) => {
          const images = sample.images || [];
          const status = sample.sample_status || sample.status || '';
          return (
            <div
              key={sample.sample_id}
              role="button"
              tabIndex={0}
              onClick={(e) => handleHalfClick(e, sample)}
              onKeyDown={(e) => e.key === 'Enter' && handleHalfClick(e, sample)}
              className="flex flex-col cursor-pointer hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-chabot-gold"
            >
              <div className="relative h-32 bg-white border-b border-gray-100">
                <span className="absolute top-2 left-2 z-10 text-[11px] font-medium text-gray-600 bg-white/90 border border-gray-200 rounded-full px-2 py-0.5">
                  Item {i + 1}
                </span>
                {images.length > 0 ? (
                  <img
                    src={`${process.env.VITE_DB_HOST_URL}${images[0]}`}
                    alt={sample.styleNumber || 'sample'}
                    loading="lazy"
                    className="w-full h-full object-contain p-3"
                  />
                ) : (
                  <div className="w-full h-full flex flex-col items-center justify-center bg-gray-50">
                    <FileImage className="w-8 h-8 text-gray-300" />
                    <span className="mt-1 text-xs text-gray-400">No image</span>
                  </div>
                )}
              </div>
              <div className="p-3">
                <div className="flex justify-between items-start gap-2">
                  <span className="text-sm font-semibold text-gray-900 truncate" title={sample.styleNumber}>
                    {sample.styleNumber}
                  </span>
                  {status && (
                    <span className={`shrink-0 px-2 py-0.5 rounded-full text-xs font-medium ${getStatusColor(status)}`}>
                      {status.replaceAll('_', ' ').split(':')[0]}
                    </span>
                  )}
                </div>
                <p className="mt-1 text-sm text-gray-500 truncate min-h-[1.25rem]" title={sample.name}>
                  {sample.name || ' '}
                </p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MenuItem({ icon: Icon, onClick, children, danger = false, disabled = false, spin = false }) {
  return (
    <button
      type="button"
      disabled={disabled}
      className={`w-full text-left px-3 py-2 text-sm flex items-center gap-2 disabled:opacity-50 ${
        danger ? 'text-red-600 hover:bg-red-50' : 'text-gray-700 hover:bg-gray-50'
      }`}
      onClick={(e) => { e.stopPropagation(); onClick && onClick(); }}
    >
      <Icon className={`w-4 h-4 ${spin ? 'animate-spin' : ''}`} /> {children}
    </button>
  );
}

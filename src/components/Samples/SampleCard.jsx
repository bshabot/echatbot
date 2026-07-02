import { FileImage, CheckCircle, MoreVertical, Trash2, Copy, Printer } from 'lucide-react';
import React, { useState } from 'react';
import { getStatusColor } from '../../utils/designUtils';
import { formatShortDate } from '../../utils/dateUtils';
import { MessageSquare, Calendar, Tag,Pencil } from 'lucide-react';

export default function SampleCard({ 
    key,
    sample, 
    onClick,
    onDelete,
    onDuplicate,
    onPrintTag,
    selected = false,
    selectable = false,
  }) {
    // console.log(sample, 'sample from sample card');
    const [menuOpen, setMenuOpen] = useState(false);
    const handleClick = (e) => {
      e.preventDefault();
      onClick(sample);
    };
   let images = sample.images || [];

   return (
           <div
             role="button"
             tabIndex={0}
             key={key}
             onClick={handleClick}
             onKeyDown={(e) => e.key === 'Enter' && handleClick(e)}
             className={`relative bg-white rounded-lg shadow-sm border ${
               selected ? 'border-chabot-gold' : 'border-gray-200'
             } hover:shadow-md transition-shadow cursor-pointer focus:outline-none focus:ring-2 focus:ring-chabot-gold`}
           >
             {!selectable && (
          <div className="absolute top-2 right-2 z-20">
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setMenuOpen((o) => !o); }}
              className="p-1 rounded-full bg-white/80 hover:bg-white shadow-sm border border-gray-200"
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
                   className={`w-6 h-6 ${
                     selected ? 'text-chabot-gold' : 'text-gray-300'
                   }`} 
                 />
               </div>
             )}
             
             <div className="relative object-contain aspect-[2/1] bg-gray-100 rounded-t-lg overflow-hidden">
               {images && images.length > 0 && (
                <div className="relative w-full  bg-gray-100 rounded-t-lg overflow-hidden">
                <img
                  src={`${process.env.VITE_DB_HOST_URL}${images[0]}`}
                  alt={sample.name}
                  className="w-full h-full object-contain "
                />
              
                  
                 
                     </div>
               ) 
              //  
              //    <div className="w-full h-full flex flex-col items-center justify-center">
              //      <FileImage className="w-12 h-12 text-gray-400" />
              //      <span className="mt-2 text-sm font-medium text-gray-500">{sample.name}</span>
              //    </div>
              //  )
               }
             </div>
       
             <div className="p-4">
               <div className="flex justify-between items-start">
                 <span className="text-sm font-medium text-gray-900">Style: {sample.styleNumber}</span>
                 <span
                   className={`px-2 py-1 rounded-full text-xs font-medium ${getStatusColor(
                     sample.sample_status || sample.status
                   )}`}
                 >
                   {(sample.sample_status|| sample.status).replaceAll('_', ' ').split(':')[0] }
                 </span>
               </div>
               {/* <label htmlFor="">name:</label> */}
               <p className="mt-2 text-sm text-gray-600 line-clamp-2">Name: {sample.name}</p>
               <div className="flex items-center justify-between text-sm text-gray-500">
                <div className="flex items-center">
                  <Calendar className="w-4 h-4 mr-1" />
                  <span>{formatShortDate(sample.created_at)}</span>
                </div>
                <div className="flex items-center">
                  <Pencil className="w-4 h-4 mr-1" />
                  <span>{formatShortDate(sample.updated_at)}</span>
                </div>
              </div>
             </div>
           </div>
         );
       };
   

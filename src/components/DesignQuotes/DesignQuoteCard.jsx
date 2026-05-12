import { FileImage, CheckCircle } from 'lucide-react';
import React from 'react';
import { getStatusColor } from '../../utils/designUtils';
import {formatDate} from '../../utils/dateUtils'
import { MessageSquare, Calendar, Tag } from 'lucide-react';
import { useGenericStore } from '../../store/VendorStore';

const DesignCard = ({ 
  design, 
  onClick, 
  selected = false,
  selectable = false,
}) => {
    const { getEntityItemById, getEntity } = useGenericStore();
    const vendors = getEntity('vendors')
    const handleClick = (e) => {
      e.preventDefault();
      onClick(design);
    };
   let images=design.images
return (
        <div
          role="button"
          tabIndex={0}
          onClick={handleClick}
          onKeyDown={(e) => e.key === 'Enter' && handleClick(e)}
          className={`relative bg-white rounded-lg shadow-sm border ${
            selected ? 'border-chabot-gold' : 'border-gray-200'
          } hover:shadow-md transition-shadow cursor-pointer focus:outline-none focus:ring-2 focus:ring-chabot-gold`}
        >
          {selectable && (
            <div className="absolute top-2 right-2 z-10">
              <CheckCircle 
                className={`w-6 h-6 ${
                  selected ? 'text-chabot-gold' : 'text-gray-300'
                }`} 
              />
            </div>
          )}
          
          <div className="relative aspect-square bg-gray-100 rounded-t-lg overflow-hidden">
            {images && images.length > 0 ? (
              <>
                <img
                  src={`${process.env.VITE_DB_HOST_URL}${images[0]}`}
                  alt={design.title}
                  className="w-full h-full object-contain"
                />
                {/* <div className="absolute bottom-0 left-0 right-0 bg-black/50 text-white px-2 py-1 text-center">
                  <span className="text-sm font-medium">hi</span>
                </div> */}
              </>
            ) : (
              <div className="w-full h-full flex flex-col items-center justify-center">
                <FileImage className="w-12 h-12 text-gray-400" />
                <span className="mt-2 text-sm font-medium text-gray-500">{design.title}</span>
              </div>
            )}
          </div>
    
          <div className="p-4">
            <div className="flex justify-between items-start">
              <span className="text-sm font-medium text-gray-900">{design.title}</span>
              {/* <span className="text-sm font-medium text-gray-900">{design.id}</span> */}
              <span
                className={`px-2 py-1 rounded-full text-xs font-medium ${getStatusColor(
                  design.status
                )}`}
              >
                {design.status.split(':')[0].replaceAll('_', ' ')}
              </span>
            </div>
            <div>
              <label htmlFor="">Vendor</label>
              <p className="mt-2 text-sm text-gray-600 line-clamp-2">{getEntityItemById('vendors',design.vendor).name}</p>
            </div>
            <div>
              <label htmlFor="">Manufacturer Code:</label>
              <p className="mt-2 text-sm text-gray-600 line-clamp-2">{design.manufacturerCode}</p>
            </div>
            <div className="flex items-center justify-between text-sm text-gray-500">
                <div className="flex items-center">
                  <Calendar className="w-4 h-4 mr-1" />
                  <span>{formatDate(design.created_at)}</span>
                </div>
              </div>
          </div>
        </div>
      );
    };

    export default DesignCard;

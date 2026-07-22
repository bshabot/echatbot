import React from 'react';
import { Link } from 'react-router-dom';
import MetalPriceEditor from '../components/MetalPrices/MetalPriceEditor';
// import KitcoWidget from '../components/Calculator/KitcoWidget';

const MetalPrices = () => {
  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold text-gray-900 mb-2">Metals</h1>
      <div className="flex gap-1 mb-6">
        <span className="px-3 py-1 rounded-full text-sm bg-[#C5A572] text-white">
          Prices
        </span>
        <Link
          to="/metal-locks"
          className="px-3 py-1 rounded-full text-sm text-gray-600 hover:bg-gray-200"
        >
          Lock History
        </Link>
      </div>
      <div className="max-w-2xl space-y-6">
        <MetalPriceEditor />
        {/* <KitcoWidget /> */}
      </div>
    </div>
  );
};

export default MetalPrices;

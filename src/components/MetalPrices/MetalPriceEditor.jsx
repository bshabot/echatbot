import React, { useState, useEffect } from 'react';
import { useSupabase } from '../SupaBaseProvider';
import { DollarSign, Save } from 'lucide-react';
import {useMetalPriceStore} from '../../store/MetalPrices'
// import { getGoldPrice,getSilverPrice,setGoldprice,setSilverprice } from '../ForNowPrices';
const MetalPriceEditor = () => {
  const { prices, updatePricesWithSync, syncFromDb } = useMetalPriceStore();
  const { supabase } = useSupabase();
  useEffect(() => { if (supabase) syncFromDb(supabase); }, [supabase, syncFromDb]);
  const [goldPrice, setGoldPrice] = useState(prices.gold.price.toString());
  const [silverPrice, setSilverPrice] = useState(prices.silver.price.toString());
  const [isEditing, setIsEditing] = useState(false);

  const handleSave = () => {
    updatePricesWithSync(supabase, {
      gold: {
        ...prices.gold,
        price: parseFloat(goldPrice),
        timestamp: new Date().toLocaleDateString(),
      },
      silver: {
        ...prices.silver,
        price: parseFloat(silverPrice),
        timestamp: new Date().toLocaleDateString(),
      },
    });
    setIsEditing(false);
  };

  return (
    <div className="bg-white rounded-xl shadow-md overflow-hidden p-6">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-lg font-semibold text-gray-900">Metal Prices</h2>
        {!isEditing && (
          <button
            onClick={() => setIsEditing(true)}
            className="text-sm text-chabot-gold hover:text-opacity-80"
          >
            Edit Prices
          </button>
        )}
      </div>

      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700">Gold Price (per oz)</label>
          <div className="mt-1 relative rounded-md shadow-sm">
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
              <DollarSign className="h-5 w-5 text-gray-400" />
            </div>
            <input
              type="number"
              step="0.01"
              value={goldPrice}
              onChange={(e) => setGoldPrice(e.target.value)}
              disabled={!isEditing}
              className="block w-full pl-10 pr-12 py-2 border border-gray-300 rounded-md focus:ring-chabot-gold focus:border-chabot-gold disabled:bg-gray-50 disabled:text-gray-500"
            />
            <div className="absolute inset-y-0 right-0 pr-3 flex items-center pointer-events-none">
              <span className="text-gray-500 sm:text-sm">/oz</span>
            </div>
          </div>
          <p className="mt-1 text-xs text-gray-500">
            Last updated: {prices.gold.timestamp}
          </p>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700">Silver Price (per oz)</label>
          <div className="mt-1 relative rounded-md shadow-sm">
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
              <DollarSign className="h-5 w-5 text-gray-400" />
            </div>
            <input
              type="number"
              step="0.01"
              value={silverPrice}
              onChange={(e) => setSilverPrice(e.target.value)}
              disabled={!isEditing}
              className="block w-full pl-10 pr-12 py-2 border border-gray-300 rounded-md focus:ring-chabot-gold focus:border-chabot-gold disabled:bg-gray-50 disabled:text-gray-500"
            />
            <div className="absolute inset-y-0 right-0 pr-3 flex items-center pointer-events-none">
              <span className="text-gray-500 sm:text-sm">/oz</span>
            </div>
          </div>
          <p className="mt-1 text-xs text-gray-500">
            Last updated: {prices.silver.timestamp}
          </p>
        </div>

        {isEditing && (
          <div className="flex justify-end space-x-3 mt-4">
            <button
              onClick={() => {
                setGoldPrice(prices.gold.price.toString());
                setSilverPrice(prices.silver.price.toString());
                setIsEditing(false);
              }}
              className="px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 border border-gray-300 rounded-md"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              className="px-4 py-2 text-sm font-medium text-white bg-chabot-gold hover:bg-opacity-90 rounded-md inline-flex items-center"
            >
              <Save className="w-4 h-4 mr-2" />
              Save Changes
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default MetalPriceEditor;
import { create } from 'zustand';
import { persist } from 'zustand/middleware';


const DEFAULT_PRICES = {
  gold: {
    price: 2051.20,
    change: 0.5,
    timestamp: new Date().toLocaleDateString()
  },
  silver: {
    price: 24.15,
    change: 0.3,
    timestamp: new Date().toLocaleDateString()
  }
};

export const useMetalPriceStore = create(
  persist(
    (set, get) => ({
      prices: DEFAULT_PRICES,
      loading: false,
      lastSyncedAt: null,

      // Local-only update — kept for backward compat.
      updatePrices: (newPrices) => {
        set({ prices: newPrices });
      },

      // Local-only fetch stub — kept for backward compat.
      fetchPrices: async () => {
        set({ loading: true });
        try {
          set(state => ({
            prices: state.prices,
            loading: false
          }));
        } catch (err) {
          set({ loading: false });
        }
      },

      // Read metal prices from the shared Supabase metal_prices table and overwrite local state.
      // Caller passes the supabase client (from useSupabase()) so the store stays import-free.
      syncFromDb: async (supabase) => {
        if (!supabase) return;
        set({ loading: true });
        try {
          const { data, error } = await supabase
            .from('metal_prices')
            .select('*');
          if (error) {
            console.error('metal_prices fetch error:', error);
            return;
          }
          if (Array.isArray(data) && data.length > 0) {
            const fetched = {};
            data.forEach(row => {
              if (!row || !row.metal_type) return;
              fetched[row.metal_type] = {
                price: Number(row.price),
                change: Number(row.change ?? 0),
                timestamp: row.timestamp ?? new Date().toLocaleDateString(),
              };
            });
            set({
              prices: { ...get().prices, ...fetched },
              lastSyncedAt: new Date().toISOString()
            });
          }
        } catch (err) {
          console.error('metal_prices fetch exception:', err);
        } finally {
          set({ loading: false });
        }
      },

      // Update prices locally AND upsert to the shared Supabase metal_prices table.
      updatePricesWithSync: async (supabase, newPrices) => {
        set({ prices: newPrices });
        if (!supabase) return;
        try {
          const rows = Object.entries(newPrices).map(([metal_type, p]) => ({
            metal_type,
            price: Number(p?.price ?? 0),
            change: Number(p?.change ?? 0),
            timestamp: p?.timestamp ?? new Date().toLocaleDateString(),
            updated_at: new Date().toISOString(),
          }));
          const { error } = await supabase
            .from('metal_prices')
            .upsert(rows, { onConflict: 'metal_type' });
          if (error) {
            console.error('metal_prices upsert error:', error);
          } else {
            set({ lastSyncedAt: new Date().toISOString() });
          }
        } catch (err) {
          console.error('metal_prices upsert exception:', err);
        }
      },
    }),
    {
      name: 'metal-prices-storage',
    }
  )
);

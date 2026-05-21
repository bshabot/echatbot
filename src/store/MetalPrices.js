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

      // Pull the latest entry from metal_lock_history and overwrite the
      // system-wide metal_prices (silver + gold). Called on app load so the
      // system always reflects the most recent London fix.
      syncFromLatestLock: async (supabase) => {
        if (!supabase) return;
        try {
          const { data, error } = await supabase
            .from("metal_lock_history")
            .select("date, silver_lock, gold_lock")
            .order("date", { ascending: false })
            .limit(1)
            .single();
          if (error || !data) return;
          const today = data.date;
          const newPrices = {
            ...get().prices,
            silver: {
              price: Number(data.silver_lock) || get().prices.silver?.price || 0,
              change: 0,
              timestamp: today,
            },
            gold: {
              price: Number(data.gold_lock) || get().prices.gold?.price || 0,
              change: 0,
              timestamp: today,
            },
          };
          set({ prices: newPrices, lastSyncedAt: new Date().toISOString() });

          // Also push to the shared metal_prices table so other clients pick it up
          const rows = [
            { metal_type: "silver", price: newPrices.silver.price, change: 0, timestamp: today, updated_at: new Date().toISOString() },
            { metal_type: "gold", price: newPrices.gold.price, change: 0, timestamp: today, updated_at: new Date().toISOString() },
          ];
          await supabase.from("metal_prices").upsert(rows, { onConflict: "metal_type" });
        } catch (err) {
          console.error("syncFromLatestLock failed:", err);
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

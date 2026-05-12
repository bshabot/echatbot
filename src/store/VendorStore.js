import { create } from "zustand";
import { createClient } from "@supabase/supabase-js";

// Initialize Supabase
const supabaseUrl =
  process.env.VITE_SUPABASE_URL;
const supabaseKey =
  process.env.VITE_SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

export const useGenericStore = create((set, get) => ({
  entities: {},
  isLoaded: {},
  isLoading: {},
  errors: {},

  // Utility: Load from localStorage
  syncEntityFromLocalStorage: (entityName) => {
    try {
      const raw = localStorage.getItem(entityName);
      if (!raw) return;

      const parsed = JSON.parse(raw);
      set((state) => ({
        entities: { ...state.entities, [entityName]: parsed },
        isLoaded: { ...state.isLoaded, [entityName]: true },
        isLoading: { ...state.isLoading, [entityName]: false },
      }));
      console.log(`Synced "${entityName}" from localStorage`);
    } catch (e) {
      console.error(`Failed to sync "${entityName}" from localStorage:`, e);
    }
  },

  // Fetch entity from Supabase
  fetchEntity: async (entityName) => {
    const { entities, isLoading, syncEntityFromLocalStorage } = get();

    if (!entityName) return;
    if (isLoading[entityName]) return;

    // Step 1: Try syncing from local cache first
    if (!entities[entityName]) {
      syncEntityFromLocalStorage(entityName);
    }

    const lastFetchTime = localStorage.getItem(`${entityName}_last_fetch_time`);
    const now = new Date();
    const expired =
      !lastFetchTime || now - new Date(lastFetchTime) >= 24 * 60 * 60 * 1000;

    if (!expired) {
      console.log(`Using cached "${entityName}", skipping fetch.`);
      return;
    }

    // Step 2: Fetch fresh from Supabase
    set((state) => ({
      isLoading: { ...state.isLoading, [entityName]: true },
      errors: { ...state.errors, [entityName]: null },
    }));

    console.log(`Fetching "${entityName}" from Supabase...`);
    const { data, error } = await supabase.from(entityName).select("*");

    if (error) {
      console.error(`Fetch error for "${entityName}":`, error);
      set((state) => ({
        errors: { ...state.errors, [entityName]: error },
        isLoading: { ...state.isLoading, [entityName]: false },
      }));
      return;
    }

    const normalized = Array.isArray(data)
      ? data.length === 1
        ? data[0]
        : data
      : [];

    set((state) => ({
      entities: { ...state.entities, [entityName]: normalized },
      isLoaded: { ...state.isLoaded, [entityName]: true },
      isLoading: { ...state.isLoading, [entityName]: false },
    }));

    try {
      localStorage.setItem(entityName, JSON.stringify(normalized));
      localStorage.setItem(
        `${entityName}_last_fetch_time`,
        now.toISOString()
      );
    } catch (e) {
      console.warn(`Failed to persist "${entityName}" to localStorage:`, e);
    }
  },

  // Update entity
  updateEntity: async (entityName, updatedData) => {
    if (!entityName || updatedData == null) return;

    const { entities = {}, isLoaded = {}, isLoading = {} } = get();

    set({
      entities: { ...entities, [entityName]: updatedData },
      isLoaded: { ...isLoaded, [entityName]: true },
      isLoading: { ...isLoading, [entityName]: false },
    });

    try {
      localStorage.setItem(entityName, JSON.stringify(updatedData));
      localStorage.setItem(
        `${entityName}_last_fetch_time`,
        new Date().toISOString()
      );
      console.log(`Updated "${entityName}" & cached`);
    } catch (e) {
      console.error(`Failed to cache "${entityName}" update:`, e);
    }
  },
 


  // Access helpers
  getEntity: (entityName) => {
    const { entities } = get();
    // console.log(entityName,'entity name',entities)
    return entities[entityName];
  },

  getEntityItemById: (entityName, id) => {
    const entity = get().entities[entityName];
    if (Array.isArray(entity)) {
      return entity.find((item) => item.id === id);
    }
    return null;
  },
}));

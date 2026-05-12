import React, { createContext, useContext, useState, useEffect } from 'react';
import { createClient } from '@supabase/supabase-js';

// Create Supabase Context
const SupabaseContext = createContext(null);

// Environment Variables
const supabaseUrl = process.env.VITE_SUPABASE_URL;
const supabaseKey = process.env.VITE_SUPABASE_ANON_KEY;

// Validate Environment Variables
if (!supabaseUrl || !supabaseKey) {
  throw new Error('Supabase URL or Key is missing. Please check your environment variables.');
}

// Initialize Supabase Client
const supabase = createClient(supabaseUrl, supabaseKey);

export default function SupabaseProvider({ children }) {
  const [session, setSession] = useState(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
    });

    return () => subscription.unsubscribe();
  }, []);

  return (
    <SupabaseContext.Provider value={{ supabase, session }}>
      {children}
    </SupabaseContext.Provider>
  );
}

export const useSupabase = () => {
  const context = useContext(SupabaseContext);
  if (!context) {
    throw new Error('useSupabase must be used within a SupabaseProvider');
  }
  return context;
};

export const handleImageUpload = async (files) => {
  const imageUrls = [];
  for (const file of files) {
    const { data, error } = await supabase.storage
      .from('echatbot')
      .upload(`public/${file.name}`, file);

    if (error) {
      console.error('Error uploading image:', error);
      continue;
    }

    const { data: publicURL } = supabase.storage
      .from('echatbot')
      .getPublicUrl(`public/${file.name}`);

    if (publicURL) {
      imageUrls.push(publicURL.publicURL);
    }
  }
  return imageUrls;
};

const returnEmptyImageObject = () => {
  return {
    images: [],
    cad: [],
  };
};

export const getImages = async (entity, entityId) => {
  if (!entity || !entityId) {
    return returnEmptyImageObject();
  }
  const { data: imageData, error: imageError } = await supabase
    .from('entity_images')
    .select('*')
    .eq('entity', entity)
    .eq('entityId', entityId)
    .single();

  if (imageError) {
    console.log("no images", imageError);
  }

  if (!imageData || imageData.length === 0) {
    return returnEmptyImageObject();
  }
  return {
    ...imageData,
    images: imageData.images.map((url) => `${process.env.VITE_DB_HOST_URL}${url}`),
  };
};

import { createClient } from "@supabase/supabase-js";

// Same project and storage key as the app's other clients, so this reads the
// signed-in staff session. Sent to the staff-only Netlify functions.
const client = createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY);

export async function staffAuthHeaders() {
  const { data } = await client.auth.getSession();
  const t = data?.session?.access_token;
  return t ? { authorization: `Bearer ${t}` } : {};
}

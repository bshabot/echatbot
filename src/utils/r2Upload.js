// Uploads a file's bytes to Cloudflare R2 via the `r2-upload` Edge Function.
//
// New uploads must land in R2 — that's where the app serves product images
// from (VITE_DB_HOST_URL). Writing to Supabase storage (the old behavior) left
// images invisible until they were manually copied to R2.
//
// `supabase` carries the logged-in user's auth (the function requires a JWT).
// `key` is the bucket path, e.g. "public/N2900E-GP.jpg". Throws on failure.
export async function uploadImageToR2(supabase, key, file) {
  const { data, error } = await supabase.functions.invoke("r2-upload", {
    body: file,
    headers: {
      "x-r2-key": key,
      "x-content-type": file.type || "image/jpeg",
    },
  });

  if (error) {
    let detail = error.message || String(error);
    try {
      const body = await error.context?.json?.();
      if (body?.error) detail = body.error;
    } catch (_) {
      /* ignore — fall back to the generic message */
    }
    throw new Error(`R2 upload failed for ${key}: ${detail}`);
  }
  if (data?.error) throw new Error(`R2 upload failed for ${key}: ${data.error}`);
  return data;
}

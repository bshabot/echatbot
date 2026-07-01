// src/utils/tags/printConfig.js
// One place to tune how tags print. Layout itself lives in tagLayout.js (single
// source of truth). This only carries printer/production options.
//
// backRotation: the BACK face folds over the center line, so it prints rotated
// 180 (in place) to read right-side-up once folded. Default ON. Confirm the
// direction on the first GX430T test print; flip if the back reads inverted
// after folding. (The FLAT preview/ZPL ignore this and match the flat target.)
export const DEFAULT_PRINT_OPTIONS = {
  dpi: 300,           // Zebra GX430T
  backRotation: true, // rotate the back face 180 for the fold (confirm on test print)
  // darkness: 20,     // optional ^MD darkness for resin on polypropylene
};

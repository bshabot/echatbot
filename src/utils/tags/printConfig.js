// src/utils/tags/printConfig.js
// One place to tune how tags print. Layout is fixed: LEFT square = QR + weight
// (front), RIGHT square = style/metal/plating (becomes the back once folded).
// After the GX430T calibration / test print, flip backRotation here if the
// right square comes out upside-down after the fold.
export const DEFAULT_PRINT_OPTIONS = {
  dpi: 300,            // Zebra GX430T
  backRotation: false, // set true if the test print shows the right square inverted
  // darkness: 20,      // optional ^MD darkness for resin on polypropylene
};

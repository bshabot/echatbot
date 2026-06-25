// src/utils/tags/printConfig.js
// One place to tune how tags print. After the GX430T calibration / test print,
// flip backRotation here if the back face comes out upside-down after the fold.
export const DEFAULT_PRINT_OPTIONS = {
  dpi: 300,          // Zebra GX430T
  backRotation: false, // set true if the test print shows the back face inverted
  frontFace: 'left',
  // darkness: 20,    // optional ^MD darkness for resin on polypropylene
};

// src/utils/tags/printConfig.js
// One place to tune how tags print. Layout itself lives in tagLayout.js (single
// source of truth). This only carries printer/production options.
//
// backRotation: OFF per Brian 7/1 after seeing real ZPL prints - both faces
// print upright, no 180 flip on the weight face.
export const DEFAULT_PRINT_OPTIONS = {
  dpi: 300,            // Zebra GX430T
  backRotation: false, // Brian 7/1: no 180 flip - print everything upright
  labelShift: -24,    // dots; + moves print DOWN the label, - up. -24: Brian's 7/1
                      // print sat a drop low (E CHABOT missed the strip). Tune here.
  // darkness: 20,     // optional ^MD darkness for resin on polypropylene
};

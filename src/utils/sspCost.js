// SSP vendor cost: a piece's sales price with the vendor import charge added on
// top -- silver 16.25%, gold 17.05%, brass 11% (the rates the SSP vendor cost
// uses). Returns null when the sample has no sales price.
export const VENDOR_CHARGE_RATE = { silver: 16.25, gold: 17.05, brass: 11 };

export function sspVendorCost(sample) {
  const base = Number(sample?.salesPrice);
  if (!(base > 0)) return null;
  const rate = VENDOR_CHARGE_RATE[String(sample?.metalType || "").toLowerCase()] || 0;
  return { base, withCharge: base * (1 + rate / 100), rate };
}

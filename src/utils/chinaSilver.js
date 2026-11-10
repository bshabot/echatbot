// China silver lock — for vendors that price silver off the Chinese market
// (Aoxin). The daily job (china_price_sync, Supabase) stores
//   silver_lock_cn = SGE Ag(T+D) close (CNY/kg, VAT incl.) / 1000 / USD-CNY * 31.1035
// in metal_lock_history ($/oz, pure silver). It is a drop-in replacement for
// silver_lock: costing still applies purity (x0.925) and the vendor's loss %.
// Checked against Aoxin PI-11333 (10/16/26): lock 65.21 -> 1.9586 $/g after
// x0.925 and Aoxin's 1% loss, vs 1.96 $/g on the invoice.
//
// A vendor opts in with pricingsetting.silverSource = "china".

export function usesChinaSilver(vendor) {
  return String(vendor?.pricingsetting?.silverSource || "").toLowerCase() === "china";
}

// Pick the silver $/oz to cost a vendor's items with.
//   prices      — useMetalPriceStore().prices
//   vendor      — a vendors row (needs pricingsetting)
// Falls back to normal silver if the China lock isn't loaded yet.
export function silverPriceForVendor(prices, vendor) {
  const normal = Number(prices?.silver?.price) || 0;
  if (!usesChinaSilver(vendor)) return normal;
  const cn = Number(prices?.silverChina?.price);
  return cn > 0 ? cn : normal;
}

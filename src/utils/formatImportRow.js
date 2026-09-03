import { getTotalCost } from '../components/Samples/TotalCost';
import { getMetalCost } from '../components/Samples/CalculatePrice';

const normaliseSellingPair = (value) => {
  const v = (value || '').toString().trim().toLowerCase();
  // SSP's own vocabulary (item/get-filters -> quantityType): pairs | piece | set.
  // Accepts the PLM's older words (pair / single) so historic sheets import.
  if (v.startsWith('pair')) return 'pairs';
  if (v.startsWith('set')) return 'set';
  if (v.startsWith('single') || v.startsWith('piece')) return 'piece';
  return 'pairs';
};

export const formatImportRow = (row, type, dropdown, prices) => {
  const stones = [];
  for (let i = 1; i <= 10; i++) {
    if (row[`Stone ${i} Type`] || row[`Stone ${i} Color`] || row[`Stone ${i} Size`]) {
      stones.push({
        id: row[`Stone ${i} ID`] || null,
        type: row[`Stone ${i} Type`] || '',
        color: row[`Stone ${i} Color`] || '',
        size: row[`Stone ${i} Size`] || '',
        shape: row[`Stone ${i} Shape`] || '',
        cost: parseFloat(row[`Stone ${i} Cost`] || 0),
        customType: row[`Stone ${i} Custom Type`] || '',
        quantity: parseInt(row[`Stone ${i} Quantity`] || 0),
        notes: row[`Stone ${i} Notes`] || '',
      });
    }
  }

  const mappedVendorId = dropdown.vendors.find(v => v.name === row['Vendor'])?.id ?? null;
  const mappedPlatingId = dropdown.plating.find(p => p.name === row['Plating'])?.id ?? null;
  const mappedCollectionId = dropdown.collection.find(c => c.name === row['Collection'])?.id ?? null;
  const mappedCategoryId = dropdown.category.find(c => c.name === row['Category'])?.id ?? null;
  // if()
  
  const starting_info = {
    id: row['starting_info_id']||'',
    necklace: row['Necklace True Or False'] || false,
    necklaceCost: parseFloat(row['Necklace Cost'] || 0),
    description: row['Quote Description'] || '',
    images: (row['Quote Images'] || '').split('|').filter(image => image !== ''),
    color: row['Color'] || '',
    height: parseFloat(row['Height (in)'] || 0),
    length: parseFloat(row['Length (in)'] || 0),
    width: parseFloat(row['Width (in)'] || 0),
    weight: parseFloat(row['Weight (g)'] || 0),
    category: mappedCategoryId,
    collection: mappedCollectionId,
    manufacturerCode: row['Manufacturer Code'] || '',
    metalType: row['Metal Type'] || '',
    platingCharge: parseFloat(row['Plating Charge'] || 0),
    stones,
    vendor: mappedVendorId,
    plating: mappedPlatingId,
    karat: row['Karat'] || '',
    designId: row['ID (Design)'] || null,
    miscCost: parseFloat(row['Misc Cost'] || 0),
    laborCost: parseFloat(row['Labor Cost'] || 0),
    totalCost: (() => {
      try {
        // Diagnostic log so you can confirm this runs during import
        console.log('formatImportRow calculating totalCost for row:', row['Style Number'] || row['Sku'] || row);

        const metalTypeKey = (row['Metal Type'] || '').toLowerCase();
        const metalPriceEntry = prices?.[metalTypeKey];
        // support both { price: number } or numeric value
        const metalPrice = metalPriceEntry?.price ?? metalPriceEntry ?? 0;

        const weight = parseFloat(row['Weight'] || row['Weight (g)'] || 0) || 0;
        const karat = row['Karat'] || '';
        const vendorObj = dropdown?.vendors?.find(v => v.id === mappedVendorId) || {};
        // tolerate different casing for pricingSetting/pricingsetting
        const lossPercent =
          vendorObj?.pricingsetting?.lossPercentage ??
          vendorObj?.pricingSetting?.lossPercentage ??
          vendorObj?.lossPercentage ??
          0;

        const metalCost = getMetalCost(metalPrice, weight, karat, lossPercent) || 0;
        const misc = parseFloat(row['Misc Cost'] || 0) || 0;
        const labor = parseFloat(row['Labor Cost'] || 0) || 0;

        const computed = getTotalCost(metalCost, misc, labor, stones) || 0;

        const providedTotal = parseFloat(row['Total Cost']);
        const finalTotal = Number.isFinite(providedTotal) ? providedTotal : computed;

        console.log({ metalTypeKey, metalPrice, weight, karat, lossPercent, metalCost, misc, labor, computed, providedTotal, finalTotal });

        return parseFloat(finalTotal) || 0;
      } catch (err) {
        console.error('Error computing totalCost in formatImportRow:', err);
        return 0;
      }
    })(),
  };

if (type === 'designs') {
    return {
      id: row['ID (Design)'] || '',
      name: row['Name'] || '',
      description: row['Design Description'] || '',
      link: row['Link'] || '',
      collection: mappedCollectionId,
      category: mappedCategoryId,
      images: (row['Design Images'] || '').split('|').filter(image => image !== ''),
      status: row['Status'] || 'Working_on_it:yellow',
      starting_info,
    };
  }

  if (type === 'samples') {
    return {
      id: row['ID (Sample)'] === null ? '' : row['ID (Sample)'],
      cad: (row['CAD Files'] || '').split('|').filter(image => image !== ''),
      // Normalise on the way in. Spreadsheets carry "Pair", "Silicone",
      // "None" and the like, and importing them verbatim is what produced
      // the casing duplicates cleaned up on 2026-09-02 (Silicone/silicone,
      // none/None, pair/Pair/pairs). The form controls already write
      // lowercase, so lowercase is the canonical form.
      selling_pair: normaliseSellingPair(row['Selling Pair']),
      back_type: (row['Back Type'] || 'none').toString().trim().toLowerCase(),
      custom_back_type: row['Custom Back Type'] || '',
      back_type_quantity: parseInt(row['Back Type Quantity'] || 0),
      name: row['Sku'] || '',
      styleNumber: row['Style Number'] || '',
      salesWeight: parseFloat(row['Sales Weight'] || 0),
      starting_info_id: row['Starting Info ID'] || '',
      status: row['Sample Status'] || 'Working_on_it:yellow',
      starting_info,
      designId: row['Design Id'] || null,
    };
  }

  if (type === 'designQuote') {
    return {
      ...starting_info,
      id: row['ID (Design Quote)'] || null,
    };
  }
};

/**
 * Spreadsheet row -> API payload builders.
 *
 * Field names mirror the recorded HAR payloads exactly. Anything the
 * sheet leaves blank falls back to config defaults (header) or is sent
 * as null/"" the way the UI does.
 */

const truthy = (v) =>
  v === true || (typeof v === 'string' && ['y', 'yes', 'true', '1'].includes(v.trim().toLowerCase())) || v === 1;

const num = (v) => (v === undefined || v === null || v === '' ? null : Number(v));
const str = (v) => (v === undefined || v === null ? '' : String(v).trim());
const list = (v) =>
  str(v)
    ? str(v)
        .split(/[,;]/)
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

export function buildHeaderPayload(row) {
  const out = {
    vendorStyleNumber: str(row.styleNumber),
    buyer: str(row.buyer),
    countryOfOrigin: str(row.countryOfOrigin).toUpperCase(),
    shippedFromCountry: str(row.shippedFromCountry || row.countryOfOrigin).toUpperCase(),
  };
  // Optional overrides of config headerDefaults — only sent when the cell is filled.
  const passthrough = [
    'brand',
    'gender',
    'ownership',
    'itemProductionMethod',
    'procurementMethod',
    'polyBagSize',
    'setCode',
    'tariffTreatment',
    'tariffCode',
  ];
  for (const k of passthrough) if (str(row[k])) out[k] = row[k];
  const numeric = ['minOrdQty', 'suppLeadTime', 'viDutyRate', 'diDutyRate'];
  for (const k of numeric) if (row[k] !== undefined && row[k] !== '') out[k] = Number(row[k]);
  const bools = ['childJewelry', 'repairable', 'closeoutItem', 'ecomExclusive', 'dropShip', 'exclusiveBrand', 'exclusiveSignet'];
  for (const k of bools) if (row[k] !== undefined && row[k] !== '') out[k] = truthy(row[k]);
  return out;
}

export function buildItemPayload(row, { hasMaterials, hasFindings, hasStones, hasChains, costingMethod, tethers }) {
  const productComponent = [];
  if (hasFindings) productComponent.push('Finding');
  if (hasMaterials) productComponent.push('Material');
  if (hasStones) productComponent.push('Stone');
  if (hasChains) productComponent.push('Chain');
  return {
    productType: str(row.productType),
    productCategories: list(row.productCategories),
    itemDescription: str(row.itemDescription),
    totalNetGramWeight: num(row.totalNetGramWeight),
    totalGrossGramWeight: num(row.totalGrossGramWeight),
    costingMethod,
    manufacturedCountryOfOrgin: str(row.countryOfOrigin).toUpperCase(), // (sic) — API misspells "Origin"
    productComponent,
    unitOfMeasure: str(row.unitOfMeasure),
    itemSize: str(row.itemSize),
    itemHeight: num(row.itemHeight),
    itemWidth: num(row.itemWidth),
    sizeableIncrement: num(row.sizeableIncrement),
    ringSizeMinimum: str(row.ringSizeMinimum) || '1',
    ringSizeMaximum: str(row.ringSizeMaximum) || '1',
    quantityType: str(row.quantityType),
    setPiece: num(row.setPiece),
    certificateType: [],
    certificationLab: [],
    supplierPack: num(row.supplierPack),
    isTetheredToMetalLossMatrix: !!tethers.isTetheredToMetalLossMatrix,
    isTetheredToDiamondPricingMatrix: !!tethers.isTetheredToDiamondPricingMatrix,
    isTetheredToOvercostMatrix: !!tethers.isTetheredToOvercostMatrix,
  };
}

function buildPlatingBlock(row, componentTab) {
  if (!str(row.platingMaterial)) return [];
  return [
    {
      platingMaterial: str(row.platingMaterial),
      platingColor: str(row.platingColor),
      platingMethod: str(row.platingMethod) || 'galvanic / electroplating',
      platingMicron: num(row.platingMicron),
      platingCost: num(row.platingCost),
      platingCoverageClassification: str(row.platingCoverage) || (componentTab === 'material' ? 'Full' : ''),
      componentTab,
    },
  ];
}

export function buildMaterialPayload(row, { tethers }) {
  return {
    materialType: str(row.materialType),
    metalPurity: num(row.metalPurity),
    metalKarat: str(row.metalKarat),
    metalAlloyColorNickelContents: [{ key: str(row.metalColor), value: str(row.nickelContent) }],
    materialNetWeight: num(row.materialNetWeight),
    metalBasePrice: num(row.metalBasePrice),
    metalFixingAllowPercent: num(row.metalFixingAllowPercent) ?? 0,
    metalFixingAllowAmt: num(row.metalFixingAllowAmt),
    metalLossPercent: num(row.metalLossPercent),
    metalLossAmt: num(row.metalLossAmt),
    metalCost: num(row.metalCost),
    metalCostPerGram: num(row.metalCostPerGram),
    platings: buildPlatingBlock(row, 'material'),
    isTetheredToMetalLossMatrix: !!tethers.isTetheredToMetalLossMatrix,
    isFixedNoMetalLock: false,
  };
}

export function buildFindingPayload(row, { tethers }) {
  return {
    findingType: str(row.findingType),
    materialType: str(row.materialType),
    metalPurity: num(row.metalPurity),
    metalKarat: str(row.metalKarat),
    metalColor: str(row.metalColor),
    nickelContent: str(row.nickelContent),
    description: str(row.description),
    quantity: num(row.quantity) ?? 1,
    size: num(row.size),
    netWeight: num(row.netWeight),
    metalCostPerGram: num(row.metalCostPerGram),
    findingMetalBasePrice: num(row.metalBasePrice),
    findingMetalFixingAllowPercent: num(row.metalFixingAllowPercent) ?? 0,
    findingMetalLossPercent: num(row.metalLossPercent),
    findingMetalLossAmt: num(row.metalLossAmt),
    manufacturingType: str(row.manufacturingType) || 'casted',
    laborCost: num(row.laborCost),
    countryOfOrigin: str(row.countryOfOrigin).toUpperCase(),
    findingMaterialCost: num(row.materialCost),
    platings: buildPlatingBlock(row, 'finding'),
    tetherMetalLossGrid: !!tethers.isTetheredToMetalLossMatrix,
    isFixedNoMetalLock: false,
  };
}

// Stone cost — v1 bucketed-by-size placeholder, same spirit as the
// category map: the workbook doesn't (yet) carry a real stone-vs-setting
// cost split, so both `cost` and `settingChargePerStone` are derived from
// stoneMillimeter and kept equal to each other (matches the recorded HAR,
// where both were 0.2 on the same row). Refine together as real invoices
// come back through reconciliation.
const STONE_BASE_COST = 0.15; // cost at STONE_BASE_SIZE_MM
const STONE_BASE_SIZE_MM = 2;
const STONE_COST_PER_MM_STEP = 0.02; // "a cent or two" per mm above base

export function stoneCostForSize(mm) {
  const size = Number(mm) || STONE_BASE_SIZE_MM;
  const cost = STONE_BASE_COST + Math.max(0, size - STONE_BASE_SIZE_MM) * STONE_COST_PER_MM_STEP;
  return Math.round(cost * 100) / 100;
}

/**
 * Row -> POST /item/{id}/stone/add-stone payload. Field names/shape from
 * the recorded add-stone HAR (2026-08-25, S180933) — see
 * docs/API-NOTES.md. `cost` and `settingChargePerStone` are the same
 * bucketed-by-size number unless the row supplies its own `cost`/
 * `settingChargePerStone` overrides.
 */
export function buildStonePayload(row) {
  const quantity = num(row.quantity) ?? 1;
  const mm = str(row.stoneMillimeter || row.size);
  const cost = num(row.cost) ?? stoneCostForSize(mm);
  const settingCharge = num(row.settingChargePerStone) ?? cost;
  return {
    isPrimaryStone: truthy(row.isPrimaryStone),
    category: str(row.category) || 'cubic zirconia',
    type: str(row.type) || 'NA',
    stoneMillimeter: mm,
    shape: str(row.shape) || 'round',
    cut: str(row.cut) || 'NA',
    color: str(row.color) || 'white',
    clarity: str(row.clarity) || 'AA',
    stonePricingMethod: str(row.stonePricingMethod) || 'Per Piece',
    quantity,
    pricePerCarat: num(row.pricePerCarat) ?? 0,
    cost,
    minimumCaratWeightPerStone: num(row.minimumCaratWeightPerStone) ?? 0,
    minimumTotalCaratWeight: num(row.minimumTotalCaratWeight) ?? 0,
    billWeightCaratPerStone: num(row.billWeightCaratPerStone) ?? 0,
    totalStoneCost: Math.round(cost * quantity * 100) / 100,
    certificateType: [],
    certificationLab: [],
    settingLocation: str(row.settingLocation || row.countryOfOrigin).toUpperCase() || 'VIETNAM',
    settingType: str(row.settingType) || 'prong',
    settingMethod: str(row.settingMethod) || 'hand_wax',
    settingChargePerStone: settingCharge,
    totalBillWeightCaratStone: num(row.totalBillWeightCaratStone) ?? 0,
    totalSettingCost: Math.round(settingCharge * quantity * 100) / 100,
    countryOfOrigin: str(row.countryOfOrigin).toUpperCase() || 'VIETNAM',
    treatment: str(row.treatment) || 'NA',
    additionalCharges: null,
  };
}

export function buildLaborPayload(row) {
  const finishTypes = list(row.finishTypes);
  const finishCosts = list(row.finishCosts).map(Number);
  return {
    noOfCastings: num(row.noOfCastings),
    ttlLaborCastingCost: num(row.ttlLaborCastingCost),
    ttlLaborSettingCost: null,
    ttlLaborChainCost: null,
    ttlLaborFindingCost: null,
    ttlAllMaterialCost: null,
    noOfAssembly: num(row.noOfAssembly),
    assemblyCharge: num(row.assemblyCharge),
    laborPerGram: num(row.laborPerGram),
    ttlLaborAssemblyCost: null,
    ttlLaborFinishingCost: null,
    manufacturingProcess1: str(row.manufacturingProcess1),
    manufacturingProcessCost1: num(row.manufacturingProcessCost1),
    manufacturingProcess2: str(row.manufacturingProcess2),
    manufacturingProcessCost2: num(row.manufacturingProcessCost2),
    manufacturingProcess3: str(row.manufacturingProcess3),
    manufacturingProcessCost3: num(row.manufacturingProcessCost3),
    ttlLaborPgCost: null,
    ttlAllLaborCosts: null,
    finish: finishTypes.map((finishType, i) => ({
      sku: 0,
      finishId: null,
      finishType,
      finishCost: finishCosts[i] ?? null,
    })),
  };
}

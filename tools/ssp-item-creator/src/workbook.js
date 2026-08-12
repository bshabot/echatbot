/**
 * Reads the input workbook (Items / Materials / Findings / Stones / Labor)
 * and groups child rows by styleNumber.
 */

import XLSX from 'xlsx';

const SHEETS = ['Items', 'Materials', 'Findings', 'Stones', 'Labor'];

export function readWorkbook(file) {
  const wb = XLSX.readFile(file);
  const get = (name) => {
    const ws = wb.Sheets[name];
    if (!ws) return [];
    return XLSX.utils
      .sheet_to_json(ws, { defval: '' })
      .filter((r) => Object.values(r).some((v) => String(v).trim() !== ''));
  };
  const data = Object.fromEntries(SHEETS.map((s) => [s, get(s)]));
  if (!data.Items.length) {
    throw new Error(`No rows found on the "Items" sheet of ${file}.`);
  }
  const byStyle = (rows) => {
    const map = new Map();
    for (const r of rows) {
      const key = String(r.styleNumber || '').trim();
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(r);
    }
    return map;
  };
  const materials = byStyle(data.Materials);
  const findings = byStyle(data.Findings);
  const stones = byStyle(data.Stones);
  const labor = byStyle(data.Labor);

  return data.Items.map((row) => {
    const style = String(row.styleNumber || '').trim();
    return {
      style,
      header: row,
      materials: materials.get(style) || [],
      findings: findings.get(style) || [],
      stones: stones.get(style) || [],
      labor: (labor.get(style) || [])[0] || null,
    };
  });
}

export function validate(items) {
  const problems = [];
  const seen = new Set();
  for (const it of items) {
    const p = (msg) => problems.push(`[${it.style || '??'}] ${msg}`);
    if (!it.style) p('missing styleNumber on Items sheet');
    if (seen.has(it.style)) p('duplicate styleNumber on Items sheet');
    seen.add(it.style);
    if (!String(it.header.buyer || '').trim()) p('missing buyer');
    if (!String(it.header.countryOfOrigin || '').trim()) p('missing countryOfOrigin');
    if (!String(it.header.productType || '').trim()) p('missing productType');
    if (!String(it.header.itemDescription || '').trim()) p('missing itemDescription');
    if (!String(it.header.quantityType || '').trim()) p('missing quantityType');
    if (it.header.totalNetGramWeight === '' || it.header.totalNetGramWeight === undefined)
      p('missing totalNetGramWeight');
    if (!it.materials.length && !it.findings.length && !it.stones.length)
      p('no Materials/Findings/Stones rows — item would have no components');
    if (it.stones.length)
      p('has Stones rows, but the stone endpoint is not captured yet (record an add-stone HAR first)');
    if (!it.labor) p('no Labor row — labor-cost tab would be left empty');
  }
  return problems;
}

import { buildSampleTagZPL, buildTagFromSample } from './src/utils/tags/zplTag.js';
import { computeTagLayout, mapSampleToTagFields, estimateWidth, sanitizeStyleNumber, formatWeight } from './src/utils/tags/tagLayout.js';

const vendors = { 7: 'Aoxin' };

const rowA = { styleNumber:'N3053NK-GP', salesWeight:2.44, metalType:'Silver', karat:'925', plating_label:'14k Gold Plated .5mic', manufacturerCode:'N29568', vendor:7 };
const dirty = { styleNumber:'G941HE-10Y\nSmaller 20% size of the original design per buyer request, keep stones', salesWeight:1.05, metalType:'Silver', karat:'925', plating_label:'Rhodium Plated', manufacturerCode:'E12345', vendor:7 };

function check(row,label){
  const f = mapSampleToTagFields(row,{vendorsById:vendors});
  const L = computeTagLayout(f,{dpi:300});
  console.log('=== '+label+' ===');
  console.log('fields:', JSON.stringify(f));
  // overflow check
  let bad=0;
  for(const e of L.elements){
    if(e.kind==='text'){
      const w = estimateWidth(e.text, e.h);
      let box;
      if(e.face==='front') box = L.foldX - e.x;
      else if(e.face==='back') box = L.flagRight - e.x;
      else box = L.widthDots - e.x;
      const over = w > box+1;
      if(over){bad++; console.log('  OVERFLOW', e.face, JSON.stringify(e.text), 'w=',Math.round(w),'box=',box);}
    }
  }
  const qr = L.elements.find(e=>e.kind==='qr');
  console.log('  QR payload =', JSON.stringify(qr.payload), 'mag',qr.mag,'modules',qr.modules,'pix',qr.size);
  console.log('  overflow lines:', bad);
  const zpl = buildSampleTagZPL(f,{dpi:300,backRotation:true});
  console.log('  ZPL has URL?', /https?:\/\//i.test(zpl), ' contains style-only QR?', zpl.includes('^FDMA,'+f.styleNumber+'^FS'));
  console.log('  text elements:');
  for(const e of L.elements.filter(e=>e.kind==='text')) console.log('    ['+e.face+'] "'+e.text+'" h='+e.h+' @('+e.x+','+e.y+')'+(e.muted?' (muted)':''));
  return zpl;
}
const za=check(rowA,'N3053NK-GP');
const zd=check(dirty,'dirty 73-char');
console.log('\nsanitize test:', sanitizeStyleNumber(dirty.styleNumber));
console.log('weight test:', formatWeight(2.44), '|', formatWeight(1.05));
console.log('\n--- ZPL (rowA) ---\n'+za);

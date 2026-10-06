import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useSupabase } from './SupaBaseProvider';

// ---- query parsing (front end; could move to a Postgres fn search_photo_tags later) ----
const CATEGORY_WORDS = {
  ring: ['ring'], rings: ['ring'],
  stud: ['stud earring'], studs: ['stud earring'],
  hoop: ['hoop earring'], hoops: ['hoop earring'],
  huggie: ['huggie earring'], huggies: ['huggie earring'],
  drop: ['drop earring'], drops: ['drop earring'], dangle: ['drop earring'], dangles: ['drop earring'],
  earring: ['*earring'], earrings: ['*earring'],
  necklace: ['necklace', 'pendant necklace'], necklaces: ['necklace', 'pendant necklace'],
  pendant: ['pendant', 'pendant necklace'], pendants: ['pendant', 'pendant necklace'],
  bracelet: ['bracelet'], bracelets: ['bracelet'],
  bangle: ['bangle'], bangles: ['bangle'],
  charm: ['charm'], charms: ['charm'],
  flatback: ['flatback'], flatbacks: ['flatback'],
  climber: ['ear climber'], climbers: ['ear climber'],
  cuff: ['ear cuff'], cuffs: ['ear cuff'],
  pin: ['pin'], pins: ['pin'],
  set: ['jewelry set'], sets: ['jewelry set'],
};
const METAL_WORDS = ['gold', 'silver', 'gunmetal', 'two-tone', 'tri-color'];
const STONE_WORDS = ['pink', 'blue', 'black', 'clear', 'white', 'green', 'red', 'purple', 'multi', 'orange', 'yellow'];
const BAD_ISSUES = ['cad drawing', 'image unreadable', 'not product'];
const PAGE_CAP = 600;

const singular = (w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);

export function parseQuery(q) {
  let s = ` ${(q || '').toLowerCase().replace(/[^a-z0-9\s-]/g, ' ')} `;
  const out = { categories: [], metal: null, stone: null, features: [], styles: [] };
  if (s.includes(' rose gold ')) { out.metal = 'rose gold'; s = s.replace(' rose gold ', ' '); }
  for (const w of s.split(/\s+/).filter(Boolean)) {
    if (/\d/.test(w) && !/^\d+k$/.test(w)) out.styles.push(w); // style number (any token with a digit)
    else if (CATEGORY_WORDS[w]) out.categories.push(...CATEGORY_WORDS[w]);
    else if (METAL_WORDS.includes(w)) out.metal = out.metal || w;
    else if (STONE_WORDS.includes(w)) out.stone = out.stone || w;
    else out.features.push(singular(w));
  }
  out.categories = [...new Set(out.categories)];
  return out;
}

const safe = (v) => !/[,()%*]/.test(v); // keep values safe inside PostgREST .or() filters
const baseStyle = (s) => (s || '').toUpperCase().split('-')[0];

export default function PhotoTagSearch({ fileImages = [], idle = null }) {
  const { supabase } = useSupabase();
  const host = process.env.VITE_DB_HOST_URL || '';

  const [text, setText] = useState('');
  const [category, setCategory] = useState('');
  const [metal, setMetal] = useState('');
  const [stone, setStone] = useState('');
  const [chips, setChips] = useState([]);
  const [onlySample, setOnlySample] = useState(false);
  const [hideBad, setHideBad] = useState(true);

  const [facets, setFacets] = useState({ categories: [], metals: [], stones: [], features: [] });
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // facet lists for dropdowns / chips (one light query)
  useEffect(() => {
    (async () => {
      const { data, error } = await supabase.from('photo_tags').select('category,metal_color,stone_color,features').limit(20000);
      if (error || !data) return;
      const count = (arr) => Object.entries(arr.reduce((m, v) => (v ? ((m[v] = (m[v] || 0) + 1), m) : m), {}))
        .sort((a, b) => b[1] - a[1]).map(([v]) => v);
      setFacets({
        categories: count(data.map((r) => r.category)),
        metals: count(data.map((r) => r.metal_color)),
        stones: count(data.map((r) => r.stone_color)),
        features: count(data.flatMap((r) => r.features || [])).slice(0, 80),
      });
    })();
  }, [supabase]);

  const search = useCallback(async () => {
    setLoading(true);
    setError(null);
    const p = parseQuery(text);
    let cats = p.categories;
    if (category) cats = [category];
    const m = metal || p.metal;
    const st = stone || p.stone;
    const feats = [...new Set([...p.features, ...chips])];

    let q = supabase.from('photo_tags').select('idx,style,category,features,metal_color,stone_color,image_issue');
    if (cats.length) {
      const parts = cats.map((c) => (c === '*earring' ? 'category.ilike.%earring%' : `category.eq.${c}`));
      q = q.or(parts.join(','));
    }
    if (m) q = q.ilike('metal_color', `%${m}%`);
    if (st) q = q.ilike('stone_color', `%${st}%`);
    if (feats.length) q = q.contains('features', feats);
    p.styles.forEach((t) => { q = q.ilike('style', `%${t}%`); });
    const { data: tags, error: tErr } = await q.order('style').limit(PAGE_CAP);
    if (tErr) { setError(tErr.message); setRows([]); setLoading(false); return; }

    const styles = [...new Set((tags || []).map((t) => t.style))];
    const bases = [...new Set(styles.map(baseStyle))];

    // samples (exact, case-insensitive) and images (exact, then base-style fallback)
    const sampleMap = {};
    const imgMap = {};
    for (let i = 0; i < styles.length; i += 60) {
      const chunk = styles.slice(i, i + 60).filter(safe);
      if (!chunk.length) continue;
      const ci = (col) => chunk.map((st) => `${col}.ilike.${st}`).join(','); // case-insensitive match
      const { data: sm } = await supabase.from('samples').select('id,"styleNumber"').or(ci('styleNumber'));
      (sm || []).forEach((s) => { sampleMap[(s.styleNumber || '').toUpperCase()] = s.id; });
      const { data: il } = await supabase.from('image_link')
        .select('styleNumber,is_primary,images:imageId(imageUrl)').or(ci('styleNumber')).limit(1000);
      (il || []).forEach((l) => {
        const k = (l.styleNumber || '').toUpperCase();
        if (l.images?.imageUrl) (imgMap[k] = imgMap[k] || []).push({ url: l.images.imageUrl, primary: l.is_primary });
      });
    }
    // base fallback for styles with no direct image
    const missing = styles.filter((s) => !imgMap[s.toUpperCase()]);
    if (missing.length) {
      const mb = [...new Set(missing.map(baseStyle))];
      for (let i = 0; i < mb.length; i += 40) {
        const chunk = mb.slice(i, i + 40);
        const { data: il } = await supabase.from('image_link')
          .select('styleNumber,is_primary,images:imageId(imageUrl)')
          .or(chunk.filter(safe).flatMap((b) => [`styleNumber.ilike.${b}`, `styleNumber.ilike.${b}-%`]).join(',')).limit(600);
        (il || []).forEach((l) => {
          const b = baseStyle(l.styleNumber);
          if (l.images?.imageUrl) (imgMap[`~${b}`] = imgMap[`~${b}`] || []).push({ url: l.images.imageUrl, primary: l.is_primary });
        });
      }
    }

    // files named after the style in images (public/<style>.ext) but not linked via image_link
    const stillNone = styles.filter((st) => safe(st) && !imgMap[st.toUpperCase()] && !imgMap[`~${baseStyle(st)}`]);
    for (let i = 0; i < stillNone.length; i += 40) {
      const chunk = stillNone.slice(i, i + 40);
      const { data: ni } = await supabase.from('images').select('imageUrl')
        .or(chunk.map((st) => `imageUrl.ilike.public/${st}.%`).join(',')).limit(200);
      (ni || []).forEach((r) => {
        const stem = r.imageUrl.replace(/^.*\//, '').replace(/\.[A-Za-z0-9]+$/, '').toUpperCase();
        (imgMap[stem] = imgMap[stem] || []).push({ url: r.imageUrl });
      });
    }

    // archive fallback: styles with no linked image use archive_images (style, r2_key); first key wins.
    // Table is created by supabase/migrations/archive_images.sql (needs Brian's approval); ignored if absent.
    const archiveMap = {};
    const noImg = styles.filter((st) => !imgMap[st.toUpperCase()] && !imgMap[`~${baseStyle(st)}`]);
    for (let i = 0; i < noImg.length; i += 150) {
      const { data: ar, error: arErr } = await supabase.from('archive_images')
        .select('style,r2_key').in('style', noImg.slice(i, i + 150)).order('r2_key');
      if (arErr) break;
      (ar || []).forEach((a) => { const k = a.style.toUpperCase(); if (!archiveMap[k]) archiveMap[k] = a.r2_key; });
    }

    setRows((tags || []).map((t) => {
      const k = t.style.toUpperCase();
      const imgs = imgMap[k] || imgMap[`~${baseStyle(t.style)}`] || (archiveMap[k] ? [{ url: archiveMap[k] }] : []);
      imgs.sort((a, b) => (b.primary ? 1 : 0) - (a.primary ? 1 : 0));
      return { ...t, sampleId: sampleMap[k] || null, images: imgs, viaBase: !imgMap[k] && imgs.length > 0 };
    }));
    setLoading(false);
  }, [supabase, text, category, metal, stone, chips]);

  // debounce
  useEffect(() => {
    const h = setTimeout(search, 350);
    return () => clearTimeout(h);
  }, [search]);

  const shown = useMemo(() => rows.filter((r) => {
    if (onlySample && !r.sampleId) return false;
    if (hideBad && r.image_issue) {
      const iss = r.image_issue.toLowerCase();
      if (BAD_ISSUES.some((b) => iss.includes(b))) return false;
    }
    return true;
  }), [rows, onlySample, hideBad]);

  const active = !!(text.trim() || category || metal || stone || chips.length);

  // folder files whose name matches the search words, merged into the same grid
  const fileMatches = useMemo(() => {
    const words = text.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    const tagged = new Set(shown.map((r) => r.style.toUpperCase()));
    return fileImages.filter((f) => {
      const n = (f.name || '').toLowerCase();
      const stem = n.replace(/\.[a-z0-9]+$/, '').toUpperCase();
      return !tagged.has(stem) && words.every((w) => n.includes(w));
    });
  }, [fileImages, text, shown]);

  const toggleChip = (f) => setChips((c) => (c.includes(f) ? c.filter((x) => x !== f) : [...c, f]));
  const sel = 'p-2 border rounded-md text-sm bg-white';

  return (
    <div>
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder='Search by style number or tags: "N813E", "heart rings", "gold huggie", "pink studs"'
        className="w-full p-3 border rounded-lg mb-3"
      />
      <div className="flex flex-wrap gap-2 items-center mb-3">
        <select className={sel} value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">All categories</option>
          {facets.categories.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select className={sel} value={metal} onChange={(e) => setMetal(e.target.value)}>
          <option value="">Any metal</option>
          {facets.metals.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select className={sel} value={stone} onChange={(e) => setStone(e.target.value)}>
          <option value="">Any stone color</option>
          {facets.stones.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <label className="text-sm flex items-center gap-1">
          <input type="checkbox" checked={onlySample} onChange={(e) => setOnlySample(e.target.checked)} /> Has sample in PLM
        </label>
        <label className="text-sm flex items-center gap-1">
          <input type="checkbox" checked={hideBad} onChange={(e) => setHideBad(e.target.checked)} /> Hide CAD / unreadable / not product
        </label>
      </div>
      <div className="flex flex-wrap gap-1 mb-3">
        {facets.features.map((f) => (
          <button key={f} onClick={() => toggleChip(f)}
            className={`px-2 py-1 rounded-full text-xs border ${chips.includes(f) ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-700'}`}>
            {f}
          </button>
        ))}
      </div>

      {!active ? idle : (<>
      {error && <p className="text-red-500 text-sm">{error}</p>}
      <p className="text-sm text-gray-500 mb-2">
        {loading ? 'Searching…' : `${shown.length + fileMatches.length} result${shown.length + fileMatches.length === 1 ? '' : 's'}${rows.length >= PAGE_CAP ? ` (capped at ${PAGE_CAP}, narrow your search)` : ''}`}
      </p>

      <div className="grid grid-cols-4 gap-4 max-md:grid-cols-2">
        {shown.map((r, i) => {
          const first = r.images[0]?.url;
          return (
            <div key={r.idx} className="border rounded-lg p-2 border-gray-300 bg-white">
              <div className="h-40 bg-gray-50 rounded-md flex items-center justify-center overflow-hidden">
                {first ? (
                  <img src={first.startsWith('http') ? first : `${host}${first}`} alt={r.style}
                    loading={i > 11 ? 'lazy' : undefined} className="max-h-full max-w-full object-contain" />
                ) : <span className="text-xs text-gray-400">No image linked</span>}
              </div>
              <div className="mt-2 text-sm font-semibold truncate">
                {r.sampleId
                  ? <Link className="text-blue-600 hover:underline" to={`/samples?sampleId=${r.sampleId}`}>{r.style}</Link>
                  : r.style}
              </div>
              <div className="text-xs text-gray-600">{r.category}{r.metal_color ? ` · ${r.metal_color}` : ''}{r.stone_color ? ` · ${r.stone_color}` : ''}</div>
              <div className="flex flex-wrap gap-1 mt-1">
                {(r.features || []).map((f) => <span key={f} className="text-[10px] px-1.5 py-0.5 bg-gray-100 rounded">{f}</span>)}
              </div>
              {!r.sampleId && <div className="text-[10px] text-amber-600 mt-1">Archive only</div>}
              {r.viaBase && <div className="text-[10px] text-gray-400">Image from base style</div>}
              {r.image_issue && <div className="text-[10px] text-red-400 mt-1">{r.image_issue}</div>}
            </div>
          );
        })}
        {fileMatches.map((f) => (
          <div key={`file-${f.name}`} className="border rounded-lg p-2 border-gray-300 bg-white">
            <div className="h-40 bg-gray-50 rounded-md flex items-center justify-center overflow-hidden">
              <img src={`${process.env.VITE_SUPABASE_URL}/storage/v1/object/public/echatbot/public/${f.name}`} alt={f.name}
                loading="lazy" className="max-h-full max-w-full object-contain" />
            </div>
            <div className="mt-2 text-sm font-semibold truncate">{f.name}</div>
            <div className="text-[10px] text-gray-400">Untagged file</div>
          </div>
        ))}
      </div>
      </>)}
    </div>
  );
}

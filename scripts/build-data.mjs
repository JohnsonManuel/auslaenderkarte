// Data pipeline for the Ausländerkarte.
//
// Reads the raw GeoJSON pulled from the Destatis "Regionalatlas" service
// (states = typ 1, districts = typ 3), each already carrying the real
// indicator AI0208 = "Anteil der ausländischen Bevölkerung an der
// Gesamtbevölkerung" (share of foreign nationals, %), reference year 2023.
//
// It cleans names, derives the parent-state key for drill-down, computes a
// stable colour domain, and writes app-ready files into ./public/data.
//
// Re-run yearly (after bumping DATA_YEAR in scripts/fetch-data.sh) with:
//   node scripts/build-data.mjs

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as XLSX from 'xlsx';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const rawDir = resolve(root, 'data', 'raw');
const outDir = resolve(root, 'public', 'data');

const DATA_YEAR = 2023;
const SOURCE =
  'Statistische Ämter des Bundes und der Länder — Regionalatlas Deutschland ' +
  '(Indikator AI0208: Ausländeranteil), Stand 31.12.2023';
const POP_SOURCE =
  'Statistisches Bundesamt — Gemeindeverzeichnis (Bevölkerung auf Grundlage des Zensus 2022)';

const readJSON = (p) => JSON.parse(readFileSync(p, 'utf8'));
const clean = (s) => (s == null ? '' : String(s).replace(/\s+/g, ' ').trim());

// "Verden, Landkreis" -> { name: "Verden", kind: "Landkreis" }
function splitName(gen, gen2) {
  const long = clean(gen2);
  const comma = long.indexOf(',');
  if (comma !== -1) {
    return { name: clean(long.slice(0, comma)), kind: clean(long.slice(comma + 1)) };
  }
  return { name: clean(gen) || long, kind: '' };
}

// ---- states -----------------------------------------------------------------
const rawStates = readJSON(resolve(rawDir, 'states_geo.json'));
const stateNameByAgs = {};

const states = {
  type: 'FeatureCollection',
  features: rawStates.features.map((f) => {
    const ags = clean(f.properties.ags);
    const name = clean(f.properties.gen);
    stateNameByAgs[ags] = name;
    const share = f.properties.ai0208 == null ? null : Number(f.properties.ai0208);
    return {
      type: 'Feature',
      id: ags,
      properties: { level: 'state', ags, name, share },
      geometry: f.geometry,
    };
  }),
};

// ---- districts (Kreise) -----------------------------------------------------
const rawKreise = readJSON(resolve(rawDir, 'kreise_geo.json'));

const kreise = {
  type: 'FeatureCollection',
  features: rawKreise.features.map((f) => {
    const ags = clean(f.properties.ags);
    const stateAgs = ags.slice(0, 2);
    const { name, kind } = splitName(f.properties.gen, f.properties.gen2);
    const share = f.properties.ai0208 == null ? null : Number(f.properties.ai0208);
    return {
      type: 'Feature',
      id: ags,
      properties: {
        level: 'district',
        ags,
        name,
        kind,
        share,
        state_ags: stateAgs,
        state_name: stateNameByAgs[stateAgs] || '',
      },
      geometry: f.geometry,
    };
  }),
};

// ---- absolute population -> German / non-German counts ----------------------
// Total population per district comes from the Destatis Gemeindeverzeichnis.
// The foreign count is derived from the real foreign-share indicator:
//   nonGerman = round(population * share%),  German = population - nonGerman.
const wb = XLSX.read(readFileSync(resolve(rawDir, 'gv_kreise.xlsx')), { type: 'buffer' });
const sheet = wb.Sheets['Kreisfreie Städte u. Landkreise'] || wb.Sheets[wb.SheetNames[1]];
const gvRows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true });

const popByAgs = {}; // 5-digit Regionalschlüssel -> total population
for (const r of gvRows) {
  const code = typeof r[0] === 'string' ? r[0].trim() : '';
  if (!/^\d{5}$/.test(code)) continue; // skip state headers + "Insgesamt" rows
  const pop = Number(r[5]);
  if (Number.isFinite(pop)) popByAgs[code] = pop;
}

const toAgs5 = (ags) => (ags.length === 5 ? ags : ags.padEnd(5, '0')); // "11" -> "11000"
const counts = (pop, share) => {
  if (pop == null || share == null) return { pop: pop ?? null, foreign: null, german: null };
  const foreign = Math.round((pop * share) / 100);
  return { pop, foreign, german: pop - foreign };
};

let matched = 0;
const statePop = {};
for (const f of kreise.features) {
  const p = f.properties;
  const pop = popByAgs[toAgs5(p.ags)] ?? null;
  if (pop != null) matched++;
  statePop[p.state_ags] = (statePop[p.state_ags] || 0) + (pop || 0);
  Object.assign(p, counts(pop, p.share));
}
for (const f of states.features) {
  const p = f.properties;
  Object.assign(p, counts(statePop[p.ags] || null, p.share));
}

// ---- colour domain (robust to outliers) -------------------------------------
const districtShares = kreise.features
  .map((f) => f.properties.share)
  .filter((v) => v != null && Number.isFinite(v))
  .sort((a, b) => a - b);

const pct = (arr, p) => arr[Math.min(arr.length - 1, Math.floor((p / 100) * arr.length))];
const domainLow = Math.max(0, Math.floor(pct(districtShares, 2)));
const domainHigh = Math.ceil(pct(districtShares, 98));

const meta = {
  year: DATA_YEAR,
  source: SOURCE,
  popSource: POP_SOURCE,
  metric: 'Ausländeranteil (share of foreign nationals, %)',
  domainLow,
  domainHigh,
  districtMin: districtShares[0],
  districtMax: districtShares[districtShares.length - 1],
  stateCount: states.features.length,
  districtCount: kreise.features.length,
};

// ---- label anchor points (one per region, avoids duplicate labels) ----------
// A multi-part region (islands, exclaves) would otherwise get one label per
// part. We emit a single Point per feature at the centroid of its largest ring.
function ringCentroid(ring) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, n = ring.length - 1; i < n; i++) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[i + 1];
    const f = x0 * y1 - x1 * y0;
    a += f;
    cx += (x0 + x1) * f;
    cy += (y0 + y1) * f;
  }
  if (a === 0) return ring[0];
  return [cx / (3 * a), cy / (3 * a)];
}
function labelPoint(geometry) {
  const polys = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  let best = polys[0][0], bestLen = 0;
  for (const poly of polys) {
    if (poly[0].length > bestLen) {
      bestLen = poly[0].length;
      best = poly[0];
    }
  }
  return ringCentroid(best);
}
const labelFC = (features, extra = () => ({})) => ({
  type: 'FeatureCollection',
  features: features.map((f) => ({
    type: 'Feature',
    properties: { name: f.properties.name, ...extra(f) },
    geometry: { type: 'Point', coordinates: labelPoint(f.geometry) },
  })),
});
const statesLabels = labelFC(states.features);
const kreiseLabels = labelFC(kreise.features, (f) => ({ state_ags: f.properties.state_ags }));

// ---- write ------------------------------------------------------------------
mkdirSync(outDir, { recursive: true });
writeFileSync(resolve(outDir, 'states.geojson'), JSON.stringify(states));
writeFileSync(resolve(outDir, 'kreise.geojson'), JSON.stringify(kreise));
writeFileSync(resolve(outDir, 'states_labels.geojson'), JSON.stringify(statesLabels));
writeFileSync(resolve(outDir, 'kreise_labels.geojson'), JSON.stringify(kreiseLabels));
writeFileSync(resolve(outDir, 'meta.json'), JSON.stringify(meta, null, 2));

const nationalPop = Object.values(statePop).reduce((s, v) => s + v, 0);
console.log('Wrote public/data:');
console.log(`  states.geojson   ${states.features.length} features`);
console.log(`  kreise.geojson   ${kreise.features.length} features`);
console.log(`  population join   ${matched}/${kreise.features.length} districts matched`);
console.log(`  Germany total    ${nationalPop.toLocaleString('de-DE')} people`);
console.log(`  colour domain    ${domainLow}%  ..  ${domainHigh}%`);
console.log(`  district range   ${meta.districtMin}%  ..  ${meta.districtMax}%`);

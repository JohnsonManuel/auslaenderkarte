// Data pipeline for the Ausländerkarte.
//
// Reads the raw GeoJSON pulled from the Destatis "Regionalatlas" service
// (states = typ 1, districts = typ 3), each already carrying the real
// indicator AI0208 = "Anteil der ausländischen Bevölkerung an der
// Gesamtbevölkerung" (share of foreign nationals, %), current reference
// year DATA_YEAR, plus attribute-only history back to 2011 for the time
// slider (see data/raw/by-year/).
//
// It cleans names, derives the parent-state key for drill-down, computes a
// stable colour domain, builds the 2011-DATA_YEAR time series, and writes
// app-ready files into ./public/data.
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

const DATA_YEAR = 2024;
const SOURCE =
  'Statistische Ämter des Bundes und der Länder — Regionalatlas Deutschland ' +
  '(Indikator AI0208: Ausländeranteil), Stand 31.12.2024';
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

// ---- time series (2011-DATA_YEAR) --------------------------------------------
// Attribute-only history for the time slider. 2011 is the earliest year
// district AGS codes line up with today's 400 districts (several
// Kreisgebietsreformen renumbered/merged districts before then). Two
// mergers remain inside 2011-DATA_YEAR:
//   03159 (Göttingen)    = old 03152 (Göttingen) + 03156 (Osterode), 2016
//   16063 (Wartburgkreis) absorbed 16056 (Eisenach), 2021
// These need no special-case code: before its merger year, a merged AGS
// simply isn't a key in that year's raw data, so it naturally comes out
// null below (rendered as the existing no-data grey) instead of a faked
// pre-merger value.
const HIST_YEARS = [2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023];
const byYearDir = resolve(rawDir, 'by-year');

function shareMapForYear(typ, year) {
  const raw = readJSON(resolve(byYearDir, `${typ}_${year}.json`));
  const map = {};
  for (const f of raw.features) {
    const ags = clean(f.properties.ags);
    const share = f.properties.ai0208 == null ? null : Number(f.properties.ai0208);
    if (share != null) map[ags] = share;
  }
  return map;
}

const years = [...HIST_YEARS, DATA_YEAR];
const shareMapsByYear = {};
for (const year of HIST_YEARS) {
  shareMapsByYear[year] = {
    states: shareMapForYear('states', year),
    kreise: shareMapForYear('kreise', year),
  };
}
// DATA_YEAR is already parsed above (rawStates/rawKreise) - reuse it instead
// of re-reading a duplicate file.
shareMapsByYear[DATA_YEAR] = {
  states: Object.fromEntries(states.features.map((f) => [f.properties.ags, f.properties.share])),
  kreise: Object.fromEntries(kreise.features.map((f) => [f.properties.ags, f.properties.share])),
};

function buildSeries(features, kind) {
  const byAgs = {};
  for (const f of features) {
    const ags = f.properties.ags;
    byAgs[ags] = years.map((year) => shareMapsByYear[year][kind][ags] ?? null);
  }
  return byAgs;
}
// Hamburg and Berlin are city-states: their district-level entity (kreise,
// typ=3) shares the SAME 2-digit AGS as the state itself ("02", "11"),
// because there's no separate Kreis - the whole state is one urban unit.
// A single flat byAgs map would let one overwrite the other, so states and
// districts get their own namespace instead of relying on the two series
// happening to agree (they do today, but that's incidental, not structural).
const timeseries = {
  years,
  states: buildSeries(states.features, 'states'),
  districts: buildSeries(kreise.features, 'kreise'),
};

const preMergeNulls = (ags) =>
  timeseries.districts[ags].filter((v, i) => v == null && years[i] < DATA_YEAR).length;

// ---- colour domain (robust to outliers, pooled across all years) -----------
// A fixed domain across the whole time range keeps colour intensity
// comparable when scrubbing the slider, instead of rescaling every frame.
const allYearsDistrictShares = kreise.features
  .flatMap((f) => timeseries.districts[f.properties.ags])
  .filter((v) => v != null && Number.isFinite(v))
  .sort((a, b) => a - b);
const districtShares = kreise.features
  .map((f) => f.properties.share)
  .filter((v) => v != null && Number.isFinite(v))
  .sort((a, b) => a - b);

const pct = (arr, p) => arr[Math.min(arr.length - 1, Math.floor((p / 100) * arr.length))];
const domainLow = Math.max(0, Math.floor(pct(allYearsDistrictShares, 2)));
const domainHigh = Math.ceil(pct(allYearsDistrictShares, 98));

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
writeFileSync(resolve(outDir, 'timeseries.json'), JSON.stringify(timeseries));

const nationalPop = Object.values(statePop).reduce((s, v) => s + v, 0);
console.log('Wrote public/data:');
console.log(`  states.geojson   ${states.features.length} features`);
console.log(`  kreise.geojson   ${kreise.features.length} features`);
console.log(`  population join   ${matched}/${kreise.features.length} districts matched`);
console.log(`  Germany total    ${nationalPop.toLocaleString('de-DE')} people`);
console.log(`  colour domain    ${domainLow}%  ..  ${domainHigh}%  (pooled across ${years.length} years)`);
console.log(`  district range   ${meta.districtMin}%  ..  ${meta.districtMax}%`);
console.log(`  timeseries.json  ${years.length} years (${years[0]}-${years[years.length - 1]}), ` +
  `${Object.keys(timeseries.states).length} states + ${Object.keys(timeseries.districts).length} districts`);
console.log(`    pre-merge gaps   Göttingen (03159): ${preMergeNulls('03159')} yrs, ` +
  `Wartburgkreis (16063): ${preMergeNulls('16063')} yrs`);

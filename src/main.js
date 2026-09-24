import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { scaleSequential } from 'd3-scale';
import { interpolateYlOrRd } from 'd3-scale-chromatic';
import Fuse from 'fuse.js';
import './style.css';

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
const overlay = showOverlay('Loading map data…');

let states, kreise, meta, statesLabels, kreiseLabels, timeseries;
try {
  [states, kreise, meta, statesLabels, kreiseLabels, timeseries] = await Promise.all([
    fetch('data/states.geojson').then(okJson),
    fetch('data/kreise.geojson').then(okJson),
    fetch('data/meta.json').then(okJson),
    fetch('data/states_labels.geojson').then(okJson),
    fetch('data/kreise_labels.geojson').then(okJson),
    fetch('data/timeseries.json').then(okJson),
  ]);
} catch (err) {
  showOverlay(`Could not load data files.\n${err.message}`, true);
  throw err;
}

// ---------------------------------------------------------------------------
// Time slider state
// ---------------------------------------------------------------------------
const YEARS = timeseries.years; // e.g. [2011, 2012, ..., 2024]
let yearIndex = YEARS.length - 1; // defaults to the latest year

// Hamburg/Berlin are city-states whose district-level entity shares the same
// 2-digit AGS as the state itself, so state and district series are kept in
// separate namespaces (see build-data.mjs) instead of one flat map.
const seriesFor = (ags, level) => (level === 'state' ? timeseries.states : timeseries.districts)[ags];
const shareAt = (ags, level, idx = yearIndex) => {
  const series = seriesFor(ags, level);
  const v = series ? series[idx] : null;
  return v == null ? null : v;
};
function countsFor(pop, share) {
  if (pop == null || share == null) return { foreign: null, german: null };
  const foreign = Math.round((pop * share) / 100);
  return { foreign, german: pop - foreign };
}

// ---------------------------------------------------------------------------
// Colour scale + derived lookups
// ---------------------------------------------------------------------------
const NO_DATA = '#2b3450';
const color = scaleSequential(interpolateYlOrRd).domain([meta.domainLow, meta.domainHigh]);
const colorFor = (share) => (share == null || !Number.isFinite(share) ? NO_DATA : color(share));

// paint a default colour (latest year) onto every feature so the fill layer
// has a sane value even before the first applyYear() feature-state pass.
for (const f of states.features) f.properties.color = colorFor(f.properties.share);
for (const f of kreise.features) f.properties.color = colorFor(f.properties.share);

// national rankings + per-state share, recomputed for the selected year.
let stateRank = {};
let districtRank = {};
let stateShareByAgs = {};

function recomputeYearDerived() {
  stateRank = rankByShare(states.features);
  districtRank = rankByShare(kreise.features);
  stateShareByAgs = Object.fromEntries(
    states.features.map((f) => [f.properties.ags, shareAt(f.properties.ags, 'state')]),
  );
}
recomputeYearDerived();

// bounding boxes for fly-to
const germanyBounds = featureCollectionBounds(states);
const stateBounds = Object.fromEntries(
  states.features.map((f) => [f.properties.ags, geometryBounds(f.geometry)]),
);
const districtBounds = Object.fromEntries(
  kreise.features.map((f) => [f.properties.ags, geometryBounds(f.geometry)]),
);

// ---------------------------------------------------------------------------
// Map
// ---------------------------------------------------------------------------
const map = new maplibregl.Map({
  container: 'map',
  style: {
    version: 8,
    glyphs: 'fonts/{fontstack}/{range}.pbf', // self-hosted (public/fonts), no external dependency
    sources: {},
    layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#0b1020' } }],
  },
  bounds: germanyBounds,
  fitBoundsOptions: { padding: 60 },
  attributionControl: false,
  dragRotate: false,
});
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
map.touchZoomRotate.disableRotation();

const FILL_OPACITY = ['case', ['boolean', ['feature-state', 'hover'], false], 0.95, 0.72];

map.on('load', () => {
  map.addSource('states', { type: 'geojson', data: states, promoteId: 'ags' });
  map.addSource('kreise', { type: 'geojson', data: kreise, promoteId: 'ags' });
  map.addSource('states-labels', { type: 'geojson', data: statesLabels });
  map.addSource('kreise-labels', { type: 'geojson', data: kreiseLabels });

  map.addLayer({
    id: 'states-fill',
    type: 'fill',
    source: 'states',
    paint: {
      'fill-color': ['coalesce', ['feature-state', 'color'], ['get', 'color']],
      'fill-color-transition': { duration: 300 },
      'fill-opacity': FILL_OPACITY,
    },
  });
  map.addLayer({
    id: 'states-line',
    type: 'line',
    source: 'states',
    paint: { 'line-color': '#0b1020', 'line-width': 1.2 },
  });

  map.addLayer({
    id: 'kreise-fill',
    type: 'fill',
    source: 'kreise',
    filter: ['==', ['get', 'state_ags'], '__none__'],
    paint: {
      'fill-color': ['coalesce', ['feature-state', 'color'], ['get', 'color']],
      'fill-color-transition': { duration: 300 },
      'fill-opacity': FILL_OPACITY,
    },
  });
  map.addLayer({
    id: 'kreise-line',
    type: 'line',
    source: 'kreise',
    filter: ['==', ['get', 'state_ags'], '__none__'],
    paint: { 'line-color': 'rgba(11,16,32,0.85)', 'line-width': 0.7 },
  });

  // Name labels on the map (state names nationally, district names in a state).
  map.addLayer({
    id: 'states-label',
    type: 'symbol',
    source: 'states-labels',
    layout: {
      'text-field': ['get', 'name'],
      'text-font': ['Noto Sans Regular'],
      'text-size': 13,
      'text-allow-overlap': false,
    },
    paint: {
      'text-color': '#f5f7ff',
      'text-halo-color': 'rgba(5,8,18,0.92)',
      'text-halo-width': 1.4,
    },
  });
  map.addLayer({
    id: 'kreise-label',
    type: 'symbol',
    source: 'kreise-labels',
    filter: ['==', ['get', 'state_ags'], '__none__'],
    layout: {
      'text-field': ['get', 'name'],
      'text-font': ['Noto Sans Regular'],
      'text-size': 11,
      'text-allow-overlap': false,
      'text-padding': 2,
    },
    paint: {
      'text-color': '#ffffff',
      'text-halo-color': 'rgba(5,8,18,0.92)',
      'text-halo-width': 1.3,
    },
  });

  wireHover('states-fill', 'states');
  wireHover('kreise-fill', 'kreise');

  // Single, race-free click handler. Behaviour depends on the current level
  // and what is under the pointer at click time:
  //   national  + on a state    -> drill into that state
  //   state     + on a district -> open its detail panel
  //   state     + empty space   -> back to the national view
  map.on('click', (e) => {
    if (level === 'national') {
      const hit = map.queryRenderedFeatures(e.point, { layers: ['states-fill'] });
      if (hit.length) drillToState(hit[0].properties.ags);
    } else {
      const hit = map.queryRenderedFeatures(e.point, { layers: ['kreise-fill'] });
      if (hit.length) showDistrictDetail(hit[0].properties);
      else goNational();
    }
  });

  // Ensure correct framing once the container has its final size.
  map.resize();
  map.fitBounds(germanyBounds, { padding: 60, duration: 0 });

  mapLoaded = true;
  applyYear(yearIndex);
});

// ---------------------------------------------------------------------------
// Drill-down state
// ---------------------------------------------------------------------------
let level = 'national'; // 'national' | 'state'
let currentStateAgs = null;

function goNational({ fly = true } = {}) {
  level = 'national';
  currentStateAgs = null;
  const none = ['==', ['get', 'state_ags'], '__none__'];
  map.setFilter('kreise-fill', none);
  map.setFilter('kreise-line', none);
  map.setFilter('kreise-label', none);
  setVisible('states-fill', true);
  setVisible('states-line', true);
  setVisible('states-label', true);
  clearHover();
  renderBreadcrumb();
  setHint('Click a state to see its districts');
  closeDetail();
  if (fly) map.fitBounds(germanyBounds, { padding: 60, duration: 700 });
}

function drillToState(ags, { fly = true } = {}) {
  if (!stateBounds[ags]) return;
  level = 'state';
  currentStateAgs = ags;
  const stateFilter = ['==', ['get', 'state_ags'], ags];
  map.setFilter('kreise-fill', stateFilter);
  map.setFilter('kreise-line', stateFilter);
  map.setFilter('kreise-label', stateFilter);
  setVisible('states-fill', false);
  setVisible('states-line', false);
  setVisible('states-label', false);
  clearHover();
  renderBreadcrumb();
  setHint('Click a district for details · click outside to go back');
  if (fly) map.fitBounds(stateBounds[ags], { padding: 40, duration: 800 });
}

// ---------------------------------------------------------------------------
// Time slider
// ---------------------------------------------------------------------------
let mapLoaded = false;
let openDetail = null; // { level: 'state' | 'district', ags } | null

function applyYear(idx) {
  yearIndex = idx;
  recomputeYearDerived();

  if (mapLoaded) {
    for (const f of states.features) {
      const ags = f.properties.ags;
      map.setFeatureState({ source: 'states', id: ags }, { color: colorFor(shareAt(ags, 'state')) });
    }
    for (const f of kreise.features) {
      const ags = f.properties.ags;
      map.setFeatureState({ source: 'kreise', id: ags }, { color: colorFor(shareAt(ags, 'district')) });
    }
  }

  renderYearLabel();

  // Keep an open detail panel in sync with the newly selected year.
  if (openDetail) {
    const fc = openDetail.level === 'state' ? states : kreise;
    const f = fc.features.find((x) => x.properties.ags === openDetail.ags);
    if (f) (openDetail.level === 'state' ? showStateDetail : showDistrictDetail)(f.properties);
  }
}

const yearSlider = document.getElementById('year-slider');
const yearLabel = document.getElementById('year-label');
const yearPrev = document.getElementById('year-prev');
const yearNext = document.getElementById('year-next');
const yearPlay = document.getElementById('year-play');
let playTimer = null;

function renderYearLabel() {
  yearLabel.textContent = YEARS[yearIndex];
  yearSlider.value = String(yearIndex);
  yearPrev.disabled = yearIndex === 0;
  yearNext.disabled = yearIndex === YEARS.length - 1;
}

yearSlider.min = '0';
yearSlider.max = String(YEARS.length - 1);
yearSlider.step = '1';
yearSlider.value = String(yearIndex);

yearSlider.addEventListener('input', () => {
  stopPlay();
  applyYear(Number(yearSlider.value));
});
yearPrev.addEventListener('click', () => {
  stopPlay();
  if (yearIndex > 0) applyYear(yearIndex - 1);
});
yearNext.addEventListener('click', () => {
  stopPlay();
  if (yearIndex < YEARS.length - 1) applyYear(yearIndex + 1);
});
const yearPlayIcon = document.getElementById('year-play-icon');
const PLAY_D = 'M8 5.5v13l11-6.5z';
const PAUSE_D = 'M7 5h4v14H7zM13 5h4v14h-4z';

yearPlay.addEventListener('click', () => {
  if (playTimer) return stopPlay();
  if (yearIndex >= YEARS.length - 1) applyYear(0);
  yearPlayIcon.setAttribute('d', PAUSE_D);
  yearPlay.setAttribute('aria-label', 'Pause');
  playTimer = setInterval(() => {
    if (yearIndex >= YEARS.length - 1) return stopPlay();
    applyYear(yearIndex + 1);
  }, 700);
});
function stopPlay() {
  if (!playTimer) return;
  clearInterval(playTimer);
  playTimer = null;
  yearPlayIcon.setAttribute('d', PLAY_D);
  yearPlay.setAttribute('aria-label', 'Play');
}

// ---------------------------------------------------------------------------
// Interactions
// ---------------------------------------------------------------------------
let hovered = null; // { source, id }
const tooltip = document.getElementById('tooltip');

function wireHover(layerId, source) {
  map.on('mousemove', layerId, (e) => {
    const f = e.features && e.features[0];
    if (!f) return;
    map.getCanvas().style.cursor = 'pointer';
    setHover(source, f.id);
    showTooltip(e.originalEvent, f.properties);
  });
  map.on('mouseleave', layerId, () => {
    map.getCanvas().style.cursor = '';
    clearHover();
    hideTooltip();
  });
}

function setHover(source, id) {
  if (hovered && (hovered.source !== source || hovered.id !== id)) clearHover();
  hovered = { source, id };
  map.setFeatureState({ source, id }, { hover: true });
}
function clearHover() {
  if (!hovered) return;
  map.setFeatureState({ source: hovered.source, id: hovered.id }, { hover: false });
  hovered = null;
}

function showTooltip(evt, props) {
  const sub =
    props.level === 'district'
      ? `${props.kind || 'District'} · ${props.state_name}`
      : 'Federal state';
  const foreignPct = shareAt(props.ags, props.level);
  const germanPct = foreignPct == null ? null : Math.round((100 - foreignPct) * 10) / 10;
  const { foreign, german } = countsFor(props.pop, foreignPct);
  tooltip.innerHTML =
    `<div class="tooltip__name">${escapeHtml(props.name)}</div>` +
    `<div class="tooltip__sub">${escapeHtml(sub)}</div>` +
    `<div class="tt-row"><span class="tt-k">Germans</span>` +
    `<span class="tt-v">${fmtInt(german)} <em>${fmtPct(germanPct)}</em></span></div>` +
    `<div class="tt-row tt-row--accent"><span class="tt-k">Non-Germans</span>` +
    `<span class="tt-v">${fmtInt(foreign)} <em>${fmtPct(foreignPct)}</em></span></div>` +
    `<div class="tt-total">Population ${fmtInt(props.pop)} · ${YEARS[yearIndex]}</div>`;
  tooltip.style.left = `${evt.clientX}px`;
  tooltip.style.top = `${evt.clientY}px`;
  tooltip.hidden = false;
}
function hideTooltip() {
  tooltip.hidden = true;
}

// ---------------------------------------------------------------------------
// Detail panel
// ---------------------------------------------------------------------------
const detail = document.getElementById('detail');

function showDistrictDetail(p) {
  openDetail = { level: 'district', ags: p.ags };
  const share = shareAt(p.ags, 'district');
  const { foreign, german } = countsFor(p.pop, share);
  const germanPct = share == null ? null : Math.round((100 - share) * 10) / 10;
  const rank = districtRank[p.ags];
  const stateShare = stateShareByAgs[p.state_ags];
  const delta = share != null && stateShare != null ? share - stateShare : null;
  fillDetail({
    kicker: p.kind || 'District',
    name: p.name,
    share,
    rows: [
      ['Germans', `${fmtInt(german)} · ${fmtPct(germanPct)}`],
      ['Non-Germans', `${fmtInt(foreign)} · ${fmtPct(share)}`],
      ['Population', fmtInt(p.pop)],
      ['State', p.state_name || '—'],
      ['Rank in Germany', rank ? `#${rank} of ${meta.districtCount}` : '—'],
      [`vs. ${p.state_name} avg.`, delta == null ? '—' : `${fmtDelta(delta)} pts`],
    ],
    note: `Population: ${meta.popSource}. Counts are derived from the ${YEARS[yearIndex]} foreign-share indicator, so they are approximate. Neighbourhood-level breakdown within a city is not part of the federal dataset.`,
  });
}

function showStateDetail(p) {
  openDetail = { level: 'state', ags: p.ags };
  const share = shareAt(p.ags, 'state');
  const { foreign, german } = countsFor(p.pop, share);
  const germanPct = share == null ? null : Math.round((100 - share) * 10) / 10;
  const rank = stateRank[p.ags];
  const districtsInState = kreise.features.filter((f) => f.properties.state_ags === p.ags).length;
  fillDetail({
    kicker: 'Federal state',
    name: p.name,
    share,
    rows: [
      ['Germans', `${fmtInt(german)} · ${fmtPct(germanPct)}`],
      ['Non-Germans', `${fmtInt(foreign)} · ${fmtPct(share)}`],
      ['Population', fmtInt(p.pop)],
      ['Rank of states', rank ? `#${rank} of ${meta.stateCount}` : '—'],
      ['Districts', String(districtsInState)],
    ],
    note: `Population: ${meta.popSource}. Counts are derived from the ${YEARS[yearIndex]} foreign-share indicator, so they are approximate. Click the state on the map to drill into its districts.`,
  });
}

function fillDetail({ kicker, name, share, rows, note }) {
  document.getElementById('detail-kicker').textContent = kicker;
  document.getElementById('detail-name').textContent = name;
  document.getElementById('detail-value').textContent = share == null ? '—' : fmtNum(share);
  const dl = detail.querySelector('.detail__meta');
  dl.innerHTML = rows
    .map(([k, v]) => `<div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd></div>`)
    .join('');
  document.getElementById('detail-note').textContent = note;
  detail.hidden = false;
}
function closeDetail() {
  detail.hidden = true;
  openDetail = null;
}

// ---------------------------------------------------------------------------
// Breadcrumb
// ---------------------------------------------------------------------------
const breadcrumb = document.getElementById('breadcrumb');

const BACK_ICON =
  '<svg class="crumb__back" viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7" ' +
  'fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function renderBreadcrumb() {
  const isState = level === 'state' && currentStateAgs;
  const homeIcon = isState ? BACK_ICON : '';
  const homeTitle = isState ? ' title="Back to Germany (Esc)"' : '';
  const parts = [
    `<button type="button" class="crumb crumb--root" data-action="home"${homeTitle}>${homeIcon}Germany</button>`,
  ];
  if (isState) {
    const name = stateNameByAgs(currentStateAgs);
    parts.push('<span class="crumb__sep">›</span>');
    parts.push(`<span class="crumb crumb--current">${escapeHtml(name)}</span>`);
  }
  breadcrumb.innerHTML = parts.join('');
}
function stateNameByAgs(ags) {
  const f = states.features.find((x) => x.properties.ags === ags);
  return f ? f.properties.name : ags;
}

breadcrumb.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action="home"]');
  if (btn) goNational();
});

detail.addEventListener('click', (e) => {
  if (e.target.closest('[data-action="close-detail"]')) closeDetail();
});

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------
const searchIndex = [
  ...states.features.map((f) => ({
    name: f.properties.name,
    ags: f.properties.ags,
    type: 'State',
    kind: 'state',
    state_ags: f.properties.ags,
    share: f.properties.share,
  })),
  ...kreise.features.map((f) => ({
    name: f.properties.name,
    ags: f.properties.ags,
    type: f.properties.kind || 'District',
    kind: 'district',
    state_ags: f.properties.state_ags,
    state_name: f.properties.state_name,
    share: f.properties.share,
  })),
];
const fuse = new Fuse(searchIndex, { keys: ['name'], threshold: 0.3, distance: 60 });

const searchInput = document.getElementById('search-input');
const searchResults = document.getElementById('search-results');
const searchForm = document.getElementById('search-form');
let activeResults = [];
let activeIndex = -1;

searchInput.addEventListener('input', () => {
  const q = searchInput.value.trim();
  if (!q) return hideResults();
  activeResults = fuse.search(q, { limit: 8 }).map((r) => r.item);
  renderResults();
});

searchInput.addEventListener('keydown', (e) => {
  if (searchResults.hidden) return;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    activeIndex = Math.min(activeIndex + 1, activeResults.length - 1);
    highlightResult();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    activeIndex = Math.max(activeIndex - 1, 0);
    highlightResult();
  } else if (e.key === 'Escape') {
    hideResults();
  }
});

searchForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const pick = activeResults[activeIndex >= 0 ? activeIndex : 0];
  if (pick) selectResult(pick);
});

searchResults.addEventListener('click', (e) => {
  const li = e.target.closest('li[data-i]');
  if (!li) return;
  const pick = activeResults[Number(li.dataset.i)];
  if (pick) selectResult(pick);
});

document.addEventListener('click', (e) => {
  if (!searchForm.contains(e.target)) hideResults();
});

// One Escape key backs out one layer at a time: search suggestions, then
// the detail panel, then drill level - so there is always an obvious way
// back, even after opening a large state with many small districts.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!searchResults.hidden) return hideResults();
  if (!detail.hidden) return closeDetail();
  if (level === 'state') return goNational();
});

function renderResults() {
  activeIndex = -1;
  if (!activeResults.length) {
    searchResults.innerHTML = '<li class="r-empty">No match</li>';
    searchResults.hidden = false;
    return;
  }
  searchResults.innerHTML = activeResults
    .map(
      (r, i) =>
        `<li data-i="${i}"><span>${escapeHtml(r.name)}</span>` +
        `<span class="r-type">${escapeHtml(r.type)}</span></li>`,
    )
    .join('');
  searchResults.hidden = false;
}
function highlightResult() {
  [...searchResults.children].forEach((li, i) =>
    li.classList.toggle('active', i === activeIndex),
  );
}
function hideResults() {
  searchResults.hidden = true;
  activeIndex = -1;
}

function selectResult(item) {
  hideResults();
  searchInput.value = item.name;
  if (item.kind === 'state') {
    drillToState(item.ags);
    const f = states.features.find((x) => x.properties.ags === item.ags);
    if (f) showStateDetail(f.properties);
  } else {
    drillToState(item.state_ags, { fly: false });
    const b = districtBounds[item.ags];
    if (b) map.fitBounds(b, { padding: 80, duration: 800, maxZoom: 10 });
    const f = kreise.features.find((x) => x.properties.ags === item.ags);
    if (f) showDistrictDetail(f.properties);
  }
}

// ---------------------------------------------------------------------------
// Legend + attribution
// ---------------------------------------------------------------------------
renderLegend();
document.getElementById('attribution').textContent = `Data: ${meta.source}. Boundaries generalised.`;

function renderLegend() {
  const stops = [];
  const n = 24;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const v = meta.domainLow + t * (meta.domainHigh - meta.domainLow);
    stops.push(`${color(v)} ${Math.round(t * 100)}%`);
  }
  document.getElementById('legend-bar').style.background = `linear-gradient(90deg, ${stops.join(',')})`;
  document.getElementById('legend-low').textContent = `${meta.domainLow}%`;
  document.getElementById('legend-high').textContent = `${meta.domainHigh}%+`;
}
function setHint(text) {
  document.getElementById('legend-hint').textContent = text;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function setVisible(layerId, visible) {
  if (map.getLayer(layerId)) {
    map.setLayoutProperty(layerId, 'visibility', visible ? 'visible' : 'none');
  }
}

function rankByShare(features) {
  const at = (f) => shareAt(f.properties.ags, f.properties.level);
  const sorted = features.filter((f) => at(f) != null).sort((a, b) => at(b) - at(a));
  const rank = {};
  sorted.forEach((f, i) => (rank[f.properties.ags] = i + 1));
  return rank;
}

function geometryBounds(geometry) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const scan = (coords) => {
    if (typeof coords[0] === 'number') {
      const [x, y] = coords;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    } else {
      for (const c of coords) scan(c);
    }
  };
  scan(geometry.coordinates);
  return [[minX, minY], [maxX, maxY]];
}

function featureCollectionBounds(fc) {
  let b = [[Infinity, Infinity], [-Infinity, -Infinity]];
  for (const f of fc.features) {
    const g = geometryBounds(f.geometry);
    b[0][0] = Math.min(b[0][0], g[0][0]);
    b[0][1] = Math.min(b[0][1], g[0][1]);
    b[1][0] = Math.max(b[1][0], g[1][0]);
    b[1][1] = Math.max(b[1][1], g[1][1]);
  }
  return b;
}

function okJson(r) {
  if (!r.ok) throw new Error(`${r.status} ${r.url}`);
  return r.json();
}

function fmtNum(v) {
  return Number(v).toLocaleString('en-GB', { maximumFractionDigits: 1 });
}
function fmtInt(v) {
  return v == null || !Number.isFinite(v) ? 'n/a' : Number(v).toLocaleString('en-GB');
}
function fmtPct(v) {
  return v == null ? 'n/a' : `${fmtNum(v)}%`;
}
function fmtDelta(v) {
  const s = fmtNum(Math.abs(v));
  return v >= 0 ? `+${s}` : `−${s}`;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
  );
}

function showOverlay(text, isError = false) {
  let el = document.querySelector('.overlay');
  if (!el) {
    el = document.createElement('div');
    el.className = 'overlay';
    document.body.appendChild(el);
  }
  el.classList.toggle('overlay--error', isError);
  el.textContent = text;
  return el;
}

// remove the loading overlay once the first frame is painted
map.once('idle', () => overlay.remove());

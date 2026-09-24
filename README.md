# Ausländerkarte — foreign-national share across Germany

A full-screen, drill-down choropleth web map (à la *thetruesize.com*, but data-driven and
scoped to Germany). Start on the 16 federal states, click one to zoom in and reveal its
districts (*Kreise und kreisfreie Städte*), each coloured by the **share of foreign
nationals** (*Ausländeranteil*). Search any state or district, hover for a tooltip, click a
district for a detail panel, and drag the year slider (2011-2024) to see how the share
changed over time. Press Esc to back out of a detail panel or drill level.

## Stack
- **MapLibre GL JS** — WebGL vector map engine (open-source, no API key, no billing).
- **d3-scale / d3-scale-chromatic** — sequential choropleth colour ramp.
- **Fuse.js** — client-side fuzzy search over region names.
- **Vite** — dev server + build. No backend: the data is static files on a CDN-friendly site.

## Data
- **Metric:** `AI0208` — *Anteil der ausländischen Bevölkerung an der Gesamtbevölkerung*
  (share of foreign nationals, %), reference year **2024**.
- **Source:** Statistische Ämter des Bundes und der Länder — **Regionalatlas Deutschland**,
  a public, no-key ArcGIS service. Geometry + indicator are fetched together, already
  reprojected to WGS84 and generalised for the web.
- Boundaries and data join on the official **AGS** key (2 digits = state, 5 digits =
  district), so drill-down is a prefix match — no fragile name matching.

- **History:** the same indicator back to **2011** (attribute-only, no geometry re-pull -
  the shape doesn't change, just the value), for the year slider. 2011 is the earliest
  year district AGS codes line up with today's 400 districts; two Kreisgebietsreform
  mergers (Göttingen 2016, Wartburgkreis/Eisenach 2021) render as no-data before their
  merger year rather than a guessed pre-merger value.

Data only changes **once a year**, so there is no live backend to maintain. Refresh with:

```bash
npm run fetch-data   # re-pull raw GeoJSON + history from the Regionalatlas (needs bash + curl)
npm run build-data   # clean + join + write public/data/* (incl. timeseries.json)
```

## Run

```bash
npm install
npm run dev          # open the printed http://localhost URL
```

Build a static bundle for hosting (Cloudflare Pages / Netlify / Vercel):

```bash
npm run build        # outputs dist/
npm run preview      # preview the production build locally
```

## Layout
```
data/raw/            raw GeoJSON pulled from the Regionalatlas (current year)
data/raw/by-year/    attribute-only history (2011-current year - 1), for the time slider
public/data/         app-ready states.geojson, kreise.geojson, meta.json, timeseries.json
scripts/             fetch-data.sh (download) + build-data.mjs (clean/join/time series)
src/                 main.js (map + interactions), style.css
```

## Notes / next steps
- The federal dataset stops at district level. **Within-city neighbourhood** breakdowns
  exist only on individual city open-data portals (Berlin, Munich, Hamburg, …) and would be
  added city-by-city as a third drill level.
- Absolute foreigner **counts** are derived (population × share, from the Destatis
  Gemeindeverzeichnis), not read directly from a Regionalatlas count table - see
  `counts()` in `build-data.mjs`. They're therefore approximate, and only available for
  the current reference year (no historical per-district population series).
- A legal-pathway breakdown (EU/free-movement vs. third-country, work/family/asylum) was
  investigated but deferred: that data lives in GENESIS-Online / regionalstatistik.de,
  which needs a registered account rather than the no-key Regionalatlas endpoint used here.

# Ausländerkarte — Germany's foreign-national population, mapped

**🔴 Live demo → https://JohnsonManuel.github.io/auslaenderkarte/**

An interactive map that shows what share of each part of Germany is made up of
foreign nationals (*Ausländer*), and how that has changed over the years. Think of it
like *thetruesize.com* — one big full-screen map you explore — but built around real
population data instead of country outlines.

## What you can do

- **Start with all 16 federal states**, each shaded by its share of foreign nationals —
  darker means a higher share.
- **Click a state to zoom in** and see the same picture broken down into its ~400
  districts (*Kreise*). Click empty space to zoom back out.
- **Hover anywhere** for a quick readout: how many Germans vs. non-Germans live there,
  and the percentages.
- **Search** for any state or district by name to jump straight to it.
- **Drag the year slider (2011–2024)** to watch how the share shifts over time, or hit
  play to animate it.

## What it's showing

The core number is the **share of foreign nationals** — people living in an area who
don't hold German citizenship, as a percentage of everyone living there. The absolute
"Germans vs. non-Germans" head-counts you see on hover are worked out from that share
combined with official population figures, so treat them as close estimates rather than
exact registry counts.

The data comes straight from Germany's official statistics offices (the
**Regionalatlas Deutschland** service run by the *Statistische Ämter des Bundes und der
Länder*), plus population totals from the *Statistisches Bundesamt* census. It's public,
free, and updated once a year — no login or paid API involved.

## How it's built

It's a small, self-contained web app with **no backend** — just static files served from
a CDN, which is why it runs happily on GitHub Pages for free.

- **[MapLibre GL JS](https://maplibre.org/)** — the map rendering engine (WebGL, open-source).
- **d3-scale** for the colour ramp, **Fuse.js** for the name search.
- **Vite** for the dev server and production build.
- A couple of small scripts (`scripts/`) fetch the yearly data and bake it into the
  ready-to-serve files in `public/data/`. Since the numbers only change once a year,
  there's nothing to keep running.

## Run it yourself

```bash
npm install
npm run dev      # opens a local dev server
npm run build    # produces the static site in dist/
```

To refresh the data for a new year:

```bash
npm run fetch-data   # pull the latest figures from the Regionalatlas
npm run build-data   # rebuild the app-ready data files
```

## Good to know

- The official data only goes down to **district level** — there's no nationwide
  neighbourhood-by-neighbourhood breakdown. Going deeper (e.g. Berlin or Munich
  neighbourhoods) would mean pulling each city's own data separately.
- History goes back to **2011** — the earliest year today's district boundaries line up
  cleanly. A handful of districts that merged after that (e.g. Göttingen in 2016) show as
  "no data" for the years before their merger rather than a guessed value.

## Data credits

Statistische Ämter des Bundes und der Länder — *Regionalatlas Deutschland* (indicator
AI0208, foreign-national share) · Statistisches Bundesamt — *Gemeindeverzeichnis*
(population). Administrative boundaries generalised for web display.

#!/usr/bin/env bash
# Fetch raw source data for the Ausländerkarte.
#
# Boundaries + the real foreigner-share indicator (AI0208) come from the public,
# no-key Destatis "Regionalatlas" ArcGIS service. We ask it to return the map
# geometry joined with the indicator, already reprojected to WGS84 (outSR=4326)
# and generalised (maxAllowableOffset) so the files stay light for the web.
#
#   typ = 1  -> Bundesländer (16 states)
#   typ = 3  -> Kreise und kreisfreie Städte (~400 districts)
#   AI0208   -> Anteil der ausländischen Bevölkerung an der Gesamtbevölkerung (%)
#
# We also pull attribute-only history (no geometry — this indicator's shape
# never changes, just the value) for 2011-2023, for the time slider. 2011 is
# the earliest year district AGS codes line up with today's 400 districts;
# before that, several Kreisgebietsreformen renumbered/merged districts.
#
# Usage:  bash scripts/fetch-data.sh   (then: node scripts/build-data.mjs)
set -euo pipefail

YEAR=2024
HIST_YEARS=(2011 2012 2013 2014 2015 2016 2017 2018 2019 2020 2021 2022 2023)
URL="https://www.gis-idmz.nrw.de/arcgis/rest/services/stba/regionalatlas/MapServer/dynamicLayer/query"
OUT="$(dirname "$0")/../data/raw"
mkdir -p "$OUT" "$OUT/by-year"

fetch () {
  local typ="$1" year="$2" offset="$3" fields="$4" geom="$5" out="$6"
  local layer='{"source":{"dataSource":{"geometryType":"esriGeometryPolygon","workspaceId":"gdb","query":"SELECT * FROM verwaltungsgrenzen_gesamt LEFT OUTER JOIN ai002_1_5 ON ags = ags2 and jahr = jahr2 WHERE typ = '"$typ"' AND jahr = '"$year"' AND (jahr2 = '"$year"' OR jahr2 IS NULL)","oidFields":"id","spatialReference":{"wkid":25832},"type":"queryTable"},"type":"dataLayer"}}'
  local args=(-G "$URL" --data-urlencode "layer=$layer" --data-urlencode "f=geojson"
    --data-urlencode "outFields=$fields" --data-urlencode "returnGeometry=$geom"
    --data-urlencode "outSR=4326" --data-urlencode "where=1=1")
  if [ "$geom" = "true" ]; then
    args+=(--data-urlencode "maxAllowableOffset=$offset")
  fi
  curl -s "${args[@]}" -o "$out"
  echo "wrote $out"
}

fetch 1 "$YEAR" 0.008 "ags,gen,ai0208"      true "$OUT/states_geo.json"
fetch 3 "$YEAR" 0.004 "ags,gen,gen2,ai0208" true "$OUT/kreise_geo.json"

for y in "${HIST_YEARS[@]}"; do
  fetch 1 "$y" 0 "ags,ai0208" false "$OUT/by-year/states_${y}.json"
  fetch 3 "$y" 0 "ags,ai0208" false "$OUT/by-year/kreise_${y}.json"
done

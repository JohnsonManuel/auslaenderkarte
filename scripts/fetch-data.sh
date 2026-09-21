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
# Usage:  bash scripts/fetch-data.sh   (then: node scripts/build-data.mjs)
set -euo pipefail

YEAR=2023
URL="https://www.gis-idmz.nrw.de/arcgis/rest/services/stba/regionalatlas/MapServer/dynamicLayer/query"
OUT="$(dirname "$0")/../data/raw"
mkdir -p "$OUT"

fetch () {
  local typ="$1" offset="$2" fields="$3" out="$4"
  local layer='{"source":{"dataSource":{"geometryType":"esriGeometryPolygon","workspaceId":"gdb","query":"SELECT * FROM verwaltungsgrenzen_gesamt LEFT OUTER JOIN ai002_1_5 ON ags = ags2 and jahr = jahr2 WHERE typ = '"$typ"' AND jahr = '"$YEAR"' AND (jahr2 = '"$YEAR"' OR jahr2 IS NULL)","oidFields":"id","spatialReference":{"wkid":25832},"type":"queryTable"},"type":"dataLayer"}}'
  curl -s -G "$URL" \
    --data-urlencode "layer=$layer" \
    --data-urlencode "f=geojson" \
    --data-urlencode "outFields=$fields" \
    --data-urlencode "returnGeometry=true" \
    --data-urlencode "outSR=4326" \
    --data-urlencode "maxAllowableOffset=$offset" \
    --data-urlencode "where=1=1" \
    -o "$OUT/$out"
  echo "wrote $OUT/$out"
}

fetch 1 0.008 "ags,gen,ai0208"      states_geo.json
fetch 3 0.004 "ags,gen,gen2,ai0208" kreise_geo.json

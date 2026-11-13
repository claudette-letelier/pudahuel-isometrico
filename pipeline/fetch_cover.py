"""Baja usos de suelo de Pudahuel: CONAF 2019 (Región Metropolitana) y áreas verdes MINVU–INE 2023.

Quedan en data/raw/cl/. El armado de la escena los lee después.
"""

import json
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "raw" / "cl"
BBOX = "-70.98,-33.56,-70.68,-33.34"
CONAF = "https://esri.ciren.cl/server/rest/services/USOS_DE_LA_TIERRA__CONAF/MapServer/6/query"
MINVU = "https://geoide.minvu.cl/server/rest/services/Catastros/%C3%81reas_Verdes_MINVU_INE_2023/FeatureServer/0/query"


def query(url, params):
    data = urllib.parse.urlencode(params).encode()
    request = urllib.request.Request(url, data=data, headers={"User-Agent": "pudahuel-isometrica/1.0"})
    with urllib.request.urlopen(request, timeout=180) as response:
        return json.loads(response.read().decode("utf-8"))


def pages(url, where, bbox=None):
    features = []
    offset = 0
    while True:
        params = {
            "where": where,
            "outFields": "*",
            "returnGeometry": "true",
            "outSR": "4326",
            "f": "geojson",
            "resultOffset": offset,
            "resultRecordCount": 1000,
        }
        if bbox:
            params.update(
                geometry=bbox,
                geometryType="esriGeometryEnvelope",
                inSR="4326",
                spatialRel="esriSpatialRelIntersects",
            )
        page = query(url, params)
        if "error" in page:
            raise SystemExit(page["error"])
        batch = page.get("features") or []
        features.extend(batch)
        print(f"  {len(features)}")
        more = page.get("exceededTransferLimit") or (page.get("properties") or {}).get("exceededTransferLimit")
        if not batch or (not more and len(batch) < 1000):
            break
        offset += len(batch)
    return {"type": "FeatureCollection", "features": features}


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    print("MINVU")
    minvu = pages(MINVU, "CUT=13124")
    (OUT / "minvu_pudahuel.geojson").write_text(json.dumps(minvu), encoding="utf-8")
    print("listo", len(minvu["features"]))


if __name__ == "__main__":
    main()

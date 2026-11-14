"""Invernaderos, potreros y canteras de OpenStreetMap dentro de Pudahuel."""

import json
import urllib.request
from pathlib import Path

OUT = Path(__file__).resolve().parents[1] / "data" / "raw" / "rural.json"
QUERY = """
[out:json][timeout:120];
area(3600168269)->.a;
(
  way["building"="greenhouse"](area.a);
  way["landuse"="greenhouse"](area.a);
  way["landuse"="farmland"](area.a);
  way["landuse"="orchard"](area.a);
  way["landuse"="vineyard"](area.a);
  way["landuse"="quarry"](area.a);
);
out geom;
"""


def main():
    body = "data=" + urllib.request.quote(QUERY)
    request = urllib.request.Request(
        "https://overpass.openstreetmap.fr/api/interpreter",
        data=body.encode(),
        headers={"User-Agent": "pudahuel-isometrica/1.0"},
    )
    with urllib.request.urlopen(request, timeout=180) as response:
        payload = json.loads(response.read().decode("utf-8"))
    OUT.write_text(json.dumps(payload), encoding="utf-8")
    print(len(payload.get("elements", [])), "elementos")


if __name__ == "__main__":
    main()

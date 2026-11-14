"""Huellas de Microsoft Global ML Building Footprints dentro de la caja de Pudahuel.

La lista pública de teselas está en dataset-links.csv. Se bajan solo las que
cubren la comuna y se guardan los polígonos de esa caja.
"""

import csv
import gzip
import io
import json
import math
import urllib.request
from pathlib import Path

OUT = Path(__file__).resolve().parents[1] / "data" / "raw" / "ms-pudahuel.jsonl"
LINKS = "https://minedbuildings.z5.web.core.windows.net/global-buildings/dataset-links.csv"
WEST, SOUTH, EAST, NORTH = -71.02, -33.58, -70.66, -33.32


def quadkey(lat: float, lon: float, level: int = 9) -> str:
    n = 2 ** level
    x = int((lon + 180.0) / 360.0 * n)
    lat_rad = math.radians(lat)
    y = int((1.0 - math.asinh(math.tan(lat_rad)) / math.pi) / 2.0 * n)
    key = []
    for i in range(level, 0, -1):
        mask = 1 << (i - 1)
        digit = (1 if x & mask else 0) + (2 if y & mask else 0)
        key.append(str(digit))
    return "".join(key)


def links_for_pudahuel() -> list[str]:
    wanted = set()
    lat = SOUTH
    while lat <= NORTH:
        lon = WEST
        while lon <= EAST:
            wanted.add(quadkey(lat, lon))
            lon += 0.08
        lat += 0.06
    print("quadkeys", sorted(wanted))
    request = urllib.request.Request(LINKS, headers={"User-Agent": "pudahuel-isometrica/1.0"})
    with urllib.request.urlopen(request, timeout=120) as response:
        text = response.read().decode("utf-8", errors="replace")
    urls = []
    for row in csv.DictReader(io.StringIO(text)):
        key = row.get("QuadKey") or row.get("quadkey") or ""
        location = (row.get("Location") or row.get("location") or "").lower()
        url = row.get("Url") or row.get("url") or ""
        if key in wanted and ("chile" in location or location == "" or "chile" in url.lower()):
            urls.append(url)
            print("tesela", key, location, url[:80])
    if not urls:
        for row in csv.DictReader(io.StringIO(text)):
            key = row.get("QuadKey") or ""
            if key in wanted:
                urls.append(row.get("Url") or "")
                print("tesela sin pais", key)
    return [url for url in urls if url]


def keep(feature: dict) -> bool:
    geometry = feature.get("geometry") or {}
    coords = geometry.get("coordinates") or []
    ring = coords[0] if geometry.get("type") == "Polygon" else coords[0][0] if coords else []
    if len(ring) < 4:
        return False
    lon = sum(point[0] for point in ring) / len(ring)
    lat = sum(point[1] for point in ring) / len(ring)
    return WEST <= lon <= EAST and SOUTH <= lat <= NORTH


def main() -> None:
    urls = links_for_pudahuel()
    if not urls:
        raise SystemExit("no hay teselas para Pudahuel")
    OUT.parent.mkdir(parents=True, exist_ok=True)
    kept = 0
    with OUT.open("w", encoding="utf-8") as handle:
        for url in urls:
            print("bajando", url[:100])
            request = urllib.request.Request(url, headers={"User-Agent": "pudahuel-isometrica/1.0"})
            with urllib.request.urlopen(request, timeout=300) as response:
                raw = response.read()
            stream = gzip.GzipFile(fileobj=io.BytesIO(raw)) if url.endswith(".gz") or raw[:2] == b"\x1f\x8b" else io.BytesIO(raw)
            for line in io.TextIOWrapper(stream, encoding="utf-8"):
                if not line.strip():
                    continue
                feature = json.loads(line)
                if not keep(feature):
                    continue
                handle.write(line if line.endswith("\n") else line + "\n")
                kept += 1
            print("  van", kept)
    print("guardadas", kept)


if __name__ == "__main__":
    main()

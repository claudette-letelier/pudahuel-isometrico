"""Arma data/scene.json con las mismas fuentes que Talca Isométrica.

- Manzanas del Censo 2017 (INE), comuna 13124, vía jiboncom/chile_geojson.
- Calles, parques, agua y huellas de OpenStreetMap ya bajadas a data/raw.
- Relieve SRTM 1" (tesela S34W071) de los Terrain Tiles de AWS, con la misma
  apertura de 100 m y el mismo suavizado que pipeline/elevation.py de Talca.
- Donde el censo muestra viviendas y OSM no tiene el edificio, se genera una
  fila de casas frente a la calle. La altura crece con las viviendas por hectárea.

Origen de la grilla: la Plaza de Armas de Pudahuel. x al este, y al norte.
"""

from __future__ import annotations

import array
import gzip
import json
import math
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw"
OUT = ROOT / "data" / "scene.json"

LAT0, LON0 = -33.437064, -70.751544
KX = 111320 * math.cos(math.radians(-LAT0))
KY = 110950
COMUNA = "13124"
STEP = 40
FINE = 20


def loc(lon: float, lat: float) -> tuple[float, float]:
    return ((lon - LON0) * KX, (lat - LAT0) * KY)


def unloc(x: float, y: float) -> tuple[float, float]:
    return (LAT0 + y / KY, LON0 + x / KX)


def shoelace(points: list[tuple[float, float]]) -> float:
    area = 0.0
    for i, (x1, y1) in enumerate(points):
        x2, y2 = points[(i + 1) % len(points)]
        area += x1 * y2 - x2 * y1
    return area * 0.5


def douglas(points: list[tuple[float, float]], epsilon: float) -> list[tuple[float, float]]:
    if len(points) < 3:
        return points
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        a, b = stack.pop()
        ax, ay = points[a]
        bx, by = points[b]
        dx, dy = bx - ax, by - ay
        length = math.hypot(dx, dy) or 1.0
        worst = 0.0
        split = None
        for i in range(a + 1, b):
            px, py = points[i]
            dist = abs(dy * px - dx * py + bx * ay - by * ax) / length
            if dist > worst:
                worst = dist
                split = i
        if split is not None and worst > epsilon:
            keep[split] = True
            stack.append((a, split))
            stack.append((split, b))
    return [point for point, flag in zip(points, keep) if flag]


def clean(points: list[tuple[float, float]], epsilon: float, limit: int) -> list[list[int]] | None:
    if len(points) > 2 and points[0] == points[-1]:
        points = points[:-1]
    if len(points) < 3:
        return None
    simplified = douglas(points, epsilon)
    if len(simplified) > limit:
        step = len(simplified) / limit
        simplified = [simplified[int(i * step)] for i in range(limit)]
    if len(simplified) < 3:
        return None
    if shoelace(simplified) < 0:
        simplified = list(reversed(simplified))
    return [[round(x), round(y)] for x, y in simplified]


def inside(x: float, y: float, ring: list[list[int]]) -> bool:
    hit = False
    j = len(ring) - 1
    for i, (xi, yi) in enumerate(ring):
        xj, yj = ring[j]
        if (yi > y) != (yj > y):
            cross = (xj - xi) * (y - yi) / ((yj - yi) or 1e-9) + xi
            if x < cross:
                hit = not hit
        j = i
    return hit


def centroid(ring: list[list[int]]) -> tuple[float, float]:
    return (
        sum(p[0] for p in ring) / len(ring),
        sum(p[1] for p in ring) / len(ring),
    )


def ring_of(geometry: dict) -> list[list[tuple[float, float]]]:
    kind = geometry.get("type")
    coords = geometry.get("coordinates") or []
    if kind == "Polygon":
        return [[(lon, lat) for lon, lat in coords[0]]] if coords else []
    if kind == "MultiPolygon":
        return [[(lon, lat) for lon, lat in poly[0]] for poly in coords if poly]
    return []


def load_blocks(path: Path, kind: str, commune: list[list[int]]) -> list[dict]:
    if not path.exists():
        print(f"sin {path.name}")
        return []
    print(f"leyendo {path.name}")
    data = json.loads(path.read_text(encoding="utf-8"))
    out = []
    for feature in data.get("features", []):
        props = feature.get("properties") or {}
        code = str(props.get("COMUNA") or props.get("comuna") or "")
        if code != COMUNA:
            continue
        for ring in ring_of(feature.get("geometry") or {}):
            projected = [loc(lon, lat) for lon, lat in ring]
            cleaned = clean(projected, 2.5, 24)
            if not cleaned:
                continue
            area = abs(shoelace([(p[0], p[1]) for p in cleaned]))
            if area < 80 or (kind == "empty" and area > 80000):
                continue
            cx, cy = centroid(cleaned)
            if not inside(cx, cy, commune):
                continue
            out.append({
                "p": cleaned,
                "viv": int(float(props.get("TOTAL_VIVI") or props.get("TOTAL_VIV") or 0)),
                "pers": int(float(props.get("TOTAL_PERS") or props.get("PERSONAS") or 0)),
                "kind": kind,
                "area": area,
            })
    print(f"  {len(out)} manzanas {kind}")
    return out


def boundary_ring() -> list[list[int]]:
    data = json.loads((RAW / "boundary.json").read_text(encoding="utf-8"))
    element = data["elements"][0]
    parts = []
    for member in element.get("members", []):
        geometry = member.get("geometry")
        if member.get("role") == "outer" and geometry:
            parts.append([(point["lon"], point["lat"]) for point in geometry])
    ring = parts.pop(0)
    guard = 0
    while parts and guard < 10000:
        guard += 1
        for index, part in enumerate(parts):
            if abs(part[0][0] - ring[-1][0]) < 1e-5 and abs(part[0][1] - ring[-1][1]) < 1e-5:
                ring.extend(part[1:])
                parts.pop(index)
                break
            if abs(part[-1][0] - ring[-1][0]) < 1e-5 and abs(part[-1][1] - ring[-1][1]) < 1e-5:
                ring.extend(reversed(part[:-1]))
                parts.pop(index)
                break
        else:
            break
    projected = [loc(lon, lat) for lon, lat in ring]
    cleaned = clean(projected, 12, 900)
    if not cleaned:
        raise SystemExit("no pude armar el límite")
    return cleaned


def load_hgt() -> tuple[array.array, int]:
    path = RAW / "dem" / "S34W071.hgt.gz"
    if not path.exists():
        raise SystemExit(f"falta {path}")
    raw = gzip.open(path, "rb").read()
    values = array.array("h")
    values.frombytes(raw)
    if sys.byteorder == "little":
        values.byteswap()
    side = int(math.isqrt(len(values)))
    return values, side


def hgt_at(values: array.array, side: int, lat: float, lon: float) -> float:
    fx = (lon - (-71)) * (side - 1)
    fy = ((-33) - lat) * (side - 1)
    if fx < 0 or fy < 0 or fx > side - 1 or fy > side - 1:
        return 0.0
    x0, y0 = int(fx), int(fy)
    x1, y1 = min(x0 + 1, side - 1), min(y0 + 1, side - 1)
    tx, ty = fx - x0, fy - y0

    def sample(ix: int, iy: int) -> float:
        value = values[iy * side + ix]
        return 0.0 if value < -1000 else float(value)

    return (
        sample(x0, y0) * (1 - tx) * (1 - ty)
        + sample(x1, y0) * tx * (1 - ty)
        + sample(x0, y1) * (1 - tx) * ty
        + sample(x1, y1) * tx * ty
    )


def elevation(commune: list[list[int]]) -> dict:
    values, side = load_hgt()
    xs = [p[0] for p in commune]
    ys = [p[1] for p in commune]
    x0 = math.floor((min(xs) - 240) / STEP) * STEP
    y0 = math.floor((min(ys) - 240) / STEP) * STEP
    x1 = math.ceil((max(xs) + 240) / STEP) * STEP
    y1 = math.ceil((max(ys) + 240) / STEP) * STEP
    fnx = int((x1 - x0) / FINE) + 1
    fny = int((y1 - y0) / FINE) + 1
    print(f"relieve {fnx}×{fny} a {FINE} m")
    print("muestreando el SRTM")
    fine = []
    for j in range(fny):
        yy = y0 + j * FINE
        fine.append([hgt_at(values, side, *unloc(x0 + i * FINE, yy)) for i in range(fnx)])
        if j % 200 == 0:
            print(f"  fila {j}/{fny}")

    def filt1d(row, radius, fn):
        n = len(row)
        return [fn(row[max(0, i - radius) : min(n, i + radius + 1)]) for i in range(n)]

    def separable(grid, row_fn):
        grid = [row_fn(row) for row in grid]
        cols = [row_fn([grid[j][i] for j in range(len(grid))]) for i in range(len(grid[0]))]
        return [[cols[i][j] for i in range(len(cols))] for j in range(len(grid))]

    print("abriendo el modelo de superficie")
    opened = separable(fine, lambda row: filt1d(row, 2, min))
    opened = separable(opened, lambda row: filt1d(row, 2, max))
    sigma = 1.5
    rad = int(3 * sigma)
    weights = [math.exp(-k * k / (2 * sigma * sigma)) for k in range(-rad, rad + 1)]

    def gauss(row):
        n = len(row)
        out = []
        for i in range(n):
            acc = ws = 0.0
            for k, weight in enumerate(weights):
                xx = min(n - 1, max(0, i + k - rad))
                acc += row[xx] * weight
                ws += weight
            out.append(acc / ws)
        return out

    print("suavizando")
    smooth = separable(opened, gauss)
    nx = int((x1 - x0) / STEP) + 1
    ny = int((y1 - y0) / STEP) + 1
    plaza = hgt_at(values, side, LAT0, LON0)
    heights = []
    previous = 0
    for j in range(ny):
        for i in range(nx):
            fx = (i * STEP) / FINE
            fy = (j * STEP) / FINE
            ix, iy = int(round(fx)), int(round(fy))
            ix = min(fnx - 1, max(0, ix))
            iy = min(fny - 1, max(0, iy))
            relative = round((smooth[iy][ix] - plaza) * 10)
            heights.append(relative - previous)
            previous = relative
    return {"o": [x0, y0], "s": STEP, "n": [nx, ny], "z0": round(plaza, 1), "h": heights}


def osm_lines(name: str) -> list[dict]:
    path = RAW / name
    if not path.exists():
        return []
    return json.loads(path.read_text(encoding="utf-8")).get("elements", [])


def street_class(kind: str) -> int:
    kind = kind.replace("_link", "")
    return {
        "motorway": 0,
        "trunk": 1,
        "primary": 2,
        "secondary": 3,
        "tertiary": 4,
        "residential": 5,
        "living_street": 6,
        "pedestrian": 6,
    }.get(kind, 7)


def building_height(tags: dict, area: float) -> float:
    raw = tags.get("height") or tags.get("building:height")
    if raw:
        try:
            value = float(str(raw).lower().replace("m", "").split(";")[0])
            if 2 < value < 160:
                return value
        except ValueError:
            pass
    levels = tags.get("building:levels")
    if levels:
        try:
            return max(3.0, float(str(levels).split(";")[0]) * 3.0)
        except ValueError:
            pass
    kind = tags.get("building", "yes")
    if kind in {"apartments", "residential"} and area > 500:
        return 18 if area > 1200 else 12
    if kind in {"commercial", "retail", "office", "industrial", "warehouse", "hangar"}:
        return 10
    if kind in {"church", "cathedral", "chapel"}:
        return 14
    if area > 2500:
        return 9
    return 4.5


def cover_kind_osm(tags: dict) -> str | None:
    land = tags.get("landuse") or ""
    natural = tags.get("natural") or ""
    if land in {"farmland", "farmyard"}:
        return "farm"
    if land in {"meadow", "grassland"}:
        return "meadow"
    if land == "forest" or natural == "wood":
        return "forest"
    if land == "scrub" or natural == "scrub":
        return "scrub"
    if land in {"orchard", "vineyard", "allotments"}:
        return "orchard"
    return None


def cover_kind_conaf(props: dict) -> str | None:
    text = " ".join(str(props.get(key) or "") for key in ("subuso", "uso", "uso_tierra")).lower()
    if any(word in text for word in ("urban", "ciudad", "industrial", "miner")):
        return None
    if "bosque" in text or "plantaci" in text:
        return "forest"
    if "matorral" in text:
        return "scrub"
    if any(word in text for word in ("frutal", "huerto", "viña", "vina", "parronal")):
        return "orchard"
    if "pradera" in text and "cultivo" not in text and "agric" not in text:
        return "meadow"
    if any(word in text for word in ("agric", "cultivo", "rotaci")):
        return "farm"
    if any(word in text for word in ("agua", "rio", "río", "humedal", "lago", "embalse")):
        return "water"
    return None


def load_cover(path: Path, commune: list[list[int]], kind_of) -> list[dict]:
    if not path.exists():
        print(f"sin {path.name}")
        return []
    data = json.loads(path.read_text(encoding="utf-8"))
    out = []
    for feature in data.get("features", []):
        props = feature.get("properties") or {}
        kind = kind_of(props)
        if not kind:
            continue
        geometry = feature.get("geometry") or {}
        for ring in ring_of(geometry):
            cleaned = clean([loc(lon, lat) for lon, lat in ring], 14, 48)
            if not cleaned:
                continue
            area = abs(shoelace([(p[0], p[1]) for p in cleaned]))
            if area < 800 or not inside(*centroid(cleaned), commune):
                continue
            out.append({"k": kind, "p": cleaned, "area": area})
    print(f"  {path.name}: {len(out)}")
    return out


def scatter_trees(polys: list[dict], parks: list[list[list[int]]], blocks: list[dict], limit: int = 12000) -> list[list]:
    urban: dict[tuple[int, int], list] = {}
    for block in blocks:
        if block["kind"] != "data":
            continue
        ring = block["p"]
        xs = [p[0] for p in ring]
        ys = [p[1] for p in ring]
        for ix in range(int(min(xs) // 80), int(max(xs) // 80) + 1):
            for iy in range(int(min(ys) // 80), int(max(ys) // 80) + 1):
                urban.setdefault((ix, iy), []).append(ring)

    def in_city(x: float, y: float) -> bool:
        for ring in urban.get((int(x // 80), int(y // 80)), ()):
            if inside(x, y, ring):
                return True
        return False

    trees = []
    step_of = {"forest": 34, "scrub": 52, "orchard": 16, "park": 22}
    code = {"forest": 0, "scrub": 1, "orchard": 2, "park": 3}

    def add(ring, kind, area):
        step = step_of[kind]
        if kind == "park" and area > 120000:
            step = 40
        xs = [p[0] for p in ring]
        ys = [p[1] for p in ring]
        x = min(xs) + step / 2
        while x < max(xs) and len(trees) < limit:
            y = min(ys) + (step / 2 if int(x / step) % 2 == 0 else step)
            while y < max(ys) and len(trees) < limit:
                if inside(x, y, ring) and not (kind in {"forest", "scrub"} and in_city(x, y)):
                    trees.append([round(x), round(y), code[kind]])
                y += step
            x += step

    for ring in parks:
        if len(trees) >= limit:
            break
        area = abs(shoelace([(p[0], p[1]) for p in ring]))
        if 400 < area < 200000:
            add(ring, "park", area)
    for kind in ("orchard", "forest", "scrub"):
        for item in polys:
            if item["k"] != kind or len(trees) >= limit:
                continue
            add(item["p"], kind, item.get("area") or 0)
    print(f"arboles: {len(trees)}")
    return trees


def generate_houses(blocks: list[dict], occupied: list[tuple[float, float]]) -> list[dict]:
    buckets: dict[tuple[int, int], list[tuple[float, float]]] = {}
    for x, y in occupied:
        buckets.setdefault((int(x // 40), int(y // 40)), []).append((x, y))

    def near(x: float, y: float) -> bool:
        ix, iy = int(x // 40), int(y // 40)
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for px, py in buckets.get((ix + dx, iy + dy), ()):
                    if (px - x) ** 2 + (py - y) ** 2 < 14 * 14:
                        return True
        return False

    houses = []
    for block in blocks:
        if block["kind"] != "data" or block["viv"] < 4 or block["area"] > 80000:
            continue
        dens = block["viv"] / max(block["area"] / 10000, 0.05)
        floors = 1 if dens < 35 else 2 if dens < 80 else 4 if dens < 150 else 6
        height = floors * 3.2
        ring = block["p"]
        placed = 0
        limit = 6 if dens < 50 else 12
        for index, (x1, y1) in enumerate(ring):
            if placed >= limit:
                break
            x2, y2 = ring[(index + 1) % len(ring)]
            length = math.hypot(x2 - x1, y2 - y1)
            if length < 22:
                continue
            angle = math.atan2(y2 - y1, x2 - x1)
            inward = (-math.sin(angle), math.cos(angle))
            cursor = 8.0
            while cursor + 8 < length - 4 and placed < limit:
                px = x1 + (x2 - x1) * (cursor / length) + inward[0] * 8
                py = y1 + (y2 - y1) * (cursor / length) + inward[1] * 8
                if inside(px, py, ring) and not near(px, py):
                    houses.append({
                        "c": [round(px, 1), round(py, 1)],
                        "a": round(angle, 3),
                        "w": 8,
                        "d": 9,
                        "h": height,
                        "r": (len(houses) // 3) % 3,
                    })
                    placed += 1
                cursor += 12
    print(f"casas generadas: {len(houses)}")
    return houses


def main() -> None:
    commune = boundary_ring()
    blocks = load_blocks(RAW / "census" / "R13_MANZANA_IND_C17.shp.geojson", "data", commune)
    blocks += load_blocks(RAW / "census" / "R13_MANZANA_SIN_INF_C17.shp.geojson", "empty", commune)
    relief = elevation(commune)

    streets = []
    for element in osm_lines("highways.json"):
        tags = element.get("tags") or {}
        kind = tags.get("highway", "")
        coords = [loc(point["lon"], point["lat"]) for point in element.get("geometry", [])]
        simplified = douglas(coords, 6)
        if len(simplified) < 2:
            continue
        mid = simplified[len(simplified) // 2]
        if not inside(mid[0], mid[1], commune):
            continue
        item = {"k": street_class(kind), "p": [[round(x), round(y)] for x, y in simplified]}
        if tags.get("name") and item["k"] <= 3:
            item["n"] = tags["name"]
        streets.append(item)

    buildings = []
    occupied = []
    for element in osm_lines("buildings.json"):
        geometry = element.get("geometry")
        if not geometry:
            continue
        projected = [loc(point["lon"], point["lat"]) for point in geometry]
        cleaned = clean(projected, 2.0, 12)
        if not cleaned:
            continue
        area = abs(shoelace([(p[0], p[1]) for p in cleaned]))
        if area < 28:
            continue
        cx, cy = centroid(cleaned)
        if not inside(cx, cy, commune):
            continue
        tags = element.get("tags") or {}
        buildings.append({
            "p": cleaned,
            "h": round(building_height(tags, area), 1),
            "r": 2 if tags.get("building") in {"apartments", "commercial", "office", "industrial"} else element["id"] % 3,
        })
        occupied.append((cx, cy))

    parks, water, airport, rails, waterways, runways, cover = [], [], [], [], [], [], []

    def closed(points: list[tuple[float, float]]) -> bool:
        return len(points) > 3 and abs(points[0][0] - points[-1][0]) < 3 and abs(points[0][1] - points[-1][1]) < 3

    for element in osm_lines("land.json"):
        tags = element.get("tags") or {}
        lines = []
        if element["type"] == "way" and element.get("geometry"):
            lines = [element["geometry"]]
        else:
            for member in element.get("members", []):
                if member.get("geometry") and member.get("role") != "inner":
                    lines.append(member["geometry"])
        for line in lines:
            projected = [loc(point["lon"], point["lat"]) for point in line]
            if tags.get("railway"):
                simplified = douglas(projected, 12)
                if len(simplified) >= 2:
                    rails.append([[round(x), round(y)] for x, y in simplified])
                continue
            if tags.get("waterway") or tags.get("aeroway") in {"runway", "taxiway"}:
                simplified = douglas(projected, 8)
                if len(simplified) < 2:
                    continue
                target = waterways if tags.get("waterway") else runways
                target.append([[round(x), round(y)] for x, y in simplified])
                continue
            if not closed(projected):
                continue
            cleaned = clean(projected, 8, 40)
            if not cleaned or abs(shoelace([(p[0], p[1]) for p in cleaned])) < 400:
                continue
            if not inside(*centroid(cleaned), commune):
                continue
            if tags.get("natural") == "water":
                water.append(cleaned)
            elif tags.get("aeroway"):
                airport.append(cleaned)
            kind = cover_kind_osm(tags)
            if kind in {"forest", "scrub", "farm", "meadow", "orchard"}:
                cover.append({
                    "k": kind,
                    "p": cleaned,
                    "area": abs(shoelace([(p[0], p[1]) for p in cleaned])),
                })
            elif tags.get("leisure") or tags.get("landuse") in {"grass", "recreation_ground", "cemetery", "village_green"}:
                parks.append(cleaned)

    for item in load_cover(RAW / "cl" / "conaf_pudahuel.geojson", commune, cover_kind_conaf):
        if item["k"] == "water":
            water.append(item["p"])
        else:
            cover.append(item)
    for item in load_cover(RAW / "cl" / "minvu_pudahuel.geojson", commune, lambda _props: "park"):
        parks.append(item["p"])
    trees = scatter_trees(cover, parks, blocks)
    houses = generate_houses(blocks, occupied)
    scene = {
        "origin": [LON0, LAT0],
        "meta": {
            "buildings": len(buildings) + len(houses),
            "osm": len(buildings),
            "houses": len(houses),
            "blocks": len(blocks),
            "cover": len(cover),
            "trees": len(trees),
            "z0": relief["z0"],
        },
        "boundary": commune,
        "blocks": [{"p": b["p"], "k": b["kind"]} for b in blocks],
        "streets": streets,
        "buildings": buildings,
        "houses": houses,
        "cover": [{"k": item["k"], "p": item["p"]} for item in cover],
        "trees": trees,
        "parks": parks,
        "water": water,
        "waterways": waterways,
        "airport": airport,
        "runways": runways,
        "rails": rails,
        "elevation": relief,
    }
    OUT.write_text(json.dumps(scene, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"escena {OUT.stat().st_size / 1_048_576:.1f} MB, plaza a {relief['z0']} m")


if __name__ == "__main__":
    main()

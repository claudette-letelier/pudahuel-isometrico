"""Arma data/city.json y data/places.json desde OpenStreetMap.

Las calles, parques, agua, aeropuerto y huellas de edificios salen de
Overpass. Las fichas cívicas combinan esas coordenadas con direcciones
publicadas por la municipalidad, el Servicio de Registro Civil y el
directorio de notarías. Las alturas que OSM no trae se estiman.
"""

from __future__ import annotations

import json
import math
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw"
OUT_CITY = ROOT / "data" / "city.json"
OUT_PLACES = ROOT / "data" / "places.json"

USER_AGENT = "pudahuel-isometrico/1.0 (mapa estatico educativo)"
OVERPASS_URLS = [
    "https://overpass.openstreetmap.fr/api/interpreter",
    "https://overpass-api.de/api/interpreter",
]
M_LAT = 110540.0


def http_json(url: str, data: bytes | None = None, timeout: int = 180) -> dict:
    req = urllib.request.Request(
        url,
        data=data,
        headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def overpass(query: str) -> dict:
    payload = urllib.parse.urlencode({"data": query}).encode()
    last_error: Exception | None = None
    for url in OVERPASS_URLS:
        try:
            print(f"overpass {url.split('/')[2]} …")
            return http_json(url, payload, timeout=240)
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
            last_error = error
            print(f"  fallo: {error}")
    raise SystemExit(f"Overpass no respondió: {last_error}")


def geocode(query: str) -> tuple[float, float] | None:
    url = "https://nominatim.openstreetmap.org/search?" + urllib.parse.urlencode(
        {
            "q": query,
            "format": "jsonv2",
            "limit": 1,
            "countrycodes": "cl",
        }
    )
    time.sleep(1.1)
    try:
        rows = http_json(url, timeout=40)
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
        print(f"  geocode falló ({query}): {error}")
        return None
    if not rows:
        print(f"  sin resultado: {query}")
        return None
    return float(rows[0]["lon"]), float(rows[0]["lat"])


def ring_geometry(element: dict) -> list[list[list[float]]]:
    rings: list[list[list[float]]] = []
    if element["type"] == "way" and "geometry" in element:
        rings.append([[point["lon"], point["lat"]] for point in element["geometry"]])
        return rings
    if element["type"] != "relation":
        return rings
    outers: list[list[tuple[float, float]]] = []
    inners: list[list[tuple[float, float]]] = []
    for member in element.get("members", []):
        geometry = member.get("geometry")
        if not geometry:
            continue
        line = [(point["lon"], point["lat"]) for point in geometry]
        role = member.get("role") or "outer"
        (inners if role == "inner" else outers).append(line)
    for line in stitch(outers) + stitch(inners):
        rings.append([[lon, lat] for lon, lat in line])
    return rings


def stitch(parts: list[list[tuple[float, float]]]) -> list[list[tuple[float, float]]]:
    pending = [part[:] for part in parts if len(part) > 1]
    rings: list[list[tuple[float, float]]] = []
    while pending:
        ring = pending.pop(0)
        changed = True
        while changed:
            changed = False
            for index, part in enumerate(pending):
                if almost(ring[-1], part[0]):
                    ring.extend(part[1:])
                elif almost(ring[-1], part[-1]):
                    ring.extend(reversed(part[:-1]))
                elif almost(ring[0], part[-1]):
                    ring = part[:-1] + ring
                elif almost(ring[0], part[0]):
                    ring = list(reversed(part[1:])) + ring
                else:
                    continue
                pending.pop(index)
                changed = True
                break
        rings.append(ring)
    return rings


def almost(a: tuple[float, float], b: tuple[float, float]) -> bool:
    return abs(a[0] - b[0]) < 1e-5 and abs(a[1] - b[1]) < 1e-5


def project(lon: float, lat: float, origin: tuple[float, float], m_lon: float) -> tuple[int, int]:
    x = round((lon - origin[0]) * m_lon)
    y = round((lat - origin[1]) * M_LAT)
    return x, y


def shoelace(points: list[tuple[int, int]]) -> float:
    area = 0.0
    for index, (x1, y1) in enumerate(points):
        x2, y2 = points[(index + 1) % len(points)]
        area += x1 * y2 - x2 * y1
    return abs(area) * 0.5


def douglas(points: list[tuple[int, int]], epsilon: float) -> list[tuple[int, int]]:
    if len(points) < 3:
        return points
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        start_i, end_i = stack.pop()
        start, end = points[start_i], points[end_i]
        dx, dy = end[0] - start[0], end[1] - start[1]
        length = math.hypot(dx, dy) or 1.0
        worst = 0.0
        split = None
        for index in range(start_i + 1, end_i):
            px, py = points[index]
            distance = abs(dy * px - dx * py + end[0] * start[1] - end[1] * start[0]) / length
            if distance > worst:
                worst = distance
                split = index
        if split is not None and worst > epsilon:
            keep[split] = True
            stack.append((start_i, split))
            stack.append((split, end_i))
    return [point for point, flagged in zip(points, keep) if flagged]


def clean_ring(points: list[tuple[int, int]], epsilon: float, limit: int) -> list[list[int]] | None:
    if len(points) > 2 and points[0] == points[-1]:
        points = points[:-1]
    if len(points) < 3:
        return None
    simplified = douglas(points, epsilon)
    if len(simplified) < 3:
        return None
    if len(simplified) > limit:
        step = len(simplified) / limit
        simplified = [simplified[int(i * step)] for i in range(limit)]
    return [[x, y] for x, y in simplified]


def point_in_ring(x: float, y: float, ring: list[list[int]]) -> bool:
    inside = False
    j = len(ring) - 1
    for i, (xi, yi) in enumerate(ring):
        xj, yj = ring[j]
        if (yi > y) != (yj > y):
            cross = (xj - xi) * (y - yi) / ((yj - yi) or 1e-9) + xi
            if x < cross:
                inside = not inside
        j = i
    return inside


def inside_commune(x: float, y: float, outers: list[list[list[int]]], inners: list[list[list[int]]]) -> bool:
    if not any(point_in_ring(x, y, ring) for ring in outers):
        return False
    return not any(point_in_ring(x, y, ring) for ring in inners)


def centroid(ring: list[list[int]]) -> tuple[float, float]:
    return (
        sum(point[0] for point in ring) / len(ring),
        sum(point[1] for point in ring) / len(ring),
    )


def height_of(tags: dict, area: float, element_id: int) -> float:
    raw = tags.get("height") or tags.get("building:height")
    if raw:
        try:
            value = float(str(raw).lower().replace("m", "").split(";")[0].strip())
            if 2 < value < 160:
                return round(value, 1)
        except ValueError:
            pass
    levels = tags.get("building:levels")
    if levels:
        try:
            return round(max(3.0, float(str(levels).split(";")[0]) * 3.0), 1)
        except ValueError:
            pass
    kind = tags.get("building", "yes")
    if kind in {"apartments", "residential"} and area > 500:
        return 18 if area > 1200 else 12
    if kind in {"commercial", "retail", "office", "hotel"}:
        return 10
    if kind in {"industrial", "warehouse", "hangar"}:
        return 11
    if kind in {"church", "cathedral", "chapel"}:
        return 14
    if kind in {"school", "university", "hospital", "civic", "public"}:
        return 9
    if area > 4000:
        return 12
    if area > 900:
        return 7
    return 4.2 + (element_id % 3) * 0.6


def roof_of(tags: dict, element_id: int) -> int:
    kind = tags.get("building", "yes")
    if kind in {"apartments", "commercial", "retail", "office", "industrial", "warehouse", "hangar"}:
        return 2
    if kind in {"church", "cathedral", "chapel", "civic", "public"}:
        return 3
    return element_id % 3


def load_buildings(area_id: int, boundary_data: dict) -> dict:
    path = RAW / "buildings.json"
    if path.exists():
        print("cache buildings.json")
        return json.loads(path.read_text(encoding="utf-8"))
    try:
        data = overpass(
            f"""
            [out:json][timeout:240];
            area({area_id})->.a;
            way["building"](area.a);
            out geom;
            """
        )
    except SystemExit:
        print("la comuna completa agotó el tiempo; pido los edificios por cuadrantes")
        points = [
            point
            for element in boundary_data["elements"]
            for member in element.get("members", [])
            for point in member.get("geometry", [])
        ]
        lons = [point["lon"] for point in points]
        lats = [point["lat"] for point in points]
        mid_lon = (min(lons) + max(lons)) / 2
        mid_lat = (min(lats) + max(lats)) / 2
        boxes = [
            (min(lons), min(lats), mid_lon, mid_lat),
            (mid_lon, min(lats), max(lons), mid_lat),
            (min(lons), mid_lat, mid_lon, max(lats)),
            (mid_lon, mid_lat, max(lons), max(lats)),
        ]
        elements = []
        seen = set()
        for south_west in boxes:
            min_lon, min_lat, max_lon, max_lat = south_west
            tile = overpass(
                f"""
                [out:json][timeout:180];
                way["building"]({min_lat},{min_lon},{max_lat},{max_lon});
                out geom;
                """
            )
            for element in tile.get("elements", []):
                if element["id"] in seen:
                    continue
                seen.add(element["id"])
                elements.append(element)
        data = {"elements": elements}
    path.write_text(json.dumps(data), encoding="utf-8")
    return data


def load_or_fetch(name: str, query: str) -> dict:
    path = RAW / name
    if path.exists():
        print(f"cache {name}")
        return json.loads(path.read_text(encoding="utf-8"))
    data = overpass(query)
    path.write_text(json.dumps(data), encoding="utf-8")
    return data


def main() -> None:
    RAW.mkdir(parents=True, exist_ok=True)
    found = overpass(
        """
        [out:json][timeout:60];
        rel["name"="Pudahuel"]["boundary"="administrative"]["admin_level"="8"];
        out tags;
        """
    )
    relations = [
        element
        for element in found.get("elements", [])
        if "Santiago" in json.dumps(element.get("tags", {}), ensure_ascii=False)
        or element.get("tags", {}).get("wikidata")
        or "Chile" in json.dumps(element.get("tags", {}), ensure_ascii=False)
    ]
    if not relations:
        relations = found.get("elements", [])
    if not relations:
        raise SystemExit("No encontré la relación administrativa de Pudahuel.")
    relation = sorted(relations, key=lambda item: int(item.get("tags", {}).get("population") or 0), reverse=True)[0]
    relation_id = relation["id"]
    print(f"relación {relation_id} {relation.get('tags', {}).get('name')}")
    area_id = 3600000000 + relation_id

    boundary_data = load_or_fetch(
        "boundary.json",
        f"[out:json][timeout:90];rel({relation_id});out geom;",
    )
    highways = load_or_fetch(
        "highways.json",
        f"""
        [out:json][timeout:180];
        area({area_id})->.a;
        way["highway"~"^(motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|residential|living_street|unclassified)$"](area.a);
        out geom;
        """,
    )
    land = load_or_fetch(
        "land.json",
        f"""
        [out:json][timeout:180];
        area({area_id})->.a;
        (
          way["leisure"~"^(park|garden|pitch|stadium|nature_reserve)$"](area.a);
          way["landuse"~"^(grass|recreation_ground|forest|cemetery)$"](area.a);
          relation["leisure"~"^(park|garden|nature_reserve)$"](area.a);
          way["natural"="water"](area.a);
          way["waterway"~"^(river|stream|canal)$"](area.a);
          way["aeroway"~"^(aerodrome|runway|taxiway|apron|terminal)$"](area.a);
          relation["aeroway"="aerodrome"](area.a);
          way["railway"~"^(rail|subway|light_rail)$"](area.a);
        );
        out geom;
        """,
    )
    buildings = load_buildings(area_id, boundary_data)
    pois = load_or_fetch(
        "pois.json",
        f"""
        [out:json][timeout:120];
        area({area_id})->.a;
        (
          node(area.a)["amenity"~"^(townhall|courthouse|police|fire_station|school|university|college|library|place_of_worship|hospital|clinic|community_centre|theatre|arts_centre)$"];
          way(area.a)["amenity"~"^(townhall|courthouse|police|fire_station|school|university|college|library|place_of_worship|hospital|clinic|community_centre|theatre|arts_centre)$"];
          node(area.a)["railway"="station"];
          node(area.a)["station"="subway"];
          node(area.a)["aeroway"="aerodrome"];
          node(area.a)["leisure"~"^(park|stadium)$"];
          way(area.a)["leisure"~"^(park|stadium)$"];
          node(area.a)["historic"];
          node(area.a)["office"="notary"];
          way(area.a)["landuse"="cemetery"];
        );
        out center tags;
        """,
    )

    boundary_el = next(element for element in boundary_data["elements"] if element["type"] == "relation")
    raw_rings = ring_geometry(boundary_el)
    lons = [point[0] for ring in raw_rings for point in ring]
    lats = [point[1] for ring in raw_rings for point in ring]
    origin = (sum(lons) / len(lons), sum(lats) / len(lats))
    m_lon = 111320.0 * math.cos(math.radians(origin[1]))

    def to_xy(lon: float, lat: float) -> tuple[int, int]:
        return project(lon, lat, origin, m_lon)

    outers: list[list[list[int]]] = []
    for ring in raw_rings:
        cleaned = clean_ring([to_xy(lon, lat) for lon, lat in ring], 18, 800)
        if cleaned and shoelace([(p[0], p[1]) for p in cleaned]) > 1000:
            outers.append(cleaned)
    outers.sort(key=lambda ring: shoelace([(p[0], p[1]) for p in ring]), reverse=True)
    if not outers:
        raise SystemExit("El límite comunal quedó vacío.")
    commune_outers = [outers[0]]
    inners: list[list[list[int]]] = []

    streets = []
    for element in highways.get("elements", []):
        tags = element.get("tags") or {}
        kind = tags.get("highway", "")
        if kind.endswith("_link"):
            kind = kind.replace("_link", "")
        width = {
            "motorway": 16,
            "trunk": 14,
            "primary": 11,
            "secondary": 8,
            "tertiary": 6,
        }.get(kind, 4.5)
        coords = [to_xy(point["lon"], point["lat"]) for point in element.get("geometry", [])]
        simplified = douglas(coords, 10 if width < 8 else 6)
        if len(simplified) < 2:
            continue
        midpoint = simplified[len(simplified) // 2]
        if not inside_commune(midpoint[0], midpoint[1], commune_outers, inners):
            continue
        item = {"k": kind, "w": width, "p": [[x, y] for x, y in simplified]}
        if tags.get("name") and kind in {"motorway", "trunk", "primary", "secondary"}:
            item["n"] = tags["name"]
        streets.append(item)

    parks, water, airport, rails, waterways, runways = [], [], [], [], [], []

    def as_line(projected: list[tuple[int, int]], epsilon: float = 12) -> list[list[int]] | None:
        simplified = douglas(projected, epsilon)
        if len(simplified) < 2:
            return None
        return [[x, y] for x, y in simplified]

    def is_closed(projected: list[tuple[int, int]]) -> bool:
        if len(projected) < 4:
            return False
        return abs(projected[0][0] - projected[-1][0]) <= 3 and abs(projected[0][1] - projected[-1][1]) <= 3

    for element in land.get("elements", []):
        tags = element.get("tags") or {}
        if element["type"] == "relation":
            parts = []
            for member in element.get("members", []):
                geometry = member.get("geometry")
                if not geometry or member.get("role") == "inner":
                    continue
                parts.append([to_xy(point["lon"], point["lat"]) for point in geometry])
            geometries = stitch(parts)
        else:
            geometries = [[to_xy(point["lon"], point["lat"]) for point in element.get("geometry", [])]]
        for projected in geometries:
            if tags.get("railway"):
                line = as_line(projected)
                if line:
                    rails.append(line)
                continue
            if tags.get("waterway") or tags.get("aeroway") in {"runway", "taxiway"}:
                line = as_line(projected, 8)
                if not line:
                    continue
                if tags.get("waterway"):
                    waterways.append(line)
                else:
                    runways.append(line)
                continue
            if not is_closed(projected):
                if tags.get("natural") == "water":
                    line = as_line(projected)
                    if line:
                        waterways.append(line)
                continue
            cleaned = clean_ring(projected, 14, 100)
            if not cleaned or shoelace([(point[0], point[1]) for point in cleaned]) < 400:
                continue
            if tags.get("natural") == "water":
                water.append(cleaned)
            elif tags.get("aeroway"):
                airport.append(cleaned)
            else:
                parks.append(cleaned)

    built = []
    for element in buildings.get("elements", []):
        geometry = element.get("geometry")
        if not geometry:
            continue
        projected = [to_xy(point["lon"], point["lat"]) for point in geometry]
        cleaned = clean_ring(projected, 3.5, 10)
        if not cleaned:
            continue
        area = shoelace([(point[0], point[1]) for point in cleaned])
        if area < 28:
            continue
        cx, cy = centroid(cleaned)
        if not inside_commune(cx, cy, commune_outers, inners):
            continue
        tags = element.get("tags") or {}
        built.append(
            {
                "p": cleaned,
                "h": height_of(tags, area, element["id"]),
                "r": roof_of(tags, element["id"]),
            }
        )

    city = {
        "name": "Pudahuel",
        "founded": "1897",
        "formerName": "Las Barrancas",
        "origin": origin,
        "boundary": commune_outers,
        "streets": streets,
        "parks": parks,
        "water": water,
        "waterways": waterways,
        "airport": airport,
        "runways": runways,
        "rails": rails,
        "buildings": built,
        "source": "OpenStreetMap, © colaboradores de OpenStreetMap (ODbL)",
    }
    OUT_CITY.write_text(json.dumps(city, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(
        f"ciudad: {len(streets)} calles, {len(built)} edificios, "
        f"{len(parks)} áreas verdes, {OUT_CITY.stat().st_size / 1_048_576:.1f} MB"
    )

    places = assemble_places(pois, to_xy, commune_outers, inners)
    OUT_PLACES.write_text(json.dumps(places, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"lugares: {len(places['places'])}")


def osm_point(element: dict) -> tuple[float, float] | None:
    if element["type"] == "node":
        return element["lon"], element["lat"]
    center = element.get("center")
    if center:
        return center["lon"], center["lat"]
    return None


def assemble_places(pois: dict, to_xy, outers, inners) -> dict:
    indexed = []
    for element in pois.get("elements", []):
        tags = element.get("tags") or {}
        point = osm_point(element)
        if not point or not tags.get("name"):
            continue
        xy = to_xy(*point)
        if not inside_commune(xy[0], xy[1], outers, inners):
            continue
        indexed.append({"name": tags["name"], "tags": tags, "lon": point[0], "lat": point[1], "xy": xy})

    def find_osm(*needles: str) -> dict | None:
        for needle in needles:
            needle_cf = needle.casefold()
            for item in indexed:
                if needle_cf in item["name"].casefold():
                    return item
        return None

    curated = [
        place("municipalidad", "gobierno", "Municipalidad de Pudahuel", "Av. San Pablo 8444",
              "Sede del municipio. La comuna se creó el 25 de febrero de 1897 con el nombre de Las Barrancas y pasó a llamarse Pudahuel en 1975.",
              "Municipalidad de Pudahuel; Plan Municipal de Cultura 2024-2027",
              "Municipalidad de Pudahuel, Avenida San Pablo 8444, Chile"),
        place("registro-civil", "notarial", "Registro Civil de Pudahuel", "Av. San Pablo 8400",
              "Oficina del Servicio de Registro Civil e Identificación, a pasos de la municipalidad, sobre el antiguo camino a Valparaíso.",
              "Directorios públicos del Servicio de Registro Civil",
              "Registro Civil, San Pablo 8400, Pudahuel, Chile"),
        place("juzgados", "tribunales", "1° y 2° Juzgado de Policía Local", "Teniente Cruz 762",
              "Los dos juzgados de policía local de la comuna funcionan en el mismo edificio. Ven faltas e infracciones municipales, no los juicios penales mayores.",
              "SERNAC, directorio de Juzgados de Policía Local; juzgado.cl",
              "Teniente Cruz 762, Pudahuel, Santiago, Chile"),
        place("notaria-2", "notarial", "2ª Notaría de Pudahuel", "Av. Teniente Cruz 570, local 8",
              "Oficio notarial de la comuna. La 1ª Notaría figura en el directorio en San Pablo 6070, pero ese número no se puede fijar con certeza sobre la calle, así que no se marca. El Conservador de Bienes Raíces de estas escrituras está en Santiago, no en la comuna.",
              "Directorio de oficios notariales de Santiago, notarial.cl",
              "Teniente Cruz 570, Pudahuel, Santiago, Chile"),
        place("plaza", "hitos", "Plaza de Armas de Pudahuel", "San Francisco con La Estrella",
              "Plaza principal del casco histórico de Las Barrancas, el poblado donde se instalaron el registro civil, la iglesia y la escuela pública.",
              "Plan Municipal de Cultura 2024-2027; OpenStreetMap",
              "Plaza de Armas de Pudahuel, Chile"),
        place("cementerio", "historia", "Cementerio Municipal de Pudahuel", "Pudahuel",
              "Abrió en 1868, dependiente entonces de la parroquia San Luis Beltrán. Es, junto con esa parroquia, el bien patrimonial más antiguo de la comuna.",
              "Plan Municipal de Cultura 2024-2027, Ministerio de las Culturas",
              "Cementerio Municipal de Pudahuel, Chile"),
        place("san-luis", "historia", "Parroquia San Luis Beltrán", "Pudahuel",
              "Parroquia del antiguo poblado de Las Barrancas. De ella dependió el cementerio municipal en el siglo XIX.",
              "Plan Municipal de Cultura 2024-2027",
              "Parroquia San Luis Beltrán, Pudahuel, Chile"),
        place("ascension", "historia", "Parroquia Ascensión del Señor", "ex Santa Corina",
              "Conocida antes como parroquia Santa Corina. Se levantó a comienzos del siglo XX en el fundo Santa Corina, con diseño atribuido al arquitecto Alberto Cruz Montt.",
              "Plan Municipal de Cultura 2024-2027",
              "Parroquia La Ascención del Señor, Pudahuel, Chile",
              ("Ascención", "Ascensión", "Santa Corina")),
        place("santa-maria", "historia", "Parroquia Santa María del Sur", "La Estrella con Laguna Sur",
              "Nació como extensión de San Luis Beltrán. La primera piedra del templo actual se bendijo en 1996, en La Estrella con Laguna Sur.",
              "Plan Municipal de Cultura 2024-2027",
              "Parroquia Santa María del Sur, Pudahuel, Chile"),
        place("aeropuerto", "hitos", "Aeropuerto Arturo Merino Benítez", "Pudahuel",
              "Principal terminal aéreo del país. Su construcción incorporó a Pudahuel los terrenos que lo rodean y afirmó el carácter de comuna de paso entre Santiago y Valparaíso.",
              "Plan Municipal de Cultura 2024-2027; OpenStreetMap",
              "Aeropuerto Arturo Merino Benítez, Chile"),
        place("caren", "cultura", "Parque Laguna Carén", "Pudahuel",
              "Predio de la Universidad de Chile en el borde norponiente de la comuna, usado como parque y campus abierto.",
              "OpenStreetMap; Universidad de Chile",
              "Parque Laguna Carén, Pudahuel, Chile"),
    ]

    used_osm = set()
    places_out = []
    for item in curated:
        hit = None
        for needle in item["osm"]:
            hit = find_osm(needle)
            if hit:
                break
        lonlat = None
        if hit:
            lonlat = (hit["lon"], hit["lat"])
            used_osm.add(id(hit))
            if hit["name"] and item["id"] in {"plaza", "cementerio", "aeropuerto", "caren"}:
                item["name"] = hit["name"] if len(hit["name"]) > 8 else item["name"]
        else:
            lonlat = geocode(item["query"])
        if not lonlat:
            print(f"omitido, sin coordenadas: {item['name']}")
            continue
        xy = to_xy(*lonlat)
        if not inside_commune(xy[0], xy[1], outers, inners):
            print(f"fuera de la comuna: {item['name']} {lonlat}")
            continue
        places_out.append({
            "id": item["id"],
            "layer": item["layer"],
            "name": item["name"],
            "address": item["address"],
            "summary": item["summary"],
            "source": item["source"],
            "lon": round(lonlat[0], 6),
            "lat": round(lonlat[1], 6),
            "x": xy[0],
            "y": xy[1],
        })

    for item in indexed:
        if id(item) in used_osm:
            continue
        tags = item["tags"]
        layer = None
        summary = None
        if tags.get("amenity") == "police" and any(
            word in item["name"].casefold() for word in ("comisaría", "comisaria", "tenencia", "prefectura")
        ):
            layer = "seguridad"
            summary = "Recinto de Carabineros de Chile marcado en OpenStreetMap."
        elif tags.get("amenity") == "fire_station":
            layer = "seguridad"
            summary = "Cuartel de bomberos marcado en OpenStreetMap."
        elif tags.get("amenity") in {"library", "arts_centre", "theatre", "community_centre", "university", "college"}:
            layer = "cultura"
            summary = "Espacio de cultura o educación superior marcado en OpenStreetMap."
        elif tags.get("amenity") == "school" and any(word in item["name"].casefold() for word in ("liceo", "colegio", "escuela", "instituto")):
            layer = "colegios"
            summary = "Establecimiento educacional marcado en OpenStreetMap. La ficha no reemplaza el directorio oficial del SLEP o del municipio."
        elif tags.get("amenity") == "hospital":
            layer = "hitos"
            summary = "Recinto de salud marcado en OpenStreetMap."
        elif tags.get("station") == "subway" or (tags.get("railway") == "station" and "metro" in item["name"].casefold()):
            layer = "hitos"
            summary = "Estación de la Línea 5 del Metro de Santiago, dentro de la comuna."
            if not item["name"].casefold().startswith("metro"):
                item["name"] = f"Metro {item['name']}"
            tags = {**tags, "addr:street": "Línea 5"}
        elif tags.get("leisure") == "stadium" or "estadio" in item["name"].casefold():
            layer = "hitos"
            summary = "Recinto deportivo marcado en OpenStreetMap."
        elif tags.get("leisure") == "park" and item["name"].casefold().startswith("parque "):
            layer = "hitos"
            summary = "Parque marcado en OpenStreetMap."
        if not layer:
            continue
        places_out.append({
            "id": slug(item["name"]),
            "layer": layer,
            "name": item["name"],
            "address": tags.get("addr:street", "Pudahuel"),
            "summary": summary,
            "source": "OpenStreetMap",
            "lon": round(item["lon"], 6),
            "lat": round(item["lat"], 6),
            "x": item["xy"][0],
            "y": item["xy"][1],
        })

    deduped = []
    seen = set()
    for item in places_out:
        if any(
            abs(item["x"] - previous["x"]) < 180
            and abs(item["y"] - previous["y"]) < 180
            and same_place(item["name"], previous["name"])
            for previous in deduped
        ):
            continue
        key = item["id"]
        if key in seen:
            item["id"] = f"{key}-{len(seen)}"
        seen.add(item["id"])
        deduped.append(item)

    return {
        "layers": [
            {"id": "tribunales", "name": "Tribunales", "group": "Ámbito jurídico y gubernamental"},
            {"id": "notarial", "name": "Notarial y registral", "group": "Ámbito jurídico y gubernamental"},
            {"id": "seguridad", "name": "Orden y seguridad", "group": "Ámbito jurídico y gubernamental"},
            {"id": "gobierno", "name": "Gobierno local", "group": "Ámbito jurídico y gubernamental"},
            {"id": "cultura", "name": "Cultura y campus", "group": "Academia e historia"},
            {"id": "colegios", "name": "Colegios y liceos", "group": "Academia e historia", "off": True},
            {"id": "historia", "name": "Historia", "group": "Academia e historia"},
            {"id": "hitos", "name": "Hitos de la ciudad", "group": "Ciudad"},
        ],
        "tours": [
            {
                "id": "barrancas",
                "name": "Casco de Las Barrancas",
                "summary": "El antiguo camino a Valparaíso, la plaza y el edificio municipal.",
                "stops": ["plaza", "municipalidad", "registro-civil", "juzgados", "notaria-2"],
            },
            {
                "id": "memoria",
                "name": "Iglesias y cementerio",
                "summary": "Los templos que el plan de cultura de la comuna destaca, y el cementerio de 1868.",
                "stops": ["san-luis", "ascension", "santa-maria", "cementerio"],
            },
            {
                "id": "hoy",
                "name": "La comuna de hoy",
                "summary": "Del centro hacia el aeropuerto y Laguna Carén: Pudahuel como comuna de paso.",
                "stops": ["municipalidad", "aeropuerto", "caren"],
            },
        ],
        "places": deduped,
    }


def place(pid, layer, name, address, summary, source, query, osm=()):
    return {
        "id": pid,
        "layer": layer,
        "name": name,
        "address": address,
        "summary": summary,
        "source": source,
        "query": query,
        "osm": osm or (name,),
    }


def same_place(left: str, right: str) -> bool:
    def norm(value: str) -> str:
        text = slug(value)
        for token in ("-de-", "-la-", "-del-", "-los-", "-las-"):
            text = text.replace(token, "-")
        return text.strip("-")

    a, b = norm(left), norm(right)
    return a == b or a in b or b in a


def slug(value: str) -> str:
    text = value.casefold()
    for src, dst in (("á", "a"), ("é", "e"), ("í", "i"), ("ó", "o"), ("ú", "u"), ("ü", "u"), ("ñ", "n")):
        text = text.replace(src, dst)
    out = []
    prev = False
    for char in text:
        if char.isalnum():
            out.append(char)
            prev = False
        elif not prev:
            out.append("-")
            prev = True
    return "".join(out).strip("-")[:48]


if __name__ == "__main__":
    main()

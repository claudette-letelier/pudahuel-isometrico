const COS = Math.cos(Math.PI / 6);
const SIN = Math.sin(Math.PI / 6);

const DAY = {
  sky: "#d9d0c2",
  ground: "#e7dcc8",
  outside: "#cfc6b6",
  park: "#8ea56a",
  water: "#7ea4b4",
  airport: "#d4cbbd",
  rail: "#6d645c",
  roads: {
    motorway: "#f7f1e4",
    trunk: "#f4eee2",
    primary: "#f3ecdf",
    secondary: "#efe6d6",
    tertiary: "#eadfcb",
    residential: "#e6dcc6",
    living_street: "#e6dcc6",
    unclassified: "#e6dcc6",
  },
  roofs: ["#c46b45", "#e7dcc8", "#a7b0b4", "#8d5b49"],
  wall: ["#d2c1ac", "#ddd0bd", "#c5c2bc", "#d0b8a6"],
  wallDark: ["#b19784", "#c2b09a", "#9b9893", "#b39484"],
  tree: "#6f8f4e",
  trunk: "#7a624c",
  label: "#3d4650",
};

const NIGHT = {
  sky: "#141b26",
  ground: "#1d2833",
  outside: "#10161d",
  park: "#24382c",
  water: "#1d3c4a",
  airport: "#2a333c",
  rail: "#8d93a1",
  roads: {
    motorway: "#3a4654",
    trunk: "#354150",
    primary: "#313c4a",
    secondary: "#2c3744",
    tertiary: "#28323e",
    residential: "#24303a",
    living_street: "#24303a",
    unclassified: "#24303a",
  },
  roofs: ["#6d4034", "#3c4650", "#4d565c", "#5c3a32"],
  wall: ["#2a333c", "#303a44", "#343e48", "#322c2c"],
  wallDark: ["#1b222a", "#222a32", "#262e36", "#241e1e"],
  tree: "#2f4a34",
  trunk: "#3a3128",
  label: "#d5dbe3",
  window: "#f0c56e",
};

export const PIN_COLORS = {
  tribunales: "#e07a5f",
  notarial: "#e0b15a",
  seguridad: "#6aa6c9",
  gobierno: "#d36b86",
  cultura: "#7dba9a",
  colegios: "#c3d07a",
  historia: "#d39a62",
  hitos: "#f2a488",
};

function rotate(x, y, rot) {
  switch (rot & 3) {
    case 1: return [-y, x];
    case 2: return [-x, -y];
    case 3: return [y, -x];
    default: return [x, y];
  }
}

function unrotate(x, y, rot) {
  switch (rot & 3) {
    case 1: return [y, -x];
    case 2: return [-x, -y];
    case 3: return [-y, x];
    default: return [x, y];
  }
}

export class IsoMap {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.city = null;
    this.places = [];
    this.visible = new Set();
    this.selected = null;
    this.night = false;
    this.labels = true;
    this.cam = { x: 0, y: 0, zoom: 0.4, rot: 0 };
    this.dragging = false;
    this.dirty = true;
    this.onSelect = () => {};
    this._bind();
  }

  setCity(city) {
    this.city = city;
    for (const building of city.buildings) {
      let sx = 0;
      let sy = 0;
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const [x, y] of building.p) {
        sx += x;
        sy += y;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
      building.cx = sx / building.p.length;
      building.cy = sy / building.p.length;
      building.span = Math.hypot(maxX - minX, maxY - minY);
    }
    this.trees = this._trees(city.parks);
    this.fit();
  }

  setPlaces(places, visible) {
    this.places = places;
    this.visible = visible;
    this.dirty = true;
  }

  setVisible(visible) {
    this.visible = visible;
    this.dirty = true;
  }

  select(id) {
    this.selected = id;
    this.dirty = true;
  }

  focus(x, y, zoom = 1.6) {
    this.cam.x = x;
    this.cam.y = y;
    this.cam.zoom = zoom;
    this.dirty = true;
  }

  fit() {
    const ring = this.city.boundary[0];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [x, y] of ring) {
      const iso = this._iso(x, y, 0);
      minX = Math.min(minX, iso[0]);
      minY = Math.min(minY, iso[1]);
      maxX = Math.max(maxX, iso[0]);
      maxY = Math.max(maxY, iso[1]);
    }
    const { width, height } = this.canvas.getBoundingClientRect();
    const zx = (width - 80) / (maxX - minX || 1);
    const zy = (height - 80) / (maxY - minY || 1);
    this.cam.zoom = Math.max(0.08, Math.min(zx, zy));
    this.cam.x = 0;
    this.cam.y = 0;
    const world = this._isoToWorld((minX + maxX) / 2, (minY + maxY) / 2);
    this.cam.x = world[0];
    this.cam.y = world[1];
    this.dirty = true;
  }

  zoomBy(factor, sx, sy) {
    const rect = this.canvas.getBoundingClientRect();
    const px = sx ?? rect.width / 2;
    const py = sy ?? rect.height / 2;
    const before = this._screenToWorld(px, py);
    this.cam.zoom = Math.min(6, Math.max(0.08, this.cam.zoom * factor));
    const after = this._screenToWorld(px, py);
    this.cam.x += before[0] - after[0];
    this.cam.y += before[1] - after[1];
    this.dirty = true;
  }

  rotate(step) {
    this.cam.rot = (this.cam.rot + step + 4) & 3;
    this.dirty = true;
  }

  resetNorth() {
    this.cam.rot = 0;
    this.dirty = true;
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.view = { width: rect.width, height: rect.height };
    this.dirty = true;
  }

  draw() {
    if (!this.city || !this.view) return;
    const ctx = this.ctx;
    const theme = this.night ? NIGHT : DAY;
    const { width, height } = this.view;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = theme.outside;
    ctx.fillRect(0, 0, width, height);

    this._fillRings(this.city.boundary, theme.ground);
    this._fillRings(this.city.parks, theme.park);
    this._fillRings(this.city.water, theme.water);
    this._strokeOpen(this.city.waterways, theme.water, 7);
    this._fillRings(this.city.airport, theme.airport);
    this._strokeOpen(this.city.runways, this.night ? "#4c5968" : "#f7f4ee", 10);
    this._strokeLines(this.city.streets, theme);
    this._strokeRails(theme);
    this._drawTrees(theme);
    this._drawBuildings(theme);
    if (this.labels) this._drawLabels(theme);
    this._drawPins();
    this.dirty = false;
  }

  metersPerPixel() {
    return 1 / (this.cam.zoom * COS);
  }

  scaleLabel() {
    const meters = this.metersPerPixel() * 110;
    const steps = [50, 100, 200, 500, 1000, 2000, 5000, 10000];
    let best = steps[0];
    for (const step of steps) {
      if (Math.abs(step - meters) < Math.abs(best - meters)) best = step;
    }
    return best >= 1000 ? `${best / 1000} km` : `${best} m`;
  }

  _bind() {
    const canvas = this.canvas;
    let last = null;
    const pointers = new Map();

    canvas.addEventListener("pointerdown", (event) => {
      canvas.setPointerCapture(event.pointerId);
      pointers.set(event.pointerId, event);
      last = event;
      this.dragging = false;
    });
    canvas.addEventListener("pointermove", (event) => {
      pointers.set(event.pointerId, event);
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
        if (this._pinch) this.zoomBy(dist / this._pinch);
        this._pinch = dist;
        return;
      }
      if (!last || !pointers.has(event.pointerId) || event.buttons === 0 && event.pointerType === "mouse") return;
      const dx = event.clientX - last.clientX;
      const dy = event.clientY - last.clientY;
      if (Math.hypot(dx, dy) > 2) this.dragging = true;
      this._pan(dx, dy);
      last = event;
    });
    const end = (event) => {
      pointers.delete(event.pointerId);
      this._pinch = null;
      if (!this.dragging && event.type === "pointerup") {
        const rect = canvas.getBoundingClientRect();
        this._pick(event.clientX - rect.left, event.clientY - rect.top);
      }
      last = pointers.size ? [...pointers.values()].at(-1) : null;
      this.dragging = false;
    };
    canvas.addEventListener("pointerup", end);
    canvas.addEventListener("pointercancel", end);
    canvas.addEventListener("wheel", (event) => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const factor = event.deltaY < 0 ? 1.12 : 0.89;
      this.zoomBy(factor, event.clientX - rect.left, event.clientY - rect.top);
    }, { passive: false });
  }

  _pan(dx, dy) {
    const [ix, iy] = this._focusIso();
    const world = this._isoToWorld(ix - dx / this.cam.zoom, iy - dy / this.cam.zoom);
    this.cam.x = world[0];
    this.cam.y = world[1];
    this.dirty = true;
  }

  _pick(sx, sy) {
    let best = null;
    let bestDist = 18;
    for (const place of this.places) {
      if (!this.visible.has(place.layer)) continue;
      const point = this._project(place.x, place.y, 26);
      const dist = Math.hypot(point.sx - sx, point.sy - sy);
      if (dist < bestDist) {
        best = place;
        bestDist = dist;
      }
    }
    this.onSelect(best ? best.id : null);
  }

  _focusIso() {
    return this._iso(this.cam.x, this.cam.y, 0);
  }

  _iso(x, y, z) {
    const [rx, ry] = rotate(x, y, this.cam.rot);
    return [(rx - ry) * COS, (rx + ry) * SIN - z];
  }

  _isoToWorld(ix, iy) {
    const rx = (ix / COS + iy / SIN) / 2;
    const ry = (iy / SIN - ix / COS) / 2;
    return unrotate(rx, ry, this.cam.rot);
  }

  _project(x, y, z = 0) {
    const iso = this._iso(x, y, z);
    const focus = this._focusIso();
    return {
      sx: (iso[0] - focus[0]) * this.cam.zoom + this.view.width / 2,
      sy: (iso[1] - focus[1]) * this.cam.zoom + this.view.height / 2,
    };
  }

  _screenToWorld(sx, sy) {
    const focus = this._focusIso();
    const ix = (sx - this.view.width / 2) / this.cam.zoom + focus[0];
    const iy = (sy - this.view.height / 2) / this.cam.zoom + focus[1];
    return this._isoToWorld(ix, iy);
  }

  _onScreen(point, margin = 80) {
    return point.sx > -margin && point.sy > -margin && point.sx < this.view.width + margin && point.sy < this.view.height + margin;
  }

  _fillRings(rings, color) {
    if (!rings?.length) return;
    const ctx = this.ctx;
    ctx.beginPath();
    for (const ring of rings) {
      if (!ring.length) continue;
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      const projected = ring.map(([x, y]) => {
        const point = this._project(x, y, 0);
        minX = Math.min(minX, point.sx);
        minY = Math.min(minY, point.sy);
        maxX = Math.max(maxX, point.sx);
        maxY = Math.max(maxY, point.sy);
        return point;
      });
      if (maxX < -200 || maxY < -200 || minX > this.view.width + 200 || minY > this.view.height + 200) continue;
      ctx.moveTo(projected[0].sx, projected[0].sy);
      for (let i = 1; i < projected.length; i += 1) ctx.lineTo(projected[i].sx, projected[i].sy);
      ctx.closePath();
    }
    ctx.fillStyle = color;
    ctx.fill();
  }

  _strokeLines(streets, theme) {
    const ctx = this.ctx;
    const zoom = this.cam.zoom;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const street of streets) {
      if (zoom < 0.45 && (street.k === "residential" || street.k === "living_street" || street.k === "unclassified")) continue;
      if (zoom < 0.22 && (street.k === "tertiary" || street.k === "secondary")) continue;
      const first = this._project(street.p[0][0], street.p[0][1], 0.4);
      let visible = this._onScreen(first, 120);
      if (!visible) {
        for (let i = 1; i < street.p.length; i += 1) {
          if (this._onScreen(this._project(street.p[i][0], street.p[i][1], 0.4), 120)) {
            visible = true;
            break;
          }
        }
      }
      if (!visible) continue;
      ctx.beginPath();
      ctx.moveTo(first.sx, first.sy);
      for (let i = 1; i < street.p.length; i += 1) {
        const point = this._project(street.p[i][0], street.p[i][1], 0.4);
        ctx.lineTo(point.sx, point.sy);
      }
      ctx.strokeStyle = theme.roads[street.k] || theme.roads.residential;
      ctx.lineWidth = Math.max(0.6, street.w * zoom * 0.55);
      ctx.stroke();
    }
  }

  _strokeOpen(lines, color, widthMeters) {
    if (!lines?.length) return;
    const ctx = this.ctx;
    ctx.strokeStyle = color;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = Math.max(1, widthMeters * this.cam.zoom * 0.55);
    for (const line of lines) {
      const first = this._project(line[0][0], line[0][1], 0.2);
      ctx.beginPath();
      ctx.moveTo(first.sx, first.sy);
      for (let i = 1; i < line.length; i += 1) {
        const point = this._project(line[i][0], line[i][1], 0.2);
        ctx.lineTo(point.sx, point.sy);
      }
      ctx.stroke();
    }
  }

  _strokeRails(theme) {
    const ctx = this.ctx;
    ctx.strokeStyle = theme.rail;
    ctx.lineWidth = Math.max(1, 3 * this.cam.zoom);
    for (const line of this.city.rails) {
      ctx.beginPath();
      const first = this._project(line[0][0], line[0][1], 0.8);
      ctx.moveTo(first.sx, first.sy);
      for (let i = 1; i < line.length; i += 1) {
        const point = this._project(line[i][0], line[i][1], 0.8);
        ctx.lineTo(point.sx, point.sy);
      }
      ctx.stroke();
    }
  }

  _drawTrees(theme) {
    if (this.cam.zoom < 0.35) return;
    const ctx = this.ctx;
    for (const tree of this.trees) {
      const base = this._project(tree[0], tree[1], 0);
      if (!this._onScreen(base, 20)) continue;
      const top = this._project(tree[0], tree[1], 8);
      ctx.strokeStyle = theme.trunk;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(base.sx, base.sy);
      ctx.lineTo(top.sx, top.sy);
      ctx.stroke();
      ctx.fillStyle = theme.tree;
      ctx.beginPath();
      ctx.ellipse(top.sx, top.sy, Math.max(2, 4.5 * this.cam.zoom), Math.max(1.4, 2.6 * this.cam.zoom), 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  _drawBuildings(theme) {
    const ctx = this.ctx;
    const zoom = this.cam.zoom;
    const list = [];
    for (const building of this.city.buildings) {
      if (zoom < 0.3 && building.span < 18) continue;
      if (zoom < 0.55 && building.span < 10) continue;
      if (this.dragging && zoom < 1 && building.span < 16) continue;
      const [rx, ry] = rotate(building.cx, building.cy, this.cam.rot);
      const probe = this._project(building.cx, building.cy, 0);
      if (!this._onScreen(probe, 160 + building.span * zoom)) continue;
      building._depth = rx + ry;
      list.push(building);
    }
    list.sort((a, b) => a._depth - b._depth);
    for (const building of list) {
      const roof = theme.roofs[building.r] || theme.roofs[0];
      const wall = theme.wall[building.r] || theme.wall[0];
      const wallDark = theme.wallDark[building.r] || theme.wallDark[0];
      const top = building.p.map(([x, y]) => this._project(x, y, building.h));
      const bottom = building.p.map(([x, y]) => this._project(x, y, 0));
      const [cx, cy] = rotate(building.cx, building.cy, this.cam.rot);
      const centerDepth = cx + cy;
      for (let i = 0; i < building.p.length; i += 1) {
        const j = (i + 1) % building.p.length;
        const [ax, ay] = building.p[i];
        const [bx, by] = building.p[j];
        const [mx, my] = rotate((ax + bx) / 2, (ay + by) / 2, this.cam.rot);
        if (mx + my < centerDepth) continue;
        const facing = (mx + my) - centerDepth;
        ctx.beginPath();
        ctx.moveTo(top[i].sx, top[i].sy);
        ctx.lineTo(top[j].sx, top[j].sy);
        ctx.lineTo(bottom[j].sx, bottom[j].sy);
        ctx.lineTo(bottom[i].sx, bottom[i].sy);
        ctx.closePath();
        ctx.fillStyle = facing > 0 ? wall : wallDark;
        ctx.fill();
        if (this.night && building.h > 11 && zoom > 0.7) {
          ctx.fillStyle = NIGHT.window;
          const wx = (top[i].sx + bottom[i].sx) / 2;
          const wy = (top[i].sy + top[j].sy) / 2 - 2;
          ctx.fillRect(wx, wy, 2, 2);
        }
      }
      ctx.beginPath();
      ctx.moveTo(top[0].sx, top[0].sy);
      for (let i = 1; i < top.length; i += 1) ctx.lineTo(top[i].sx, top[i].sy);
      ctx.closePath();
      ctx.fillStyle = roof;
      ctx.fill();
    }
  }

  _drawLabels(theme) {
    if (this.cam.zoom < 0.7) return;
    const ctx = this.ctx;
    const used = new Set();
    ctx.fillStyle = theme.label;
    ctx.font = "12px Outfit, sans-serif";
    ctx.textAlign = "center";
    for (const street of this.city.streets) {
      if (!street.n || (street.k !== "primary" && street.k !== "trunk" && street.k !== "motorway" && street.k !== "secondary")) continue;
      const mid = street.p[Math.floor(street.p.length / 2)];
      const point = this._project(mid[0], mid[1], 2);
      if (!this._onScreen(point, 0)) continue;
      const cell = `${Math.round(point.sx / 110)}:${Math.round(point.sy / 70)}`;
      if (used.has(cell)) continue;
      used.add(cell);
      ctx.fillText(street.n, point.sx, point.sy);
    }
  }

  _drawPins() {
    const ctx = this.ctx;
    for (const place of this.places) {
      if (!this.visible.has(place.layer)) continue;
      const selected = place.id === this.selected;
      const base = this._project(place.x, place.y, 0);
      const head = this._project(place.x, place.y, selected ? 36 : 24);
      if (!this._onScreen(head, 30)) continue;
      ctx.strokeStyle = PIN_COLORS[place.layer] || "#fff";
      ctx.lineWidth = selected ? 2.5 : 1.5;
      ctx.beginPath();
      ctx.moveTo(base.sx, base.sy);
      ctx.lineTo(head.sx, head.sy);
      ctx.stroke();
      ctx.fillStyle = PIN_COLORS[place.layer] || "#fff";
      ctx.beginPath();
      ctx.arc(head.sx, head.sy, selected ? 7 : 4.5, 0, Math.PI * 2);
      ctx.fill();
      if (selected) {
        ctx.strokeStyle = "#1b2430";
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.font = "600 13px Outfit, sans-serif";
        ctx.textAlign = "left";
        ctx.fillStyle = this.night ? "#f3eee6" : "#1b2430";
        ctx.fillText(place.name, head.sx + 10, head.sy + 4);
      }
    }
  }

  _trees(parks) {
    const trees = [];
    for (const ring of parks) {
      if (ring.length < 3 || trees.length > 1800) break;
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const [x, y] of ring) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
      if (maxX - minX < 40 || maxY - minY < 40) continue;
      for (let x = minX; x < maxX && trees.length < 1800; x += 34) {
        for (let y = minY; y < maxY && trees.length < 1800; y += 34) {
          const jx = x + ((x * 13 + y * 7) % 17) - 8;
          const jy = y + ((x * 3 + y * 11) % 15) - 7;
          if (inside(jx, jy, ring)) trees.push([jx, jy]);
        }
      }
    }
    return trees;
  }
}

function inside(x, y, ring) {
  let hit = false;
  let j = ring.length - 1;
  for (let i = 0; i < ring.length; i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y)) {
      const cross = ((xj - xi) * (y - yi)) / ((yj - yi) || 1e-9) + xi;
      if (x < cross) hit = !hit;
    }
    j = i;
  }
  return hit;
}

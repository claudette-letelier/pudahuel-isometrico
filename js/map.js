const EL = Math.PI / 6;
const BASEH = 3200;
const DIST = 8000;
const HOME_ZOOM = matchMedia("(max-width: 760px)").matches ? 5 : 6;

const ROOF = [
  [0.77, 0.42, 0.27],
  [0.91, 0.86, 0.78],
  [0.65, 0.69, 0.71],
  [0.55, 0.36, 0.29],
];
const WALL = [
  [0.82, 0.76, 0.67],
  [0.87, 0.82, 0.74],
  [0.77, 0.76, 0.74],
  [0.82, 0.72, 0.65],
];
const WIDTHS = [16, 13, 11, 9.5, 7, 5, 3.5, 3.2];

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

function relief(delta) {
  const sign = Math.sign(delta);
  return sign * 3 * 50 * Math.log1p(Math.abs(delta) / 50);
}

class Bucket {
  constructor() {
    this.pos = [];
    this.nrm = [];
    this.col = [];
  }

  tri(a, b, c, color) {
    const ax = b[0] - a[0];
    const ay = b[1] - a[1];
    const az = b[2] - a[2];
    const bx = c[0] - a[0];
    const by = c[1] - a[1];
    const bz = c[2] - a[2];
    let nx = ay * bz - az * by;
    let ny = az * bx - ax * bz;
    let nz = ax * by - ay * bx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;
    for (const p of [a, b, c]) {
      this.pos.push(p[0], p[1], p[2]);
      this.nrm.push(nx, ny, nz);
      this.col.push(color[0], color[1], color[2]);
    }
  }

  up(a, b, c, color) {
    const ny = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
    if (ny >= 0) this.tri(a, b, c, color);
    else this.tri(a, c, b, color);
  }

  mesh(material) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
    geometry.setAttribute("normal", new THREE.Float32BufferAttribute(this.nrm, 3));
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(this.col, 3));
    geometry.computeBoundingSphere();
    return new THREE.Mesh(geometry, material);
  }
}

function windowMaterial(uniforms) {
  const material = new THREE.MeshLambertMaterial({ vertexColors: true });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = uniforms.uNight;
    shader.uniforms.uWin = uniforms.uWin;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vWP;\nvarying vec3 vWN;")
      .replace(
        "#include <project_vertex>",
        "#include <project_vertex>\nvWP=(modelMatrix*vec4(transformed,1.0)).xyz;\nvWN=normalize(mat3(modelMatrix)*objectNormal);",
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        "#include <common>\nvarying vec3 vWP;\nvarying vec3 vWN;\nuniform float uNight;\nuniform float uWin;",
      )
      .replace(
        "#include <tonemapping_fragment>",
        `if (abs(vWN.y) < 0.25 && vWP.y > 1.4) {
          vec2 t = normalize(vec2(-vWN.z, vWN.x));
          float u = fract(dot(vWP.xz, t) / 3.2);
          float v = fract(vWP.y / 3.1);
          float win = step(0.22, u) * step(u, 0.78) * step(0.24, v) * step(v, 0.74);
          float lamp = fract(sin(dot(floor(vWP.xz * 0.2) + floor(vWP.y), vec2(12.9898, 78.233))) * 43758.5453);
          gl_FragColor.rgb = mix(gl_FragColor.rgb, gl_FragColor.rgb * 0.72, win * uWin * (1.0 - uNight));
          gl_FragColor.rgb += win * step(0.62, lamp) * uNight * vec3(1.0, 0.76, 0.38) * 0.9;
        }
        #include <tonemapping_fragment>`,
      );
  };
  return material;
}

export class IsoMap {
  constructor(canvas) {
    this.canvas = canvas;
    this.city = null;
    this.places = [];
    this.visible = new Set();
    this.selected = null;
    this.night = false;
    this.labels = true;
    this.cam = { x: 0, y: 0, zoom: HOME_ZOOM, rot: 0 };
    this.dragging = false;
    this.dirty = true;
    this.onSelect = () => {};
    this.W = 1;
    this.H = 1;
    this._paintedNight = null;
    this._shadowStale = true;
    this.ready = false;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(0x1c2430, 1);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.shadowMap.autoUpdate = false;

    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -30000, 30000);
    this.hemi = new THREE.HemisphereLight(0xf4f1e6, 0x8e8a70, 0.5);
    this.sun = new THREE.DirectionalLight(0xfff3dd, 0.82);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.scene.add(this.hemi, this.sun, this.sun.target);
    this.sund = new THREE.Vector3(0.36, 0.707, -0.61).normalize();
    this.slx = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), this.sund).normalize();
    this.sly = new THREE.Vector3().crossVectors(this.sund, this.slx);
    this.uni = { uNight: { value: 0 }, uWin: { value: 0 } };
    this.raycaster = new THREE.Raycaster();
    this._pv = new THREE.Vector3();
    this._plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this._hit = new THREE.Vector3();

    this.overlay = document.createElement("canvas");
    this.overlay.id = "pins";
    canvas.parentElement.appendChild(this.overlay);
    this.octx = this.overlay.getContext("2d");
    this._bind();
  }

  setCity(city) {
    this.city = city;
    this._decodeElevation(city.elevation);
    this._build(city);
    this.ready = true;
    this.focus(0, 0, HOME_ZOOM);
  }

  setPlaces(places, visible) {
    if (this.city?.origin) {
      const [lon0, lat0] = this.city.origin;
      const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
      const ky = 110950;
      for (const place of places) {
        place.x = (place.lon - lon0) * kx;
        place.y = (place.lat - lat0) * ky;
      }
    }
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

  focus(x, y, zoom = HOME_ZOOM) {
    const az = this._az();
    const lifted = this._height(x, y) / Math.tan(EL);
    this.cam.x = x - Math.sin(az) * lifted;
    this.cam.y = y + Math.cos(az) * lifted;
    this.cam.zoom = Math.max(0.12, Math.min(26, zoom));
    const panel = document.querySelector("#panel");
    const ox = panel && this.W > 760 ? panel.getBoundingClientRect().width / 2 : 0;
    const k = BASEH / this.cam.zoom / this.H;
    this.cam.x -= ox * k * Math.cos(az);
    this.cam.y -= ox * k * Math.sin(az);
    this._placeCam(true);
  }

  fit() {
    const ring = this.city?.boundary || [];
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
    const span = Math.max(maxX - minX, maxY - minY, 1);
    const zoom = BASEH / (span * 1.15 * Math.sin(EL));
    this.focus((minX + maxX) / 2, (minY + maxY) / 2, zoom);
  }

  zoomBy(factor, sx, sy) {
    const before = sx == null ? null : this._planeAt(sx, sy);
    this.cam.zoom = Math.max(0.12, Math.min(26, this.cam.zoom * factor));
    this._placeCam(false);
    if (!before) {
      this._shadowStale = true;
      return;
    }
    const after = this._planeAt(sx, sy);
    if (after) {
      this.cam.x += before[0] - after[0];
      this.cam.y += before[1] - after[1];
      this._placeCam(false);
    }
    this._shadowStale = true;
  }

  rotate(step) {
    this.cam.rot = (this.cam.rot + step + 4) & 3;
    this._placeCam(true);
  }

  resetNorth() {
    this.cam.rot = 0;
    this._placeCam(true);
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.W = Math.max(1, rect.width);
    this.H = Math.max(1, rect.height);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(this.W, this.H, false);
    this.overlay.width = Math.max(1, Math.floor(this.W * dpr));
    this.overlay.height = Math.max(1, Math.floor(this.H * dpr));
    this.overlay.style.width = `${this.W}px`;
    this.overlay.style.height = `${this.H}px`;
    this.octx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._placeCam(true);
  }

  draw() {
    if (!this.ready) return;
    if (this._paintedNight !== this.night) this._applyNight();
    if (this._shadowStale && !this.dragging) {
      this._fitShadow();
      this._shadowStale = false;
    }
    const cast = this.cam.zoom >= 0.9;
    if (this.buildings) this.buildings.castShadow = cast;
    this.renderer.render(this.scene, this.camera);
    this._drawOverlay();
    this.dirty = false;
  }

  metersPerPixel() {
    return BASEH / this.cam.zoom / this.H;
  }

  scaleLabel() {
    const a = this._planeAt(this.W / 2, this.H / 2);
    const b = this._planeAt(this.W / 2 + 110, this.H / 2);
    if (!a || !b) return "";
    const meters = Math.hypot(a[0] - b[0], a[1] - b[1]);
    const steps = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000];
    let best = steps[0];
    for (const step of steps) {
      if (Math.abs(step - meters) < Math.abs(best - meters)) best = step;
    }
    return best >= 1000 ? `${best / 1000} km` : `${best} m`;
  }

  _az() {
    return Math.PI / 4 + this.cam.rot * (Math.PI / 2);
  }

  _decodeElevation(elev) {
    const [nx, ny] = elev.n;
    const z = new Float32Array(nx * ny);
    let acc = 0;
    for (let i = 0; i < elev.h.length; i += 1) {
      acc += elev.h[i];
      z[i] = relief(acc / 10);
    }
    this.elev = { o: elev.o, s: elev.s, nx, ny, z };
  }

  _inRing(x, y) {
    const ring = this.city?.boundary;
    if (!ring?.length) return true;
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
      const yi = ring[i][1];
      const yj = ring[j][1];
      if ((yi > y) !== (yj > y)) {
        const xCross = ((ring[j][0] - ring[i][0]) * (y - yi)) / (yj - yi || 1e-9) + ring[i][0];
        if (x < xCross) inside = !inside;
      }
    }
    return inside;
  }

  _height(x, y) {
    const elev = this.elev;
    if (!elev) return 0;
    const fx = (x - elev.o[0]) / elev.s;
    const fy = (y - elev.o[1]) / elev.s;
    if (fx < 0 || fy < 0 || fx > elev.nx - 1 || fy > elev.ny - 1) return 0;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const x1 = Math.min(x0 + 1, elev.nx - 1);
    const y1 = Math.min(y0 + 1, elev.ny - 1);
    const tx = fx - x0;
    const ty = fy - y0;
    const g = (ix, iy) => elev.z[iy * elev.nx + ix];
    return (
      g(x0, y0) * (1 - tx) * (1 - ty) +
      g(x1, y0) * tx * (1 - ty) +
      g(x0, y1) * (1 - tx) * ty +
      g(x1, y1) * tx * ty
    );
  }

  _build(city) {
    for (const mesh of [this.terrain, this.edge, this.ground, this.waterMesh, this.buildings, this.trees]) {
      if (!mesh) continue;
      this.scene.remove(mesh);
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
    const ground = new Bucket();
    const water = new Bucket();
    const built = new Bucket();
    const yard = [0.74, 0.68, 0.56];
    const park = [0.5, 0.62, 0.36];
    const road = [0.97, 0.95, 0.88];
    const apron = [0.8, 0.77, 0.7];
    const rail = [0.42, 0.38, 0.35];
    const blue = [0.45, 0.62, 0.7];

    const coverColor = {
      farm: [[0.78, 0.76, 0.46], [0.62, 0.7, 0.36], [0.7, 0.64, 0.38]],
      meadow: [[0.74, 0.78, 0.48], [0.64, 0.72, 0.4]],
      forest: [[0.32, 0.46, 0.26]],
      scrub: [[0.58, 0.62, 0.34]],
      orchard: [[0.5, 0.64, 0.3], [0.42, 0.56, 0.28]],
      yard: [[0.66, 0.64, 0.58], [0.58, 0.56, 0.52]],
    };
    for (let index = 0; index < (city.cover || []).length; index += 1) {
      const item = city.cover[index];
      const choices = coverColor[item.k] || coverColor.meadow;
      if (item.k === "farm" || item.k === "meadow" || item.k === "orchard") {
        this._field(ground, item.p, choices, 0.08, index);
      } else {
        this._drape(ground, item.p, choices[index % choices.length], 0.08);
      }
    }
    for (const block of city.blocks || []) this._drape(ground, block.p, block.k === "empty" ? park : yard, 0.18);
    for (const ring of city.parks || []) this._drape(ground, ring, park, 0.28);
    for (const ring of city.airport || []) this._drape(ground, ring, apron, 0.16);
    for (const street of city.streets || []) {
      const pale = street.k <= 1 ? [0.99, 0.97, 0.9] : road;
      this._ribbon(ground, street.p, WIDTHS[street.k] || 3.2, pale, 0.45);
    }
    for (const line of city.rails || []) this._ribbon(ground, line, 3.2, rail, 0.5);
    for (const line of city.runways || []) this._ribbon(ground, line, 14, [0.93, 0.91, 0.86], 0.4);
    for (const ring of city.water || []) this._drape(water, ring, blue, 0.22);
    for (const line of city.waterways || []) this._ribbon(water, line, 16, blue, 0.3);
    this.edge = this._edgeWall(city.boundary);

    for (const building of city.buildings || []) {
      const [cx, cy] = centroid(building.p);
      const base = this._height(cx, cy) - 1.2;
      this._prism(built, building.p, base, building.h + 1.2, ROOF[building.r % 4], WALL[building.r % 4]);
    }
    for (const house of city.houses || []) {
      const base = this._height(house.c[0], house.c[1]) - 0.8;
      this._box(built, house.c[0], house.c[1], house.a, house.w, house.d, base, house.h + 0.8, ROOF[house.r % 4], WALL[house.r % 4]);
    }

    const flat = new THREE.MeshLambertMaterial({ vertexColors: true });
    const wet = new THREE.MeshLambertMaterial({
      vertexColors: true,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -2,
    });
    this.terrain = this._terrainMesh(city.boundary, ground);
    this.terrain.receiveShadow = true;
    this.ground = ground.mesh(flat);
    this.ground.receiveShadow = true;
    this.waterMesh = water.mesh(wet);
    this.waterMesh.receiveShadow = true;
    this.buildings = built.mesh(windowMaterial(this.uni));
    this.buildings.castShadow = true;
    this.buildings.receiveShadow = true;
    this.trees = this._treeField(city.trees || []);
    this.scene.add(this.terrain, this.edge, this.ground, this.waterMesh, this.buildings);
    if (this.trees) this.scene.add(this.trees);
  }

  _soil(height, salt = 0) {
    const hi = Math.min(1, Math.max(0, height / 70));
    const low = salt > 0 ? [0.66, 0.72, 0.38] : [0.8, 0.76, 0.48];
    const high = [0.34, 0.48, 0.26];
    return [
      low[0] * (1 - hi) + high[0] * hi,
      low[1] * (1 - hi) + high[1] * hi,
      low[2] * (1 - hi) + high[2] * hi,
    ];
  }

  _terrainMesh(ring, rim) {
    const { o, s, nx, ny, z } = this.elev;
    const wide = nx - 1;
    const high = ny - 1;
    const mask = new Uint8Array(wide * high);
    for (let j = 0; j < high; j += 1) {
      const y = o[1] + (j + 0.5) * s;
      const cuts = [];
      for (let i = 0, k = ring.length - 1; i < ring.length; k = i, i += 1) {
        const a = ring[i];
        const b = ring[k];
        if ((a[1] > y) !== (b[1] > y)) cuts.push(a[0] + ((y - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
      }
      cuts.sort((p, q) => p - q);
      for (let m = 0; m + 1 < cuts.length; m += 2) {
        const i0 = Math.max(0, Math.ceil((cuts[m] - o[0]) / s - 0.5));
        const i1 = Math.min(wide - 1, Math.floor((cuts[m + 1] - o[0]) / s - 0.5));
        for (let i = i0; i <= i1; i += 1) mask[j * wide + i] = 1;
      }
    }
    for (let e = 0; e < ring.length; e += 1) {
      const a = ring[e];
      const b = ring[(e + 1) % ring.length];
      const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / (s * 0.5)));
      for (let step = 0; step <= steps; step += 1) {
        const x = a[0] + ((b[0] - a[0]) * step) / steps;
        const y = a[1] + ((b[1] - a[1]) * step) / steps;
        const i = Math.floor((x - o[0]) / s);
        const j = Math.floor((y - o[1]) / s);
        if (i >= 0 && j >= 0 && i < wide && j < high) mask[j * wide + i] = 2;
      }
    }
    const pos = new Float32Array(nx * ny * 3);
    const col = new Float32Array(nx * ny * 3);
    for (let j = 0; j < ny; j += 1) {
      for (let i = 0; i < nx; i += 1) {
        const k = (j * nx + i) * 3;
        const height = z[j * nx + i];
        const salt = Math.sin(i * 0.37 + j * 0.21) * Math.cos(i * 0.11 - j * 0.17);
        const tone = this._soil(height, salt);
        pos[k] = o[0] + i * s;
        pos[k + 1] = height;
        pos[k + 2] = -(o[1] + j * s);
        col[k] = tone[0];
        col[k + 1] = tone[1];
        col[k + 2] = tone[2];
      }
    }
    const idx = [];
    for (let j = 0; j < high; j += 1) {
      for (let i = 0; i < wide; i += 1) {
        const flag = mask[j * wide + i];
        if (flag === 1) {
          const a = j * nx + i;
          idx.push(a, a + 1, a + nx + 1, a, a + nx + 1, a + nx);
        } else if (flag === 2) {
          const x0 = o[0] + i * s;
          const y0 = o[1] + j * s;
          const parts = 4;
          const step = s / parts;
          for (let v = 0; v < parts; v += 1) {
            for (let u = 0; u < parts; u += 1) {
              const cx = x0 + (u + 0.5) * step;
              const cy = y0 + (v + 0.5) * step;
              if (!this._inRing(cx, cy)) continue;
              const quad = [
                [x0 + u * step, y0 + v * step],
                [x0 + (u + 1) * step, y0 + v * step],
                [x0 + (u + 1) * step, y0 + (v + 1) * step],
                [x0 + u * step, y0 + (v + 1) * step],
              ].map(([x, y]) => [x, this._height(x, y), -y]);
              const tone = this._soil(this._height(cx, cy));
              rim.up(quad[0], quad[1], quad[2], tone);
              rim.up(quad[0], quad[2], quad[3], tone);
            }
          }
        }
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(col, 3));
    geometry.setIndex(idx);
    geometry.computeVertexNormals();
    return new THREE.Mesh(geometry, new THREE.MeshLambertMaterial({ vertexColors: true }));
  }

  _edgeWall(ring) {
    const { o, s } = this.elev;
    const cutsOf = (a, b) => {
      const ts = [0, 1];
      for (const axis of [0, 1]) {
        const u = (a[axis] - o[axis]) / s;
        const v = (b[axis] - o[axis]) / s;
        const span = v - u;
        if (Math.abs(span) < 1e-9) continue;
        const lo = Math.min(u, v);
        const hi = Math.max(u, v);
        for (let k = Math.floor(lo) + 1; k < hi; k += 1) ts.push((k - u) / span);
      }
      ts.sort((p, q) => p - q);
      const unique = [];
      for (const t of ts) {
        if (!unique.length || t - unique[unique.length - 1] > 1e-4) unique.push(Math.min(1, Math.max(0, t)));
      }
      return unique.map((t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    };
    let floor = Infinity;
    for (const [x, y] of ring) floor = Math.min(floor, this._height(x, y));
    const base = floor - 48;
    const wall = new Bucket();
    const topsoil = [0.37, 0.27, 0.18];
    const soil = [0.54, 0.42, 0.3];
    const stratum = [0.4, 0.3, 0.2];
    for (let i = 0; i < ring.length; i += 1) {
      const start = ring[i];
      const end = ring[(i + 1) % ring.length];
      const points = cutsOf(start, end);
      for (let m = 0; m < points.length - 1; m += 1) {
        const a = points[m];
        const b = points[m + 1];
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        if (Math.hypot(dx, dy) < 0.4) continue;
        const ha = this._height(a[0], a[1]);
        const hb = this._height(b[0], b[1]);
        const band = (lowA, lowB, highA, highB, color) => {
          this._wall(
            wall,
            [a[0], lowA, -a[1]],
            [b[0], lowB, -b[1]],
            [b[0], highB, -b[1]],
            [a[0], highA, -a[1]],
            color,
            dy,
            dx,
          );
        };
        band(ha - 3.5, hb - 3.5, ha, hb, topsoil);
        band(base + 16, base + 16, ha - 3.5, hb - 3.5, soil);
        band(base + 7, base + 7, base + 16, base + 16, stratum);
        band(base, base, base + 7, base + 7, soil);
        const len = Math.hypot(dx, dy) || 1;
        const ix = (-dy / len) * 36;
        const iy = (dx / len) * 36;
        const cap = this._soil((ha + hb) / 2);
        const c0 = [a[0], ha + 0.25, -a[1]];
        const c1 = [b[0], hb + 0.25, -b[1]];
        const c2 = [b[0] + ix, this._height(b[0] + ix, b[1] + iy) + 0.25, -(b[1] + iy)];
        const c3 = [a[0] + ix, this._height(a[0] + ix, a[1] + iy) + 0.25, -(a[1] + iy)];
        wall.up(c0, c1, c2, cap);
        wall.up(c0, c2, c3, cap);
      }
    }
    const mesh = wall.mesh(new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
    mesh.receiveShadow = true;
    return mesh;
  }

  _treeField(trees) {
    if (!trees.length) return null;
    const geometry = roundTreeGeometry();
    const material = new THREE.MeshLambertMaterial({ vertexColors: true });
    const mesh = new THREE.InstancedMesh(geometry, material, trees.length);
    const dummy = new THREE.Object3D();
    for (let i = 0; i < trees.length; i += 1) {
      const [x, y, kind] = trees[i];
      const spin = ((Math.abs(x * 12.9898 + y * 78.233) % 1) + 1) % 1;
      const scale = (kind === 1 ? 0.55 : kind === 2 ? 0.78 : 1) * (0.82 + spin * 0.36);
      dummy.position.set(x, this._height(x, y), -y);
      dummy.rotation.set(0, spin * Math.PI * 2, 0);
      dummy.scale.set(scale, scale * (kind === 0 ? 1.45 : 0.92 + spin * 0.2), scale);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    return mesh;
  }

  _onRoad(point) {
    if (this._inRing(point[0], point[1])) return true;
    return (
      this._inRing(point[0] + 20, point[1]) ||
      this._inRing(point[0] - 20, point[1]) ||
      this._inRing(point[0], point[1] + 20) ||
      this._inRing(point[0], point[1] - 20)
    );
  }

  _roadSpan(a, b) {
    const left = this._onRoad(a);
    const right = this._onRoad(b);
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    if (left && right && this._onRoad(mid)) return [a, b];
    if (!left && !right) return null;
    if (left && right) return null;
    let inside = left ? a : b;
    let outside = left ? b : a;
    for (let step = 0; step < 10; step += 1) {
      const middle = [(inside[0] + outside[0]) / 2, (inside[1] + outside[1]) / 2];
      if (this._onRoad(middle)) inside = middle;
      else outside = middle;
    }
    return left ? [a, inside] : [inside, b];
  }

  _field(bucket, ring, colors, lift, seed) {
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
    const alongX = maxX - minX >= maxY - minY;
    const start = alongX ? minX : minY;
    const end = alongX ? maxX : maxY;
    if (end - start < 80) {
      this._drape(bucket, ring, colors[seed % colors.length], lift);
      return;
    }
    const band = end - start > 500 ? 72 : 48;
    for (let cursor = start, index = seed; cursor < end - 4; cursor += band, index += 1) {
      const piece = clipBand(ring, alongX ? 0 : 1, cursor, Math.min(end, cursor + band));
      if (piece.length >= 3) this._drape(bucket, piece, colors[index % colors.length], lift);
    }
  }

  _drape(bucket, ring, color, lift) {
    if (!ring || ring.length < 3) return;
    const contour = ring.map(([x, y]) => new THREE.Vector2(x, y));
    let faces = [];
    try {
      faces = THREE.ShapeUtils.triangulateShape(contour, []);
    } catch {
      return;
    }
    const verts = ring.map(([x, y]) => [x, this._height(x, y) + lift, -y]);
    for (const [i, j, k] of faces) bucket.up(verts[i], verts[j], verts[k], color);
  }

  _ribbon(bucket, pts, width, color, lift) {
    if (!pts || pts.length < 2) return;
    for (let i = 0; i < pts.length - 1; i += 1) {
      const span = this._roadSpan(pts[i], pts[i + 1]);
      if (!span) continue;
      const [a, b] = span;
      let dx = b[0] - a[0];
      let dy = b[1] - a[1];
      const len = Math.hypot(dx, dy) || 1;
      dx /= len;
      dy /= len;
      const ha = this._height(a[0], a[1]) + lift;
      const hb = this._height(b[0], b[1]) + lift;
      const leftA = [a[0] - dy * width * 0.5, ha, -(a[1] + dx * width * 0.5)];
      const rightA = [a[0] + dy * width * 0.5, ha, -(a[1] - dx * width * 0.5)];
      const leftB = [b[0] - dy * width * 0.5, hb, -(b[1] + dx * width * 0.5)];
      const rightB = [b[0] + dy * width * 0.5, hb, -(b[1] - dx * width * 0.5)];
      bucket.up(leftA, rightA, rightB, color);
      bucket.up(leftA, rightB, leftB, color);
    }
  }

  _prism(bucket, ring, base, height, roof, wall) {
    const n = ring.length;
    if (n < 3) return;
    const top = [];
    const bot = [];
    for (const [x, y] of ring) {
      top.push([x, base + height, -y]);
      bot.push([x, base, -y]);
    }
    for (let i = 0; i < n; i += 1) {
      const j = (i + 1) % n;
      const dx = ring[j][0] - ring[i][0];
      const dy = ring[j][1] - ring[i][1];
      this._wall(bucket, bot[i], bot[j], top[j], top[i], wall, dy, dx);
    }
    const contour = ring.map(([x, y]) => new THREE.Vector2(x, y));
    let faces = [];
    try {
      faces = THREE.ShapeUtils.triangulateShape(contour, []);
    } catch {
      faces = [];
    }
    for (const [i, j, k] of faces) bucket.up(top[i], top[j], top[k], roof);
  }

  _wall(bucket, a, b, c, d, color, outX, outZ) {
    const ax = b[0] - a[0];
    const ay = b[1] - a[1];
    const az = b[2] - a[2];
    const bx = c[0] - a[0];
    const by = c[1] - a[1];
    const bz = c[2] - a[2];
    const nx = ay * bz - az * by;
    const nz = ax * by - ay * bx;
    if (nx * outX + nz * outZ >= 0) {
      bucket.tri(a, b, c, color);
      bucket.tri(a, c, d, color);
    } else {
      bucket.tri(a, c, b, color);
      bucket.tri(a, d, c, color);
    }
  }

  _box(bucket, cx, cy, angle, w, d, base, height, roof, wall) {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const hx = w / 2;
    const hd = d / 2;
    const ring = [
      [-hx, -hd],
      [hx, -hd],
      [hx, hd],
      [-hx, hd],
    ].map(([lx, ly]) => [cx + lx * c - ly * s, cy + lx * s + ly * c]);
    this._prism(bucket, ring, base, height, roof, wall);
  }

  _trees(bucket, parks) {
    let count = 0;
    const leaf = [0.33, 0.46, 0.26];
    const trunk = [0.4, 0.3, 0.2];
    for (const ring of parks) {
      if (count > 1600 || ring.length < 3) continue;
      let area = 0;
      for (let i = 0; i < ring.length; i += 1) {
        const a = ring[i];
        const b = ring[(i + 1) % ring.length];
        area += a[0] * b[1] - b[0] * a[1];
      }
      if (Math.abs(area) > 160000) continue;
      for (let i = 0; i < ring.length && count < 1600; i += 1) {
        const a = ring[i];
        const b = ring[(i + 1) % ring.length];
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        const len = Math.hypot(dx, dy);
        if (len < 18) continue;
        const steps = Math.min(6, Math.floor(len / 16));
        for (let s = 1; s <= steps && count < 1600; s += 1) {
          const t = s / (steps + 1);
          const x = a[0] + dx * t - dy * (4 / len);
          const y = a[1] + dy * t + dx * (4 / len);
          const h = this._height(x, y);
          this._box(bucket, x, y, 0, 0.6, 0.6, h, 2.2, trunk, trunk);
          this._box(bucket, x, y, 0.4, 3.2, 3.2, h + 2.2, 3.4, leaf, leaf);
          count += 1;
        }
      }
    }
  }

  _placeCam(shadow) {
    const h = BASEH / this.cam.zoom;
    const aspect = this.W / this.H;
    const cam = this.camera;
    cam.left = (-h * aspect) / 2;
    cam.right = (h * aspect) / 2;
    cam.top = h / 2;
    cam.bottom = -h / 2;
    const az = this._az();
    const tx = this.cam.x;
    const ty = this.cam.y;
    cam.position.set(
      tx + Math.sin(az) * Math.cos(EL) * DIST,
      Math.sin(EL) * DIST,
      -ty + Math.cos(az) * Math.cos(EL) * DIST,
    );
    cam.up.set(0, 1, 0);
    cam.lookAt(tx, 0, -ty);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
    const ppm = this.H / h;
    this.uni.uWin.value = Math.max(0, Math.min(1, (ppm - 1.2) / 1.6));
    if (shadow) this._fitShadow();
    else this._shadowStale = true;
    this.dirty = true;
  }

  _fitShadow() {
    const cam = this.camera;
    let x0 = 1e9;
    let x1 = -1e9;
    let y0 = 1e9;
    let y1 = -1e9;
    let z0 = 1e9;
    let z1 = -1e9;
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        const origin = new THREE.Vector3(sx, sy, -1).unproject(cam);
        const far = new THREE.Vector3(sx, sy, 1).unproject(cam);
        const dir = far.sub(origin);
        if (Math.abs(dir.y) < 1e-4) continue;
        dir.normalize();
        for (const height of [-30, 90]) {
          const t = (height - origin.y) / dir.y;
          const v = origin.clone().addScaledVector(dir, t);
          const px = v.dot(this.slx);
          const py = v.dot(this.sly);
          const pz = v.dot(this.sund);
          x0 = Math.min(x0, px);
          x1 = Math.max(x1, px);
          y0 = Math.min(y0, py);
          y1 = Math.max(y1, py);
          z0 = Math.min(z0, pz);
          z1 = Math.max(z1, pz);
        }
      }
    }
    if (x0 > x1) return;
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const hx = Math.max(8, ((x1 - x0) / 2) * 1.25);
    const hy = Math.max(8, ((y1 - y0) / 2) * 1.25);
    this.sun.target.position
      .copy(this.slx)
      .multiplyScalar(cx)
      .addScaledVector(this.sly, cy)
      .addScaledVector(this.sund, z0);
    this.sun.position.copy(this.sun.target.position).addScaledVector(this.sund, z1 - z0 + 400);
    this.sun.target.updateMatrixWorld();
    const shadow = this.sun.shadow.camera;
    shadow.left = -hx;
    shadow.right = hx;
    shadow.bottom = -hy;
    shadow.top = hy;
    shadow.near = 1;
    shadow.far = z1 - z0 + 420;
    shadow.updateProjectionMatrix();
    this.sun.shadow.normalBias = 1.5;
    this.sun.shadow.bias = -0.0004;
    this.renderer.shadowMap.needsUpdate = true;
  }

  _applyNight() {
    this._paintedNight = this.night;
    this.renderer.setClearColor(this.night ? 0x101820 : 0x1c2430, 1);
    this.hemi.color.set(this.night ? 0x243044 : 0xf4f1e6);
    this.hemi.groundColor.set(this.night ? 0x141810 : 0x8e8a70);
    this.hemi.intensity = this.night ? 0.22 : 0.5;
    this.sun.color.set(this.night ? 0x9eb4d4 : 0xfff3dd);
    this.sun.intensity = this.night ? 0.16 : 0.82;
    this.uni.uNight.value = this.night ? 1 : 0;
    this.renderer.shadowMap.needsUpdate = true;
  }

  _planeAt(px, py) {
    const ndc = new THREE.Vector2((px / this.W) * 2 - 1, -(py / this.H) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    return this.raycaster.ray.intersectPlane(this._plane, this._hit) ? [this._hit.x, -this._hit.z] : null;
  }

  _project(x, y, extra) {
    const v = this._pv.set(x, this._height(x, y) + extra, -y).project(this.camera);
    return {
      sx: (v.x + 1) * 0.5 * this.W,
      sy: (1 - v.y) * 0.5 * this.H,
      ok: v.z >= -1 && v.z <= 1 && Math.abs(v.x) < 1.2 && Math.abs(v.y) < 1.2,
    };
  }

  _drawOverlay() {
    const ctx = this.octx;
    ctx.clearRect(0, 0, this.W, this.H);
    if (this.labels && this.cam.zoom > 2.4) this._drawLabels(ctx);
    this._drawPins(ctx);
  }

  _drawLabels(ctx) {
    ctx.font = "12px Outfit, sans-serif";
    ctx.fillStyle = this.night ? "#d5dbe3" : "#3d4650";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const taken = [];
    for (const street of this.city.streets || []) {
      if (!street.n || street.k > 4) continue;
      const mid = street.p[Math.floor(street.p.length / 2)];
      const point = this._project(mid[0], mid[1], 1);
      if (!point.ok) continue;
      if (taken.some(([x, y]) => Math.hypot(x - point.sx, y - point.sy) < 72)) continue;
      taken.push([point.sx, point.sy]);
      ctx.fillText(street.n, point.sx, point.sy);
      if (taken.length > 40) break;
    }
  }

  _drawPins(ctx) {
    for (const place of this.places) {
      if (!this.visible.has(place.layer)) continue;
      const point = this._project(place.x, place.y, 4);
      if (!point.ok) continue;
      const on = place.id === this.selected;
      const sy = point.sy - 12;
      ctx.beginPath();
      ctx.moveTo(point.sx, point.sy);
      ctx.lineTo(point.sx, sy);
      ctx.strokeStyle = "#1b2430";
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(point.sx, sy, on ? 8 : 5.5, 0, Math.PI * 2);
      ctx.fillStyle = PIN_COLORS[place.layer] || "#e07a5f";
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = on ? "#fffaf3" : "#1b2430";
      ctx.stroke();
    }
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
      canvas.style.cursor = "grabbing";
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
      if (!last || !pointers.has(event.pointerId) || (event.buttons === 0 && event.pointerType === "mouse")) return;
      const dx = event.clientX - last.clientX;
      const dy = event.clientY - last.clientY;
      if (Math.hypot(dx, dy) > 2) this.dragging = true;
      this._pan(dx, dy);
      last = event;
    });
    const end = (event) => {
      pointers.delete(event.pointerId);
      this._pinch = null;
      canvas.style.cursor = "grab";
      if (!this.dragging && event.type === "pointerup") {
        const rect = canvas.getBoundingClientRect();
        this._pick(event.clientX - rect.left, event.clientY - rect.top);
      }
      last = pointers.size ? [...pointers.values()].at(-1) : null;
      this.dragging = false;
      this._shadowStale = true;
      this.dirty = true;
    };
    canvas.addEventListener("pointerup", end);
    canvas.addEventListener("pointercancel", end);
    canvas.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        const rect = canvas.getBoundingClientRect();
        this.zoomBy(event.deltaY < 0 ? 1.12 : 0.89, event.clientX - rect.left, event.clientY - rect.top);
      },
      { passive: false },
    );
  }

  _pan(dx, dy) {
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);
    up.y = 0;
    if (up.lengthSq() < 1e-6) return;
    up.normalize();
    const k = BASEH / this.cam.zoom / this.H;
    const mx = -right.x * dx * k + (up.x * dy * k) / Math.sin(EL);
    const mz = -right.z * dx * k + (up.z * dy * k) / Math.sin(EL);
    this.cam.x += mx;
    this.cam.y -= mz;
    this._placeCam(false);
  }

  _pick(sx, sy) {
    let best = null;
    let bestDist = 18;
    for (const place of this.places) {
      if (!this.visible.has(place.layer)) continue;
      const point = this._project(place.x, place.y, 4);
      const dist = Math.hypot(point.sx - sx, point.sy - 12 - sy);
      if (dist < bestDist) {
        best = place;
        bestDist = dist;
      }
    }
    this.onSelect(best ? best.id : null);
  }
}

function clipBand(poly, axis, start, end) {
  const inside = (point, limit, keepBelow) => (keepBelow ? point[axis] <= limit : point[axis] >= limit);
  const cut = (a, b, limit) => {
    const span = b[axis] - a[axis] || 1e-9;
    const t = (limit - a[axis]) / span;
    return axis === 0 ? [limit, a[1] + (b[1] - a[1]) * t] : [a[0] + (b[0] - a[0]) * t, limit];
  };
  let out = poly;
  for (const [limit, keepBelow] of [[start, false], [end, true]]) {
    if (out.length < 3) return [];
    const next = [];
    for (let i = 0; i < out.length; i += 1) {
      const a = out[i];
      const b = out[(i + 1) % out.length];
      const ina = inside(a, limit, keepBelow);
      const inb = inside(b, limit, keepBelow);
      if (ina && inb) next.push(b);
      else if (ina && !inb) next.push(cut(a, b, limit));
      else if (!ina && inb) {
        next.push(cut(a, b, limit));
        next.push(b);
      }
    }
    out = next;
  }
  return out;
}

function roundTreeGeometry() {
  const crown = new THREE.IcosahedronGeometry(2.5, 0);
  crown.scale(1, 1.12, 1);
  crown.translate(0, 4.8, 0);
  const trunk = new THREE.CylinderGeometry(0.32, 0.45, 2.5, 5, 1);
  trunk.translate(0, 1.25, 0);
  const foliage = crown.toNonIndexed();
  const stem = trunk.toNonIndexed();
  foliage.computeVertexNormals();
  stem.computeVertexNormals();
  const leaves = foliage.attributes.position.count;
  const bark = stem.attributes.position.count;
  const position = new Float32Array((leaves + bark) * 3);
  const normal = new Float32Array((leaves + bark) * 3);
  const color = new Float32Array((leaves + bark) * 3);
  position.set(foliage.attributes.position.array);
  position.set(stem.attributes.position.array, leaves * 3);
  normal.set(foliage.attributes.normal.array);
  normal.set(stem.attributes.normal.array, leaves * 3);
  for (let i = 0; i < leaves; i += 1) color.set([0.4, 0.54, 0.27], i * 3);
  for (let i = 0; i < bark; i += 1) color.set([0.42, 0.33, 0.25], (leaves + i) * 3);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(position, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(normal, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(color, 3));
  crown.dispose();
  trunk.dispose();
  foliage.dispose();
  stem.dispose();
  return geometry;
}

function clipToRect(poly, x0, y0, x1, y1) {
  const planes = [
    [(p) => p[0] >= x0, (a, b) => [x0, a[1] + ((b[1] - a[1]) * (x0 - a[0])) / (b[0] - a[0] || 1e-9)]],
    [(p) => p[0] <= x1, (a, b) => [x1, a[1] + ((b[1] - a[1]) * (x1 - a[0])) / (b[0] - a[0] || 1e-9)]],
    [(p) => p[1] >= y0, (a, b) => [a[0] + ((b[0] - a[0]) * (y0 - a[1])) / (b[1] - a[1] || 1e-9), y0]],
    [(p) => p[1] <= y1, (a, b) => [a[0] + ((b[0] - a[0]) * (y1 - a[1])) / (b[1] - a[1] || 1e-9), y1]],
  ];
  let out = poly;
  for (const [inside, hit] of planes) {
    if (out.length < 3) return [];
    const next = [];
    for (let i = 0; i < out.length; i += 1) {
      const a = out[i];
      const b = out[(i + 1) % out.length];
      const ina = inside(a);
      const inb = inside(b);
      if (ina && inb) next.push(b);
      else if (ina && !inb) next.push(hit(a, b));
      else if (!ina && inb) {
        next.push(hit(a, b));
        next.push(b);
      }
    }
    out = next;
  }
  return out;
}

function centroid(ring) {
  let x = 0;
  let y = 0;
  for (const p of ring) {
    x += p[0];
    y += p[1];
  }
  return [x / ring.length, y / ring.length];
}

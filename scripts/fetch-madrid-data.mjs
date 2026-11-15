import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(PROJECT_ROOT, 'public', 'data');
const CHUNKS_DIR = path.join(DATA_DIR, 'chunks');

const OSM_CACHE_DIR = path.join(__dirname, '.cache-osm');

// Recorte completo interior de la M-30 (Almendra Central de Madrid, ~44 km²)
// BBOX se ajusta dinámicamente al anillo M-30 + margen de ~260 m
let BBOX = {
  minLon: -3.7510,
  minLat: 40.3820,
  maxLon: -3.6570,
  maxLat: 40.4870,
};

let M30_RING_LONLAT = null;

const ORIGIN = {
  lon: -3.6941,
  lat: 40.4152,
};

const CHUNK_SIZE_M = 400;
const METERS_PER_DEG_LON = 111320 * Math.cos((ORIGIN.lat * Math.PI) / 180);
const METERS_PER_DEG_LAT = 110540;

const ROAD_HIGHWAYS = new Set([
  'motorway',
  'motorway_link',
  'trunk',
  'primary',
  'primary_link',
  'secondary',
  'secondary_link',
  'tertiary',
  'tertiary_link',
  'unclassified',
  'residential',
  'living_street',
  'pedestrian',
  'footway',
  'cycleway',
  'service',
]);

const PARK_LEISURE = new Set(['park', 'garden', 'nature_reserve', 'playground']);
const PARK_LANDUSE = new Set(['grass', 'forest', 'meadow', 'recreation_ground', 'village_green', 'flowerbed']);
const PARK_NATURAL = new Set(['wood', 'scrub', 'grassland', 'heath']);

function roundCoord(val) {
  return Math.round(val * 1e6) / 1e6;
}

function projectToMeters(lon, lat) {
  return [
    (lon - ORIGIN.lon) * METERS_PER_DEG_LON,
    -(lat - ORIGIN.lat) * METERS_PER_DEG_LAT,
  ];
}

function deterministicHash(id) {
  let h = (Number(id) || 1) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}

function parseNumericMeters(raw) {
  if (raw === undefined || raw === null) return null;
  const match = String(raw).trim().match(/^(-?\d+(?:[.,]\d+)?)/);
  if (!match) return null;
  const val = parseFloat(match[1].replace(',', '.'));
  return Number.isFinite(val) && val >= 0 ? val : null;
}

function normalizeRoofShape(raw) {
  if (!raw) return undefined;
  const s = String(raw).trim().toLowerCase();
  if (s === 'flat') return 'flat';
  if (s === 'gabled') return 'gabled';
  if (s === 'hipped' || s === 'half-hipped' || s === 'saltbox') return 'hipped';
  if (s === 'pyramidal' || s === 'cone') return 'pyramidal';
  if (s === 'mansard') return 'mansard';
  if (s === 'dome' || s === 'onion') return 'dome';
  if (s === 'round') return 'round';
  if (s === 'skillion') return 'skillion';
  return undefined;
}

function ringAreaMetersSq(ring) {
  let area = 0;
  const len =
    ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]
      ? ring.length - 1
      : ring.length;
  for (let i = 0, j = len - 1; i < len; j = i++) {
    const [xi, zi] = projectToMeters(ring[i][0], ring[i][1]);
    const [xj, zj] = projectToMeters(ring[j][0], ring[j][1]);
    area += (xj + xi) * (zj - zi);
  }
  return Math.abs(area * 0.5);
}

function pointInRingXZMeters(x, z, ptsXZ) {
  let inside = false;
  for (let i = 0, j = ptsXZ.length - 1; i < ptsXZ.length; j = i++) {
    const xi = ptsXZ[i][0];
    const zi = ptsXZ[i][1];
    const xj = ptsXZ[j][0];
    const zj = ptsXZ[j][1];
    const intersect = zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi + 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function computeBuildingProps(id, tags, isPart, outerRing) {
  const explicitMinH = parseNumericMeters(tags.min_height);
  const minLevels = parseNumericMeters(tags['building:min_level']);
  const minHeight =
    explicitMinH !== null
      ? Math.min(80, explicitMinH)
      : minLevels !== null
        ? Math.min(80, minLevels * 3.4)
        : 0;

  const explicitH = parseNumericMeters(tags.height);
  const levels = parseNumericMeters(tags['building:levels']);
  const roofLevels = parseNumericMeters(tags['roof:levels']);
  let height;
  if (explicitH !== null && explicitH > 0) {
    height = Math.min(115, Math.max(minHeight + 2.5, explicitH));
  } else if (levels !== null && levels > 0) {
    height = Math.min(115, Math.max(minHeight + 2.5, levels * 3.4 + (roofLevels ? roofLevels * 2.8 : 0)));
  } else {
    height = Math.max(minHeight + 3.0, Math.round((14 + deterministicHash(id) * 10) * 10) / 10);
  }

  const roofShape = normalizeRoofShape(tags['roof:shape']);
  const explicitRoofH = parseNumericMeters(tags['roof:height']);
  let roofHeight;
  if (roofShape && roofShape !== 'flat') {
    const availH = Math.max(1.5, height - minHeight - 1.5);
    if (explicitRoofH !== null && explicitRoofH > 0) {
      roofHeight = Math.min(availH, Math.max(1.2, explicitRoofH));
    } else if (roofLevels !== null && roofLevels > 0) {
      roofHeight = Math.min(availH, Math.max(1.4, roofLevels * 2.8));
    } else {
      const areaSq = ringAreaMetersSq(outerRing);
      const approxRadius = Math.sqrt(areaSq / Math.PI);
      const est = Math.max(2.0, approxRadius * 0.42);
      roofHeight = Math.min(availH, Math.min(11, est));
    }
    roofHeight = Math.round(roofHeight * 10) / 10;
  }

  const props = {
    height: Math.round(height * 10) / 10,
  };
  if (minHeight > 0.1) props.minHeight = Math.round(minHeight * 10) / 10;
  if (roofShape && roofShape !== 'flat') {
    props.roofShape = roofShape;
    props.roofHeight = roofHeight;
  }
  if (isPart) props.isPart = true;
  return props;
}

function pointInRingLonLat(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    const intersect = yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi + 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function isInsideBbox(lon, lat, pad = 0.0005) {
  if (
    lon < BBOX.minLon - pad ||
    lon > BBOX.maxLon + pad ||
    lat < BBOX.minLat - pad ||
    lat > BBOX.maxLat + pad
  ) {
    return false;
  }
  if (!M30_RING_LONLAT) return true;
  if (pointInRingLonLat(lon, lat, M30_RING_LONLAT)) return true;
  if (pad <= 0) return false;
  return (
    pointInRingLonLat(lon + pad, lat, M30_RING_LONLAT) ||
    pointInRingLonLat(lon - pad, lat, M30_RING_LONLAT) ||
    pointInRingLonLat(lon, lat + pad, M30_RING_LONLAT) ||
    pointInRingLonLat(lon, lat - pad, M30_RING_LONLAT)
  );
}

function ringCentroid(ring) {
  let sumLon = 0;
  let sumLat = 0;
  const len =
    ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]
      ? ring.length - 1
      : ring.length;
  for (let i = 0; i < len; i++) {
    sumLon += ring[i][0];
    sumLat += ring[i][1];
  }
  return len > 0 ? [sumLon / len, sumLat / len] : [ORIGIN.lon, ORIGIN.lat];
}

function stitchWayRings(wayNodeLists) {
  const segments = wayNodeLists.filter((list) => list.length >= 2).map((list) => [...list]);
  const closedRings = [];

  while (segments.length > 0) {
    let current = segments.shift();
    let changed = true;

    while (changed && current[0] !== current[current.length - 1]) {
      changed = false;
      const startId = current[0];
      const endId = current[current.length - 1];

      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        const segStart = seg[0];
        const segEnd = seg[seg.length - 1];

        if (segStart === endId) {
          current = current.concat(seg.slice(1));
          segments.splice(i, 1);
          changed = true;
          break;
        }
        if (segEnd === endId) {
          current = current.concat([...seg].reverse().slice(1));
          segments.splice(i, 1);
          changed = true;
          break;
        }
        if (segEnd === startId) {
          current = seg.slice(0, -1).concat(current);
          segments.splice(i, 1);
          changed = true;
          break;
        }
        if (segStart === startId) {
          current = [...seg].reverse().slice(0, -1).concat(current);
          segments.splice(i, 1);
          changed = true;
          break;
        }
      }
    }

    if (current.length >= 4 && current[0] === current[current.length - 1]) {
      closedRings.push(current);
    }
  }

  return closedRings;
}

function ringNodeIdsToCoords(nodeIds, nodeMap) {
  const coords = [];
  for (const nid of nodeIds) {
    const pt = nodeMap.get(nid);
    if (!pt) return null;
    coords.push([roundCoord(pt[0]), roundCoord(pt[1])]);
  }
  return coords.length >= 4 ? coords : null;
}

function createCircleRing(centerLon, centerLat, radiusMeters, segments = 28) {
  const ring = [];
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const lon = roundCoord(centerLon + (Math.cos(a) * radiusMeters) / METERS_PER_DEG_LON);
    const lat = roundCoord(centerLat + (Math.sin(a) * radiusMeters) / METERS_PER_DEG_LAT);
    ring.push([lon, lat]);
  }
  return ring;
}

const DEFAULT_M30_RING = [
  [-3.661, 40.428], [-3.659, 40.441], [-3.662, 40.456], [-3.671, 40.471],
  [-3.686, 40.484], [-3.699, 40.484], [-3.713, 40.479], [-3.732, 40.467],
  [-3.746, 40.453], [-3.743, 40.436], [-3.735, 40.422], [-3.726, 40.411],
  [-3.721, 40.399], [-3.709, 40.389], [-3.692, 40.385], [-3.676, 40.391],
  [-3.666, 40.402], [-3.662, 40.415], [-3.661, 40.428],
];

function buildRadialM30Ring(points) {
  const cx = -3.696;
  const cy = 40.428;
  const mx = METERS_PER_DEG_LON;
  const my = METERS_PER_DEG_LAT;
  const bins = Array.from({ length: 72 }, () => []);

  for (const [lon, lat] of points) {
    const dx = (lon - cx) * mx;
    const dy = (lat - cy) * my;
    const r = Math.hypot(dx, dy);
    if (r < 2200 || r > 7400) continue;
    let a = Math.atan2(dy, dx);
    if (a < 0) a += Math.PI * 2;
    const b = Math.min(71, Math.floor((a / (Math.PI * 2)) * 72));
    bins[b].push({ lon, lat, dx, dy, r });
  }

  const built = [];
  for (let b = 0; b < 72; b++) {
    if (!bins[b].length) continue;
    bins[b].sort((u, v) => u.r - v.r);
    const pick = bins[b][Math.floor(bins[b].length * 0.3)];
    const scale = (pick.r + 260) / pick.r;
    built.push([
      roundCoord(cx + (pick.dx * scale) / mx),
      roundCoord(cy + (pick.dy * scale) / my),
    ]);
  }
  if (built.length >= 24) {
    built.push(built[0]);
    return built;
  }
  return null;
}

async function initM30Boundary() {
  const m30CacheFile = path.join(OSM_CACHE_DIR, 'm30-boundary.json');
  await fs.mkdir(OSM_CACHE_DIR, { recursive: true });

  let ring = null;
  try {
    const cached = JSON.parse(await fs.readFile(m30CacheFile, 'utf8'));
    if (Array.isArray(cached) && cached.length >= 24) {
      ring = cached;
      console.log(`Polígono M-30 cargado de caché (${ring.length} vértices).`);
    }
  } catch {
    // sin caché previo
  }

  if (!ring) {
    const endpoints = [
      'https://overpass-api.de/api/interpreter',
      'https://overpass.kumi.systems/api/interpreter',
    ];
    const q = `[out:json][timeout:30];way["ref"="M-30"]["highway"~"motorway|trunk"](40.38,-3.755,40.495,-3.65);out geom;`;
    for (const ep of endpoints) {
      try {
        const res = await fetch(ep, {
          method: 'POST',
          headers: {
            'User-Agent': 'FixieMessenger3D/1.0',
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: 'data=' + encodeURIComponent(q),
          signal: AbortSignal.timeout(25000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const d = await res.json();
        const pts = [];
        for (const el of d.elements || []) {
          for (const p of el.geometry || []) {
            pts.push([p.lon, p.lat]);
          }
        }
        ring = buildRadialM30Ring(pts);
        if (ring) {
          await fs.writeFile(m30CacheFile, JSON.stringify(ring));
          console.log(`Polígono real M-30 extraído desde OSM (${ring.length} vértices).`);
          break;
        }
      } catch (err) {
        console.warn(`Mirror Overpass (${ep}) no disponible: ${err.message}`);
      }
    }
  }

  if (!ring) {
    console.warn('Usando polígono M-30 por defecto para filtrado inicial de tiles.');
    ring = DEFAULT_M30_RING;
  }

  M30_RING_LONLAT = ring;
}

function tileIntersectsM30(tileBbox) {
  if (!M30_RING_LONLAT) return true;
  const [minLon, minLat, maxLon, maxLat] = tileBbox;
  for (let i = 0; i <= 2; i++) {
    const lon = minLon + ((maxLon - minLon) * i) / 2;
    for (let j = 0; j <= 2; j++) {
      const lat = minLat + ((maxLat - minLat) * j) / 2;
      if (pointInRingLonLat(lon, lat, M30_RING_LONLAT)) return true;
    }
  }
  for (const [vx, vy] of M30_RING_LONLAT) {
    if (vx >= minLon && vx <= maxLon && vy >= minLat && vy <= maxLat) return true;
  }
  return false;
}

async function fetchTile(tileBbox, label, depth = 0) {
  const cacheKey = tileBbox.map((v) => v.toFixed(5)).join('_');
  const cacheFile = path.join(OSM_CACHE_DIR, `tile_${cacheKey}.json`);
  try {
    const cached = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
    if (Array.isArray(cached)) {
      return { elements: cached, fromCache: true };
    }
  } catch {
    // no está en caché
  }

  const url = `https://api.openstreetmap.org/api/0.6/map.json?bbox=${tileBbox.join(',')}`;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'FixieMessenger3D/1.0 (https://github.com/Alexgmatosc/fixie-messenger-3d)',
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(40000),
      });
      if (res.status === 400 && depth < 2) {
        console.warn(`  [${label}] >50k nodos (HTTP 400); subdividiendo en 4 sub-tiles...`);
        const [minLon, minLat, maxLon, maxLat] = tileBbox;
        const midLon = roundCoord((minLon + maxLon) * 0.5);
        const midLat = roundCoord((minLat + maxLat) * 0.5);
        const subs = [
          [minLon, minLat, midLon, midLat],
          [midLon, minLat, maxLon, midLat],
          [minLon, midLat, midLon, maxLat],
          [midLon, midLat, maxLon, maxLat],
        ];
        const merged = [];
        for (let s = 0; s < subs.length; s++) {
          const part = await fetchTile(subs[s], `${label}.${s + 1}`, depth + 1);
          merged.push(...part.elements);
          if (!part.fromCache) await new Promise((r) => setTimeout(r, 450));
        }
        await fs.writeFile(cacheFile, JSON.stringify(merged));
        return { elements: merged, fromCache: false };
      }
      if (res.status === 429 || res.status >= 500) {
        const retryAfter = Number(res.headers.get('retry-after')) || 0;
        const waitMs = Math.max(retryAfter * 1000, 12000 * attempt);
        if (attempt === 5) throw new Error(`HTTP ${res.status}`);
        console.warn(`  [${label}] HTTP ${res.status}, esperando ${(waitMs / 1000).toFixed(0)}s (reintento ${attempt}/5)...`);
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (!Array.isArray(json.elements)) throw new Error('Sin elements');
      await fs.writeFile(cacheFile, JSON.stringify(json.elements));
      console.log(`  [${label}] OK (${json.elements.length} elementos)`);
      return { elements: json.elements, fromCache: false };
    } catch (err) {
      if (attempt === 5) throw err;
      const waitMs = 8000 * attempt;
      console.warn(`  [${label}] Reintento ${attempt}/5 (${err.message}) en ${(waitMs / 1000).toFixed(0)}s...`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  return { elements: [], fromCache: false };
}

async function fetchTiledOsmElements() {
  const cols = 12;
  const rows = 14;
  const dLon = (BBOX.maxLon - BBOX.minLon) / cols;
  const dLat = (BBOX.maxLat - BBOX.minLat) / rows;

  const tasks = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const tile = [
        roundCoord(BBOX.minLon + c * dLon),
        roundCoord(BBOX.minLat + r * dLat),
        roundCoord(BBOX.minLon + (c + 1) * dLon),
        roundCoord(BBOX.minLat + (r + 1) * dLat),
      ];
      if (!tileIntersectsM30(tile)) continue;
      tasks.push({ tile, label: `tile ${tasks.length + 1}` });
    }
  }

  console.log(`Descargando Madrid interior M-30 en ${tasks.length} tiles (filtrados al contorno M-30)...`);

  const nodeMap = new Map();
  const wayMap = new Map();
  const relationMap = new Map();
  const treeMap = new Map();

  let cacheHits = 0;
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    const { elements, fromCache } = await fetchTile(t.tile, `${t.label}/${tasks.length}`);
    if (fromCache) cacheHits++;

    for (const el of elements) {
      if (el.type === 'node') {
        nodeMap.set(el.id, [el.lon, el.lat]);
        if (el.tags?.natural === 'tree' && isInsideBbox(el.lon, el.lat, 0.0001)) {
          treeMap.set(el.id, [roundCoord(el.lon), roundCoord(el.lat)]);
        }
      } else if (el.type === 'way') {
        wayMap.set(el.id, el);
      } else if (el.type === 'relation') {
        relationMap.set(el.id, el);
      }
    }

    if (!fromCache && i + 1 < tasks.length) {
      await new Promise((r) => setTimeout(r, 450));
    }
  }

  // Refinar contorno M-30 directamente desde los ways M-30 ya descargados
  const localM30Pts = [];
  for (const w of wayMap.values()) {
    const tags = w.tags || {};
    if (tags.ref === 'M-30' && (tags.highway === 'motorway' || tags.highway === 'trunk')) {
      for (const nid of w.nodes || []) {
        const pt = nodeMap.get(nid);
        if (pt) localM30Pts.push(pt);
      }
    }
  }
  const exactLocalRing = buildRadialM30Ring(localM30Pts);
  if (exactLocalRing) {
    M30_RING_LONLAT = exactLocalRing;
    await fs.writeFile(path.join(OSM_CACHE_DIR, 'm30-boundary.json'), JSON.stringify(exactLocalRing));
    console.log(`Contorno M-30 refinado desde los datos locales (${exactLocalRing.length} vértices).`);
    // Re-filtrar árboles respecto al anillo exacto
    for (const [tid, [tlon, tlat]] of treeMap.entries()) {
      if (!isInsideBbox(tlon, tlat, 0.0001)) treeMap.delete(tid);
    }
  }

  console.log(
    `Elementos unicos totales (${cacheHits} tiles de caché): ${nodeMap.size} nodos, ${wayMap.size} vias, ${relationMap.size} relaciones.`
  );
  return { nodeMap, wayMap, relationMap, trees: Array.from(treeMap.values()) };
}

function chunkKeyForXZ(x, z) {
  const cx = Math.floor(x / CHUNK_SIZE_M);
  const cz = Math.floor(z / CHUNK_SIZE_M);
  return { cx, cz, key: `${cx}_${cz}` };
}

function decodePng(buf) {
  const signature = '89504e470d0a1a0a';
  if (buf.subarray(0, 8).toString('hex') !== signature) {
    throw new Error('Archivo PNG Terrarium inválido');
  }
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const bitDepth = buf[24];
  const colorType = buf[25];
  if (bitDepth !== 8) {
    throw new Error(`Profundidad PNG no soportada: ${bitDepth}`);
  }
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : 1;
  let offset = 8;
  const idatChunks = [];
  while (offset < buf.length) {
    const len = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    if (type === 'IDAT') {
      idatChunks.push(buf.subarray(offset + 8, offset + 8 + len));
    }
    if (type === 'IEND') break;
    offset += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idatChunks));
  const stride = width * bpp;
  const pixels = new Uint8Array(width * height * bpp);

  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const rowStart = y * (stride + 1) + 1;
    const outStart = y * stride;
    for (let x = 0; x < stride; x++) {
      let val = raw[rowStart + x];
      const a = x >= bpp ? pixels[outStart + x - bpp] : 0;
      const b = y > 0 ? pixels[outStart - stride + x] : 0;
      const c = x >= bpp && y > 0 ? pixels[outStart - stride + x - bpp] : 0;
      if (filter === 1) val = (val + a) & 255;
      else if (filter === 2) val = (val + b) & 255;
      else if (filter === 3) val = (val + ((a + b) >> 1)) & 255;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        val = (val + pr) & 255;
      }
      pixels[outStart + x] = val;
    }
  }
  return { width, height, bpp, pixels };
}

function lonLatToTilePixelFloat(lon, lat, z) {
  const n = 2 ** z;
  const xFloat = ((lon + 180) / 360) * n;
  const latRad = (lat * Math.PI) / 180;
  const yFloat = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  return { xFloat, yFloat };
}

function smoothGridGaussian(grid, cols, rows, passes = 2) {
  let src = Float64Array.from(grid);
  let dst = new Float64Array(cols * rows);
  for (let pass = 0; pass < passes; pass++) {
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        let sum = 0;
        let weightSum = 0;
        for (let dr = -1; dr <= 1; dr++) {
          const rr = Math.max(0, Math.min(rows - 1, r + dr));
          const wr = dr === 0 ? 2 : 1;
          for (let dc = -1; dc <= 1; dc++) {
            const cc = Math.max(0, Math.min(cols - 1, c + dc));
            const wc = dc === 0 ? 2 : 1;
            const w = wr * wc;
            sum += src[rr * cols + cc] * w;
            weightSum += w;
          }
        }
        dst[r * cols + c] = sum / weightSum;
      }
    }
    const tmp = src;
    src = dst;
    dst = tmp;
  }
  return Array.from(src);
}

function sampleRawGridBilinear(rawGrid, cols, rows, bbox, lon, lat) {
  const u = Math.max(0, Math.min(1, (lon - bbox[0]) / (bbox[2] - bbox[0])));
  const v = Math.max(0, Math.min(1, (lat - bbox[1]) / (bbox[3] - bbox[1])));
  const fx = u * (cols - 1);
  const fy = v * (rows - 1);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(cols - 1, x0 + 1);
  const y1 = Math.min(rows - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const v00 = rawGrid[y0 * cols + x0];
  const v10 = rawGrid[y0 * cols + x1];
  const v01 = rawGrid[y1 * cols + x0];
  const v11 = rawGrid[y1 * cols + x1];
  return (v00 * (1 - tx) + v10 * tx) * (1 - ty) + (v01 * (1 - tx) + v11 * tx) * ty;
}

async function fetchTerrariumDemGrid(cols, rows, demBbox) {
  const zoom = 15;
  const minCorner = lonLatToTilePixelFloat(demBbox[0], demBbox[3], zoom);
  const maxCorner = lonLatToTilePixelFloat(demBbox[2], demBbox[1], zoom);

  const minTx = Math.floor(minCorner.xFloat);
  const maxTx = Math.floor(maxCorner.xFloat);
  const minTy = Math.floor(minCorner.yFloat);
  const maxTy = Math.floor(maxCorner.yFloat);

  const tileCoords = [];
  for (let ty = minTy; ty <= maxTy; ty++) {
    for (let tx = minTx; tx <= maxTx; tx++) {
      tileCoords.push({ tx, ty });
    }
  }

  console.log(`Descargando ${tileCoords.length} tiles Terrarium DEM z=${zoom} (~3,5 m/px)...`);
  const tiles = new Map();
  const demConcurrency = 10;
  for (let i = 0; i < tileCoords.length; i += demConcurrency) {
    const batch = tileCoords.slice(i, i + demConcurrency);
    await Promise.all(
      batch.map(async ({ tx, ty }) => {
        const url = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${zoom}/${tx}/${ty}.png`;
        const res = await fetch(url, { signal: AbortSignal.timeout(25000) });
        if (!res.ok) throw new Error(`Terrarium HTTP ${res.status} en ${tx}/${ty}`);
        const buf = Buffer.from(await res.arrayBuffer());
        tiles.set(`${tx}_${ty}`, decodePng(buf));
      })
    );
  }

  function sampleTilePixelElevation(globalPx, globalPy) {
    const tx = Math.floor(globalPx / 256);
    const ty = Math.floor(globalPy / 256);
    const clampedTx = Math.max(minTx, Math.min(maxTx, tx));
    const clampedTy = Math.max(minTy, Math.min(maxTy, ty));
    const img = tiles.get(`${clampedTx}_${clampedTy}`);
    if (!img) throw new Error(`Tile Terrarium ausente ${clampedTx}_${clampedTy}`);
    const px = Math.max(0, Math.min(255, globalPx - clampedTx * 256));
    const py = Math.max(0, Math.min(255, globalPy - clampedTy * 256));
    const idx = (py * img.width + px) * img.bpp;
    const r = img.pixels[idx];
    const g = img.pixels[idx + 1];
    const b = img.pixels[idx + 2];
    return r * 256 + g + b / 256 - 32768;
  }

  const rawValues = new Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    const lat = demBbox[1] + (r / (rows - 1)) * (demBbox[3] - demBbox[1]);
    for (let c = 0; c < cols; c++) {
      const lon = demBbox[0] + (c / (cols - 1)) * (demBbox[2] - demBbox[0]);
      const { xFloat, yFloat } = lonLatToTilePixelFloat(lon, lat, zoom);
      const centerGx = Math.round(xFloat * 256);
      const centerGy = Math.round(yFloat * 256);
      let sum = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          sum += sampleTilePixelElevation(centerGx + dx, centerGy + dy);
        }
      }
      rawValues[r * cols + c] = sum / 9;
    }
  }

  return rawValues;
}

async function fetchGoogleMapsDemGrid(cols, rows, demBbox, apiKey) {
  const total = cols * rows;
  console.log(`Descargando ${total} muestras de Google Maps Elevation API...`);
  const coords = [];
  for (let r = 0; r < rows; r++) {
    const lat = demBbox[1] + (r / (rows - 1)) * (demBbox[3] - demBbox[1]);
    for (let c = 0; c < cols; c++) {
      const lon = demBbox[0] + (c / (cols - 1)) * (demBbox[2] - demBbox[0]);
      coords.push(`${lat.toFixed(6)},${lon.toFixed(6)}`);
    }
  }

  const batchSize = 200;
  const rawValues = new Array(total);
  for (let i = 0; i < coords.length; i += batchSize) {
    const slice = coords.slice(i, i + batchSize);
    const url = `https://maps.googleapis.com/maps/api/elevation/json?locations=${encodeURIComponent(
      slice.join('|')
    )}&key=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`Google Elevation HTTP ${res.status}`);
    const json = await res.json();
    if (json.status !== 'OK' || !Array.isArray(json.results)) {
      throw new Error(`Google Elevation status=${json.status} ${json.error_message || ''}`);
    }
    for (let j = 0; j < json.results.length; j++) {
      rawValues[i + j] = json.results[j].elevation;
    }
  }
  return rawValues;
}

async function fetchOpenMeteoDemFallback(cols, rows, demBbox) {
  const coarseCols = 35;
  const coarseRows = 29;
  console.log(
    `Fallback a Open-Meteo Copernicus DEM (${coarseCols}x${coarseRows} muestreado y reescalado)...`
  );
  const lats = [];
  const lons = [];
  for (let r = 0; r < coarseRows; r++) {
    const lat = demBbox[1] + (r / (coarseRows - 1)) * (demBbox[3] - demBbox[1]);
    for (let c = 0; c < coarseCols; c++) {
      const lon = demBbox[0] + (c / (coarseCols - 1)) * (demBbox[2] - demBbox[0]);
      lats.push(lat.toFixed(6));
      lons.push(lon.toFixed(6));
    }
  }

  const batchSize = 100;
  const coarseValues = [];
  for (let i = 0; i < lats.length; i += batchSize) {
    const latBatch = lats.slice(i, i + batchSize).join(',');
    const lonBatch = lons.slice(i, i + batchSize).join(',');
    const url = `https://api.open-meteo.com/v1/elevation?latitude=${latBatch}&longitude=${lonBatch}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
    const json = await res.json();
    if (!Array.isArray(json.elevation)) throw new Error('Open-Meteo sin elevation');
    coarseValues.push(...json.elevation);
  }

  const rawValues = new Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    const lat = demBbox[1] + (r / (rows - 1)) * (demBbox[3] - demBbox[1]);
    for (let c = 0; c < cols; c++) {
      const lon = demBbox[0] + (c / (cols - 1)) * (demBbox[2] - demBbox[0]);
      rawValues[r * cols + c] = sampleRawGridBilinear(
        coarseValues,
        coarseCols,
        coarseRows,
        demBbox,
        lon,
        lat
      );
    }
  }
  return rawValues;
}

async function fetchHighResDemGrid() {
  const cols = 220;
  const rows = 290;
  const demBbox = [
    roundCoord(BBOX.minLon - 0.002),
    roundCoord(BBOX.minLat - 0.002),
    roundCoord(BBOX.maxLon + 0.002),
    roundCoord(BBOX.maxLat + 0.002),
  ];

  let rawValues;
  const googleApiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (googleApiKey) {
    rawValues = await fetchGoogleMapsDemGrid(cols, rows, demBbox, googleApiKey);
  } else {
    try {
      rawValues = await fetchTerrariumDemGrid(cols, rows, demBbox);
    } catch (err) {
      console.warn(`Terrarium fallo (${err.message}); usando Open-Meteo Copernicus DEM...`);
      rawValues = await fetchOpenMeteoDemFallback(cols, rows, demBbox);
    }
  }

  const smoothed = smoothGridGaussian(rawValues, cols, rows, 2);
  const originElevationM =
    Math.round(
      sampleRawGridBilinear(smoothed, cols, rows, demBbox, ORIGIN.lon, ORIGIN.lat) * 10
    ) / 10;

  let minElev = Infinity;
  let maxElev = -Infinity;
  const values = smoothed.map((v) => {
    if (v < minElev) minElev = v;
    if (v > maxElev) maxElev = v;
    return Math.round((v - originElevationM) * 10) / 10;
  });

  const minElevationM = Math.round(minElev * 10) / 10;
  const maxElevationM = Math.round(maxElev * 10) / 10;
  console.log(
    `DEM alta resolucion listo (${cols}x${rows} = ${values.length} pts): ` +
      `min ${minElevationM} m, origen Neptuno ${originElevationM} m, max ${maxElevationM} m s.n.m.`
  );

  return {
    cols,
    rows,
    bbox: demBbox,
    originElevationM,
    minElevationM,
    maxElevationM,
    values,
  };
}

async function main() {
  await initM30Boundary();

  const demOnly = process.argv.includes('--dem-only');
  const manifestPath = path.join(CHUNKS_DIR, 'manifest.json');
  if (demOnly) {
    const existingRaw = await fs.readFile(manifestPath, 'utf8');
    const manifest = JSON.parse(existingRaw);
    manifest.dem = await fetchHighResDemGrid();
    manifest.meta.generatedAt = new Date().toISOString();
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    console.log(`DEM inyectado correctamente en ${manifestPath}`);
    return;
  }

  const [{ nodeMap, wayMap, relationMap, trees }, dem] = await Promise.all([
    fetchTiledOsmElements(),
    fetchHighResDemGrid(),
  ]);

  const relationOuterWayIds = new Set();
  const rawBuildings = [];
  const buildingParts = [];
  const parks = [];
  const water = [];
  const roads = [];

  function extractMultipolygonRings(rel) {
    const outerNodeLists = [];
    const innerNodeLists = [];
    for (const member of rel.members || []) {
      if (member.type !== 'way') continue;
      const w = wayMap.get(member.ref);
      if (!w || !Array.isArray(w.nodes)) continue;
      if (member.role === 'inner') {
        innerNodeLists.push(w.nodes);
      } else {
        outerNodeLists.push(w.nodes);
        relationOuterWayIds.add(w.id);
      }
    }
    const outers = stitchWayRings(outerNodeLists)
      .map((ids) => ringNodeIdsToCoords(ids, nodeMap))
      .filter(Boolean);
    const inners = stitchWayRings(innerNodeLists)
      .map((ids) => ringNodeIdsToCoords(ids, nodeMap))
      .filter(Boolean);
    return { outers, inners };
  }

  for (const rel of relationMap.values()) {
    const tags = rel.tags || {};
    if (tags.type !== 'multipolygon') continue;

    const isPart = Boolean(tags['building:part'] && tags['building:part'] !== 'no');
    const isBuilding = !isPart && Boolean(tags.building && tags.building !== 'no');
    const isPark =
      PARK_LEISURE.has(tags.leisure) ||
      PARK_LANDUSE.has(tags.landuse) ||
      PARK_NATURAL.has(tags.natural);
    const isWater =
      tags.natural === 'water' ||
      tags.amenity === 'fountain' ||
      tags.waterway === 'riverbank';

    if (!isPart && !isBuilding && !isPark && !isWater) continue;

    const { outers, inners } = extractMultipolygonRings(rel);
    if (outers.length === 0) continue;

    for (let i = 0; i < outers.length; i++) {
      const outer = outers[i];
      const [cLon, cLat] = ringCentroid(outer);
      if (!isInsideBbox(cLon, cLat, 0.0008)) continue;
      const rings = i === 0 ? [outer, ...inners] : [outer];

      if (isPart || isBuilding) {
        const props = computeBuildingProps(rel.id, tags, isPart, outer);
        const target = isPart ? buildingParts : rawBuildings;
        target.push({
          id: `rel/${rel.id}${outers.length > 1 ? `_${i}` : ''}`,
          name: tags.name || undefined,
          ...props,
          rings,
        });
      } else if (isWater) {
        water.push({
          id: `rel/${rel.id}${outers.length > 1 ? `_${i}` : ''}`,
          name: tags.name || undefined,
          rings,
        });
      } else if (isPark) {
        parks.push({
          id: `rel/${rel.id}${outers.length > 1 ? `_${i}` : ''}`,
          name: tags.name || undefined,
          rings,
        });
      }
    }
  }

  for (const way of wayMap.values()) {
    const tags = way.tags || {};
    const nodeIds = way.nodes || [];
    if (nodeIds.length < 2) continue;

    const isClosed = nodeIds.length >= 4 && nodeIds[0] === nodeIds[nodeIds.length - 1];

    if (tags.highway && ROAD_HIGHWAYS.has(tags.highway)) {
      const layerNum = tags.layer ? Number(tags.layer) : 0;
      const isTunnel = tags.tunnel === 'yes' || (Number.isFinite(layerNum) && layerNum < 0);
      if (!isTunnel) {
        const coords = [];
        for (const nid of nodeIds) {
          const pt = nodeMap.get(nid);
          if (pt) coords.push([roundCoord(pt[0]), roundCoord(pt[1])]);
        }
        if (coords.length >= 2 && coords.some(([lon, lat]) => isInsideBbox(lon, lat, 0.001))) {
          roads.push({
            id: `way/${way.id}`,
            name: tags.name || undefined,
            highway: tags.highway,
            oneway: tags.oneway === 'yes' || tags.oneway === '1' || tags.junction === 'roundabout',
            lanes: parseInt(tags.lanes, 10) || 0,
            coords,
          });
        }
      }
    }

    if (!isClosed) continue;

    const isPart = Boolean(tags['building:part'] && tags['building:part'] !== 'no');
    const isBuilding = !isPart && Boolean(tags.building && tags.building !== 'no');
    if ((isPart || isBuilding) && !relationOuterWayIds.has(way.id)) {
      const coords = ringNodeIdsToCoords(nodeIds, nodeMap);
      if (coords) {
        const [cLon, cLat] = ringCentroid(coords);
        if (isInsideBbox(cLon, cLat, 0.0008)) {
          const props = computeBuildingProps(way.id, tags, isPart, coords);
          const target = isPart ? buildingParts : rawBuildings;
          target.push({
            id: `way/${way.id}`,
            name: tags.name || undefined,
            ...props,
            rings: [coords],
          });
        }
      }
      continue;
    }

    const isWater =
      tags.natural === 'water' ||
      tags.amenity === 'fountain' ||
      tags.waterway === 'riverbank';
    if (isWater && !relationOuterWayIds.has(way.id)) {
      const coords = ringNodeIdsToCoords(nodeIds, nodeMap);
      if (coords) {
        const [cLon, cLat] = ringCentroid(coords);
        if (isInsideBbox(cLon, cLat, 0.0008)) {
          water.push({
            id: `way/${way.id}`,
            name: tags.name || undefined,
            rings: [coords],
          });
        }
      }
      continue;
    }

    const isPark =
      PARK_LEISURE.has(tags.leisure) ||
      PARK_LANDUSE.has(tags.landuse) ||
      PARK_NATURAL.has(tags.natural);
    if (isPark && !relationOuterWayIds.has(way.id)) {
      const coords = ringNodeIdsToCoords(nodeIds, nodeMap);
      if (coords) {
        const [cLon, cLat] = ringCentroid(coords);
        if (isInsideBbox(cLon, cLat, 0.001)) {
          parks.push({
            id: `way/${way.id}`,
            name: tags.name || undefined,
            rings: [coords],
          });
        }
      }
    }
  }

  // Deduplicar contornos padre (`building`) cuando existen `building:part` detallados dentro de su huella
  const partGrid = new Map();
  const PART_CELL_M = 50;
  const indexedParts = buildingParts.map((part) => {
    const [cLon, cLat] = ringCentroid(part.rings[0]);
    const [cx, cz] = projectToMeters(cLon, cLat);
    const areaSq = ringAreaMetersSq(part.rings[0]);
    const entry = { part, cx, cz, areaSq };
    const gx = Math.floor(cx / PART_CELL_M);
    const gz = Math.floor(cz / PART_CELL_M);
    const key = `${gx}_${gz}`;
    const list = partGrid.get(key) || [];
    list.push(entry);
    partGrid.set(key, list);
    return entry;
  });

  let omittedParentBuildings = 0;
  const buildings = [];
  for (const b of rawBuildings) {
    const outerXZ = b.rings[0].map(([lon, lat]) => projectToMeters(lon, lat));
    const holesXZ = b.rings.slice(1).map((r) => r.map(([lon, lat]) => projectToMeters(lon, lat)));
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const [px, pz] of outerXZ) {
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (pz < minZ) minZ = pz;
      if (pz > maxZ) maxZ = pz;
    }

    const gx0 = Math.floor(minX / PART_CELL_M);
    const gx1 = Math.floor(maxX / PART_CELL_M);
    const gz0 = Math.floor(minZ / PART_CELL_M);
    const gz1 = Math.floor(maxZ / PART_CELL_M);

    let groundPartsArea = 0;
    let allPartsArea = 0;
    let matchCount = 0;
    for (let gx = gx0; gx <= gx1; gx++) {
      for (let gz = gz0; gz <= gz1; gz++) {
        const list = partGrid.get(`${gx}_${gz}`);
        if (!list) continue;
        for (const item of list) {
          if (item.cx < minX || item.cx > maxX || item.cz < minZ || item.cz > maxZ) continue;
          if (!pointInRingXZMeters(item.cx, item.cz, outerXZ)) continue;
          if (holesXZ.some((h) => pointInRingXZMeters(item.cx, item.cz, h))) continue;
          matchCount++;
          allPartsArea += item.areaSq;
          if ((item.part.minHeight ?? 0) < 3.5) {
            groundPartsArea += item.areaSq;
          }
        }
      }
    }

    const parentArea = ringAreaMetersSq(b.rings[0]);
    const coveredByParts =
      parentArea > 1 &&
      (groundPartsArea >= parentArea * 0.45 || (matchCount >= 2 && allPartsArea >= parentArea * 0.35));
    if (coveredByParts) {
      omittedParentBuildings++;
    } else {
      buildings.push(b);
    }
  }
  for (const item of indexedParts) {
    buildings.push(item.part);
  }
  const roofShapedCount = buildings.filter((b) => b.roofShape && b.roofShape !== 'flat').length;
  console.log(
    `Arquitectura 3D procesada: ${buildings.length - buildingParts.length} edificios simples, ` +
      `${buildingParts.length} building:part (${omittedParentBuildings} contornos padre reemplazados), ` +
      `${roofShapedCount} con tejado con forma OSM.`
  );

  // Asegurar lámina de agua de Fuente de Neptuno
  const hasNeptunoWater = water.some((w) => {
    const [lon, lat] = ringCentroid(w.rings[0]);
    return Math.hypot(lon - ORIGIN.lon, lat - ORIGIN.lat) < 0.00035;
  });
  if (!hasNeptunoWater) {
    water.push({
      id: 'synthetic/neptuno-fountain',
      name: 'Fuente de Neptuno',
      rings: [createCircleRing(ORIGIN.lon, ORIGIN.lat, 13.5)],
    });
  }

  // Particionar en chunks espaciales de 400m x 400m
  const chunkMap = new Map();
  function getOrCreateChunk(cx, cz, key) {
    let ch = chunkMap.get(key);
    if (!ch) {
      ch = {
        cx,
        cz,
        key,
        buildings: [],
        roads: [],
        parks: [],
        water: [],
        trees: [],
      };
      chunkMap.set(key, ch);
    }
    return ch;
  }

  for (const b of buildings) {
    const [cLon, cLat] = ringCentroid(b.rings[0]);
    const [x, z] = projectToMeters(cLon, cLat);
    const { cx, cz, key } = chunkKeyForXZ(x, z);
    getOrCreateChunk(cx, cz, key).buildings.push(b);
  }

  for (const p of parks) {
    const [cLon, cLat] = ringCentroid(p.rings[0]);
    const [x, z] = projectToMeters(cLon, cLat);
    const { cx, cz, key } = chunkKeyForXZ(x, z);
    getOrCreateChunk(cx, cz, key).parks.push(p);
  }

  for (const w of water) {
    const [cLon, cLat] = ringCentroid(w.rings[0]);
    const [x, z] = projectToMeters(cLon, cLat);
    const { cx, cz, key } = chunkKeyForXZ(x, z);
    getOrCreateChunk(cx, cz, key).water.push(w);
  }

  for (const t of trees) {
    const [x, z] = projectToMeters(t[0], t[1]);
    const { cx, cz, key } = chunkKeyForXZ(x, z);
    getOrCreateChunk(cx, cz, key).trees.push(t);
  }

  // Dividir cada calle por punto medio de tramo para no duplicar carreteras entre chunks
  for (const r of roads) {
    const midCoord = r.coords[Math.floor(r.coords.length / 2)];
    const [x, z] = projectToMeters(midCoord[0], midCoord[1]);
    const { cx, cz, key } = chunkKeyForXZ(x, z);
    getOrCreateChunk(cx, cz, key).roads.push(r);
  }

  await fs.rm(CHUNKS_DIR, { recursive: true, force: true });
  await fs.mkdir(CHUNKS_DIR, { recursive: true });

  const chunkEntries = [];
  await Promise.all(
    Array.from(chunkMap.values()).map(async (ch) => {
      const fileName = `chunk_${ch.key}.json`;
      await fs.writeFile(path.join(CHUNKS_DIR, fileName), JSON.stringify(ch));
      chunkEntries.push({
        key: ch.key,
        cx: ch.cx,
        cz: ch.cz,
        file: fileName,
        counts: {
          buildings: ch.buildings.length,
          roads: ch.roads.length,
          parks: ch.parks.length,
          water: ch.water.length,
          trees: ch.trees.length,
        },
      });
    })
  );

  chunkEntries.sort((a, b) => a.cx - b.cx || a.cz - b.cz);

  const manifest = {
    meta: {
      origin: ORIGIN,
      bbox: [BBOX.minLon, BBOX.minLat, BBOX.maxLon, BBOX.maxLat],
      chunkSizeM: CHUNK_SIZE_M,
      generatedAt: new Date().toISOString(),
      source: 'OpenStreetMap',
    },
    totals: {
      chunks: chunkEntries.length,
      buildings: buildings.length,
      roads: roads.length,
      parks: parks.length,
      water: water.length,
      trees: trees.length,
    },
    dem,
    chunks: chunkEntries,
  };

  await fs.writeFile(path.join(CHUNKS_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));

  console.log(
    `\nStreaming espacial generado en public/data/chunks/:\n` +
      `  - Chunks (${CHUNK_SIZE_M}x${CHUNK_SIZE_M} m): ${manifest.totals.chunks}\n` +
      `  - Edificios totales: ${manifest.totals.buildings}\n` +
      `  - Calles totales: ${manifest.totals.roads}\n` +
      `  - Parques totales: ${manifest.totals.parks}\n` +
      `  - Agua/fuentes: ${manifest.totals.water}\n` +
      `  - Arboles OSM: ${manifest.totals.trees}`
  );
}

main().catch((err) => {
  console.error('Error generando chunks de Madrid:', err);
  process.exit(1);
});

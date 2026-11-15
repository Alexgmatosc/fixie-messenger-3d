import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(PROJECT_ROOT, 'public', 'data');
const CHUNKS_DIR = path.join(DATA_DIR, 'chunks');

// Gran recorte del centro de Madrid (~3.39 km x 2.76 km = ~9.35 km²):
// Palacio Real / Plaza de España <-> Retiro Este, Atocha <-> Alonso Martínez / Colón
const BBOX = {
  minLon: -3.7150,
  minLat: 40.4050,
  maxLon: -3.6750,
  maxLat: 40.4300,
};

const ORIGIN = {
  lon: -3.6941,
  lat: 40.4152,
};

const CHUNK_SIZE_M = 400;
const METERS_PER_DEG_LON = 111320 * Math.cos((ORIGIN.lat * Math.PI) / 180);
const METERS_PER_DEG_LAT = 110540;

const ROAD_HIGHWAYS = new Set([
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
  if (!raw) return null;
  const match = String(raw).trim().match(/^(\d+(?:[.,]\d+)?)/);
  if (!match) return null;
  const val = parseFloat(match[1].replace(',', '.'));
  return Number.isFinite(val) && val > 0 ? val : null;
}

function computeBuildingHeight(id, tags) {
  const explicitHeight = parseNumericMeters(tags.height);
  if (explicitHeight !== null) {
    return Math.min(110, Math.max(3.5, explicitHeight));
  }
  const levels = parseNumericMeters(tags['building:levels']);
  if (levels !== null) {
    return Math.min(110, Math.max(3.5, levels * 3.5));
  }
  return Math.round((14 + deterministicHash(id) * 10) * 10) / 10;
}

function isInsideBbox(lon, lat, pad = 0.0005) {
  return (
    lon >= BBOX.minLon - pad &&
    lon <= BBOX.maxLon + pad &&
    lat >= BBOX.minLat - pad &&
    lat <= BBOX.maxLat + pad
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

async function fetchTile(tileBbox, label) {
  const url = `https://api.openstreetmap.org/api/0.6/map.json?bbox=${tileBbox.join(',')}`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'MadridFixie3D/1.0 (https://github.com/local/madrid-fixie-3d)',
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (!Array.isArray(json.elements)) throw new Error('Sin elements');
      console.log(`  [${label}] OK (${json.elements.length} elementos)`);
      return json.elements;
    } catch (err) {
      if (attempt === 3) throw err;
      console.warn(`  [${label}] Reintento ${attempt}/3 (${err.message})...`);
      await new Promise((r) => setTimeout(r, 1200 * attempt));
    }
  }
  return [];
}

async function fetchTiledOsmElements() {
  const cols = 4;
  const rows = 3;
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
      tasks.push({ tile, label: `tile ${r * cols + c + 1}/${cols * rows}` });
    }
  }

  console.log(`Descargando centro de Madrid en ${tasks.length} tiles (3.39 km x 2.76 km)...`);

  const nodeMap = new Map();
  const wayMap = new Map();
  const relationMap = new Map();
  const treeMap = new Map();

  // Concurrencia controlada de 3 peticiones simultáneas
  const concurrency = 3;
  for (let i = 0; i < tasks.length; i += concurrency) {
    const batch = tasks.slice(i, i + concurrency);
    const results = await Promise.all(batch.map((t) => fetchTile(t.tile, t.label)));
    for (const elements of results) {
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
    }
  }

  console.log(
    `Elementos unicos totales: ${nodeMap.size} nodos, ${wayMap.size} vias, ${relationMap.size} relaciones.`
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
  await Promise.all(
    tileCoords.map(async ({ tx, ty }) => {
      const url = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${zoom}/${tx}/${ty}.png`;
      const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`Terrarium HTTP ${res.status} en ${tx}/${ty}`);
      const buf = Buffer.from(await res.arrayBuffer());
      tiles.set(`${tx}_${ty}`, decodePng(buf));
    })
  );

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
  const cols = 140;
  const rows = 116;
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

  await fs.rm(CHUNKS_DIR, { recursive: true, force: true });
  await fs.mkdir(CHUNKS_DIR, { recursive: true });

  const [{ nodeMap, wayMap, relationMap, trees }, dem] = await Promise.all([
    fetchTiledOsmElements(),
    fetchHighResDemGrid(),
  ]);

  const relationOuterWayIds = new Set();
  const buildings = [];
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

    const isBuilding = Boolean(tags.building && tags.building !== 'no');
    const isPark =
      PARK_LEISURE.has(tags.leisure) ||
      PARK_LANDUSE.has(tags.landuse) ||
      PARK_NATURAL.has(tags.natural);
    const isWater =
      tags.natural === 'water' ||
      tags.amenity === 'fountain' ||
      tags.waterway === 'riverbank';

    if (!isBuilding && !isPark && !isWater) continue;

    const { outers, inners } = extractMultipolygonRings(rel);
    if (outers.length === 0) continue;

    for (let i = 0; i < outers.length; i++) {
      const outer = outers[i];
      const [cLon, cLat] = ringCentroid(outer);
      if (!isInsideBbox(cLon, cLat, 0.0008)) continue;
      const rings = i === 0 ? [outer, ...inners] : [outer];

      if (isBuilding) {
        buildings.push({
          id: `rel/${rel.id}${outers.length > 1 ? `_${i}` : ''}`,
          name: tags.name || undefined,
          height: computeBuildingHeight(rel.id, tags),
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

    if (tags.building && tags.building !== 'no' && !relationOuterWayIds.has(way.id)) {
      const coords = ringNodeIdsToCoords(nodeIds, nodeMap);
      if (coords) {
        const [cLon, cLat] = ringCentroid(coords);
        if (isInsideBbox(cLon, cLat, 0.0008)) {
          buildings.push({
            id: `way/${way.id}`,
            name: tags.name || undefined,
            height: computeBuildingHeight(way.id, tags),
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

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const CHUNKS_LOD2_DIR = path.join(PROJECT_ROOT, 'public/data/chunks-lod2');
const CACHE_DIR = path.join(__dirname, '.cache-mapillary');
const OUT_FILE = path.join(PROJECT_ROOT, 'public/data/facades/granvia_corridor.json');

const ORIGIN_LON = -3.6941;
const ORIGIN_LAT = 40.4152;
const METERS_PER_DEG_LON = 111320 * Math.cos((ORIGIN_LAT * Math.PI) / 180);
const METERS_PER_DEG_LAT = 110540;

const CORRIDOR_CENTER = { lat: 40.4192, lon: -3.6975 };
const CORRIDOR_BBOX = [-3.7045, 40.4176, -3.6935, 40.4222]; // Alcalá / Cibeles -> Gran Vía / Red de San Luis

function projectToMeters(lon, lat) {
  return [
    (lon - ORIGIN_LON) * METERS_PER_DEG_LON,
    -(lat - ORIGIN_LAT) * METERS_PER_DEG_LAT,
  ];
}

function parseRingPts(b) {
  const outer = b.rings?.[0];
  if (!Array.isArray(outer) || outer.length === 0) return [];
  if (Array.isArray(outer[0])) {
    return outer.map(([lon, lat]) => projectToMeters(lon, lat));
  }
  const pts = [];
  for (let i = 0; i < outer.length; i += 2) {
    pts.push(projectToMeters(outer[i], outer[i + 1]));
  }
  return pts;
}

function buildingCentroidXZ(b) {
  const pts = parseRingPts(b);
  if (!pts.length) return [Infinity, Infinity];
  let sx = 0;
  let sz = 0;
  for (const [x, z] of pts) {
    sx += x;
    sz += z;
  }
  return [sx / pts.length, sz / pts.length];
}

async function loadCorridorBuildings() {
  const manifestPath = path.join(CHUNKS_LOD2_DIR, 'manifest.json');
  const raw = await fs.readFile(manifestPath, 'utf8');
  const manifest = JSON.parse(raw);

  // Chunks que cubren Alcalá / Cibeles / Metrópolis / Gran Vía (-1200..0 en X, -800..-200 en Z)
  const chunkFiles = new Set(['chunk_-1_-2.json', 'chunk_-2_-2.json', 'chunk_-3_-2.json', 'chunk_-1_-1.json']);
  const buildings = [];

  for (const entry of manifest.chunks || []) {
    const fileName = entry.file.split('/').pop();
    if (!chunkFiles.has(fileName)) continue;
    const filePath = entry.file.startsWith('/data/')
      ? path.join(PROJECT_ROOT, 'public', entry.file)
      : path.join(CHUNKS_LOD2_DIR, fileName);
    try {
      const cRaw = await fs.readFile(filePath, 'utf8');
      const chunk = JSON.parse(cRaw);
      for (const b of chunk.buildings || []) {
        const [cx, cz] = buildingCentroidXZ(b);
        if (cx >= -1150 && cx <= -50 && cz >= -650 && cz <= -280) {
          buildings.push({ ...b, cx, cz });
        }
      }
    } catch {
      // Ignorar chunks ausentes en modo parcial
    }
  }
  return buildings;
}

/**
 * Ray-wall matching para fotografías con GPS y `computed_compass_angle` (Mapillary v4).
 */
function matchCameraToBuildingWall(camX, camZ, compassDeg, buildings, maxDist = 48) {
  const rad = (compassDeg * Math.PI) / 180;
  // Rumbo geográfico: 0° = Norte (-Z), 90° = Este (+X)
  const dirX = Math.sin(rad);
  const dirZ = -Math.cos(rad);

  let best = null;
  for (const b of buildings) {
    const pts = parseRingPts(b);
    for (let i = 0; i < pts.length; i++) {
      const [ax, az] = pts[i];
      const [bx, bz] = pts[(i + 1) % pts.length];
      const ex = bx - ax;
      const ez = bz - az;
      const len = Math.hypot(ex, ez);
      if (len < 3.0) continue;

      // Normal de borde en plano XZ (dirX*nx + dirZ*nz en valor absoluto cubre orientación CW/CCW)
      const nx = -ez / len;
      const nz = ex / len;
      const facing = Math.abs(dirX * nx + dirZ * nz);
      if (facing < 0.55) continue;

      // Intersección rayo-segmento
      const denom = dirX * -ez + dirZ * ex;
      if (Math.abs(denom) < 1e-5) continue;
      const dx = ax - camX;
      const dz = az - camZ;
      const t = (dx * -ez + dz * ex) / denom;
      const u = (dirX * dz - dirZ * dx) / denom;
      if (t > 2 && t < maxDist && u >= 0.08 && u <= 0.92) {
        const score = facing * 2.0 - t / maxDist;
        if (!best || score > best.score) {
          best = {
            buildingId: b.id,
            parent3dId: b.parent3dId ?? null,
            name: b.name || null,
            height: b.height,
            distanceM: Number(t.toFixed(1)),
            perpendicularity: Number(facing.toFixed(3)),
            score,
          };
        }
      }
    }
  }
  return best;
}

async function fetchMapillaryCorridor(token, buildings) {
  const [minLon, minLat, maxLon, maxLat] = CORRIDOR_BBOX;
  const url =
    `https://graph.mapillary.com/images?access_token=${encodeURIComponent(token)}` +
    `&fields=id,geometry,computed_compass_angle,thumb_1024_url,captured_at` +
    `&bbox=${minLon},${minLat},${maxLon},${maxLat}&limit=80`;

  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) {
    throw new Error(`Mapillary HTTP ${res.status}: ${await res.text()}`);
  }
  const json = await res.json();
  const images = json.data || [];

  const matched = [];
  for (const img of images) {
    const coords = img.geometry?.coordinates;
    const angle = img.computed_compass_angle;
    if (!Array.isArray(coords) || typeof angle !== 'number') continue;

    const [camX, camZ] = projectToMeters(coords[0], coords[1]);
    const hit = matchCameraToBuildingWall(camX, camZ, angle, buildings);
    if (!hit) continue;

    matched.push({
      source: 'mapillary-v4',
      license: 'CC BY-SA 4.0',
      imageId: img.id,
      thumbUrl: img.thumb_1024_url || null,
      lon: coords[0],
      lat: coords[1],
      compassAngleDeg: Number(angle.toFixed(1)),
      ...hit,
    });
  }

  matched.sort((a, b) => b.score - a.score);
  return { mode: 'mapillary', rawCount: images.length, samples: matched.slice(0, 24) };
}

async function fetchWikimediaCorridor(buildings) {
  const url =
    `https://commons.wikimedia.org/w/api.php?action=query` +
    `&generator=geosearch&ggscoord=${CORRIDOR_CENTER.lat}|${CORRIDOR_CENTER.lon}` +
    `&ggsradius=500&ggslimit=30&ggsnamespace=6` +
    `&prop=imageinfo|coordinates&iiprop=url|extmetadata|size&iiurlwidth=640&format=json`;

  let pages = [];
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'madrid-fixie-3d-map/0.1 (open-data-research)' },
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) {
      const json = await res.json();
      pages = Object.values(json.query?.pages || {});
    }
  } catch (err) {
    console.warn(`[extract-facades] Aviso consultando Wikimedia Commons: ${err.message}`);
  }

  const samples = [];
  for (const page of pages) {
    const info = page.imageinfo?.[0];
    const coord = page.coordinates?.[0];
    if (!info || !coord) continue;
    const title = String(page.title || '').replace(/^File:/, '');
    if (!/\.(jpe?g|png|webp)$/i.test(title)) continue;

    const [px, pz] = projectToMeters(coord.lon, coord.lat);
    let nearest = null;
    let nearestDist = Infinity;
    for (const b of buildings) {
      const d = Math.hypot(b.cx - px, b.cz - pz);
      if (d < nearestDist) {
        nearestDist = d;
        nearest = b;
      }
    }

    const license = info.extmetadata?.LicenseShortName?.value || 'CC BY-SA';
    const isIconicGranVia = /metr[oó]polis|gran\s*v[ií]a|alcal[aá]|grassy|telef[oó]nica|cibeles|banco/i.test(
      title
    );
    const isChurchBaroque = /san\s*jos[eé]|iglesia|parroquia|calatrava/i.test(title);

    samples.push({
      source: 'wikimedia-commons',
      license,
      title,
      thumbUrl: info.thumburl || info.url,
      lon: coord.lon,
      lat: coord.lat,
      styleHint: isChurchBaroque ? 7 : isIconicGranVia ? 6 : 1,
      nearestBuildingId: nearest?.id ?? null,
      nearestParent3dId: nearest?.parent3dId ?? null,
      nearestBuildingName: nearest?.name ?? null,
      distanceM: Number(nearestDist.toFixed(1)),
    });
  }

  samples.sort((a, b) => a.distanceM - b.distanceM);
  return { mode: 'wikimedia-fallback', rawCount: pages.length, samples: samples.slice(0, 20) };
}

async function main() {
  await fs.mkdir(path.dirname(OUT_FILE), { recursive: true });
  await fs.mkdir(CACHE_DIR, { recursive: true });

  const buildings = await loadCorridorBuildings();
  const token = process.env.MAPILLARY_TOKEN?.trim();

  let result;
  if (token) {
    console.log('[extract-facades] Token MAPILLARY_TOKEN detectado: consultando Mapillary API v4...');
    result = await fetchMapillaryCorridor(token, buildings);
  } else {
    console.log(
      '[extract-facades] Sin MAPILLARY_TOKEN: ejecutando fallback geolocalizado Wikimedia Commons (CC BY-SA)...'
    );
    result = await fetchWikimediaCorridor(buildings);
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    corridor: 'Calle de Alcalá — Edificio Metrópolis — Gran Vía (Madrid)',
    bbox: CORRIDOR_BBOX,
    corridorWorldBounds: { minX: -1100, maxX: -50, minZ: -600, maxZ: -310 },
    lod2BuildingsScanned: buildings.length,
    extractionMode: result.mode,
    rawCandidateCount: result.rawCount,
    facadeStyleMappings: {
      6: {
        name: 'Gran Vía Beaux-Arts Limestone & Colonnades',
        palette: ['#eee6d7', '#d8ccb8', '#293039', '#c9a64c'],
        description: 'Columnatas pareadas corintias, ménsulas, balcones señoriales y zócalo noble',
      },
      7: {
        name: 'Madrid Baroque Red Brick & Granite Trim',
        palette: ['#9c4b39', '#8a3e2e', '#cec8bf', '#352b25'],
        description: 'Ladrillo madrileño fino con pilastras, frontones y cadenas de granito (San José / Alcalá)',
      },
    },
    samples: result.samples,
  };

  await fs.writeFile(OUT_FILE, JSON.stringify(payload, null, 2), 'utf8');
  console.log(
    `[extract-facades] Generado ${path.relative(PROJECT_ROOT, OUT_FILE)} (${result.samples.length} muestras geolocalizadas, modo=${result.mode})`
  );
}

main().catch((err) => {
  console.error('[extract-facades] Error:', err);
  process.exit(1);
});

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const BASE_CHUNKS_DIR = path.join(PROJECT_ROOT, 'public', 'data', 'chunks');
const LOD2_CHUNKS_DIR = path.join(PROJECT_ROOT, 'public', 'data', 'chunks-lod2');
const CACHE_DIR = path.join(__dirname, '.cache-lod2');

const ORIGIN_LON = -3.6941;
const ORIGIN_LAT = 40.4152;
const METERS_PER_DEG_LON = 111320 * Math.cos((ORIGIN_LAT * Math.PI) / 180);
const METERS_PER_DEG_LAT = 110540;

const SIGMA_LOD2_URL =
  'https://sigma.madrid.es/hosted/rest/services/CARTOGRAFIA/EDIFICIOS_ALTURAS/MapServer/0/query';

function projectToMeters(lon, lat) {
  return [
    (lon - ORIGIN_LON) * METERS_PER_DEG_LON,
    -(lat - ORIGIN_LAT) * METERS_PER_DEG_LAT,
  ];
}

function unprojectFromMeters(x, z) {
  return [
    ORIGIN_LON + x / METERS_PER_DEG_LON,
    ORIGIN_LAT - z / METERS_PER_DEG_LAT,
  ];
}

function roundCoord(v) {
  return Math.round(v * 1e6) / 1e6;
}

function ringAreaSqMeters(ring) {
  let area = 0;
  const n = ring.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const [xi, zi] = projectToMeters(ring[i][0], ring[i][1]);
    const [xj, zj] = projectToMeters(ring[j][0], ring[j][1]);
    area += (xj + xi) * (zj - zi);
  }
  return Math.abs(area * 0.5);
}

function ringCentroidMeters(ring) {
  const n =
    ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]
      ? ring.length - 1
      : ring.length;
  let sx = 0;
  let sz = 0;
  for (let i = 0; i < n; i++) {
    const [x, z] = projectToMeters(ring[i][0], ring[i][1]);
    sx += x;
    sz += z;
  }
  return n > 0 ? [sx / n, sz / n] : [0, 0];
}

function pointInRingMeters(px, pz, ringMeters) {
  let inside = false;
  for (let i = 0, j = ringMeters.length - 1; i < ringMeters.length; j = i++) {
    const xi = ringMeters[i][0];
    const zi = ringMeters[i][1];
    const xj = ringMeters[j][0];
    const zj = ringMeters[j][1];
    const intersect = zi > pz !== zj > pz && px < ((xj - xi) * (pz - zi)) / (zj - zi + 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function perpDistSq(p, a, b) {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const lenSq = dx * dx + dz * dz;
  if (lenSq < 1e-9) {
    return (p[0] - a[0]) ** 2 + (p[1] - a[1]) ** 2;
  }
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / lenSq));
  const px = a[0] + t * dx;
  const pz = a[1] + t * dz;
  return (p[0] - px) ** 2 + (p[1] - pz) ** 2;
}

function simplifyDP(pts, tolSq) {
  if (pts.length <= 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];

  while (stack.length > 0) {
    const [lo, hi] = stack.pop();
    let maxD = 0;
    let idx = -1;
    for (let i = lo + 1; i < hi; i++) {
      const d = perpDistSq(pts[i], pts[lo], pts[hi]);
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (maxD > tolSq && idx !== -1) {
      keep[idx] = 1;
      stack.push([lo, idx], [idx, hi]);
    }
  }

  const out = [];
  for (let i = 0; i < pts.length; i++) {
    if (keep[i]) out.push(pts[i]);
  }
  return out;
}

/**
 * Simplifica un anillo lon/lat eliminando vértices redundantes (< 0.18 m de desviación)
 * preservando chaflanes, rotondas y quiebros arquitectónicos de la restitución 1:1000.
 */
function simplifyClosedRing(ringLonLat, toleranceM = 0.18) {
  if (ringLonLat.length <= 4) return ringLonLat.map(([lon, lat]) => [roundCoord(lon), roundCoord(lat)]);
  const open = ringLonLat.slice(0, -1).map(([lon, lat]) => projectToMeters(lon, lat));
  if (open.length <= 3) return ringLonLat.map(([lon, lat]) => [roundCoord(lon), roundCoord(lat)]);

  // Dividir en punto más lejano al primero para preservar la costura cerrada
  let farIdx = 1;
  let maxDistSq = -1;
  for (let i = 1; i < open.length; i++) {
    const dSq = (open[i][0] - open[0][0]) ** 2 + (open[i][1] - open[0][1]) ** 2;
    if (dSq > maxDistSq) {
      maxDistSq = dSq;
      farIdx = i;
    }
  }

  const tolSq = toleranceM * toleranceM;
  const h1 = simplifyDP(open.slice(0, farIdx + 1), tolSq);
  const h2 = simplifyDP([...open.slice(farIdx), open[0]], tolSq);
  const merged = [...h1.slice(0, -1), ...h2];
  if (merged.length < 4) {
    return ringLonLat.map(([lon, lat]) => [roundCoord(lon), roundCoord(lat)]);
  }
  return merged.map(([x, z]) => {
    const [lon, lat] = unprojectFromMeters(x, z);
    return [roundCoord(lon), roundCoord(lat)];
  });
}

async function fetchEnvelopePaged(minLon, minLat, maxLon, maxLat, cacheKey) {
  const cacheFile = path.join(CACHE_DIR, `${cacheKey}.json`);
  try {
    const raw = await fs.readFile(cacheFile, 'utf8');
    return JSON.parse(raw);
  } catch {
    // Miss
  }

  const allFeatures = [];
  let offset = 0;
  const pageSize = 2000;

  while (true) {
    const params = new URLSearchParams({
      geometry: `${minLon.toFixed(6)},${minLat.toFixed(6)},${maxLon.toFixed(6)},${maxLat.toFixed(6)}`,
      geometryType: 'esriGeometryEnvelope',
      inSR: '4326',
      outSR: '4326',
      outFields: 'OBJECTID,ID_3D,ALTURA,Z_EDIFICIO_CAMBIO_ALTURA,Z_EDIFICIO_HUELLA',
      returnGeometry: 'true',
      resultRecordCount: String(pageSize),
      resultOffset: String(offset),
      f: 'geojson',
    });

    const url = `${SIGMA_LOD2_URL}?${params.toString()}`;
    let data = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(25000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        data = await res.json();
        break;
      } catch (err) {
        if (attempt === 2) throw err;
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
      }
    }

    const feats = Array.isArray(data?.features) ? data.features : [];
    allFeatures.push(...feats);
    if (feats.length < pageSize) break;
    offset += feats.length;
  }

  await fs.writeFile(cacheFile, JSON.stringify(allFeatures), 'utf8');
  return allFeatures;
}

async function main() {
  const includeAll = process.argv.includes('--all');
  await fs.mkdir(LOD2_CHUNKS_DIR, { recursive: true });
  await fs.mkdir(CACHE_DIR, { recursive: true });

  const manifestRaw = await fs.readFile(path.join(BASE_CHUNKS_DIR, 'manifest.json'), 'utf8');
  const manifest = JSON.parse(manifestRaw);
  const chunkSizeM = manifest.meta.chunkSizeM;

  // Zona por defecto: Distrito Centro + Retiro oeste + Chamberí sur + Salamanca oeste + Lavapiés (~72 bloques)
  const targetEntries = manifest.chunks.filter((entry) => {
    if (includeAll) return true;
    return entry.cx >= -4 && entry.cx <= 3 && entry.cz >= -5 && entry.cz <= 3;
  });

  console.log(`Objetivo LoD2 (Ayuntamiento de Madrid 1:1000): ${targetEntries.length} chunks.`);

  // Agrupar chunks en celdas de 2×2 (800×800 m) para descargar eficientemente desde SIGMA
  const tileGroups = new Map();
  for (const e of targetEntries) {
    const tx = Math.floor(e.cx / 2);
    const tz = Math.floor(e.cz / 2);
    const key = `${tx}_${tz}`;
    if (!tileGroups.has(key)) tileGroups.set(key, { tx, tz, entries: [] });
    tileGroups.get(key).entries.push(e);
  }

  const uniqueObjects = new Map();
  let tileIdx = 0;
  for (const [key, tile] of tileGroups.entries()) {
    tileIdx++;
    const x0 = tile.tx * 2 * chunkSizeM - 15;
    const x1 = (tile.tx * 2 + 2) * chunkSizeM + 15;
    const z0 = tile.tz * 2 * chunkSizeM - 15;
    const z1 = (tile.tz * 2 + 2) * chunkSizeM + 15;

    const [minLon, maxLat] = unprojectFromMeters(x0, z0);
    const [maxLon, minLat] = unprojectFromMeters(x1, z1);

    process.stdout.write(
      `[${tileIdx}/${tileGroups.size}] Descargando tesela SIGMA 1:1000 (${key})... `
    );
    const feats = await fetchEnvelopePaged(minLon, minLat, maxLon, maxLat, `tile_${key}`);
    console.log(`${feats.length} volúmenes.`);

    for (const f of feats) {
      const p = f.properties;
      const g = f.geometry;
      if (!p || !g) continue;
      const oid = Number(p.OBJECTID);
      if (uniqueObjects.has(oid)) continue;

      let height = Number(p.ALTURA);
      if (!Number.isFinite(height) || height < 1.8) {
        const zTop = Number(p.Z_EDIFICIO_CAMBIO_ALTURA);
        const zBot = Number(p.Z_EDIFICIO_HUELLA);
        if (Number.isFinite(zTop) && Number.isFinite(zBot)) {
          height = zTop - zBot;
        }
      }
      if (!Number.isFinite(height) || height < 1.8 || height > 260) continue;

      const polys =
        g.type === 'Polygon'
          ? [g.coordinates]
          : g.type === 'MultiPolygon'
            ? g.coordinates
            : [];

      let partSubIdx = 0;
      for (const polyRings of polys) {
        if (!Array.isArray(polyRings) || polyRings.length === 0) continue;
        const outer = simplifyClosedRing(polyRings[0], 0.18);
        if (outer.length < 4) continue;
        const areaSq = ringAreaSqMeters(outer);
        if (areaSq < 2.2) continue;

        const holes = [];
        for (let h = 1; h < polyRings.length; h++) {
          const hole = simplifyClosedRing(polyRings[h], 0.22);
          if (hole.length >= 4 && ringAreaSqMeters(hole) >= 1.5) {
            holes.push(hole);
          }
        }

        const [centX, centZ] = ringCentroidMeters(outer);
        const uid = partSubIdx === 0 ? oid : `${oid}_${partSubIdx}`;
        partSubIdx++;

        uniqueObjects.set(uid, {
          uid,
          oid,
          parent3dId: Number(p.ID_3D) || oid,
          height: Math.round(height * 10) / 10,
          areaSq,
          centX,
          centZ,
          rings: [outer, ...holes],
        });
      }
    }
  }

  console.log(`Total sub-volúmenes LoD2 válidos y simplificados: ${uniqueObjects.size}`);

  // Agrupar por edificio municipal ID_3D para clasificar niveles (base / main / attic / tower)
  const byBuilding = new Map();
  for (const item of uniqueObjects.values()) {
    if (!byBuilding.has(item.parent3dId)) byBuilding.set(item.parent3dId, []);
    byBuilding.get(item.parent3dId).push(item);
  }

  // Indexar por chunk destino
  const targetKeySet = new Set(targetEntries.map((e) => e.key));
  const lod2ByChunk = new Map();

  for (const items of byBuilding.values()) {
    let maxH = 0;
    let maxArea = 0;
    for (const it of items) {
      if (it.height > maxH) maxH = it.height;
      if (it.areaSq > maxArea) maxArea = it.areaSq;
    }

    for (const it of items) {
      let lod2Tier = 'main';
      if (items.length >= 2) {
        if (it.height <= 7.5 && it.height < maxH * 0.55 && it.areaSq < maxArea * 0.65) {
          lod2Tier = 'base';
        } else if (it.height >= maxH - 0.6 && it.areaSq <= maxArea * 0.50) {
          lod2Tier = it.areaSq <= 42 && it.height >= 22 ? 'tower' : 'attic';
        }
      }

      const cx = Math.floor(it.centX / chunkSizeM);
      const cz = Math.floor(it.centZ / chunkSizeM);
      const cKey = `${cx}_${cz}`;
      if (!targetKeySet.has(cKey)) continue;

      if (!lod2ByChunk.has(cKey)) lod2ByChunk.set(cKey, []);
      lod2ByChunk.get(cKey).push({
        id: `lod2/${it.uid}`,
        parent3dId: it.parent3dId,
        height: it.height,
        lod2Tier,
        hasCornice: lod2Tier === 'main' && it.height >= 10,
        rings: it.rings,
        areaSq: it.areaSq,
        centX: it.centX,
        centZ: it.centZ,
      });
    }
  }

  // Fusionar con metadatos ricos de OSM (nombres, cúpulas reales, edificio Metrópolis) en cada chunk destino
  let totalBuildingsCount = 0;
  let enrichedChunks = 0;
  const newChunkEntries = [];

  for (const entry of manifest.chunks) {
    if (!targetKeySet.has(entry.key)) {
      totalBuildingsCount += entry.counts.buildings;
      newChunkEntries.push(entry);
      continue;
    }

    const baseChunkPath = path.join(BASE_CHUNKS_DIR, `chunk_${entry.cx}_${entry.cz}.json`);
    const basePayload = JSON.parse(await fs.readFile(baseChunkPath, 'utf8'));
    const lod2List = lod2ByChunk.get(entry.key) ?? [];

    if (lod2List.length === 0) {
      totalBuildingsCount += entry.counts.buildings;
      newChunkEntries.push(entry);
      continue;
    }

    // Preparar índice ligero de OSM del chunk para heredar roofShape + name + Landmark IDs
    const osmMeta = basePayload.buildings.map((b) => {
      const [ox, oz] = ringCentroidMeters(b.rings[0]);
      const outerM = b.rings[0].map(([lon, lat]) => projectToMeters(lon, lat));
      return { b, ox, oz, outerM, matched: false };
    });

    // Asignar metadata OSM al sub-volumen LoD2 más cercano/compatible
    for (const m of osmMeta) {
      let best = null;
      let bestScore = Infinity;

      for (const l of lod2List) {
        const d = Math.hypot(l.centX - m.ox, l.centZ - m.oz);
        if (d > 14 && !pointInRingMeters(m.ox, m.oz, l.rings[0].map(([lo, la]) => projectToMeters(lo, la)))) {
          continue;
        }
        const hDiff = Math.abs(l.height - m.b.height);
        const score = d + hDiff * 0.5;
        if (score < bestScore) {
          bestScore = score;
          best = l;
        }
      }

      if (best) {
        m.matched = true;
        if (m.b.name && !best.name) best.name = m.b.name;
        if (m.b.roofShape && m.b.roofShape !== 'flat' && !best.roofShape) {
          best.roofShape = m.b.roofShape;
          best.roofHeight = m.b.roofHeight;
        }
        // Conservar ID especial para el hito de Edificio Metrópolis / cúpula Gran Vía
        if (m.b.id === 'way/332068538') {
          best.id = 'way/332068538';
          best.roofShape = 'dome';
          best.roofHeight = Math.max(m.b.roofHeight || 4.5, 6.2);
          best.name = best.name || 'Edificio Metrópolis';
        }
      }
    }

    // Conservar cualquier edificio OSM que no tenga equivalente LoD2 en ese punto (p. ej. pabellones recientes)
    const cleanLod2 = lod2List.map(({ areaSq: _a, centX: _cx, centZ: _cz, ...rest }) => rest);
    for (const m of osmMeta) {
      if (!m.matched) {
        // Comprobar si su centroide cae dentro de algún sub-volumen LoD2 vecino
        const covered = lod2List.some((l) =>
          pointInRingMeters(m.ox, m.oz, l.rings[0].map(([lo, la]) => projectToMeters(lo, la)))
        );
        if (!covered) {
          cleanLod2.push(m.b);
        }
      }
    }

    const enrichedPayload = {
      ...basePayload,
      buildings: cleanLod2,
    };

    const fileName = `chunk_${entry.cx}_${entry.cz}.json`;
    await fs.writeFile(path.join(LOD2_CHUNKS_DIR, fileName), JSON.stringify(enrichedPayload), 'utf8');

    totalBuildingsCount += cleanLod2.length;
    enrichedChunks++;
    newChunkEntries.push({
      ...entry,
      file: `/data/chunks-lod2/${fileName}`,
      counts: {
        ...entry.counts,
        buildings: cleanLod2.length,
      },
    });
  }

  const lod2Manifest = {
    ...manifest,
    meta: {
      ...manifest.meta,
      generatedAt: new Date().toISOString(),
      source: 'Ayuntamiento de Madrid 3D LoD2 (1:1000) + OSM',
    },
    totals: {
      ...manifest.totals,
      buildings: totalBuildingsCount,
    },
    chunks: newChunkEntries,
  };

  await fs.writeFile(path.join(LOD2_CHUNKS_DIR, 'manifest.json'), JSON.stringify(lod2Manifest), 'utf8');
  console.log(
    `\n✓ Generado public/data/chunks-lod2/manifest.json (${enrichedChunks} chunks centrales con LoD2 1:1000 real, ${totalBuildingsCount.toLocaleString('es-ES')} edificios totales).`
  );
}

main().catch((err) => {
  console.error('Error importando LoD2 de Madrid:', err);
  process.exit(1);
});

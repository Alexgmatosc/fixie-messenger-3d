/**
 * Independent opaque-box SLPK v1 binary chunk parser, projection/grid math,
 * and DEM alignment verifier.
 *
 * Implements PROJECT.md § Interface Contracts #1, #2, and #3 without importing
 * any internal converter or runtime engine modules.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  BASE_MANIFEST_EXPECTATIONS,
  CHUNK_SIZE_M,
  MAP_BBOX,
  MAX_ROOF_TYPE,
  MAX_WALL_STYLE,
  METERS_PER_DEG_LAT,
  METERS_PER_DEG_LON,
  ORIGIN_LAT,
  ORIGIN_LON,
  PATHS,
  SLPK_HEADER_BYTES,
  SLPK_MAGIC,
  SLPK_VERSION,
  UPWARD_ROOF_MIN_TOP_DIST,
} from '../fixtures/madrid-fixtures.mjs';

export function align4(n) {
  return (n + 3) & ~3;
}

export function projectToMeters(lon, lat) {
  return [
    (lon - ORIGIN_LON) * METERS_PER_DEG_LON,
    -(lat - ORIGIN_LAT) * METERS_PER_DEG_LAT,
  ];
}

export function unprojectFromMeters(x, z) {
  return [
    ORIGIN_LON + x / METERS_PER_DEG_LON,
    ORIGIN_LAT - z / METERS_PER_DEG_LAT,
  ];
}

export function chunkCoordsForXZ(x, z) {
  return {
    cx: Math.floor(x / CHUNK_SIZE_M),
    cz: Math.floor(z / CHUNK_SIZE_M),
  };
}

export function chunkKeyForXZ(x, z) {
  const { cx, cz } = chunkCoordsForXZ(x, z);
  return `${cx}_${cz}`;
}

export function chunkBoundsForKey(key) {
  const match = /^(-?\d+)_(-?\d+)$/.exec(String(key));
  if (!match) {
    throw new assert.AssertionError({ message: `Invalid chunk key format: "${key}"` });
  }
  const cx = Number(match[1]);
  const cz = Number(match[2]);
  return {
    cx,
    cz,
    minX: cx * CHUNK_SIZE_M,
    maxX: (cx + 1) * CHUNK_SIZE_M,
    minZ: cz * CHUNK_SIZE_M,
    maxZ: (cz + 1) * CHUNK_SIZE_M,
  };
}

export function loadJsonFile(filePath, label = filePath) {
  assert.ok(fs.existsSync(filePath), `Expected ${label} to exist at ${filePath}`);
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

/**
 * Resolves a manifest entry's `file` or `meshFile` reference to an on-disk path.
 * Handles both "/data/chunks-slpk/chunk_0_0.bin" URLs and relative "chunk_0_0.bin" names,
 * as well as temp --out-dir outputs where meshFile may still carry a "/data/..." prefix.
 */
export function resolveManifestChunkPath(ref, { baseDir, publicRoot = path.join(PATHS.repoRoot, 'public') }) {
  assert.ok(typeof ref === 'string' && ref.length > 0, 'Expected non-empty manifest file reference');
  if (baseDir) {
    const direct = path.join(baseDir, ref);
    if (fs.existsSync(direct)) return direct;
    const byBasename = path.join(baseDir, path.basename(ref));
    if (fs.existsSync(byBasename)) return byBasename;
  }
  if (ref.startsWith('/')) {
    const fromPublic = path.join(publicRoot, ref.replace(/^\/+/, ''));
    if (fs.existsSync(fromPublic)) return fromPublic;
  }
  return baseDir ? path.join(baseDir, path.basename(ref)) : path.join(publicRoot, ref);
}

let cachedBaseManifest = null;
export function loadBaseManifest() {
  if (!cachedBaseManifest) {
    cachedBaseManifest = loadJsonFile(PATHS.baseManifest, 'base OSM manifest');
  }
  return cachedBaseManifest;
}

export function createTerrainEvaluator(dem, exaggeration = 1.0) {
  assert.ok(dem && typeof dem === 'object', 'DEM grid object is required');
  assert.ok(Array.isArray(dem.values) && dem.values.length === dem.cols * dem.rows, 'Invalid DEM values array');

  return {
    dem,
    getHeightAtLonLat(lon, lat) {
      const { cols, rows, bbox, values } = dem;
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

      const v00 = values[y0 * cols + x0] ?? 0;
      const v10 = values[y0 * cols + x1] ?? 0;
      const v01 = values[y1 * cols + x0] ?? 0;
      const v11 = values[y1 * cols + x1] ?? 0;

      const h0 = v00 * (1 - tx) + v10 * tx;
      const h1 = v01 * (1 - tx) + v11 * tx;
      return (h0 * (1 - ty) + h1 * ty) * exaggeration;
    },
    getHeightAtXZ(x, z) {
      const [lon, lat] = unprojectFromMeters(x, z);
      return this.getHeightAtLonLat(lon, lat);
    },
    getAbsoluteElevationAtXZ(x, z) {
      return dem.originElevationM + this.getHeightAtXZ(x, z) / (exaggeration || 1);
    },
  };
}

function toUint8View(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  throw new assert.AssertionError({ message: 'Expected Buffer, Uint8Array, or ArrayBuffer for SLPK binary chunk' });
}

function copyAlignedFloat32(bytes, byteOffset, count) {
  const byteLen = count * 4;
  if ((bytes.byteOffset + byteOffset) % 4 === 0) {
    return new Float32Array(bytes.buffer, bytes.byteOffset + byteOffset, count);
  }
  const copy = bytes.slice(byteOffset, byteOffset + byteLen);
  return new Float32Array(copy.buffer, copy.byteOffset, count);
}

function copyAlignedUint32(bytes, byteOffset, count) {
  const byteLen = count * 4;
  if ((bytes.byteOffset + byteOffset) % 4 === 0) {
    return new Uint32Array(bytes.buffer, bytes.byteOffset + byteOffset, count);
  }
  const copy = bytes.slice(byteOffset, byteOffset + byteLen);
  return new Uint32Array(copy.buffer, copy.byteOffset, count);
}

/**
 * Parses and validates the SLPK v1 binary chunk layout (PROJECT.md § Contract 3).
 * Throws AssertionError on any header, alignment, or byte-length mismatch.
 */
export function parseSlpkChunk(rawBuffer) {
  const bytes = toUint8View(rawBuffer);
  assert.ok(
    bytes.byteLength >= SLPK_HEADER_BYTES,
    `SLPK chunk truncated: expected >= ${SLPK_HEADER_BYTES} bytes, got ${bytes.byteLength}`
  );

  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = dv.getUint32(0, true);
  assert.equal(
    magic,
    SLPK_MAGIC,
    `Invalid SLPK magic: expected 0x${SLPK_MAGIC.toString(16)}, got 0x${magic.toString(16)}`
  );

  const version = dv.getUint32(4, true);
  assert.equal(version, SLPK_VERSION, `Unsupported SLPK version: expected ${SLPK_VERSION}, got ${version}`);

  const vertexCount = dv.getUint32(8, true);
  const indexCount = dv.getUint32(12, true);
  const buildingCount = dv.getUint32(16, true);
  const flags = dv.getUint32(20, true);
  const reserved0 = dv.getUint32(24, true);
  const reserved1 = dv.getUint32(28, true);

  assert.equal(reserved0, 0, `SLPK header reserved0 must be 0, got ${reserved0}`);
  assert.equal(reserved1, 0, `SLPK header reserved1 must be 0, got ${reserved1}`);

  const expectedIndexedFlag = indexCount > 0 ? 1 : 0;
  assert.equal(
    flags & 1,
    expectedIndexedFlag,
    `SLPK header flags bit 0 (${flags & 1}) inconsistent with indexCount=${indexCount}`
  );

  if (indexCount > 0) {
    assert.equal(indexCount % 3, 0, `indexCount (${indexCount}) must be a multiple of 3`);
  } else {
    assert.equal(vertexCount % 3, 0, `Non-indexed vertexCount (${vertexCount}) must be a multiple of 3`);
  }

  const posBytes = vertexCount * 12;
  const normBytes = vertexCount * 12;
  const colorBytes = align4(vertexCount * 3);
  const localHeightBytes = vertexCount * 4;
  const topDistBytes = vertexCount * 4;
  const roofTypeBytes = align4(vertexCount);
  const wallStyleBytes = align4(vertexCount);
  const indexBytes = indexCount > 0 ? indexCount * 4 : 0;

  const expectedByteLength =
    SLPK_HEADER_BYTES +
    posBytes +
    normBytes +
    colorBytes +
    localHeightBytes +
    topDistBytes +
    roofTypeBytes +
    wallStyleBytes +
    indexBytes;

  assert.equal(
    bytes.byteLength,
    expectedByteLength,
    `SLPK byteLength mismatch: expected ${expectedByteLength} bytes (V=${vertexCount}, I=${indexCount}), got ${bytes.byteLength}`
  );

  let offset = SLPK_HEADER_BYTES;
  const positions = copyAlignedFloat32(bytes, offset, vertexCount * 3);
  offset += posBytes;

  const normals = copyAlignedFloat32(bytes, offset, vertexCount * 3);
  offset += normBytes;

  const colors = bytes.subarray(offset, offset + vertexCount * 3);
  offset += colorBytes;

  const aLocalHeight = copyAlignedFloat32(bytes, offset, vertexCount);
  offset += localHeightBytes;

  const aTopDist = copyAlignedFloat32(bytes, offset, vertexCount);
  offset += topDistBytes;

  const aRoofType = bytes.subarray(offset, offset + vertexCount);
  offset += roofTypeBytes;

  const aWallStyle = bytes.subarray(offset, offset + vertexCount);
  offset += wallStyleBytes;

  const indices = indexCount > 0 ? copyAlignedUint32(bytes, offset, indexCount) : null;

  return {
    header: {
      magic,
      version,
      vertexCount,
      indexCount,
      buildingCount,
      flags,
      reserved0,
      reserved1,
    },
    byteLength: bytes.byteLength,
    positions,
    normals,
    colors,
    aLocalHeight,
    aTopDist,
    aRoofType,
    aWallStyle,
    indices,
  };
}

export function readAndParseSlpkChunk(filePath) {
  assert.ok(fs.existsSync(filePath), `Expected SLPK .bin file to exist at ${filePath}`);
  const buf = fs.readFileSync(filePath);
  return parseSlpkChunk(buf);
}

/**
 * Validates vertex attributes, world bounds, normals, and outward CCW winding
 * of a parsed SLPK v1 chunk buffer. Returns detailed geometry metrics.
 */
export function validateSlpkChunkGeometry(parsed, options = {}) {
  const {
    chunkKey = null,
    requireNonEmpty = false,
    centroidMarginM = 350,
    minOutwardWindingRatio = 0.99,
    minNormalLen = 0.95,
    maxNormalLen = 1.05,
    upwardRoofMinTopDist = UPWARD_ROOF_MIN_TOP_DIST,
    terrain = null,
  } = options;

  const {
    header: { vertexCount, indexCount, buildingCount },
    positions,
    normals,
    colors,
    aLocalHeight,
    aTopDist,
    aRoofType,
    aWallStyle,
    indices,
  } = parsed;

  if (requireNonEmpty) {
    assert.ok(vertexCount > 0, 'Expected non-empty SLPK chunk (vertexCount > 0)');
    assert.ok(buildingCount > 0, 'Expected buildingCount > 0 in non-empty SLPK chunk');
  }

  let chunkBounds = null;
  if (chunkKey) {
    chunkBounds = chunkBoundsForKey(chunkKey);
  }

  const [swX, swZ] = projectToMeters(MAP_BBOX[0], MAP_BBOX[1]);
  const [neX, neZ] = projectToMeters(MAP_BBOX[2], MAP_BBOX[3]);
  const worldMinX = Math.min(swX, neX) - 1000;
  const worldMaxX = Math.max(swX, neX) + 1000;
  const worldMinZ = Math.min(swZ, neZ) - 1000;
  const worldMaxZ = Math.max(swZ, neZ) + 1000;

  const demMinRel = BASE_MANIFEST_EXPECTATIONS.dem.minElevationM - BASE_MANIFEST_EXPECTATIONS.dem.originElevationM;
  const demMaxRel = BASE_MANIFEST_EXPECTATIONS.dem.maxElevationM - BASE_MANIFEST_EXPECTATIONS.dem.originElevationM;

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  let nonZeroColors = 0;

  const roofTypeCounts = new Uint32Array(MAX_ROOF_TYPE + 1);
  const wallStyleCounts = new Uint32Array(MAX_WALL_STYLE + 1);

  for (let i = 0; i < vertexCount; i++) {
    const px = positions[i * 3];
    const py = positions[i * 3 + 1];
    const pz = positions[i * 3 + 2];
    assert.ok(
      Number.isFinite(px) && Number.isFinite(py) && Number.isFinite(pz),
      `Non-finite position at vertex ${i}: (${px}, ${py}, ${pz})`
    );
    assert.ok(
      px >= worldMinX && px <= worldMaxX && pz >= worldMinZ && pz <= worldMaxZ,
      `Vertex ${i} out of Madrid world bounds: (${px.toFixed(2)}, ${pz.toFixed(2)})`
    );
    assert.ok(
      py >= demMinRel - 60 && py <= demMaxRel + 400,
      `Vertex ${i} Y=${py.toFixed(2)} outside plausible elevation range [${demMinRel - 60}, ${demMaxRel + 400}]`
    );
    if (chunkBounds) {
      assert.ok(
        px >= chunkBounds.minX - centroidMarginM &&
          px <= chunkBounds.maxX + centroidMarginM &&
          pz >= chunkBounds.minZ - centroidMarginM &&
          pz <= chunkBounds.maxZ + centroidMarginM,
        `Vertex ${i} (${px.toFixed(1)}, ${pz.toFixed(1)}) far outside chunk ${chunkKey} bounds [${chunkBounds.minX}..${chunkBounds.maxX}, ${chunkBounds.minZ}..${chunkBounds.maxZ}]`
      );
    }

    if (px < minX) minX = px;
    if (px > maxX) maxX = px;
    if (py < minY) minY = py;
    if (py > maxY) maxY = py;
    if (pz < minZ) minZ = pz;
    if (pz > maxZ) maxZ = pz;

    const nx = normals[i * 3];
    const ny = normals[i * 3 + 1];
    const nz = normals[i * 3 + 2];
    assert.ok(
      Number.isFinite(nx) && Number.isFinite(ny) && Number.isFinite(nz),
      `Non-finite normal at vertex ${i}: (${nx}, ${ny}, ${nz})`
    );
    const nLen = Math.hypot(nx, ny, nz);
    assert.ok(
      nLen >= minNormalLen && nLen <= maxNormalLen,
      `Non-unit normal at vertex ${i}: |n|=${nLen.toFixed(4)} (${nx}, ${ny}, ${nz})`
    );

    const lh = aLocalHeight[i];
    const td = aTopDist[i];
    assert.ok(Number.isFinite(lh) && lh >= 0, `Invalid aLocalHeight at vertex ${i}: ${lh}`);
    assert.ok(Number.isFinite(td) && td >= 0, `Invalid aTopDist at vertex ${i}: ${td}`);

    const rt = aRoofType[i];
    const ws = aWallStyle[i];
    assert.ok(rt <= MAX_ROOF_TYPE, `Invalid aRoofType=${rt} at vertex ${i} (expected 0..${MAX_ROOF_TYPE})`);
    assert.ok(ws <= MAX_WALL_STYLE, `Invalid aWallStyle=${ws} at vertex ${i} (expected 0..${MAX_WALL_STYLE})`);
    roofTypeCounts[rt]++;
    wallStyleCounts[ws]++;

    if ((rt === 1 || rt === 2 || rt === 4) && ny > 0.5) {
      assert.ok(
        td >= upwardRoofMinTopDist,
        `Upward roof vertex ${i} (aRoofType=${rt}, ny=${ny.toFixed(3)}) has aTopDist=${td.toFixed(3)} < ${upwardRoofMinTopDist}`
      );
    }

    const r = colors[i * 3];
    const g = colors[i * 3 + 1];
    const b = colors[i * 3 + 2];
    if (r > 0 || g > 0 || b > 0) nonZeroColors++;
  }

  if (vertexCount > 0) {
    assert.ok(nonZeroColors > 0, 'All vertex colors are black (0,0,0)');
  }

  const triangleCount = indices ? indexCount / 3 : vertexCount / 3;
  let outwardCount = 0;
  let inwardCount = 0;
  let degenerateCount = 0;
  let slopedRoofTriangles = 0;
  let upwardRoofTriangles = 0;
  let horizontalWallTriangles = 0;

  for (let t = 0; t < triangleCount; t++) {
    const i0 = indices ? indices[t * 3] : t * 3;
    const i1 = indices ? indices[t * 3 + 1] : t * 3 + 1;
    const i2 = indices ? indices[t * 3 + 2] : t * 3 + 2;

    assert.ok(
      i0 < vertexCount && i1 < vertexCount && i2 < vertexCount,
      `Triangle ${t} index out of bounds (${i0}, ${i1}, ${i2}) >= vertexCount (${vertexCount})`
    );

    const ax = positions[i0 * 3];
    const ay = positions[i0 * 3 + 1];
    const az = positions[i0 * 3 + 2];
    const bx = positions[i1 * 3];
    const by = positions[i1 * 3 + 1];
    const bz = positions[i1 * 3 + 2];
    const cx = positions[i2 * 3];
    const cy = positions[i2 * 3 + 1];
    const cz = positions[i2 * 3 + 2];

    const e1x = bx - ax;
    const e1y = by - ay;
    const e1z = bz - az;
    const e2x = cx - ax;
    const e2y = cy - ay;
    const e2z = cz - az;

    const fx = e1y * e2z - e1z * e2y;
    const fy = e1z * e2x - e1x * e2z;
    const fz = e1x * e2y - e1y * e2x;
    const crossLen = Math.hypot(fx, fy, fz);

    if (crossLen <= 1e-4) {
      degenerateCount++;
      continue;
    }

    const avgNx = (normals[i0 * 3] + normals[i1 * 3] + normals[i2 * 3]) / 3;
    const avgNy = (normals[i0 * 3 + 1] + normals[i1 * 3 + 1] + normals[i2 * 3 + 1]) / 3;
    const avgNz = (normals[i0 * 3 + 2] + normals[i1 * 3 + 2] + normals[i2 * 3 + 2]) / 3;

    const dot = fx * avgNx + fy * avgNy + fz * avgNz;
    if (dot > 0) {
      outwardCount++;
    } else if (dot < 0) {
      inwardCount++;
    }

    const unitFy = Math.abs(fy / crossLen);
    if (avgNy > 0.05 && avgNy < 0.995) {
      slopedRoofTriangles++;
    }
    if (avgNy > 0.5) {
      upwardRoofTriangles++;
    }
    if (Math.abs(avgNy) < 0.25 && unitFy < 0.25) {
      horizontalWallTriangles++;
    }
  }

  const nonDegenerate = outwardCount + inwardCount;
  const outwardWindingRatio = nonDegenerate > 0 ? outwardCount / nonDegenerate : 1.0;

  if (nonDegenerate > 0) {
    assert.ok(
      outwardWindingRatio >= minOutwardWindingRatio,
      `Outward CCW winding ratio too low: ${outwardCount}/${nonDegenerate} (${(outwardWindingRatio * 100).toFixed(2)}%, expected >= ${(minOutwardWindingRatio * 100).toFixed(2)}%)`
    );
  }

  let terrainSamples = null;
  if (terrain && vertexCount > 0) {
    // Sample base/low-aLocalHeight vertices to measure alignment to local DEM
    const deltas = [];
    const step = Math.max(1, Math.floor(vertexCount / 2000));
    for (let i = 0; i < vertexCount; i += step) {
      if (aLocalHeight[i] <= 1.0) {
        const x = positions[i * 3];
        const y = positions[i * 3 + 1];
        const z = positions[i * 3 + 2];
        const groundY = terrain.getHeightAtXZ(x, z);
        deltas.push(y - groundY);
      }
    }
    if (deltas.length > 0) {
      deltas.sort((a, b) => a - b);
      terrainSamples = {
        count: deltas.length,
        minDelta: deltas[0],
        medianDelta: deltas[Math.floor(deltas.length / 2)],
        maxDelta: deltas[deltas.length - 1],
      };
    }
  }

  return {
    vertexCount,
    indexCount,
    buildingCount,
    triangleCount,
    nonDegenerateTriangles: nonDegenerate,
    degenerateTriangles: degenerateCount,
    outwardCount,
    inwardCount,
    outwardWindingRatio,
    slopedRoofTriangles,
    upwardRoofTriangles,
    horizontalWallTriangles,
    roofTypeCounts: Array.from(roofTypeCounts),
    wallStyleCounts: Array.from(wallStyleCounts),
    bounds: vertexCount > 0 ? { minX, maxX, minY, maxY, minZ, maxZ } : null,
    terrainSamples,
  };
}

/**
 * Samples vertices inside a spatial XZ box from a parsed SLPK chunk.
 */
export function filterVerticesInBox(parsed, { minX, maxX, minZ, maxZ }) {
  const {
    header: { vertexCount },
    positions,
    normals,
    aLocalHeight,
    aTopDist,
    aRoofType,
    aWallStyle,
  } = parsed;

  const matched = [];
  for (let i = 0; i < vertexCount; i++) {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];
    if (x >= minX && x <= maxX && z >= minZ && z <= maxZ) {
      matched.push({
        index: i,
        x,
        y,
        z,
        ny: normals[i * 3 + 1],
        aLocalHeight: aLocalHeight[i],
        aTopDist: aTopDist[i],
        aRoofType: aRoofType[i],
        aWallStyle: aWallStyle[i],
      });
    }
  }
  return matched;
}

/**
 * Counts triangles whose centroid lies inside a spatial XZ box.
 */
export function countTrianglesInBox(parsed, { minX, maxX, minZ, maxZ }) {
  const {
    header: { vertexCount, indexCount },
    positions,
    normals,
    indices,
  } = parsed;
  const triCount = indices ? indexCount / 3 : vertexCount / 3;
  let total = 0;
  let sloped = 0;
  let minY = Infinity;
  let maxY = -Infinity;

  for (let t = 0; t < triCount; t++) {
    const i0 = indices ? indices[t * 3] : t * 3;
    const i1 = indices ? indices[t * 3 + 1] : t * 3 + 1;
    const i2 = indices ? indices[t * 3 + 2] : t * 3 + 2;
    const cx = (positions[i0 * 3] + positions[i1 * 3] + positions[i2 * 3]) / 3;
    const cz = (positions[i0 * 3 + 2] + positions[i1 * 3 + 2] + positions[i2 * 3 + 2]) / 3;
    if (cx >= minX && cx <= maxX && cz >= minZ && cz <= maxZ) {
      total++;
      const y0 = positions[i0 * 3 + 1];
      const y1 = positions[i1 * 3 + 1];
      const y2 = positions[i2 * 3 + 1];
      if (y0 < minY) minY = y0;
      if (y1 < minY) minY = y1;
      if (y2 < minY) minY = y2;
      if (y0 > maxY) maxY = y0;
      if (y1 > maxY) maxY = y1;
      if (y2 > maxY) maxY = y2;

      const avgNy = (normals[i0 * 3 + 1] + normals[i1 * 3 + 1] + normals[i2 * 3 + 1]) / 3;
      if (avgNy > 0.05 && avgNy < 0.995) {
        sloped++;
      }
    }
  }
  return {
    total,
    sloped,
    minY: total > 0 ? minY : null,
    maxY: total > 0 ? maxY : null,
  };
}

/**
 * Verifies local DEM alignment across a chunk by measuring per-cell base deltas
 * (lowest vertices near ground vs TerrainElevation.getHeightAtXZ).
 */
export function assertLocalDemAlignment(parsed, terrain, options = {}) {
  const {
    maxBaseOffsetAboveGroundM = 6.0,
    minBaseOffsetBelowGroundM = -25.0,
    cellSizeM = 50,
  } = options;

  const {
    header: { vertexCount },
    positions,
    aLocalHeight,
  } = parsed;
  assert.ok(vertexCount > 0, 'Cannot verify DEM alignment on empty chunk');

  // Group lowest vertices per 50m cell where aLocalHeight <= 0.5 (base/skirt vertices)
  const cells = new Map();
  for (let i = 0; i < vertexCount; i++) {
    if (aLocalHeight[i] > 1.0) continue;
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];
    const cellKey = `${Math.floor(x / cellSizeM)}_${Math.floor(z / cellSizeM)}`;
    const prev = cells.get(cellKey);
    if (!prev || y < prev.y) {
      cells.set(cellKey, { x, y, z });
    }
  }

  assert.ok(cells.size > 0, 'Expected base vertices (aLocalHeight <= 1.0) for DEM alignment check');
  const deltas = [];
  for (const pt of cells.values()) {
    const groundY = terrain.getHeightAtXZ(pt.x, pt.z);
    deltas.push(pt.y - groundY);
  }
  deltas.sort((a, b) => a - b);
  const medianDelta = deltas[Math.floor(deltas.length / 2)];
  assert.ok(
    medianDelta >= minBaseOffsetBelowGroundM && medianDelta <= maxBaseOffsetAboveGroundM,
    `Local DEM base median delta ${medianDelta.toFixed(2)}m out of expected range [${minBaseOffsetBelowGroundM}, ${maxBaseOffsetAboveGroundM}]`
  );
  return {
    sampledCells: cells.size,
    minDelta: deltas[0],
    medianDelta,
    maxDelta: deltas[deltas.length - 1],
  };
}

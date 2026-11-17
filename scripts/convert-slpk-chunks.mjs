#!/usr/bin/env node
/**
 * Offline Madrid LoD2 SLPK -> SLPK v1 binary chunk converter.
 *
 * Streams `MODELADO_3D_MADRID.slpk` (ZIP64 STORE + gzipped I3S v1.10 leaves),
 * projects leaf triangle meshes into Fuente de Neptuno local meters,
 * aligns building bases to `manifest.json` DEM via two-pass host/ground logic,
 * synthesizes TSL shader vertex attributes, deduplicates vertices per feature,
 * and emits compact `chunk_<cx>_<cz>.bin` + `manifest.json`.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------
// 1. Projection & DEM Constants (exact match to src/geo/projection.ts)
// ---------------------------------------------------------------------------

export const ORIGIN_LON = -3.6941;
export const ORIGIN_LAT = 40.4152;
export const METERS_PER_DEG_LON = 111320 * Math.cos((ORIGIN_LAT * Math.PI) / 180);
export const METERS_PER_DEG_LAT = 110540;
export const CHUNK_SIZE_M = 400;

export const SLPK_MAGIC = 0x4b504c53; // "SLPK" little-endian
export const SLPK_VERSION = 1;

export const PALETTE_BUILDING_TONES = [
  0xf5f0e6,
  0xeee5d5,
  0xe8dac3,
  0xf1ebdf,
  0xe4e6ea,
  0xede0cf,
];

export const INCLUDED_CAPAS = new Set([
  '01_EDIFICIO_P',
  '01_PORCHE_CASETA_COBERTIZO_P',
  '01_MARQUESINA_P',
  '06_ASCENSOR_P',
  '01_QUIOSCO_OBRA_P',
  '01_LUCERNARIO_P',
  '01_CONSTRUCCION_PERMANENTE_VIA_P',
  '01_DEPOSITO_ELEVADO_P',
  '01_GRADAS_P',
]);

export function projectToMeters(lon, lat) {
  const x = (lon - ORIGIN_LON) * METERS_PER_DEG_LON;
  const z = -(lat - ORIGIN_LAT) * METERS_PER_DEG_LAT;
  return [x === 0 ? 0 : x, z === 0 ? 0 : z];
}

export function unprojectFromMeters(x, z) {
  const lon = ORIGIN_LON + x / METERS_PER_DEG_LON;
  const lat = ORIGIN_LAT - z / METERS_PER_DEG_LAT;
  return [lon, lat];
}

export class TerrainElevation {
  constructor(dem, exaggeration = 1.0) {
    this.dem = dem;
    this.exaggeration = exaggeration;
  }

  get originElevationM() {
    return this.dem.originElevationM;
  }

  getHeightAtLonLat(lon, lat) {
    const { cols, rows, bbox, values } = this.dem;
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
    return (h0 * (1 - ty) + h1 * ty) * this.exaggeration;
  }

  getHeightAtXZ(x, z) {
    const [lon, lat] = unprojectFromMeters(x, z);
    return this.getHeightAtLonLat(lon, lat);
  }
}

// ---------------------------------------------------------------------------
// 2. ECEF -> ENU -> Three.js Normal Rotation & Math Helpers
// ---------------------------------------------------------------------------

export function computeEnuBasis(lonDeg, latDeg) {
  const lam = (lonDeg * Math.PI) / 180;
  const phi = (latDeg * Math.PI) / 180;
  const sinLam = Math.sin(lam);
  const cosLam = Math.cos(lam);
  const sinPhi = Math.sin(phi);
  const cosPhi = Math.cos(phi);
  return { sinLam, cosLam, sinPhi, cosPhi };
}

export function ecefNormalToWorld(ex, ey, ez, lonDeg, latDeg) {
  const { sinLam, cosLam, sinPhi, cosPhi } = computeEnuBasis(lonDeg, latDeg);
  return rotateEcefWithBasis(ex, ey, ez, sinLam, cosLam, sinPhi, cosPhi);
}

export function rotateEcefWithBasis(ex, ey, ez, sinLam, cosLam, sinPhi, cosPhi) {
  const e = -sinLam * ex + cosLam * ey;
  const n = -sinPhi * cosLam * ex - sinPhi * sinLam * ey + cosPhi * ez;
  const u = cosPhi * cosLam * ex + cosPhi * sinLam * ey + sinPhi * ez;
  const nx = e;
  const ny = u;
  const nz = -n;
  const len = Math.hypot(nx, ny, nz);
  if (!Number.isFinite(len) || len < 1e-12) {
    return [0, 1, 0];
  }
  return [nx / len, ny / len, nz / len];
}

export function hashString(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return (h >>> 0) / 4294967295;
}

export function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function computeFeatureColorRGB8(id3d) {
  const idKey = String(id3d);
  const hVal = hashString(idKey);
  const toneIdx = Math.min(
    PALETTE_BUILDING_TONES.length - 1,
    Math.floor(hVal * PALETTE_BUILDING_TONES.length)
  );
  const hex = PALETTE_BUILDING_TONES[toneIdx];
  const sr = ((hex >> 16) & 0xff) / 255;
  const sg = ((hex >> 8) & 0xff) / 255;
  const sb = (hex & 0xff) / 255;
  const shade = 0.96 + hashString(`${idKey}_s`) * 0.08;
  const r = Math.max(0, Math.min(255, Math.round(srgbToLinear(sr) * shade * 255)));
  const g = Math.max(0, Math.min(255, Math.round(srgbToLinear(sg) * shade * 255)));
  const b = Math.max(0, Math.min(255, Math.round(srgbToLinear(sb) * shade * 255)));
  return [r, g, b];
}

export function classifyRoofType(capa, ny, altura, worldZ) {
  if (capa === '01_MARQUESINA_P') {
    return ny > 0.15 ? 4 : 3;
  }
  if (capa === '01_LUCERNARIO_P') {
    return ny > 0.15 ? 4 : 3;
  }
  if (capa === '01_GRADAS_P' || capa === '01_CONSTRUCCION_PERMANENTE_VIA_P') {
    return ny > 0.92 ? 1 : 3;
  }
  if (ny < -0.5) {
    return 3;
  }
  if (ny > 0.92) {
    return 1;
  }
  if (ny > 0.15) {
    if (ny <= 0.55 && altura >= 18.0 && worldZ >= -2530) {
      return 4;
    }
    return 2;
  }
  if (capa === '01_PORCHE_CASETA_COBERTIZO_P' && altura < 1.8) {
    return 3;
  }
  return 0;
}

export function chooseBuildingWallStyle({ capa, id3d, altura, worldX, worldZ, hasClassicRoof }) {
  const H = altura;
  const hVal = hashString(`${String(id3d)}_ws`);
  const inNorthBusinessDistrict = worldZ < -2530;

  if (capa === '06_ASCENSOR_P') {
    if (inNorthBusinessDistrict && H >= 30) return 4;
    return hVal < 0.5 ? 1 : 3;
  }

  if (inNorthBusinessDistrict && H >= 30) {
    return 4;
  }

  const inGranViaAlcalaCorridor =
    worldX >= -1100 && worldX <= -50 && worldZ >= -600 && worldZ <= -310;
  if (inGranViaAlcalaCorridor && (H >= 18 || hasClassicRoof)) {
    return hVal > 0.78 && H < 26 ? 7 : 6;
  }

  if (!hasClassicRoof && H >= 54) {
    return 4;
  }

  if (hasClassicRoof || H >= 23) {
    return 1;
  }

  if (H >= 15) {
    if (hVal < 0.52) return 0;
    if (hVal < 0.80) return 2;
    return 1;
  }

  if (hVal < 0.36) return 2;
  if (hVal < 0.72) return 0;
  return 3;
}

// ---------------------------------------------------------------------------
// 3. ZIP / ZIP64 Random-Access Reader
// ---------------------------------------------------------------------------

function readExactSync(fd, buf, offset, length, position) {
  let totalRead = 0;
  while (totalRead < length) {
    const n = fs.readSync(
      fd,
      buf,
      offset + totalRead,
      length - totalRead,
      position + totalRead
    );
    if (n <= 0) {
      throw new Error(
        `Unexpected EOF reading ${length} bytes at offset ${position} (got ${totalRead})`
      );
    }
    totalRead += n;
  }
}

export function openSlpkReader(slpkPath) {
  const fd = fs.openSync(slpkPath, 'r');
  try {
    const stat = fs.fstatSync(fd);
    const fileSize = stat.size;
    if (fileSize < 22) {
      throw new Error(`Invalid ZIP/SLPK file (size=${fileSize}): ${slpkPath}`);
    }

    const tailLen = Math.min(65536 + 22, fileSize);
    const tailOffset = fileSize - tailLen;
    const tail = Buffer.allocUnsafe(tailLen);
    readExactSync(fd, tail, 0, tailLen, tailOffset);

    let eocdIdx = -1;
    for (let i = tailLen - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        const cmtLen = tail.readUInt16LE(i + 20);
        if (i + 22 + cmtLen === tailLen) {
          eocdIdx = i;
          break;
        }
        if (eocdIdx === -1) eocdIdx = i;
      }
    }
    if (eocdIdx === -1) {
      throw new Error(`Could not find ZIP End of Central Directory in ${slpkPath}`);
    }

    let totalEntries = tail.readUInt16LE(eocdIdx + 10);
    let cdSize = tail.readUInt32LE(eocdIdx + 12);
    let cdOffset = tail.readUInt32LE(eocdIdx + 16);

    // Check for ZIP64 EOCD Locator immediately preceding 32-bit EOCD
    if (eocdIdx >= 20 && tail.readUInt32LE(eocdIdx - 20) === 0x07064b50) {
      const z64EocdOffset = Number(tail.readBigUInt64LE(eocdIdx - 20 + 8));
      const z64Buf = Buffer.allocUnsafe(56);
      readExactSync(fd, z64Buf, 0, 56, z64EocdOffset);
      if (z64Buf.readUInt32LE(0) !== 0x06064b50) {
        throw new Error(`Invalid ZIP64 EOCD signature at offset ${z64EocdOffset}`);
      }
      totalEntries = Number(z64Buf.readBigUInt64LE(32));
      cdSize = Number(z64Buf.readBigUInt64LE(40));
      cdOffset = Number(z64Buf.readBigUInt64LE(48));
    }

    const cd = Buffer.allocUnsafe(cdSize);
    readExactSync(fd, cd, 0, cdSize, cdOffset);

    const entries = new Map();
    let pos = 0;
    while (pos < cd.length) {
      if (cd.readUInt32LE(pos) !== 0x02014b50) {
        throw new Error(`Invalid Central Directory signature at offset ${pos}`);
      }
      const flags = cd.readUInt16LE(pos + 8);
      const comp = cd.readUInt16LE(pos + 10);
      let csize = cd.readUInt32LE(pos + 20);
      let usize = cd.readUInt32LE(pos + 24);
      const fnLen = cd.readUInt16LE(pos + 28);
      const exLen = cd.readUInt16LE(pos + 30);
      const cmtLen = cd.readUInt16LE(pos + 32);
      let lhoff = cd.readUInt32LE(pos + 42);

      const encoding = (flags & 0x0800) !== 0 ? 'utf8' : 'utf8';
      const name = cd.toString(encoding, pos + 46, pos + 46 + fnLen);

      if (csize === 0xffffffff || usize === 0xffffffff || lhoff === 0xffffffff) {
        let ep = pos + 46 + fnLen;
        const end = ep + exLen;
        while (ep + 4 <= end) {
          const tag = cd.readUInt16LE(ep);
          const sz = cd.readUInt16LE(ep + 2);
          if (tag === 0x0001) {
            let vp = ep + 4;
            if (usize === 0xffffffff) {
              usize = Number(cd.readBigUInt64LE(vp));
              vp += 8;
            }
            if (csize === 0xffffffff) {
              csize = Number(cd.readBigUInt64LE(vp));
              vp += 8;
            }
            if (lhoff === 0xffffffff) {
              lhoff = Number(cd.readBigUInt64LE(vp));
              vp += 8;
            }
            break;
          }
          ep += 4 + sz;
        }
      }

      entries.set(name, { comp, csize, usize, lhoff });
      pos += 46 + fnLen + exLen + cmtLen;
    }

    const lfhBuf = Buffer.allocUnsafe(30);

    function readRawEntry(name) {
      const entry = entries.get(name);
      if (!entry) return null;
      readExactSync(fd, lfhBuf, 0, 30, entry.lhoff);
      if (lfhBuf.readUInt32LE(0) !== 0x04034b50) {
        throw new Error(`Invalid Local File Header signature for ${name} at ${entry.lhoff}`);
      }
      const fnLen = lfhBuf.readUInt16LE(26);
      const exLen = lfhBuf.readUInt16LE(28);
      const dataOffset = entry.lhoff + 30 + fnLen + exLen;
      const raw = Buffer.allocUnsafe(entry.csize);
      readExactSync(fd, raw, 0, entry.csize, dataOffset);
      if (entry.comp === 0) {
        return raw;
      }
      if (entry.comp === 8) {
        return zlib.inflateRawSync(raw);
      }
      throw new Error(`Unsupported ZIP compression method ${entry.comp} for ${name}`);
    }

    function readEntry(name) {
      const raw = readRawEntry(name);
      if (!raw) return null;
      if (name.endsWith('.gz')) {
        return zlib.gunzipSync(raw);
      }
      return raw;
    }

    function close() {
      fs.closeSync(fd);
    }

    return {
      entries,
      totalEntries,
      readRawEntry,
      readEntry,
      close,
    };
  } catch (err) {
    try {
      fs.closeSync(fd);
    } catch {
      // ignore close error
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// 4. I3S Binary Decoders (PerAttributeArray & Attribute Storage)
// ---------------------------------------------------------------------------

export function ensureAlignedBuffer(buf) {
  if ((buf.byteOffset & 7) === 0) {
    return buf;
  }
  const ab = new ArrayBuffer(buf.byteLength);
  const aligned = Buffer.from(ab);
  buf.copy(aligned);
  return aligned;
}

export function decodeGeometryBuffer(rawBuf) {
  const buf = ensureAlignedBuffer(rawBuf);
  if (buf.byteLength < 8) {
    throw new Error(`Geometry buffer too small (${buf.byteLength} bytes)`);
  }
  const vertexCount = buf.readUInt32LE(0);
  const featureCount = buf.readUInt32LE(4);
  const expectedLen = 8 + vertexCount * 36 + featureCount * 16;
  if (buf.byteLength < expectedLen) {
    throw new Error(
      `Geometry buffer truncated: got ${buf.byteLength}, expected ${expectedLen} (vc=${vertexCount}, fc=${featureCount})`
    );
  }

  const base = buf.byteOffset;
  const positions = new Float32Array(buf.buffer, base + 8, vertexCount * 3);
  const normals = new Float32Array(buf.buffer, base + 8 + vertexCount * 12, vertexCount * 3);

  const fidOff = 8 + vertexCount * 36;
  const frOff = fidOff + featureCount * 8;
  const featureIds = new Array(featureCount);
  const faceRanges = new Array(featureCount);
  for (let i = 0; i < featureCount; i++) {
    featureIds[i] = Number(buf.readBigUInt64LE(fidOff + i * 8));
    faceRanges[i] = [
      buf.readUInt32LE(frOff + i * 8),
      buf.readUInt32LE(frOff + i * 8 + 4),
    ];
  }

  return { vertexCount, featureCount, positions, normals, featureIds, faceRanges };
}

export function decodeOid32Attribute(rawBuf) {
  const buf = ensureAlignedBuffer(rawBuf);
  const count = buf.readUInt32LE(0);
  if (buf.byteLength < 4 + count * 4) {
    throw new Error(`Oid32 attribute buffer truncated (${buf.byteLength} < ${4 + count * 4})`);
  }
  const out = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    out[i] = buf.readUInt32LE(4 + i * 4);
  }
  return out;
}

export function decodeInt32Attribute(rawBuf) {
  const buf = ensureAlignedBuffer(rawBuf);
  const count = buf.readUInt32LE(0);
  if (buf.byteLength < 4 + count * 4) {
    throw new Error(`Int32 attribute buffer truncated (${buf.byteLength} < ${4 + count * 4})`);
  }
  const out = new Int32Array(count);
  for (let i = 0; i < count; i++) {
    out[i] = buf.readInt32LE(4 + i * 4);
  }
  return out;
}

export function decodeStringAttribute(rawBuf) {
  const count = rawBuf.readUInt32LE(0);
  const totalBytes = rawBuf.readUInt32LE(4);
  const headerAndCounts = 8 + count * 4;
  if (rawBuf.byteLength < headerAndCounts + totalBytes) {
    throw new Error(
      `String attribute buffer truncated (${rawBuf.byteLength} < ${headerAndCounts + totalBytes})`
    );
  }
  const out = new Array(count);
  let strOff = headerAndCounts;
  for (let i = 0; i < count; i++) {
    const byteCount = rawBuf.readUInt32LE(8 + i * 4);
    let end = strOff + byteCount;
    while (end > strOff && rawBuf[end - 1] === 0) {
      end--;
    }
    out[i] = rawBuf.toString('utf8', strOff, end);
    strOff += byteCount;
  }
  return out;
}

export function decodeFloat64Attribute(rawBuf) {
  const count = rawBuf.readUInt32LE(0);
  // I3S inserts 4 bytes of zero padding at bytes 4..7 before Float64 values at byte 8
  const expected = 8 + count * 8;
  if (rawBuf.byteLength < expected) {
    throw new Error(`Float64 attribute buffer truncated (${rawBuf.byteLength} < ${expected})`);
  }
  const out = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    out[i] = rawBuf.readDoubleLE(8 + i * 8);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 5. Leaf Selection & Spatial Host Grid
// ---------------------------------------------------------------------------

export function selectLeafNodes(reader, targetChunks) {
  const nodepageNames = [];
  for (const name of reader.entries.keys()) {
    if (name.startsWith('nodepages/') && name.endsWith('.json.gz')) {
      nodepageNames.push(name);
    }
  }
  nodepageNames.sort((a, b) => {
    const na = parseInt(a.slice('nodepages/'.length), 10);
    const nb = parseInt(b.slice('nodepages/'.length), 10);
    return na - nb;
  });

  const targetBoxes = targetChunks.map((c) => {
    const x0 = c.cx * CHUNK_SIZE_M;
    const z0 = c.cz * CHUNK_SIZE_M;
    return { x0, x1: x0 + CHUNK_SIZE_M, z0, z1: z0 + CHUNK_SIZE_M };
  });

  let minLon = Infinity;
  let maxLon = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  for (const b of targetBoxes) {
    const [lon0, lat1] = unprojectFromMeters(b.x0, b.z0);
    const [lon1, lat0] = unprojectFromMeters(b.x1, b.z1);
    if (lon0 < minLon) minLon = lon0;
    if (lon1 > maxLon) maxLon = lon1;
    if (lat0 < minLat) minLat = lat0;
    if (lat1 > maxLat) maxLat = lat1;
  }

  const leaves = [];
  for (const npName of nodepageNames) {
    const buf = reader.readEntry(npName);
    if (!buf) continue;
    const np = JSON.parse(buf.toString('utf8'));
    const nodes = np.nodes || [];
    for (const node of nodes) {
      if (node.children && node.children.length > 0) continue;
      if (!node.obb || !node.obb.center || !node.obb.halfSize || !node.mesh?.geometry) continue;

      const [lon, lat] = node.obb.center;
      const [hx, hy, hz] = node.obb.halfSize;
      const radius = Math.hypot(hx, hy, hz) + 50;
      const degPad = Math.max(0.01, radius / 80000);
      if (
        lon < minLon - degPad ||
        lon > maxLon + degPad ||
        lat < minLat - degPad ||
        lat > maxLat + degPad
      ) {
        continue;
      }

      const [lx, lz] = projectToMeters(lon, lat);
      const rSq = radius * radius;
      let overlaps = false;
      for (let i = 0; i < targetBoxes.length; i++) {
        const b = targetBoxes[i];
        const dx = lx < b.x0 ? b.x0 - lx : lx > b.x1 ? lx - b.x1 : 0;
        const dz = lz < b.z0 ? b.z0 - lz : lz > b.z1 ? lz - b.z1 : 0;
        if (dx * dx + dz * dz <= rSq) {
          overlaps = true;
          break;
        }
      }
      if (overlaps) {
        leaves.push({
          index: node.index,
          resource: node.mesh.geometry.resource ?? node.index - 1,
          obbCenter: node.obb.center,
          obbHalfSize: node.obb.halfSize,
          lx,
          lz,
          radius,
        });
      }
    }
  }

  return leaves;
}

export class HostSpatialGrid {
  constructor(cellSizeM = 50) {
    this.cellSizeM = cellSizeM;
    this.cells = new Map();
    this.byId3d = new Map();
  }

  insert(host) {
    this.byId3d.set(host.id3d, host);
    const minGX = Math.floor(host.minX / this.cellSizeM);
    const maxGX = Math.floor(host.maxX / this.cellSizeM);
    const minGZ = Math.floor(host.minZ / this.cellSizeM);
    const maxGZ = Math.floor(host.maxZ / this.cellSizeM);
    for (let gx = minGX; gx <= maxGX; gx++) {
      for (let gz = minGZ; gz <= maxGZ; gz++) {
        const key = `${gx}_${gz}`;
        let list = this.cells.get(key);
        if (!list) {
          list = [];
          this.cells.set(key, list);
        }
        list.push(host);
      }
    }
  }

  findHost(capa, cx, cz, featMinY, featMaxZ) {
    const pad = 1.5;
    const minGX = Math.floor((cx - pad) / this.cellSizeM);
    const maxGX = Math.floor((cx + pad) / this.cellSizeM);
    const minGZ = Math.floor((cz - pad) / this.cellSizeM);
    const maxGZ = Math.floor((cz + pad) / this.cellSizeM);

    let bestHost = null;
    let bestScore = Infinity;
    let bestArea = Infinity;
    const seen = new Set();

    for (let gx = minGX; gx <= maxGX; gx++) {
      for (let gz = minGZ; gz <= maxGZ; gz++) {
        const list = this.cells.get(`${gx}_${gz}`);
        if (!list) continue;
        for (let i = 0; i < list.length; i++) {
          const host = list[i];
          if (seen.has(host)) continue;
          seen.add(host);

          if (
            cx < host.minX - pad ||
            cx > host.maxX + pad ||
            cz < host.minZ - pad ||
            cz > host.maxZ + pad
          ) {
            continue;
          }

          let score;
          if (capa === '01_LUCERNARIO_P') {
            if (host.maxY_slpk < featMinY - 1.0) continue;
            score = Math.abs(host.maxY_slpk - featMinY);
          } else if (capa === '01_MARQUESINA_P') {
            if (featMinY < host.maxY_slpk - 3.0) continue;
            score = Math.abs(host.maxY_slpk - featMinY);
          } else if (capa === '06_ASCENSOR_P') {
            score = Math.abs(host.maxY_slpk - featMaxZ);
          } else {
            continue;
          }

          const area = (host.maxX - host.minX) * (host.maxZ - host.minZ);
          if (score < bestScore - 1e-6 || (Math.abs(score - bestScore) <= 1e-6 && area < bestArea)) {
            bestScore = score;
            bestArea = area;
            bestHost = host;
          }
        }
      }
    }

    return bestHost;
  }
}

// ---------------------------------------------------------------------------
// 6. Growable Chunk Mesh Accumulator & SLPK v1 Binary Packer
// ---------------------------------------------------------------------------

export function align4(n) {
  return (n + 3) & ~3;
}

export class ChunkMeshAccumulator {
  constructor(cx, cz, dedup = true) {
    this.cx = cx;
    this.cz = cz;
    this.key = `${cx}_${cz}`;
    this.dedup = dedup;
    this.buildingCount = 0;
    this.vertexCount = 0;
    this.indexCount = 0;

    this.vCap = 1024;
    this.pos = new Float32Array(this.vCap * 3);
    this.norm = new Float32Array(this.vCap * 3);
    this.col = new Uint8Array(this.vCap * 3);
    this.lh = new Float32Array(this.vCap);
    this.td = new Float32Array(this.vCap);
    this.rt = new Uint8Array(this.vCap);
    this.ws = new Uint8Array(this.vCap);

    this.iCap = dedup ? 3072 : 0;
    this.indices = dedup ? new Uint32Array(this.iCap) : null;
  }

  ensureVertexCapacity(extra) {
    const needed = this.vertexCount + extra;
    if (needed <= this.vCap) return;
    let nextCap = this.vCap;
    while (nextCap < needed) nextCap *= 2;

    const nextPos = new Float32Array(nextCap * 3);
    nextPos.set(this.pos.subarray(0, this.vertexCount * 3));
    this.pos = nextPos;

    const nextNorm = new Float32Array(nextCap * 3);
    nextNorm.set(this.norm.subarray(0, this.vertexCount * 3));
    this.norm = nextNorm;

    const nextCol = new Uint8Array(nextCap * 3);
    nextCol.set(this.col.subarray(0, this.vertexCount * 3));
    this.col = nextCol;

    const nextLh = new Float32Array(nextCap);
    nextLh.set(this.lh.subarray(0, this.vertexCount));
    this.lh = nextLh;

    const nextTd = new Float32Array(nextCap);
    nextTd.set(this.td.subarray(0, this.vertexCount));
    this.td = nextTd;

    const nextRt = new Uint8Array(nextCap);
    nextRt.set(this.rt.subarray(0, this.vertexCount));
    this.rt = nextRt;

    const nextWs = new Uint8Array(nextCap);
    nextWs.set(this.ws.subarray(0, this.vertexCount));
    this.ws = nextWs;

    this.vCap = nextCap;
  }

  ensureIndexCapacity(extra) {
    if (!this.dedup) return;
    const needed = this.indexCount + extra;
    if (needed <= this.iCap) return;
    let nextCap = this.iCap;
    while (nextCap < needed) nextCap *= 2;
    const nextIdx = new Uint32Array(nextCap);
    nextIdx.set(this.indices.subarray(0, this.indexCount));
    this.indices = nextIdx;
    this.iCap = nextCap;
  }

  pushVertex(x, y, z, nx, ny, nz, r, g, b, lh, td, rt, ws) {
    this.ensureVertexCapacity(1);
    const v = this.vertexCount;
    const v3 = v * 3;
    this.pos[v3] = x;
    this.pos[v3 + 1] = y;
    this.pos[v3 + 2] = z;
    this.norm[v3] = nx;
    this.norm[v3 + 1] = ny;
    this.norm[v3 + 2] = nz;
    this.col[v3] = r;
    this.col[v3 + 1] = g;
    this.col[v3 + 2] = b;
    this.lh[v] = lh;
    this.td[v] = td;
    this.rt[v] = rt;
    this.ws[v] = ws;
    this.vertexCount = v + 1;
    return v;
  }

  pushIndex(idx) {
    this.ensureIndexCapacity(1);
    this.indices[this.indexCount++] = idx;
  }

  toBinaryBuffer() {
    return packSlpkChunkBinary({
      vertexCount: this.vertexCount,
      indexCount: this.dedup ? this.indexCount : 0,
      buildingCount: this.buildingCount,
      position: this.pos.subarray(0, this.vertexCount * 3),
      normal: this.norm.subarray(0, this.vertexCount * 3),
      color: this.col.subarray(0, this.vertexCount * 3),
      aLocalHeight: this.lh.subarray(0, this.vertexCount),
      aTopDist: this.td.subarray(0, this.vertexCount),
      aRoofType: this.rt.subarray(0, this.vertexCount),
      aWallStyle: this.ws.subarray(0, this.vertexCount),
      indices: this.dedup ? this.indices.subarray(0, this.indexCount) : null,
    });
  }
}

export function packSlpkChunkBinary({
  vertexCount,
  indexCount,
  buildingCount,
  position,
  normal,
  color,
  aLocalHeight,
  aTopDist,
  aRoofType,
  aWallStyle,
  indices,
}) {
  const V = vertexCount;
  const I = indices ? indexCount : 0;
  const flags = I > 0 ? 1 : 0;

  const off0 = 32;
  const off1 = off0 + V * 12;
  const off2 = off1 + V * 12;
  const off3 = off2 + align4(V * 3);
  const off4 = off3 + V * 4;
  const off5 = off4 + V * 4;
  const off6 = off5 + align4(V);
  const off7 = off6 + align4(V);
  const totalBytes = off7 + I * 4;

  const ab = new ArrayBuffer(totalBytes);
  const header = new Uint32Array(ab, 0, 8);
  header[0] = SLPK_MAGIC;
  header[1] = SLPK_VERSION;
  header[2] = V;
  header[3] = I;
  header[4] = buildingCount;
  header[5] = flags;
  header[6] = 0;
  header[7] = 0;

  new Float32Array(ab, off0, V * 3).set(position.subarray(0, V * 3));
  new Float32Array(ab, off1, V * 3).set(normal.subarray(0, V * 3));
  new Uint8Array(ab, off2, V * 3).set(color.subarray(0, V * 3));
  new Float32Array(ab, off3, V).set(aLocalHeight.subarray(0, V));
  new Float32Array(ab, off4, V).set(aTopDist.subarray(0, V));
  new Uint8Array(ab, off5, V).set(aRoofType.subarray(0, V));
  new Uint8Array(ab, off6, V).set(aWallStyle.subarray(0, V));
  if (I > 0 && indices) {
    new Uint32Array(ab, off7, I).set(indices.subarray(0, I));
  }

  return Buffer.from(ab);
}

// ---------------------------------------------------------------------------
// 7. Leaf Feature Extraction & Terrain-Aligned Emission
// ---------------------------------------------------------------------------

export function extractLeafFeatureTriangles(geom, featIdx, obbCenter) {
  const [lon0, lat0, z0] = obbCenter;
  const [startFace, endFace] = geom.faceRanges[featIdx];
  const triTotal = endFace - startFace + 1;
  if (triTotal <= 0) return null;

  const basis = computeEnuBasis(lon0, lat0);
  const { positions, normals } = geom;

  // Each valid triangle contributes 9 pos floats + 9 norm floats
  const trisPos = new Float32Array(triTotal * 9);
  const trisNorm = new Float32Array(triTotal * 9);
  let validTris = 0;

  let sumX = 0;
  let sumZ = 0;
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  let minYSlpk = Infinity;
  let maxYSlpk = -Infinity;

  for (let f = startFace; f <= endFace; f++) {
    const vBase = f * 3;
    const pBase0 = vBase * 3;
    const pBase1 = pBase0 + 3;
    const pBase2 = pBase0 + 6;

    const dLon0 = positions[pBase0];
    const dLat0 = positions[pBase0 + 1];
    const dZ0 = positions[pBase0 + 2];
    const dLon1 = positions[pBase1];
    const dLat1 = positions[pBase1 + 1];
    const dZ1 = positions[pBase1 + 2];
    const dLon2 = positions[pBase2];
    const dLat2 = positions[pBase2 + 1];
    const dZ2 = positions[pBase2 + 2];

    if (
      !Number.isFinite(dLon0) ||
      !Number.isFinite(dLat0) ||
      !Number.isFinite(dZ0) ||
      !Number.isFinite(dLon1) ||
      !Number.isFinite(dLat1) ||
      !Number.isFinite(dZ1) ||
      !Number.isFinite(dLon2) ||
      !Number.isFinite(dLat2) ||
      !Number.isFinite(dZ2)
    ) {
      continue;
    }

    const px0 = (lon0 + dLon0 - ORIGIN_LON) * METERS_PER_DEG_LON;
    const pz0 = -(lat0 + dLat0 - ORIGIN_LAT) * METERS_PER_DEG_LAT;
    const py0 = z0 + dZ0;

    const px1 = (lon0 + dLon1 - ORIGIN_LON) * METERS_PER_DEG_LON;
    const pz1 = -(lat0 + dLat1 - ORIGIN_LAT) * METERS_PER_DEG_LAT;
    const py1 = z0 + dZ1;

    const px2 = (lon0 + dLon2 - ORIGIN_LON) * METERS_PER_DEG_LON;
    const pz2 = -(lat0 + dLat2 - ORIGIN_LAT) * METERS_PER_DEG_LAT;
    const py2 = z0 + dZ2;

    const e1x = px1 - px0;
    const e1y = py1 - py0;
    const e1z = pz1 - pz0;
    const e2x = px2 - px0;
    const e2y = py2 - py0;
    const e2z = pz2 - pz0;

    const crx = e1y * e2z - e1z * e2y;
    const cry = e1z * e2x - e1x * e2z;
    const crz = e1x * e2y - e1y * e2x;
    const crossLenSq = crx * crx + cry * cry + crz * crz;
    if (!Number.isFinite(crossLenSq) || crossLenSq < 1e-20) {
      continue;
    }

    const outBase = validTris * 9;
    trisPos[outBase] = px0;
    trisPos[outBase + 1] = py0;
    trisPos[outBase + 2] = pz0;
    trisPos[outBase + 3] = px1;
    trisPos[outBase + 4] = py1;
    trisPos[outBase + 5] = pz1;
    trisPos[outBase + 6] = px2;
    trisPos[outBase + 7] = py2;
    trisPos[outBase + 8] = pz2;

    let geoNx = 0;
    let geoNy = 1;
    let geoNz = 0;
    let geoComputed = false;

    for (let k = 0; k < 3; k++) {
      const nOff = pBase0 + k * 3;
      const ex = normals[nOff];
      const ey = normals[nOff + 1];
      const ez = normals[nOff + 2];
      const eLen = Math.hypot(ex, ey, ez);
      let wx;
      let wy;
      let wz;
      if (!Number.isFinite(eLen) || eLen < 1e-5) {
        if (!geoComputed) {
          const crossLen = Math.sqrt(crossLenSq);
          geoNx = crx / crossLen;
          geoNy = cry / crossLen;
          geoNz = crz / crossLen;
          geoComputed = true;
        }
        wx = geoNx;
        wy = geoNy;
        wz = geoNz;
      } else {
        [wx, wy, wz] = rotateEcefWithBasis(
          ex,
          ey,
          ez,
          basis.sinLam,
          basis.cosLam,
          basis.sinPhi,
          basis.cosPhi
        );
      }
      trisNorm[outBase + k * 3] = wx;
      trisNorm[outBase + k * 3 + 1] = wy;
      trisNorm[outBase + k * 3 + 2] = wz;
    }

    validTris++;

    sumX += px0 + px1 + px2;
    sumZ += pz0 + pz1 + pz2;
    if (px0 < minX) minX = px0;
    if (px1 < minX) minX = px1;
    if (px2 < minX) minX = px2;
    if (px0 > maxX) maxX = px0;
    if (px1 > maxX) maxX = px1;
    if (px2 > maxX) maxX = px2;

    if (pz0 < minZ) minZ = pz0;
    if (pz1 < minZ) minZ = pz1;
    if (pz2 < minZ) minZ = pz2;
    if (pz0 > maxZ) maxZ = pz0;
    if (pz1 > maxZ) maxZ = pz1;
    if (pz2 > maxZ) maxZ = pz2;

    if (py0 < minYSlpk) minYSlpk = py0;
    if (py1 < minYSlpk) minYSlpk = py1;
    if (py2 < minYSlpk) minYSlpk = py2;
    if (py0 > maxYSlpk) maxYSlpk = py0;
    if (py1 > maxYSlpk) maxYSlpk = py1;
    if (py2 > maxYSlpk) maxYSlpk = py2;
  }

  if (validTris === 0) return null;
  const vertTotal = validTris * 3;
  return {
    triCount: validTris,
    trisPos: trisPos.subarray(0, validTris * 9),
    trisNorm: trisNorm.subarray(0, validTris * 9),
    cx: sumX / vertTotal,
    cz: sumZ / vertTotal,
    minX,
    maxX,
    minZ,
    maxZ,
    minYSlpk,
    maxYSlpk,
  };
}

export function computeEdificioHostRecord(geomFeat, id3d, altura, terrain) {
  const slpkGroundZ = geomFeat.maxYSlpk - altura;
  const { trisPos, triCount, cx, cz } = geomFeat;

  const seenGround = new Set();
  let sumDem = 0;
  let countDem = 0;
  const thresh = slpkGroundZ + 1.0;

  for (let t = 0; t < triCount; t++) {
    const base = t * 9;
    for (let k = 0; k < 3; k++) {
      const vx = trisPos[base + k * 3];
      const vy = trisPos[base + k * 3 + 1];
      const vz = trisPos[base + k * 3 + 2];
      if (vy <= thresh) {
        const gKey = `${Math.round(vx * 100)}_${Math.round(vz * 100)}`;
        if (!seenGround.has(gKey)) {
          seenGround.add(gKey);
          sumDem += terrain.getHeightAtXZ(vx, vz);
          countDem++;
        }
      }
    }
  }

  const demBaseY = countDem > 0 ? sumDem / countDem : terrain.getHeightAtXZ(cx, cz);
  const deltaY = demBaseY - (slpkGroundZ - terrain.originElevationM);

  return {
    id3d,
    minX: geomFeat.minX,
    maxX: geomFeat.maxX,
    minZ: geomFeat.minZ,
    maxZ: geomFeat.maxZ,
    maxY_slpk: geomFeat.maxYSlpk,
    deltaY,
    slpkGroundZ,
  };
}

export function emitFeatureToAccumulator({
  acc,
  geomFeat,
  id3d,
  capa,
  altura,
  terrain,
  hostGrid,
  featVertMap,
}) {
  const { trisPos, trisNorm, triCount, cx, cz, minYSlpk, maxYSlpk } = geomFeat;
  const slpkGroundZ = maxYSlpk - altura;

  let deltaY;
  let effectiveGroundZ = slpkGroundZ;
  const isHostEligible =
    capa === '01_LUCERNARIO_P' ||
    capa === '01_MARQUESINA_P' ||
    capa === '06_ASCENSOR_P';

  if (capa === '01_EDIFICIO_P') {
    const cachedHost = hostGrid.byId3d.get(id3d);
    if (cachedHost) {
      deltaY = cachedHost.deltaY;
    } else {
      const computed = computeEdificioHostRecord(geomFeat, id3d, altura, terrain);
      deltaY = computed.deltaY;
    }
  } else if (isHostEligible && hostGrid) {
    const host = hostGrid.findHost(capa, cx, cz, minYSlpk, maxYSlpk);
    if (host) {
      deltaY = host.deltaY;
      if (capa === '01_LUCERNARIO_P' || capa === '01_MARQUESINA_P') {
        effectiveGroundZ = host.slpkGroundZ;
      }
    } else {
      const demBaseY = terrain.getHeightAtXZ(cx, cz);
      deltaY = demBaseY - (slpkGroundZ - terrain.originElevationM);
    }
  } else {
    const demBaseY = terrain.getHeightAtXZ(cx, cz);
    deltaY = demBaseY - (slpkGroundZ - terrain.originElevationM);
  }

  const originElev = terrain.originElevationM;
  const isGroundResting = capa !== '01_LUCERNARIO_P' && capa !== '01_MARQUESINA_P';

  // Downward soffit vertices (ny < -0.5) & per-column min/max Y & classic-roof counts
  const downVertKeys = isGroundResting ? new Set() : null;
  const colMaxY = new Map();
  const colMinY = new Map();
  let totalUpTris = 0;
  let slopedOrSteepUpTris = 0;

  for (let t = 0; t < triCount; t++) {
    const pBase = t * 9;
    const ny0 = trisNorm[pBase + 1];
    const ny1 = trisNorm[pBase + 4];
    const ny2 = trisNorm[pBase + 7];
    const triNy = (ny0 + ny1 + ny2) / 3;

    if (triNy > 0.15) {
      totalUpTris++;
      if (triNy <= 0.92) {
        slopedOrSteepUpTris++;
      }
    }

    for (let k = 0; k < 3; k++) {
      const vx = trisPos[pBase + k * 3];
      const vySlpk = trisPos[pBase + k * 3 + 1];
      const vz = trisPos[pBase + k * 3 + 2];
      const vny = trisNorm[pBase + k * 3 + 1];

      if (isGroundResting && (triNy < -0.5 || vny < -0.5)) {
        downVertKeys.add(
          `${Math.round(vx * 1000)}_${Math.round(vySlpk * 1000)}_${Math.round(vz * 1000)}`
        );
      }

      const colKey = `${Math.round(vx * 100)}_${Math.round(vz * 100)}`;
      const prevMax = colMaxY.get(colKey);
      if (prevMax === undefined || vySlpk > prevMax) {
        colMaxY.set(colKey, vySlpk);
      }
      const prevMin = colMinY.get(colKey);
      if (prevMin === undefined || vySlpk < prevMin) {
        colMinY.set(colKey, vySlpk);
      }
    }
  }

  const hasClassicRoof =
    slopedOrSteepUpTris >= 6 || (totalUpTris > 0 && slopedOrSteepUpTris / totalUpTris >= 0.08);
  const wallStyle = chooseBuildingWallStyle({
    capa,
    id3d,
    altura,
    worldX: cx,
    worldZ: cz,
    hasClassicRoof,
  });
  const [cr, cg, cb] = computeFeatureColorRGB8(id3d);

  const groundClampThreshold = slpkGroundZ + 0.2;
  const maxZClampCap = maxYSlpk - 0.5;

  if (acc.dedup) {
    featVertMap.clear();
  }

  for (let t = 0; t < triCount; t++) {
    const pBase = t * 9;
    const triNy =
      (trisNorm[pBase + 1] + trisNorm[pBase + 4] + trisNorm[pBase + 7]) / 3;
    const isWallTri = isGroundResting && Math.abs(triNy) <= 0.2;

    const triIndices = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      const vx = trisPos[pBase + k * 3];
      const vySlpk = trisPos[pBase + k * 3 + 1];
      const vz = trisPos[pBase + k * 3 + 2];
      const nx = trisNorm[pBase + k * 3];
      const ny = trisNorm[pBase + k * 3 + 1];
      const nz = trisNorm[pBase + k * 3 + 2];

      const colKey = `${Math.round(vx * 100)}_${Math.round(vz * 100)}`;
      const cMinY = colMinY.get(colKey) ?? vySlpk;

      let yWorld = vySlpk - originElev + deltaY;
      if (
        isWallTri &&
        vySlpk <= groundClampThreshold &&
        vySlpk <= cMinY + 0.02 &&
        vySlpk < maxZClampCap &&
        !downVertKeys.has(
          `${Math.round(vx * 1000)}_${Math.round(vySlpk * 1000)}_${Math.round(vz * 1000)}`
        )
      ) {
        const clampedY = terrain.getHeightAtXZ(vx, vz) - 1.5;
        if (clampedY < yWorld) {
          yWorld = clampedY;
        }
      }

      const localHeight = Math.max(0.0, vySlpk - effectiveGroundZ);
      const roofType = classifyRoofType(capa, ny, altura, cz);
      let topDist;
      if (roofType === 1 || roofType === 2 || roofType === 4 || roofType === 5) {
        topDist = 5.0;
      } else {
        const colTop = colMaxY.get(colKey) ?? maxYSlpk;
        topDist = Math.max(0.0, colTop - vySlpk);
      }

      if (acc.dedup) {
        const dKey = `${Math.fround(vx)}|${Math.fround(yWorld)}|${Math.fround(vz)}|${Math.fround(nx)}|${Math.fround(ny)}|${Math.fround(nz)}|${roofType}|${Math.fround(localHeight)}|${Math.fround(topDist)}`;
        let vIdx = featVertMap.get(dKey);
        if (vIdx === undefined) {
          vIdx = acc.pushVertex(
            vx,
            yWorld,
            vz,
            nx,
            ny,
            nz,
            cr,
            cg,
            cb,
            localHeight,
            topDist,
            roofType,
            wallStyle
          );
          featVertMap.set(dKey, vIdx);
        }
        triIndices[k] = vIdx;
      } else {
        acc.pushVertex(
          vx,
          yWorld,
          vz,
          nx,
          ny,
          nz,
          cr,
          cg,
          cb,
          localHeight,
          topDist,
          roofType,
          wallStyle
        );
      }
    }
    if (
      acc.dedup &&
      triIndices[0] !== triIndices[1] &&
      triIndices[1] !== triIndices[2] &&
      triIndices[0] !== triIndices[2]
    ) {
      acc.pushIndex(triIndices[0]);
      acc.pushIndex(triIndices[1]);
      acc.pushIndex(triIndices[2]);
    }
  }

  acc.buildingCount++;
}

// ---------------------------------------------------------------------------
// 8. Leaf Reader Helper & Two-Pass Conversion Pipeline
// ---------------------------------------------------------------------------

function readLeafPayload(reader, resource) {
  const prefix = `nodes/${resource}`;
  const gBuf = reader.readEntry(`${prefix}/geometries/0.bin.gz`);
  const f0Buf = reader.readEntry(`${prefix}/attributes/f_0/0.bin.gz`);
  const f1Buf = reader.readEntry(`${prefix}/attributes/f_1/0.bin.gz`);
  const f2Buf = reader.readEntry(`${prefix}/attributes/f_2/0.bin.gz`);
  const f6Buf = reader.readEntry(`${prefix}/attributes/f_6/0.bin.gz`);
  if (!gBuf || !f0Buf || !f1Buf || !f2Buf || !f6Buf) {
    return null;
  }
  const geom = decodeGeometryBuffer(gBuf);
  const oid32 = decodeOid32Attribute(f0Buf);
  const id3dArr = decodeInt32Attribute(f1Buf);
  const capaArr = decodeStringAttribute(f2Buf);
  const alturaArr = decodeFloat64Attribute(f6Buf);
  return { geom, oid32, id3dArr, capaArr, alturaArr };
}

export function filterTargetChunks(baseChunks, { bbox = null, chunks = null } = {}) {
  const byKey = new Map(baseChunks.map((c) => [c.key, c]));
  let selected;

  if (chunks && chunks.length > 0) {
    selected = [];
    for (const k of chunks) {
      const entry = byKey.get(k);
      if (!entry) {
        throw new Error(`Unknown chunk key "${k}" (not present in base manifest)`);
      }
      selected.push(entry);
    }
  } else {
    selected = [...baseChunks];
  }

  if (bbox) {
    const [minLon, minLat, maxLon, maxLat] = bbox;
    const [xMin, zMax] = projectToMeters(minLon, minLat);
    const [xMax, zMin] = projectToMeters(maxLon, maxLat);
    selected = selected.filter((c) => {
      const cx0 = c.cx * CHUNK_SIZE_M;
      const cx1 = cx0 + CHUNK_SIZE_M;
      const cz0 = c.cz * CHUNK_SIZE_M;
      const cz1 = cz0 + CHUNK_SIZE_M;
      return cx1 >= xMin && cx0 <= xMax && cz1 >= zMin && cz0 <= zMax;
    });
  }

  selected.sort((a, b) => a.cx - b.cx || a.cz - b.cz);
  return selected;
}

export function splitChunkCzBatches(targetChunks, numBatches = 4) {
  const czValues = Array.from(new Set(targetChunks.map((c) => c.cz))).sort((a, b) => a - b);
  if (czValues.length === 0) return [];
  const actualBatches = Math.min(numBatches, czValues.length);
  const batches = [];
  for (let b = 0; b < actualBatches; b++) {
    const start = Math.floor((b * czValues.length) / actualBatches);
    const end = Math.floor(((b + 1) * czValues.length) / actualBatches);
    const czSet = new Set(czValues.slice(start, end));
    batches.push(targetChunks.filter((c) => czSet.has(c.cz)));
  }
  return batches;
}

export function convertSlpkToChunks({
  slpkPath,
  baseManifestPath,
  outDir,
  bbox = null,
  chunks = null,
  dedup = true,
  updateExisting = false,
  silent = false,
}) {
  const startTime = Date.now();
  const baseManifest = JSON.parse(fs.readFileSync(baseManifestPath, 'utf8'));
  const targetChunks = filterTargetChunks(baseManifest.chunks, { bbox, chunks });
  const targetChunkKeys = new Set(targetChunks.map((c) => c.key));
  const terrain = new TerrainElevation(baseManifest.dem);

  fs.mkdirSync(outDir, { recursive: true });

  const reader = openSlpkReader(slpkPath);
  const stats = {
    totalChunks: targetChunks.length,
    populatedChunks: 0,
    emptyChunks: 0,
    candidateLeaves: 0,
    totalFeatures: 0,
    totalVertices: 0,
    totalTriangles: 0,
    totalBinBytes: 0,
    peakRssBytes: process.memoryUsage().rss,
  };

  function updatePeakRss() {
    const rss = process.memoryUsage().rss;
    if (rss > stats.peakRssBytes) stats.peakRssBytes = rss;
  }

  try {
    const candidateLeaves = selectLeafNodes(reader, targetChunks);
    stats.candidateLeaves = candidateLeaves.length;

    // Pass 1: Build global 01_EDIFICIO_P host spatial grid
    const hostGrid = new HostSpatialGrid(50);
    for (let li = 0; li < candidateLeaves.length; li++) {
      const leaf = candidateLeaves[li];
      const payload = readLeafPayload(reader, leaf.resource);
      if (!payload) continue;
      const { geom, id3dArr, capaArr, alturaArr } = payload;

      for (let fi = 0; fi < geom.featureCount; fi++) {
        if (capaArr[fi] !== '01_EDIFICIO_P') continue;
        const altura = alturaArr[fi];
        if (!Number.isFinite(altura) || altura <= 0) continue;

        const geomFeat = extractLeafFeatureTriangles(geom, fi, leaf.obbCenter);
        if (!geomFeat) continue;

        const host = computeEdificioHostRecord(geomFeat, id3dArr[fi], altura, terrain);
        hostGrid.insert(host);
      }
      if ((li & 127) === 127) updatePeakRss();
    }

    updatePeakRss();
    if (!silent) {
      console.log(
        `[Pass 1] Indexed ${hostGrid.byId3d.size} host buildings from ${candidateLeaves.length} candidate leaves (RSS ${(process.memoryUsage().rss / 1048576).toFixed(1)} MB)`
      );
    }

    // Pass 2: 4 cz-row batches to bound peak RSS < 400 MB
    const batches = splitChunkCzBatches(targetChunks, 4);
    const chunkStatsMap = new Map();
    const featVertMap = new Map();

    for (let bi = 0; bi < batches.length; bi++) {
      const batchChunks = batches[bi];
      const batchAccMap = new Map();
      const batchBoxes = [];
      for (const c of batchChunks) {
        batchAccMap.set(c.key, new ChunkMeshAccumulator(c.cx, c.cz, dedup));
        const x0 = c.cx * CHUNK_SIZE_M;
        const z0 = c.cz * CHUNK_SIZE_M;
        batchBoxes.push({ x0, x1: x0 + CHUNK_SIZE_M, z0, z1: z0 + CHUNK_SIZE_M });
      }

      for (let li = 0; li < candidateLeaves.length; li++) {
        const leaf = candidateLeaves[li];
        const rSq = leaf.radius * leaf.radius;
        let overlapsBatch = false;
        for (let k = 0; k < batchBoxes.length; k++) {
          const b = batchBoxes[k];
          const dx = leaf.lx < b.x0 ? b.x0 - leaf.lx : leaf.lx > b.x1 ? leaf.lx - b.x1 : 0;
          const dz = leaf.lz < b.z0 ? b.z0 - leaf.lz : leaf.lz > b.z1 ? leaf.lz - b.z1 : 0;
          if (dx * dx + dz * dz <= rSq) {
            overlapsBatch = true;
            break;
          }
        }
        if (!overlapsBatch) continue;

        const payload = readLeafPayload(reader, leaf.resource);
        if (!payload) continue;
        const { geom, id3dArr, capaArr, alturaArr } = payload;

        for (let fi = 0; fi < geom.featureCount; fi++) {
          const capa = capaArr[fi];
          if (!INCLUDED_CAPAS.has(capa)) continue;
          const altura = alturaArr[fi];
          if (!Number.isFinite(altura) || altura <= 0) continue;

          const geomFeat = extractLeafFeatureTriangles(geom, fi, leaf.obbCenter);
          if (!geomFeat) continue;

          const cxGrid = Math.floor(geomFeat.cx / CHUNK_SIZE_M);
          const czGrid = Math.floor(geomFeat.cz / CHUNK_SIZE_M);
          const key = `${cxGrid}_${czGrid}`;
          if (!targetChunkKeys.has(key)) continue;
          const acc = batchAccMap.get(key);
          if (!acc) continue;

          emitFeatureToAccumulator({
            acc,
            geomFeat,
            id3d: id3dArr[fi],
            capa,
            altura,
            terrain,
            hostGrid,
            featVertMap,
          });
        }
        if ((li & 63) === 63) updatePeakRss();
      }

      for (const [key, acc] of batchAccMap) {
        if (acc.buildingCount > 0 && acc.vertexCount > 0) {
          const binBuf = acc.toBinaryBuffer();
          const outBinPath = path.join(outDir, `chunk_${acc.cx}_${acc.cz}.bin`);
          fs.writeFileSync(outBinPath, binBuf);

          const tris = acc.dedup ? acc.indexCount / 3 : acc.vertexCount / 3;
          stats.populatedChunks++;
          stats.totalFeatures += acc.buildingCount;
          stats.totalVertices += acc.vertexCount;
          stats.totalTriangles += tris;
          stats.totalBinBytes += binBuf.byteLength;
          chunkStatsMap.set(key, {
            buildings: acc.buildingCount,
            meshFile: `/data/chunks-slpk/chunk_${acc.cx}_${acc.cz}.bin`,
          });
        } else {
          stats.emptyChunks++;
          chunkStatsMap.set(key, { buildings: 0, meshFile: null });
        }
      }

      updatePeakRss();
      if (!silent) {
        console.log(
          `[Pass 2] Batch ${bi + 1}/${batches.length} complete (${batchChunks.length} chunks, RSS ${(process.memoryUsage().rss / 1048576).toFixed(1)} MB)`
        );
      }
    }

    let totalRoads = 0;
    let totalParks = 0;
    let totalWater = 0;
    let totalTrees = 0;

    const manifestChunks = targetChunks.map((c) => {
      const cs = chunkStatsMap.get(c.key) || { buildings: 0, meshFile: null };
      totalRoads += c.counts.roads;
      totalParks += c.counts.parks;
      totalWater += c.counts.water;
      totalTrees += c.counts.trees;

      const entry = {
        key: c.key,
        cx: c.cx,
        cz: c.cz,
        file: `chunk_${c.cx}_${c.cz}.json`,
        counts: {
          buildings: cs.buildings,
          roads: c.counts.roads,
          parks: c.counts.parks,
          water: c.counts.water,
          trees: c.counts.trees,
        },
      };
      if (cs.buildings > 0 && cs.meshFile) {
        entry.meshFile = cs.meshFile;
      }
      return entry;
    });

    const outManifestPath = path.join(outDir, 'manifest.json');
    let finalChunks = manifestChunks;
    if (updateExisting && fs.existsSync(outManifestPath)) {
      const prev = JSON.parse(fs.readFileSync(outManifestPath, 'utf8'));
      const updatedByKey = new Map(manifestChunks.map((c) => [c.key, c]));
      finalChunks = (prev.chunks || []).map((c) => updatedByKey.get(c.key) || c);
      totalRoads = 0;
      totalParks = 0;
      totalWater = 0;
      totalTrees = 0;
      let totalBld = 0;
      for (const c of finalChunks) {
        totalBld += c.counts.buildings;
        totalRoads += c.counts.roads;
        totalParks += c.counts.parks;
        totalWater += c.counts.water;
        totalTrees += c.counts.trees;
      }
      stats.totalFeatures = totalBld;
    }

    const manifest = {
      meta: {
        origin: baseManifest.meta.origin,
        bbox: baseManifest.meta.bbox,
        chunkSizeM: baseManifest.meta.chunkSizeM ?? CHUNK_SIZE_M,
        generatedAt: new Date().toISOString(),
        source: 'slpk-lod2',
      },
      totals: {
        chunks: finalChunks.length,
        buildings: stats.totalFeatures,
        roads: totalRoads,
        parks: totalParks,
        water: totalWater,
        trees: totalTrees,
      },
      dem: baseManifest.dem,
      chunks: finalChunks,
    };

    fs.writeFileSync(outManifestPath, JSON.stringify(manifest));

    stats.elapsedMs = Date.now() - startTime;
    return { manifest, stats, outManifestPath };
  } finally {
    reader.close();
  }
}

// ---------------------------------------------------------------------------
// 9. CLI Entrypoint
// ---------------------------------------------------------------------------

export function parseCliArgs(argv) {
  const opts = {
    slpkPath: 'scripts/.cache-lod2/MODELADO_3D_MADRID.slpk',
    baseManifestPath: 'public/data/chunks/manifest.json',
    outDir: 'public/data/chunks-slpk',
    bbox: null,
    chunks: null,
    dedup: true,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else if (arg === '--slpk') {
      const val = argv[++i];
      if (!val) throw new Error('Missing value for --slpk');
      opts.slpkPath = val;
    } else if (arg === '--base-manifest') {
      const val = argv[++i];
      if (!val) throw new Error('Missing value for --base-manifest');
      opts.baseManifestPath = val;
    } else if (arg === '--out-dir') {
      const val = argv[++i];
      if (!val) throw new Error('Missing value for --out-dir');
      opts.outDir = val;
    } else if (arg === '--bbox') {
      const val = argv[++i];
      if (!val) throw new Error('Missing value for --bbox');
      const parts = val.split(',').map(Number);
      if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
        throw new Error(`Invalid --bbox "${val}": expected minLon,minLat,maxLon,maxLat`);
      }
      if (parts[0] >= parts[2] || parts[1] >= parts[3]) {
        throw new Error(`Invalid --bbox "${val}": min must be < max`);
      }
      opts.bbox = parts;
    } else if (arg === '--chunks') {
      const val = argv[++i];
      if (!val) throw new Error('Missing value for --chunks');
      opts.chunks = val
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (opts.chunks.length === 0) {
        throw new Error('Empty --chunks list');
      }
    } else if (arg === '--no-dedup') {
      opts.dedup = false;
    } else if (arg === '--update-existing') {
      opts.updateExisting = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return opts;
}

function printHelp() {
  console.log(`Usage: node scripts/convert-slpk-chunks.mjs [options]

Options:
  --slpk <path>                 Input .slpk path (default: scripts/.cache-lod2/MODELADO_3D_MADRID.slpk)
  --base-manifest <path>        Base OSM manifest path (default: public/data/chunks/manifest.json)
  --out-dir <path>              Output directory (default: public/data/chunks-slpk)
  --bbox <minLon,minLat,maxLon,maxLat>  Filter target chunks overlapping bbox
  --chunks <k1,k2,...>          Comma-separated chunk keys (e.g. 0_0,-1_-1)
  --no-dedup                    Disable per-feature vertex deduplication (emit non-indexed SLPK)
  --help                        Show this help message`);
}

function main() {
  const opts = parseCliArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    process.exit(0);
  }

  const result = convertSlpkToChunks(opts);
  const { stats } = result;
  console.log(
    `Done in ${(stats.elapsedMs / 1000).toFixed(2)}s: ` +
      `${stats.populatedChunks}/${stats.totalChunks} populated chunks, ` +
      `${stats.totalFeatures} buildings, ` +
      `${stats.totalVertices} verts, ` +
      `${stats.totalTriangles} tris, ` +
      `${(stats.totalBinBytes / (1024 * 1024)).toFixed(2)} MiB .bin, ` +
      `peak RSS ${(stats.peakRssBytes / (1024 * 1024)).toFixed(1)} MB`
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

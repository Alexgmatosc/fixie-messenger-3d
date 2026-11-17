import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  ORIGIN_LON,
  ORIGIN_LAT,
  METERS_PER_DEG_LON,
  METERS_PER_DEG_LAT,
  SLPK_MAGIC,
  SLPK_VERSION,
  projectToMeters,
  unprojectFromMeters,
  TerrainElevation,
  ecefNormalToWorld,
  classifyRoofType,
  chooseBuildingWallStyle,
  computeFeatureColorRGB8,
  openSlpkReader,
  decodeGeometryBuffer,
  decodeOid32Attribute,
  decodeInt32Attribute,
  decodeStringAttribute,
  decodeFloat64Attribute,
  align4,
  packSlpkChunkBinary,
  ChunkMeshAccumulator,
  HostSpatialGrid,
  extractLeafFeatureTriangles,
  computeEdificioHostRecord,
  emitFeatureToAccumulator,
  convertSlpkToChunks,
} from './convert-slpk-chunks.mjs';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Synthetic Binary & ZIP / ZIP64 Builders for Tests
// ---------------------------------------------------------------------------

function makeGeometryBuffer(triangles, featureRanges) {
  // triangles: [{ p: [x0,y0,z0, x1,y1,z1, x2,y2,z2], n: [nx0,ny0,nz0, ...] }, ...]
  const vc = triangles.length * 3;
  const fc = featureRanges.length;
  const totalBytes = 8 + vc * 36 + fc * 16;
  const buf = Buffer.alloc(totalBytes);
  buf.writeUInt32LE(vc, 0);
  buf.writeUInt32LE(fc, 4);

  const posOff = 8;
  const normOff = posOff + vc * 12;
  const colorOff = posOff + vc * 32;

  for (let t = 0; t < triangles.length; t++) {
    const tri = triangles[t];
    for (let k = 0; k < 3; k++) {
      const vi = t * 3 + k;
      buf.writeFloatLE(tri.p[k * 3], posOff + vi * 12);
      buf.writeFloatLE(tri.p[k * 3 + 1], posOff + vi * 12 + 4);
      buf.writeFloatLE(tri.p[k * 3 + 2], posOff + vi * 12 + 8);
      buf.writeFloatLE(tri.n[k * 3], normOff + vi * 12);
      buf.writeFloatLE(tri.n[k * 3 + 1], normOff + vi * 12 + 4);
      buf.writeFloatLE(tri.n[k * 3 + 2], normOff + vi * 12 + 8);
      buf[colorOff + vi * 4 + 3] = 255;
    }
  }

  const fidOff = 8 + vc * 36;
  const frOff = fidOff + fc * 8;
  for (let f = 0; f < fc; f++) {
    buf.writeBigUInt64LE(BigInt(featureRanges[f].oid), fidOff + f * 8);
    buf.writeUInt32LE(featureRanges[f].start, frOff + f * 8);
    buf.writeUInt32LE(featureRanges[f].end, frOff + f * 8 + 4);
  }
  return buf;
}

function makeOid32Buffer(values) {
  const buf = Buffer.alloc(4 + values.length * 4);
  buf.writeUInt32LE(values.length, 0);
  for (let i = 0; i < values.length; i++) buf.writeUInt32LE(values[i], 4 + i * 4);
  return buf;
}

function makeInt32Buffer(values) {
  const buf = Buffer.alloc(4 + values.length * 4);
  buf.writeUInt32LE(values.length, 0);
  for (let i = 0; i < values.length; i++) buf.writeInt32LE(values[i], 4 + i * 4);
  return buf;
}

function makeStringBuffer(strings, nullTerminate = true) {
  const encoded = strings.map((s) => Buffer.from(nullTerminate ? `${s}\0` : s, 'utf8'));
  const totalBytes = encoded.reduce((a, b) => a + b.length, 0);
  const buf = Buffer.alloc(8 + strings.length * 4 + totalBytes);
  buf.writeUInt32LE(strings.length, 0);
  buf.writeUInt32LE(totalBytes, 4);
  let off = 8 + strings.length * 4;
  for (let i = 0; i < encoded.length; i++) {
    buf.writeUInt32LE(encoded[i].length, 8 + i * 4);
    encoded[i].copy(buf, off);
    off += encoded[i].length;
  }
  return buf;
}

function makeFloat64AlturaBuffer(values) {
  // 4-byte count + 4-byte zero pad + Float64LE[]
  const buf = Buffer.alloc(8 + values.length * 8);
  buf.writeUInt32LE(values.length, 0);
  buf.writeUInt32LE(0, 4);
  for (let i = 0; i < values.length; i++) {
    buf.writeDoubleLE(values[i], 8 + i * 8);
  }
  return buf;
}

function worldToEcefNormal(nx, ny, nz, lonDeg, latDeg) {
  // Inverse of ENU->Three.js (X=E, Y=U, Z=-N): E=nx, N=-nz, U=ny
  const e = nx;
  const n = -nz;
  const u = ny;
  const lam = (lonDeg * Math.PI) / 180;
  const phi = (latDeg * Math.PI) / 180;
  const sinLam = Math.sin(lam);
  const cosLam = Math.cos(lam);
  const sinPhi = Math.sin(phi);
  const cosPhi = Math.cos(phi);
  return [
    -sinLam * e - sinPhi * cosLam * n + cosPhi * cosLam * u,
    cosLam * e - sinPhi * sinLam * n + cosPhi * sinLam * u,
    cosPhi * n + sinPhi * u,
  ];
}

function buildZipStoreArchive(entries, { zip64 = false } = {}) {
  // entries: [{ name: string, data: Buffer }]
  const lfhChunks = [];
  const cdChunks = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const lfh = Buffer.alloc(30 + nameBuf.length);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(zip64 ? 45 : 20, 4);
    lfh.writeUInt16LE(0x0800, 6);
    lfh.writeUInt16LE(0, 8); // STORE
    lfh.writeUInt32LE(data.length, 18);
    lfh.writeUInt32LE(data.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);
    nameBuf.copy(lfh, 30);

    lfhChunks.push(lfh, data);

    const extraZ64 = zip64 ? Buffer.alloc(12) : Buffer.alloc(0);
    if (zip64) {
      extraZ64.writeUInt16LE(0x0001, 0);
      extraZ64.writeUInt16LE(8, 2);
      extraZ64.writeBigUInt64LE(BigInt(offset), 4);
    }

    const cd = Buffer.alloc(46 + nameBuf.length + extraZ64.length);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(zip64 ? 45 : 20, 4);
    cd.writeUInt16LE(zip64 ? 45 : 20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(0, 10); // STORE
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(extraZ64.length, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt32LE(zip64 ? 0xffffffff : offset, 42);
    nameBuf.copy(cd, 46);
    if (extraZ64.length > 0) extraZ64.copy(cd, 46 + nameBuf.length);
    cdChunks.push(cd);

    offset += lfh.length + data.length;
  }

  const cdBuf = Buffer.concat(cdChunks);
  const cdOffset = offset;
  const cdSize = cdBuf.length;

  if (!zip64) {
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(cdSize, 12);
    eocd.writeUInt32LE(cdOffset, 16);
    return Buffer.concat([...lfhChunks, cdBuf, eocd]);
  }

  const z64EocdOffset = cdOffset + cdSize;
  const z64Eocd = Buffer.alloc(56);
  z64Eocd.writeUInt32LE(0x06064b50, 0);
  z64Eocd.writeBigUInt64LE(44n, 4);
  z64Eocd.writeUInt16LE(45, 12);
  z64Eocd.writeUInt16LE(45, 14);
  z64Eocd.writeBigUInt64LE(BigInt(entries.length), 24);
  z64Eocd.writeBigUInt64LE(BigInt(entries.length), 32);
  z64Eocd.writeBigUInt64LE(BigInt(cdSize), 40);
  z64Eocd.writeBigUInt64LE(BigInt(cdOffset), 48);

  const z64Loc = Buffer.alloc(20);
  z64Loc.writeUInt32LE(0x07064b50, 0);
  z64Loc.writeUInt32LE(0, 4);
  z64Loc.writeBigUInt64LE(BigInt(z64EocdOffset), 8);
  z64Loc.writeUInt32LE(1, 16);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0xffff, 8);
  eocd.writeUInt16LE(0xffff, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdOffset, 16);

  return Buffer.concat([...lfhChunks, cdBuf, z64Eocd, z64Loc, eocd]);
}

function makeFlatDemGrid(elevationM = 652.2) {
  return {
    cols: 3,
    rows: 3,
    bbox: [-3.76, 40.37, -3.64, 40.5],
    originElevationM: 652.2,
    minElevationM: elevationM,
    maxElevationM: elevationM,
    values: new Array(9).fill(elevationM - 652.2),
  };
}

function makeBoxTrianglesMeters(x0, x1, y0, y1, z0, z1, lon0, lat0, zCenter, { withBottom = true } = {}) {
  // Creates a box in Three.js world space, then maps vertices back to (dLon, dLat, dZ)
  // and world normals to ECEF normals for synthetic SLPK geometry.
  const toLocal = (wx, wy, wz) => {
    const [lon, lat] = unprojectFromMeters(wx, wz);
    return [lon - lon0, lat - lat0, wy - zCenter];
  };
  const pushQuad = (a, b, c, d, wnx, wny, wnz, out) => {
    const ecef = worldToEcefNormal(wnx, wny, wnz, lon0, lat0);
    const n = [...ecef, ...ecef, ...ecef];
    const pa = toLocal(...a);
    const pb = toLocal(...b);
    const pc = toLocal(...c);
    const pd = toLocal(...d);
    out.push({ p: [...pa, ...pb, ...pc], n });
    out.push({ p: [...pa, ...pc, ...pd], n });
  };
  const tris = [];
  // +Y top (CCW looking from +Y)
  pushQuad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], 0, 1, 0, tris);
  if (withBottom) {
    // -Y bottom
    pushQuad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], 0, -1, 0, tris);
  }
  // +Z front
  pushQuad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], 0, 0, 1, tris);
  // -Z back
  pushQuad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], 0, 0, -1, tris);
  // +X right
  pushQuad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], 1, 0, 0, tris);
  // -X left
  pushQuad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], -1, 0, 0, tris);
  return tris;
}

// ---------------------------------------------------------------------------
// Suite 1: Projection, Winding & ECEF -> ENU -> Three.js Normals
// ---------------------------------------------------------------------------

test('Suite 1: Projection constants, ECEF->Three.js normals, CCW winding, degenerate drop', () => {
  assert.deepEqual(projectToMeters(ORIGIN_LON, ORIGIN_LAT), [0, 0]);
  assert.ok(Math.abs(METERS_PER_DEG_LON - 111320 * Math.cos((ORIGIN_LAT * Math.PI) / 180)) < 1e-9);
  assert.equal(METERS_PER_DEG_LAT, 110540);

  const lam = (ORIGIN_LON * Math.PI) / 180;
  const phi = (ORIGIN_LAT * Math.PI) / 180;

  // Zenith (Up) -> (0, 1, 0)
  const up = ecefNormalToWorld(
    Math.cos(phi) * Math.cos(lam),
    Math.cos(phi) * Math.sin(lam),
    Math.sin(phi),
    ORIGIN_LON,
    ORIGIN_LAT
  );
  assert.ok(Math.abs(up[0]) < 1e-6 && Math.abs(up[1] - 1) < 1e-6 && Math.abs(up[2]) < 1e-6);

  // East -> (1, 0, 0)
  const east = ecefNormalToWorld(-Math.sin(lam), Math.cos(lam), 0, ORIGIN_LON, ORIGIN_LAT);
  assert.ok(Math.abs(east[0] - 1) < 1e-6 && Math.abs(east[1]) < 1e-6 && Math.abs(east[2]) < 1e-6);

  // North -> (0, 0, -1)
  const north = ecefNormalToWorld(
    -Math.sin(phi) * Math.cos(lam),
    -Math.sin(phi) * Math.sin(lam),
    Math.cos(phi),
    ORIGIN_LON,
    ORIGIN_LAT
  );
  assert.ok(Math.abs(north[0]) < 1e-6 && Math.abs(north[1]) < 1e-6 && Math.abs(north[2] + 1) < 1e-6);

  // Outward CCW triangle in ENU (E, N, U) -> Three.js (X=E, Y=U, Z=-N) preserves +Y normal
  const p0 = [0, 0, 0];
  const p1 = [10 / METERS_PER_DEG_LON, 0, 0]; // +10m East
  const p2 = [0, 10 / METERS_PER_DEG_LAT, 0]; // +10m North
  const geom = decodeGeometryBuffer(
    makeGeometryBuffer(
      [
        // Valid CCW triangle with zero ECEF normal -> tests geometric fallback normal
        { p: [...p0, ...p1, ...p2], n: [0, 0, 0, 0, 0, 0, 0, 0, 0] },
        // Degenerate sliver triangle (collinear) -> must be dropped
        { p: [0, 0, 0, 1e-6, 0, 0, 2e-6, 0, 0], n: [0, 0, 1, 0, 0, 1, 0, 0, 1] },
        // Non-finite vertex -> must be dropped
        { p: [NaN, 0, 0, 1e-4, 0, 0, 0, 1e-4, 0], n: [0, 0, 1, 0, 0, 1, 0, 0, 1] },
      ],
      [{ oid: 1, start: 0, end: 2 }]
    )
  );
  const feat = extractLeafFeatureTriangles(geom, 0, [ORIGIN_LON, ORIGIN_LAT, 650]);
  assert.equal(feat.triCount, 1);
  // Geometric fallback normal should point +Y (0, 1, 0)
  assert.ok(feat.trisNorm[1] > 0.9999);
});

// ---------------------------------------------------------------------------
// Suite 2: f_6 (ALTURA) 4-Byte Alignment Pad & Unaligned Buffer Handling
// ---------------------------------------------------------------------------

test('Suite 2: f_6 Float64 4-byte alignment padding and unaligned slice guard', () => {
  const expected = [29.86, 3.13, 250.03, -0.31];
  const f6Buf = makeFloat64AlturaBuffer(expected);
  const decoded = decodeFloat64Attribute(f6Buf);
  assert.equal(decoded.length, 4);
  for (let i = 0; i < expected.length; i++) {
    assert.equal(decoded[i], expected[i]);
  }

  // Test unaligned byteOffset (byteOffset % 8 === 1) for both decodeFloat64Attribute and decodeGeometryBuffer
  const geomBuf = makeGeometryBuffer(
    [{ p: [0, 0, 0, 1e-4, 0, 0, 0, 1e-4, 0], n: [0, 0, 1, 0, 0, 1, 0, 0, 1] }],
    [{ oid: 42, start: 0, end: 0 }]
  );
  const padded = Buffer.alloc(1 + geomBuf.length);
  geomBuf.copy(padded, 1);
  const unalignedSlice = padded.subarray(1);
  assert.equal(unalignedSlice.byteOffset & 7, 1);

  const decGeom = decodeGeometryBuffer(unalignedSlice);
  assert.equal(decGeom.vertexCount, 3);
  assert.equal(decGeom.featureIds[0], 42);
});

// ---------------------------------------------------------------------------
// Suite 3: geometries/0.bin & f_0..f_2 Decoding + Lossless Roof/CAPA Preservation
// ---------------------------------------------------------------------------

test('Suite 3: Multi-feature geometry + f_0..f_2 decoding + lossless roof & CAPA preservation', () => {
  const obbCenter = [ORIGIN_LON, ORIGIN_LAT, 652.2];
  const tris = [
    // Feat 0: pitched roof (two triangles, ny = 0.707) -> must NOT be simplified
    {
      p: [0, 0, 10, 5 / METERS_PER_DEG_LON, 0, 10, 0, 5 / METERS_PER_DEG_LAT, 15],
      n: [
        ...worldToEcefNormal(0, 0.7071, 0.7071, ORIGIN_LON, ORIGIN_LAT),
        ...worldToEcefNormal(0, 0.7071, 0.7071, ORIGIN_LON, ORIGIN_LAT),
        ...worldToEcefNormal(0, 0.7071, 0.7071, ORIGIN_LON, ORIGIN_LAT),
      ],
    },
    {
      p: [0, 0, 10, 0, -5 / METERS_PER_DEG_LAT, 10, 0, 5 / METERS_PER_DEG_LAT, 15],
      n: [
        ...worldToEcefNormal(-0.7071, 0.7071, 0, ORIGIN_LON, ORIGIN_LAT),
        ...worldToEcefNormal(-0.7071, 0.7071, 0, ORIGIN_LON, ORIGIN_LAT),
        ...worldToEcefNormal(-0.7071, 0.7071, 0, ORIGIN_LON, ORIGIN_LAT),
      ],
    },
    // Feat 1: skylight 01_LUCERNARIO_P
    {
      p: [0, 0, 16, 1 / METERS_PER_DEG_LON, 0, 16, 0, 1 / METERS_PER_DEG_LAT, 17],
      n: [
        ...worldToEcefNormal(0, 0.7071, 0.7071, ORIGIN_LON, ORIGIN_LAT),
        ...worldToEcefNormal(0, 0.7071, 0.7071, ORIGIN_LON, ORIGIN_LAT),
        ...worldToEcefNormal(0, 0.7071, 0.7071, ORIGIN_LON, ORIGIN_LAT),
      ],
    },
  ];
  const gBuf = makeGeometryBuffer(tris, [
    { oid: 101, start: 0, end: 1 },
    { oid: 102, start: 2, end: 2 },
  ]);
  const f0 = makeOid32Buffer([101, 102]);
  const f1 = makeInt32Buffer([10001, 10002]);
  const f2 = makeStringBuffer(['01_EDIFICIO_P', '01_LUCERNARIO_P'], true);

  const decG = decodeGeometryBuffer(gBuf);
  const decF0 = decodeOid32Attribute(f0);
  const decF1 = decodeInt32Attribute(f1);
  const decF2 = decodeStringAttribute(f2);

  assert.equal(decG.featureCount, 2);
  assert.deepEqual(Array.from(decF0), [101, 102]);
  assert.deepEqual(Array.from(decF1), [10001, 10002]);
  assert.deepEqual(decF2, ['01_EDIFICIO_P', '01_LUCERNARIO_P']);

  assert.equal(classifyRoofType('01_EDIFICIO_P', 0.7071, 15, 0), 2); // sloped roof
  assert.equal(classifyRoofType('01_EDIFICIO_P', 0.4, 30, -200), 4); // slate mansard/dome
  assert.equal(classifyRoofType('01_EDIFICIO_P', 0.98, 15, 0), 1); // flat roof
  assert.equal(classifyRoofType('01_EDIFICIO_P', -0.98, 15, 0), 3); // underside soffit
  assert.equal(classifyRoofType('01_LUCERNARIO_P', 0.7071, 16, 0), 4); // skylight top
  assert.equal(classifyRoofType('01_MARQUESINA_P', 0.0, 4, 0), 3); // canopy edge trim
});

// ---------------------------------------------------------------------------
// Suite 4: Terrain Alignment, Host Inheritance & Ground-Skirt Safety Clamp
// ---------------------------------------------------------------------------

test('Suite 4: DEM alignment, host inheritance (01_LUCERNARIO_P), and downhill skirt clamp', () => {
  // Sloped DEM: west higher (662m), east lower (642m)
  const dem = {
    cols: 2,
    rows: 2,
    bbox: [-3.71, 40.40, -3.68, 40.43],
    originElevationM: 652.2,
    minElevationM: 642.2,
    maxElevationM: 662.2,
    // row 0 (south) = [+10, -10], row 1 (north) = [+10, -10]
    values: [10, -10, 10, -10],
  };
  const terrain = new TerrainElevation(dem);
  const obbCenter = [ORIGIN_LON, ORIGIN_LAT, 650.0];

  // Host 01_EDIFICIO_P spanning x in [-20, 20], z in [-10, 10], y_slpk in [649.5, 670.0] (ALTURA=20 -> slpkGroundZ=650.0)
  // Real SLPK 01_EDIFICIO_P walls have NO bottom cap (withBottom: false).
  // Add an elevated overhang soffit at y=650.1 (within slpkGroundZ+0.20!) touched by ny=-1 to verify it is NOT clamped down.
  const hostTris = makeBoxTrianglesMeters(-20, 20, 649.5, 670.0, -10, 10, ...obbCenter, { withBottom: false });
  const overhangTris = makeBoxTrianglesMeters(18, 22, 650.1, 655.0, -2, 2, ...obbCenter, { withBottom: true });
  const lucTris = makeBoxTrianglesMeters(-4, 4, 670.0, 671.5, -4, 4, ...obbCenter);
  const allTris = [...hostTris, ...overhangTris, ...lucTris];

  const gBuf = makeGeometryBuffer(allTris, [
    { oid: 1, start: 0, end: hostTris.length + overhangTris.length - 1 },
    { oid: 2, start: hostTris.length + overhangTris.length, end: allTris.length - 1 },
  ]);
  const geom = decodeGeometryBuffer(gBuf);

  const hostFeat = extractLeafFeatureTriangles(geom, 0, obbCenter);
  const lucFeat = extractLeafFeatureTriangles(geom, 1, obbCenter);

  const hostGrid = new HostSpatialGrid(50);
  const hostRec = computeEdificioHostRecord(hostFeat, 5001, 20.0, terrain);
  hostGrid.insert(hostRec);

  const acc = new ChunkMeshAccumulator(0, 0, true);
  const featVertMap = new Map();

  emitFeatureToAccumulator({
    acc,
    geomFeat: hostFeat,
    id3d: 5001,
    capa: '01_EDIFICIO_P',
    altura: 20.0,
    terrain,
    hostGrid,
    featVertMap,
  });
  const hostVertEnd = acc.vertexCount;

  // Give skylight a 4 m different own ground datum (ALTURA=25.5 -> slpkGroundZ=646.0); host inheritance must lock it to host roof!
  emitFeatureToAccumulator({
    acc,
    geomFeat: lucFeat,
    id3d: 5002,
    capa: '01_LUCERNARIO_P',
    altura: 25.5,
    terrain,
    hostGrid,
    featVertMap,
  });

  // Check host roof Y vs skylight bottom Y
  let hostMaxYWorld = -Infinity;
  for (let i = 0; i < hostVertEnd; i++) {
    if (acc.pos[i * 3 + 1] > hostMaxYWorld) hostMaxYWorld = acc.pos[i * 3 + 1];
  }
  let lucMinYWorld = Infinity;
  for (let i = hostVertEnd; i < acc.vertexCount; i++) {
    if (acc.pos[i * 3 + 1] < lucMinYWorld) lucMinYWorld = acc.pos[i * 3 + 1];
  }
  assert.ok(
    Math.abs(lucMinYWorld - hostMaxYWorld) < 0.05,
    `Skylight bottom (${lucMinYWorld}) must sit flush on host roof (${hostMaxYWorld})`
  );

  // Check downhill wall skirt clamping on east edge (x = +20, where DEM is lower than west edge)
  let eastWallMinY = Infinity;
  let overhangBottomY = Infinity;
  for (let i = 0; i < hostVertEnd; i++) {
    const x = acc.pos[i * 3];
    const y = acc.pos[i * 3 + 1];
    const ny = acc.norm[i * 3 + 1];
    if (x > 19.5 && x < 20.5 && Math.abs(ny) <= 0.2 && y < eastWallMinY) {
      eastWallMinY = y;
    }
    if (x > 21.5 && Math.abs(ny) <= 0.2 && y < overhangBottomY) {
      overhangBottomY = y;
    }
  }
  const eastDemY = terrain.getHeightAtXZ(20, 0);
  assert.ok(
    eastWallMinY <= eastDemY - 1.49,
    `Downhill wall bottom (${eastWallMinY}) must clamp <= DEM - 1.5 (${eastDemY - 1.5})`
  );
  // Overhang at x=22 has ny=-1 bottom face -> must NOT clamp down to DEM - 1.5
  assert.ok(
    overhangBottomY > eastDemY - 1.0,
    `Overhang soffit wall (${overhangBottomY}) must NOT clamp down to skirt depth`
  );
});

// ---------------------------------------------------------------------------
// Suite 5: SLPK v1 Binary Packing, align4 Padding & --no-dedup Mode
// ---------------------------------------------------------------------------

test('Suite 5: SLPK v1 binary layout, align4 padding for V=5/7, and non-indexed mode', () => {
  for (const V of [5, 7]) {
    const I = 6;
    const pos = new Float32Array(V * 3).fill(1.5);
    const norm = new Float32Array(V * 3).fill(0);
    const col = new Uint8Array(V * 3).fill(200);
    const lh = new Float32Array(V).fill(3.2);
    const td = new Float32Array(V).fill(5.0);
    const rt = new Uint8Array(V).fill(2);
    const ws = new Uint8Array(V).fill(6);
    const idx = new Uint32Array([0, 1, 2, 2, 3, 4]);

    const bin = packSlpkChunkBinary({
      vertexCount: V,
      indexCount: I,
      buildingCount: 2,
      position: pos,
      normal: norm,
      color: col,
      aLocalHeight: lh,
      aTopDist: td,
      aRoofType: rt,
      aWallStyle: ws,
      indices: idx,
    });

    const expectedBytes = 32 + V * 32 + align4(V * 3) + 2 * align4(V) + I * 4;
    assert.equal(bin.byteLength, expectedBytes);
    assert.equal(bin.readUInt32LE(0), SLPK_MAGIC);
    assert.equal(bin.readUInt32LE(4), SLPK_VERSION);
    assert.equal(bin.readUInt32LE(8), V);
    assert.equal(bin.readUInt32LE(12), I);
    assert.equal(bin.readUInt32LE(16), 2);
    assert.equal(bin.readUInt32LE(20), 1);

    // Check padding bytes are zeroed
    const colOff = 32 + V * 24;
    for (let p = V * 3; p < align4(V * 3); p++) {
      assert.equal(bin[colOff + p], 0);
    }
    const rtOff = colOff + align4(V * 3) + V * 8;
    for (let p = V; p < align4(V); p++) {
      assert.equal(bin[rtOff + p], 0);
    }

    // Check non-indexed (--no-dedup)
    const nonIdxBin = packSlpkChunkBinary({
      vertexCount: V,
      indexCount: 0,
      buildingCount: 2,
      position: pos,
      normal: norm,
      color: col,
      aLocalHeight: lh,
      aTopDist: td,
      aRoofType: rt,
      aWallStyle: ws,
      indices: null,
    });
    assert.equal(nonIdxBin.readUInt32LE(12), 0);
    assert.equal(nonIdxBin.readUInt32LE(20), 0);
    assert.equal(nonIdxBin.byteLength, 32 + V * 32 + align4(V * 3) + 2 * align4(V));
  }
});

// ---------------------------------------------------------------------------
// Suite 6: Deduplication Invariants & TSL Attribute Synthesis Rules
// ---------------------------------------------------------------------------

test('Suite 6: Per-feature deduplication invariants and TSL attribute synthesis', () => {
  const dem = makeFlatDemGrid(652.2);
  const terrain = new TerrainElevation(dem);
  const obbCenter = [ORIGIN_LON, ORIGIN_LAT, 652.2];

  // Build two identical co-located boxes as TWO distinct features -> must NOT merge across features!
  // Within each box, 12 triangles (36 verts) share 24 corner/normal pairs (3 normals per corner -> 24 verts).
  const boxTris = makeBoxTrianglesMeters(10, 20, 652.2, 672.2, 10, 20, ...obbCenter);
  const gBuf = makeGeometryBuffer(
    [...boxTris, ...boxTris],
    [
      { oid: 1, start: 0, end: boxTris.length - 1 },
      { oid: 2, start: boxTris.length, end: boxTris.length * 2 - 1 },
    ]
  );
  const geom = decodeGeometryBuffer(gBuf);
  const fA = extractLeafFeatureTriangles(geom, 0, obbCenter);
  const fB = extractLeafFeatureTriangles(geom, 1, obbCenter);

  const acc = new ChunkMeshAccumulator(0, 0, true);
  const featVertMap = new Map();
  const hostGrid = new HostSpatialGrid(50);

  emitFeatureToAccumulator({
    acc,
    geomFeat: fA,
    id3d: 9001,
    capa: '01_EDIFICIO_P',
    altura: 20.0,
    terrain,
    hostGrid,
    featVertMap,
  });
  const vertsAfterA = acc.vertexCount;
  // 12 tris * 3 = 36 raw verts; each quad merges 2 diagonal verts -> 4 verts per face * 6 faces = 24 (sharp 90° corners do NOT merge!)
  assert.equal(vertsAfterA, 24);
  assert.equal(acc.indexCount, 36);

  emitFeatureToAccumulator({
    acc,
    geomFeat: fB,
    id3d: 9002,
    capa: '01_EDIFICIO_P',
    altura: 20.0,
    terrain,
    hostGrid,
    featVertMap,
  });
  // Distinct features never merge vertices
  assert.equal(acc.vertexCount, 48);
  assert.equal(acc.indexCount, 72);

  // TSL aWallStyle checks
  // North business district (AZCA/Cuatro Torres): worldZ < -2530, H >= 30 -> style 4 (glass)
  assert.equal(
    chooseBuildingWallStyle({
      capa: '01_EDIFICIO_P',
      id3d: 10127715,
      altura: 250,
      worldX: 559,
      worldZ: -6966,
      hasClassicRoof: true,
    }),
    4
  );
  // Gran Via / Alcala corridor landmark (Banco de Espana) -> 6 or 7, NOT 4
  const bdeStyle = chooseBuildingWallStyle({
    capa: '01_EDIFICIO_P',
    id3d: 10152073,
    altura: 64.7,
    worldX: -213,
    worldZ: -353,
    hasClassicRoof: false,
  });
  assert.ok(bdeStyle === 6 || bdeStyle === 7);

  // Cibeles (hasClassicRoof = true, altura = 63.9) -> 1 (Palace Stone), NOT 4
  assert.equal(
    chooseBuildingWallStyle({
      capa: '01_EDIFICIO_P',
      id3d: 10077863,
      altura: 63.9,
      worldX: 195,
      worldZ: -401,
      hasClassicRoof: true,
    }),
    1
  );

  // Color RGB8 determinism
  const c1 = computeFeatureColorRGB8(10077863);
  const c2 = computeFeatureColorRGB8(10077863);
  assert.deepEqual(c1, c2);
  assert.ok(c1.every((v) => v >= 0 && v <= 255));

  // Stepped building aTopDist uses per-column colMaxY (0.0 at lower terrace cornice, not 20.0 from central tower)
  const steppedBase = makeBoxTrianglesMeters(0, 20, 652.2, 672.2, 0, 20, ...obbCenter, { withBottom: false });
  const steppedTower = makeBoxTrianglesMeters(5, 15, 672.2, 692.2, 5, 15, ...obbCenter, { withBottom: false });
  const steppedTris = [...steppedBase, ...steppedTower];
  const sGeom = decodeGeometryBuffer(
    makeGeometryBuffer(steppedTris, [{ oid: 77, start: 0, end: steppedTris.length - 1 }])
  );
  const sFeat = extractLeafFeatureTriangles(sGeom, 0, obbCenter);
  const sAcc = new ChunkMeshAccumulator(0, 0, true);
  emitFeatureToAccumulator({
    acc: sAcc,
    geomFeat: sFeat,
    id3d: 9003,
    capa: '01_EDIFICIO_P',
    altura: 40.0,
    terrain,
    hostGrid,
    featVertMap: new Map(),
  });
  let foundTerraceTopDistZero = false;
  let foundRoofTopDistFive = false;
  for (let i = 0; i < sAcc.vertexCount; i++) {
    const x = sAcc.pos[i * 3];
    const lh = sAcc.lh[i];
    const rt = sAcc.rt[i];
    const td = sAcc.td[i];
    if (rt === 0 && Math.abs(x - 0) < 0.1 && Math.abs(lh - 20.0) < 0.1 && td < 0.05) {
      foundTerraceTopDistZero = true;
    }
    if (rt === 1 && Math.abs(td - 5.0) < 1e-5) {
      foundRoofTopDistFive = true;
    }
  }
  assert.ok(foundTerraceTopDistZero, 'Stepped outer wall cornice must have aTopDist == 0 via colMaxY');
  assert.ok(foundRoofTopDistFive, 'Flat roof must have aTopDist == 5.0');
});

// ---------------------------------------------------------------------------
// Suite 7: End-to-End Synthetic SLPK (ZIP32 & ZIP64) + CLI Flags
// ---------------------------------------------------------------------------

test('Suite 7: End-to-end synthetic SLPK (ZIP64 & ZIP32) + CLI --chunks/--bbox/--no-dedup/fail-fast', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slpk-test-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const obbCenter = [ORIGIN_LON, ORIGIN_LAT, 652.2];
  // Building in chunk 0_0 (x=50..60, z=50..60), dam in 0_0 (excluded), subterranean in 0_0 (excluded)
  const b1 = makeBoxTrianglesMeters(50, 60, 651.7, 672.2, 50, 60, ...obbCenter);
  const dam = makeBoxTrianglesMeters(70, 80, 651.7, 658.2, 70, 80, ...obbCenter);
  const sub = makeBoxTrianglesMeters(90, 95, 650.0, 652.0, 90, 95, ...obbCenter);
  const allTris = [...b1, ...dam, ...sub];

  const gBuf = makeGeometryBuffer(allTris, [
    { oid: 1, start: 0, end: b1.length - 1 },
    { oid: 2, start: b1.length, end: b1.length + dam.length - 1 },
    { oid: 3, start: b1.length + dam.length, end: allTris.length - 1 },
  ]);
  const f0 = makeOid32Buffer([1, 2, 3]);
  const f1 = makeInt32Buffer([7001, 7002, 7003]);
  const f2 = makeStringBuffer(['01_EDIFICIO_P', '01_PRESA_EMBALSE_P', '01_EDIFICIO_P'], true);
  const f6 = makeFloat64AlturaBuffer([20.0, 6.0, -0.5]);

  const nodepageJson = JSON.stringify({
    nodes: [
      { index: 0, children: [1] },
      {
        index: 1,
        obb: { center: obbCenter, halfSize: [200, 200, 30] },
        mesh: { geometry: { resource: 0 }, attribute: { resource: 0 } },
      },
    ],
  });

  const zipEntries = [
    { name: 'nodepages/0.json.gz', data: zlib.gzipSync(Buffer.from(nodepageJson)) },
    { name: 'nodes/0/geometries/0.bin.gz', data: zlib.gzipSync(gBuf) },
    { name: 'nodes/0/attributes/f_0/0.bin.gz', data: zlib.gzipSync(f0) },
    { name: 'nodes/0/attributes/f_1/0.bin.gz', data: zlib.gzipSync(f1) },
    { name: 'nodes/0/attributes/f_2/0.bin.gz', data: zlib.gzipSync(f2) },
    { name: 'nodes/0/attributes/f_6/0.bin.gz', data: zlib.gzipSync(f6) },
  ];

  const slpk64Path = path.join(tmpDir, 'synthetic_zip64.slpk');
  const slpk32Path = path.join(tmpDir, 'synthetic_zip32.slpk');
  fs.writeFileSync(slpk64Path, buildZipStoreArchive(zipEntries, { zip64: true }));
  fs.writeFileSync(slpk32Path, buildZipStoreArchive(zipEntries, { zip64: false }));

  // Verify openSlpkReader works on both ZIP64 and standard 32-bit ZIP
  const r32 = openSlpkReader(slpk32Path);
  assert.equal(r32.entries.size, 6);
  r32.close();

  const baseManifestPath = path.join(tmpDir, 'base-manifest.json');
  const dem = makeFlatDemGrid(652.2);
  fs.writeFileSync(
    baseManifestPath,
    JSON.stringify({
      meta: {
        origin: { lon: ORIGIN_LON, lat: ORIGIN_LAT },
        bbox: [-3.751, 40.382, -3.657, 40.487],
        chunkSizeM: 400,
        generatedAt: '2026-01-01T00:00:00Z',
        source: 'OpenStreetMap',
      },
      totals: { chunks: 2, buildings: 0, roads: 5, parks: 1, water: 0, trees: 2 },
      dem,
      chunks: [
        {
          key: '0_0',
          cx: 0,
          cz: 0,
          file: 'chunk_0_0.json',
          counts: { buildings: 0, roads: 3, parks: 1, water: 0, trees: 2 },
        },
        {
          key: '1_0',
          cx: 1,
          cz: 0,
          file: 'chunk_1_0.json',
          counts: { buildings: 0, roads: 2, parks: 0, water: 0, trees: 0 },
        },
      ],
    })
  );

  // Test CLI --chunks 0_0,1_0 against ZIP64 synthetic archive
  const outDir1 = path.join(tmpDir, 'out1');
  await execFileAsync('node', [
    'scripts/convert-slpk-chunks.mjs',
    '--slpk',
    slpk64Path,
    '--base-manifest',
    baseManifestPath,
    '--out-dir',
    outDir1,
    '--chunks',
    '0_0,1_0',
  ]);

  const manifest1 = JSON.parse(fs.readFileSync(path.join(outDir1, 'manifest.json'), 'utf8'));
  assert.equal(manifest1.meta.source, 'slpk-lod2');
  assert.deepEqual(manifest1.dem, dem);
  assert.equal(manifest1.totals.chunks, 2);
  assert.equal(manifest1.totals.buildings, 1); // dam + subterranean excluded!

  const c00 = manifest1.chunks.find((c) => c.key === '0_0');
  const c10 = manifest1.chunks.find((c) => c.key === '1_0');
  assert.equal(c00.file, 'chunk_0_0.json');
  assert.equal(c00.meshFile, '/data/chunks-slpk/chunk_0_0.bin');
  assert.equal(c00.counts.buildings, 1);
  assert.equal(c10.meshFile, undefined);
  assert.equal(fs.existsSync(path.join(outDir1, 'chunk_0_0.bin')), true);
  assert.equal(fs.existsSync(path.join(outDir1, 'chunk_1_0.bin')), false);

  const binBuf = fs.readFileSync(path.join(outDir1, 'chunk_0_0.bin'));
  assert.equal(binBuf.readUInt32LE(0), SLPK_MAGIC);
  assert.equal(binBuf.readUInt32LE(8), 24);
  assert.equal(binBuf.readUInt32LE(12), 36);
  assert.equal(binBuf.readUInt32LE(16), 1);
  assert.equal(binBuf.readUInt32LE(20), 1);

  // Test --bbox + --no-dedup via direct function
  const outDir2 = path.join(tmpDir, 'out2');
  const res2 = convertSlpkToChunks({
    slpkPath: slpk32Path,
    baseManifestPath,
    outDir: outDir2,
    bbox: [-3.694, 40.411, -3.69, 40.415],
    dedup: false,
    silent: true,
  });
  assert.equal(res2.manifest.chunks.length, 1);
  assert.equal(res2.manifest.chunks[0].key, '0_0');
  const binNoDedup = fs.readFileSync(path.join(outDir2, 'chunk_0_0.bin'));
  assert.equal(binNoDedup.readUInt32LE(8), 36);
  assert.equal(binNoDedup.readUInt32LE(12), 0);
  assert.equal(binNoDedup.readUInt32LE(20), 0);

  // Unknown --chunks must fail fast with non-zero exit code
  await assert.rejects(
    execFileAsync('node', [
      'scripts/convert-slpk-chunks.mjs',
      '--slpk',
      slpk64Path,
      '--base-manifest',
      baseManifestPath,
      '--out-dir',
      outDir1,
      '--chunks',
      '999_999',
    ])
  );
});

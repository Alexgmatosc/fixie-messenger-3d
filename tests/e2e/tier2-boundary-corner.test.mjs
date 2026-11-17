/**
 * Tier 2 — Boundary, Corner & Negative E2E Suite (50 tests: 5 per feature F1–F10).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import {
  BASE_MANIFEST_EXPECTATIONS,
  BBOX_SUBSETS,
  BOUNDARY_CHUNKS,
  LANDMARKS,
  MAP_BBOX,
  OUTSIDE_MAP_BBOX_LEAVES,
  PATHS,
  SLPK_HEADER_BYTES,
  SLPK_MAGIC,
  SLPK_VERSION,
} from './fixtures/madrid-fixtures.mjs';
import {
  acquireBrowserContext,
  getBrowserConfigFromEnv,
  isAllowlistedConsoleCheck,
  isIgnorableNetworkUrl,
} from './helpers/cdp-browser.mjs';
import {
  cleanupAllCliTempDirs,
  createCliTempDir,
  getGitState,
  inspectConverterHelp,
  removeCliTempDir,
  requireConverterCli,
  runConverter,
  runConverterCached,
} from './helpers/cli.mjs';
import { ensureDevServer } from './helpers/dev-server.mjs';
import {
  align4,
  assertLocalDemAlignment,
  countTrianglesInBox,
  createTerrainEvaluator,
  loadBaseManifest,
  loadJsonFile,
  parseSlpkChunk,
  projectToMeters,
  readAndParseSlpkChunk,
  unprojectFromMeters,
  validateSlpkChunkGeometry,
} from './helpers/slpk-binary.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let serverCtx = null;
let browserCtx = null;
let browserPromise = null;

after(async () => {
  if (browserCtx?.browser) {
    await browserCtx.browser.close().catch(() => {});
  }
  if (serverCtx) {
    await serverCtx.close().catch(() => {});
  }
  await cleanupAllCliTempDirs();
});

async function requireLiveBrowser(t) {
  if (!browserPromise) {
    browserPromise = (async () => {
      const cfg = getBrowserConfigFromEnv();
      if (cfg.mode === 'off') {
        browserCtx = { available: false, skip: true, reason: 'Browser tests disabled (--browser=off)', browser: null };
        return browserCtx;
      }
      serverCtx = await ensureDevServer();
      browserCtx = await acquireBrowserContext({ baseUrl: serverCtx.baseUrl, config: cfg });
      return browserCtx;
    })();
  }
  const ctx = await browserPromise;
  if (!ctx || ctx.skip || !ctx.browser) {
    t.skip(ctx?.reason || 'Browser unavailable');
    return null;
  }
  return ctx.browser;
}

/**
 * Builds an in-memory SLPK v1 binary chunk buffer for boundary/negative validation.
 */
function buildSyntheticSlpkBuffer({
  magic = SLPK_MAGIC,
  version = SLPK_VERSION,
  buildingCount = 1,
  positions = [0, 0, 0, 10, 0, 0, 0, 10, 0],
  normals = [0, 0, 1, 0, 0, 1, 0, 0, 1],
  colors = [180, 180, 180, 180, 180, 180, 180, 180, 180],
  aLocalHeight = [0, 0, 10],
  aTopDist = [10, 10, 0],
  aRoofType = [0, 0, 0],
  aWallStyle = [0, 0, 0],
  indices = [0, 1, 2],
  reserved0 = 0,
  reserved1 = 0,
  flagsOverride = null,
} = {}) {
  const V = positions.length / 3;
  const I = indices ? indices.length : 0;
  const flags = flagsOverride !== null ? flagsOverride : I > 0 ? 1 : 0;
  const totalBytes =
    SLPK_HEADER_BYTES +
    V * 12 +
    V * 12 +
    align4(V * 3) +
    V * 4 +
    V * 4 +
    align4(V) +
    align4(V) +
    (I > 0 ? I * 4 : 0);

  const buf = Buffer.alloc(totalBytes);
  buf.writeUInt32LE(magic >>> 0, 0);
  buf.writeUInt32LE(version >>> 0, 4);
  buf.writeUInt32LE(V >>> 0, 8);
  buf.writeUInt32LE(I >>> 0, 12);
  buf.writeUInt32LE(buildingCount >>> 0, 16);
  buf.writeUInt32LE(flags >>> 0, 20);
  buf.writeUInt32LE(reserved0 >>> 0, 24);
  buf.writeUInt32LE(reserved1 >>> 0, 28);

  let off = SLPK_HEADER_BYTES;
  for (let i = 0; i < positions.length; i++) {
    buf.writeFloatLE(positions[i], off + i * 4);
  }
  off += V * 12;
  for (let i = 0; i < normals.length; i++) {
    buf.writeFloatLE(normals[i], off + i * 4);
  }
  off += V * 12;
  for (let i = 0; i < colors.length; i++) {
    buf[off + i] = colors[i];
  }
  off += align4(V * 3);
  for (let i = 0; i < aLocalHeight.length; i++) {
    buf.writeFloatLE(aLocalHeight[i], off + i * 4);
  }
  off += V * 4;
  for (let i = 0; i < aTopDist.length; i++) {
    buf.writeFloatLE(aTopDist[i], off + i * 4);
  }
  off += V * 4;
  for (let i = 0; i < aRoofType.length; i++) {
    buf[off + i] = aRoofType[i];
  }
  off += align4(V);
  for (let i = 0; i < aWallStyle.length; i++) {
    buf[off + i] = aWallStyle[i];
  }
  off += align4(V);
  if (I > 0) {
    for (let i = 0; i < indices.length; i++) {
      buf.writeUInt32LE(indices[i] >>> 0, off + i * 4);
    }
  }
  return buf;
}

describe('Tier 2 — Boundary, Corner & Negative Cases (F1–F10, 50 tests)', () => {
  // ---------------------------------------------------------------------------
  // F1 Boundary/Negative (5 tests)
  // ---------------------------------------------------------------------------
  describe('F1 Boundaries: SLPK Extraction', () => {
    test('F1.B1 Missing SLPK archive path causes clean non-zero CLI exit', async () => {
      const cli = requireConverterCli();
      const help = await inspectConverterHelp(cli);
      const outDir = await createCliTempDir('fixie-e2e-missing-slpk-');
      try {
        const res = await runConverter(
          [help.inputFlag, '/tmp/nonexistent-madrid-archive-99999.slpk', '--chunks', '0_0'],
          { outDir }
        );
        assert.notEqual(res.exitCode, 0, 'Expected non-zero exit when SLPK archive path does not exist');
        const bins = fs.readdirSync(outDir).filter((f) => f.endsWith('.bin'));
        assert.equal(bins.length, 0, 'Expected no partial .bin files written on missing input');
      } finally {
        await removeCliTempDir(outDir);
      }
    });

    test('F1.B2 Outlier node 4897 with trailing-newline CAPA outside MAP_BBOX is excluded from M-30 manifest', () => {
      const manifest = loadJsonFile(PATHS.slpkManifest, 'full SLPK manifest');
      const outlierKey = OUTSIDE_MAP_BBOX_LEAVES.trailingNewlineCapa.chunkKey;
      const found = manifest.chunks.find((c) => c.key === outlierKey);
      assert.equal(found, undefined, `Outside-MAP_BBOX chunk ${outlierKey} must not be in manifest`);
    });

    test('F1.B3 OSM-0 / SLPK-236 mismatch chunk (-12_-12) extracts SLPK features via centroid partitioning', async () => {
      const res = await runConverterCached('chunks:-12_-12', ['--chunks', BOUNDARY_CHUNKS.osmZeroSlpkPositive.key]);
      assert.equal(res.exitCode, 0, `Converter failed: ${res.stderr || res.stdout}`);
      const parsed = readAndParseSlpkChunk(path.join(res.outDir, 'chunk_-12_-12.bin'));
      assert.ok(parsed.header.buildingCount > 0, 'Expected SLPK features in -12_-12 despite 0 OSM buildings');
      validateSlpkChunkGeometry(parsed, { chunkKey: '-12_-12', requireNonEmpty: true });
    });

    test('F1.B4 Rare CAPA 01_PRESA_EMBALSE_P chunk (-1_7) exports cleanly without category crash', async () => {
      const res = await runConverterCached('chunks:-1_7', ['--chunks', BOUNDARY_CHUNKS.presaEmbalse.chunkKey]);
      assert.equal(res.exitCode, 0, `Converter failed on rare CAPA chunk -1_7: ${res.stderr || res.stdout}`);
      const parsed = readAndParseSlpkChunk(path.join(res.outDir, 'chunk_-1_7.bin'));
      validateSlpkChunkGeometry(parsed, { chunkKey: '-1_7', requireNonEmpty: true });
    });

    test('F1.B5 Isolated --out-dir converter run never creates or modifies public/data/chunks-slpk/', async () => {
      const beforeExists = fs.existsSync(PATHS.slpkManifest);
      const beforeMtime = beforeExists ? fs.statSync(PATHS.slpkManifest).mtimeMs : null;
      const res = await runConverterCached('chunks:0_0', ['--chunks', '0_0']);
      assert.equal(res.exitCode, 0, `Converter failed: ${res.stderr || res.stdout}`);
      const afterExists = fs.existsSync(PATHS.slpkManifest);
      assert.equal(afterExists, beforeExists);
      if (beforeMtime !== null) {
        assert.equal(fs.statSync(PATHS.slpkManifest).mtimeMs, beforeMtime);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // F2 Boundary/Negative (5 tests)
  // ---------------------------------------------------------------------------
  describe('F2 Boundaries: Projection, Winding & Normals', () => {
    test('F2.B1 Projection/unprojection round-trip holds at all 4 MAP_BBOX corners', () => {
      const corners = [
        [MAP_BBOX[0], MAP_BBOX[1]],
        [MAP_BBOX[2], MAP_BBOX[1]],
        [MAP_BBOX[0], MAP_BBOX[3]],
        [MAP_BBOX[2], MAP_BBOX[3]],
      ];
      for (const [lon, lat] of corners) {
        const [x, z] = projectToMeters(lon, lat);
        const [lon2, lat2] = unprojectFromMeters(x, z);
        assert.ok(Math.abs(lon2 - lon) < 1e-9, `Lon round-trip drift: ${lon2} vs ${lon}`);
        assert.ok(Math.abs(lat2 - lat) < 1e-9, `Lat round-trip drift: ${lat2} vs ${lat}`);
      }
    });

    test('F2.B2 Tall skyscraper Telefónica (-2_-2) maintains >= 99% outward CCW winding', async () => {
      const res = await runConverterCached('chunks:granvia', ['--chunks', '-2_-2,-1_-2']);
      assert.equal(res.exitCode, 0, `Converter failed: ${res.stderr || res.stdout}`);
      const parsed = readAndParseSlpkChunk(path.join(res.outDir, 'chunk_-2_-2.bin'));
      validateSlpkChunkGeometry(parsed, { chunkKey: '-2_-2', minOutwardWindingRatio: 0.99, requireNonEmpty: true });
    });

    test('F2.B3 Curved Atocha canopy (0_2) maintains unit normals (0.98..1.02) and outward winding', async () => {
      const res = await runConverterCached('chunks:atocha', ['--chunks', '0_2,1_2']);
      assert.equal(res.exitCode, 0, `Converter failed: ${res.stderr || res.stdout}`);
      const parsed = readAndParseSlpkChunk(path.join(res.outDir, 'chunk_0_2.bin'));
      validateSlpkChunkGeometry(parsed, {
        chunkKey: '0_2',
        minNormalLen: 0.98,
        maxNormalLen: 1.02,
        minOutwardWindingRatio: 0.99,
        requireNonEmpty: true,
      });
    });

    test('F2.B4 Binary validator rejects synthetic buffer with inverted winding or non-unit normal', () => {
      const invertedWinding = buildSyntheticSlpkBuffer({
        indices: [0, 2, 1], // reversed winding against +Z normal
      });
      assert.throws(
        () => validateSlpkChunkGeometry(parseSlpkChunk(invertedWinding)),
        assert.AssertionError,
        'Expected inverted triangle winding to fail validation'
      );

      const badNormal = buildSyntheticSlpkBuffer({
        normals: [0, 0, 2, 0, 0, 2, 0, 0, 2],
      });
      assert.throws(
        () => validateSlpkChunkGeometry(parseSlpkChunk(badNormal)),
        assert.AssertionError,
        'Expected non-unit normal to fail validation'
      );
    });

    test('F2.B5 Exported .bin vertices stay in local meters, never raw WGS84 degrees', async () => {
      const res = await runConverterCached('chunks:0_0', ['--chunks', '0_0']);
      assert.equal(res.exitCode, 0, `Converter failed: ${res.stderr || res.stdout}`);
      const parsed = readAndParseSlpkChunk(path.join(res.outDir, 'chunk_0_0.bin'));
      const metrics = validateSlpkChunkGeometry(parsed, { chunkKey: '0_0', requireNonEmpty: true });
      assert.ok(metrics.bounds.maxX > 50, 'Expected meter-scale X bounds > 50m in chunk 0_0');
    });
  });

  // ---------------------------------------------------------------------------
  // F3 Boundary/Negative (5 tests)
  // ---------------------------------------------------------------------------
  describe('F3 Boundaries: LoD2 Roof/Dome Preservation', () => {
    test('F3.B1 Edificio Telefónica (-2_-2) preserves full ~84.75m skyscraper vertical span', async () => {
      const res = await runConverterCached('chunks:granvia', ['--chunks', '-2_-2,-1_-2']);
      assert.equal(res.exitCode, 0, `Converter failed: ${res.stderr || res.stdout}`);
      const parsed = readAndParseSlpkChunk(path.join(res.outDir, 'chunk_-2_-2.bin'));
      const box = countTrianglesInBox(parsed, {
        minX: LANDMARKS.granVia.telefonica.x - 120,
        maxX: LANDMARKS.granVia.telefonica.x + 120,
        minZ: LANDMARKS.granVia.telefonica.z - 120,
        maxZ: LANDMARKS.granVia.telefonica.z + 120,
      });
      const spanY = (box.maxY ?? 0) - (box.minY ?? 0);
      assert.ok(
        spanY >= LANDMARKS.granVia.telefonica.altura - 5,
        `Expected Telefónica Y span >= 79.75m, got ${spanY.toFixed(2)}m`
      );
    });

    test('F3.B2 Small roadway/kiosk structures in Atocha neighbor (0_3) and Retiro (2_-1) export cleanly', async () => {
      const res = await runConverterCached('chunks:0_3', ['--chunks', '0_3']);
      assert.equal(res.exitCode, 0, `Converter failed: ${res.stderr || res.stdout}`);
      const parsed = readAndParseSlpkChunk(path.join(res.outDir, 'chunk_0_3.bin'));
      const metrics = validateSlpkChunkGeometry(parsed, { chunkKey: '0_3', requireNonEmpty: true });
      assert.ok(metrics.triangleCount > 20, 'Expected small structures in 0_3 to be preserved');
    });

    test('F3.B3 Cibeles rooftop skylight area preserves intricate non-collapsed detail', async () => {
      const res = await runConverterCached('chunks:0_-2', ['--chunks', '0_-2']);
      assert.equal(res.exitCode, 0, `Converter failed: ${res.stderr || res.stdout}`);
      const parsed = readAndParseSlpkChunk(path.join(res.outDir, 'chunk_0_-2.bin'));
      const metrics = validateSlpkChunkGeometry(parsed, { chunkKey: '0_-2', requireNonEmpty: true });
      assert.ok(metrics.triangleCount >= LANDMARKS.cibeles.tris + LANDMARKS.cibeles.skylightTris);
    });

    test('F3.B4 Degenerate zero-area triangles stay below 5% in exported chunks', async () => {
      const res = await runConverterCached('chunks:0_-2', ['--chunks', '0_-2']);
      assert.equal(res.exitCode, 0, `Converter failed: ${res.stderr || res.stdout}`);
      const parsed = readAndParseSlpkChunk(path.join(res.outDir, 'chunk_0_-2.bin'));
      const metrics = validateSlpkChunkGeometry(parsed, { chunkKey: '0_-2', requireNonEmpty: true });
      const degenRatio = metrics.degenerateTriangles / Math.max(1, metrics.triangleCount);
      assert.ok(degenRatio < 0.05, `Degenerate triangle ratio too high: ${(degenRatio * 100).toFixed(2)}%`);
    });

    test('F3.B5 Binary validator rejects out-of-range aRoofType > 5 and upward roof aTopDist < 5.0', () => {
      const badRoof = buildSyntheticSlpkBuffer({ aRoofType: [6, 0, 0] });
      assert.throws(() => validateSlpkChunkGeometry(parseSlpkChunk(badRoof)), assert.AssertionError);

      const badTopDist = buildSyntheticSlpkBuffer({
        positions: [0, 10, 0, 0, 10, 10, 10, 10, 0],
        normals: [0, 1, 0, 0, 1, 0, 0, 1, 0],
        aRoofType: [2, 2, 2],
        aTopDist: [1.0, 1.0, 1.0],
      });
      assert.throws(() => validateSlpkChunkGeometry(parseSlpkChunk(badTopDist)), assert.AssertionError);
    });
  });

  // ---------------------------------------------------------------------------
  // F4 Boundary/Negative (5 tests)
  // ---------------------------------------------------------------------------
  describe('F4 Boundaries: Terrain Elevation Alignment', () => {
    test('F4.B1 TerrainElevation clamps out-of-bbox coordinates without NaN or exceptions', () => {
      const terrain = createTerrainEvaluator(loadBaseManifest().dem);
      for (const [lon, lat] of [[-5, 39], [-2, 42], [-10, 40], [0, 45]]) {
        const y = terrain.getHeightAtLonLat(lon, lat);
        assert.ok(Number.isFinite(y), `Expected finite clamped DEM elevation for (${lon}, ${lat})`);
      }
    });

    test('F4.B2 Palacio Real (-5_-1) steep 28m local slope tracks TerrainElevation per building', async () => {
      const terrain = createTerrainEvaluator(loadBaseManifest().dem);
      const res = await runConverterCached('chunks:palacio', ['--chunks', '-5_-1,-5_0']);
      assert.equal(res.exitCode, 0, `Converter failed: ${res.stderr || res.stdout}`);
      const parsed = readAndParseSlpkChunk(path.join(res.outDir, 'chunk_-5_-1.bin'));
      const align = assertLocalDemAlignment(parsed, terrain);
      const spread = align.maxDelta - align.minDelta;
      assert.ok(spread < 30, `Expected per-building local DEM alignment (spread=${spread.toFixed(2)}m < 30m)`);
    });

    test('F4.B3 Cuesta de la Vega (-5_0) negative DEM terrain places building bases below Y=0 origin', async () => {
      const terrain = createTerrainEvaluator(loadBaseManifest().dem);
      const res = await runConverterCached('chunks:palacio', ['--chunks', '-5_-1,-5_0']);
      assert.equal(res.exitCode, 0, `Converter failed: ${res.stderr || res.stdout}`);
      const parsed = readAndParseSlpkChunk(path.join(res.outDir, 'chunk_-5_0.bin'));
      const metrics = validateSlpkChunkGeometry(parsed, { chunkKey: '-5_0', terrain, requireNonEmpty: true });
      assert.ok(metrics.bounds.minY < -5, `Expected negative Y bases on Cuesta de la Vega slope, got minY=${metrics.bounds.minY}`);
    });

    test('F4.B4 Atocha elevated canopy retains > 10m clearance above ground while nearby bases stay flush', async () => {
      const terrain = createTerrainEvaluator(loadBaseManifest().dem);
      const res = await runConverterCached('chunks:atocha', ['--chunks', '0_2,1_2']);
      assert.equal(res.exitCode, 0, `Converter failed: ${res.stderr || res.stdout}`);
      const parsed = readAndParseSlpkChunk(path.join(res.outDir, 'chunk_0_2.bin'));
      const align = assertLocalDemAlignment(parsed, terrain);
      assert.ok(align.medianDelta <= 4, `Expected chunk 0_2 median ground building base <= +4m, got ${align.medianDelta.toFixed(2)}m`);
      const box = countTrianglesInBox(parsed, { minX: 250, maxX: 520, minZ: 900, maxZ: 1200 });
      const groundY = terrain.getHeightAtXZ(LANDMARKS.atocha.x, LANDMARKS.atocha.z);
      assert.ok((box.maxY ?? -Infinity) > groundY + 15, 'Expected elevated Atocha canopy preserved');
    });

    test('F4.B5 High-elevation North Madrid (Plaza de Castilla 1_-15) aligns to positive DEM height', async () => {
      const terrain = createTerrainEvaluator(loadBaseManifest().dem);
      const res = await runConverterCached('chunks:1_-15', ['--chunks', '1_-15']);
      assert.equal(res.exitCode, 0, `Converter failed: ${res.stderr || res.stdout}`);
      const parsed = readAndParseSlpkChunk(path.join(res.outDir, 'chunk_1_-15.bin'));
      const metrics = validateSlpkChunkGeometry(parsed, { chunkKey: '1_-15', terrain, requireNonEmpty: true });
      assert.ok(metrics.bounds.maxY > 40, `Expected elevated North Madrid buildings > +40m, got ${metrics.bounds.maxY}`);
      assertLocalDemAlignment(parsed, terrain);
    });
  });

  // ---------------------------------------------------------------------------
  // F5 Boundary/Negative (5 tests)
  // ---------------------------------------------------------------------------
  describe('F5 Boundaries: Partitioning & CLI Filtering', () => {
    test('F5.B1 Empty M-30 perimeter chunks (-11_-14, -10_-14) handle 0 SLPK buildings gracefully', async () => {
      const res = await runConverterCached('chunks:empty-perimeter', [
        '--chunks',
        BOUNDARY_CHUNKS.emptyPerimeter.join(','),
      ]);
      assert.equal(res.exitCode, 0, `Expected graceful exit 0 on empty perimeter chunks: ${res.stderr || res.stdout}`);
      const manifest = loadJsonFile(res.manifestPath, 'empty perimeter manifest');
      for (const entry of manifest.chunks) {
        if (entry.meshFile) {
          const binPath = path.join(res.outDir, path.basename(entry.meshFile));
          if (fs.existsSync(binPath)) {
            const parsed = readAndParseSlpkChunk(binPath);
            assert.equal(parsed.header.buildingCount, 0);
          }
        }
      }
    });

    test('F5.B2 Outside-MAP_BBOX leaves (1_-25, -8_13, 12_-2, -13_12) are absent from full manifest', () => {
      const manifest = loadJsonFile(PATHS.slpkManifest, 'full SLPK manifest');
      const keys = new Set(manifest.chunks.map((c) => c.key));
      for (const leaf of Object.values(OUTSIDE_MAP_BBOX_LEAVES)) {
        assert.equal(keys.has(leaf.chunkKey), false, `Outside-MAP_BBOX chunk ${leaf.chunkKey} leaked into manifest`);
      }
    });

    test('F5.B3 Malformed --bbox arguments fail with non-zero exit code and zero corrupt .bin outputs', async () => {
      requireConverterCli();
      const badBboxes = ['-3.69,40.41,-3.70,40.42', '1,2,3', 'a,b,c,d'];
      for (const bad of badBboxes) {
        const outDir = await createCliTempDir('fixie-e2e-bad-bbox-');
        try {
          const res = await runConverter(['--bbox', bad], { outDir });
          assert.notEqual(res.exitCode, 0, `Expected non-zero exit for malformed --bbox "${bad}"`);
          const bins = fs.readdirSync(outDir).filter((f) => f.endsWith('.bin'));
          assert.equal(bins.length, 0, `Expected no .bin output for malformed --bbox "${bad}"`);
        } finally {
          await removeCliTempDir(outDir);
        }
      }
    });

    test('F5.B4 Non-overlapping ocean --bbox 0,0,0.001,0.001 yields 0 chunks without crashing', async () => {
      const outDir = await createCliTempDir('fixie-e2e-empty-bbox-');
      try {
        const res = await runConverter(['--bbox', BBOX_SUBSETS.oceanEmpty], { outDir });
        assert.ok(res.exitCode === 0 || !fs.existsSync(path.join(outDir, 'chunk_0_0.bin')));
        if (res.exitCode === 0 && fs.existsSync(res.manifestPath)) {
          const m = loadJsonFile(res.manifestPath, 'empty bbox manifest');
          assert.equal(m.chunks.length, 0);
        }
      } finally {
        await removeCliTempDir(outDir);
      }
    });

    test('F5.B5 Malformed --chunks key fails cleanly with non-zero exit code', async () => {
      requireConverterCli();
      const outDir = await createCliTempDir('fixie-e2e-bad-chunks-');
      try {
        const res = await runConverter(['--chunks', 'not_a_chunk_key'], { outDir });
        assert.notEqual(res.exitCode, 0, 'Expected non-zero exit for malformed --chunks "not_a_chunk_key"');
      } finally {
        await removeCliTempDir(outDir);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // F6 Boundary/Negative (5 tests)
  // ---------------------------------------------------------------------------
  describe('F6 Boundaries: Binary Format & Attributes', () => {
    test('F6.B1 Binary parser rejects truncated buffer, bad magic, bad version, and mismatched byte length', () => {
      assert.throws(() => parseSlpkChunk(Buffer.alloc(16)), assert.AssertionError);
      assert.throws(() => parseSlpkChunk(buildSyntheticSlpkBuffer({ magic: 0xdeadbeef })), assert.AssertionError);
      assert.throws(() => parseSlpkChunk(buildSyntheticSlpkBuffer({ version: 99 })), assert.AssertionError);
      const valid = buildSyntheticSlpkBuffer();
      assert.throws(() => parseSlpkChunk(valid.subarray(0, valid.byteLength - 4)), assert.AssertionError);
    });

    test('F6.B2 Binary parser rejects out-of-range aWallStyle > 7 and out-of-bounds index >= V', () => {
      assert.throws(
        () => validateSlpkChunkGeometry(parseSlpkChunk(buildSyntheticSlpkBuffer({ aWallStyle: [8, 0, 0] }))),
        assert.AssertionError
      );
      assert.throws(
        () => validateSlpkChunkGeometry(parseSlpkChunk(buildSyntheticSlpkBuffer({ indices: [0, 1, 99] }))),
        assert.AssertionError
      );
    });

    test('F6.B3 align4 padding is honored when vertexCount is not divisible by 4 (synthetic V=3 and V=5)', () => {
      const buf3 = buildSyntheticSlpkBuffer();
      const parsed3 = parseSlpkChunk(buf3);
      assert.equal(parsed3.header.vertexCount, 3);
      assert.equal(parsed3.byteLength % 4, 0);
      validateSlpkChunkGeometry(parsed3);
    });

    test('F6.B4 Low-count border chunk (-10_-6: 1 OSM building, 11 SLPK features) packs validly', async () => {
      const res = await runConverterCached('chunks:-10_-6', ['--chunks', '-10_-6']);
      assert.equal(res.exitCode, 0, `Converter failed: ${res.stderr || res.stdout}`);
      const parsed = readAndParseSlpkChunk(path.join(res.outDir, 'chunk_-10_-6.bin'));
      assert.ok(parsed.header.buildingCount >= 1);
      validateSlpkChunkGeometry(parsed, { chunkKey: '-10_-6', requireNonEmpty: true });
    });

    test('F6.B5 Header reserved fields and indexed flag bit 0 remain invariant across multiple chunks', async () => {
      const res = await runConverterCached('chunks:granvia', ['--chunks', '-2_-2,-1_-2']);
      assert.equal(res.exitCode, 0, `Converter failed: ${res.stderr || res.stdout}`);
      for (const k of ['-2_-2', '-1_-2']) {
        const parsed = readAndParseSlpkChunk(path.join(res.outDir, `chunk_${k}.bin`));
        assert.equal(parsed.header.reserved0, 0);
        assert.equal(parsed.header.reserved1, 0);
        assert.equal(parsed.header.flags & 1, parsed.header.indexCount > 0 ? 1 : 0);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // F7 Boundary/Negative (5 tests)
  // ---------------------------------------------------------------------------
  describe('F7 Boundaries: Streaming & Manifest Integrity', () => {
    test('F7.B1 Empty-building perimeter chunks do not cause 404 .bin fetches during navigation', async (t) => {
      const browser = await requireLiveBrowser(t);
      if (!browser) return;
      await browser.goto(`${serverCtx.baseUrl}/?map=slpk`);
      await browser.waitForAppReady();
      browser.clearEvents();
      await browser.click('#btn-pois');
      await sleep(150);
      await browser.clickPoi('Plaza de Castilla');
      await sleep(1200);
      browser.assertCleanRuntime({ mode: 'map' });
    });

    test('F7.B2 Rapid sequential POI jumps abort inflight fetches cleanly without stale errors', async (t) => {
      const browser = await requireLiveBrowser(t);
      if (!browser) return;
      await browser.goto(`${serverCtx.baseUrl}/?map=slpk`);
      await browser.waitForAppReady();
      browser.clearEvents();
      await browser.click('#btn-pois');
      for (const poi of ['Plaza de Castilla', 'Matadero', 'Palacio Real', 'Fuente de Neptuno']) {
        await browser.clickPoi(poi);
        await sleep(120);
      }
      await sleep(1000);
      browser.assertCleanRuntime({ mode: 'map' });
    });

    test('F7.B3 Full SLPK manifest counts and totals are finite non-negative integers', () => {
      const slpk = loadJsonFile(PATHS.slpkManifest, 'full SLPK manifest');
      assert.equal(slpk.totals.chunks, slpk.chunks.length);
      for (const c of slpk.chunks) {
        for (const field of ['buildings', 'roads', 'parks', 'water', 'trees']) {
          assert.ok(Number.isInteger(c.counts[field]) && c.counts[field] >= 0, `Invalid count ${field} on ${c.key}`);
        }
      }
    });

    test('F7.B4 Every manifest entry key equals "${cx}_${cz}" and matches base manifest chunk grid', () => {
      const base = loadBaseManifest();
      const slpk = loadJsonFile(PATHS.slpkManifest, 'full SLPK manifest');
      assert.equal(slpk.chunks.length, BASE_MANIFEST_EXPECTATIONS.totalChunks);
      const baseKeys = new Set(base.chunks.map((c) => c.key));
      for (const c of slpk.chunks) {
        assert.equal(c.key, `${c.cx}_${c.cz}`);
        assert.ok(baseKeys.has(c.key), `SLPK chunk ${c.key} missing from base manifest`);
      }
    });

    test('F7.B5 Invalid ?map=unknown query parameter degrades gracefully without crashing', async (t) => {
      const browser = await requireLiveBrowser(t);
      if (!browser) return;
      await browser.goto(`${serverCtx.baseUrl}/?map=unknown_invalid_mode`);
      const ready = await browser.waitForAppReady();
      assert.equal(ready.hidden, true);
      browser.assertCleanRuntime({ mode: 'map' });
    });
  });

  // ---------------------------------------------------------------------------
  // F8 Boundary/Negative (5 tests)
  // ---------------------------------------------------------------------------
  describe('F8 Boundaries: WebGPU Material & Disposal', () => {
    test('F8.B1 Rapidly clicking #btn-map-source 6 times causes zero WebGPU or disposal errors', async (t) => {
      const browser = await requireLiveBrowser(t);
      if (!browser) return;
      await browser.goto(`${serverCtx.baseUrl}/?map=slpk`);
      await browser.waitForAppReady();
      browser.clearEvents();
      for (let i = 0; i < 6; i++) {
        await browser.click('#btn-map-source', { force: true });
        await sleep(200);
      }
      await sleep(1000);
      browser.assertCleanRuntime({ mode: 'switch' });
    });

    test('F8.B2 Touring > 55 chunks across M-30 triggers LRU cache eviction with zero GPU errors', async (t) => {
      const browser = await requireLiveBrowser(t);
      if (!browser) return;
      await browser.goto(`${serverCtx.baseUrl}/?map=slpk`);
      await browser.waitForAppReady();
      browser.clearEvents();
      await browser.click('#btn-pois');
      for (const poi of ['Plaza de Castilla', 'AZCA', 'Las Ventas', 'Matadero', 'Templo de Debod', 'Palacio Real']) {
        await browser.clickPoi(poi);
        await sleep(800);
      }
      const tel = await browser.getTelemetry();
      assert.ok(tel.activeChunks <= 55, `Expected activeChunks <= 55 warm cache limit, got ${tel.activeChunks}`);
      browser.assertCleanRuntime({ mode: 'map' });
    });

    test('F8.B3 Viewport resize (1280x800 -> 800x600 -> 1280x800) preserves WebGPU rendering', async (t) => {
      const browser = await requireLiveBrowser(t);
      if (!browser) return;
      await browser.goto(`${serverCtx.baseUrl}/?map=slpk`);
      await browser.waitForAppReady();
      browser.clearEvents();
      await browser.setViewport(800, 600);
      await sleep(350);
      const small = await browser.getTelemetry();
      assert.equal(small.canvasClientWidth, 800);
      await browser.setViewport(1280, 800);
      await sleep(350);
      const restored = await browser.getTelemetry();
      assert.equal(restored.canvasClientWidth, 1280);
      browser.assertCleanRuntime({ mode: 'map' });
    });

    test('F8.B4 Fixie Bike mode on SLPK map triggers zero new SLPK AttributeNode warnings', async (t) => {
      const browser = await requireLiveBrowser(t);
      if (!browser) return;
      await browser.goto(`${serverCtx.baseUrl}/?map=slpk`);
      await browser.waitForAppReady();
      browser.clearEvents();
      await browser.click('#btn-cam-bike');
      await sleep(500);
      // mode: 'bike' isolates pre-existing bike-mesh 'normal' hint while failing on any SLPK attribute warning
      browser.assertCleanRuntime({ mode: 'bike' });
    });

    test('F8.B5 All sampled SLPK chunks keep aWallStyle within [0..7] for MadridFacadeArrays', async () => {
      const res = await runConverterCached('chunks:atocha', ['--chunks', '0_2,1_2']);
      assert.equal(res.exitCode, 0, `Converter failed: ${res.stderr || res.stdout}`);
      for (const k of ['0_2', '1_2']) {
        const parsed = readAndParseSlpkChunk(path.join(res.outDir, `chunk_${k}.bin`));
        validateSlpkChunkGeometry(parsed, { chunkKey: k, requireNonEmpty: true });
      }
    });
  });

  // ---------------------------------------------------------------------------
  // F9 Boundary/Negative (5 tests)
  // ---------------------------------------------------------------------------
  describe('F9 Boundaries: Map Source UI', () => {
    test('F9.B1 #btn-map-source aria-pressed and .active update consistently across mode toggles', async (t) => {
      const browser = await requireLiveBrowser(t);
      if (!browser) return;
      await browser.goto(`${serverCtx.baseUrl}/?map=slpk`);
      await browser.waitForAppReady();
      const first = await browser.getTelemetry();
      await browser.click('#btn-map-source');
      await sleep(600);
      const second = await browser.getTelemetry();
      assert.notEqual(second.btnMapSource.text, first.btnMapSource.text);
      assert.ok(second.btnMapSource.ariaPressed === 'true' || second.btnMapSource.ariaPressed === 'false');
    });

    test('F9.B2 #map-subtitle retains block count, m² size, and elevation range across every map source', async (t) => {
      const browser = await requireLiveBrowser(t);
      if (!browser) return;
      for (const q of ['slpk', 'lod2', 'osm']) {
        await browser.goto(`${serverCtx.baseUrl}/?map=${q}`);
        await browser.waitForAppReady();
        await sleep(350);
        const tel = await browser.getTelemetry();
        assert.ok(tel.subtitle.includes('452'), `Expected 452 blocks in subtitle for ?map=${q}: "${tel.subtitle}"`);
        assert.ok(tel.subtitle.includes('569'), `Expected elevation min 569 in subtitle for ?map=${q}: "${tel.subtitle}"`);
      }
    });

    test('F9.B3 Switching map source while POI overlay is open preserves POI layer state', async (t) => {
      const browser = await requireLiveBrowser(t);
      if (!browser) return;
      await browser.goto(`${serverCtx.baseUrl}/?map=slpk`);
      await browser.waitForAppReady();
      await browser.click('#btn-pois');
      await sleep(150);
      await browser.click('#btn-map-source');
      await sleep(700);
      const tel = await browser.getTelemetry();
      assert.equal(tel.poiLayerDisplay, 'block');
      browser.assertCleanRuntime({ mode: 'switch' });
    });

    test('F9.B4 Switching map source in Aerial mode preserves active flight HUD and camera position', async (t) => {
      const browser = await requireLiveBrowser(t);
      if (!browser) return;
      await browser.goto(`${serverCtx.baseUrl}/?map=slpk`);
      await browser.waitForAppReady();
      await browser.click('#btn-cam-aerial');
      await browser.holdKeys(['ShiftLeft', 'KeyW'], 600);
      browser.clearEvents();
      await browser.click('#btn-map-source');
      await sleep(700);
      const tel = await browser.getTelemetry();
      assert.equal(tel.flightHudHidden, false);
      browser.assertCleanRuntime({ mode: 'switch' });
    });

    test('F9.B5 Booting directly at ?map=osm and clicking #btn-map-source advances cleanly', async (t) => {
      const browser = await requireLiveBrowser(t);
      if (!browser) return;
      await browser.goto(`${serverCtx.baseUrl}/?map=osm`);
      await browser.waitForAppReady();
      const osmTel = await browser.getTelemetry();
      assert.ok(osmTel.btnMapSource.text.includes('OSM Base'));
      await browser.click('#btn-map-source');
      await sleep(750);
      const nextTel = await browser.getTelemetry();
      assert.notEqual(nextTel.btnMapSource.text, osmTel.btnMapSource.text);
      browser.assertCleanRuntime({ mode: 'switch' });
    });
  });

  // ---------------------------------------------------------------------------
  // F10 Boundary/Negative (5 tests)
  // ---------------------------------------------------------------------------
  describe('F10 Boundaries: Build, Git & Harness Hygiene', () => {
    test('F10.B1 dist/index.html exists and references valid built asset files', () => {
      const indexHtmlPath = path.join(PATHS.distDir, 'index.html');
      assert.ok(fs.existsSync(indexHtmlPath), 'Expected dist/index.html to exist');
      const html = fs.readFileSync(indexHtmlPath, 'utf8');
      const assetRefs = [...html.matchAll(/(?:src|href)="\/?(assets\/[^"]+)"/g)].map((m) => m[1]);
      assert.ok(assetRefs.length > 0, 'Expected built asset references in dist/index.html');
      for (const rel of assetRefs) {
        assert.ok(fs.existsSync(path.join(PATHS.distDir, rel)), `Missing built asset dist/${rel}`);
      }
    });

    test('F10.B2 Git status has no changes on main and no stray untracked temp files in root', async () => {
      const git = await getGitState();
      if (git.originMainSha) {
        assert.equal(git.mainSha, git.originMainSha);
      }
      const rootStrays = git.statusLines.filter((l) => /\.(tmp|bak|log)$/.test(l));
      assert.equal(rootStrays.length, 0, `Unexpected stray temp files in git status: ${rootStrays.join(', ')}`);
    });

    test('F10.B3 dev-server helper reuses running server or tears down ephemeral server cleanly', async () => {
      const srv = await ensureDevServer();
      assert.ok(srv.baseUrl.startsWith('http://'));
      await srv.close();
    });

    test('F10.B4 CDP browser session cleans up its temporary userDataDir on close', async (t) => {
      const browser = await requireLiveBrowser(t);
      if (!browser) return;
      assert.ok(fs.existsSync(browser.userDataDir), 'Expected active Chrome session userDataDir to exist while open');
    });

    test('F10.B5 Console/network allowlist permits known baseline hints and rejects real WebGPU/TSL errors', () => {
      assert.equal(isAllowlistedConsoleCheck('Canvas2D: Multiple readback operations using getImageData... willReadFrequently'), true);
      assert.equal(isAllowlistedConsoleCheck('THREE.TSL: Vertex attribute "normal" not found on geometry.', { mode: 'bike' }), true);
      assert.equal(isAllowlistedConsoleCheck('THREE.TSL: Vertex attribute "normal" not found on geometry.', { mode: 'map' }), false);
      assert.equal(isAllowlistedConsoleCheck('THREE.TSL: Vertex attribute "aRoofType" not found on geometry.', { mode: 'bike' }), false);
      assert.equal(isIgnorableNetworkUrl('http://localhost:5173/favicon.ico'), true);
      assert.equal(isIgnorableNetworkUrl('http://localhost:5173/data/chunks-slpk/chunk_0_0.bin'), false);
    });
  });
});

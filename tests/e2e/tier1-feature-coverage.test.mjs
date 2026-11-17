/**
 * Tier 1 — Feature Coverage E2E Suite (50 tests: 5 per feature F1–F10).
 * Opaque-box verification strictly derived from ORIGINAL_REQUEST.md and PROJECT.md Contracts.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import {
  BASE_MANIFEST_EXPECTATIONS,
  BBOX_SUBSETS,
  CHUNK_SIZE_M,
  GIT_EXPECTATIONS,
  LANDMARKS,
  PATHS,
} from './fixtures/madrid-fixtures.mjs';
import {
  acquireBrowserContext,
  getBrowserConfigFromEnv,
} from './helpers/cdp-browser.mjs';
import {
  cleanupAllCliTempDirs,
  discoverConverterCli,
  getGitState,
  inspectConverterHelp,
  requireConverterCli,
  runConverterCached,
  runNpmBuild,
  runTscNoEmit,
} from './helpers/cli.mjs';
import { ensureDevServer } from './helpers/dev-server.mjs';
import {
  assertLocalDemAlignment,
  chunkKeyForXZ,
  countTrianglesInBox,
  createTerrainEvaluator,
  loadBaseManifest,
  loadJsonFile,
  parseSlpkChunk,
  projectToMeters,
  readAndParseSlpkChunk,
  resolveManifestChunkPath,
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

describe('Tier 1 — Feature Coverage (F1–F10, 50 tests)', () => {
  // ---------------------------------------------------------------------------
  // F1: SLPK Archive Streaming & Leaf Extraction (5 tests)
  // ---------------------------------------------------------------------------
  describe('F1: SLPK Archive Streaming & Leaf Extraction', () => {
    test('F1.1 Converter CLI exists and --help exposes --bbox, --chunks, and output dir flags', async () => {
      const cli = requireConverterCli();
      const help = await inspectConverterHelp(cli);
      assert.equal(help.exitCode, 0, `Expected converter --help to exit 0, got ${help.exitCode}`);
      assert.ok(help.hasBbox, 'Expected converter --help to document --bbox');
      assert.ok(help.hasChunks, 'Expected converter --help to document --chunks');
      assert.ok(
        help.helpText.includes('--out-dir') || help.helpText.includes('--out'),
        'Expected converter --help to document --out-dir or --out'
      );
    });

    test('F1.2 Raw SLPK archive exists and --chunks 0_0 extracts Neptuno leaf buildings', async () => {
      assert.ok(fs.existsSync(PATHS.slpkArchive), `Missing raw SLPK archive at ${PATHS.slpkArchive}`);
      const res = await runConverterCached('chunks:0_0', ['--chunks', '0_0']);
      assert.equal(res.exitCode, 0, `Converter failed: ${res.stderr || res.stdout}`);
      const manifest = loadJsonFile(res.manifestPath, 'subset manifest (0_0)');
      const entry = manifest.chunks.find((c) => c.key === '0_0');
      assert.ok(entry, 'Expected chunk 0_0 in subset manifest');
      assert.ok(entry.meshFile, 'Expected entry.meshFile for chunk 0_0');
      const binPath = resolveManifestChunkPath(entry.meshFile, { baseDir: res.outDir });
      const parsed = readAndParseSlpkChunk(binPath);
      assert.ok(parsed.header.buildingCount > 0, 'Expected buildingCount > 0 in chunk 0_0');
      assert.ok(parsed.header.vertexCount > 0, 'Expected vertexCount > 0 in chunk 0_0');
    });

    test('F1.3 Leaf-only extraction on Cibeles (0_-2) avoids multi-LOD hierarchy duplication', async () => {
      const res = await runConverterCached('chunks:0_-2', ['--chunks', '0_-2']);
      assert.equal(res.exitCode, 0, `Converter failed: ${res.stderr || res.stdout}`);
      const binPath = path.join(res.outDir, 'chunk_0_-2.bin');
      const parsed = readAndParseSlpkChunk(binPath);
      const metrics = validateSlpkChunkGeometry(parsed, { chunkKey: '0_-2', requireNonEmpty: true });
      // Leaf 3933 has 16,804 tris across 0_-2 & 0_-1; adjacent leaves fit cleanly under 100k tris per chunk
      assert.ok(
        metrics.triangleCount >= LANDMARKS.cibeles.tris && metrics.triangleCount < 150000,
        `Unexpected triangle count ${metrics.triangleCount} in chunk_0_-2.bin (leaf-only expected)`
      );
    });

    test('F1.4 Attribute f_6 (ALTURA) decoding preserves Cibeles 63.93m building height span', async () => {
      const res = await runConverterCached('chunks:0_-2', ['--chunks', '0_-2']);
      assert.equal(res.exitCode, 0, `Converter failed: ${res.stderr || res.stdout}`);
      const parsed = readAndParseSlpkChunk(path.join(res.outDir, 'chunk_0_-2.bin'));
      const box = countTrianglesInBox(parsed, {
        minX: LANDMARKS.cibeles.palacioX - 110,
        maxX: LANDMARKS.cibeles.palacioX + 110,
        minZ: LANDMARKS.cibeles.palacioZ - 110,
        maxZ: LANDMARKS.cibeles.palacioZ + 110,
      });
      assert.ok(box.total >= LANDMARKS.cibeles.tris * 0.8, `Expected Cibeles triangles near Palacio, got ${box.total}`);
      const spanY = (box.maxY ?? 0) - (box.minY ?? 0);
      assert.ok(
        spanY >= LANDMARKS.cibeles.altura - 5,
        `Expected Cibeles Y span >= ${LANDMARKS.cibeles.altura - 5}m (ALTURA=${LANDMARKS.cibeles.altura}), got ${spanY.toFixed(2)}m`
      );
    });

    test('F1.5 Full exported SLPK manifest exists with non-zero M-30 chunks and buildings', () => {
      const manifest = loadJsonFile(PATHS.slpkManifest, 'full SLPK manifest');
      assert.ok(manifest.totals && manifest.totals.chunks > 0, 'Expected totals.chunks > 0');
      assert.ok(manifest.totals.buildings > 0, 'Expected totals.buildings > 0');
      assert.ok(Array.isArray(manifest.chunks) && manifest.chunks.length === manifest.totals.chunks);
    });
  });

  // ---------------------------------------------------------------------------
  // F2: Projection, Winding & ECEF->ENU Normals (5 tests)
  // ---------------------------------------------------------------------------
  describe('F2: Projection, Winding & ECEF->ENU Normals', () => {
    test('F2.1 Neptuno origin (-3.6941, 40.4152) projects to (0, 0) in chunk 0_0', () => {
      const [x, z] = projectToMeters(LANDMARKS.neptuno.lon, LANDMARKS.neptuno.lat);
      assert.ok(Math.abs(x) < 1e-9, `Expected x=0 at Neptuno, got ${x}`);
      assert.ok(Math.abs(z) < 1e-9, `Expected z=0 at Neptuno, got ${z}`);
      assert.equal(chunkKeyForXZ(x, z), '0_0');
    });

    test('F2.2 Cibeles chunk_0_-2.bin positions lie within projected 0_-2 chunk bounds', async () => {
      const res = await runConverterCached('chunks:0_-2', ['--chunks', '0_-2']);
      assert.equal(res.exitCode, 0, `Converter failed: ${res.stderr || res.stdout}`);
      const parsed = readAndParseSlpkChunk(path.join(res.outDir, 'chunk_0_-2.bin'));
      const metrics = validateSlpkChunkGeometry(parsed, { chunkKey: '0_-2', requireNonEmpty: true });
      assert.ok(metrics.bounds.minX < 400 && metrics.bounds.maxX > 0, 'Expected X overlap with [0, 400]');
      assert.ok(metrics.bounds.minZ < -400 && metrics.bounds.maxZ > -800, 'Expected Z overlap with [-800, -400]');
    });

    test('F2.3 All vertex normals in chunk_0_-2.bin are finite unit-length vectors', async () => {
      const res = await runConverterCached('chunks:0_-2', ['--chunks', '0_-2']);
      assert.equal(res.exitCode, 0, `Converter failed: ${res.stderr || res.stdout}`);
      const parsed = readAndParseSlpkChunk(path.join(res.outDir, 'chunk_0_-2.bin'));
      validateSlpkChunkGeometry(parsed, {
        minNormalLen: 0.98,
        maxNormalLen: 1.02,
        requireNonEmpty: true,
      });
    });

    test('F2.4 Triangle winding in (X=E, Y=U, Z=-N) is >= 99% outward CCW relative to normals', async () => {
      const res = await runConverterCached('chunks:0_-2', ['--chunks', '0_-2']);
      assert.equal(res.exitCode, 0, `Converter failed: ${res.stderr || res.stdout}`);
      const parsed = readAndParseSlpkChunk(path.join(res.outDir, 'chunk_0_-2.bin'));
      const metrics = validateSlpkChunkGeometry(parsed, {
        minOutwardWindingRatio: 0.99,
        requireNonEmpty: true,
      });
      assert.ok(metrics.outwardWindingRatio >= 0.99, `Outward ratio ${metrics.outwardWindingRatio}`);
    });

    test('F2.5 Gran Vía (-2_-2, -1_-2) ECEF->ENU normals include horizontal walls and upward roofs', async () => {
      const res = await runConverterCached('chunks:granvia', ['--chunks', '-2_-2,-1_-2']);
      assert.equal(res.exitCode, 0, `Converter failed: ${res.stderr || res.stdout}`);
      for (const key of ['-2_-2', '-1_-2']) {
        const parsed = readAndParseSlpkChunk(path.join(res.outDir, `chunk_${key}.bin`));
        const metrics = validateSlpkChunkGeometry(parsed, { chunkKey: key, requireNonEmpty: true });
        assert.ok(metrics.horizontalWallTriangles > 100, `Expected horizontal wall normals in ${key}`);
        assert.ok(metrics.upwardRoofTriangles > 100, `Expected upward roof normals in ${key}`);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // F3: Lossless LoD2 Roof/Dome Preservation (5 tests)
  // ---------------------------------------------------------------------------
  describe('F3: Lossless LoD2 Roof/Dome Preservation', () => {
    test('F3.1 Palacio de Cibeles (0_-2) preserves >= 482 non-planar sloped/dome roof triangles', async () => {
      const res = await runConverterCached('chunks:0_-2', ['--chunks', '0_-2']);
      assert.equal(res.exitCode, 0, `Converter failed: ${res.stderr || res.stdout}`);
      const parsed = readAndParseSlpkChunk(path.join(res.outDir, 'chunk_0_-2.bin'));
      const metrics = validateSlpkChunkGeometry(parsed, { chunkKey: '0_-2', requireNonEmpty: true });
      assert.ok(
        metrics.slopedRoofTriangles >= LANDMARKS.cibeles.slopedTris,
        `Expected >= ${LANDMARKS.cibeles.slopedTris} sloped/dome triangles in 0_-2, got ${metrics.slopedRoofTriangles}`
      );
    });

    test('F3.2 Atocha station (0_2) preserves arched 01_MARQUESINA_P canopy curved triangles', async () => {
      const res = await runConverterCached('chunks:atocha', ['--chunks', '0_2,1_2']);
      assert.equal(res.exitCode, 0, `Converter failed: ${res.stderr || res.stdout}`);
      const parsed = readAndParseSlpkChunk(path.join(res.outDir, 'chunk_0_2.bin'));
      const metrics = validateSlpkChunkGeometry(parsed, { chunkKey: '0_2', requireNonEmpty: true });
      assert.ok(
        metrics.slopedRoofTriangles >= 1000,
        `Expected >= 1000 curved/sloped triangles for Atocha canopy in 0_2, got ${metrics.slopedRoofTriangles}`
      );
    });

    test('F3.3 Gran Vía (-1_-2, Metrópolis) preserves sloped/dome roof detail without planar flattening', async () => {
      const res = await runConverterCached('chunks:granvia', ['--chunks', '-2_-2,-1_-2']);
      assert.equal(res.exitCode, 0, `Converter failed: ${res.stderr || res.stdout}`);
      const parsed = readAndParseSlpkChunk(path.join(res.outDir, 'chunk_-1_-2.bin'));
      const metrics = validateSlpkChunkGeometry(parsed, { chunkKey: '-1_-2', requireNonEmpty: true });
      assert.ok(
        metrics.slopedRoofTriangles >= LANDMARKS.granVia.metropolis.slopedTris,
        `Expected >= ${LANDMARKS.granVia.metropolis.slopedTris} sloped tris in -1_-2, got ${metrics.slopedRoofTriangles}`
      );
      assert.ok(
        metrics.roofTypeCounts[2] + metrics.roofTypeCounts[4] > 0,
        'Expected sloped (2) or dome/mansard (4) roof vertices in Metrópolis chunk'
      );
    });

    test('F3.4 Retiro (2_-1) preserves pavilion and kiosk sloped roof geometries', async () => {
      const res = await runConverterCached('chunks:2_-1', ['--chunks', '2_-1']);
      assert.equal(res.exitCode, 0, `Converter failed: ${res.stderr || res.stdout}`);
      const parsed = readAndParseSlpkChunk(path.join(res.outDir, 'chunk_2_-1.bin'));
      const metrics = validateSlpkChunkGeometry(parsed, { chunkKey: '2_-1', requireNonEmpty: true });
      assert.ok(metrics.slopedRoofTriangles >= 200, `Expected >= 200 sloped tris in 2_-1, got ${metrics.slopedRoofTriangles}`);
    });

    test('F3.5 Architectural roof classifications span walls (0), flat (1), sloped (2), and dome/trim (3..5)', async () => {
      const res = await runConverterCached('chunks:0_-2', ['--chunks', '0_-2']);
      assert.equal(res.exitCode, 0, `Converter failed: ${res.stderr || res.stdout}`);
      const parsed = readAndParseSlpkChunk(path.join(res.outDir, 'chunk_0_-2.bin'));
      const metrics = validateSlpkChunkGeometry(parsed, { chunkKey: '0_-2', requireNonEmpty: true });
      assert.ok(metrics.roofTypeCounts[0] > 0, 'Expected wall vertices (aRoofType=0)');
      assert.ok(metrics.roofTypeCounts[1] + metrics.roofTypeCounts[2] > 0, 'Expected roof vertices (1 or 2)');
      assert.ok(
        metrics.roofTypeCounts[3] + metrics.roofTypeCounts[4] + metrics.roofTypeCounts[5] > 0,
        'Expected trim/dome/gold detail vertices (aRoofType 3..5)'
      );
    });
  });

  // ---------------------------------------------------------------------------
  // F4: Terrain Elevation Alignment (5 tests)
  // ---------------------------------------------------------------------------
  describe('F4: Terrain Elevation Alignment', () => {
    test('F4.1 Base manifest DEM grid matches 220x290 Madrid topography and Neptuno origin', () => {
      const base = loadBaseManifest();
      assert.equal(base.dem.cols, BASE_MANIFEST_EXPECTATIONS.dem.cols);
      assert.equal(base.dem.rows, BASE_MANIFEST_EXPECTATIONS.dem.rows);
      assert.equal(base.dem.originElevationM, BASE_MANIFEST_EXPECTATIONS.dem.originElevationM);
      assert.equal(base.dem.values.length, BASE_MANIFEST_EXPECTATIONS.dem.valuesLength);
      const terrain = createTerrainEvaluator(base.dem);
      const relY = terrain.getHeightAtXZ(0, 0);
      assert.ok(Math.abs(relY - LANDMARKS.neptuno.demRelM) < 0.05, `Neptuno relY=${relY}`);
    });

    test('F4.2 Neptuno chunk_0_0.bin building bases align flush with local TerrainElevation', async () => {
      const terrain = createTerrainEvaluator(loadBaseManifest().dem);
      const res = await runConverterCached('chunks:0_0', ['--chunks', '0_0']);
      assert.equal(res.exitCode, 0, `Converter failed: ${res.stderr || res.stdout}`);
      const parsed = readAndParseSlpkChunk(path.join(res.outDir, 'chunk_0_0.bin'));
      const align = assertLocalDemAlignment(parsed, terrain, {
        minBaseOffsetBelowGroundM: -18,
        maxBaseOffsetAboveGroundM: 4,
      });
      assert.ok(align.sampledCells >= 4, 'Expected multiple terrain sample cells in 0_0');
    });

    test('F4.3 Palacio Real (-5_-1) -> Cuesta de la Vega (-5_0) tracks ~15-28m steep DEM descent', async () => {
      const terrain = createTerrainEvaluator(loadBaseManifest().dem);
      const res = await runConverterCached('chunks:palacio', ['--chunks', '-5_-1,-5_0']);
      assert.equal(res.exitCode, 0, `Converter failed: ${res.stderr || res.stdout}`);
      const upper = readAndParseSlpkChunk(path.join(res.outDir, 'chunk_-5_-1.bin'));
      const lower = readAndParseSlpkChunk(path.join(res.outDir, 'chunk_-5_0.bin'));
      const alignUpper = assertLocalDemAlignment(upper, terrain);
      const alignLower = assertLocalDemAlignment(lower, terrain);
      // Both chunks must remain locally aligned relative to their own DEM elevation (median delta close to 0/-skirt, not 20m off)
      assert.ok(
        Math.abs(alignUpper.medianDelta - alignLower.medianDelta) < 12,
        `Steep slope chunks drifted apart relative to DEM: upper=${alignUpper.medianDelta.toFixed(2)}, lower=${alignLower.medianDelta.toFixed(2)}`
      );
    });

    test('F4.4 Elevated Atocha 01_MARQUESINA_P canopy (0_2) preserves positive height above local ground', async () => {
      const terrain = createTerrainEvaluator(loadBaseManifest().dem);
      const res = await runConverterCached('chunks:atocha', ['--chunks', '0_2,1_2']);
      assert.equal(res.exitCode, 0, `Converter failed: ${res.stderr || res.stdout}`);
      const parsed = readAndParseSlpkChunk(path.join(res.outDir, 'chunk_0_2.bin'));
      // Atocha canopy sits around (288..480, 900..1180) with base ~ +10..22m above ground
      const box = countTrianglesInBox(parsed, {
        minX: 250,
        maxX: 520,
        minZ: 900,
        maxZ: 1200,
      });
      assert.ok(box.total > 500, `Expected Atocha station geometry in 0_2, got ${box.total} tris`);
      const groundAtAtocha = terrain.getHeightAtXZ(LANDMARKS.atocha.x, LANDMARKS.atocha.z);
      assert.ok(
        (box.maxY ?? -Infinity) > groundAtAtocha + 15,
        `Expected Atocha canopy top above groundY+15m (${groundAtAtocha.toFixed(2)}), got maxY=${box.maxY}`
      );
    });

    test('F4.5 Full public/data/chunks-slpk/manifest.json embeds identical DEM grid to base manifest', () => {
      const base = loadBaseManifest();
      const slpk = loadJsonFile(PATHS.slpkManifest, 'full SLPK manifest');
      assert.deepEqual(slpk.dem, base.dem, 'Expected SLPK manifest.dem to match base manifest.dem');
    });
  });

  // ---------------------------------------------------------------------------
  // F5: Chunk Grid Partitioning & CLI Filtering (5 tests)
  // ---------------------------------------------------------------------------
  describe('F5: Chunk Grid Partitioning & CLI Filtering', () => {
    test('F5.1 --chunks 0_-2 writes only chunk_0_-2.bin and manifest.json in isolated temp dir', async () => {
      const res = await runConverterCached('chunks:0_-2', ['--chunks', '0_-2']);
      assert.equal(res.exitCode, 0, `Converter failed: ${res.stderr || res.stdout}`);
      const manifest = loadJsonFile(res.manifestPath, 'subset manifest');
      assert.equal(manifest.chunks.length, 1, `Expected 1 chunk for --chunks 0_-2, got ${manifest.chunks.length}`);
      assert.equal(manifest.chunks[0].key, '0_-2');
      const binFiles = fs.readdirSync(res.outDir).filter((f) => f.endsWith('.bin'));
      assert.deepEqual(binFiles, ['chunk_0_-2.bin']);
    });

    test('F5.2 Multi-chunk --chunks -1_-2,-1_-1 partitions cross-chunk leaf 6200 without duplication', async () => {
      const res = await runConverterCached('chunks:metropolis', ['--chunks', '-1_-2,-1_-1']);
      assert.equal(res.exitCode, 0, `Converter failed: ${res.stderr || res.stdout}`);
      const manifest = loadJsonFile(res.manifestPath, 'metropolis subset manifest');
      const keys = manifest.chunks.map((c) => c.key).sort();
      assert.deepEqual(keys, ['-1_-2', '-1_-1'].sort());
      // Verify no vertex in -1_-2 has centroid outside and building counts are distinct
      const cA = readAndParseSlpkChunk(path.join(res.outDir, 'chunk_-1_-2.bin'));
      const cB = readAndParseSlpkChunk(path.join(res.outDir, 'chunk_-1_-1.bin'));
      assert.ok(cA.header.buildingCount > 0 && cB.header.buildingCount > 0);
      assert.notEqual(cA.header.vertexCount, cB.header.vertexCount, 'Cross-chunk leaves must not copy identical vertex buffers');
    });

    test('F5.3 --bbox Neptuno subset filters strictly to overlapping 400x400m grid chunks', async () => {
      const res = await runConverterCached('bbox:neptuno', ['--bbox', BBOX_SUBSETS.neptunoSmall]);
      assert.equal(res.exitCode, 0, `Converter failed: ${res.stderr || res.stdout}`);
      const manifest = loadJsonFile(res.manifestPath, 'bbox subset manifest');
      assert.ok(manifest.chunks.length >= 1 && manifest.chunks.length <= 9, `Unexpected bbox chunk count: ${manifest.chunks.length}`);
      assert.ok(manifest.chunks.some((c) => c.key === '0_0'), 'Expected Neptuno bbox to include chunk 0_0');
      assert.equal(manifest.meta.chunkSizeM, CHUNK_SIZE_M);
    });

    test('F5.4 Full SLPK manifest covers all 452 M-30 chunks with valid key/file references', () => {
      const slpk = loadJsonFile(PATHS.slpkManifest, 'full SLPK manifest');
      assert.equal(slpk.chunks.length, BASE_MANIFEST_EXPECTATIONS.totalChunks);
      for (const entry of slpk.chunks) {
        assert.equal(entry.key, `${entry.cx}_${entry.cz}`);
        const baseFile = resolveManifestChunkPath(entry.file, { baseDir: PATHS.baseChunksDir });
        assert.ok(fs.existsSync(baseFile), `Missing base OSM JSON for ${entry.key}: ${baseFile}`);
      }
    });

    test('F5.5 package.json exposes a script invoking convert-slpk-chunks', () => {
      const cli = discoverConverterCli();
      assert.ok(cli.packageScriptName, 'Expected package.json script referencing convert-slpk-chunks');
      assert.ok(cli.found, 'Expected scripts/convert-slpk-chunks.{mjs,py} to exist');
    });
  });

  // ---------------------------------------------------------------------------
  // F6: Binary Chunk Packing & Attribute Synthesis (5 tests)
  // ---------------------------------------------------------------------------
  describe('F6: Binary Chunk Packing & Attribute Synthesis', () => {
    test('F6.1 SLPK v1 binary header and align4 section lengths match byte-for-byte', async () => {
      const res = await runConverterCached('chunks:0_-2', ['--chunks', '0_-2']);
      assert.equal(res.exitCode, 0, `Converter failed: ${res.stderr || res.stdout}`);
      const parsed = readAndParseSlpkChunk(path.join(res.outDir, 'chunk_0_-2.bin'));
      assert.equal(parsed.header.magic, 0x4b504c53);
      assert.equal(parsed.header.version, 1);
      assert.equal(parsed.header.reserved0, 0);
      assert.equal(parsed.header.reserved1, 0);
    });

    test('F6.2 aLocalHeight >= 0, aTopDist >= 0, and upward roofs enforce aTopDist >= 5.0', async () => {
      const res = await runConverterCached('chunks:0_-2', ['--chunks', '0_-2']);
      assert.equal(res.exitCode, 0, `Converter failed: ${res.stderr || res.stdout}`);
      const parsed = readAndParseSlpkChunk(path.join(res.outDir, 'chunk_0_-2.bin'));
      const metrics = validateSlpkChunkGeometry(parsed, { upwardRoofMinTopDist: 5.0, requireNonEmpty: true });
      assert.ok(metrics.upwardRoofTriangles > 0, 'Expected upward roof triangles to exercise aTopDist >= 5.0');
    });

    test('F6.3 aRoofType (0..5) and aWallStyle (0..7) stay within TSL shader bounds with variety', async () => {
      const res = await runConverterCached('chunks:0_-2', ['--chunks', '0_-2']);
      assert.equal(res.exitCode, 0, `Converter failed: ${res.stderr || res.stdout}`);
      const parsed = readAndParseSlpkChunk(path.join(res.outDir, 'chunk_0_-2.bin'));
      const metrics = validateSlpkChunkGeometry(parsed, { requireNonEmpty: true });
      const distinctWallStyles = metrics.wallStyleCounts.filter((c) => c > 0).length;
      assert.ok(distinctWallStyles >= 2, `Expected multiple wall styles in 0_-2, got ${distinctWallStyles}`);
    });

    test('F6.4 RGB vertex colors are populated with non-black architectural tones', async () => {
      const res = await runConverterCached('chunks:0_0', ['--chunks', '0_0']);
      assert.equal(res.exitCode, 0, `Converter failed: ${res.stderr || res.stdout}`);
      const parsed = readAndParseSlpkChunk(path.join(res.outDir, 'chunk_0_0.bin'));
      let distinctLuma = new Set();
      for (let i = 0; i < Math.min(parsed.header.vertexCount, 2000); i++) {
        distinctLuma.add(parsed.colors[i * 3] + parsed.colors[i * 3 + 1] + parsed.colors[i * 3 + 2]);
      }
      assert.ok(distinctLuma.size >= 3, 'Expected varied RGB architectural colors');
    });

    test('F6.5 Indexed packing deduplicates shared vertices (vertexCount <= indexCount)', async () => {
      const res = await runConverterCached('chunks:0_-2', ['--chunks', '0_-2']);
      assert.equal(res.exitCode, 0, `Converter failed: ${res.stderr || res.stdout}`);
      const parsed = readAndParseSlpkChunk(path.join(res.outDir, 'chunk_0_-2.bin'));
      if (parsed.header.indexCount > 0) {
        assert.ok(
          parsed.header.vertexCount < parsed.header.indexCount,
          `Expected deduplicated vertexCount (${parsed.header.vertexCount}) < indexCount (${parsed.header.indexCount})`
        );
      } else {
        assert.equal(parsed.header.vertexCount % 3, 0);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // F7: Binary Chunk Streaming & Mesh Builder (5 tests)
  // ---------------------------------------------------------------------------
  describe('F7: Binary Chunk Streaming & Mesh Builder', () => {
    test('F7.1 Live app fetches /data/chunks-slpk/manifest.json and .bin chunks on boot', async (t) => {
      const browser = await requireLiveBrowser(t);
      if (!browser) return;
      await browser.goto(`${serverCtx.baseUrl}/`);
      await browser.waitForAppReady();
      await sleep(400);
      const urls = browser.getFetchedUrls();
      assert.ok(
        urls.some((r) => r.url.includes('/data/chunks-slpk/manifest.json') && r.status === 200),
        'Expected browser to fetch /data/chunks-slpk/manifest.json with HTTP 200'
      );
      assert.ok(
        urls.some((r) => /\/data\/chunks-slpk\/chunk_-?\d+_-?\d+\.bin/.test(r.url) && r.status === 200),
        'Expected browser to fetch /data/chunks-slpk/chunk_*.bin binary chunks with HTTP 200'
      );
    });

    test('F7.2 Initial preload around Neptuno renders active chunks, buildings, and trees', async (t) => {
      const browser = await requireLiveBrowser(t);
      if (!browser) return;
      await browser.goto(`${serverCtx.baseUrl}/?map=slpk`);
      await browser.waitForAppReady();
      await sleep(400);
      const tel = await browser.getTelemetry();
      assert.ok(tel.activeChunks >= 4, `Expected >= 4 active chunks around Neptuno, got ${tel.activeChunks}`);
      assert.ok(tel.buildings > 0, `Expected non-zero buildings, got ${tel.buildings}`);
      assert.ok(tel.trees > 0, `Expected non-zero trees from base OSM payload, got ${tel.trees}`);
    });

    test('F7.3 HTTP response for /data/chunks-slpk/chunk_0_0.bin parses as valid SLPK v1 binary', async (t) => {
      const browser = await requireLiveBrowser(t);
      if (!browser) return;
      const res = await fetch(`${serverCtx.baseUrl}/data/chunks-slpk/chunk_0_0.bin`);
      assert.equal(res.status, 200, `Expected HTTP 200 for /data/chunks-slpk/chunk_0_0.bin, got ${res.status}`);
      const buf = await res.arrayBuffer();
      const parsed = parseSlpkChunk(buf);
      validateSlpkChunkGeometry(parsed, { chunkKey: '0_0', requireNonEmpty: true });
    });

    test('F7.4 Navigating > 780m to Cibeles / AZCA dynamically streams new .bin chunks', async (t) => {
      const browser = await requireLiveBrowser(t);
      if (!browser) return;
      await browser.goto(`${serverCtx.baseUrl}/?map=slpk`);
      await browser.waitForAppReady();
      await sleep(350);
      browser.clearEvents();
      await browser.click('#btn-pois');
      await sleep(150);
      await browser.clickPoi('AZCA');
      await sleep(1500);
      const urls = browser.getFetchedUrls();
      assert.ok(
        urls.some((r) => /\/data\/chunks-slpk\/chunk_-?\d+_-?\d+\.bin/.test(r.url) && r.status === 200),
        'Expected dynamic /data/chunks-slpk/*.bin fetches after jumping > 780m to AZCA'
      );
      browser.assertCleanRuntime({ mode: 'map' });
    });

    test('F7.5 All meshFile entries in public/data/chunks-slpk/manifest.json exist on disk', () => {
      const slpk = loadJsonFile(PATHS.slpkManifest, 'full SLPK manifest');
      const withMesh = slpk.chunks.filter((c) => Boolean(c.meshFile));
      assert.ok(withMesh.length > 300, `Expected > 300 chunks with meshFile, got ${withMesh.length}`);
      for (const entry of withMesh) {
        const p = resolveManifestChunkPath(entry.meshFile, { baseDir: PATHS.slpkChunksDir });
        assert.ok(fs.existsSync(p), `Missing .bin file for chunk ${entry.key}: ${p}`);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // F8: WebGPU / TSL Material & Disposal Verification (5 tests)
  // ---------------------------------------------------------------------------
  describe('F8: WebGPU / TSL Material & Disposal Verification', () => {
    test('F8.1 Renderer initializes WebGPU backend and hides loading overlay', async (t) => {
      const browser = await requireLiveBrowser(t);
      if (!browser) return;
      await browser.goto(`${serverCtx.baseUrl}/`);
      const ready = await browser.waitForAppReady();
      const cfg = getBrowserConfigFromEnv();
      if (!cfg.allowWebglFallback) {
        assert.equal(ready.backend, 'WebGPU', `Expected WebGPU backend, got ${ready.backend}`);
      } else {
        assert.ok(ready.backend === 'WebGPU' || ready.backend.includes('WebGL2'));
      }
      assert.equal(ready.hidden, true);
    });

    test('F8.2 Zero Runtime.exceptionThrown, console errors, or TSL/AttributeNode warnings on boot', async (t) => {
      const browser = await requireLiveBrowser(t);
      if (!browser) return;
      await browser.goto(`${serverCtx.baseUrl}/?map=slpk`);
      await browser.waitForAppReady();
      await sleep(500);
      browser.assertCleanRuntime({ mode: 'map' });
    });

    test('F8.3 WebGPU canvas renders non-empty frame with active draw calls', async (t) => {
      const browser = await requireLiveBrowser(t);
      if (!browser) return;
      await browser.goto(`${serverCtx.baseUrl}/`);
      await browser.waitForAppReady();
      await sleep(400);
      const tel = await browser.getTelemetry();
      assert.ok(tel.canvasWidth >= 800 && tel.canvasHeight >= 500, `Unexpected canvas size ${tel.canvasWidth}x${tel.canvasHeight}`);
      assert.ok(tel.calls > 10, `Expected > 10 draw calls, got ${tel.calls}`);
      const png = await browser.screenshot();
      assert.ok(png.byteLength > 50_000, `Expected non-trivial PNG screenshot (>50KB), got ${png.byteLength}B`);
    });

    test('F8.4 Aerial camera mode + turbo flight emits zero WGSL/TSL/DeviceLost errors', async (t) => {
      const browser = await requireLiveBrowser(t);
      if (!browser) return;
      await browser.goto(`${serverCtx.baseUrl}/?map=slpk`);
      await browser.waitForAppReady();
      browser.clearEvents();
      await browser.click('#btn-cam-aerial');
      await browser.holdKeys(['ShiftLeft', 'KeyW'], 1400);
      await sleep(400);
      const tel = await browser.getTelemetry();
      assert.equal(tel.flightHudHidden, false);
      browser.assertCleanRuntime({ mode: 'aerial' });
    });

    test('F8.5 Map source cycling disposes prior geometries without WebGPU errors or leaks', async (t) => {
      const browser = await requireLiveBrowser(t);
      if (!browser) return;
      await browser.goto(`${serverCtx.baseUrl}/?map=slpk`);
      await browser.waitForAppReady();
      browser.clearEvents();
      for (let i = 0; i < 3; i++) {
        await browser.click('#btn-map-source');
        await browser.waitForEnabled('#btn-map-source');
        await sleep(350);
      }
      browser.assertCleanRuntime({ mode: 'switch' });
    });
  });

  // ---------------------------------------------------------------------------
  // F9: Map Version Selection UI & Default Source (5 tests)
  // ---------------------------------------------------------------------------
  describe('F9: Map Version Selection UI & Default Source', () => {
    test('F9.1 Default load (no ?map= param) boots into SLPK LoD2 3D map', async (t) => {
      const browser = await requireLiveBrowser(t);
      if (!browser) return;
      await browser.goto(`${serverCtx.baseUrl}/`);
      await browser.waitForAppReady();
      await sleep(400);
      const urls = browser.getFetchedUrls();
      assert.ok(
        urls.some((r) => r.url.includes('/data/chunks-slpk/manifest.json') && r.status === 200),
        'Expected default load to fetch /data/chunks-slpk/manifest.json'
      );
      const tel = await browser.getTelemetry();
      assert.ok(tel.btnMapSource?.text.length > 0);
    });

    test('F9.2 ?map=slpk loads SLPK mode distinct from LoD2 1:1000 and OSM Base', async (t) => {
      const browser = await requireLiveBrowser(t);
      if (!browser) return;
      await browser.goto(`${serverCtx.baseUrl}/?map=slpk`);
      await browser.waitForAppReady();
      await sleep(400);
      const tel = await browser.getTelemetry();
      assert.ok(
        !/LoD2 1:1000|OSM Base/.test(tel.btnMapSource?.text || ''),
        `Expected ?map=slpk button label distinct from LoD2 1:1000 / OSM Base, got "${tel.btnMapSource?.text}"`
      );
    });

    test('F9.3 ?map=lod2 loads SIGMA LoD2 1:1000 mode cleanly', async (t) => {
      const browser = await requireLiveBrowser(t);
      if (!browser) return;
      await browser.goto(`${serverCtx.baseUrl}/?map=lod2`);
      await browser.waitForAppReady();
      await sleep(400);
      const tel = await browser.getTelemetry();
      assert.ok(tel.btnMapSource?.text.includes('LoD2 1:1000'), `Expected LoD2 1:1000 label, got "${tel.btnMapSource?.text}"`);
      assert.ok(tel.subtitle.includes('LoD2 1:1000'), `Expected LoD2 subtitle, got "${tel.subtitle}"`);
      browser.assertCleanRuntime({ mode: 'map' });
    });

    test('F9.4 ?map=osm loads OSM Base mode cleanly', async (t) => {
      const browser = await requireLiveBrowser(t);
      if (!browser) return;
      await browser.goto(`${serverCtx.baseUrl}/?map=osm`);
      await browser.waitForAppReady();
      await sleep(400);
      const tel = await browser.getTelemetry();
      assert.ok(tel.btnMapSource?.text.includes('OSM Base'), `Expected OSM Base label, got "${tel.btnMapSource?.text}"`);
      assert.ok(tel.subtitle.includes('OSM Base'), `Expected OSM subtitle, got "${tel.subtitle}"`);
      browser.assertCleanRuntime({ mode: 'map' });
    });

    test('F9.5 Clicking #btn-map-source cycles across all 3 map modes (slpk, lod2, osm)', async (t) => {
      const browser = await requireLiveBrowser(t);
      if (!browser) return;
      await browser.goto(`${serverCtx.baseUrl}/?map=slpk`);
      await browser.waitForAppReady();
      await sleep(400);
      const states = [];
      for (let i = 0; i < 4; i++) {
        const tel = await browser.getTelemetry();
        states.push({ label: tel.btnMapSource?.text, subtitle: tel.subtitle, buildings: tel.buildings });
        if (i < 3) {
          await browser.click('#btn-map-source');
          await browser.waitForEnabled('#btn-map-source');
          await sleep(350);
        }
      }
      const uniqueFirstThree = new Set(states.slice(0, 3).map((s) => s.label));
      assert.equal(uniqueFirstThree.size, 3, `Expected 3 distinct map source labels, got ${JSON.stringify(states)}`);
      assert.equal(states[3].label, states[0].label, 'Expected 3rd click to cycle back to initial mode');
      browser.assertCleanRuntime({ mode: 'switch' });
    });
  });

  // ---------------------------------------------------------------------------
  // F10: Build, Git Branch & Live Browser Verification (5 tests)
  // ---------------------------------------------------------------------------
  describe('F10: Build, Git Branch & Live Browser Verification', () => {
    test('F10.1 tsc --noEmit passes with zero TypeScript errors', async () => {
      const res = await runTscNoEmit();
      assert.equal(res.exitCode, 0, `tsc --noEmit failed:\n${res.stdout}\n${res.stderr}`);
    });

    test('F10.2 npm run build succeeds with exit code 0 and emits dist/', async () => {
      const res = await runNpmBuild();
      assert.equal(res.exitCode, 0, `npm run build failed:\n${res.stdout}\n${res.stderr}`);
      assert.ok(fs.existsSync(path.join(PATHS.distDir, 'index.html')), 'Expected dist/index.html after build');
    });

    test('F10.3 Git remains on feat/madrid-lod2-map with main untouched', async () => {
      const git = await getGitState();
      assert.equal(git.branch, GIT_EXPECTATIONS.expectedBranch);
      if (git.originMainSha) {
        assert.equal(git.mainSha, git.originMainSha, 'Expected local main branch to remain untouched at origin/main');
      }
    });

    test('F10.4 Live browser navigation emits zero /data/ or /assets/ HTTP 404/500 responses', async (t) => {
      const browser = await requireLiveBrowser(t);
      if (!browser) return;
      await browser.goto(`${serverCtx.baseUrl}/`);
      await browser.waitForAppReady();
      await sleep(400);
      browser.assertCleanRuntime({ mode: 'map' });
    });

    test('F10.5 POI overlay and Fixie Bike mode run live without fatal errors', async (t) => {
      const browser = await requireLiveBrowser(t);
      if (!browser) return;
      await browser.goto(`${serverCtx.baseUrl}/`);
      await browser.waitForAppReady();
      browser.clearEvents();
      await browser.click('#btn-pois');
      await sleep(200);
      const telPoi = await browser.getTelemetry();
      assert.equal(telPoi.poiLayerDisplay, 'block');
      assert.ok(telPoi.visiblePois > 0, 'Expected visible POI pills');
      await browser.click('#btn-cam-bike');
      await browser.holdKeys(['ShiftLeft', 'KeyW'], 1000);
      await sleep(350);
      const telBike = await browser.getTelemetry();
      assert.ok(telBike.flightMode.includes('Fixie'), `Expected Fixie HUD mode, got "${telBike.flightMode}"`);
      browser.assertCleanRuntime({ mode: 'bike' });
    });
  });
});

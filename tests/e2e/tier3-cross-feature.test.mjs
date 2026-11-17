/**
 * Tier 3 — Cross-Feature Pairwise Integration E2E Suite (10 tests).
 * Verifies interactions across F1–F10 boundaries.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import {
  BBOX_SUBSETS,
  LANDMARKS,
  PATHS,
} from './fixtures/madrid-fixtures.mjs';
import {
  acquireBrowserContext,
  getBrowserConfigFromEnv,
} from './helpers/cdp-browser.mjs';
import {
  cleanupAllCliTempDirs,
  runConverterCached,
} from './helpers/cli.mjs';
import { ensureDevServer } from './helpers/dev-server.mjs';
import {
  assertLocalDemAlignment,
  countTrianglesInBox,
  createTerrainEvaluator,
  loadBaseManifest,
  loadJsonFile,
  parseSlpkChunk,
  readAndParseSlpkChunk,
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

describe('Tier 3 — Cross-Feature Pairwise Combinations (10 tests)', () => {
  test('T3.1 (F1×F2): Leaf extraction across 0_-2 & -1_-2 preserves unit normals and >= 99% outward winding', async () => {
    const res = await runConverterCached('chunks:cibeles-metro', ['--chunks', '0_-2,-1_-2']);
    assert.equal(res.exitCode, 0, `Converter failed: ${res.stderr || res.stdout}`);
    for (const key of ['0_-2', '-1_-2']) {
      const parsed = readAndParseSlpkChunk(path.join(res.outDir, `chunk_${key}.bin`));
      const m = validateSlpkChunkGeometry(parsed, {
        chunkKey: key,
        minNormalLen: 0.98,
        maxNormalLen: 1.02,
        minOutwardWindingRatio: 0.99,
        requireNonEmpty: true,
      });
      assert.ok(m.triangleCount > 1000);
    }
  });

  test('T3.2 (F2×F4): Projected Palacio Real -> Cuesta de la Vega (-5_-1 -> -5_0) tracks 28m local DEM slope', async () => {
    const terrain = createTerrainEvaluator(loadBaseManifest().dem);
    const res = await runConverterCached('chunks:palacio', ['--chunks', '-5_-1,-5_0']);
    assert.equal(res.exitCode, 0, `Converter failed: ${res.stderr || res.stdout}`);
    const upper = readAndParseSlpkChunk(path.join(res.outDir, 'chunk_-5_-1.bin'));
    const lower = readAndParseSlpkChunk(path.join(res.outDir, 'chunk_-5_0.bin'));
    const a1 = assertLocalDemAlignment(upper, terrain);
    const a2 = assertLocalDemAlignment(lower, terrain);
    assert.ok(a1.sampledCells >= 2 && a2.sampledCells >= 2);
    const mLower = validateSlpkChunkGeometry(lower, { chunkKey: '-5_0', terrain, requireNonEmpty: true });
    assert.ok(mLower.bounds.minY < -5, 'Expected negative Y elevations on Cuesta de la Vega slope');
  });

  test('T3.3 (F3×F4): Atocha arched canopy (0_2) preserves >= 1000 curved triangles AND stays elevated above DEM', async () => {
    const terrain = createTerrainEvaluator(loadBaseManifest().dem);
    const res = await runConverterCached('chunks:atocha', ['--chunks', '0_2,1_2']);
    assert.equal(res.exitCode, 0, `Converter failed: ${res.stderr || res.stdout}`);
    const parsed = readAndParseSlpkChunk(path.join(res.outDir, 'chunk_0_2.bin'));
    const m = validateSlpkChunkGeometry(parsed, { chunkKey: '0_2', terrain, requireNonEmpty: true });
    assert.ok(m.slopedRoofTriangles >= 1000, `Expected >= 1000 curved canopy tris, got ${m.slopedRoofTriangles}`);
    const canopy = countTrianglesInBox(parsed, { minX: 250, maxX: 520, minZ: 900, maxZ: 1200 });
    const groundY = terrain.getHeightAtXZ(LANDMARKS.atocha.x, LANDMARKS.atocha.z);
    assert.ok((canopy.maxY ?? -Infinity) > groundY + 15);
  });

  test('T3.4 (F3×F6): Cibeles dome/roof geometry pairs with valid aRoofType, aWallStyle, and aTopDist >= 5.0', async () => {
    const res = await runConverterCached('chunks:0_-2', ['--chunks', '0_-2']);
    assert.equal(res.exitCode, 0, `Converter failed: ${res.stderr || res.stdout}`);
    const parsed = readAndParseSlpkChunk(path.join(res.outDir, 'chunk_0_-2.bin'));
    const m = validateSlpkChunkGeometry(parsed, { upwardRoofMinTopDist: 5.0, requireNonEmpty: true });
    assert.ok(m.slopedRoofTriangles >= LANDMARKS.cibeles.slopedTris);
    assert.ok(m.roofTypeCounts[2] + m.roofTypeCounts[4] > 0);
    assert.ok(m.wallStyleCounts.filter((c) => c > 0).length >= 2);
  });

  test('T3.5 (F1×F5): --bbox Neptuno subset and --chunks 0_0 produce matching chunk_0_0.bin geometry', async () => {
    const byChunk = await runConverterCached('chunks:0_0', ['--chunks', '0_0']);
    const byBbox = await runConverterCached('bbox:neptuno', ['--bbox', BBOX_SUBSETS.neptunoSmall]);
    assert.equal(byChunk.exitCode, 0, `Converter --chunks failed: ${byChunk.stderr || byChunk.stdout}`);
    assert.equal(byBbox.exitCode, 0, `Converter --bbox failed: ${byBbox.stderr || byBbox.stdout}`);
    const p1 = readAndParseSlpkChunk(path.join(byChunk.outDir, 'chunk_0_0.bin'));
    const p2 = readAndParseSlpkChunk(path.join(byBbox.outDir, 'chunk_0_0.bin'));
    assert.equal(p1.header.buildingCount, p2.header.buildingCount);
    assert.equal(p1.header.vertexCount, p2.header.vertexCount);
    assert.equal(p1.header.indexCount, p2.header.indexCount);
  });

  test('T3.6 (F5×F7): Manifest grid keys align with runtime HTTP /data/chunks-slpk/chunk_*.bin streaming', async (t) => {
    const browser = await requireLiveBrowser(t);
    if (!browser) return;
    const slpk = loadJsonFile(PATHS.slpkManifest, 'full SLPK manifest');
    const manifestKeys = new Set(slpk.chunks.map((c) => c.key));

    await browser.goto(`${serverCtx.baseUrl}/?map=slpk`);
    await browser.waitForAppReady();
    await sleep(400);
    const binUrls = browser
      .getFetchedUrls()
      .filter((r) => /\/data\/chunks-slpk\/chunk_(-?\d+_-?\d+)\.bin/.test(r.url) && r.status === 200);
    assert.ok(binUrls.length > 0, 'Expected runtime .bin chunk fetches');
    for (const r of binUrls) {
      const m = /chunk_(-?\d+_-?\d+)\.bin/.exec(r.url);
      assert.ok(m && manifestKeys.has(m[1]), `Fetched chunk ${m?.[1]} not found in manifest`);
    }
  });

  test('T3.7 (F6×F8): Streamed HTTP .bin buffers satisfy binary attribute bounds AND render with zero AttributeNode warnings', async (t) => {
    const browser = await requireLiveBrowser(t);
    if (!browser) return;
    await browser.goto(`${serverCtx.baseUrl}/?map=slpk`);
    await browser.waitForAppReady();
    await sleep(500);
    browser.assertCleanRuntime({ mode: 'map' });

    const binUrls = browser
      .getFetchedUrls()
      .filter((r) => /\/data\/chunks-slpk\/chunk_-?\d+_-?\d+\.bin/.test(r.url) && r.status === 200);
    assert.ok(binUrls.length > 0, 'Expected streamed .bin URLs in SLPK mode');
    for (const r of binUrls.slice(0, 3)) {
      const res = await fetch(r.url);
      assert.equal(res.status, 200);
      const parsed = parseSlpkChunk(await res.arrayBuffer());
      validateSlpkChunkGeometry(parsed);
    }
  });

  test('T3.8 (F7×F9): Switching slpk -> osm -> slpk updates active building counts and re-streams cleanly', async (t) => {
    const browser = await requireLiveBrowser(t);
    if (!browser) return;
    await browser.goto(`${serverCtx.baseUrl}/?map=slpk`);
    await browser.waitForAppReady();
    await sleep(400);
    const urls = browser.getFetchedUrls();
    assert.ok(
      urls.some((r) => r.url.includes('/data/chunks-slpk/manifest.json') && r.status === 200),
      'Expected ?map=slpk initial load to stream /data/chunks-slpk/manifest.json'
    );
    const slpkTel = await browser.getTelemetry();
    assert.ok(
      !/LoD2 1:1000|OSM Base/.test(slpkTel.btnMapSource?.text || ''),
      `Expected SLPK label distinct from LoD2 1:1000 / OSM Base, got "${slpkTel.btnMapSource?.text}"`
    );

    // Cycle until OSM Base is active
    let osmTel = null;
    for (let i = 0; i < 3; i++) {
      await browser.click('#btn-map-source');
      await browser.waitForEnabled('#btn-map-source');
      await sleep(350);
      const tel = await browser.getTelemetry();
      if (tel.btnMapSource.text.includes('OSM Base')) {
        osmTel = tel;
        break;
      }
    }
    assert.ok(osmTel, 'Expected #btn-map-source cycle to reach OSM Base');
    assert.notEqual(osmTel.buildings, slpkTel.buildings, 'Expected OSM and SLPK building counts to differ');

    // Cycle back to initial mode
    for (let i = 0; i < 3; i++) {
      const tel = await browser.getTelemetry();
      if (tel.btnMapSource.text === slpkTel.btnMapSource.text) break;
      await browser.click('#btn-map-source');
      await browser.waitForEnabled('#btn-map-source');
      await sleep(350);
    }
    const backTel = await browser.getTelemetry();
    assert.equal(backTel.btnMapSource.text, slpkTel.btnMapSource.text);
    browser.assertCleanRuntime({ mode: 'switch' });
  });

  test('T3.9 (F8×F9): Aerial flight + map-source toggle preserves rendering stability with zero WebGPU errors', async (t) => {
    const browser = await requireLiveBrowser(t);
    if (!browser) return;
    await browser.goto(`${serverCtx.baseUrl}/?map=slpk`);
    await browser.waitForAppReady();
    browser.clearEvents();
    await browser.click('#btn-cam-aerial');
    await browser.holdKeys(['ShiftLeft', 'KeyW'], 1000);
    await browser.click('#btn-map-source');
    await sleep(800);
    await browser.click('#btn-map-source');
    await sleep(800);
    const tel = await browser.getTelemetry();
    assert.ok(tel.calls > 10, 'Expected active draw calls after aerial map switch');
    browser.assertCleanRuntime({ mode: 'switch' });
  });

  test('T3.10 (F9×F10): All three ?map= query params (slpk, lod2, osm) boot cleanly under WebGPU with zero 404s', async (t) => {
    const browser = await requireLiveBrowser(t);
    if (!browser) return;
    const seenLabels = new Set();
    for (const mode of ['slpk', 'lod2', 'osm']) {
      await browser.goto(`${serverCtx.baseUrl}/?map=${mode}`);
      const ready = await browser.waitForAppReady();
      await sleep(400);
      const tel = await browser.getTelemetry();
      seenLabels.add(tel.btnMapSource.text);
      const cfg = getBrowserConfigFromEnv();
      if (!cfg.allowWebglFallback) {
        assert.equal(ready.backend, 'WebGPU');
      }
      browser.assertCleanRuntime({ mode: 'map' });
    }
    assert.equal(seenLabels.size, 3, `Expected 3 distinct modes across ?map=slpk/lod2/osm, got ${[...seenLabels]}`);
  });
});

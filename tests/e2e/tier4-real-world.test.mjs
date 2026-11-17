/**
 * Tier 4 — Real-World Madrid E2E Application Scenarios (6 scenarios).
 * Exercises complete user journeys across Madrid landmarks under live WebGPU.
 */
import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { LANDMARKS, WARM_CACHE_MAX_CHUNKS } from './fixtures/madrid-fixtures.mjs';
import {
  acquireBrowserContext,
  getBrowserConfigFromEnv,
} from './helpers/cdp-browser.mjs';
import { ensureDevServer } from './helpers/dev-server.mjs';
import {
  parseSlpkChunk,
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

describe('Tier 4 — Real-World Madrid Scenarios (6 scenarios)', () => {
  test('T4.1 Neptuno (0, 0) Startup & WebGPU City Overview', async (t) => {
    const browser = await requireLiveBrowser(t);
    if (!browser) return;
    await browser.goto(`${serverCtx.baseUrl}/`);
    const ready = await browser.waitForAppReady();
    await sleep(500);

    const cfg = getBrowserConfigFromEnv();
    if (!cfg.allowWebglFallback) {
      assert.equal(ready.backend, 'WebGPU');
    }

    const tel = await browser.getTelemetry();
    assert.ok(tel.activeChunks >= 4, `Expected >= 4 preloaded chunks around Neptuno, got ${tel.activeChunks}`);
    assert.ok(tel.buildings > 0, `Expected non-zero buildings, got ${tel.buildings}`);
    assert.ok(tel.calls > 10, `Expected active draw calls, got ${tel.calls}`);
    assert.ok(tel.elevText.includes('652'), `Expected Neptuno elevation ~652m, got "${tel.elevText}"`);

    const urls = browser.getFetchedUrls();
    assert.ok(
      urls.some((r) => r.url.includes('/data/chunks-slpk/manifest.json') && r.status === 200),
      'Expected SLPK manifest fetch on startup'
    );
    assert.ok(
      urls.some((r) => r.url.includes('/data/chunks-slpk/chunk_0_0.bin') && r.status === 200),
      'Expected chunk_0_0.bin fetch at Neptuno startup'
    );

    const png = await browser.screenshot();
    assert.ok(png.byteLength > 50_000, `Expected non-empty rendered PNG (>50KB), got ${png.byteLength}B`);
    browser.assertCleanRuntime({ mode: 'map' });
  });

  test('T4.2 Palacio de Cibeles Dome, Towers & Rooftop Skylight (0_-2)', async (t) => {
    const browser = await requireLiveBrowser(t);
    if (!browser) return;
    await browser.goto(`${serverCtx.baseUrl}/?map=slpk`);
    await browser.waitForAppReady();
    browser.clearEvents();

    await browser.click('#btn-pois');
    await sleep(150);
    await browser.clickPoi('Plaza de Cibeles');
    await sleep(1200);

    const tel = await browser.getTelemetry();
    assert.ok(tel.buildings > 0 && tel.calls > 10);

    // Fetch chunk_0_-2.bin from the live server and verify dome/skylight attributes & winding
    const binRes = await fetch(`${serverCtx.baseUrl}/data/chunks-slpk/chunk_0_-2.bin`);
    assert.equal(binRes.status, 200, 'Expected HTTP 200 for /data/chunks-slpk/chunk_0_-2.bin');
    const parsed = parseSlpkChunk(await binRes.arrayBuffer());
    const metrics = validateSlpkChunkGeometry(parsed, { chunkKey: '0_-2', requireNonEmpty: true });
    assert.ok(
      metrics.slopedRoofTriangles >= LANDMARKS.cibeles.slopedTris,
      `Expected Cibeles sloped/dome tris >= ${LANDMARKS.cibeles.slopedTris}, got ${metrics.slopedRoofTriangles}`
    );

    const png = await browser.screenshot();
    assert.ok(png.byteLength > 50_000);
    browser.assertCleanRuntime({ mode: 'map' });
  });

  test('T4.3 Gran Vía Corridor Multi-Chunk Cruise (-1_-2 -> -2_-2 -> -3_-2)', async (t) => {
    const browser = await requireLiveBrowser(t);
    if (!browser) return;
    await browser.goto(`${serverCtx.baseUrl}/?map=slpk`);
    await browser.waitForAppReady();
    browser.clearEvents();

    await browser.click('#btn-pois');
    await sleep(150);
    await browser.clickPoi('Puerta del Sol');
    await sleep(900);

    await browser.click('#btn-cam-aerial');
    await sleep(200);
    await browser.holdKeys(['ShiftLeft', 'KeyW'], 1800);
    await browser.holdKeys(['ShiftLeft', 'KeyA'], 1200);
    await sleep(700);

    const urls = browser.getFetchedUrls();
    assert.ok(
      urls.some((r) => /\/data\/chunks-slpk\/chunk_-\d+_-\d+\.bin/.test(r.url) && r.status === 200),
      'Expected negative-quadrant Gran Vía / Sol SLPK .bin chunks to stream dynamically'
    );
    const tel = await browser.getTelemetry();
    assert.ok(tel.activeChunks >= 4 && tel.buildings > 0);
    browser.assertCleanRuntime({ mode: 'aerial' });
  });

  test('T4.4 Palacio Real -> Cuesta de la Vega Steep Slope Descent (-5_-1 -> -5_0)', async (t) => {
    const browser = await requireLiveBrowser(t);
    if (!browser) return;
    await browser.goto(`${serverCtx.baseUrl}/?map=slpk`);
    await browser.waitForAppReady();
    browser.clearEvents();

    await browser.click('#btn-pois');
    await sleep(150);
    await browser.clickPoi('Palacio Real');
    await sleep(1200);
    const beforeTel = await browser.getTelemetry();

    await browser.click('#btn-cam-bike');
    await sleep(250);
    await browser.holdKeys(['ShiftLeft', 'KeyW'], 1800);
    await sleep(500);
    const afterTel = await browser.getTelemetry();

    assert.ok(afterTel.flightMode.includes('Fixie'));
    assert.ok(afterTel.activeChunks >= 4 && afterTel.buildings > 0);
    assert.ok(beforeTel.elevText.length > 0 && afterTel.elevText.length > 0);
    browser.assertCleanRuntime({ mode: 'bike' });
  });

  test('T4.5 Atocha -> Retiro Park & #btn-map-source Live Comparison (slpk/lod2/osm)', async (t) => {
    const browser = await requireLiveBrowser(t);
    if (!browser) return;
    await browser.goto(`${serverCtx.baseUrl}/?map=slpk`);
    await browser.waitForAppReady();
    browser.clearEvents();

    await browser.click('#btn-pois');
    await sleep(150);
    await browser.clickPoi('Estación de Atocha');
    await sleep(1000);
    await browser.clickPoi('Estanque del Retiro');
    await sleep(1000);

    const urls = browser.getFetchedUrls();
    assert.ok(
      urls.some((r) => r.url.includes('/data/chunks-slpk/chunk_0_2.bin') && r.status === 200) ||
        urls.some((r) => r.url.includes('/data/chunks-slpk/chunk_2_-1.bin') && r.status === 200),
      'Expected Atocha/Retiro SLPK .bin chunks to be streamed'
    );

    const labels = new Set();
    for (let i = 0; i < 3; i++) {
      const tel = await browser.getTelemetry();
      labels.add(tel.btnMapSource.text);
      await browser.click('#btn-map-source');
      await browser.waitForEnabled('#btn-map-source');
      await sleep(350);
    }
    assert.equal(labels.size, 3, `Expected 3 distinct map modes during Atocha/Retiro toggle, got ${[...labels]}`);
    browser.assertCleanRuntime({ mode: 'switch' });
  });

  test('T4.6 Long-Range M-30 POI Tour (Dynamic Streaming & LRU Cache Churn)', async (t) => {
    const browser = await requireLiveBrowser(t);
    if (!browser) return;
    await browser.goto(`${serverCtx.baseUrl}/?map=slpk`);
    await browser.waitForAppReady();
    browser.clearEvents();

    await browser.click('#btn-pois');
    await sleep(150);

    const tour = [
      'Plaza de Castilla',
      'AZCA / Bernabéu',
      'Plaza de Las Ventas',
      'Matadero / Madrid Río',
      'Templo de Debod',
      'Fuente de Neptuno',
    ];
    for (const poi of tour) {
      await browser.clickPoi(poi);
      await sleep(900);
    }

    const binChunksFetched = new Set(
      browser
        .getFetchedUrls()
        .filter((r) => /\/data\/chunks-slpk\/chunk_-?\d+_-?\d+\.bin/.test(r.url) && r.status === 200)
        .map((r) => r.url)
    );
    assert.ok(
      binChunksFetched.size >= 20,
      `Expected >= 20 distinct SLPK .bin chunks streamed across M-30 POI tour, got ${binChunksFetched.size}`
    );

    const tel = await browser.getTelemetry();
    assert.ok(
      tel.activeChunks <= WARM_CACHE_MAX_CHUNKS,
      `Expected warm cache bounded <= ${WARM_CACHE_MAX_CHUNKS}, got ${tel.activeChunks}`
    );
    browser.assertCleanRuntime({ mode: 'map' });
  });
});

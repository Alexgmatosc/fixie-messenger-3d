/**
 * Zero-dependency Node 22 Chrome CDP + WebGPU automation helper.
 * Uses global fetch + WebSocket against headless/offscreen Chrome with isolated
 * mkdtemp --user-data-dir, full Runtime/Log/Network/Page telemetry, clean tab
 * recycling on goto() to avoid WebGPU device accumulation, and guaranteed cleanup.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_CHROME_PATHS = [
  process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
].filter(Boolean);

export const MCP_FALLBACK_INSTRUCTIONS = [
  'Chrome headless WebGPU is unavailable in this environment. Verify live via chrome-devtools-mcp:',
  '  1. new_page / navigate_page -> http://localhost:5173/?map=slpk',
  '  2. wait_for -> #loading-overlay.hidden / #stat-backend',
  '  3. evaluate_script -> verify #stat-backend === "WebGPU", navigator.gpu.requestAdapter() !== null, and #stat-* counts',
  '  4. click #btn-map-source, #btn-cam-aerial, #btn-pois, and a .poi-pill; press_key (Shift + KeyW) to stream chunks',
  '  5. list_console_messages & list_network_requests -> verify 0 WebGPU/TSL/AttributeNode warnings and 0 /data/ 404/500s',
  '  6. take_screenshot for visual verification, then close_page',
].join('\n');

const activeSessions = new Set();
let hooksRegistered = false;

function registerProcessCleanupHooks() {
  if (hooksRegistered) return;
  hooksRegistered = true;

  const syncTeardown = () => {
    for (const s of activeSessions) {
      try {
        if (s.ws && s.ws.readyState === WebSocket.OPEN) {
          s.ws.close();
        }
      } catch {
        // ignore
      }
      try {
        if (s.proc && s.proc.exitCode === null) {
          s.proc.kill('SIGKILL');
        }
      } catch {
        // ignore
      }
      try {
        if (s.userDataDir) {
          fs.rmSync(s.userDataDir, { recursive: true, force: true });
        }
      } catch {
        // ignore
      }
    }
    activeSessions.clear();
  };

  process.on('exit', syncTeardown);
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      syncTeardown();
      process.exit(130);
    });
  }
}

export function findChromeBinary() {
  for (const candidate of DEFAULT_CHROME_PATHS) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function getBrowserConfigFromEnv() {
  const mode = (process.env.E2E_BROWSER_MODE || 'auto').toLowerCase();
  const headed = process.env.E2E_HEADED === '1';
  const allowWebglFallback = process.env.E2E_ALLOW_WEBGL_FALLBACK === '1';
  return { mode, headed, allowWebglFallback };
}

const KEY_INFO = {
  KeyW: { key: 'w', code: 'KeyW', windowsVirtualKeyCode: 87 },
  KeyA: { key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 },
  KeyS: { key: 's', code: 'KeyS', windowsVirtualKeyCode: 83 },
  KeyD: { key: 'd', code: 'KeyD', windowsVirtualKeyCode: 68 },
  KeyQ: { key: 'q', code: 'KeyQ', windowsVirtualKeyCode: 81 },
  KeyE: { key: 'e', code: 'KeyE', windowsVirtualKeyCode: 69 },
  KeyR: { key: 'r', code: 'KeyR', windowsVirtualKeyCode: 82 },
  ShiftLeft: { key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, modifierBit: 8 },
  ControlLeft: { key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, modifierBit: 2 },
  Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function formatConsoleArgs(args = []) {
  return args
    .map((a) => {
      if (a.value !== undefined) return String(a.value);
      if (a.description !== undefined) return String(a.description);
      return a.type || '';
    })
    .join(' ');
}

function isIgnorableUrl(url = '', allowOfflineIgn = true) {
  if (!url) return false;
  if (url.endsWith('/favicon.ico')) return true;
  if (allowOfflineIgn && url.includes('ign.es/')) return true;
  return false;
}

function isAllowlistedLogText(text = '', { mode = 'map', allowOfflineIgn = true } = {}) {
  if (text.includes('willReadFrequently')) return true;
  if (text.includes('/favicon.ico')) return true;
  if (allowOfflineIgn && text.includes('ign.es')) return true;
  if (
    mode === 'bike' &&
    text.includes('THREE.TSL: Vertex attribute "normal" not found on geometry')
  ) {
    return true;
  }
  return false;
}

function isCriticalGpuOrTslMessage(text = '') {
  return /WebGPU|WGSL|DeviceLost|AttributeNode|THREE\.TSL|Vertex attribute .* not found/i.test(text);
}

/**
 * Launches Chrome with isolated userDataDir and attaches a zero-dep CDP WebSocket client.
 */
export async function launchCdpBrowser(options = {}) {
  const {
    headless = process.env.E2E_HEADED !== '1',
    chromePath = findChromeBinary(),
    launchTimeoutMs = 20000,
    windowWidth = 1280,
    windowHeight = 800,
  } = options;

  if (!chromePath) {
    throw new Error('Google Chrome binary not found. Set CHROME_BIN or install Google Chrome.');
  }

  registerProcessCleanupHooks();
  const userDataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'fixie-e2e-chrome-'));

  const args = [
    headless ? '--headless=new' : '--window-position=-3200,-3200',
    `--user-data-dir=${userDataDir}`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--metrics-recording-only',
    `--window-size=${windowWidth},${windowHeight}`,
    'about:blank',
  ];

  const proc = spawn(chromePath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const sessionRecord = { proc, userDataDir, ws: null };
  activeSessions.add(sessionRecord);

  let stderrBuf = '';
  let port = null;
  let exited = false;

  proc.on('exit', () => {
    exited = true;
  });
  proc.stderr.on('data', (chunk) => {
    stderrBuf += chunk.toString('utf8');
    const m = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(stderrBuf);
    if (m) port = Number(m[1]);
  });

  try {
    const activePortFile = path.join(userDataDir, 'DevToolsActivePort');
    const deadline = Date.now() + launchTimeoutMs;
    while (!port && Date.now() < deadline) {
      if (exited) {
        throw new Error(`Chrome exited prematurely (${proc.exitCode}): ${stderrBuf}`);
      }
      if (fs.existsSync(activePortFile)) {
        const lines = fs.readFileSync(activePortFile, 'utf8').trim().split(/\r?\n/);
        const parsed = Number(lines[0]);
        if (Number.isInteger(parsed) && parsed > 0) {
          port = parsed;
          break;
        }
      }
      await sleep(75);
    }

    if (!port) {
      throw new Error(`Timed out waiting for Chrome DevTools port: ${stderrBuf}`);
    }

    let pageTarget = null;
    while (Date.now() < deadline) {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (res.ok) {
        const targets = await res.json();
        pageTarget = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
        if (pageTarget) break;
      }
      await sleep(75);
    }

    if (!pageTarget) {
      throw new Error('Could not find Chrome page target via /json/list');
    }

    const events = {
      consoleMessages: [],
      exceptions: [],
      logEntries: [],
      responses: [],
      loadingFailed: [],
      requestsById: new Map(),
    };

    let nextId = 1;
    let pending = new Map();
    let ws = null;
    let currentTargetId = pageTarget.id;

    const attachToTarget = async (target) => {
      const oldWs = ws;
      const oldPending = pending;
      pending = new Map();

      const nextWs = new WebSocket(target.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('CDP WebSocket connect timeout')), 10000);
        nextWs.addEventListener(
          'open',
          () => {
            clearTimeout(t);
            resolve();
          },
          { once: true }
        );
        nextWs.addEventListener(
          'error',
          (err) => {
            clearTimeout(t);
            reject(new Error(`CDP WebSocket error: ${err?.message || 'unknown'}`));
          },
          { once: true }
        );
      });

      nextWs.addEventListener('message', (msgEvent) => {
        const data = JSON.parse(String(msgEvent.data));
        if (data.id !== undefined) {
          const slot = pending.get(data.id);
          if (slot) {
            pending.delete(data.id);
            if (data.error) {
              slot.reject(new Error(`CDP ${slot.method}: ${data.error.message}`));
            } else {
              slot.resolve(data.result);
            }
          }
          return;
        }

        const { method, params } = data;
        if (method === 'Runtime.consoleAPICalled') {
          events.consoleMessages.push({
            type: params.type,
            text: formatConsoleArgs(params.args),
            timestamp: params.timestamp,
          });
        } else if (method === 'Runtime.exceptionThrown') {
          const ex = params.exceptionDetails;
          events.exceptions.push({
            text: ex?.exception?.description || ex?.text || 'Uncaught exception',
            url: ex?.url || '',
            lineNumber: ex?.lineNumber,
          });
        } else if (method === 'Log.entryAdded') {
          events.logEntries.push({
            level: params.entry?.level,
            source: params.entry?.source,
            text: params.entry?.text || '',
            url: params.entry?.url || '',
          });
        } else if (method === 'Network.requestWillBeSent') {
          events.requestsById.set(params.requestId, params.request?.url || '');
        } else if (method === 'Network.responseReceived') {
          events.responses.push({
            requestId: params.requestId,
            url: params.response?.url || '',
            status: params.response?.status ?? 0,
            mimeType: params.response?.mimeType || '',
          });
        } else if (method === 'Network.loadingFailed') {
          events.loadingFailed.push({
            requestId: params.requestId,
            url: events.requestsById.get(params.requestId) || '',
            errorText: params.errorText || 'loadingFailed',
            canceled: Boolean(params.canceled),
          });
        }
      });

      ws = nextWs;
      sessionRecord.ws = nextWs;
      currentTargetId = target.id;

      if (oldWs) {
        for (const slot of oldPending.values()) {
          slot.reject(new Error('Tab recycled'));
        }
        try {
          if (oldWs.readyState === WebSocket.OPEN) oldWs.close();
        } catch {
          // ignore
        }
      }

      await send('Runtime.enable');
      await send('Log.enable');
      await send('Network.enable');
      await send('Page.enable');
    };

    const send = (method, params = {}, timeoutMs = 25000) => {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`CDP command timed out (${timeoutMs}ms): ${method}`));
        }, timeoutMs);
        pending.set(id, {
          method,
          resolve: (val) => {
            clearTimeout(timer);
            resolve(val);
          },
          reject: (err) => {
            clearTimeout(timer);
            reject(err);
          },
        });
        ws.send(JSON.stringify({ id, method, params }));
      });
    };

    await attachToTarget(pageTarget);

    let hasNavigatedOnce = false;

    const close = async () => {
      activeSessions.delete(sessionRecord);
      try {
        if (ws && ws.readyState === WebSocket.OPEN) {
          await Promise.race([send('Browser.close').catch(() => {}), sleep(500)]);
          ws.close();
        }
      } catch {
        // ignore
      }
      if (!exited) {
        try {
          proc.kill('SIGTERM');
        } catch {
          // ignore
        }
        const waitStart = Date.now();
        while (!exited && Date.now() - waitStart < 1500) {
          await sleep(50);
        }
        if (!exited) {
          try {
            proc.kill('SIGKILL');
          } catch {
            // ignore
          }
        }
      }
      await fs.promises.rm(userDataDir, { recursive: true, force: true });
    };

    const evaluate = async (fnOrExpr, ...args) => {
      const expression =
        typeof fnOrExpr === 'function'
          ? `(${fnOrExpr.toString()})(${args.map((a) => JSON.stringify(a)).join(',')})`
          : String(fnOrExpr);
      const res = await send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (res.exceptionDetails) {
        throw new Error(
          `Runtime.evaluate exception: ${res.exceptionDetails.exception?.description || res.exceptionDetails.text}`
        );
      }
      return res.result?.value;
    };

    const clearEvents = () => {
      events.consoleMessages.length = 0;
      events.exceptions.length = 0;
      events.logEntries.length = 0;
      events.responses.length = 0;
      events.loadingFailed.length = 0;
      events.requestsById.clear();
    };

    const goto = async (url, { clear = true, recycleTab = true } = {}) => {
      if (recycleTab && hasNavigatedOnce) {
        const prevId = currentTargetId;
        const newRes = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' });
        if (newRes.ok) {
          const newTarget = await newRes.json();
          if (newTarget?.webSocketDebuggerUrl) {
            if (clear) clearEvents();
            await attachToTarget(newTarget);
            await fetch(`http://127.0.0.1:${port}/json/close/${prevId}`).catch(() => {});
            await send('Page.navigate', { url });
            await sleep(100);
            return;
          }
        }
      }
      hasNavigatedOnce = true;
      if (clear) clearEvents();
      await send('Page.navigate', { url });
      await sleep(100);
    };

    const waitForAppReady = async (timeoutMs = 25000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const state = await evaluate(() => {
          const overlay = document.getElementById('loading-overlay');
          const status = document.getElementById('loading-status')?.textContent || '';
          const backend = document.getElementById('stat-backend')?.textContent || '—';
          const fps = document.getElementById('stat-fps')?.textContent || '—';
          const chunks = document.getElementById('stat-chunks')?.textContent || '—';
          return {
            hidden: overlay ? overlay.classList.contains('hidden') : false,
            status,
            backend,
            fps,
            chunks,
          };
        });
        if (state?.status?.includes('Error al iniciar')) {
          throw new assert.AssertionError({ message: `App failed to initialize: ${state.status}` });
        }
        if (state?.hidden && state.backend !== '—' && state.fps !== '—') {
          return state;
        }
        await sleep(150);
      }
      const last = await evaluate(() => ({
        hidden: document.getElementById('loading-overlay')?.classList.contains('hidden'),
        status: document.getElementById('loading-status')?.textContent,
        backend: document.getElementById('stat-backend')?.textContent,
        fps: document.getElementById('stat-fps')?.textContent,
      }));
      throw new Error(`Timed out waiting for app ready after ${timeoutMs}ms: ${JSON.stringify(last)}`);
    };

    const getTelemetry = async () => {
      return evaluate(() => {
        const text = (id) => document.getElementById(id)?.textContent?.trim() ?? '';
        const btnMap = document.getElementById('btn-map-source');
        const canvas = document.querySelector('#canvas-container canvas');
        const poiLayer = document.getElementById('poi-layer');
        const visiblePois = Array.from(document.querySelectorAll('#poi-layer .poi-pill')).filter(
          (el) => el.style.display !== 'none'
        ).length;

        const chunksStr = text('stat-chunks');
        const chunkMatch = /^(\d+)\s*\/\s*(\d+)$/.exec(chunksStr);

        return {
          backend: text('stat-backend'),
          chunksText: chunksStr,
          activeChunks: chunkMatch ? Number(chunkMatch[1]) : 0,
          totalChunks: chunkMatch ? Number(chunkMatch[2]) : 0,
          calls: Number(text('stat-calls')) || 0,
          fps: Number(text('stat-fps')) || 0,
          buildings: Number(text('stat-buildings').replace(/[^\d]/g, '')) || 0,
          trees: Number(text('stat-trees').replace(/[^\d]/g, '')) || 0,
          elevText: text('stat-elev'),
          subtitle: text('map-subtitle'),
          btnMapSource: btnMap
            ? {
                text: btnMap.textContent?.trim() ?? '',
                disabled: btnMap.disabled,
                active: btnMap.classList.contains('active'),
                ariaPressed: btnMap.getAttribute('aria-pressed'),
              }
            : null,
          flightHudHidden: document.getElementById('flight-hud')?.hidden ?? true,
          flightMode: text('flight-mode-label'),
          flightAlt: text('flight-alt'),
          flightSpeed: text('flight-speed'),
          poiLayerDisplay: poiLayer ? poiLayer.style.display : 'none',
          visiblePois,
          canvasWidth: canvas?.width ?? 0,
          canvasHeight: canvas?.height ?? 0,
          canvasClientWidth: canvas?.clientWidth ?? 0,
          canvasClientHeight: canvas?.clientHeight ?? 0,
        };
      });
    };

    const clickPoint = async (x, y) => {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x,
        y,
        button: 'left',
        clickCount: 1,
      });
      await send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x,
        y,
        button: 'left',
        clickCount: 1,
      });
    };

    const waitForEnabled = async (selector, timeoutMs = 15000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const disabled = await evaluate((sel) => {
          const el = document.querySelector(sel);
          return el ? Boolean(el.disabled) : null;
        }, selector);
        if (disabled === false) return;
        await sleep(75);
      }
      throw new Error(`Element "${selector}" remained disabled after ${timeoutMs}ms`);
    };

    const click = async (selector, { waitForEnabledMs = 15000, force = false } = {}) => {
      const deadline = Date.now() + waitForEnabledMs;
      let rect = null;
      while (true) {
        rect = await evaluate((sel) => {
          const el = document.querySelector(sel);
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return {
            x: r.left + r.width / 2,
            y: r.top + r.height / 2,
            width: r.width,
            height: r.height,
            disabled: Boolean(el.disabled),
          };
        }, selector);
        assert.ok(rect && rect.width > 0 && rect.height > 0, `Element "${selector}" not found or not visible`);
        if (force || !rect.disabled) break;
        if (Date.now() >= deadline) {
          assert.ok(!rect.disabled, `Element "${selector}" remained disabled after ${waitForEnabledMs}ms`);
        }
        await sleep(75);
      }
      await clickPoint(rect.x, rect.y);
    };

    /**
     * Triggers a POI pill navigation button. Uses a real CDP mouse click when the
     * pill is within the current camera frustum; falls back to DOM .click() on the
     * matching .poi-pill when frustum-culled (display: none) behind the camera.
     */
    const clickPoi = async (labelSubstring) => {
      const info = await evaluate((needle) => {
        const pills = Array.from(document.querySelectorAll('#poi-layer .poi-pill'));
        const el = pills.find((p) => (p.textContent || '').includes(needle));
        if (!el) return null;
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          return {
            visible: true,
            x: r.left + r.width / 2,
            y: r.top + r.height / 2,
            label: el.textContent?.trim(),
          };
        }
        el.click();
        return { visible: false, label: el.textContent?.trim() };
      }, labelSubstring);
      assert.ok(info, `POI pill matching "${labelSubstring}" not found in #poi-layer`);
      if (info.visible) {
        await clickPoint(info.x, info.y);
      }
      return info.label;
    };

    const holdKeys = async (codes, durationMs = 1000) => {
      let modifiers = 0;
      for (const code of codes) {
        const info = KEY_INFO[code] || { key: code, code, windowsVirtualKeyCode: 0 };
        if (info.modifierBit) modifiers |= info.modifierBit;
      }
      try {
        for (const code of codes) {
          const info = KEY_INFO[code] || { key: code, code, windowsVirtualKeyCode: 0 };
          await send('Input.dispatchKeyEvent', {
            type: 'keyDown',
            code: info.code,
            key: info.key,
            windowsVirtualKeyCode: info.windowsVirtualKeyCode,
            modifiers,
          });
        }
        await sleep(durationMs);
      } finally {
        for (const code of [...codes].reverse()) {
          const info = KEY_INFO[code] || { key: code, code, windowsVirtualKeyCode: 0 };
          await send('Input.dispatchKeyEvent', {
            type: 'keyUp',
            code: info.code,
            key: info.key,
            windowsVirtualKeyCode: info.windowsVirtualKeyCode,
            modifiers: 0,
          }).catch(() => {});
        }
      }
    };

    const setViewport = async (width, height) => {
      await send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false,
      });
    };

    const screenshot = async (filePath = null) => {
      const res = await send('Page.captureScreenshot', { format: 'png' });
      const buf = Buffer.from(res.data, 'base64');
      if (filePath) {
        await fs.promises.writeFile(filePath, buf);
      }
      return buf;
    };

    const probeWebGpuAdapter = async () => {
      return evaluate(async () => {
        if (!('gpu' in navigator) || !navigator.gpu) {
          return { hasGpu: false, adapter: null };
        }
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) {
          return { hasGpu: true, adapter: null };
        }
        return {
          hasGpu: true,
          adapter: {
            vendor: adapter.info?.vendor ?? '',
            architecture: adapter.info?.architecture ?? '',
            featuresCount: adapter.features?.size ?? 0,
          },
        };
      });
    };

    const getAuditedErrors = ({ mode = 'map', allowOfflineIgn = true } = {}) => {
      const consoleErrors = events.consoleMessages.filter(
        (m) => m.type === 'error' && !isAllowlistedLogText(m.text, { mode, allowOfflineIgn })
      );
      const criticalWarnings = events.consoleMessages.filter(
        (m) =>
          m.type === 'warning' &&
          !isAllowlistedLogText(m.text, { mode, allowOfflineIgn }) &&
          isCriticalGpuOrTslMessage(m.text)
      );
      const logErrors = events.logEntries.filter(
        (e) =>
          (e.level === 'error' || isCriticalGpuOrTslMessage(e.text)) &&
          !isAllowlistedLogText(e.text, { mode, allowOfflineIgn }) &&
          !isIgnorableUrl(e.url, allowOfflineIgn)
      );
      const badResponses = events.responses.filter(
        (r) => r.status >= 400 && !isIgnorableUrl(r.url, allowOfflineIgn)
      );
      const failedRequests = events.loadingFailed.filter(
        (f) => !f.canceled && !isIgnorableUrl(f.url, allowOfflineIgn)
      );

      return {
        exceptions: [...events.exceptions],
        consoleErrors,
        criticalWarnings,
        logErrors,
        badResponses,
        failedRequests,
      };
    };

    const assertCleanRuntime = (opts = {}) => {
      const audit = getAuditedErrors(opts);
      assert.equal(
        audit.exceptions.length,
        0,
        `Uncaught browser exceptions: ${JSON.stringify(audit.exceptions)}`
      );
      assert.equal(
        audit.consoleErrors.length,
        0,
        `Unexpected console errors: ${JSON.stringify(audit.consoleErrors)}`
      );
      assert.equal(
        audit.criticalWarnings.length,
        0,
        `Unexpected WebGPU/TSL/AttributeNode warnings: ${JSON.stringify(audit.criticalWarnings)}`
      );
      assert.equal(
        audit.logErrors.length,
        0,
        `Unexpected browser log errors: ${JSON.stringify(audit.logErrors)}`
      );
      assert.equal(
        audit.badResponses.length,
        0,
        `Unexpected HTTP >= 400 responses: ${JSON.stringify(audit.badResponses)}`
      );
      assert.equal(
        audit.failedRequests.length,
        0,
        `Unexpected network loading failures: ${JSON.stringify(audit.failedRequests)}`
      );
    };

    const getFetchedUrls = () => events.responses.map((r) => ({ url: r.url, status: r.status }));

    return {
      port,
      userDataDir,
      send,
      evaluate,
      goto,
      waitForAppReady,
      getTelemetry,
      waitForEnabled,
      click,
      clickPoi,
      holdKeys,
      setViewport,
      screenshot,
      probeWebGpuAdapter,
      clearEvents,
      getAuditedErrors,
      assertCleanRuntime,
      getFetchedUrls,
      events,
      close,
    };
  } catch (err) {
    activeSessions.delete(sessionRecord);
    try {
      if (proc.exitCode === null) proc.kill('SIGKILL');
    } catch {
      // ignore
    }
    await fs.promises.rm(userDataDir, { recursive: true, force: true });
    throw err;
  }
}

/**
 * Acquires a browser session respecting --browser=auto|required|off and
 * --allow-webgl-fallback. Returns { skip: true, reason, mcpInstructions } when skipped.
 */
export async function acquireBrowserContext({ baseUrl, config = getBrowserConfigFromEnv() } = {}) {
  if (config.mode === 'off') {
    return {
      available: false,
      skip: true,
      reason: 'Browser tests disabled (--browser=off)',
      mcpInstructions: MCP_FALLBACK_INSTRUCTIONS,
      browser: null,
    };
  }

  const chromePath = findChromeBinary();
  if (!chromePath) {
    if (config.mode === 'required') {
      throw new Error(`Chrome binary not found and --browser=required is set.\n${MCP_FALLBACK_INSTRUCTIONS}`);
    }
    return {
      available: false,
      skip: true,
      reason: 'Google Chrome binary not found',
      mcpInstructions: MCP_FALLBACK_INSTRUCTIONS,
      browser: null,
    };
  }

  let browser;
  try {
    browser = await launchCdpBrowser({
      headless: !config.headed,
      chromePath,
    });
    await browser.goto(baseUrl);
    const gpu = await browser.probeWebGpuAdapter();
    if (!gpu.adapter && !config.allowWebglFallback) {
      await browser.close();
      if (config.mode === 'required') {
        throw new Error(`WebGPU adapter unavailable in Chrome and --allow-webgl-fallback is not set.\n${MCP_FALLBACK_INSTRUCTIONS}`);
      }
      return {
        available: false,
        skip: true,
        reason: 'WebGPU adapter unavailable in Chrome (Metal GPU blocked or headless fallback)',
        mcpInstructions: MCP_FALLBACK_INSTRUCTIONS,
        browser: null,
      };
    }
    return {
      available: true,
      skip: false,
      reason: null,
      gpu,
      browser,
    };
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    if (config.mode === 'required') {
      throw err;
    }
    return {
      available: false,
      skip: true,
      reason: `Chrome CDP unavailable: ${err.message}`,
      mcpInstructions: MCP_FALLBACK_INSTRUCTIONS,
      browser: null,
    };
  }
}

export function isAllowlistedConsoleCheck(text, options) {
  return isAllowlistedLogText(text, options);
}

export function isIgnorableNetworkUrl(url, allowOfflineIgn = true) {
  return isIgnorableUrl(url, allowOfflineIgn);
}

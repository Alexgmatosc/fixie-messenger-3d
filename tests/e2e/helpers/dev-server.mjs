/**
 * Dev/preview server helper for E2E browser tests.
 * Reuses an active http://localhost:5173/ (or E2E_BASE_URL) when serving the app,
 * or spawns an ephemeral Vite dev/preview server on 127.0.0.1:<freePort>.
 * Never terminates pre-existing developer servers (e.g. PID 4249).
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { PATHS } from '../fixtures/madrid-fixtures.mjs';

const activeServers = new Set();
let exitHookRegistered = false;

function registerExitCleanup() {
  if (exitHookRegistered) return;
  exitHookRegistered = true;
  process.on('exit', () => {
    for (const proc of activeServers) {
      try {
        proc.kill('SIGKILL');
      } catch {
        // ignore
      }
    }
    activeServers.clear();
  });
}

async function isAppServing(url, timeoutMs = 1500) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal });
    if (!res.ok) return false;
    const html = await res.text();
    return html.includes('canvas-container');
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export function allocateFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : null;
      srv.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

export async function stopServerProcess(proc) {
  if (!proc) return;
  activeServers.delete(proc);
  if (proc.exitCode !== null || proc.killed) return;

  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    proc.once('exit', finish);
    try {
      proc.kill('SIGTERM');
    } catch {
      finish();
      return;
    }
    const killTimer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        // ignore
      }
      setTimeout(finish, 300).unref();
    }, 1500);
    killTimer.unref();
  });
}

export async function ensureDevServer(options = {}) {
  const {
    baseUrl = process.env.E2E_BASE_URL || 'http://localhost:5173',
    preview = process.env.E2E_PREVIEW === '1',
    cwd = PATHS.repoRoot,
    timeoutMs = 15000,
  } = options;

  if (!preview && (await isAppServing(baseUrl))) {
    return {
      baseUrl: baseUrl.replace(/\/$/, ''),
      managed: false,
      preview: false,
      close: async () => {},
    };
  }

  registerExitCleanup();
  const port = await allocateFreePort();
  const viteBin = path.join(cwd, 'node_modules', '.bin', 'vite');
  const args = preview
    ? ['preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort']
    : ['--host', '127.0.0.1', '--port', String(port), '--strictPort'];

  const proc = spawn(viteBin, args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  activeServers.add(proc);

  let logs = '';
  proc.stdout.on('data', (d) => {
    logs += d.toString('utf8');
  });
  proc.stderr.on('data', (d) => {
    logs += d.toString('utf8');
  });

  const targetUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      await stopServerProcess(proc);
      throw new Error(`Vite ${preview ? 'preview ' : ''}exited prematurely (${proc.exitCode}): ${logs}`);
    }
    if (await isAppServing(targetUrl, 1000)) {
      return {
        baseUrl: targetUrl,
        managed: true,
        preview,
        pid: proc.pid,
        close: () => stopServerProcess(proc),
      };
    }
    await new Promise((r) => setTimeout(r, 150));
  }

  await stopServerProcess(proc);
  throw new Error(`Timed out waiting for Vite server at ${targetUrl} after ${timeoutMs}ms: ${logs}`);
}

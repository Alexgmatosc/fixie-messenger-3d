/**
 * Opaque-box CLI discovery, isolated temp-dir converter execution,
 * build/tsc checks, and git state verification helpers.
 */
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { GIT_EXPECTATIONS, PATHS } from '../fixtures/madrid-fixtures.mjs';

const execFileAsync = promisify(execFile);

const activeTempDirs = new Set();
const cachedRuns = new Map();
let exitHookRegistered = false;

function registerExitCleanup() {
  if (exitHookRegistered) return;
  exitHookRegistered = true;
  const cleanupSync = () => {
    for (const dir of activeTempDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
    activeTempDirs.clear();
  };
  process.on('exit', cleanupSync);
}

export async function createCliTempDir(prefix = 'fixie-e2e-cli-') {
  registerExitCleanup();
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
  activeTempDirs.add(dir);
  return dir;
}

export async function removeCliTempDir(dir) {
  if (!dir) return;
  activeTempDirs.delete(dir);
  await fs.promises.rm(dir, { recursive: true, force: true });
}

export async function cleanupAllCliTempDirs() {
  cachedRuns.clear();
  const dirs = [...activeTempDirs];
  activeTempDirs.clear();
  await Promise.all(dirs.map((d) => fs.promises.rm(d, { recursive: true, force: true })));
}

export function spawnProcess(cmd, args, options = {}) {
  const { cwd = PATHS.repoRoot, timeoutMs = 120000, env = process.env } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill('SIGTERM');
            setTimeout(() => child.kill('SIGKILL'), 1500).unref();
          }, timeoutMs)
        : null;

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({
        exitCode: code ?? (signal ? 1 : 0),
        signal,
        timedOut,
        stdout,
        stderr,
      });
    });
  });
}

/**
 * Discovers the SLPK converter script (scripts/convert-slpk-chunks.mjs or .py)
 * and its package.json script entry without importing converter internals.
 */
export function discoverConverterCli(repoRoot = PATHS.repoRoot) {
  const mjsPath = path.join(repoRoot, 'scripts', 'convert-slpk-chunks.mjs');
  const pyPath = path.join(repoRoot, 'scripts', 'convert-slpk-chunks.py');

  let scriptPath = null;
  let runtime = null;
  if (fs.existsSync(mjsPath)) {
    scriptPath = mjsPath;
    runtime = process.execPath;
  } else if (fs.existsSync(pyPath)) {
    scriptPath = pyPath;
    runtime = 'python3';
  }

  let packageScriptName = null;
  let packageScriptCmd = null;
  const pkgPath = path.join(repoRoot, 'package.json');
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const scripts = pkg.scripts ?? {};
    for (const [name, cmd] of Object.entries(scripts)) {
      if (typeof cmd === 'string' && cmd.includes('convert-slpk-chunks')) {
        packageScriptName = name;
        packageScriptCmd = cmd;
        break;
      }
    }
  }

  return {
    found: Boolean(scriptPath),
    scriptPath,
    runtime,
    packageScriptName,
    packageScriptCmd,
  };
}

export function requireConverterCli(repoRoot = PATHS.repoRoot) {
  const cli = discoverConverterCli(repoRoot);
  assert.ok(
    cli.found,
    'Expected converter CLI at scripts/convert-slpk-chunks.mjs or scripts/convert-slpk-chunks.py'
  );
  return cli;
}

const helpCache = new Map();

export async function inspectConverterHelp(cli = requireConverterCli()) {
  if (helpCache.has(cli.scriptPath)) {
    return helpCache.get(cli.scriptPath);
  }
  const res = await spawnProcess(cli.runtime, [cli.scriptPath, '--help'], { timeoutMs: 15000 });
  const text = `${res.stdout}\n${res.stderr}`;
  const outFlag = text.includes('--out-dir')
    ? '--out-dir'
    : text.includes('--out')
      ? '--out'
      : '--out-dir';
  const inputFlag = text.includes('--slpk')
    ? '--slpk'
    : text.includes('--input')
      ? '--input'
      : '--slpk';

  const info = {
    exitCode: res.exitCode,
    helpText: text,
    hasBbox: text.includes('--bbox'),
    hasChunks: text.includes('--chunks'),
    outFlag,
    inputFlag,
  };
  helpCache.set(cli.scriptPath, info);
  return info;
}

/**
 * Runs the converter CLI into an isolated temporary output directory.
 * Caller is responsible for cleanup or using runConverterCached() / cleanupAllCliTempDirs().
 */
export async function runConverter(args, options = {}) {
  const cli = requireConverterCli(options.repoRoot);
  const help = await inspectConverterHelp(cli);
  const outDir = options.outDir ?? (await createCliTempDir('fixie-e2e-slpk-'));
  const includeOutDir = options.includeOutDir !== false;

  const fullArgs = [cli.scriptPath, ...args];
  if (includeOutDir) {
    fullArgs.push(help.outFlag, outDir);
  }

  const res = await spawnProcess(cli.runtime, fullArgs, {
    cwd: options.cwd ?? PATHS.repoRoot,
    timeoutMs: options.timeoutMs ?? 120000,
  });

  return {
    ...res,
    outDir,
    manifestPath: path.join(outDir, 'manifest.json'),
    cli,
    help,
  };
}

/**
 * Cached isolated converter run keyed by a deterministic cacheKey within a test process.
 * Always writes to os.tmpdir() and cleans up on cleanupAllCliTempDirs() / process exit.
 */
export async function runConverterCached(cacheKey, args, options = {}) {
  if (cachedRuns.has(cacheKey)) {
    return cachedRuns.get(cacheKey);
  }
  const promise = runConverter(args, options);
  cachedRuns.set(cacheKey, promise);
  return promise;
}

export async function runNpmBuild(repoRoot = PATHS.repoRoot) {
  return spawnProcess('npm', ['run', 'build'], { cwd: repoRoot, timeoutMs: 120000 });
}

export async function runTscNoEmit(repoRoot = PATHS.repoRoot) {
  const tscBin = path.join(repoRoot, 'node_modules', '.bin', 'tsc');
  return spawnProcess(tscBin, ['--noEmit'], { cwd: repoRoot, timeoutMs: 60000 });
}

export async function getGitState(repoRoot = PATHS.repoRoot) {
  const runGit = async (args) => {
    const { stdout } = await execFileAsync('git', args, { cwd: repoRoot });
    return stdout.trim();
  };

  const branch = await runGit(['rev-parse', '--abbrev-ref', 'HEAD']);
  const headSha = await runGit(['rev-parse', 'HEAD']);
  const mainSha = await runGit(['rev-parse', GIT_EXPECTATIONS.baseBranch]);
  let originMainSha = null;
  try {
    originMainSha = await runGit(['rev-parse', `origin/${GIT_EXPECTATIONS.baseBranch}`]);
  } catch {
    originMainSha = null;
  }
  const statusPorcelain = await runGit(['status', '--porcelain']);

  return {
    branch,
    headSha,
    mainSha,
    originMainSha,
    statusLines: statusPorcelain ? statusPorcelain.split('\n').filter(Boolean) : [],
  };
}

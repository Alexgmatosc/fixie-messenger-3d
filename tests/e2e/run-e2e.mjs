#!/usr/bin/env node
/**
 * Unified Opaque-Box E2E Test Runner for Madrid LoD2 SLPK Integration.
 *
 * Flags:
 *   --tier=1|2|3|4 (or comma-separated list, e.g. --tier=1,3; default: all)
 *   --browser=auto|required|off (default: auto)
 *   --headed (launch offscreen visible Chrome instead of --headless=new)
 *   --preview (test against ephemeral `vite preview` dist/ bundle)
 *   --allow-webgl-fallback (allow WebGL2 fallback if WebGPU adapter unavailable)
 *   --json (emit machine-readable JSON summary)
 *   --help
 */
import path from 'node:path';
import { run } from 'node:test';
import { fileURLToPath } from 'node:url';
import { MCP_FALLBACK_INSTRUCTIONS } from './helpers/cdp-browser.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TIER_FILES = new Map([
  ['1', { tier: 1, name: 'Tier 1 (Feature Coverage)', file: path.join(__dirname, 'tier1-feature-coverage.test.mjs') }],
  ['2', { tier: 2, name: 'Tier 2 (Boundary & Corner)', file: path.join(__dirname, 'tier2-boundary-corner.test.mjs') }],
  ['3', { tier: 3, name: 'Tier 3 (Cross-Feature)', file: path.join(__dirname, 'tier3-cross-feature.test.mjs') }],
  ['4', { tier: 4, name: 'Tier 4 (Real-World Madrid)', file: path.join(__dirname, 'tier4-real-world.test.mjs') }],
]);

function parseArgs(argv) {
  const opts = {
    tiers: ['1', '2', '3', '4'],
    browser: 'auto',
    headed: false,
    preview: false,
    allowWebglFallback: false,
    json: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else if (arg === '--headed') {
      opts.headed = true;
    } else if (arg === '--preview') {
      opts.preview = true;
    } else if (arg === '--allow-webgl-fallback') {
      opts.allowWebglFallback = true;
    } else if (arg === '--json') {
      opts.json = true;
    } else if (arg.startsWith('--tier=')) {
      opts.tiers = arg.slice('--tier='.length).split(',').map((s) => s.trim()).filter(Boolean);
    } else if (arg === '--tier' && argv[i + 1]) {
      opts.tiers = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    } else if (arg.startsWith('--browser=')) {
      opts.browser = arg.slice('--browser='.length).trim().toLowerCase();
    } else if (arg === '--browser') {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        opts.browser = argv[++i].trim().toLowerCase();
      } else {
        opts.browser = 'required';
      }
    } else {
      throw new Error(`Unknown CLI flag: ${arg}. Pass --help for usage.`);
    }
  }

  for (const t of opts.tiers) {
    if (!TIER_FILES.has(t)) {
      throw new Error(`Invalid tier "${t}". Valid tiers: 1, 2, 3, 4.`);
    }
  }
  if (!['auto', 'required', 'off'].includes(opts.browser)) {
    throw new Error(`Invalid --browser mode "${opts.browser}". Valid: auto, required, off.`);
  }
  return opts;
}

function printHelp() {
  console.log(`Usage: node tests/e2e/run-e2e.mjs [options]

Options:
  --tier=1|2|3|4           Select tier(s) to run (comma-separated, default: 1,2,3,4)
  --browser=auto|required|off
                           Browser WebGPU test mode (default: auto)
  --headed                 Launch offscreen headed Chrome instead of --headless=new
  --preview                Start ephemeral vite preview server for dist/ verification
  --allow-webgl-fallback   Allow WebGL2 fallback when WebGPU adapter is unavailable
  --json                   Output JSON report only
  --help                   Show this help message
`);
}

function formatError(err) {
  if (!err) return 'Unknown error';
  const cause = err.cause ? err.cause : err;
  return cause?.message || String(cause);
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }

  if (opts.help) {
    printHelp();
    process.exit(0);
  }

  process.env.E2E_BROWSER_MODE = opts.browser;
  process.env.E2E_HEADED = opts.headed ? '1' : '0';
  process.env.E2E_PREVIEW = opts.preview ? '1' : '0';
  process.env.E2E_ALLOW_WEBGL_FALLBACK = opts.allowWebglFallback ? '1' : '0';

  const selected = opts.tiers.map((t) => TIER_FILES.get(t));
  const files = selected.map((s) => s.file);

  const perFileStats = new Map();
  for (const s of selected) {
    perFileStats.set(path.resolve(s.file), {
      tier: s.tier,
      name: s.name,
      file: path.relative(process.cwd(), s.file),
      passed: 0,
      failed: 0,
      skipped: 0,
      failures: [],
      skipReasons: new Set(),
      hookErrors: [],
    });
  }

  const startedAt = Date.now();
  const stream = run({
    files,
    isolation: 'none',
    concurrency: false,
  });

  for await (const ev of stream) {
    const fileKey = ev.data?.file ? path.resolve(ev.data.file) : null;
    const stats = fileKey ? perFileStats.get(fileKey) : null;

    if (ev.type === 'test:pass' || ev.type === 'test:fail') {
      const isLeaf = ev.data.details?.type !== 'suite' && ev.data.nesting > 0;
      const isSkipped = ev.data.skip !== undefined && ev.data.skip !== false;

      if (isLeaf && stats) {
        if (isSkipped) {
          stats.skipped++;
          if (typeof ev.data.skip === 'string') {
            stats.skipReasons.add(ev.data.skip);
          }
          if (!opts.json) {
            console.log(`  [SKIP] ${ev.data.name}${typeof ev.data.skip === 'string' ? ` (${ev.data.skip})` : ''}`);
          }
        } else if (ev.type === 'test:pass') {
          stats.passed++;
          if (!opts.json) {
            console.log(`  [PASS] ${ev.data.name}`);
          }
        } else {
          stats.failed++;
          const msg = formatError(ev.data.details?.error);
          stats.failures.push({ name: ev.data.name, error: msg });
          if (!opts.json) {
            console.log(`  [FAIL] ${ev.data.name}\n         ${msg.replace(/\n/g, '\n         ')}`);
          }
        }
      } else if (!isLeaf && ev.type === 'test:fail' && stats) {
        // Suite or hook failure (e.g., before() hook failed when --browser=required)
        const msg = formatError(ev.data.details?.error);
        stats.hookErrors.push({ name: ev.data.name, error: msg });
        if (!opts.json) {
          console.error(`  [HOOK FAIL] ${ev.data.name}: ${msg}`);
        }
      }
    }
  }

  const durationMs = Date.now() - startedAt;
  const tiersSummary = [...perFileStats.values()].map((s) => ({
    tier: s.tier,
    name: s.name,
    file: s.file,
    passed: s.passed,
    failed: s.failed,
    skipped: s.skipped,
    total: s.passed + s.failed + s.skipped,
    hookErrors: s.hookErrors,
    failures: s.failures,
    skipReasons: [...s.skipReasons],
  }));

  const totals = tiersSummary.reduce(
    (acc, t) => {
      acc.passed += t.passed;
      acc.failed += t.failed;
      acc.skipped += t.skipped;
      acc.total += t.total;
      acc.hookErrors += t.hookErrors.length;
      return acc;
    },
    { passed: 0, failed: 0, skipped: 0, total: 0, hookErrors: 0 }
  );

  const anyBrowserSkip = tiersSummary.some((t) => t.skipped > 0);
  const exitCode = totals.failed === 0 && totals.hookErrors === 0 ? 0 : 1;

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          ok: exitCode === 0,
          durationMs,
          options: opts,
          totals,
          tiers: tiersSummary,
          mcpFallback: anyBrowserSkip ? MCP_FALLBACK_INSTRUCTIONS : null,
        },
        null,
        2
      )
    );
  } else {
    console.log('\n=== E2E Summary ===');
    for (const t of tiersSummary) {
      console.log(
        `${t.name.padEnd(28)} pass=${String(t.passed).padStart(3)}  fail=${String(t.failed).padStart(3)}  skip=${String(t.skipped).padStart(3)}  total=${String(t.total).padStart(3)}`
      );
    }
    console.log(
      `TOTAL                        pass=${String(totals.passed).padStart(3)}  fail=${String(totals.failed).padStart(3)}  skip=${String(totals.skipped).padStart(3)}  total=${String(totals.total).padStart(3)}  (${(durationMs / 1000).toFixed(2)}s)`
    );
    if (anyBrowserSkip) {
      console.log(`\n${MCP_FALLBACK_INSTRUCTIONS}`);
    }
  }

  process.exit(exitCode);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

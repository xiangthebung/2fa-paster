/**
 * The browser checks: `npm run test:browser`.
 *
 * Separate from `npm test` because it needs a browser on the machine and a built
 * `dist/`, and `npm test` is meant to stay a pure, instant, dependency-free run.
 * Both are wired into `npm run verify`, which builds in between.
 *
 * No Chrome is a skip, not a failure. The whole suite would otherwise become
 * unrunnable on a machine that can still legitimately work on the scoring, the
 * parsing and the storage rules. A skip prints loudly enough that nobody mistakes
 * it for a pass.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { findChrome, open, reporter, root } from './harness.mjs';
import { run as runContentChecks } from './content.checks.mjs';
import { run as runUiChecks } from './ui.checks.mjs';

const chrome = findChrome();
if (!chrome) {
  console.log(
    'browser checks skipped: no Chrome found.\n' +
      '  These cover content.js — which field gets filled, which button gets pressed —\n' +
      '  and the popup and options layout. Nothing else covers them.\n' +
      '  Set CHROME_PATH to a Chrome or Chromium binary to run them.',
  );
  process.exit(0);
}

if (!existsSync(path.join(root, 'dist', 'content.js'))) {
  console.error('browser checks need a build: run `npm run build` first (they drive dist/, not the source).');
  process.exit(1);
}

console.log(`browser checks, using ${chrome}\n`);

const report = reporter();
const { page, close } = await open();

try {
  await runContentChecks(page, report);
  await runUiChecks(page, report);
} finally {
  await close();
}

if (report.failures.length > 0) {
  console.error(`${report.passed} passed, ${report.failures.length} FAILED:\n`);
  for (const failure of report.failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`browser checks: ${report.passed} passed`);

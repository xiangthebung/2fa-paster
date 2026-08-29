/**
 * The README, checked against the code.
 *
 * Most of a README cannot be tested, and should not be — the parts explaining why
 * a thing is the way it is are the parts worth having. But a README also carries
 * facts, and facts of exactly the kind that go stale without anyone noticing: a
 * default that changed, a command that was renamed, a file that moved, a threshold
 * that was tuned. Nothing fails when those drift. A reader simply follows the
 * instructions and gets a different result from the one described.
 *
 * So the mechanical half is mechanical. What is deliberately not checked here:
 * anything about how the extension reads, feels, or looks, and anything that would
 * need a Gmail account. Those are named in the README itself as unverified rather
 * than quietly counted as covered.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { AUTO_FILL_CONFIDENCE } from '../code-finder.js';
import { DEFAULTS, SOURCES } from '../settings.js';

const root = path.resolve(import.meta.dirname, '..');
const read = (name) => readFileSync(path.join(root, name), 'utf8');

const readme = read('README.md');
const pkg = JSON.parse(read('package.json'));
const manifest = JSON.parse(read('manifest.json'));

test('every command the README gives can actually be run', () => {
  const named = new Set(
    [...readme.matchAll(/\bnpm run ([\w:]+)/g)].map((match) => match[1]),
  );
  assert.ok(named.size >= 5, `expected the README to list the commands, found ${[...named]}`);
  for (const script of named) {
    assert.ok(pkg.scripts[script], `README says "npm run ${script}", which package.json does not define`);
  }

  // And the other way: a command nobody documents is one nobody uses.
  for (const script of Object.keys(pkg.scripts)) {
    assert.ok(
      named.has(script) || script === 'test',
      `package.json defines "${script}", which the README does not mention`,
    );
  }
});

test('every file the README points at exists', () => {
  const named = [...readme.matchAll(/`((?:[\w-]+\/)*[\w.-]+\.(?:js|mjs|json|md|svg))`/g)].map(
    (match) => match[1],
  );
  assert.ok(named.length >= 8, `expected the README to name files, found ${named}`);
  for (const name of new Set(named)) {
    // `client-id.local` and friends are created by the reader, not shipped.
    if (name.endsWith('.local')) continue;
    assert.ok(existsSync(path.join(root, name)), `README points at ${name}, which does not exist`);
  }
});

test('every internal link in the README lands somewhere', () => {
  const anchors = new Set([
    ...[...readme.matchAll(/<a id="([\w-]+)"><\/a>/g)].map((match) => match[1]),
    // GitHub's slug for a heading: lower-cased, spaces to dashes, punctuation gone.
    ...[...readme.matchAll(/^#{2,4} (.+)$/gm)].map((match) =>
      match[1]
        .toLowerCase()
        .replace(/[^\w\s-]/g, '')
        .trim()
        .replace(/\s+/g, '-'),
    ),
  ]);

  for (const [, target] of readme.matchAll(/\]\(#([\w-]+)\)/g)) {
    assert.ok(anchors.has(target), `README links to #${target}, which is not a heading or anchor in it`);
  }
});

test('the settings table states the defaults the code actually has', () => {
  // The table is the most-read part of the README and the most quietly wrong when
  // a default is tuned. Each row is bound to the setting it describes; renaming a
  // row fails here, which is the intent.
  const expected = [
    ['How it reads your mail', DEFAULTS.source === SOURCES.feed ? 'Inbox preview' : 'Full messages'],
    ['Ignore codes older than', `${DEFAULTS.freshnessMinutes} minutes`],
    ['Also copy to the clipboard', DEFAULTS.autoCopy ? 'On' : 'Off'],
    ['Submit the form after filling', DEFAULTS.autoSubmit ? '**On**' : '**Off**'],
    ['Confirm it on the page', DEFAULTS.inPageToast ? 'On' : 'Off'],
    ['Keep recent codes for', `${DEFAULTS.historyMinutes} minutes`],
    ['Show a desktop notification', DEFAULTS.notify ? 'On' : 'Off'],
    ['Wipe the clipboard after', DEFAULTS.clipboardClearSeconds === 0 ? 'Never' : `${DEFAULTS.clipboardClearSeconds} seconds`],
    ['Fall back to all recent mail', DEFAULTS.scanAllRecentMail ? 'On' : 'Off'],
    ['Extra search terms', DEFAULTS.extraQuery === '' ? 'empty' : DEFAULTS.extraQuery],
  ];

  const rows = new Map(
    [...readme.matchAll(/^\| ([^|]+?) \| ([^|]+?) \|/gm)].map((match) => [match[1].trim(), match[2].trim()]),
  );

  for (const [label, value] of expected) {
    assert.ok(rows.has(label), `the settings table has no row called "${label}"`);
    assert.equal(rows.get(label), value, `the README says "${label}" defaults to "${rows.get(label)}"`);
  }
});

test('the numbers the README quotes are the numbers in the code', () => {
  const confidence = readme.match(/confidence score of (\d+) or better/);
  assert.ok(confidence, 'the README no longer states the automatic-fill threshold');
  assert.equal(Number(confidence[1]), AUTO_FILL_CONFIDENCE);

  assert.match(
    readme,
    /two-minute inbox watch/,
    'the README no longer describes the watch length',
  );
  assert.equal(DEFAULTS.watchSeconds, 120, 'the watch is no longer two minutes, so the README is wrong');

  const half = readme.match(/arrived in the last (half hour|\d+ minutes)/);
  assert.ok(half, 'the README no longer says how long the recent list keeps things');
  assert.equal(DEFAULTS.historyMinutes, 30, 'the recent list is no longer half an hour');
});

test('the keyboard shortcut the README names is the one the manifest asks for', () => {
  const stated = readme.match(/`(Ctrl\+Shift\+\d)` by default/);
  assert.ok(stated, 'the README no longer names the default shortcut');
  assert.equal(stated[1], manifest.commands['paste-code'].suggested_key.default);
});

test('every badge the README explains is one the worker sets', () => {
  const background = read('background.js');
  const table = readme.match(/\| Badge \| Meaning \|\n\|[^\n]*\n((?:\|[^\n]*\n)+)/);
  assert.ok(table, 'the badge table is gone from the README');

  const badges = [...table[1].matchAll(/^\| `(.+?)` \|/gm)].map((match) => match[1]);
  assert.ok(badges.length >= 5, `expected the badge table to have rows, found ${badges}`);

  // Every short string literal on a line that sets a badge. Read this way rather
  // than as `Badge('x'` because the success case picks its glyph with a ternary,
  // and a check that only saw the direct calls would miss the two most common
  // badges a user ever sees.
  const set = new Set();
  for (const line of background.split('\n')) {
    // No `\b` before Badge: in `setBadge(` there is no word boundary between the
    // `t` and the `B`, so anchoring it there matches nothing at all.
    if (!/Badge\(/.test(line)) continue;
    // Colours and the empty "clear the badge" string come out first. Leaving the
    // empty one in is not harmless: its closing quote pairs with the opening quote
    // of the colour after it, and the scan reports a badge of ", ".
    const cleaned = line.replace(/'#[0-9a-fA-F]{3,8}'/g, '').replace(/''/g, '');
    for (const [, literal] of cleaned.matchAll(/'([^']{1,4})'/g)) set.add(literal);
  }
  assert.ok(set.size >= 5, `expected to find the badges background.js sets, found ${[...set]}`);

  for (const badge of badges) {
    assert.ok(set.has(badge), `the README explains a "${badge}" badge that background.js never sets`);
  }
  // And the other direction, which is the one that leaves somebody staring at a
  // symbol with nowhere to look it up.
  for (const badge of set) {
    assert.ok(badges.includes(badge), `background.js sets a "${badge}" badge the README does not explain`);
  }
});

/**
 * Checks the seams between files that nothing else can check.
 *
 * The UI, the service worker and the injected script only meet at runtime, and
 * they meet through strings: an element id, a message type, a filename in the
 * build's allowlist. Rename one end and the other end fails silently — a popup
 * button that does nothing, a fill request nobody answers — with no error
 * anywhere a test would see it.
 *
 * So this reads the sources and matches the strings up. It is not a substitute
 * for loading the extension, but it catches the whole class of typo that survives
 * a passing test run.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { SITE_ORIGINS } from '../settings.js';

const root = path.resolve(import.meta.dirname, '..');
const read = (name) => readFileSync(path.join(root, name), 'utf8');

const sources = {
  background: read('background.js'),
  content: read('content.js'),
  offscreen: read('offscreen.js'),
  popupJs: read('popup.js'),
  popupHtml: read('popup.html'),
  popupCss: read('popup.css'),
  optionsJs: read('options.js'),
  optionsHtml: read('options.html'),
  optionsCss: read('options.css'),
  build: read('scripts/build.mjs'),
  manifest: JSON.parse(read('manifest.json')),
};

const matchAll = (source, pattern) => [...source.matchAll(pattern)].map((match) => match[1]);
const unique = (values) => [...new Set(values)];

/** Ids the page defines. */
const idsIn = (html) => new Set(matchAll(html, /\bid="([^"]+)"/g));
/** Ids the script looks up through the `$` helper. */
const lookupsIn = (js) => unique(matchAll(js, /\$\('([\w-]+)'\)/g));

test('every element the popup script looks up exists in popup.html', () => {
  const ids = idsIn(sources.popupHtml);
  const missing = lookupsIn(sources.popupJs).filter((id) => !ids.has(id));
  assert.deepEqual(missing, [], `popup.js looks up ids that popup.html does not define: ${missing}`);
});

test('every element the options script looks up exists in options.html', () => {
  const ids = idsIn(sources.optionsHtml);
  const missing = lookupsIn(sources.optionsJs).filter((id) => !ids.has(id));
  assert.deepEqual(missing, [], `options.js looks up ids that options.html does not define: ${missing}`);
});

test('every label points at a control that exists', () => {
  for (const [name, html] of [
    ['popup.html', sources.popupHtml],
    ['options.html', sources.optionsHtml],
  ]) {
    const ids = idsIn(html);
    for (const target of matchAll(html, /<label[^>]*\bfor="([^"]+)"/g)) {
      assert.ok(ids.has(target), `${name}: <label for="${target}"> has no matching element`);
    }
    for (const target of matchAll(html, /aria-labelledby="([^"]+)"/g)) {
      for (const id of target.split(/\s+/)) {
        assert.ok(ids.has(id), `${name}: aria-labelledby="${id}" has no matching element`);
      }
    }
  }
});

test('the switch is operated by clicking the switch, not only its label', () => {
  // A checkbox hidden under its own decoration is the worst kind of broken
  // control: it looks right, the label still works, and nothing anywhere throws.
  //
  // `.switch input` and `.switch-track` are both `position: absolute; inset: 0`
  // over the same box. The track comes second in the DOM, so without either a
  // z-index or `pointer-events: none` it paints on top and eats the click. No
  // amount of dispatching events at the input from a test can see this — hit
  // testing needs a real layout — so the rule itself is what gets checked.
  for (const [name, css] of [
    ['popup.css', sources.popupCss],
    ['options.css', sources.optionsCss],
  ]) {
    const rule = css.match(/\.switch-track\s*\{([^}]*)\}/);
    assert.ok(rule, `${name}: could not find the .switch-track rule`);
    assert.ok(
      /pointer-events:\s*none/.test(rule[1]) || /z-index/.test(rule[1]),
      `${name}: .switch-track covers the checkbox, so it needs "pointer-events: none" ` +
        'or the switch will only respond to clicks on its label',
    );
  }
});

/** The keys of the `handlers` object in background.js. */
function backgroundHandlers() {
  const block = sources.background.match(/const handlers = \{([\s\S]*?)\n\};/);
  assert.ok(block, 'could not find the handlers object in background.js');
  return new Set(matchAll(block[1], /^ {2}async\s+'?([\w-]+)'?\s*\(/gm));
}

test('every message the UI sends has a handler in the service worker', () => {
  const handlers = backgroundHandlers();
  // Sanity check on the extraction itself, so a regex that matches nothing
  // cannot make this test vacuously pass.
  assert.ok(handlers.size >= 8, `expected to find the handlers, found ${[...handlers]}`);

  for (const [name, js] of [
    ['popup.js', sources.popupJs],
    ['options.js', sources.optionsJs],
  ]) {
    for (const type of unique(matchAll(js, /\bsend\(\s*'([\w-]+)'/g))) {
      assert.ok(handlers.has(type), `${name} sends "${type}", which background.js does not handle`);
    }
  }
});

test('the service worker handles the message the injected script sends', () => {
  const sent = unique(matchAll(sources.content, /sendMessage\(\{\s*type:\s*'([\w-]+)'/g));
  assert.deepEqual(sent, ['code-field-seen']);
  for (const type of sent) {
    assert.ok(
      sources.background.includes(`'${type}'`),
      `content.js sends "${type}", which background.js does not mention`,
    );
  }
});

test('the injected script handles every message the service worker sends it', () => {
  const sent = unique(matchAll(sources.background, /sendMessage\(\s*\w+,\s*\{\s*type:\s*'([\w-]+)'/g));
  assert.deepEqual(sent.sort(), ['fill-code', 'has-code-field']);
  for (const type of sent) {
    assert.ok(
      sources.content.includes(`=== '${type}'`),
      `background.js sends "${type}" to the page, which content.js does not handle`,
    );
  }
});

test('the clipboard document and its caller agree on the message shape', () => {
  assert.match(sources.background, /target:\s*'offscreen-clipboard'/);
  assert.match(sources.offscreen, /target\s*!==\s*'offscreen-clipboard'/);
  assert.match(sources.background, /type:\s*'copy'/);
  assert.match(sources.offscreen, /type === 'copy'/);
});

/** The build's shipping allowlist. */
function runtimeFiles() {
  const block = sources.build.match(/const RUNTIME_FILES = \[([\s\S]*?)\n\];/);
  assert.ok(block, 'could not find RUNTIME_FILES in scripts/build.mjs');
  return new Set(matchAll(block[1], /'([^']+)'/g));
}

test('every runtime asset is on the build allowlist', () => {
  const listed = runtimeFiles();
  assert.ok(listed.size > 10, `expected to find the allowlist, found ${[...listed]}`);

  const shippable = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(js|css|html)$/.test(entry.name))
    .map((entry) => entry.name);

  for (const name of shippable) {
    assert.ok(listed.has(name), `${name} is not in RUNTIME_FILES, so it will not be shipped`);
  }
  for (const name of readdirSync(path.join(root, 'icons'))) {
    assert.ok(listed.has(`icons/${name}`), `icons/${name} is not in RUNTIME_FILES`);
  }
});

test('the manifest asks for exactly the permissions the code uses', () => {
  const { manifest } = sources;
  const all = [
    sources.background,
    sources.popupJs,
    sources.optionsJs,
    sources.content,
    sources.offscreen,
    read('auth.js'),
    read('gmail.js'),
    read('inbox-feed.js'),
    read('settings.js'),
  ].join('\n');

  // Each permission has to be justified by a call that needs it, so the list
  // cannot quietly grow past what the extension actually does.
  const justification = {
    identity: /chrome\.identity\./,
    storage: /chrome\.storage\./,
    scripting: /chrome\.scripting\./,
    alarms: /chrome\.alarms\./,
    notifications: /chrome\.notifications\./,
    offscreen: /chrome\.offscreen\./,
    clipboardWrite: /execCommand\('copy'\)/,
    activeTab: /chrome\.scripting\.executeScript/,
  };

  for (const permission of manifest.permissions) {
    const pattern = justification[permission];
    assert.ok(pattern, `manifest asks for "${permission}" but nothing here explains why`);
    assert.match(all, pattern, `manifest asks for "${permission}" but no code uses it`);
  }

  assert.deepEqual(manifest.oauth2.scopes, ['https://www.googleapis.com/auth/gmail.readonly']);

  // Broad site access must stay optional: the manual path works without it, and
  // the patterns must match SITE_ORIGINS or the grant would be requested and
  // then never recognised.
  assert.deepEqual(manifest.optional_host_permissions, SITE_ORIGINS);
  for (const pattern of manifest.host_permissions) {
    assert.ok(
      pattern.startsWith('https://') && !pattern.includes('*.'),
      `host_permissions should name exact hosts, found "${pattern}"`,
    );
  }
});

test('every Google host the code calls is permitted and allowed by the CSP', () => {
  const csp = sources.manifest.content_security_policy.extension_pages;

  // `https://www.googleapis.com/auth/...` is an OAuth scope name handed to
  // chrome.identity, not an address anything connects to, so it is excluded.
  const called = unique(
    matchAll(
      [sources.background, read('gmail.js'), read('auth.js'), read('inbox-feed.js')].join('\n'),
      /https:\/\/((?:[\w.]+\.googleapis\.com|mail\.google\.com))(?!\/auth\/)/g,
    ),
  );
  assert.deepEqual(called.sort(), ['gmail.googleapis.com', 'mail.google.com', 'oauth2.googleapis.com']);

  for (const host of called) {
    assert.ok(csp.includes(host), `code calls ${host}, which the CSP does not allow`);
    assert.ok(
      sources.manifest.host_permissions.some((pattern) => pattern.includes(host)),
      `code calls ${host}, which is not in host_permissions`,
    );
  }
});

test('the inbox feed is reachable without any optional permission', () => {
  // The whole point of the default source is that it works on install. If the
  // Gmail host ever moved to optional_host_permissions, the no-setup promise
  // would quietly become a permission prompt.
  assert.ok(
    sources.manifest.host_permissions.some((pattern) => pattern.startsWith('https://mail.google.com/')),
    'mail.google.com must be a required host permission',
  );
  assert.ok(
    !sources.manifest.optional_host_permissions.some((pattern) => pattern.includes('mail.google.com')),
  );
});

test('the default source is the one that needs no setup', async () => {
  const { DEFAULTS, SOURCES } = await import('../settings.js');
  assert.equal(DEFAULTS.source, SOURCES.feed);
});

test('manifest and package versions stay in step', () => {
  assert.equal(sources.manifest.version, JSON.parse(read('package.json')).version);
});

test('the committed manifest keeps its client-ID placeholder', () => {
  // The real value is injected at build time from a git-ignored file. If it ever
  // lands here, it has been committed by accident.
  assert.match(sources.manifest.oauth2.client_id, /^REPLACE_WITH/);
});

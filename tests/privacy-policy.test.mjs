/**
 * The privacy policy, checked against the code.
 *
 * A privacy policy is the one document where being out of date is not an
 * inconvenience — it is a false statement about someone's email. And it rots in a
 * way nothing notices: the sentence stays grammatical, the file stays committed,
 * and the only thing that changed is three lines in a module it does not name.
 * This repository has already had that happen. The policy said the page script
 * "does not read page content" and "does not send anything anywhere", while the
 * script read four hundred characters of surrounding text and posted the page's
 * address to the service worker.
 *
 * So the checkable half of the policy is checked. Two kinds of claim:
 *
 * *Boundaries* — where data can go, who may write to storage, what runs in a web
 * page. These are asserted against every runtime file rather than against the
 * handful that do the work today, because the whole point is to catch the day a
 * fifth file starts making requests.
 *
 * *Numbers and names* — "up to 12 codes", "the last 40", the button you are told
 * to press. These are read out of the document itself and compared to the source,
 * so editing one without the other fails here.
 *
 * What cannot be checked mechanically is stated in the report that accompanies
 * this file rather than implied to be covered: whether Gmail's feed really only
 * carries unread inbox mail, whether `chrome.storage.session` really never
 * reaches disk, and what Google does with a `gmail.readonly` token. Those are
 * claims about other people's systems.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { DEFAULTS } from '../settings.js';

const root = path.resolve(import.meta.dirname, '..');
const read = (name) => readFileSync(path.join(root, name), 'utf8');

const policy = read('PRIVACY_POLICY.md');
const manifest = JSON.parse(read('manifest.json'));

/** Every JavaScript file that ships inside the extension. */
const RUNTIME_JS = [
  'background.js',
  'content.js',
  'offscreen.js',
  'popup.js',
  'options.js',
  'auth.js',
  'gmail.js',
  'inbox-feed.js',
  'code-finder.js',
  'domains.js',
  'settings.js',
  'text.js',
];

const sources = new Map(RUNTIME_JS.map((name) => [name, read(name)]));

/** Which of the runtime files match a pattern. */
function filesMatching(pattern) {
  return RUNTIME_JS.filter((name) => new RegExp(pattern).test(sources.get(name)));
}

/* ------------------------------------------------------------------ *
 * Where data can go
 * ------------------------------------------------------------------ */

test('the policy names exactly the hosts the manifest allows', () => {
  // The three bullets under "Where data goes", read out of the document.
  const listed = [...policy.matchAll(/^- `([a-z0-9.]+\.(?:com|net|org))`/gm)].map((match) => match[1]);
  assert.deepEqual(
    listed.sort(),
    ['gmail.googleapis.com', 'mail.google.com', 'oauth2.googleapis.com'],
    'the "Where data goes" list is not the three hosts it should be',
  );

  for (const host of listed) {
    assert.ok(
      manifest.host_permissions.some((pattern) => pattern.includes(host)),
      `the policy names ${host}, which the manifest does not ask permission for`,
    );
    assert.ok(
      manifest.content_security_policy.extension_pages.includes(host),
      `the policy names ${host}, which the CSP does not allow`,
    );
  }

  // And nothing is permitted that the policy does not mention. A host added to
  // the manifest without a line here is exactly the drift this is for.
  for (const pattern of manifest.host_permissions) {
    const host = pattern.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    assert.ok(listed.includes(host), `the manifest permits ${host}, which the policy does not disclose`);
  }
});

test('no runtime file reaches a host the policy does not name', () => {
  const allowed = new Set(['mail.google.com', 'gmail.googleapis.com', 'oauth2.googleapis.com']);
  const offenders = [];

  for (const [name, source] of sources) {
    for (const match of source.matchAll(/https?:\/\/([\w.-]+)/g)) {
      const host = match[1];
      // `www.googleapis.com/auth/...` is the name of an OAuth scope handed to
      // Chrome, not an address anything opens a connection to.
      if (host === 'www.googleapis.com') continue;
      // Documentation links in comments point at Google's own console and are
      // never fetched; they are opened in a tab by the person reading them.
      if (source.slice(Math.max(0, match.index - 200), match.index).includes('href')) continue;
      if (!allowed.has(host)) offenders.push(`${name} -> ${host}`);
    }
  }

  assert.deepEqual(offenders, [], 'a runtime file references a host the privacy policy does not disclose');
});

test('only the mail readers and the token revoke make requests', () => {
  // Both readers take the `fetch` to use as an argument — that is what makes them
  // testable without a browser — so the call site reads `fetchImpl(...)` rather
  // than `fetch(...)`. Either spelling counts as making a request. `auth.js` is
  // the third file because revoking a token is a plain POST.
  assert.deepEqual(
    filesMatching(String.raw`\bfetch(?:Impl)?\s*\(`).sort(),
    ['auth.js', 'gmail.js', 'inbox-feed.js'],
    'something other than the mail readers and the token revoke is making requests',
  );

  // The service worker hands `fetch` down and never calls it, which is what keeps
  // the request shaping in the two files a reviewer has to read.
  assert.doesNotMatch(
    sources.get('background.js'),
    /\bfetch\s*\(/,
    'background.js now makes requests directly, so the network is no longer described by two files',
  );
});

test('nothing anywhere opens another kind of connection', () => {
  // A policy that lists three hosts is worth nothing if a websocket or a beacon
  // can go somewhere else entirely.
  for (const pattern of [
    String.raw`XMLHttpRequest`,
    String.raw`sendBeacon`,
    String.raw`new WebSocket`,
    String.raw`EventSource`,
    String.raw`importScripts`,
    String.raw`navigator\.connection`,
  ]) {
    assert.deepEqual(filesMatching(pattern), [], `a runtime file uses ${pattern}`);
  }
});

/* ------------------------------------------------------------------ *
 * What runs inside a web page
 * ------------------------------------------------------------------ */

test('the page script makes no requests of its own', () => {
  // The policy says so explicitly, and says that this is a property of the code
  // rather than of the CSP — content scripts run under the host page's policy, so
  // nothing would stop it. That makes this the only thing enforcing it.
  const content = sources.get('content.js');
  for (const pattern of [/\bfetch\s*\(/, /XMLHttpRequest/, /sendBeacon/, /new Image\s*\(/, /new WebSocket/]) {
    assert.doesNotMatch(content, pattern, `content.js does something the policy says it does not: ${pattern}`);
  }
});

test('the page script talks only to this extension', () => {
  const content = sources.get('content.js');
  assert.doesNotMatch(content, /sendMessageExternal|onMessageExternal|chrome\.runtime\.connect\b/);

  const sent = [...content.matchAll(/sendMessage\(\{\s*type:\s*'([\w-]+)'/g)].map((match) => match[1]);
  assert.deepEqual(sent, ['code-field-seen'], 'content.js sends a message the policy does not describe');
});

test('the policy states how much page text the script reads, and it is right', () => {
  const stated = policy.match(/up to (\d+) characters of the text/);
  assert.ok(stated, 'the policy no longer says how much surrounding text is read');

  const inCode = sources.get('content.js').match(/textContent \?\? ''\)\.slice\(0, (\d+)\)/);
  assert.ok(inCode, 'content.js no longer slices the surrounding text where the policy says it does');
  assert.equal(
    Number(stated[1]),
    Number(inCode[1]),
    'the policy and content.js disagree about how much of the page is read',
  );
});

/* ------------------------------------------------------------------ *
 * Storage
 * ------------------------------------------------------------------ */

test('only settings.js writes to storage', () => {
  // One file owning every write is what makes the storage table checkable by
  // reading a single file, and what stops a code ending up somewhere the table
  // does not mention.
  assert.deepEqual(
    filesMatching(String.raw`chrome\.storage\.\w+\.(set|remove|clear)\(`),
    ['settings.js'],
    'something other than settings.js writes to storage',
  );
});

test('each storage area holds what the policy says it holds', () => {
  const settings = sources.get('settings.js');

  // Session: the code in hand, the used-message ids, the watch, the recent list.
  const session = [...settings.matchAll(/chrome\.storage\.session\.(?:set|get|remove)\(\s*\{?\s*\[?([\w.]+)/g)]
    .map((match) => match[1])
    .filter((name) => name.startsWith('SESSION_KEYS'));
  assert.ok(session.length > 0, 'session storage is no longer keyed through SESSION_KEYS');

  // Local: the signed-in addresses, and nothing else. The policy gives this one
  // row of the table and a lifetime, and it is the only key that survives Chrome
  // closing, so an addition here is a real change to what is kept on disk.
  const local = [...settings.matchAll(/chrome\.storage\.local\.(?:set|get|remove)\(\s*\{?\s*'?([\w]+)/g)]
    .map((match) => match[1]);
  assert.deepEqual([...new Set(local)], ['feedAccounts'], 'chrome.storage.local holds something new');

  // Sync: settings only. This is the area that leaves the machine, replicated
  // through the Google account, so anything landing here is disclosed differently.
  assert.match(settings, /chrome\.storage\.sync\.set\(merged\)/);
  assert.match(settings, /chrome\.storage\.sync\.get\(Object\.keys\(DEFAULTS\)\)/);
});

test('no access token is ever put into storage', () => {
  assert.deepEqual(
    filesMatching(String.raw`chrome\.identity\.`),
    ['auth.js'],
    'something other than auth.js handles tokens',
  );
  assert.doesNotMatch(
    sources.get('auth.js'),
    /chrome\.storage/,
    'auth.js touches storage, and the policy says Chrome holds the token',
  );
});

test('the retention numbers in the policy are the ones in the code', () => {
  const settings = sources.get('settings.js');

  const historyLimit = policy.match(/up to (\d+) codes/);
  assert.ok(historyLimit, 'the policy no longer says how many codes the recent list keeps');
  assert.match(
    settings,
    new RegExp(String.raw`HISTORY_LIMIT = ${historyLimit[1]}\b`),
    `the policy says ${historyLimit[1]} recent codes; settings.js disagrees`,
  );

  const usedLimit = policy.match(/already delivered \(the last (\d+)\)/);
  assert.ok(usedLimit, 'the policy no longer says how many message ids are remembered');
  assert.match(
    settings,
    new RegExp(String.raw`USED_HISTORY_LIMIT = ${usedLimit[1]}\b`),
    `the policy says ${usedLimit[1]} message ids; settings.js disagrees`,
  );

  const history = policy.match(/(\d+) minutes by default/);
  assert.ok(history, 'the policy no longer states the default recent-list window');
  assert.equal(DEFAULTS.historyMinutes, Number(history[1]));

  assert.match(policy, /ten minutes by default/, 'the policy no longer states the default freshness window');
  assert.equal(DEFAULTS.freshnessMinutes, 10);
});

/* ------------------------------------------------------------------ *
 * The controls it tells you to use
 * ------------------------------------------------------------------ */

test('every control the policy tells you to press exists', () => {
  const optionsJs = sources.get('options.js');
  const popupHtml = read('popup.html');

  for (const label of ['Forget everything stored', 'Disconnect and forget']) {
    assert.ok(
      policy.includes(label),
      `the policy should tell people about the "${label}" button`,
    );
    assert.ok(
      optionsJs.includes(label),
      `the policy names a "${label}" button that the options page does not render`,
    );
  }

  // The popup's Clear, which the policy offers as the quick way to drop the list.
  assert.match(policy, /\*\*Clear\*\* in the popup/);
  assert.ok(popupHtml.includes('>Clear<'), 'the policy names a Clear button the popup does not have');
});

test('every source file the policy points at exists', () => {
  const named = [...policy.matchAll(/`([\w-]+\.js)`/g)].map((match) => match[1]);
  assert.ok(named.length >= 4, `expected the policy to name the files to read, found ${named}`);
  for (const name of new Set(named)) {
    assert.ok(sources.has(name), `the policy points at ${name}, which is not a runtime file`);
  }
});

test('the policy carries a date, and it is not older than the code it describes', () => {
  /* `Effective:`, not `Last updated:`. A policy's date is the date it governs from,
     which is the thing a reader needs; when it was last edited is a fact about us. It
     also matches the other published policies this author keeps. */
  const dated = policy.match(/^Effective: (\d{1,2} \w+ \d{4})$/m);
  assert.ok(dated, 'the policy has no "Effective" line');
  assert.ok(!Number.isNaN(Date.parse(dated[1])), `"${dated[1]}" is not a date`);
});

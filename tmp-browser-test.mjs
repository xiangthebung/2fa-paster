/**
 * Throwaway: drives the real popup in real Chrome over the DevTools Protocol.
 *
 * The two bugs that got through my JS-only harness were a hit-testing failure (a
 * decorative span painted over the checkbox) and a layout shift. Neither is visible
 * without a layout engine. So: serve the popup over http, inject a fake `chrome`
 * before its modules run, and then ask the browser the questions only it can answer
 * — what is at these coordinates, and did anything move.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const PORT = 8731;
const CDP = 'http://127.0.0.1:9222';
const root = process.cwd();

const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const server = createServer(async (req, res) => {
  const name = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'popup.html';
  const file = path.join(root, name);
  if (!file.startsWith(root)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' }).end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

/* ---------------------------------------------------------------- *
 * A very small CDP client
 * ---------------------------------------------------------------- */

const browser = await (await fetch(`${CDP}/json/version`)).json();
const socket = new WebSocket(browser.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});

let nextId = 1;
const pending = new Map();
const events = [];

socket.addEventListener('message', (message) => {
  const frame = JSON.parse(message.data);
  if (frame.id && pending.has(frame.id)) {
    const { resolve, reject } = pending.get(frame.id);
    pending.delete(frame.id);
    if (frame.error) reject(new Error(`${frame.error.message} (${JSON.stringify(frame.error.data ?? '')})`));
    else resolve(frame.result);
    return;
  }
  if (frame.method) events.push(frame);
});

function call(method, params = {}, sessionId) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`${method} timed out`));
    }, 15000);
  });
}

const { targetId } = await call('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true });

const send = (method, params) => call(method, params, sessionId);

await send('Page.enable');
await send('Runtime.enable');
await send('Log.enable');
// The popup's own width, so wrapping and every measurement below match reality.
await send('Emulation.setDeviceMetricsOverride', {
  width: 380,
  height: 640,
  deviceScaleFactor: 1,
  mobile: false,
});

/** Evaluate an expression in the page and return its value. */
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    throw new Error(`page threw: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
  }
  return result.result.value;
}

/* ---------------------------------------------------------------- *
 * The fake extension environment
 * ---------------------------------------------------------------- */

function stub(status) {
  return `(() => {
    const status = ${JSON.stringify(status)};
    // Timestamps have to be relative to when the page actually runs.
    if (status.lastCode) status.lastCode.receivedAt = Date.now() - 30000;
    for (const row of status.history ?? []) {
      row.receivedAt = Date.now() - 120000;
      row.seenAt = row.receivedAt;
    }
    if (status.watching) status.watching.until = Date.now() + 90000;

    window.__sent = [];
    window.chrome = {
      runtime: {
        id: 'testextensionidtestextensionidxx',
        sendMessage: async (message) => {
          window.__sent.push(message);
          if (message.type === 'status') return { ok: true, status: structuredClone(status) };
          if (message.type === 'settings') {
            Object.assign(status.settings, message.patch);
            return { ok: true, settings: structuredClone(status.settings) };
          }
          if (message.type === 'has-field') return { ok: true, hasField: true };
          if (message.type === 'refill') return { ok: true, found: true, result: { code: '1', filled: true, submitted: true } };
          return { ok: true };
        },
        openOptionsPage: () => {},
        getURL: (p) => p,
      },
      commands: { getAll: async () => [{ name: 'paste-code', shortcut: 'Ctrl+Shift+2' }] },
      permissions: { request: async () => false, contains: async () => false },
      storage: { onChanged: { addListener: () => {} } },
      tabs: { create: async () => {} },
    };
  })()`;
}

const baseStatus = {
  source: 'feed',
  ready: true,
  problem: null,
  email: 'me@gmail.com',
  accounts: [{ index: 0, account: 'me@gmail.com' }],
  apiConfigured: false,
  settings: {
    source: 'feed',
    freshnessMinutes: 10,
    autoFill: false,
    autoCopy: true,
    autoSubmit: true,
    inPageToast: true,
    notify: true,
    scanAllRecentMail: false,
    clipboardClearSeconds: 0,
    historyMinutes: 30,
    pollSeconds: 4,
    watchSeconds: 120,
    extraQuery: '',
  },
  lastCode: {
    code: '123456',
    messageId: 'm1',
    from: 'GitHub <noreply@github.com>',
    subject: 'Your code',
    senderSite: 'github.com',
    receivedAt: 0,
    foundAt: 0,
    confidence: 82,
    reasons: ['6 digits', 'in the subject'],
    siteMatch: true,
    ambiguous: false,
    site: 'github.com',
  },
  history: [
    {
      code: '999999',
      messageId: 'm2',
      from: 'Acme <s@acme.com>',
      subject: 'Acme code',
      senderSite: 'acme.com',
      receivedAt: 0,
      seenAt: 0,
      confidence: 70,
      site: '',
      filled: false,
      submitted: false,
    },
  ],
  watching: null,
  autoGranted: false,
  extensionId: 'testextensionidtestextensionidxx',
  tab: { id: 7, url: 'https://github.com/login', site: 'github.com', title: 'Sign in' },
};

const clone = (extra = {}, settings = {}) => ({
  ...structuredClone(baseStatus),
  ...extra,
  settings: { ...structuredClone(baseStatus.settings), ...settings },
});

/** Load popup.html with a given status, and report anything the page complained about. */
let installed = null;
async function load(page, status) {
  if (installed) await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: installed });
  installed = (await send('Page.addScriptToEvaluateOnNewDocument', { source: stub(status) })).identifier;
  events.length = 0;
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/${page}` });
  await new Promise((resolve) => setTimeout(resolve, 700));

  const complaints = [];
  for (const event of events) {
    if (event.method === 'Runtime.exceptionThrown') {
      const details = event.params.exceptionDetails;
      complaints.push(details.exception?.description ?? details.text);
    }
    if (event.method === 'Log.entryAdded' && event.params.entry.level === 'error') {
      // The stand-in http server has no favicon; a real extension page never asks.
      if ((event.params.entry.url ?? '').endsWith('/favicon.ico')) continue;
      complaints.push(`${event.params.entry.text} ${event.params.entry.url ?? ''}`);
    }
    if (event.method === 'Runtime.consoleAPICalled' && event.params.type === 'error') {
      complaints.push(event.params.args.map((a) => a.description ?? a.value).join(' '));
    }
  }
  return complaints;
}

/* ---------------------------------------------------------------- *
 * The checks
 * ---------------------------------------------------------------- */

const failures = [];
const log = [];
const check = (ok, message) => (ok ? log.push(`  ok   ${message}`) : failures.push(message));

// 1. Every render path, including the ones my stub harness never reached.
const permutations = [
  ['a code in hand', clone()],
  ['no code yet', clone({ lastCode: null, history: [] })],
  ['no code but history', clone({ lastCode: null })],
  ['watching', clone({ watching: { tabId: 7, origin: 'github.com', startedAt: 0, until: 0 } })],
  ['not ready, feed', clone({ ready: false, email: '', accounts: [], lastCode: null, history: [] })],
  ['not ready, api unconfigured', clone({ ready: false, source: 'api', accounts: [], lastCode: null }, { source: 'api' })],
  ['ambiguous code', clone({ lastCode: { ...structuredClone(baseStatus.lastCode), siteMatch: false, ambiguous: true } })],
  ['no tab', clone({ tab: null, lastCode: null, history: [] })],
];

for (const [name, status] of permutations) {
  const complaints = await load('popup.html', status);
  check(complaints.length === 0, `popup errored with "${name}": ${complaints.join(' | ')}`);
}

// 2. Hit testing: is the checkbox what a click on the switch actually lands on?
await load('popup.html', clone());
const hits = await evaluate(`
  (() => {
    const out = [];
    for (const id of ['auto-fill', 'auto-submit']) {
      const input = document.getElementById(id);
      const box = input.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      out.push({ id, hit: hit ? (hit.id || hit.className || hit.tagName) : null, w: Math.round(box.width) });
    }
    return out;
  })()
`);
for (const hit of hits) {
  check(hit.hit === hit.id, `a click on the ${hit.id} switch lands on "${hit.hit}", not the checkbox`);
}
log.push(`  switch hit test: ${JSON.stringify(hits)}`);

// 3. A real mouse click at the switch, through Chrome's own hit testing.
const beforeClick = await evaluate(`document.getElementById('auto-submit').checked`);
const box = await evaluate(`
  (() => { const r = document.getElementById('auto-submit').getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()
`);
for (const type of ['mousePressed', 'mouseReleased']) {
  await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
}
await new Promise((resolve) => setTimeout(resolve, 400));
const afterClick = await evaluate(`document.getElementById('auto-submit').checked`);
const patched = await evaluate(`JSON.stringify(window.__sent.filter(m => m.type === 'settings').map(m => m.patch))`);
check(beforeClick !== afterClick, `a real click on the switch did not change it (was ${beforeClick})`);
check(patched.includes('autoSubmit'), `a real click on the switch sent no setting: ${patched}`);
log.push(`  real click on switch: ${beforeClick} -> ${afterClick}, sent ${patched}`);

// 4. Layout stability: nothing above or around the switch may move when it is flipped.
const shift = await evaluate(`
  (async () => {
    const top = (sel) => {
      const el = document.querySelector(sel);
      return el ? Math.round(el.getBoundingClientRect().top) : null;
    };
    const snapshot = () => ({
      group: top('.settings-group'),
      submitRow: top('.settings-group .setting-row:last-child'),
      history: top('#history-card'),
      code: top('#code-card'),
      height: document.body.scrollHeight,
    });
    const before = snapshot();
    const input = document.getElementById('auto-submit');
    input.click();
    await new Promise((r) => setTimeout(r, 350));
    const after = snapshot();
    input.click();
    await new Promise((r) => setTimeout(r, 350));
    const back = snapshot();
    return { before, after, back };
  })()
`);
for (const key of ['group', 'submitRow', 'history', 'code', 'height']) {
  check(
    shift.before[key] === shift.after[key] && shift.after[key] === shift.back[key],
    `${key} moved when the switch was flipped: ${shift.before[key]} -> ${shift.after[key]} -> ${shift.back[key]}`,
  );
}
log.push(`  layout on toggle: ${JSON.stringify(shift.before)}`);

// 5. The shortcut chip is on the button and visible.
const chip = await evaluate(`
  (() => {
    const kbd = document.getElementById('shortcut-hint');
    const button = document.getElementById('paste-button');
    return {
      text: kbd.textContent,
      hidden: kbd.hidden,
      insideButton: button.contains(kbd),
      visible: kbd.getBoundingClientRect().width > 0,
    };
  })()
`);
check(chip.text === 'Ctrl+Shift+2' && !chip.hidden && chip.insideButton && chip.visible,
  `the shortcut chip is wrong: ${JSON.stringify(chip)}`);
log.push(`  shortcut chip: ${JSON.stringify(chip)}`);

// 6. The removed privacy line really is gone, and no footer is left behind.
const gone = await evaluate(`
  ({
    privacy: document.body.textContent.includes('Codes stay in this browser'),
    footer: Boolean(document.querySelector('.app-footer')),
  })
`);
check(!gone.privacy, 'the privacy line is still in the popup');
check(!gone.footer, 'an empty footer is still in the popup');

// 7. Clicking the code copies it; clicking a history row is reachable.
const reach = await evaluate(`
  (() => {
    const code = document.getElementById('code-value');
    const rect = code.getBoundingClientRect();
    const onCode = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    const row = document.querySelector('.history-row');
    return { codeHit: onCode?.id ?? null, hasRow: Boolean(row), rowText: row?.textContent ?? '' };
  })()
`);
check(reach.codeHit === 'code-value', `clicking the code lands on "${reach.codeHit}"`);
log.push(`  history row: "${reach.rowText}"`);

// 8. The options page renders without complaint too.
const optionsComplaints = await load('options.html', clone());
check(optionsComplaints.length === 0, `options errored: ${optionsComplaints.join(' | ')}`);
const optionSwitches = await evaluate(`
  (() => {
    const out = [];
    for (const input of document.querySelectorAll('.switch input')) {
      // The options page is a long document. elementFromPoint is viewport-relative,
      // so anything below the fold has to be scrolled to first or it reports null.
      input.scrollIntoView({ block: 'center' });
      const r = input.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      out.push({
        id: input.id,
        ok: hit === input,
        hit: hit ? (hit.id || hit.className || hit.tagName) : 'nothing',
        top: Math.round(r.top),
      });
    }
    return out;
  })()
`);
for (const entry of optionSwitches) {
  check(entry.ok, `options: a click on the ${entry.id} switch lands on "${entry.hit}" (top ${entry.top})`);
}
log.push(`  options switches reachable: ${optionSwitches.filter((s) => s.ok).length}/${optionSwitches.length}`);

// And a real click on one of them, to be sure.
await evaluate(`document.getElementById('in-page-toast').scrollIntoView({ block: 'center' })`);
const toastBox = await evaluate(`
  (() => { const r = document.getElementById('in-page-toast').getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()
`);
const toastBefore = await evaluate(`document.getElementById('in-page-toast').checked`);
for (const type of ['mousePressed', 'mouseReleased']) {
  await send('Input.dispatchMouseEvent', { type, x: toastBox.x, y: toastBox.y, button: 'left', clickCount: 1 });
}
await new Promise((resolve) => setTimeout(resolve, 400));
const toastAfter = await evaluate(`document.getElementById('in-page-toast').checked`);
const toastPatch = await evaluate(`JSON.stringify(window.__sent.filter(m => m.type === 'settings').map(m => m.patch))`);
check(toastBefore !== toastAfter, `options: a real click on the in-page-toast switch did nothing`);
check(toastPatch.includes('inPageToast'), `options: a real click sent no setting: ${toastPatch}`);
log.push(`  options real click: ${toastBefore} -> ${toastAfter}, sent ${toastPatch}`);

/* ---------------------------------------------------------------- */

console.log(log.join('\n'));
console.log(failures.length === 0 ? '\nno failures' : `\n${failures.length} FAILURES:\n${failures.map((f) => `  - ${f}`).join('\n')}`);

await call('Target.closeTarget', { targetId });
socket.close();
server.close();
process.exit(failures.length ? 1 : 0);

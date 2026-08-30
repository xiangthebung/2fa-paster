/**
 * A layout engine, for the tests that need one.
 *
 * Everything under `tests/*.test.mjs` is pure: it imports a module, calls it, and
 * asserts on the return value. That covers the scoring, the parsing and the
 * storage rules, and it cannot cover `content.js` at all — a file whose entire
 * job is to look at a rendered page, decide which box is the code box, and press
 * a button. There is nothing to import and no return value to assert on. The
 * questions it answers ("is this input visible?", "what does the label above it
 * say?", "which element does a click land on?") only have answers inside a
 * browser.
 *
 * That gap is not academic. The two defects this harness's throwaway ancestor
 * found were a decorative span painted over a checkbox, and a layout shift when a
 * switch was flipped. Both looked perfect in the source and neither was reachable
 * from Node.
 *
 * So: launch headless Chrome, serve `dist/` over http, and drive it over the
 * DevTools Protocol. `dist/` rather than the source tree, because `dist/` is what
 * Chrome loads and what the build rewrites the manifest into — testing the source
 * folder tests something nobody runs.
 *
 * This file owns the plumbing: finding Chrome, starting it, the socket, the file
 * server, and the page helpers. The checks live in `content.checks.mjs` and
 * `ui.checks.mjs`; `run.mjs` is the entry point.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const dist = path.join(root, 'dist');

/**
 * Where Chrome might be.
 *
 * `CHROME_PATH` first so a machine with an unusual install, or a CI image with a
 * pinned build, can say so without editing this list.
 */
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  `${process.env.LOCALAPPDATA ?? ''}/Google/Chrome/Application/chrome.exe`,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  // Chromium-based Edge runs the same engine and the same protocol. It is a
  // fallback rather than a target: what ships is a Chrome extension.
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean);

/** @returns {string | null} */
export function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
};

/**
 * Serve `dist/` plus the fixture pages, on one origin.
 *
 * One origin matters: a fixture page loads `content.js` with a relative `<script
 * src>`, and the script it loads has to be the built one rather than a copy that
 * could drift.
 *
 * `pages` is a live map of extra files that exist only in memory, checked before
 * either directory. The checks do not use it; `scripts/store-shots.mjs` does, to
 * serve the invented sign-in pages it photographs — and to hand back the popup
 * PNGs it has just captured so a frame page can lay them out. Live rather than
 * copied, because those PNGs do not exist yet when the server starts.
 *
 * @param {Map<string, { body: string | Buffer, type?: string }>} pages
 */
async function serve(pages) {
  const fixtures = path.join(root, 'tests', 'browser', 'fixtures');

  const server = createServer(async (request, response) => {
    const name = decodeURIComponent(request.url.split('?')[0]).replace(/^\/+/, '');

    const virtual = pages.get(name);
    if (virtual) {
      response
        .writeHead(200, {
          'content-type': virtual.type ?? TYPES[path.extname(name)] ?? 'text/html; charset=utf-8',
          'cache-control': 'no-store',
        })
        .end(virtual.body);
      return;
    }

    const base = name.startsWith('fixtures/') ? fixtures : dist;
    const relative = name.startsWith('fixtures/') ? name.slice('fixtures/'.length) : name;
    const file = path.resolve(base, relative);
    // Path traversal would let a fixture read anything on the machine. It is a
    // test server, but it is also a server.
    if (!file.startsWith(base)) {
      response.writeHead(403).end();
      return;
    }
    try {
      const body = await readFile(file);
      response
        .writeHead(200, {
          'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream',
          'cache-control': 'no-store',
        })
        .end(body);
    } catch {
      response.writeHead(404).end();
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port };
}

/**
 * Start Chrome and wait for it to say where its debugger is listening.
 *
 * Port zero rather than the conventional 9222: a developer with a debuggable
 * Chrome already open would otherwise have this harness attach to their own
 * browser and start navigating it.
 */
async function launchChrome(binary) {
  const profile = await mkdtemp(path.join(tmpdir(), '2fa-paster-browser-test-'));
  const child = spawn(
    binary,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-sync',
      '--mute-audio',
      'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  const endpoint = await new Promise((resolve, reject) => {
    let buffered = '';
    const timer = setTimeout(() => reject(new Error('Chrome did not report a debugging endpoint')), 30000);
    child.stderr.on('data', (chunk) => {
      buffered += chunk;
      const match = buffered.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Chrome exited with code ${code} before listening`));
    });
  });

  return { child, profile, endpoint };
}

/**
 * A page in a running browser, with the few protocol calls these checks need.
 *
 * @typedef {object} Page
 * @property {(expression: string) => Promise<unknown>} evaluate
 * @property {(url: string, options?: { before?: string }) => Promise<string[]>} open
 * @property {(x: number, y: number) => Promise<void>} click
 * @property {(width: number, height: number) => Promise<void>} resize
 * @property {(media: Array<{ name: string, value: string }>) => Promise<void>} emulateMedia
 * @property {(options?: { clip?: { x: number, y: number, width: number, height: number } }) => Promise<Buffer>} screenshot
 * @property {string} origin
 */

/**
 * Bring up the browser, the server and one page.
 *
 * @param {{ width?: number, height?: number,
 *           pages?: Map<string, { body: string | Buffer, type?: string }> }} [options]
 *   `pages` is served ahead of `dist/` and the fixtures, and is read on every
 *   request rather than copied, so a caller can add to it while the browser is
 *   running. See `serve`.
 * @returns {Promise<{ page: Page, close: () => Promise<void> }>}
 */
export async function open({ width = 1024, height = 900, pages = new Map() } = {}) {
  const binary = findChrome();
  if (!binary) throw new Error('no Chrome found');

  const { server, port } = await serve(pages);
  const { child, profile, endpoint } = await launchChrome(binary);

  const socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('could not connect to Chrome')), { once: true });
  });

  let nextId = 1;
  const pending = new Map();
  /** Protocol events since the last navigation, for the console-error check. */
  let events = [];

  socket.addEventListener('message', (message) => {
    const frame = JSON.parse(message.data);
    if (frame.id && pending.has(frame.id)) {
      const { resolve, reject } = pending.get(frame.id);
      pending.delete(frame.id);
      if (frame.error) reject(new Error(`${frame.error.message} ${JSON.stringify(frame.error.data ?? '')}`));
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
      }, 20000);
    });
  }

  const { targetId } = await call('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true });
  const send = (method, params) => call(method, params, sessionId);

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');

  /** The script installed before every navigation, if any. */
  let installed = null;

  const page = {
    origin: `http://127.0.0.1:${port}`,

    async evaluate(expression) {
      const result = await send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (result.exceptionDetails) {
        const details = result.exceptionDetails;
        throw new Error(`page threw: ${details.exception?.description ?? details.text}`);
      }
      return result.result.value;
    },

    /**
     * Navigate, optionally installing a script that runs before the page's own.
     *
     * `Page.addScriptToEvaluateOnNewDocument` rather than an inline `<script>`,
     * because the stub `chrome` object has to exist before `content.js` reaches
     * `chrome.runtime.onMessage`, and an injected script cannot beat a `<script>`
     * that is already in the document.
     *
     * @returns {Promise<string[]>} anything the page complained about
     */
    async open(url, { before } = {}) {
      if (installed) {
        await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: installed });
        installed = null;
      }
      if (before) {
        installed = (await send('Page.addScriptToEvaluateOnNewDocument', { source: before })).identifier;
      }
      events = [];
      await send('Page.navigate', { url: url.startsWith('http') ? url : `${page.origin}/${url}` });
      // Load plus a beat: content.js schedules its first field report, and the
      // pages under test settle their own layout on DOMContentLoaded.
      await new Promise((resolve) => setTimeout(resolve, 600));

      const complaints = [];
      for (const event of events) {
        if (event.method === 'Runtime.exceptionThrown') {
          const details = event.params.exceptionDetails;
          complaints.push(details.exception?.description ?? details.text);
        }
        if (event.method === 'Log.entryAdded' && event.params.entry.level === 'error') {
          // A real extension page never requests a favicon; this server has none.
          if ((event.params.entry.url ?? '').endsWith('/favicon.ico')) continue;
          complaints.push(`${event.params.entry.text} ${event.params.entry.url ?? ''}`);
        }
        if (event.method === 'Runtime.consoleAPICalled' && event.params.type === 'error') {
          complaints.push(event.params.args.map((arg) => arg.description ?? arg.value).join(' '));
        }
      }
      return complaints;
    },

    /** A real mouse click, through Chrome's own hit testing rather than `.click()`. */
    async click(x, y) {
      for (const type of ['mousePressed', 'mouseReleased']) {
        await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    },

    /** A real key press, so focus moves the way it does for a person. */
    async press(key, { code = key, virtualKey = 0 } = {}) {
      for (const type of ['rawKeyDown', 'keyUp']) {
        await send('Input.dispatchKeyEvent', {
          type,
          key,
          code,
          windowsVirtualKeyCode: virtualKey,
          nativeVirtualKeyCode: virtualKey,
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 30));
    },

    async resize(w, h) {
      await send('Emulation.setDeviceMetricsOverride', {
        width: w,
        height: h,
        deviceScaleFactor: 1,
        mobile: false,
      });
    },

    async emulateMedia(features) {
      await send('Emulation.setEmulatedMedia', { features });
    },

    /**
     * A PNG of the viewport, or of one box in the page.
     *
     * Used by `scripts/store-shots.mjs`, not by the checks. `clip` is in page
     * coordinates, and `captureBeyondViewport` is what lets it reach a card
     * below the fold without scrolling the page first — scrolling moves sticky
     * headers and re-triggers entry animations, and the store images should not
     * depend on either.
     *
     * @param {{ clip?: { x: number, y: number, width: number, height: number } }} [options]
     * @returns {Promise<Buffer>}
     */
    async screenshot({ clip } = {}) {
      const { data } = await send('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: Boolean(clip),
        ...(clip ? { clip: { ...clip, scale: 1 } } : {}),
      });
      return Buffer.from(data, 'base64');
    },
  };

  await page.resize(width, height);

  async function close() {
    try {
      socket.close();
    } catch {
      // Already gone.
    }
    child.kill();
    await new Promise((resolve) => server.close(resolve));
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }

  return { page, close };
}

/**
 * A run of checks with a name, so a failure says which claim broke.
 *
 * Deliberately not `node:test`: these checks share one expensive browser and run
 * in a fixed order, and the test runner's per-file isolation would either start a
 * browser per file or need a global fixture. A tally and a non-zero exit is all
 * the reporting a single command needs.
 */
export function reporter() {
  const failures = [];
  let passed = 0;

  return {
    check(ok, message) {
      if (ok) passed += 1;
      else failures.push(message);
      return ok;
    },
    get passed() {
      return passed;
    },
    get failures() {
      return failures;
    },
  };
}

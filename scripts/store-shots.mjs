/**
 * The Chrome Web Store images, rendered from the built extension.
 *
 *   npm run store:assets
 *
 * Writes `store-assets/`: five 1280x800 screenshots and the 440x280 promotional
 * tile. Needs a Chrome or Chromium on the machine, found the same way
 * `npm run test:browser` finds one, or named by `CHROME_PATH`.
 *
 * Five decisions worth knowing about.
 *
 * **It photographs `dist/`, never the source tree.** `dist/` is what `npm run
 * zip` packages and what a reviewer installs, so it is what the pictures have to
 * come from. `npm run store:assets` builds first for that reason.
 *
 * **It reuses the browser harness the checks already use** — `tests/browser/
 * harness.mjs` — rather than adding Playwright. That harness already knows how to
 * find Chrome, serve `dist/` on one origin and drive a page over the DevTools
 * protocol, and this repository has no dependencies to add one to. Two things
 * were added there for this file: a map of in-memory pages served ahead of
 * `dist/`, and `page.screenshot()`.
 *
 * **Every pixel of extension interface is rendered by the shipped build.** The
 * popup and the options page here are `dist/popup.html` and `dist/options.html`,
 * laid out by their own CSS; the code that appears in the sign-in pages is typed
 * into them by `dist/content.js` doing its real work, and the confirmation card
 * in the corner is the one the extension draws. What is stubbed is the service
 * worker's *reply* — the mail, and only the mail.
 *
 * **The mail is invented, and the scorer is not.** The three messages below are
 * made up: made-up services on `.example` domains, made-up codes, no real
 * mailbox and no network. But the confidence figure and the "Why this one"
 * reasons in the screenshots are not written by hand — they are computed by
 * importing `code-finder.js` and running the shipped scorer over those invented
 * messages. So the panel cannot claim a score the extension would not produce.
 *
 * **The composition is done in the browser.** The page being photographed is
 * already a layout engine; asking it to put one PNG on a background is less code
 * than an image library, and the caption typography is set in CSS rather than
 * measured by hand. Every source image is captured at exactly the size it is
 * placed at, so nothing is scaled after the fact.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { findChrome, open } from '../tests/browser/harness.mjs';
import { STUB as CONTENT_STUB } from '../tests/browser/content.checks.mjs';
import { findBestCode } from '../code-finder.js';
import { senderName } from '../domains.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'store-assets');

/* ------------------------------------------------------------------ *
 * Store sizes
 * ------------------------------------------------------------------ */

const WIDTH = 1280;
const HEIGHT = 800;
/** Caption band above a centred screenshot. */
const BAND = 158;
const STAGE = HEIGHT - BAND;
/**
 * The copy column of the split frames.
 *
 * Wide, because the popup is only 380px and cannot honestly be made bigger: it
 * is nearly as tall as the frame already, so enlarging it would crop its header
 * off. Giving the words the extra room is better than floating a small popup in
 * a large empty stage.
 */
const COPY = 556;

const TILE = { width: 440, height: 280 };

/**
 * The popup is 380px wide by its own stylesheet and is never re-laid-out to
 * anything else, so it is re-rendered larger rather than enlarged afterwards: a
 * scaled-up PNG of a 380px popup is a soft PNG. This is the ceiling; the real
 * factor is whatever makes the whole popup fit in `POPUP_ROOM`, because a store
 * screenshot with the header cropped off says the extension has no header.
 */
const POPUP_ZOOM = 1.55;

/** Height a popup screenshot may occupy in a split frame's stage. */
const POPUP_ROOM = HEIGHT - 24 - 44;

/* ------------------------------------------------------------------ *
 * The invented inbox
 * ------------------------------------------------------------------ *
 *
 * Three services that do not exist, on the `.example` TLD that is reserved so
 * that they cannot start existing. No real sender, no real code, no real
 * mailbox, and nothing here is read from a network — `searchForCode` never runs
 * in this script at all. What does run is `findBestCode`, over exactly these
 * three messages.
 */

const NOW = Date.now();
const SITE = 'orchardpost.example';

const MESSAGES = [
  {
    id: 'invented-orchard',
    from: 'Orchard Post <no-reply@orchardpost.example>',
    subject: '739204 is your Orchard Post verification code',
    text:
      'Enter this verification code to finish signing in to orchardpost.example.\n' +
      '739204\n' +
      'It expires in 10 minutes. Do not share it with anyone.\n' +
      'If you did not request it, you can ignore this message. Order number 4471902 is unaffected.',
    receivedAt: NOW - 24000,
  },
  {
    id: 'invented-tinbox',
    from: 'Tinbox Studio <hello@tinbox.example>',
    subject: 'Your Tinbox sign-in code',
    text: 'Your login code is 518402. It is valid for 15 minutes.',
    receivedAt: NOW - 5 * 60000,
  },
  {
    id: 'invented-larkfield',
    from: 'Larkfield Rail <tickets@larkfield.example>',
    subject: 'One-time passcode for your booking',
    text: 'Use passcode 204817 to confirm this booking. Do not share it.',
    receivedAt: NOW - 9 * 60000,
  },
];

/** The shipped scorer's opinion of that inbox, with the sign-in page in front of you. */
const FOUND = findBestCode(MESSAGES, { site: SITE, now: NOW });
if (!FOUND) throw new Error('store-shots: the scorer found no code in the sample inbox');
if (FOUND.code !== '739204') {
  // The pictures name a code in their captions, and a caption that disagrees
  // with the panel beside it is worse than no caption.
  throw new Error(`store-shots: the scorer picked ${FOUND.code}, but the sample copy says 739204`);
}

const CODE = FOUND.code;

const messageOf = (id) => MESSAGES.find((message) => message.id === id);

/** `deliver` shape: what the popup renders as the code in hand. */
const LAST_CODE = {
  code: FOUND.code,
  messageId: FOUND.messageId,
  from: FOUND.from,
  subject: FOUND.subject,
  senderSite: FOUND.senderSite,
  receivedAt: FOUND.receivedAt,
  foundAt: NOW,
  confidence: FOUND.confidence,
  reasons: FOUND.reasons,
  siteMatch: FOUND.siteMatch,
  ambiguous: FOUND.ambiguous,
  site: SITE,
};

/** `noteHistory` shape: the winner, filled, plus everything else that turned up. */
const HISTORY = [
  {
    code: FOUND.code,
    messageId: FOUND.messageId,
    from: FOUND.from,
    subject: FOUND.subject,
    senderSite: FOUND.senderSite,
    receivedAt: FOUND.receivedAt,
    seenAt: NOW,
    confidence: FOUND.confidence,
    site: SITE,
    filled: true,
    submitted: true,
  },
  ...FOUND.alternatives.map((other) => ({
    code: other.code,
    messageId: other.messageId,
    from: other.from,
    subject: other.subject,
    senderSite: other.senderSite,
    receivedAt: other.receivedAt,
    seenAt: NOW,
    confidence: other.confidence,
    site: '',
    filled: false,
    submitted: false,
  })),
];

/* ------------------------------------------------------------------ *
 * A stand-in service worker
 * ------------------------------------------------------------------ */

/**
 * Everything `buildStatus` returns, as the popup and the options page expect it.
 *
 * The one thing this stubs is the answer to `chrome.runtime.sendMessage`. It is
 * deliberately not shared with `tests/browser/ui.checks.mjs`, which rewrites
 * every timestamp to a fixed age so its assertions cannot drift — here the ages
 * are the ones the invented mail actually carries, because they are on screen.
 */
const BASE_STATUS = {
  source: 'feed',
  ready: true,
  problem: null,
  email: 'you@example.com',
  accounts: [{ index: 0, account: 'you@example.com', unreadCount: 3 }],
  apiConfigured: false,
  settings: {
    source: 'feed',
    freshnessMinutes: 10,
    autoFill: true,
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
  lastCode: LAST_CODE,
  history: HISTORY,
  watching: null,
  autoGranted: true,
  extensionId: 'storeassetsplaceholderextensionid',
  tab: { id: 1, url: `https://${SITE}/sign-in`, site: SITE, title: 'Orchard Post — Sign in' },
};

const status = (extra = {}, settings = {}) => ({
  ...structuredClone(BASE_STATUS),
  ...extra,
  settings: { ...structuredClone(BASE_STATUS.settings), ...settings },
});

/** Installed before the page's own scripts, because both pages ask on load. */
function stub(state) {
  return `(() => {
    const status = ${JSON.stringify(state)};
    window.chrome = {
      runtime: {
        id: status.extensionId,
        lastError: undefined,
        getURL: (path) => path,
        openOptionsPage: () => {},
        sendMessage: async (message) => {
          if (message.type === 'status') return { ok: true, status: structuredClone(status) };
          if (message.type === 'settings') {
            Object.assign(status.settings, message.patch);
            return { ok: true, settings: structuredClone(status.settings) };
          }
          if (message.type === 'has-field') return { ok: true, hasField: true };
          return { ok: true };
        },
      },
      commands: { getAll: async () => [{ name: 'paste-code', shortcut: 'Ctrl+Shift+2' }] },
      permissions: { request: async () => true, contains: async () => status.autoGranted },
      storage: { onChanged: { addListener: () => {} } },
      tabs: { create: async () => {} },
    };
  })()`;
}

/* ------------------------------------------------------------------ *
 * The pages being signed in to
 * ------------------------------------------------------------------ *
 *
 * Invented, and both say so on the page. Neither names, depicts or imitates a
 * real service; the layouts are ordinary because a code form is ordinary. The
 * extension is not told anything about them — it finds the field by looking, the
 * same way it does on a real page.
 */

const PAGE_STYLE = `
  :root { color-scheme: light }
  * { box-sizing: border-box }
  body {
    margin: 0;
    min-height: 100vh;
    display: grid;
    place-items: center;
    background: linear-gradient(180deg, #f7f6fb 0%, #eceaf4 100%);
    color: #1d1d1f;
    font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .sheet {
    width: 468px;
    padding: 34px 38px 30px;
    border-radius: 18px;
    background: #fff;
    box-shadow: 0 1px 2px rgba(20, 18, 40, .06), 0 24px 60px -30px rgba(20, 18, 40, .45);
  }
  .brand { display: flex; align-items: center; gap: 10px; font-weight: 680; letter-spacing: -.01em }
  .brand span.mark {
    display: grid; place-items: center; width: 30px; height: 30px; border-radius: 9px;
    background: #2f5d50; color: #fff; font-size: 15px; font-weight: 700;
  }
  h1 { margin: 22px 0 6px; font-size: 22px; font-weight: 660; letter-spacing: -.02em }
  p.lead { margin: 0 0 22px; color: #5c5c68 }
  label { display: block; margin-bottom: 7px; font-size: 13px; font-weight: 620; color: #3c3c46 }
  input[type=text] {
    width: 100%; padding: 13px 15px; border: 1px solid #d3d1de; border-radius: 11px;
    background: #fff; color: inherit; font: 600 20px/1.2 inherit; letter-spacing: .34em;
  }
  input[type=text]:focus { outline: 2px solid rgba(47, 93, 80, .5); outline-offset: 1px }
  .actions { display: flex; gap: 10px; margin-top: 20px }
  button {
    padding: 11px 18px; border: 0; border-radius: 11px; font: 620 14px/1 inherit; cursor: pointer;
  }
  button.primary { background: #2f5d50; color: #fff }
  button.quiet { background: #f0eff5; color: #43434e }
  button.danger { background: #fbeceb; color: #a4231b }
  .fine { margin: 20px 0 0; color: #85838f; font-size: 12px }
  .sample {
    position: fixed; left: 16px; bottom: 14px; padding: 5px 10px; border-radius: 7px;
    background: rgba(29, 29, 31, .62); color: #fff; font-size: 11px; font-weight: 600;
  }
  .log {
    margin: 22px 0 0; padding: 14px 16px; border-radius: 12px; background: #f7f6fb;
    border: 1px solid #e6e4ef; font-size: 12.5px; color: #43434e;
  }
  .log strong { display: block; margin-bottom: 6px; font-size: 11px; letter-spacing: .08em;
    text-transform: uppercase; color: #85838f }
  .log li { margin-top: 3px; list-style: none }
  .log .no { color: #2f5d50; font-weight: 620 }
  .log ul { margin: 0; padding: 0 }
`;

const SAMPLE_BADGE = '<p class="sample">Sample page — Orchard Post is not a real service</p>';

const signInPage = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Orchard Post — Sign in</title>
<style>${PAGE_STYLE}</style></head>
<body>
  <main class="sheet">
    <p class="brand"><span class="mark">O</span> Orchard Post</p>
    <h1>Enter your verification code</h1>
    <p class="lead">We emailed a 6-digit code to you@example.com. It expires in 10 minutes.</p>
    <form id="form" onsubmit="event.preventDefault()">
      <label for="code">Verification code</label>
      <input id="code" name="otp" type="text" autocomplete="one-time-code" maxlength="6" inputmode="numeric">
      <div class="actions">
        <button class="primary" type="submit">Verify and continue</button>
        <button class="quiet" type="button">Use a different method</button>
      </div>
    </form>
    <p class="fine">Never share this code. Orchard Post will not ask you for it.</p>
  </main>
  ${SAMPLE_BADGE}
  <script src="/content.js"></script>
</body></html>`;

/**
 * The page the never-press list exists for.
 *
 * "Resend code" is a submit button on plenty of real forms and comes first in
 * document order, so it beats any "press the first submit button" strategy — and
 * pressing it invalidates the code that has just been filled in. The destructive
 * button beside it is the unrecoverable version of the same mistake.
 *
 * The page keeps its own record of which of its buttons were pressed, and prints
 * it. That record is written by the page, not by the extension, which is what
 * makes it worth photographing: the two buttons that were not pressed are the
 * claim, and this is the page saying so.
 */
const devicePage = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Orchard Post — Confirm</title>
<style>${PAGE_STYLE}</style></head>
<body>
  <main class="sheet">
    <p class="brand"><span class="mark">O</span> Orchard Post</p>
    <h1>Confirm with your security code</h1>
    <p class="lead">Enter the code we emailed you to finish removing this device.</p>
    <form id="form" onsubmit="event.preventDefault()">
      <label for="code">Security code</label>
      <input id="code" name="otp" type="text" autocomplete="one-time-code" maxlength="6" inputmode="numeric">
      <div class="actions">
        <button class="quiet" type="submit" onclick="press('Resend code')">Resend code</button>
        <button class="danger" type="button" onclick="press('Remove this device')">Remove this device</button>
        <button class="primary" type="submit" onclick="press('Continue')">Continue</button>
      </div>
    </form>
    <div class="log">
      <strong>What this page recorded</strong>
      <ul id="log"><li class="no">Nothing pressed yet.</li></ul>
    </div>
  </main>
  ${SAMPLE_BADGE}
  <script>
    const seen = [];
    function press(what) {
      seen.push(what);
      document.getElementById('log').innerHTML = seen.map((entry) => '<li>Pressed: ' + entry + '</li>').join('')
        + ['Resend code', 'Remove this device']
            .filter((button) => !seen.includes(button))
            .map((button) => '<li class="no">Not pressed: ' + button + '</li>')
            .join('');
    }
  </script>
  <script src="/content.js"></script>
</body></html>`;

/* ------------------------------------------------------------------ *
 * Frames
 * ------------------------------------------------------------------ */

const FRAME_STYLE = `
  * { box-sizing: border-box }
  body {
    display: flex;
    width: ${WIDTH}px; height: ${HEIGHT}px;
    margin: 0; overflow: hidden;
    color: #1c1b22;
    background: #f5f4f9;
    font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .split { display: flex; width: 100%; height: 100% }
  .copy {
    display: flex; flex-direction: column; justify-content: center;
    width: ${COPY}px; flex: 0 0 ${COPY}px; padding: 0 52px;
    background: radial-gradient(120% 90% at 0% 0%, #ffffff 0%, #f5f4f9 62%);
  }
  .eyebrow { margin: 0; color: #5b45e0; font-size: 11.5px; font-weight: 800; letter-spacing: .17em; text-transform: uppercase }
  h1 { margin: 13px 0 0; font-size: 37px; font-weight: 760; letter-spacing: -.034em; line-height: 1.11; text-wrap: balance }
  .note { margin: 15px 0 0; color: #4c4b58; font-size: 16.5px; line-height: 1.5; text-wrap: pretty }
  ul.points { margin: 24px 0 0; padding: 0; list-style: none }
  ul.points li { position: relative; margin-top: 10px; padding-left: 25px; font-size: 15px; line-height: 1.45; color: #26252f }
  ul.points li::before { position: absolute; top: -1px; left: 0; color: #5b45e0; content: "\\2713"; font-weight: 800 }
  .foot { margin: 26px 0 0; color: #77758a; font-size: 12.5px; line-height: 1.5 }
  .stage {
    position: relative; display: flex; flex: 1; gap: 26px; padding: 24px 24px 44px;
    align-items: center; justify-content: center; flex-direction: column;
    background: radial-gradient(105% 78% at 68% 4%, #ddd7fb 0%, #c8c0f4 54%, #a99ee9 100%);
  }
  .head {
    display: flex; height: ${BAND}px; flex-direction: column; justify-content: center; padding: 0 58px;
    background: radial-gradient(130% 300% at 100% 0%, #ffffff 0%, #f5f4f9 60%);
  }
  .head h1 { max-width: none; font-size: 32px }
  .head .note { max-width: 1020px; margin-top: 7px; font-size: 15.5px }
  .hero { display: flex; flex-direction: column; width: 100% }
  .hero .stage { height: ${STAGE}px; flex: none; border-top: 1px solid #d7d2ee }
  img { display: block; border-radius: 15px; box-shadow: 0 0 0 1px rgba(28, 24, 60, .09), 0 32px 66px -26px rgba(28, 24, 60, .55) }
  .head .foot { margin-top: 9px }
`;

/**
 * Every frame says where its contents came from, in its own copy rather than as
 * a sticker over the picture — a sticker large enough to read is large enough to
 * cover something, and the two hero frames put it straight across the extension's
 * own confirmation card.
 */
const PROVENANCE =
  'Interface rendered by the shipped build. The mail, the services and the codes are invented.';

const framePage = (body) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>${FRAME_STYLE}</style></head><body>${body}</body></html>`;

function splitFrame({ eyebrow, title, note, points, foot, shots }) {
  return framePage(`<div class="split">
  <div class="copy">
    <p class="eyebrow">${eyebrow}</p>
    <h1>${title}</h1>
    <p class="note">${note}</p>
    <ul class="points">${points.map((point) => `<li>${point}</li>`).join('')}</ul>
    <p class="foot">${foot}</p>
  </div>
  <div class="stage">${shots.map((shot) => `<img src="${shot}" alt="">`).join('')}</div>
</div>`);
}

function heroFrame({ eyebrow, title, note, shots }) {
  return framePage(`<div class="hero">
  <div class="head">
    <p class="eyebrow">${eyebrow}</p>
    <h1>${title}</h1>
    <p class="note">${note}</p>
    <p class="foot">${PROVENANCE}</p>
  </div>
  <div class="stage">${shots.map((shot) => `<img src="${shot}" alt="">`).join('')}</div>
</div>`);
}

const tilePage = `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>
  * { box-sizing: border-box }
  body {
    display: flex; width: ${TILE.width}px; height: ${TILE.height}px;
    flex-direction: column; justify-content: center; margin: 0; padding: 0 32px; overflow: hidden;
    color: #f3f1ff;
    background: radial-gradient(125% 145% at 6% 0%, #7a63ff 0%, #5b45e0 52%, #2b1d78 100%);
    font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .mark {
    display: inline-flex; width: 62px; height: 62px; align-items: center; justify-content: center;
    border-radius: 16px; background: #fff; box-shadow: 0 10px 24px -10px rgba(14, 8, 48, .6);
  }
  .mark img { display: block; width: 44px; height: 44px }
  h1 { margin: 17px 0 0; font-size: 32px; font-weight: 770; letter-spacing: -.032em }
  p { margin: 8px 0 0; color: rgba(243, 241, 255, .82); font-size: 15px }
  small { margin-top: 13px; color: rgba(243, 241, 255, .58); font-size: 11.5px }
</style></head><body>
  <span class="mark"><img src="/icons/icon-128.png" alt=""></span>
  <h1>2FA Paster</h1>
  <p>The code from your inbox, in the box.</p>
  <small>Reads your own Gmail, on your own machine. No server, no account.</small>
</body></html>`;

/* ------------------------------------------------------------------ *
 * Plumbing
 * ------------------------------------------------------------------ */

/** In-memory files the harness serves ahead of `dist/`. Added to as we go. */
const pages = new Map();

const html = (body) => ({ body, type: 'text/html; charset=utf-8' });
const png = (body) => ({ body, type: 'image/png' });

/** Width and height straight out of a PNG's IHDR chunk. */
function pngSize(buffer) {
  if (buffer.length < 24 || buffer.toString('ascii', 12, 16) !== 'IHDR') {
    throw new Error('not a PNG');
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

const written = [];

/** Write one finished image, having checked it is the size the store asks for. */
async function emit(name, buffer, expected) {
  const size = pngSize(buffer);
  if (size.width !== expected.width || size.height !== expected.height) {
    throw new Error(
      `store-shots: ${name} came out ${size.width}x${size.height}, not ${expected.width}x${expected.height}`,
    );
  }
  await writeFile(path.join(out, name), buffer);
  written.push(`${name}  ${size.width}x${size.height}`);
  process.stdout.write(`  ${name}\n`);
}

/** Render one frame page at an exact size and keep the result. */
async function frame(page, name, markup, size = { width: WIDTH, height: HEIGHT }) {
  const route = `frames/${name}.html`;
  pages.set(route, html(markup));
  await page.resize(size.width, size.height);
  await page.open(route);
  // Images are served rather than inlined, so give the decode a beat: the first
  // frame after navigation can otherwise be captured with an empty box.
  await page.evaluate(
    `Promise.all([...document.images].map((image) => image.decode())).then(() => document.fonts.ready)`,
  );
  await emit(`${name}.png`, await page.screenshot(), size);
}

/**
 * Photograph the whole popup, as large as it can be shown without cropping it.
 *
 * In practice that is close to life size: at these fixtures the popup is already
 * about as tall as the frame, so the fitted zoom lands just under 1 and the
 * enlargement is nominal. The arithmetic stays because the alternative — a fixed
 * factor — silently starts cutting the header off the day a row is added.
 *
 * @param {import('../tests/browser/harness.mjs').Page} page
 * @param {object} state         the status the stub answers with
 * @param {string} [after]       an expression run once the popup has rendered
 */
async function shootPopup(page, state, after = '') {
  const measure = `
    (() => {
      const rect = document.querySelector('.app').getBoundingClientRect();
      return { width: rect.width, height: rect.bottom };
    })()
  `;

  await page.resize(420, 1400);
  await page.open('popup.html', { before: stub(state) });
  if (after) await page.evaluate(after);
  await page.evaluate(`new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 120)))`);

  // How much it can be enlarged before it stops fitting in the frame.
  const natural = await page.evaluate(measure);
  const zoom = Math.min(POPUP_ZOOM, Math.floor((POPUP_ROOM / natural.height) * 1000) / 1000);

  await page.evaluate(`document.documentElement.style.zoom = '${zoom}'`);
  await page.evaluate(`new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 120)))`);

  // Measured again after the zoom, because rounding at the new scale can move
  // the last row by a pixel. Whether `getBoundingClientRect` reports the zoomed
  // box or the unzoomed one depends on the Chrome version, so both candidate
  // answers are compared against what came back and the nearer one wins. A
  // threshold test cannot do this: the fitted zoom is often just under 1, where
  // "bigger than natural" is false for the wrong reason, and scaling a second
  // time crops a strip off the side of the popup.
  const box = await page.evaluate(measure);
  const reportsZoomed = Math.abs(box.width - natural.width * zoom) <= Math.abs(box.width - natural.width);
  const width = Math.round(reportsZoomed ? box.width : box.width * zoom);
  const height = Math.round(reportsZoomed ? box.height : box.height * zoom);

  await page.resize(width, height);
  await page.evaluate(`new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 120)))`);
  process.stdout.write(`  popup ${width}x${height} at ${zoom}x\n`);
  return { shot: await page.screenshot(), width, height };
}

/**
 * Fill one of the invented sign-in pages the way the service worker would.
 *
 * `content.js` is loaded by the page itself from `dist/`, and the message below
 * is the same `fill-code` the worker sends — same code path, same field-finding,
 * same never-press list, same confirmation card.
 */
async function shootFill(page, route, { width, height }) {
  await page.resize(width, height);
  await page.open(route, { before: CONTENT_STUB });
  const result = await page.evaluate(
    `window.__ask(${JSON.stringify({
      type: 'fill-code',
      code: CODE,
      submit: true,
      toast: true,
      sender: senderName(messageOf('invented-orchard').from),
    })})`,
  );
  if (!result?.filled) {
    throw new Error(`store-shots: ${route} was not filled: ${JSON.stringify(result)}`);
  }
  // The confirmation card animates in and clears itself after 4.5 seconds.
  await page.evaluate(`new Promise((resolve) => setTimeout(resolve, 400))`);
  return { shot: await page.screenshot(), result };
}

/* ------------------------------------------------------------------ *
 * The run
 * ------------------------------------------------------------------ */

async function main() {
  if (!findChrome()) {
    console.error(
      'store-shots: no Chrome found. Set CHROME_PATH to a Chrome or Chromium binary.\n' +
        'The store images are rendered by loading dist/ in a real browser; there is no other way to get them.',
    );
    process.exit(1);
  }
  try {
    await readFile(path.join(root, 'dist', 'popup.html'));
  } catch {
    console.error('store-shots: no dist/. Run `npm run build` first — the pictures come from what ships.');
    process.exit(1);
  }

  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });

  pages.set('demo/sign-in.html', html(signInPage));
  pages.set('demo/device.html', html(devicePage));
  pages.set('frames/tile.html', html(tilePage));

  const { page, close } = await open({ width: WIDTH, height: HEIGHT, pages });

  try {
    // Fixed, so the pictures do not depend on the machine's theme, and so the
    // confirmation card is captured settled rather than mid-transition.
    await page.emulateMedia([
      { name: 'prefers-color-scheme', value: 'light' },
      { name: 'prefers-reduced-motion', value: 'reduce' },
    ]);

    /* -- 01: the code, and why it is that one ---------------------- */

    const codeShot = await shootPopup(
      page,
      status({ watching: null }),
      `document.getElementById('code-why').open = true`,
    );
    pages.set('shots/popup-code.png', png(codeShot.shot));

    await frame(
      page,
      '01-code-1280x800',
      splitFrame({
        eyebrow: 'The code, and why that one',
        title: 'The newest code from your inbox, without leaving the page',
        note:
          'Open the popup, or press the shortcut. 2FA Paster reads the mail that just arrived, ' +
          'picks the number that is actually a one-time code, and says how sure it is.',
        points: [
          'Scored rather than grabbed — and it shows the reasons for the score',
          'Knows an order number, a year, a price and a phone number are not codes',
          'Prefers the mail that came from the site you are signing in to',
          'Fill the page, or copy — the code is on screen either way',
        ],
        foot:
          'Interface rendered by the shipped build. The mail behind this picture is invented and the ' +
          'sender does not exist — but the score and the reasons are computed by the extension’s own scorer.',
        shots: ['/shots/popup-code.png'],
      }),
    );

    /* -- 02: the fill ---------------------------------------------- */

    const fill = await shootFill(page, 'demo/sign-in.html', { width: 980, height: 586 });
    pages.set('shots/fill.png', png(fill.shot));

    await frame(
      page,
      '02-fill-1280x800',
      heroFrame({
        eyebrow: 'Into the box',
        title: 'It finds the code box and types the code into it',
        note:
          'Single fields, six one-character boxes, fields inside an iframe, and inputs a framework ' +
          'controls. It says so on the page afterwards, so an automatic fill never looks like the site acting alone.',
        shots: ['/shots/fill.png'],
      }),
    );

    /* -- 03: the buttons it will not press ------------------------- */

    const guard = await shootFill(page, 'demo/device.html', { width: 980, height: 618 });
    pages.set('shots/guard.png', png(guard.shot));
    if (guard.result.submitKind !== 'clicked') {
      throw new Error(`store-shots: the guard page was submitted by "${guard.result.submitKind}", not a click`);
    }

    await frame(
      page,
      '03-guard-1280x800',
      heroFrame({
        eyebrow: 'What it will not press',
        title: 'It presses the button that finishes the step, and no other',
        note:
          '“Resend code” is a submit button on plenty of forms, and pressing it invalidates the code just filled in. ' +
          'Anything that deletes, removes, revokes, resends or cancels is skipped, in every inflection — ' +
          'and only buttons inside the same form are considered at all.',
        shots: ['/shots/guard.png'],
      }),
    );

    /* -- 04: two codes at once ------------------------------------- */

    const recentShot = await shootPopup(
      page,
      status({ watching: { tabId: 1, origin: SITE, startedAt: NOW, until: NOW + 96000 } }),
      `document.getElementById('history-card').open = true`,
    );
    pages.set('shots/popup-recent.png', png(recentShot.shot));

    await frame(
      page,
      '04-recent-1280x800',
      splitFrame({
        eyebrow: 'When two arrive at once',
        title: 'Which code was for which site, a minute after the fact',
        note:
          'A busy inbox delivers more than one code in the same minute. The recent list names the sender of ' +
          'each and where it went, and one click puts a different one into the page.',
        points: [
          'Codes identifiably from another service are never filled in unasked',
          'Nothing is typed in unattended below the confidence bar',
          'Watching stops when the tab closes or leaves the site',
          'The list lives in memory and is gone in half an hour, or immediately on Clear',
        ],
        foot:
          'Interface rendered by the shipped build. Three invented services on the reserved .example ' +
          'domain; no real mail was read to make this picture.',
        shots: ['/shots/popup-recent.png'],
      }),
    );

    /* -- 05: what it can see --------------------------------------- */

    await page.resize(660, 1200);
    await page.open('options.html', { before: stub(status()) });
    await page.evaluate(`new Promise((resolve) => setTimeout(resolve, 250))`);

    const cards = await page.evaluate(`
      (() => {
        const box = (selector) => {
          const rect = document.querySelector(selector).getBoundingClientRect();
          return {
            x: Math.round(rect.x + window.scrollX),
            y: Math.round(rect.y + window.scrollY),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          };
        };
        return { source: box('[aria-labelledby="source-title"]'), privacy: box('[aria-labelledby="privacy-title"]') };
      })()
    `);

    pages.set('shots/options-source.png', png(await page.screenshot({ clip: cards.source })));
    pages.set('shots/options-privacy.png', png(await page.screenshot({ clip: cards.privacy })));

    await frame(
      page,
      '05-privacy-1280x800',
      splitFrame({
        eyebrow: 'What it can see',
        title: 'The default reader needs no account, and sees less',
        note:
          'Out of the box it reads Gmail’s own inbox feed with the session your browser already has: ' +
          'unread inbox mail only, and only the sender, subject, a snippet and a time. Full messages are ' +
          'an option you turn on, with an OAuth client that belongs to your Google account.',
        points: [
          'No server of ours, no analytics, no third-party code, no dependencies',
          'Message text is scanned for a code and dropped — never stored',
          'Codes live in memory and go when Chrome closes',
          'Three hosts are ever contacted, all Google’s',
        ],
        foot:
          'Both panels are the extension’s own settings page, rendered by the shipped build, ' +
          'showing the default reader in the state it reaches once you are signed in to Gmail.',
        shots: ['/shots/options-source.png', '/shots/options-privacy.png'],
      }),
    );

    /* -- the promotional tile -------------------------------------- */

    await page.resize(TILE.width, TILE.height);
    await page.open('frames/tile.html');
    await page.evaluate(
      `Promise.all([...document.images].map((image) => image.decode())).then(() => document.fonts.ready)`,
    );
    await emit('promo-440x280.png', await page.screenshot(), TILE);
  } finally {
    await close();
  }

  console.log(`\nstore-assets/ (${written.length} files)`);
  for (const line of written) console.log(`  ${line}`);
}

await main();

/**
 * The popup and the options page, rendered.
 *
 * Three classes of defect live here and none of them are reachable from Node.
 *
 * *Hit testing.* A decorative span painted over a checkbox makes a switch that
 * looks perfect and cannot be clicked. `document.elementFromPoint` is the only
 * thing that knows.
 *
 * *Layout shift.* Flipping a switch that changes the height of its own row moves
 * everything below it, so the next click lands on the wrong control. Measurable
 * only after a real layout.
 *
 * *Narrow-width overflow.* The options page carries a seven-scene setup
 * walkthrough. Twice, a review found its Back/Next controls sitting outside the
 * viewport at 320-400px, reachable only by scrolling the document sideways. The
 * cause was two `display: grid` containers with an implicit `auto` track, which
 * cannot size below their content's min-content contribution, so the grid widened
 * past its own parent. It was fixed by giving them `minmax(0, 1fr)` — and that
 * fix had no test, which is how it would have come back. The `scrollWidth ===
 * clientWidth` checks below are that test.
 *
 * The per-element overflow check matters more than the document one: the second
 * container never scrolled the document at all. Its label simply painted outside
 * its own box and across the input below it, which no page-level width assertion
 * would ever have noticed.
 */

/** Everything `buildStatus` returns, as the pages expect to receive it. */
const BASE_STATUS = {
  source: 'feed',
  ready: true,
  problem: null,
  email: 'you@example.com',
  accounts: [{ index: 0, account: 'you@example.com' }],
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
    code: '482913',
    messageId: 'm1',
    from: 'Example <noreply@example.com>',
    subject: 'Your verification code',
    senderSite: 'example.com',
    receivedAt: 0,
    foundAt: 0,
    confidence: 82,
    reasons: ['6 digits', 'in the subject'],
    siteMatch: true,
    ambiguous: false,
    site: 'example.com',
  },
  history: [
    {
      code: '771204',
      messageId: 'm2',
      from: 'Other <s@other.example>',
      subject: 'Other code',
      senderSite: 'other.example',
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
  extensionId: 'browsertestextensionidbrowsertest',
  tab: { id: 7, url: 'https://example.com/login', site: 'example.com', title: 'Sign in' },
};

const clone = (extra = {}, settings = {}) => ({
  ...structuredClone(BASE_STATUS),
  ...extra,
  settings: { ...structuredClone(BASE_STATUS.settings), ...settings },
});

/** A stand-in service worker, answering the messages both pages send. */
function stub(status) {
  return `(() => {
    const status = ${JSON.stringify(status)};
    // Ages are rendered relative to now, so fixed timestamps would drift.
    if (status.lastCode) status.lastCode.receivedAt = status.lastCode.foundAt = Date.now() - 30000;
    for (const row of status.history ?? []) {
      row.receivedAt = row.seenAt = Date.now() - 120000;
    }
    if (status.watching) status.watching.until = Date.now() + 90000;

    window.__sent = [];
    window.chrome = {
      runtime: {
        id: status.extensionId,
        lastError: undefined,
        getURL: (path) => path,
        openOptionsPage: () => {},
        sendMessage: async (message) => {
          window.__sent.push(message);
          if (message.type === 'status') return { ok: true, status: structuredClone(status) };
          if (message.type === 'settings') {
            Object.assign(status.settings, message.patch);
            return { ok: true, settings: structuredClone(status.settings) };
          }
          if (message.type === 'has-field') return { ok: true, hasField: true };
          if (message.type === 'refill') {
            return {
              ok: true,
              found: true,
              result: status.__refill ?? { code: '482913', filled: true, submitted: true, copied: true },
            };
          }
          return { ok: true };
        },
      },
      commands: { getAll: async () => [{ name: 'paste-code', shortcut: 'Ctrl+Shift+2' }] },
      permissions: { request: async () => false, contains: async () => false },
      storage: { onChanged: { addListener: () => {} } },
      tabs: { create: async () => {} },
    };
  })()`;
}

/**
 * Widths worth checking, and why each one.
 *
 * 340 is 680 at 200% browser zoom, which is a common accessibility setting and
 * reaches the narrow layout by a different route than a small window.
 */
const NARROW_WIDTHS = [
  [560, 'the breakpoint itself'],
  [400, 'a narrow window'],
  [340, '680 at 200% zoom'],
  [320, 'the narrowest common phone width'],
];

/**
 * @param {import('./harness.mjs').Page} page
 * @param {ReturnType<import('./harness.mjs').reporter>} report
 */
export async function run(page, report) {
  const { check } = report;

  /* ---------------------------------------------------------------- *
   * Every state the popup can be in
   * ---------------------------------------------------------------- */

  await page.resize(380, 640);

  const states = [
    ['a code in hand', clone()],
    ['nothing found yet', clone({ lastCode: null, history: [] })],
    ['no code, but a recent list', clone({ lastCode: null })],
    ['watching the inbox', clone({ watching: { tabId: 7, origin: 'example.com', startedAt: 0, until: 0 } })],
    ['no Gmail session', clone({ ready: false, email: '', accounts: [], lastCode: null, history: [] })],
    [
      'the API reader with no client ID',
      clone({ ready: false, source: 'api', accounts: [], lastCode: null }, { source: 'api' }),
    ],
    [
      'a code that could belong to anyone',
      clone({ lastCode: { ...structuredClone(BASE_STATUS.lastCode), siteMatch: false, ambiguous: true } }),
    ],
    ['no page to fill', clone({ tab: null, lastCode: null, history: [] })],
    ['an error from the worker', clone({ ready: false, problem: { kind: 'offline', message: 'Could not reach Gmail.' }, lastCode: null, history: [] })],
  ];

  for (const [name, status] of states) {
    const complaints = await page.open('popup.html', { before: stub(status) });
    check(complaints.length === 0, `popup with ${name}: ${complaints.join(' | ')}`);
  }

  /* ---------------------------------------------------------------- *
   * The switches can actually be clicked
   * ---------------------------------------------------------------- */

  await page.open('popup.html', { before: stub(clone()) });

  const hits = await page.evaluate(`
    (() => {
      const out = [];
      for (const input of document.querySelectorAll('.switch input')) {
        input.scrollIntoView({ block: 'center' });
        const box = input.getBoundingClientRect();
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        out.push({ id: input.id, ok: hit === input, hit: hit ? (hit.id || hit.className || hit.tagName) : 'nothing' });
      }
      return out;
    })()
  `);
  for (const hit of hits) {
    check(hit.ok, `popup: a click on the ${hit.id} switch lands on "${hit.hit}", not the checkbox`);
  }
  check(hits.length > 0, 'popup: no switches were found to test');

  // And once through Chrome's own hit testing, not `elementFromPoint`.
  const before = await page.evaluate(`document.getElementById('auto-submit').checked`);
  const box = await page.evaluate(`
    (() => {
      const rect = document.getElementById('auto-submit').getBoundingClientRect();
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    })()
  `);
  await page.click(box.x, box.y);
  const after = await page.evaluate(`document.getElementById('auto-submit').checked`);
  const patches = await page.evaluate(
    `JSON.stringify(window.__sent.filter((m) => m.type === 'settings').map((m) => m.patch))`,
  );
  check(before !== after, `popup: a real click on the auto-submit switch did not change it (stayed ${before})`);
  check(patches.includes('autoSubmit'), `popup: a real click sent no setting change: ${patches}`);

  /* ---------------------------------------------------------------- *
   * The popup does not claim a copy that did not happen
   * ---------------------------------------------------------------- */

  {
    // "Also copy to the clipboard" is a setting. With it off and the page
    // refusing the fill, the popup used to say "Copied it" regardless — which
    // sends someone to paste nothing into a form that is waiting for a code.
    for (const [reason, why] of [
      ['blocked', 'a page Chrome will not let us script'],
      ['rejected', 'a page that refused the typed value'],
    ]) {
      await page.open('popup.html', {
        before: stub(
          clone(
            { __refill: { code: '482913', filled: false, fillReason: reason, copied: false } },
            { autoCopy: false },
          ),
        ),
      });
      await page.evaluate(`document.getElementById('fill-button').click()`);
      await page.evaluate(`new Promise((resolve) => setTimeout(resolve, 300))`);
      const said = await page.evaluate(`document.getElementById('status').textContent`);
      check(
        !/copied/i.test(said),
        `popup on ${why} with copying off: said "${said}", which claims a copy that did not happen`,
      );
      check(said.trim().length > 0, `popup on ${why}: said nothing at all`);
    }
  }

  /* ---------------------------------------------------------------- *
   * Nothing moves when a switch is flipped
   * ---------------------------------------------------------------- */

  await page.open('popup.html', { before: stub(clone()) });

  const shift = await page.evaluate(`
    (async () => {
      const top = (selector) => {
        const element = document.querySelector(selector);
        return element ? Math.round(element.getBoundingClientRect().top) : null;
      };
      const snapshot = () => ({
        code: top('#code-card'),
        history: top('#history-card'),
        height: document.body.scrollHeight,
      });
      const input = document.getElementById('auto-submit');
      const start = snapshot();
      input.click();
      await new Promise((resolve) => setTimeout(resolve, 350));
      const flipped = snapshot();
      input.click();
      await new Promise((resolve) => setTimeout(resolve, 350));
      return { start, flipped, back: snapshot() };
    })()
  `);
  for (const key of ['code', 'history', 'height']) {
    check(
      shift.start[key] === shift.flipped[key] && shift.flipped[key] === shift.back[key],
      `popup: ${key} moved when a switch was flipped: ${shift.start[key]} -> ${shift.flipped[key]} -> ${shift.back[key]}`,
    );
  }

  /* ---------------------------------------------------------------- *
   * The options page, at every width it has to survive
   * ---------------------------------------------------------------- */

  await page.resize(1024, 900);
  const optionsComplaints = await page.open('options.html', { before: stub(clone()) });
  check(optionsComplaints.length === 0, `options page: ${optionsComplaints.join(' | ')}`);

  const optionSwitches = await page.evaluate(`
    (() => {
      const out = [];
      for (const input of document.querySelectorAll('.switch input')) {
        // The options page is long, and elementFromPoint is viewport-relative:
        // anything below the fold reports null unless it is scrolled to first.
        input.scrollIntoView({ block: 'center' });
        const rect = input.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        out.push({ id: input.id, ok: hit === input, hit: hit ? (hit.id || hit.className || hit.tagName) : 'nothing' });
      }
      return out;
    })()
  `);
  for (const hit of optionSwitches) {
    check(hit.ok, `options: a click on the ${hit.id} switch lands on "${hit.hit}", not the checkbox`);
  }

  /* ---------------------------------------------------------------- *
   * There is always a way to throw everything away
   * ---------------------------------------------------------------- */

  {
    // The privacy policy points at this button as the way to clear what is
    // stored. It used to be revealed only on the connected-API path, so under the
    // default reader — the one that needs no setup and is what almost everyone
    // runs — the control the policy describes was not on the page at all.
    const forget = [
      ['the default inbox-preview reader', clone(), 'Forget everything stored'],
      [
        'the connected API reader',
        clone({ source: 'api', ready: true, apiConfigured: true }, { source: 'api' }),
        'Disconnect and forget',
      ],
      [
        'the API reader before it is connected',
        clone({ source: 'api', ready: false, apiConfigured: true }, { source: 'api' }),
        'Disconnect and forget',
      ],
    ];

    for (const [name, status, label] of forget) {
      await page.open('options.html', { before: stub(status) });
      const button = await page.evaluate(`
        (() => {
          const element = document.getElementById('disconnect-button');
          const rect = element.getBoundingClientRect();
          return { hidden: element.hidden, text: element.textContent.trim(), width: Math.round(rect.width) };
        })()
      `);
      check(button.hidden === false, `options with ${name}: no way to forget what is stored — the button is hidden`);
      check(button.width > 0, `options with ${name}: the forget button has no box`);
      check(button.text === label, `options with ${name}: the button reads "${button.text}", expected "${label}"`);
    }
  }

  for (const [width, why] of NARROW_WIDTHS) {
    await page.resize(width, 900);
    await page.open('options.html', { before: stub(clone()) });

    const layout = await page.evaluate(`
      (() => {
        const root = document.documentElement;
        // Every control a user must be able to reach to complete setup or change
        // a setting. An off-screen "Next" is a broken walkthrough.
        const required = [
          ...document.querySelectorAll(
            '.switch input, .tour-nav-button, .tour-play-button, [data-tour-go], button, select, input[type="text"], input[type="number"]',
          ),
        ].filter((element) => element.offsetParent !== null || element.getClientRects().length > 0);

        const outside = required
          .map((element) => {
            const rect = element.getBoundingClientRect();
            return { text: (element.id || element.textContent || element.tagName).trim().slice(0, 40), right: Math.round(rect.right) };
          })
          .filter((entry) => entry.right > root.clientWidth + 1);

        // An element wider than its own box paints over whatever is beside it,
        // without ever widening the document.
        const clipped = [];
        for (const element of document.querySelectorAll('body *')) {
          if (element.scrollWidth > element.clientWidth + 1 && getComputedStyle(element).overflowX === 'visible') {
            clipped.push({
              tag: (element.id || element.className || element.tagName).toString().slice(0, 40),
              scroll: element.scrollWidth,
              client: element.clientWidth,
            });
          }
        }

        return {
          clientWidth: root.clientWidth,
          scrollWidth: root.scrollWidth,
          required: required.length,
          outside,
          clipped: clipped.slice(0, 5),
        };
      })()
    `);

    check(
      layout.scrollWidth === layout.clientWidth,
      `options at ${width}px (${why}): the document scrolls sideways — ${layout.scrollWidth} wide in a ${layout.clientWidth} viewport`,
    );
    check(
      layout.outside.length === 0,
      `options at ${width}px (${why}): ${layout.outside.length} controls sit outside the viewport: ${JSON.stringify(layout.outside)}`,
    );
    check(
      layout.clipped.length === 0,
      `options at ${width}px (${why}): elements overflow their own box and paint over their neighbours: ${JSON.stringify(layout.clipped)}`,
    );
    check(layout.required > 20, `options at ${width}px: only ${layout.required} controls rendered, expected the whole page`);
  }

  /* ---------------------------------------------------------------- *
   * The setup walkthrough
   * ---------------------------------------------------------------- */

  await page.resize(1024, 900);
  await page.open('options.html', { before: stub(clone()) });

  const tour = await page.evaluate(`
    (async () => {
      const scenes = [...document.querySelectorAll('[data-tour-scene]')];
      // Only one scene is in the document at a time: the rest carry \`hidden\`.
      // Reading opacity instead would be measuring a display:none element, which
      // reports its specified value and answers the wrong question.
      const painted = () =>
        scenes.filter((scene) => {
          const rect = scene.getBoundingClientRect();
          return !scene.hidden && rect.width > 0 && rect.height > 0;
        });

      // Pausing motion must not make the selected scene disappear: it pauses the
      // animation that is also what fades a scene in.
      document.getElementById('tour-play-button').click();
      await new Promise((resolve) => setTimeout(resolve, 200));
      const pausedVisible = painted().length;

      const reached = new Set();
      for (let step = 0; step < scenes.length; step++) {
        document.getElementById('tour-next-button').click();
        await new Promise((resolve) => setTimeout(resolve, 120));
        const shown = painted();
        if (shown.length !== 1) return { error: shown.length + ' scenes on screen at step ' + step };
        reached.add(scenes.indexOf(shown[0]));
      }

      return {
        scenes: scenes.length,
        pausedVisible,
        reached: reached.size,
        autoplayOff: document.getElementById('tour-auto-button').textContent.includes('Start'),
        announced: document.getElementById('tour-announcer').textContent.trim(),
      };
    })()
  `);

  check(!tour.error, `walkthrough: ${tour.error}`);
  check(tour.scenes === 7, `walkthrough: ${tour.scenes} scenes, expected 7`);
  check(tour.pausedVisible === 1, `walkthrough: ${tour.pausedVisible} scenes visible with motion paused, expected exactly 1`);
  check(tour.reached === tour.scenes, `walkthrough: Next reached ${tour.reached} of ${tour.scenes} scenes`);
  check(tour.autoplayOff === true, 'walkthrough: pressing Next left autoplay running, so it keeps moving under you');
  check(tour.announced.length > 0, 'walkthrough: manual navigation announced nothing to assistive technology');

  /* ---------------------------------------------------------------- *
   * Reduced motion
   * ---------------------------------------------------------------- */

  await page.emulateMedia([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.open('options.html', { before: stub(clone()) });

  const reduced = await page.evaluate(`
    (async () => {
      const scenes = [...document.querySelectorAll('[data-tour-scene]')];
      const painted = () =>
        scenes.filter((scene) => !scene.hidden && scene.getBoundingClientRect().height > 0);

      const before = painted().length;
      const reached = new Set();
      for (let step = 0; step < scenes.length; step++) {
        document.getElementById('tour-next-button').click();
        await new Promise((resolve) => setTimeout(resolve, 60));
        const shown = painted();
        if (shown.length === 1) reached.add(scenes.indexOf(shown[0]));
      }

      return {
        before,
        reached: reached.size,
        animations: document.getAnimations().length,
        motionDisabled: document.getElementById('tour-play-button').disabled,
        autoplayOff: document.getElementById('tour-auto-button').textContent.includes('Start'),
      };
    })()
  `);
  // Reduced motion turns the walkthrough into a static, manually-driven set of
  // scenes. It must stay usable, not become an empty box.
  check(reduced.before === 1, `reduced motion: ${reduced.before} scenes on screen at load, expected exactly 1`);
  check(reduced.reached === 7, `reduced motion: Back/Next reached ${reduced.reached} of 7 scenes`);
  check(reduced.animations === 0, `reduced motion: ${reduced.animations} animations are still running`);
  check(reduced.motionDisabled === true, 'reduced motion: the motion control is still offered, with nothing to control');
  check(reduced.autoplayOff === true, 'reduced motion: autoplay is on by default, which is the thing being asked to stop');
  await page.emulateMedia([]);
}

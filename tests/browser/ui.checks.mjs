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
 *
 * A fourth class arrived with the decision card: *the words*. "Pressed Verify",
 * "Skipped 'Security code' — card field", "Held — check the sender" are the whole
 * point of that card, and each is assembled from a record by a renderer. The
 * checks below render the states and read the sentences back.
 */

/** A delivered code as `deliver` stores it, with the outcome the card lists. */
const LAST_CODE = {
  code: '482913',
  messageId: 'm1',
  from: 'Example <noreply@example.com>',
  address: 'noreply@example.com',
  subject: 'Your verification code',
  senderSite: 'example.com',
  receivedAt: 0,
  link: 'https://mail.google.com/mail?message_id=m1&view=conv',
  account: 'you@example.com',
  foundAt: 0,
  confidence: 82,
  reasons: ['6 digits', 'in the subject'],
  siteMatch: true,
  ambiguous: false,
  held: false,
  site: 'example.com',
  outcome: {
    filled: true,
    fillReason: '',
    kind: 'single',
    boxes: 1,
    label: 'Verification code',
    submitted: true,
    submitKind: 'clicked',
    pressed: 'Verify',
    held: false,
    submitWanted: true,
    refused: [{ label: 'Security code', rule: 'card field' }],
    copied: true,
    error: '',
  },
};

/** The same code, held: several arrived, none tied to the site, filled and not submitted. */
const HELD_CODE = {
  ...LAST_CODE,
  code: '558102',
  from: 'Account Team <noreply@accountprotection.net>',
  address: 'noreply@accountprotection.net',
  senderSite: 'accountprotection.net',
  siteMatch: false,
  ambiguous: true,
  held: true,
  outcome: { ...LAST_CODE.outcome, submitted: false, submitKind: '', pressed: '', held: true, refused: [], copied: false },
};

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
  lastCode: LAST_CODE,
  history: [
    {
      code: '771204',
      messageId: 'm2',
      from: 'Security <bounce@sendgrid.net>',
      subject: 'Your verification code',
      senderSite: 'sendgrid.net',
      receivedAt: 0,
      seenAt: 0,
      confidence: 70,
      link: '',
      account: 'you@example.com',
      siteMatch: false,
      site: '',
      filled: false,
      submitted: false,
    },
  ],
  watching: null,
  autoGranted: false,
  guide: false,
  extensionId: 'browsertestextensionidbrowsertest',
  tab: { id: 7, url: 'https://example.com/login', site: 'example.com', title: 'Sign in' },
};

const clone = (extra = {}, settings = {}) => ({
  ...structuredClone(BASE_STATUS),
  ...extra,
  settings: { ...structuredClone(BASE_STATUS.settings), ...settings },
});

/**
 * A stand-in service worker, answering the messages both pages send.
 *
 * `__field`, `__paste`, `__refill` and `__submit` on the status are what the
 * stub answers those four messages with, so a check can stage an outcome.
 */
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
    window.__opened = [];
    window.chrome = {
      runtime: {
        id: status.extensionId,
        lastError: undefined,
        getURL: (path) => path,
        openOptionsPage: () => { window.__opened.push('options'); },
        sendMessage: async (message) => {
          window.__sent.push(message);
          if (message.type === 'status') return { ok: true, status: structuredClone(status) };
          if (message.type === 'settings') {
            Object.assign(status.settings, message.patch);
            return { ok: true, settings: structuredClone(status.settings) };
          }
          if (message.type === 'has-field') return status.__field ?? { ok: true, hasField: true, blocked: false, refused: [] };
          if (message.type === 'paste') return status.__paste ?? { ok: true, found: false };
          if (message.type === 'refill') {
            // The worker records what a re-fill did before answering, so the
            // popup's next status read sees the same outcome the reply carries.
            const result = status.__refill ?? { ...status.lastCode, filled: true, submitted: true, copied: true };
            status.lastCode = result;
            return { ok: true, found: true, result };
          }
          if (message.type === 'submit') {
            const result = status.__submit ?? {
              ...status.lastCode,
              held: false,
              outcome: { ...(status.lastCode?.outcome ?? {}), submitted: true, submitKind: 'clicked', pressed: 'Verify', held: false },
            };
            status.lastCode = result;
            return { ok: true, found: true, result };
          }
          if (message.type === 'dismiss-guide') {
            status.guide = false;
            return { ok: true };
          }
          return { ok: true };
        },
      },
      commands: { getAll: async () => [{ name: 'paste-code', shortcut: 'Ctrl+Shift+2' }] },
      permissions: { request: async () => false, contains: async () => false },
      storage: { onChanged: { addListener: () => {} } },
      tabs: { create: async ({ url }) => { window.__opened.push(url); } },
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

/** The visible text of every row in the decision card. */
const OUTCOME_ROWS = `[...document.querySelectorAll('#code-outcome li')].map((li) => li.textContent)`;

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
    ['a code filled and held', clone({ lastCode: structuredClone(HELD_CODE) })],
    ['the first-run tip', clone({ guide: true })],
    [
      'two accounts',
      clone({
        email: 'you@example.com, work@example.com',
        accounts: [
          { index: 0, account: 'you@example.com' },
          { index: 1, account: 'work@example.com' },
        ],
      }),
    ],
    ['no page to fill', clone({ tab: null, lastCode: null, history: [] })],
    ['an error from the worker', clone({ ready: false, problem: { kind: 'offline', message: 'Could not reach Gmail.' }, lastCode: null, history: [] })],
  ];

  for (const [name, status] of states) {
    const complaints = await page.open('popup.html', { before: stub(status) });
    check(complaints.length === 0, `popup with ${name}: ${complaints.join(' | ')}`);
    // The popup is a fixed 380px wide. Anything wider scrolls sideways in a
    // window that cannot be resized, which is how a long address gets lost.
    const width = await page.evaluate(`document.documentElement.scrollWidth`);
    check(width <= 380, `popup with ${name}: ${width}px wide, wider than the 380px popup`);
  }

  /* ---------------------------------------------------------------- *
   * The decision card says what was done
   * ---------------------------------------------------------------- */

  {
    await page.open('popup.html', { before: stub(clone()) });
    const card = await page.evaluate(`
      (() => ({
        rows: ${OUTCOME_ROWS},
        address: document.getElementById('code-address').textContent,
        origin: document.getElementById('code-origin').textContent,
        openMail: !document.getElementById('open-mail').hidden,
        heldHidden: document.getElementById('held-actions').hidden,
      }))()
    `);
    check(
      JSON.stringify(card.rows) ===
        JSON.stringify(['Filled “Verification code”', 'Pressed Verify', 'Skipped “Security code” — card field', 'Copied to your clipboard']),
      `decision card: rows read ${JSON.stringify(card.rows)}`,
    );
    check(card.address === 'noreply@example.com', `decision card: the address line reads "${card.address}"`);
    check(
      card.origin === 'Sent by example.com — the site you are on',
      `decision card: the origin line reads "${card.origin}"`,
    );
    check(card.openMail, 'decision card: "Open in Gmail" is hidden for a code that has a link');
    check(card.heldHidden, 'decision card: the held actions show for a code that was submitted');

    // "Open in Gmail" opens the mail, and nothing else.
    await page.evaluate(`document.getElementById('open-mail').click()`);
    const opened = await page.evaluate(`JSON.stringify(window.__opened)`);
    check(opened === JSON.stringify([LAST_CODE.link]), `decision card: Open in Gmail opened ${opened}`);
  }

  /* ---------------------------------------------------------------- *
   * The held state: filled, not submitted, two ways out
   * ---------------------------------------------------------------- */

  {
    await page.open('popup.html', { before: stub(clone({ lastCode: structuredClone(HELD_CODE) })) });
    const held = await page.evaluate(`
      (() => ({
        origin: document.getElementById('code-origin').textContent,
        rows: ${OUTCOME_ROWS},
        submitVisible: !document.getElementById('held-actions').hidden && !document.getElementById('submit-anyway').hidden,
        alternatives: [...document.querySelectorAll('.alt-button strong')].map((el) => el.textContent),
        pill: document.getElementById('code-origin').className,
      }))()
    `);
    check(
      held.origin.startsWith('Held — check the sender'),
      `held: the origin line reads "${held.origin}", expected it to lead with "Held — check the sender"`,
    );
    check(held.origin.includes('none name example.com'), `held: the origin line does not name the site: "${held.origin}"`);
    check(held.pill.includes('is-unsure'), `held: the origin pill is styled "${held.pill}", not as unsure`);
    check(
      held.rows.includes('Not submitted — check the sender first'),
      `held: the rows do not say the submit was held: ${JSON.stringify(held.rows)}`,
    );
    check(held.submitVisible, 'held: no "Submit anyway" button');
    check(
      JSON.stringify(held.alternatives) === JSON.stringify(['Use 771204 instead']),
      `held: the alternatives read ${JSON.stringify(held.alternatives)}`,
    );

    // "Submit anyway" asks the worker, and the card then says what was pressed.
    await page.evaluate(`document.getElementById('submit-anyway').click()`);
    await page.evaluate(`new Promise((resolve) => setTimeout(resolve, 300))`);
    const after = await page.evaluate(`
      (() => ({
        sent: window.__sent.some((m) => m.type === 'submit' && m.tabId === 7),
        rows: ${OUTCOME_ROWS},
        heldHidden: document.getElementById('held-actions').hidden,
      }))()
    `);
    check(after.sent, 'held: "Submit anyway" did not send a submit for the current tab');
    check(after.rows.includes('Pressed Verify'), `held: after submitting, the rows read ${JSON.stringify(after.rows)}`);
    check(after.heldHidden, 'held: the held actions are still offered after the submit');
  }

  {
    // "Use … instead" re-fills with that code, through the same path as the recent list.
    await page.open('popup.html', { before: stub(clone({ lastCode: structuredClone(HELD_CODE) })) });
    await page.evaluate(`document.querySelector('.alt-button').click()`);
    await page.evaluate(`new Promise((resolve) => setTimeout(resolve, 300))`);
    const refill = await page.evaluate(
      `JSON.stringify(window.__sent.filter((m) => m.type === 'refill').map((m) => [m.tabId, m.code]))`,
    );
    check(refill === JSON.stringify([[7, '771204']]), `held: "Use 771204 instead" sent ${refill}`);
  }

  /* ---------------------------------------------------------------- *
   * Nothing found
   * ---------------------------------------------------------------- */

  {
    await page.open('popup.html', { before: stub(clone({ __paste: { ok: true, found: false } })) });
    await page.evaluate(`document.getElementById('paste-button').click()`);
    await page.evaluate(`new Promise((resolve) => setTimeout(resolve, 300))`);
    const empty = await page.evaluate(`
      (() => ({
        shown: !document.getElementById('empty-card').hidden,
        codeHidden: document.getElementById('code-card').hidden,
        body: document.getElementById('empty-body').textContent,
        hint: document.querySelector('.empty-hint').textContent.replace(/\\s+/g, ' ').trim(),
        search: !document.getElementById('open-search').hidden,
        retry: !document.getElementById('retry-button').hidden,
        upgrade: !document.getElementById('upgrade-button').hidden,
      }))()
    `);
    check(empty.shown, 'nothing found: the empty card did not appear');
    check(empty.codeHidden, 'nothing found: the old code is still on show above "Nothing found"');
    check(
      empty.body.includes('unread Primary mail') && empty.body.includes('Updates, Promotions, Social and Forums'),
      `nothing found: the body does not say what was read: "${empty.body}"`,
    );
    check(empty.body.includes('last 10 minutes'), `nothing found: the body does not state the window: "${empty.body}"`);
    check(empty.hint.includes('mark it unread'), `nothing found: the hint does not say to mark it unread: "${empty.hint}"`);
    check(empty.search && empty.retry, 'nothing found: "Open Gmail search" or "Try again" is missing');
    check(empty.upgrade, 'nothing found: the full-message reader is not offered under the feed');

    await page.evaluate(`document.getElementById('open-search').click()`);
    const opened = await page.evaluate(`JSON.stringify(window.__opened)`);
    check(
      /mail\.google\.com\/mail\/u\/0\/#search\//.test(opened) && /code/.test(opened),
      `nothing found: "Open Gmail search" opened ${opened}`,
    );

    // Try again runs the search again, from the card.
    await page.evaluate(`document.getElementById('retry-button').click()`);
    await page.evaluate(`new Promise((resolve) => setTimeout(resolve, 300))`);
    const pastes = await page.evaluate(`window.__sent.filter((m) => m.type === 'paste').length`);
    check(pastes === 2, `nothing found: "Try again" sent ${pastes - 1} further paste(s), expected 1`);
  }

  /* ---------------------------------------------------------------- *
   * The first-run tip
   * ---------------------------------------------------------------- */

  {
    await page.open('popup.html', { before: stub(clone({ guide: true })) });
    const guide = await page.evaluate(`
      (() => ({
        shown: !document.getElementById('guide-card').hidden,
        key: document.getElementById('guide-key').textContent,
        auto: !document.getElementById('guide-auto').hidden,
        text: document.getElementById('guide-card').textContent.replace(/\\s+/g, ' '),
      }))()
    `);
    check(guide.shown, 'first run: the tip is not shown when the worker says it is due');
    check(guide.key === 'Ctrl+Shift+2', `first run: the tip names the shortcut as "${guide.key}"`);
    check(guide.auto && guide.text.includes('Chrome asks once'), 'first run: the tip does not explain the permission prompt');

    await page.evaluate(`document.getElementById('guide-dismiss').click()`);
    await page.evaluate(`new Promise((resolve) => setTimeout(resolve, 200))`);
    const dismissed = await page.evaluate(`
      (() => ({
        hidden: document.getElementById('guide-card').hidden,
        sent: window.__sent.some((m) => m.type === 'dismiss-guide'),
      }))()
    `);
    check(dismissed.hidden && dismissed.sent, 'first run: "Got it" did not close the tip and tell the worker');

    await page.open('popup.html', { before: stub(clone({ guide: true }, { autoFill: true })) });
    const withAuto = await page.evaluate(`document.getElementById('guide-auto').hidden`);
    check(withAuto === true, 'first run: the tip explains turning on automatic filling to someone who has');

    await page.open('popup.html', { before: stub(clone({ guide: false })) });
    check(await page.evaluate(`document.getElementById('guide-card').hidden`), 'first run: the tip shows when it is not due');
  }

  /* ---------------------------------------------------------------- *
   * Two accounts, and a page Chrome will not let us into
   * ---------------------------------------------------------------- */

  {
    await page.open('popup.html', {
      before: stub(
        clone({
          email: 'you@example.com, work.account.longname@company-domain.example',
          accounts: [
            { index: 0, account: 'you@example.com' },
            { index: 1, account: 'work.account.longname@company-domain.example' },
          ],
        }),
      ),
    });
    const header = await page.evaluate(`
      (() => {
        const account = document.getElementById('account');
        return {
          text: account.textContent,
          title: account.title,
          clipped: account.scrollWidth > account.clientWidth,
          address: document.getElementById('code-address').textContent,
        };
      })()
    `);
    check(header.text === '2 accounts', `two accounts: the header reads "${header.text}"`);
    check(header.title.includes('work.account.longname@company-domain.example'), 'two accounts: the tooltip does not list the addresses');
    check(!header.clipped, 'two accounts: the header is still clipped');
    check(header.address === 'noreply@example.com → you@example.com', `two accounts: the code's mailbox reads "${header.address}"`);
  }

  {
    const blocked = 'Chrome does not allow filling on this page';
    await page.open('popup.html', {
      before: stub(
        clone({
          tab: { id: 8, url: 'chrome://version/', site: '', title: 'About Version' },
          __field: { ok: true, hasField: false, blocked: true, reason: blocked, refused: [] },
          lastCode: { ...structuredClone(LAST_CODE), site: '', outcome: { ...LAST_CODE.outcome, filled: false, fillReason: 'blocked', submitted: false, pressed: '', refused: [] } },
        }),
      ),
    });
    await page.evaluate(`new Promise((resolve) => setTimeout(resolve, 200))`);
    const chromePage = await page.evaluate(`
      (() => ({ target: document.getElementById('target-field').textContent, rows: ${OUTCOME_ROWS} }))()
    `);
    check(chromePage.target === blocked, `chrome page: the target card reads "${chromePage.target}"`);
    check(chromePage.rows[0] === blocked, `chrome page: the outcome reads ${JSON.stringify(chromePage.rows)}`);
  }

  {
    // A page with no code box says which fields it looked at.
    await page.open('popup.html', {
      before: stub(
        clone({
          lastCode: null,
          __field: { ok: true, hasField: false, blocked: false, refused: [{ label: 'Security code', rule: 'card field' }] },
        }),
      ),
    });
    await page.evaluate(`new Promise((resolve) => setTimeout(resolve, 200))`);
    const target = await page.evaluate(`document.getElementById('target-field').textContent`);
    check(
      target === 'No code box — skipped “Security code” (card field)',
      `refused field: the target card reads "${target}"`,
    );
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

  // The note under the automatic-filling switch says, before the flip, that Chrome
  // will ask and the popup will close. Saying it afterwards is too late.
  const note = await page.evaluate(`document.getElementById('auto-note').textContent`);
  check(
    /Chrome asks once/.test(note) && /popup closes/.test(note),
    `popup: the auto-fill note does not warn about the prompt: "${note}"`,
  );

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
            {
              __refill: {
                ...structuredClone(LAST_CODE),
                filled: false,
                fillReason: reason,
                copied: false,
                outcome: { ...LAST_CODE.outcome, filled: false, fillReason: reason, submitted: false, pressed: '', refused: [], copied: false },
              },
            },
            { autoCopy: false },
          ),
        ),
      });
      await page.evaluate(`document.getElementById('fill-button').click()`);
      await page.evaluate(`new Promise((resolve) => setTimeout(resolve, 300))`);
      const said = await page.evaluate(`${OUTCOME_ROWS}.join(' | ')`);
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
   * Keyboard and screen reader
   * ---------------------------------------------------------------- */

  for (const [name, width, height, status] of [
    ['popup.html', 380, 640, clone()],
    ['popup.html (held)', 380, 640, clone({ lastCode: structuredClone(HELD_CODE), guide: true })],
    ['options.html', 1024, 900, clone()],
  ]) {
    await page.resize(width, height);
    await page.open(name.split(' ')[0], { before: stub(status) });

    // Open every disclosure first, so the controls inside one are held to the
    // same standard as the rest. Closed is not the interesting state: Chrome now
    // hides collapsed `<details>` content with `content-visibility` rather than
    // `display: none`, so those controls still have a layout box while being
    // correctly unreachable — which reads as a keyboard trap and is not one.
    await page.evaluate(`
      (() => {
        for (const details of document.querySelectorAll('details')) details.open = true;
      })()
    `);
    await page.evaluate(`new Promise((resolve) => requestAnimationFrame(resolve))`);

    // An icon-only button is a blank to a screen reader unless something names
    // it. The settings gear in the popup is the case this exists for.
    const unnamed = await page.evaluate(`
      (() => {
        const named = (element) => {
          const own = (element.textContent ?? '').trim();
          if (own) return true;
          for (const attribute of ['aria-label', 'title', 'alt', 'value']) {
            if ((element.getAttribute(attribute) ?? '').trim()) return true;
          }
          const by = element.getAttribute('aria-labelledby');
          if (by && by.split(/\\s+/).some((id) => (document.getElementById(id)?.textContent ?? '').trim())) {
            return true;
          }
          return element.labels ? [...element.labels].some((label) => (label.textContent ?? '').trim()) : false;
        };

        return [...document.querySelectorAll('button, a[href], select, input:not([type="hidden"])')]
          .filter((element) => element.offsetParent !== null || element.getClientRects().length > 0)
          .filter((element) => !named(element))
          .map((element) => element.id || element.className || element.tagName)
          .slice(0, 8);
      })()
    `);
    check(unnamed.length === 0, `${name}: controls with no accessible name: ${JSON.stringify(unnamed)}`);

    // Walk the page with Tab, the way somebody who cannot use a mouse does. Two
    // things are being asked at once: does focus reach every control, and can you
    // see where it is when it gets there.
    await page.evaluate(`document.body.focus()`);

    // Tag every control with something unique before walking, rather than
    // identifying it afterwards by id or class. Half of these controls share a
    // class — seven `tour-dot`s, eight `step-watch-button`s — so counting
    // distinct names undercounts badly and reads as a page that cannot be
    // reached by keyboard when it can.
    const stops = await page.evaluate(`
      (() => {
        const candidates = [...document.querySelectorAll(
          'button, a[href], select, input:not([type="hidden"]), [tabindex="0"]',
        )]
          .filter((element) => element.offsetParent !== null || element.getClientRects().length > 0)
          .filter((element) => !element.disabled);

        const keys = new Set();
        candidates.forEach((element, index) => {
          // A radio group is one tab stop on purpose: Tab enters the group and
          // the arrow keys move within it. Counting each radio separately would
          // report a correct page as broken.
          const key = element.type === 'radio' ? 'radio:' + element.name : 'control:' + index;
          element.setAttribute('data-tab-probe', key);
          keys.add(key);
        });
        return keys.size;
      })()
    `);

    const reached = new Set();
    const unfocusable = [];
    // A few extra presses so the ring has a chance to come round again.
    for (let step = 0; step < stops + 6; step++) {
      await page.press('Tab', { virtualKey: 9 });
      const at = await page.evaluate(`
        (() => {
          const element = document.activeElement;
          if (!element || element === document.body) return null;
          const style = getComputedStyle(element);
          const outlined =
            (style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0) ||
            style.boxShadow !== 'none';
          return {
            probe: element.getAttribute('data-tab-probe'),
            id: element.id || element.className || element.tagName,
            outlined,
          };
        })()
      `);
      if (!at) continue;
      if (at.probe) reached.add(at.probe);
      if (!at.outlined && !unfocusable.includes(at.id)) unfocusable.push(at.id);
    }

    check(
      reached.size >= stops,
      `${name}: Tab reached ${reached.size} of ${stops} controls, so some are mouse-only`,
    );
    check(
      unfocusable.length === 0,
      `${name}: focused with no visible ring, so you cannot tell where you are: ${JSON.stringify(unfocusable.slice(0, 6))}`,
    );
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

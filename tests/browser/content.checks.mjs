/**
 * What `content.js` does to a real page.
 *
 * This is the file that types a credential into someone's browser and then
 * presses a button, and until this harness existed nothing tested it. The
 * expensive mistakes it can make are not crashes — they are confident wrong
 * answers:
 *
 *   - filling the CVV box on a checkout page, because "security code" is what
 *     that field is labelled;
 *   - filling a postcode, a password, or a search box, because they are the only
 *     input on the page and the page says "code" somewhere;
 *   - clicking "Resend code", which is a submit button on plenty of forms and
 *     invalidates the code that was just filled in;
 *   - clicking anything at all on a form whose only buttons are destructive.
 *
 * Every one of those is a page-shaped question. So each check below is a fixture
 * page in `fixtures/`, loaded with a stub `chrome` in front of it, driven through
 * the same two messages the service worker sends.
 *
 * The silence contract is worth stating because it looks like a missing case: a
 * frame with no code box must not reply *at all*. A fill is addressed to every
 * frame in the tab and Chrome uses the first reply, so an outer document that
 * politely answered "nothing here" would beat the iframe that has the field.
 * `__ask` resolves to `null` for that, and `null` is the expected value in every
 * refusal check below.
 */

/**
 * The extension environment a content script expects, and a way to talk to it.
 *
 * Installed before the page's own scripts run, because `content.js` reaches for
 * `chrome.runtime.onMessage` as soon as it is parsed.
 */
export const STUB = `(() => {
  window.__reports = [];
  window.__listenerCount = 0;
  window.chrome = {
    runtime: {
      id: 'browsertestextensionidbrowsertest',
      lastError: undefined,
      getURL: (path) => path,
      onMessage: {
        addListener: (fn) => {
          window.__listenerCount += 1;
          window.__listener = fn;
        },
      },
      sendMessage: (message, callback) => {
        window.__reports.push(message);
        if (typeof callback === 'function') callback();
      },
    },
  };

  /**
   * Send one message the way the service worker does, and resolve with the reply
   * — or with null when the frame deliberately stayed silent.
   */
  window.__ask = (message) => new Promise((resolve) => {
    if (typeof window.__listener !== 'function') {
      resolve({ __noListener: true });
      return;
    }
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const willAnswerLater = window.__listener(message, {}, finish);
    // A listener that returns anything but true has finished with this message.
    // If it never called sendResponse, that is the silence contract.
    if (willAnswerLater !== true) setTimeout(() => finish(null), 0);
    else setTimeout(() => finish({ __timeout: true }), 8000);
  });
})()`;

const CODE = '482913';

/** @param {import('./harness.mjs').Page} page */
const ask = (page, message) => page.evaluate(`window.__ask(${JSON.stringify(message)})`);

const fillMessage = (extra = {}) => ({
  type: 'fill-code',
  code: CODE,
  submit: true,
  toast: false,
  sender: 'Example',
  ...extra,
});

/**
 * @param {import('./harness.mjs').Page} page
 * @param {ReturnType<import('./harness.mjs').reporter>} report
 */
export async function run(page, report) {
  const { check } = report;

  /* ---------------------------------------------------------------- *
   * It fills the field a page really is offering
   * ---------------------------------------------------------------- */

  {
    const complaints = await page.open('fixtures/otp-login.html', { before: STUB });
    check(complaints.length === 0, `otp-login: the page complained: ${complaints.join(' | ')}`);

    const seen = await ask(page, { type: 'has-code-field' });
    check(seen?.hasField === true, `otp-login: has-code-field answered ${JSON.stringify(seen)}`);
    check(seen?.kind === 'single', `otp-login: field kind was ${seen?.kind}`);

    const filled = await ask(page, fillMessage());
    check(filled?.filled === true, `otp-login: fill reported ${JSON.stringify(filled)}`);
    check(filled?.boxes === 1, `otp-login: filled ${filled?.boxes} boxes, expected 1`);

    const value = await page.evaluate(`document.getElementById('code').value`);
    check(value === CODE, `otp-login: the field holds "${value}", expected "${CODE}"`);

    check(filled?.submitKind === 'clicked', `otp-login: submitted by "${filled?.submitKind}", expected a click`);
    const clicked = await page.evaluate(`JSON.stringify(window.__clicked ?? [])`);
    check(clicked === '["Verify"]', `otp-login: clicked ${clicked}, expected only Verify`);
    check(await page.evaluate(`window.__submitted === true`), 'otp-login: the form was never submitted');
  }

  /* ---------------------------------------------------------------- *
   * It refuses the pages where a fill would be a mistake
   * ---------------------------------------------------------------- */

  /**
   * Each of these must produce no reply and no change to any field. The second
   * half matters as much as the first: a fill that happened and then reported
   * failure would still have put a live credential in the wrong box.
   */
  const refusals = [
    {
      page: 'fixtures/checkout.html',
      what: 'a checkout page whose CVV field is labelled "Security code"',
      fields: ['cardnumber', 'cvv', 'exp', 'postcode'],
    },
    { page: 'fixtures/password.html', what: 'a password prompt', fields: ['user', 'pw'] },
    { page: 'fixtures/search.html', what: 'a search box', fields: ['q'] },
    { page: 'fixtures/zip-code.html', what: 'a postcode field on a page that says "code"', fields: ['zip'] },
    { page: 'fixtures/hidden.html', what: 'a code box that is not on screen yet', fields: ['user', 'code'] },
  ];

  for (const refusal of refusals) {
    const complaints = await page.open(refusal.page, { before: STUB });
    check(complaints.length === 0, `${refusal.page}: the page complained: ${complaints.join(' | ')}`);

    const seen = await ask(page, { type: 'has-code-field' });
    check(seen === null, `${refusal.what}: has-code-field replied ${JSON.stringify(seen)} instead of staying silent`);

    const filled = await ask(page, fillMessage());
    check(filled === null, `${refusal.what}: fill-code replied ${JSON.stringify(filled)} instead of staying silent`);

    const values = await page.evaluate(
      `JSON.stringify(${JSON.stringify(refusal.fields)}.map((id) => document.getElementById(id).value))`,
    );
    const untouched = JSON.parse(values).every((value) => value === '');
    check(untouched, `${refusal.what}: a field was written to: ${values}`);
    check(
      await page.evaluate(`window.__submitted === undefined`),
      `${refusal.what}: the form was submitted anyway`,
    );
  }

  /* ---------------------------------------------------------------- *
   * Segmented boxes
   * ---------------------------------------------------------------- */

  {
    await page.open('fixtures/segmented.html', { before: STUB });

    const seen = await ask(page, { type: 'has-code-field' });
    check(seen?.kind === 'segmented', `segmented: kind was ${seen?.kind}`);

    const filled = await ask(page, fillMessage());
    check(filled?.filled === true, `segmented: fill reported ${JSON.stringify(filled)}`);
    check(filled?.boxes === 6, `segmented: found ${filled?.boxes} boxes, expected 6`);

    // Joined in document order. Front to back is the whole point: a group
    // collected by walking a Map and never sorted comes out in insertion order,
    // which is usually right and occasionally reversed.
    const written = await page.evaluate(
      `[...document.querySelectorAll('.boxes input')].map((i) => i.value).join('')`,
    );
    check(written === CODE, `segmented: the boxes hold "${written}", expected "${CODE}"`);
  }

  /* ---------------------------------------------------------------- *
   * Which button gets pressed
   * ---------------------------------------------------------------- */

  {
    await page.open('fixtures/resend.html', { before: STUB });
    const filled = await ask(page, fillMessage());
    check(filled?.filled === true, `resend: fill reported ${JSON.stringify(filled)}`);

    const clicked = await page.evaluate(`JSON.stringify(window.__clicked ?? [])`);
    check(
      clicked === '["Verify"]',
      `resend: clicked ${clicked}. Resending is a submit button and pressing it kills the code just filled in.`,
    );
  }

  {
    // The same guard, on the path where it is the only thing standing between a
    // filled code and the button that invalidates it.
    await page.open('fixtures/resend-only.html', { before: STUB });
    const filled = await ask(page, fillMessage());
    check(filled?.filled === true, `resend-only: fill reported ${JSON.stringify(filled)}`);

    const clicked = await page.evaluate(`JSON.stringify(window.__clicked ?? [])`);
    check(
      clicked === '[]',
      `resend-only: clicked ${clicked} — the only button on the form is the one that must not be pressed`,
    );
    check(
      filled?.submitKind === 'requested',
      `resend-only: submitted by "${filled?.submitKind}", expected the form's own submit`,
    );
  }

  {
    await page.open('fixtures/destructive.html', { before: STUB });
    const filled = await ask(page, fillMessage());
    check(filled?.filled === true, `destructive: fill reported ${JSON.stringify(filled)}`);

    const clicked = await page.evaluate(`JSON.stringify(window.__clicked ?? [])`);
    check(clicked === '[]', `destructive: pressed ${clicked} — none of those may ever be clicked`);
    check(
      filled?.submitKind === 'requested',
      `destructive: submitted by "${filled?.submitKind}", expected the form's own submit rather than a button`,
    );
  }

  {
    await page.open('fixtures/modal.html', { before: STUB });
    const filled = await ask(page, fillMessage());
    check(filled?.filled === true, `modal: fill reported ${JSON.stringify(filled)}`);
    check(filled?.submitKind === 'enter', `modal: submitted by "${filled?.submitKind}", expected Enter`);
    check(await page.evaluate(`window.__enter === true`), 'modal: the page never saw the Enter key');
  }

  {
    // Submitting is a setting, and switching it off has to actually stop it.
    await page.open('fixtures/otp-login.html', { before: STUB });
    const filled = await ask(page, fillMessage({ submit: false }));
    check(filled?.filled === true, `no-submit: fill reported ${JSON.stringify(filled)}`);
    check(filled?.submitted === false, `no-submit: submitted anyway (${filled?.submitKind})`);
    const clicked = await page.evaluate(`JSON.stringify(window.__clicked ?? [])`);
    check(clicked === '[]', `no-submit: clicked ${clicked} with submitting switched off`);
  }

  /* ---------------------------------------------------------------- *
   * A framework-controlled input
   * ---------------------------------------------------------------- */

  {
    await page.open('fixtures/controlled.html', { before: STUB });

    // First prove the fixture is actually hostile, or the check below passes for
    // the wrong reason: an ordinary input would satisfy it too.
    const swallowed = await page.evaluate(`
      (() => {
        const input = document.getElementById('code');
        input.value = 'zzzzzz';
        const native = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
        return native.get.call(input);
      })()
    `);
    check(swallowed === '', `controlled: the fixture is not hostile — a plain write left "${swallowed}"`);

    const filled = await ask(page, fillMessage());
    check(filled?.filled === true, `controlled: fill reported ${JSON.stringify(filled)}`);

    const value = await page.evaluate(`
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
        .get.call(document.getElementById('code'))
    `);
    check(value === CODE, `controlled: the field holds "${value}" — the prototype setter did not reach it`);
    check(
      await page.evaluate(`window.__inputEvents > 0`),
      'controlled: no input event was dispatched, so a framework would never notice the change',
    );
  }

  /* ---------------------------------------------------------------- *
   * The toast
   * ---------------------------------------------------------------- */

  {
    await page.open('fixtures/otp-login.html', { before: STUB });
    const filled = await ask(page, fillMessage({ toast: true, submit: false }));
    check(filled?.toasted === true, `toast: fill reported toasted=${filled?.toasted}`);

    const toast = await page.evaluate(`
      (() => {
        const host = document.getElementById('__twofa_paster_toast');
        if (!host) return null;
        return {
          openRoot: host.shadowRoot !== null,
          html: host.outerHTML,
          bodyText: document.body.textContent,
        };
      })()
    `);
    check(toast !== null, 'toast: nothing was put on the page');
    check(toast?.openRoot === false, 'toast: the shadow root is open, so page script can read it');
    check(!toast?.html.includes(CODE), 'toast: the markup contains the code itself');
    check(!toast?.bodyText.includes(CODE), 'toast: the code is rendered as page text');
  }

  /* ---------------------------------------------------------------- *
   * Injected twice
   * ---------------------------------------------------------------- */

  {
    // `fillTab` injects this file on every fill, and auto mode registers it as a
    // content script on every page. On a page in auto mode the two meet, so the
    // guard at the top is load-bearing: a second listener would fill twice and
    // press the button twice.
    await page.open('fixtures/otp-login.html', { before: STUB });
    const before = await page.evaluate('window.__listenerCount');
    await page.evaluate(`
      new Promise((resolve) => {
        const script = document.createElement('script');
        script.src = '/content.js';
        script.onload = resolve;
        script.onerror = resolve;
        document.head.append(script);
      })
    `);
    const after = await page.evaluate('window.__listenerCount');
    check(
      before === 1 && after === 1,
      `re-injection: listener count went ${before} -> ${after}, expected to stay at 1`,
    );
  }

  /* ---------------------------------------------------------------- *
   * Telling the worker a field appeared
   * ---------------------------------------------------------------- */

  {
    await page.open('fixtures/otp-login.html', { before: STUB });
    const reports = await page.evaluate(`JSON.stringify(window.__reports)`);
    const parsed = JSON.parse(reports);
    check(
      parsed.some((message) => message.type === 'code-field-seen'),
      `report: a page with a code box sent ${reports}, expected a code-field-seen`,
    );

    await page.open('fixtures/checkout.html', { before: STUB });
    const quiet = await page.evaluate(`JSON.stringify(window.__reports)`);
    check(
      quiet === '[]',
      `report: a checkout page sent ${quiet} — auto mode would start watching the inbox on every checkout`,
    );
  }
}

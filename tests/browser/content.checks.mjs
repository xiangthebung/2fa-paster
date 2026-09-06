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

  // The card is drawn in a closed shadow root, which is the point of it: no page
  // script can reach in. The checks below still have to read it, so the root is
  // caught on its way past — installed before content.js runs, in the test only.
  // The root stays closed; \`host.shadowRoot\` is still null, and a check asserts it.
  window.__shadowRoots = [];
  const attachShadow = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (init) {
    const root = attachShadow.call(this, init);
    window.__shadowRoots.push(root);
    return root;
  };
  const cardRoot = () => window.__shadowRoots.findLast((root) => root.host?.isConnected);
  window.__card = () => {
    const card = cardRoot()?.querySelector('.card');
    if (!card) return null;
    const text = (selector) => card.querySelector(selector)?.textContent ?? '';
    return {
      title: text('.title'),
      detail: text('.detail'),
      note: text('.note'),
      heading: text('.picker-title'),
      rows: [...card.querySelectorAll('.row')].map((row) => row.textContent),
      buttons: [...card.querySelectorAll('button')].map((button) => button.textContent),
      text: card.textContent,
    };
  };
  window.__cardClick = (label) => {
    const button = [...(cardRoot()?.querySelectorAll('button') ?? [])].find((b) => b.textContent.includes(label));
    if (!button) return false;
    button.click();
    return true;
  };

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
    // The reply names what it did, in the words the page uses, so the popup can
    // say "Filled 'Verification code'" and "Pressed Verify" rather than "done".
    check(filled?.pressed === 'Verify', `otp-login: the reply says "${filled?.pressed}" was pressed, expected "Verify"`);
    check(filled?.label === 'Verification code', `otp-login: the reply names the field "${filled?.label}"`);
    check(JSON.stringify(filled?.refused) === '[]', `otp-login: nothing was skipped, but the reply lists ${JSON.stringify(filled?.refused)}`);
    const clicked = await page.evaluate(`JSON.stringify(window.__clicked ?? [])`);
    check(clicked === '["Verify"]', `otp-login: clicked ${clicked}, expected only Verify`);
    check(await page.evaluate(`window.__submitted === true`), 'otp-login: the form was never submitted');
  }

  /* ---------------------------------------------------------------- *
   * It says what it skipped, and why
   * ---------------------------------------------------------------- */

  {
    // A card confirmation: card number, a CVV labelled "Security code", and the
    // one-time code box beside them. The code has to land in the right box, and
    // the reply has to name the box that was passed over and the rule that
    // caught it — that is what the popup turns into "Skipped 'Security code' —
    // card field". The card number is not reported: it never called itself a
    // code, so nobody needs telling it was not filled with one.
    const skipped = [{ label: 'Security code', rule: 'card field' }];
    await page.open('fixtures/payment-otp.html', { before: STUB });

    const seen = await ask(page, { type: 'has-code-field' });
    check(
      seen?.hasField === true && seen?.label === 'Verification code',
      `payment-otp: has-code-field answered ${JSON.stringify(seen)}`,
    );
    check(
      JSON.stringify(seen?.refused) === JSON.stringify(skipped),
      `payment-otp: has-code-field reports ${JSON.stringify(seen?.refused)} as skipped`,
    );

    const filled = await ask(page, fillMessage());
    check(filled?.filled === true && filled?.label === 'Verification code', `payment-otp: fill reported ${JSON.stringify(filled)}`);
    check(
      filled?.pressed === 'Verify' && filled?.submitKind === 'clicked',
      `payment-otp: pressed "${filled?.pressed}" by "${filled?.submitKind}", expected a click on Verify`,
    );
    check(
      JSON.stringify(filled?.refused) === JSON.stringify(skipped),
      `payment-otp: the fill reply lists ${JSON.stringify(filled?.refused)} as skipped`,
    );
    const values = await page.evaluate(
      `JSON.stringify(['cardnumber', 'cvv', 'code'].map((id) => document.getElementById(id).value))`,
    );
    check(values === JSON.stringify(['', '', CODE]), `payment-otp: the fields hold ${values}`);
  }

  {
    // With no code box anywhere, the top frame still answers `why-no-field`
    // with the fields it looked at, so "no code box found" can say which ones.
    await page.open('fixtures/checkout.html', { before: STUB });
    const why = await ask(page, { type: 'why-no-field' });
    const rules = (why?.refused ?? []).map((entry) => `${entry.label} — ${entry.rule}`);
    check(rules[0] === 'Security code — card field', `checkout why-no-field: the first refusal is "${rules[0]}"`);
    check(rules.includes('Post code — postcode field'), `checkout why-no-field: ${JSON.stringify(rules)} does not name the postcode`);
    check(
      !rules.some((rule) => rule.startsWith('Card number')),
      `checkout why-no-field: a field that never called itself a code is reported: ${JSON.stringify(rules)}`,
    );
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

    const card = await page.evaluate(`window.__card()`);
    check(card?.title === 'Code filled in', `toast: the card's title reads "${card?.title}"`);
    check(!card?.text.includes(CODE), 'toast: the card shows the code that is already in the box');
    check(card?.rows.length === 0, `toast: with nothing else in the inbox the card offers ${JSON.stringify(card?.rows)}`);
  }

  /* ---------------------------------------------------------------- *
   * Held: filled, never submitted, and two ways to finish
   * ---------------------------------------------------------------- */

  const heldMessage = () =>
    fillMessage({ hold: true, toast: true, address: 'noreply@accountprotection.net', site: 'example.com' });

  {
    // Several codes arrived and none is tied to this site: the code goes in,
    // because seeing it in the box is how you judge it, and the button is left
    // alone, because pressing it with the wrong code is what locks an account.
    await page.open('fixtures/otp-login.html', { before: STUB });
    const held = await ask(page, heldMessage());
    check(held?.filled === true && held?.held === true, `held: fill reported ${JSON.stringify(held)}`);
    check(held?.submitted === false && held?.pressed === '', `held: submitted anyway (${held?.submitKind} "${held?.pressed}")`);
    check(await page.evaluate(`JSON.stringify(window.__clicked ?? [])`) === '[]', 'held: a button was pressed');
    check(await page.evaluate(`document.getElementById('code').value`) === CODE, 'held: the code was not typed in');

    const card = await page.evaluate(`window.__card()`);
    check(card?.title === 'Held — check the sender', `held: the card's title reads "${card?.title}"`);
    check(/noreply@accountprotection\.net/.test(card?.detail ?? ''), `held: the card does not name the address: "${card?.detail}"`);
    check(/none name example\.com/.test(card?.note ?? ''), `held: the card's note reads "${card?.note}"`);
    check(card?.buttons.includes('Submit anyway'), `held: the card offers ${JSON.stringify(card?.buttons)}`);

    // The popup's "Submit anyway" arrives as `submit-code`: the same button the
    // fill would have pressed, and the reply names it.
    const submitted = await ask(page, { type: 'submit-code' });
    check(
      submitted?.submitted === true && submitted?.pressed === 'Verify' && submitted?.submitKind === 'clicked',
      `held: submit-code answered ${JSON.stringify(submitted)}`,
    );
    check(await page.evaluate(`JSON.stringify(window.__clicked ?? [])`) === '["Verify"]', 'held: Verify was not the button pressed');
    const after = await page.evaluate(`window.__card()`);
    check(after?.title === 'Submitted — Verify pressed', `held: after the submit the card reads "${after?.title}"`);
    check(!after?.buttons.includes('Submit anyway'), 'held: the card still offers "Submit anyway" after submitting');
  }

  {
    // The card's own "Submit anyway": the same press, and the worker is told so
    // the popup opened afterwards describes what happened.
    await page.open('fixtures/otp-login.html', { before: STUB });
    await ask(page, heldMessage());
    check(await page.evaluate(`window.__cardClick('Submit anyway')`), 'card submit: no "Submit anyway" button to press');
    await page.evaluate(`new Promise((resolve) => setTimeout(resolve, 500))`);
    const clicked = await page.evaluate(`JSON.stringify(window.__clicked ?? [])`);
    check(clicked === '["Verify"]', `card submit: clicked ${clicked}`);
    const told = await page.evaluate(`JSON.stringify(window.__reports.filter((m) => m.type === 'code-used'))`);
    check(
      /"action":"submitted"/.test(told) && /"submitted":true/.test(told) && /"pressed":"Verify"/.test(told),
      `card submit: the worker was told ${told}`,
    );
  }

  {
    // A frame that never filled anything stays silent on `submit-code`, for the
    // same reason it stays silent on a fill: the frame that did the fill answers.
    await page.open('fixtures/otp-login.html', { before: STUB });
    const silent = await ask(page, { type: 'submit-code' });
    check(silent === null, `submit-code with nothing filled replied ${JSON.stringify(silent)} instead of staying silent`);
    check(await page.evaluate(`JSON.stringify(window.__clicked ?? [])`) === '[]', 'submit-code with nothing filled pressed a button');
  }

  /* ---------------------------------------------------------------- *
   * The picker on the page
   * ---------------------------------------------------------------- */

  {
    // Other codes arrived at the same time: the card lists them by address, one
    // click swaps the field's value, and the worker is told which code went in.
    const other = { code: '771204', sender: 'Security', address: 'bounce@sendgrid.net', receivedAt: Date.now() - 60000 };
    await page.open('fixtures/otp-login.html', { before: STUB });
    const filled = await ask(
      page,
      fillMessage({ submit: false, toast: true, address: 'noreply@example.com', alternatives: [other] }),
    );
    check(filled?.filled === true, `picker: fill reported ${JSON.stringify(filled)}`);

    const card = await page.evaluate(`window.__card()`);
    check(card?.heading === 'Other recent codes', `picker: the heading reads "${card?.heading}"`);
    check(
      card?.rows.length === 1 && /Use 771204 instead/.test(card.rows[0]) && /bounce@sendgrid\.net/.test(card.rows[0]),
      `picker: the rows read ${JSON.stringify(card?.rows)}`,
    );
    check(!card?.text.includes(CODE), 'picker: the card shows the code that is already in the box');

    check(await page.evaluate(`window.__cardClick('771204')`), 'picker: no row to click');
    await page.evaluate(`new Promise((resolve) => setTimeout(resolve, 400))`);
    const value = await page.evaluate(`document.getElementById('code').value`);
    check(value === '771204', `picker: after the swap the field holds "${value}"`);
    const swapped = await page.evaluate(`window.__card()`);
    check(swapped?.title === 'Swapped in', `picker: after the swap the card reads "${swapped?.title}"`);
    check(
      swapped?.rows.some((row) => row.includes(CODE)),
      `picker: the code that was replaced is not offered back: ${JSON.stringify(swapped?.rows)}`,
    );
    const told = await page.evaluate(`JSON.stringify(window.__reports.filter((m) => m.type === 'code-used'))`);
    check(/"action":"swapped"/.test(told) && /"code":"771204"/.test(told), `picker: the worker was told ${told}`);
    check(await page.evaluate(`JSON.stringify(window.__clicked ?? [])`) === '[]', 'picker: a swap with submitting off pressed a button');
  }

  {
    // With submitting on, a chosen code is delivered the way a chosen code is:
    // the person picked it, so the sender question is settled and it goes through.
    const other = { code: '771204', sender: 'Security', address: 'bounce@sendgrid.net', receivedAt: Date.now() - 60000 };
    await page.open('fixtures/otp-login.html', { before: STUB });
    await ask(page, heldMessage());
    // Redraw with a row to pick: the held card carries the alternatives it was given.
    await page.open('fixtures/otp-login.html', { before: STUB });
    await ask(page, fillMessage({ ...heldMessage(), alternatives: [other] }));
    check(await page.evaluate(`window.__cardClick('771204')`), 'picker (held): no row to click');
    await page.evaluate(`new Promise((resolve) => setTimeout(resolve, 500))`);
    const clicked = await page.evaluate(`JSON.stringify(window.__clicked ?? [])`);
    check(clicked === '["Verify"]', `picker (held): picking a code with submitting on clicked ${clicked}, expected Verify`);
    const swapped = await page.evaluate(`window.__card()`);
    check(swapped?.title === 'Swapped in, Verify pressed', `picker (held): the card reads "${swapped?.title}"`);
  }

  /* ---------------------------------------------------------------- *
   * The shortcut pressed again
   * ---------------------------------------------------------------- */

  {
    // A second press of the shortcut on a page that was just filled asks the
    // page to put its card back up with the other codes. Only a frame holding a
    // fill answers: an untouched page stays silent, and the worker fetches.
    const other = { code: '771204', sender: 'Security', address: 'bounce@sendgrid.net', receivedAt: Date.now() - 60000 };
    const same = { code: CODE, sender: 'Example', address: 'noreply@example.com', receivedAt: Date.now() - 20000 };
    await page.open('fixtures/otp-login.html', { before: STUB });
    const silent = await ask(page, { type: 'show-picker', rows: [other] });
    check(silent === null, `second press: an unfilled page answered ${JSON.stringify(silent)} instead of staying silent`);
    check((await page.evaluate(`window.__card()`)) === null, 'second press: an unfilled page drew a card');

    await ask(page, fillMessage({ submit: false, toast: false, address: 'noreply@example.com' }));
    check((await page.evaluate(`window.__card()`)) === null, 'second press: a fill with the card switched off drew one anyway');
    const shown = await ask(page, { type: 'show-picker', rows: [same, other] });
    check(shown?.shown === true, `second press: show-picker answered ${JSON.stringify(shown)}`);
    const card = await page.evaluate(`window.__card()`);
    check(card?.title === 'Already filled in', `second press: the card's title reads "${card?.title}"`);
    check(/noreply@example\.com/.test(card?.detail ?? ''), `second press: the card does not name the address: "${card?.detail}"`);
    check(card?.heading === 'Other recent codes', `second press: the picker's heading reads "${card?.heading}"`);
    check(
      card?.rows.length === 1 && /Use 771204 instead/.test(card.rows[0]) && /bounce@sendgrid\.net/.test(card.rows[0]),
      `second press: the rows read ${JSON.stringify(card?.rows)} — the code already in the box must not be offered`,
    );
    check(!card?.buttons.includes('Submit anyway'), 'second press: a fill with submitting off offers "Submit anyway"');

    check(await page.evaluate(`window.__cardClick('771204')`), 'second press: no row to click');
    await page.evaluate(`new Promise((resolve) => setTimeout(resolve, 400))`);
    const value = await page.evaluate(`document.getElementById('code').value`);
    check(value === '771204', `second press: after the swap the field holds "${value}"`);

    // Pressed once more with nothing else to offer: the card says so.
    const again = await ask(page, { type: 'show-picker', rows: [] });
    check(again?.shown === true, `second press (nothing new): show-picker answered ${JSON.stringify(again)}`);
    const bare = await page.evaluate(`window.__card()`);
    check(bare?.note === 'No other code has arrived.', `second press (nothing new): the card's note reads "${bare?.note}"`);
    check(bare?.rows.length === 0, `second press (nothing new): the card offers ${JSON.stringify(bare?.rows)}`);
  }

  {
    // A held code, pressed again: the held card comes back, submit still on offer,
    // and still nothing pressed.
    await page.open('fixtures/otp-login.html', { before: STUB });
    await ask(page, heldMessage());
    const shown = await ask(page, { type: 'show-picker', rows: [] });
    check(shown?.shown === true, `second press (held): show-picker answered ${JSON.stringify(shown)}`);
    const card = await page.evaluate(`window.__card()`);
    check(card?.title === 'Held — check the sender', `second press (held): the card's title reads "${card?.title}"`);
    check(card?.buttons.includes('Submit anyway'), `second press (held): the card offers ${JSON.stringify(card?.buttons)}`);
    check((await page.evaluate(`JSON.stringify(window.__clicked ?? [])`)) === '[]', 'second press (held): a button was pressed');
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

/**
 * Finds the code box on a page and types into it.
 *
 * This is a classic script, not a module: Chrome does not load `content_scripts`
 * as modules, and `scripting.executeScript` files are classic too. The build
 * fails if an `import` appears here, because the resulting syntax error would
 * only ever show up in the page's console.
 *
 * Two problems to solve, and neither has a standard answer:
 *
 * 1. Which input is the code box? `autocomplete="one-time-code"` settles it when
 *    it is present, and often it is not. Everything else is inference from names,
 *    labels, and shape — and the expensive mistake is a false positive, because
 *    pasting a code into the wrong field can mean submitting it somewhere it
 *    should not go. So candidates must clear a threshold, and anything that looks
 *    like a card number, a CVV, a postcode or a password is disqualified outright
 *    rather than merely outscored.
 *
 * 2. Setting `.value` is not enough. A React-controlled input tracks its own last
 *    value and will discard a plain assignment on the next render, so the value
 *    goes in through the native setter and the events a real keystroke would
 *    produce are dispatched by hand. Every fill is read back afterwards, and a
 *    synthetic paste is the fallback when the framework rejected the write.
 */
(() => {
  'use strict';

  // Injected on demand *and* registered for auto mode, so the same page can
  // receive this file twice. The listener below must only be attached once.
  if (window.__twoFaPasterLoaded) return;
  window.__twoFaPasterLoaded = true;

  /* ---------------------------------------------------------------- *
   * Recognising the field
   * ---------------------------------------------------------------- */

  /** Names that mean "one-time code" and nothing else. */
  const STRONG_HINT =
    /(one[-_ ]?time|onetime|\botp\b|\botc\b|totp|\bmfa\b|\b2fa\b|two[-_ ]?factor|two[-_ ]?step|authcode|auth[-_ ]code|verification[-_ ]?code|verify[-_ ]?code|security[-_ ]?code|passcode|sms[-_ ]?code|email[-_ ]?code|login[-_ ]?code|signin[-_ ]?code|confirmation[-_ ]?code|challenge)/i;

  /** "code" or "pin" on their own: suggestive, not conclusive. */
  const WEAK_HINT = /(^|[^a-z])(code|pin|token|digits?)([^a-z]|$)/i;

  /**
   * Compounds that contain "code" but are never a one-time code. Checked before
   * the weak hint, so a postcode field cannot be scored up by it.
   */
  const DECOY_HINT =
    /((zip|postal|post|country|area|dial|phone|promo|coupon|discount|voucher|gift|referral|invite|invitation|currency|language|lang|locale|state|province|city|airport|iata|colour|color|bar|qr|product|sku|store|branch|access[-_ ]?key)[-_ ]?code|zipcode|postcode)/i;

  /**
   * Payment fields. "Security code" is the CVV label on most checkout pages, so
   * this has to win against the strong hint rather than merely compete with it.
   */
  const PAYMENT_HINT =
    /(card|credit|debit|cvv|cvc|cvn|csc|expir|\bexp\b|month|year|iban|routing|account[-_ ]?number|sort[-_ ]?code)/i;

  const SECRET_HINT = /(password|passwd|pwd|passwort|contrase|senha|mot[-_ ]?de[-_ ]?passe)/i;
  const WRONG_FIELD_HINT = /(search|query|\bemail\b|e-mail|user(name)?|login[-_ ]?id|address|street|city|phone|mobile|tel\b|birth|\bdob\b|amount|quantity|\bqty\b)/i;

  const FILLABLE_TYPES = new Set(['text', 'tel', 'number', 'password', 'search', '']);

  /** Autocomplete values that name a different field outright. */
  const WRONG_AUTOCOMPLETE = new Set([
    'username',
    'email',
    'current-password',
    'new-password',
    'cc-number',
    'cc-csc',
    'cc-exp',
    'cc-exp-month',
    'cc-exp-year',
    'postal-code',
    'country',
    'tel',
    'tel-national',
    'street-address',
    'name',
    'given-name',
    'family-name',
  ]);

  /** Below this, it is not a code box and nothing gets typed into it. */
  const ACCEPT_SCORE = 30;

  /** Walking every element to find shadow roots is bounded on huge pages. */
  const SHADOW_SCAN_LIMIT = 8000;

  function isVisible(element) {
    if (!element.isConnected || element.disabled || element.readOnly) return false;
    if (element.type === 'hidden') return false;
    const rect = element.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4) return false;
    const style = getComputedStyle(element);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    return Number(style.opacity) >= 0.05;
  }

  /** Every input in the document, including inside open shadow roots. */
  function collectInputs() {
    const found = [];
    const roots = [document];
    let scanned = 0;

    while (roots.length > 0) {
      const root = roots.pop();
      for (const input of root.querySelectorAll('input')) found.push(input);
      if (scanned < SHADOW_SCAN_LIMIT) {
        for (const element of root.querySelectorAll('*')) {
          scanned += 1;
          if (scanned > SHADOW_SCAN_LIMIT) break;
          if (element.shadowRoot) roots.push(element.shadowRoot);
        }
      }
    }
    return found;
  }

  /** Text that describes an input: its own attributes plus its label. */
  function describe(input) {
    const parts = [
      input.getAttribute('name'),
      input.getAttribute('id'),
      input.getAttribute('placeholder'),
      input.getAttribute('aria-label'),
      input.getAttribute('autocomplete'),
      input.getAttribute('data-testid'),
      input.className,
    ];

    const labelledBy = input.getAttribute('aria-labelledby');
    if (labelledBy) {
      for (const id of labelledBy.split(/\s+/)) {
        parts.push(document.getElementById(id)?.textContent ?? '');
      }
    }
    if (input.labels) for (const label of input.labels) parts.push(label.textContent ?? '');
    if (input.id) {
      const root = input.getRootNode();
      if (root instanceof ShadowRoot) {
        parts.push(root.querySelector(`label[for="${CSS.escape(input.id)}"]`)?.textContent ?? '');
      }
    }

    // The heading or sentence just above the field is often the only place the
    // words "verification code" appear.
    const container = input.closest('form, fieldset, section, div');
    if (container) parts.push((container.textContent ?? '').slice(0, 400));

    return parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').toLowerCase();
  }

  /**
   * How likely is this input to be the code box?
   *
   * @returns {{ score: number, why: string[] } | null} null when disqualified
   */
  function scoreInput(input, { active }) {
    const type = (input.getAttribute('type') ?? '').toLowerCase();
    if (!FILLABLE_TYPES.has(type)) return null;
    if (!isVisible(input)) return null;

    const autocomplete = (input.getAttribute('autocomplete') ?? '').trim().toLowerCase();
    const description = describe(input);
    const own = [
      input.getAttribute('name'),
      input.getAttribute('id'),
      input.getAttribute('placeholder'),
      input.getAttribute('aria-label'),
      autocomplete,
      input.className,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();

    // Disqualifications. These use the field's own attributes, not the
    // surrounding copy, because a checkout page mentions "code" everywhere.
    if (autocomplete === 'one-time-code') {
      // The standard attribute is definitive; skip the rest of the gauntlet.
      return { score: 100 + (active ? 10 : 0), why: ['autocomplete="one-time-code"'] };
    }
    if (WRONG_AUTOCOMPLETE.has(autocomplete)) return null;
    if (PAYMENT_HINT.test(own)) return null;
    if (DECOY_HINT.test(own)) return null;
    if (SECRET_HINT.test(own)) return null;
    if (WRONG_FIELD_HINT.test(own)) return null;

    const why = [];
    let score = 0;

    if (STRONG_HINT.test(own)) {
      score += 60;
      why.push('named like a one-time code');
    } else if (STRONG_HINT.test(description)) {
      score += 34;
      why.push('labelled like a one-time code');
    } else if (WEAK_HINT.test(own) && !DECOY_HINT.test(description)) {
      score += 32;
      why.push('named "code"');
    } else if (WEAK_HINT.test(description) && !DECOY_HINT.test(description)) {
      score += 16;
      why.push('described as a code');
    }

    const maxLength = input.maxLength;
    if (maxLength >= 4 && maxLength <= 8) {
      score += 20;
      why.push(`accepts ${maxLength} characters`);
    } else if (maxLength === 1) {
      score += 14;
      why.push('single character box');
    }

    const inputMode = (input.getAttribute('inputmode') ?? '').toLowerCase();
    if (type === 'tel' || type === 'number' || inputMode === 'numeric' || inputMode === 'tel') {
      score += 12;
      why.push('numeric entry');
    }

    const pattern = input.getAttribute('pattern') ?? '';
    if (/\\d|\[0-9\]/.test(pattern)) {
      score += 18;
      why.push('digits-only pattern');
    }

    if (/^[\s*•\-_]*(\d[\s\-*•]*){4,8}$/.test(input.getAttribute('placeholder') ?? '')) {
      score += 14;
      why.push('numeric placeholder');
    }

    // Where the cursor already is beats any amount of guessing from names.
    if (active) {
      score += 45;
      why.push('already focused');
    }

    // An input the user has typed into is probably not waiting for a code, but
    // a segmented box that we filled earlier is a legitimate refill target.
    if (input.value && maxLength !== 1) score -= 18;

    return score > 0 ? { score, why } : null;
  }

  /**
   * A row of single-character boxes, which is how most modern code entry looks.
   *
   * Six inputs that each hold one character are an OTP field with such
   * regularity that this does not need a name to agree with it — but they do have
   * to share a parent, so a page of one-character boxes for some other purpose is
   * not treated as one field.
   */
  function findSegmentedGroup(inputs) {
    const singles = inputs.filter(
      (input) =>
        input.maxLength === 1 &&
        FILLABLE_TYPES.has((input.getAttribute('type') ?? '').toLowerCase()) &&
        isVisible(input) &&
        !PAYMENT_HINT.test(`${input.name} ${input.id} ${input.className}`.toLowerCase()),
    );
    if (singles.length < 4) return null;

    const byParent = new Map();
    for (const input of singles) {
      const parent = input.parentElement?.parentElement ?? input.parentElement;
      if (!parent) continue;
      if (!byParent.has(parent)) byParent.set(parent, []);
      byParent.get(parent).push(input);
    }

    let best = null;
    for (const group of byParent.values()) {
      if (group.length < 4 || group.length > 10) continue;
      if (!best || group.length > best.length) best = group;
    }
    if (!best) return null;

    // Document order, so the code is not written back to front.
    best.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
    return best;
  }

  /**
   * The best place on this page to put a code.
   *
   * @returns {{ kind: 'single', input: HTMLInputElement, score: number, why: string[] }
   *          | { kind: 'segmented', inputs: HTMLInputElement[], score: number, why: string[] }
   *          | null}
   */
  function findTarget() {
    const inputs = collectInputs();
    if (inputs.length === 0) return null;

    const active = document.activeElement;

    const segmented = findSegmentedGroup(inputs);
    if (segmented) {
      const named = segmented.some((input) => STRONG_HINT.test(`${input.name} ${input.id} ${input.className}`));
      const focused = segmented.includes(active);
      return {
        kind: 'segmented',
        inputs: segmented,
        score: 70 + (named ? 20 : 0) + (focused ? 15 : 0),
        why: [`${segmented.length} single-character boxes`, ...(named ? ['named like a one-time code'] : [])],
      };
    }

    let best = null;
    for (const input of inputs) {
      const scored = scoreInput(input, { active: input === active });
      if (!scored) continue;
      if (!best || scored.score > best.score) best = { kind: 'single', input, ...scored };
    }
    return best && best.score >= ACCEPT_SCORE ? best : null;
  }

  /* ---------------------------------------------------------------- *
   * Typing into it
   * ---------------------------------------------------------------- */

  /**
   * Assign through the prototype's setter.
   *
   * React installs its own `value` setter on the element instance to track
   * changes. Writing `input.value = x` goes through that tracker, which then
   * decides nothing changed and reverts the field on the next render. Reaching
   * past it to the prototype setter is what makes the write stick.
   */
  function assign(input, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (setter) setter.call(input, value);
    else input.value = value;
  }

  /** The events a real keystroke would have produced, in order. */
  function announce(input, value) {
    const key = value.slice(-1);
    input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, composed: true }));
    input.dispatchEvent(
      new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: value }),
    );
    input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    input.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, composed: true }));
  }

  /**
   * Hand the code over as a paste instead of a set of keystrokes.
   *
   * Some segmented components only implement distribution in a paste handler,
   * and some controlled inputs discard a programmatic write no matter how it is
   * announced. This is the fallback for both.
   */
  function tryPaste(input, code) {
    try {
      const data = new DataTransfer();
      data.setData('text/plain', code);
      input.focus();
      const event = new ClipboardEvent('paste', {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
        composed: true,
      });
      return input.dispatchEvent(event);
    } catch {
      return false;
    }
  }

  function highlight(inputs) {
    for (const input of inputs) {
      const previous = input.style.getPropertyValue('outline');
      const previousPriority = input.style.getPropertyPriority('outline');
      input.style.setProperty('outline', '2px solid #6d5bff', 'important');
      setTimeout(() => {
        if (previous) input.style.setProperty('outline', previous, previousPriority);
        else input.style.removeProperty('outline');
      }, 1200);
    }
  }

  function fillSingle(input, code) {
    input.focus();
    assign(input, '');
    assign(input, code);
    announce(input, code);
    if (input.value === code) return true;

    // The framework rejected the write; try it as a paste.
    tryPaste(input, code);
    return input.value === code;
  }

  function fillSegmented(inputs, code) {
    const characters = [...code].slice(0, inputs.length);
    for (const [index, input] of inputs.entries()) {
      const character = characters[index] ?? '';
      input.focus();
      assign(input, '');
      assign(input, character);
      announce(input, character);
    }
    // Leave the caret after the last box so a keystroke does not overwrite.
    inputs[Math.min(characters.length, inputs.length) - 1]?.focus();

    const written = inputs.map((input) => input.value).join('');
    if (written.startsWith(code) || written === code) return true;

    tryPaste(inputs[0], code);
    return inputs.map((input) => input.value).join('').startsWith(code);
  }

  /* ---------------------------------------------------------------- *
   * Handing it over
   * ---------------------------------------------------------------- */

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /** Wording that means "this button finishes the code step". */
  const SUBMIT_TEXT =
    /(verif\w*|continue|submit|confirm\w*|next|proceed|sign ?in|log ?in|login|done|finish|authenticate|validate|unlock|^\s*(ok|go)\s*$)/i;

  /**
   * Wording that must never be pressed on anyone's behalf.
   *
   * Checked before the list above and against every candidate, including
   * `type="submit"` ones: "Resend code" is a submit button on plenty of forms, and
   * pressing it invalidates the code that was just filled in.
   */
  const AVOID_TEXT =
    /(cancel|dismiss|close|go back|\bback\b|resend|send again|send another|new code|another code|try another|use another|another (way|method|option)|different|didn['\u2019\u02bc]?t|did not|not you|having trouble|trouble|help|support|sign ?up|register|create account|remember|trust|skip|call me|text me|more options|other options|delete|remove|log ?out|sign ?out)/i;

  /** How long to keep waiting for a button that the page has not enabled yet. */
  const SUBMIT_RETRY_DELAYS = [0, 90, 260];

  /** The words a button shows, from its text or its accessible name. */
  function buttonText(element) {
    const parts = [
      element.textContent,
      element.value,
      element.getAttribute('aria-label'),
      element.getAttribute('title'),
      element.getAttribute('name'),
    ];
    return parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  }

  function isPressable(element) {
    if (element.disabled) return false;
    if (element.getAttribute('aria-disabled') === 'true') return false;
    return isVisible(element) || element.type === 'submit';
  }

  /**
   * The button in this form that finishes the code step, if there is one.
   *
   * Deliberately narrow. Everything considered is inside the same form as the
   * field that was filled — hunting the whole page for something that looks like a
   * Continue button is how an autofiller ends up clicking "Delete account".
   */
  function submitButton(form) {
    const candidates = [...form.querySelectorAll('button, input[type="submit"], input[type="button"], [role="button"]')];
    let fallback = null;

    for (const element of candidates) {
      if (!isPressable(element)) continue;
      const text = buttonText(element);
      if (AVOID_TEXT.test(text)) continue;

      const declared = (element.getAttribute('type') ?? '').toLowerCase() === 'submit';
      if (declared) {
        // A declared submit button whose wording also reads like one is as good
        // as this gets; otherwise remember it and keep looking for a better name.
        if (SUBMIT_TEXT.test(text) || !text) return element;
        fallback ??= element;
        continue;
      }
      // Anything not declared as a submit button has to say what it does. An
      // unlabelled `<div role="button">` is not something to press blind.
      if (SUBMIT_TEXT.test(text)) return element;
    }
    return fallback;
  }

  /**
   * Press Enter in the field.
   *
   * The fallback for the very common case of a code box with no surrounding form
   * — a modal that listens for the key itself — and what a person would do anyway.
   */
  function pressEnter(input) {
    const options = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, composed: true, cancelable: true };
    try {
      input.focus();
      input.dispatchEvent(new KeyboardEvent('keydown', options));
      input.dispatchEvent(new KeyboardEvent('keypress', options));
      input.dispatchEvent(new KeyboardEvent('keyup', options));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get the page to accept the code.
   *
   * Three routes, in descending order of how much the page has told us about
   * itself: press the button it labelled, ask its form to submit, or press Enter.
   *
   * The retry matters more than it looks. Most code forms keep their button
   * disabled until the value is long enough, and a framework re-enables it a render
   * or two after the input event — so the first look often finds a disabled button
   * on a form that is about to be perfectly submittable. Clicking the page's own
   * button is the route it designed and tested; the others are guesses about it.
   * Worth a quarter of a second to get the good one.
   *
   * Enter comes last because a synthetic key event has no default action: it only
   * does anything if the page is listening for it. That happens to cover the case
   * with no form at all — a modal handling the key itself — which is the one place
   * the other two routes have nothing to offer.
   *
   * @returns {Promise<'clicked' | 'requested' | 'enter' | false>}
   */
  async function submitFrom(input) {
    const form = input.closest('form');

    if (form) {
      for (const wait of SUBMIT_RETRY_DELAYS) {
        if (wait) await sleep(wait);
        // Replaced by a re-render, or the page submitted itself while we waited.
        // Either way this is finished, and claiming otherwise would be a guess.
        if (!input.isConnected) return false;
        const button = submitButton(form);
        if (button) {
          button.click();
          return 'clicked';
        }
      }

      if (typeof form.requestSubmit === 'function') {
        try {
          form.requestSubmit();
          return 'requested';
        } catch {
          // Falls through to the key press.
        }
      }
    }

    return pressEnter(input) ? 'enter' : false;
  }

  /**
   * @param {object} target
   * @param {string} code
   * @param {{ submit?: boolean, toast?: boolean, sender?: string }} options
   */
  async function fill(target, code, { submit = false, toast = false, sender = '' } = {}) {
    const inputs = target.kind === 'segmented' ? target.inputs : [target.input];
    const ok =
      target.kind === 'segmented' ? fillSegmented(target.inputs, code) : fillSingle(target.input, code);

    if (!ok) return { filled: false, reason: 'rejected', why: target.why };
    highlight(inputs);

    let submitted = false;
    if (submit) {
      try {
        // From the last box: that is where the caret is after a segmented fill,
        // and where Enter would have been pressed.
        submitted = await submitFrom(inputs[inputs.length - 1] ?? inputs[0]);
      } catch {
        submitted = false;
      }
    }

    // After the submit attempt, so the wording describes what happened rather
    // than what was intended.
    const toasted = toast ? showToast({ submitted, sender }) : false;

    return {
      filled: true,
      kind: target.kind,
      boxes: inputs.length,
      why: target.why,
      submitted: Boolean(submitted),
      submitKind: submitted || '',
      toasted,
    };
  }

  /* ---------------------------------------------------------------- *
   * Saying so, on the page
   * ---------------------------------------------------------------- */

  const TOAST_ID = '__twofa_paster_toast';
  const TOAST_MS = 4500;
  /** Under this, the frame is a widget and a corner-anchored card would clip. */
  const TOAST_MIN_WIDTH = 300;
  const TOAST_MIN_HEIGHT = 200;

  let toastTimer = null;

  const TOAST_STYLE = `
    :host { all: initial; }
    .card {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      box-sizing: border-box;
      max-width: 300px;
      padding: 12px 14px;
      border-radius: 13px;
      background: #ffffff;
      box-shadow: 0 2px 6px rgba(0,0,0,.09), 0 12px 32px rgba(0,0,0,.16);
      color: #1d1d1f;
      font: 500 13px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
      text-align: left;
      cursor: pointer;
      transition: opacity .18s ease, transform .18s ease;
    }
    .enter { opacity: 0; transform: translateY(8px); }
    .mark {
      display: grid;
      place-items: center;
      width: 22px;
      height: 22px;
      flex: 0 0 auto;
      border-radius: 50%;
      background: #1b8a3a;
      color: #fff;
      font-size: 13px;
      line-height: 1;
    }
    .copy { display: grid; gap: 2px; min-width: 0; }
    .title { font-weight: 640; }
    .detail { color: #6a6a74; font-size: 12px; font-weight: 450; }
    @media (prefers-color-scheme: dark) {
      .card { background: #26262b; color: #f2f2f5; box-shadow: 0 2px 6px rgba(0,0,0,.4), 0 12px 32px rgba(0,0,0,.5); }
      .detail { color: #a3a3ad; }
    }
    @media (prefers-reduced-motion: reduce) {
      .card { transition: none; }
      .enter { opacity: 1; transform: none; }
    }
  `;

  /**
   * Tell the page's reader what just happened.
   *
   * A code arriving by itself is the one part of this that could look like the
   * page misbehaving, so it says so where you are already looking — and it matters
   * more now that submitting is automatic, because the form can be gone before you
   * have finished reading it.
   *
   * Rendered in a closed shadow root: no page stylesheet can reach in and restyle
   * it into something misleading, and no page script can read it by walking the
   * DOM. The code itself is never shown — it is on the screen already, in the box.
   *
   * @param {{ submitted: 'clicked' | 'enter' | 'requested' | false, sender?: string }} outcome
   * @returns {boolean} whether anything was actually put on screen
   */
  function showToast({ submitted, sender }) {
    if (!document.body) return false;
    if (window.innerWidth < TOAST_MIN_WIDTH || window.innerHeight < TOAST_MIN_HEIGHT) return false;

    try {
      document.getElementById(TOAST_ID)?.remove();

      const host = document.createElement('div');
      host.id = TOAST_ID;
      host.style.cssText =
        'all: initial; position: fixed !important; right: 16px !important; bottom: 16px !important;' +
        'z-index: 2147483647 !important; width: auto !important; height: auto !important;' +
        'pointer-events: auto !important; contain: layout style;';

      const root = host.attachShadow({ mode: 'closed' });
      // A constructed stylesheet rather than a `<style>` element: it never enters
      // the page's DOM, so a strict `style-src` policy has nothing to object to.
      try {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(TOAST_STYLE);
        root.adoptedStyleSheets = [sheet];
      } catch {
        const style = document.createElement('style');
        style.textContent = TOAST_STYLE;
        root.append(style);
      }

      const card = document.createElement('div');
      card.className = 'card enter';
      card.setAttribute('role', 'status');
      card.setAttribute('aria-live', 'polite');

      const mark = document.createElement('span');
      mark.className = 'mark';
      mark.setAttribute('aria-hidden', 'true');
      mark.textContent = '✓';

      const copy = document.createElement('span');
      copy.className = 'copy';
      const title = document.createElement('span');
      title.className = 'title';
      title.textContent =
        submitted === 'enter'
          ? 'Code filled in, Enter pressed'
          : submitted
            ? 'Code filled in and submitted'
            : 'Code filled in';
      const detail = document.createElement('span');
      detail.className = 'detail';
      detail.textContent = sender ? `2FA Paster · from ${sender}` : '2FA Paster';
      copy.append(title, detail);

      card.append(mark, copy);
      root.append(card);
      document.body.append(host);

      // One frame later, so the transition has a starting point to move from.
      requestAnimationFrame(() => card.classList.remove('enter'));

      const dismiss = () => {
        card.classList.add('enter');
        setTimeout(() => host.remove(), 200);
      };
      card.addEventListener('click', dismiss);
      clearTimeout(toastTimer);
      toastTimer = setTimeout(dismiss, TOAST_MS);
      return true;
    } catch {
      return false;
    }
  }

  /* ---------------------------------------------------------------- *
   * Talking to the service worker
   * ---------------------------------------------------------------- */

  /**
   * Both handlers stay silent when this frame has no code box.
   *
   * A code form is often inside an iframe, so the fill is addressed to every
   * frame in the tab at once. Chrome uses the first reply it gets, which means a
   * frame with nothing to offer must not reply at all — otherwise the outer
   * document answers "no field here" before the iframe that has the field gets a
   * word in. No reply from anywhere is the caller's signal that the page has no
   * code box.
   */
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'has-code-field') {
      const target = findTarget();
      if (!target) return false;
      sendResponse({ ok: true, hasField: true, kind: target.kind, why: target.why });
      return false;
    }

    if (message?.type === 'fill-code') {
      let target;
      try {
        target = findTarget();
      } catch {
        return false;
      }
      if (!target) return false;

      // Answered asynchronously: submitting waits a moment for a button the page
      // has not enabled yet, and the caller wants to know whether that worked.
      fill(target, String(message.code ?? ''), {
        submit: Boolean(message.submit),
        toast: Boolean(message.toast),
        sender: String(message.sender ?? ''),
      })
        .then((result) => sendResponse({ ok: true, ...result }))
        .catch((error) =>
          sendResponse({ ok: true, filled: false, reason: 'error', error: String(error?.message ?? error) }),
        );
      return true;
    }

    return false;
  });

  /**
   * Tell the service worker when a code box appears, so auto mode knows to start
   * watching the inbox.
   *
   * Most login flows reveal the field after a click rather than on load, so a
   * one-off scan is not enough. Reports are deduplicated and rate limited: this
   * runs on every page in auto mode and must stay quiet.
   */
  let lastReport = 0;
  let reportedFor = '';
  let queued = null;

  function report() {
    const now = Date.now();
    const at = `${location.href}`;
    if (at === reportedFor && now - lastReport < 30000) return;
    if (!findTarget()) return;
    reportedFor = at;
    lastReport = now;
    try {
      chrome.runtime.sendMessage({ type: 'code-field-seen', href: at }, () => void chrome.runtime.lastError);
    } catch {
      // The extension was reloaded underneath us; nothing to do.
    }
  }

  function scheduleReport(delay = 400) {
    clearTimeout(queued);
    queued = setTimeout(report, delay);
  }

  scheduleReport(0);

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'attributes') {
        scheduleReport();
        return;
      }
      for (const node of record.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        if (node.tagName === 'INPUT' || node.querySelector?.('input')) {
          scheduleReport();
          return;
        }
      }
    }
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributeFilter: ['type', 'autocomplete', 'maxlength', 'style', 'class', 'hidden'],
  });

  window.addEventListener('focusin', (event) => {
    if (event.target instanceof HTMLInputElement) scheduleReport(150);
  });
})();

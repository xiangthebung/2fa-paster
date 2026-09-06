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
 *    rather than merely outscored. Every disqualification is also *reported*, by
 *    the field's label and the rule that caught it, so the popup can say
 *    "Skipped 'Security code' — card field" rather than leaving the reader to
 *    wonder whether the extension looked at all.
 *
 * 2. Setting `.value` is not enough. A React-controlled input tracks its own last
 *    value and will discard a plain assignment on the next render, so the value
 *    goes in through the native setter and the events a real keystroke would
 *    produce are dispatched by hand. Every fill is read back afterwards, and a
 *    synthetic paste is the fallback when the framework rejected the write.
 *
 * A third thing lives here because it has to: the card in the corner of the page.
 * It confirms what was done, names the button that was pressed, and — when other
 * codes arrived at the same time — lists them, so the wrong one can be swapped for
 * the right one without opening anything. Pressing the shortcut again brings the
 * list back, for as long as the boxes it filled are still on the page.
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

  /** Autocomplete values that name a different field outright, and what to call it. */
  const WRONG_AUTOCOMPLETE = new Map([
    ['username', 'username field'],
    ['email', 'email field'],
    ['current-password', 'password field'],
    ['new-password', 'password field'],
    ['cc-number', 'card field'],
    ['cc-csc', 'card field'],
    ['cc-exp', 'card field'],
    ['cc-exp-month', 'card field'],
    ['cc-exp-year', 'card field'],
    ['postal-code', 'postcode field'],
    ['country', 'country field'],
    ['tel', 'phone field'],
    ['tel-national', 'phone field'],
    ['street-address', 'address field'],
    ['name', 'name field'],
    ['given-name', 'name field'],
    ['family-name', 'name field'],
  ]);

  /**
   * What to call a field the decoy or wrong-field patterns caught.
   *
   * The reason shown is the *kind* of field, not the pattern that matched: a
   * reader wants "postcode field", not "matched /zip|postal/". Order matters
   * only where two could match; the first wins.
   */
  const REFUSAL_KINDS = [
    [/zip|postal|postcode|\bpost\b/i, 'postcode field'],
    [/promo|coupon|discount|voucher|gift|referral|invit/i, 'promo code field'],
    [/phone|mobile|\btel\b|dial|area/i, 'phone field'],
    [/search|query/i, 'search box'],
    [/e-?mail/i, 'email field'],
    [/user|login[-_ ]?id/i, 'username field'],
    [/address|street|city|state|province|country/i, 'address field'],
    [/birth|\bdob\b/i, 'date of birth'],
    [/amount|quantity|\bqty\b|currency/i, 'amount field'],
  ];

  /** Below this, it is not a code box and nothing gets typed into it. */
  const ACCEPT_SCORE = 30;

  /** Walking every element to find shadow roots is bounded on huge pages. */
  const SHADOW_SCAN_LIMIT = 8000;

  /** Skipped fields reported per page. Three is a decision; ten is a dump. */
  const MAX_REFUSALS = 3;

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

  const collapse = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

  /** The words on an input's own label, if it has one. */
  function labelText(input) {
    const parts = [];
    const labelledBy = input.getAttribute('aria-labelledby');
    if (labelledBy) {
      for (const id of labelledBy.split(/\s+/)) parts.push(document.getElementById(id)?.textContent ?? '');
    }
    if (input.labels) for (const label of input.labels) parts.push(label.textContent ?? '');
    if (input.id) {
      const root = input.getRootNode();
      if (root instanceof ShadowRoot) {
        parts.push(root.querySelector(`label[for="${CSS.escape(input.id)}"]`)?.textContent ?? '');
      }
    }
    return collapse(parts.filter(Boolean).join(' '));
  }

  /**
   * How a person would refer to this field.
   *
   * Its label first, because that is what is on screen; then the attributes a
   * page uses instead of one. Short, because it goes in a sentence.
   */
  function fieldLabel(input) {
    const candidates = [
      labelText(input),
      input.getAttribute('aria-label'),
      input.getAttribute('placeholder'),
      input.getAttribute('name'),
      input.getAttribute('id'),
    ];
    const text = candidates.map(collapse).find(Boolean) ?? 'a field';
    return text.length > 32 ? `${text.slice(0, 31)}…` : text;
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
      labelText(input),
    ];

    // The heading or sentence just above the field is often the only place the
    // words "verification code" appear.
    const container = input.closest('form, fieldset, section, div');
    if (container) parts.push((container.textContent ?? '').slice(0, 400));

    return parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').toLowerCase();
  }

  /** The field's own words: attributes and label, without the surrounding copy. */
  function nameplate(input) {
    return [
      input.getAttribute('name'),
      input.getAttribute('id'),
      input.getAttribute('placeholder'),
      input.getAttribute('aria-label'),
      (input.getAttribute('autocomplete') ?? '').trim().toLowerCase(),
      input.className,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
  }

  /** Whether a field says "code" about itself — the ones worth explaining a refusal for. */
  const hinted = (own, label) => STRONG_HINT.test(own) || WEAK_HINT.test(own) || STRONG_HINT.test(label) || WEAK_HINT.test(label);

  /** The kind of field a decoy or wrong-field match points at. */
  function kindOf(text, fallback) {
    for (const [pattern, kind] of REFUSAL_KINDS) {
      if (pattern.test(text)) return kind;
    }
    return fallback;
  }

  /**
   * How likely is this input to be the code box?
   *
   * @returns {{ score: number, why: string[] } | { refused: string } | null}
   *   `refused` names the rule that ruled it out; null means it was never in
   *   the running — the wrong type of input, or one with nothing to say.
   */
  function scoreInput(input, { active }) {
    const type = (input.getAttribute('type') ?? '').toLowerCase();
    if (!FILLABLE_TYPES.has(type)) return null;

    const autocomplete = (input.getAttribute('autocomplete') ?? '').trim().toLowerCase();
    const own = nameplate(input);
    const label = labelText(input).toLowerCase();

    if (!isVisible(input)) {
      // A code box that is not on screen yet is worth a word — the page is
      // probably about to reveal it — and every other hidden input is not.
      return hinted(own, label) && !PAYMENT_HINT.test(own) ? { refused: 'not visible yet' } : null;
    }

    if (autocomplete === 'one-time-code') {
      // The standard attribute is definitive; skip the rest of the gauntlet.
      return { score: 100 + (active ? 10 : 0), why: ['autocomplete="one-time-code"'] };
    }

    // Disqualifications. These use the field's own attributes, not the
    // surrounding copy, because a checkout page mentions "code" everywhere.
    // Only a field that calls itself a code gets its refusal explained: nobody
    // needs to be told the email box was not filled with a one-time code.
    const explain = (rule) => (hinted(own, label) ? { refused: rule } : null);
    if (WRONG_AUTOCOMPLETE.has(autocomplete)) return explain(WRONG_AUTOCOMPLETE.get(autocomplete));
    if (PAYMENT_HINT.test(own)) return explain('card field');
    if (DECOY_HINT.test(own)) return explain(kindOf(own, 'a different kind of code'));
    if (SECRET_HINT.test(own)) return explain('password field');
    if (WRONG_FIELD_HINT.test(own)) return explain(kindOf(own, 'not a code field'));

    const description = describe(input);
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
   * @typedef {{ kind: 'single', input: HTMLInputElement, score: number, why: string[] }
   *         | { kind: 'segmented', inputs: HTMLInputElement[], score: number, why: string[] }} Target
   */

  /**
   * Look over the page: the best place to put a code, and the fields that were
   * passed over on the way to it.
   *
   * The refusals are the safety story made visible. A checkout page whose CVV is
   * labelled "Security code" produces no target and one refusal — and the
   * refusal is what tells the person the extension saw the field and chose not
   * to touch it, which is a very different thing from not having looked.
   *
   * @returns {{ target: Target | null, refused: Array<{ label: string, rule: string }> }}
   */
  function survey() {
    const inputs = collectInputs();
    const refused = [];
    const refuse = (input, rule) => {
      if (refused.length < MAX_REFUSALS) refused.push({ label: fieldLabel(input), rule });
    };
    if (inputs.length === 0) return { target: null, refused };

    const active = document.activeElement;
    const segmented = findSegmentedGroup(inputs);
    const inGroup = new Set(segmented ?? []);

    let best = null;
    for (const input of inputs) {
      if (inGroup.has(input)) continue;
      const verdict = scoreInput(input, { active: input === active });
      if (!verdict) continue;
      if (verdict.refused) {
        refuse(input, verdict.refused);
        continue;
      }
      if (!best || verdict.score > best.score) best = { kind: 'single', input, ...verdict };
    }

    if (segmented) {
      const named = segmented.some((input) => STRONG_HINT.test(`${input.name} ${input.id} ${input.className}`));
      const focused = segmented.includes(active);
      return {
        target: {
          kind: 'segmented',
          inputs: segmented,
          score: 70 + (named ? 20 : 0) + (focused ? 15 : 0),
          why: [`${segmented.length} single-character boxes`, ...(named ? ['named like a one-time code'] : [])],
        },
        refused,
      };
    }

    if (best && best.score < ACCEPT_SCORE) {
      // It said something about itself, and not enough. Worth reporting for the
      // same reason as the outright refusals: it was looked at.
      if (best.score >= 16) refuse(best.input, 'not clearly a code box');
      best = null;
    }
    return { target: best, refused };
  }

  /** The best place on this page to put a code, or null. */
  function findTarget() {
    return survey().target;
  }

  /** What a target is called, for "Filled 'Verification code'". */
  function targetLabel(target) {
    if (target.kind === 'segmented') return `${target.inputs.length} boxes`;
    const label = fieldLabel(target.input);
    return label === 'a field' ? '' : label;
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

  /** The inputs a target is made of, in order. */
  const inputsOf = (target) => (target.kind === 'segmented' ? target.inputs : [target.input]);

  /** Write a code into a target, whichever shape it is. */
  function write(target, code) {
    return target.kind === 'segmented' ? fillSegmented(target.inputs, code) : fillSingle(target.input, code);
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
   *
   * The destructive verbs are stems on purpose. This list used to hold `delete`
   * and `remove` as literals, which reads as covering the case and does not:
   * "Confirm account deletion" and "Confirm removal of this device" contain
   * neither, and both match `confirm\w*` in the list above — so both were clicked.
   * Wording that is dangerous is dangerous in every inflection, so anything added
   * here should be a stem unless there is a reason it cannot be.
   */
  const AVOID_TEXT =
    /(cancel|dismiss|close|go back|\bback\b|resend|send again|send another|new code|another code|try another|use another|another (way|method|option)|different|didn['’ʼ]?t|did not|not you|having trouble|trouble|help|support|sign ?up|register|create account|remember|trust|skip|call me|text me|more options|other options|delet\w*|remov\w*|deactivat\w*|deregister|terminat\w*|revok\w*|unsubscrib\w*|disconnect\w*|log ?out|sign ?out)/i;

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

  /** The words a button shows, short enough to quote: "Pressed Verify". */
  function pressedName(element) {
    const own = collapse(element.textContent) || collapse(element.value) || collapse(element.getAttribute('aria-label'));
    const text = own || buttonText(element);
    return text.length > 40 ? `${text.slice(0, 39)}…` : text;
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
   * @returns {Promise<{ kind: 'clicked' | 'requested' | 'enter' | false, pressed: string }>}
   *   `pressed` is the button's wording when one was clicked, and what the
   *   popup quotes back: "Pressed Verify".
   */
  async function submitFrom(input) {
    const form = input.closest('form');

    if (form) {
      for (const wait of SUBMIT_RETRY_DELAYS) {
        if (wait) await sleep(wait);
        // Replaced by a re-render, or the page submitted itself while we waited.
        // Either way this is finished, and claiming otherwise would be a guess.
        if (!input.isConnected) return { kind: false, pressed: '' };
        const button = submitButton(form);
        if (button) {
          const pressed = pressedName(button);
          button.click();
          return { kind: 'clicked', pressed };
        }
      }

      if (typeof form.requestSubmit === 'function') {
        try {
          form.requestSubmit();
          return { kind: 'requested', pressed: '' };
        } catch {
          // Falls through to the key press.
        }
      }
    }

    return { kind: pressEnter(input) ? 'enter' : false, pressed: '' };
  }

  /**
   * What was last put into this page, so the card's buttons have something to
   * act on: "Submit anyway" presses the form the fill went into, and a swap
   * writes over the same boxes.
   */
  let lastFill = null;

  /**
   * @param {Target} target
   * @param {string} code
   * @param {object} options
   * @param {boolean} [options.submit]   press the button afterwards
   * @param {boolean} [options.hold]     fill, but leave the submit for a person —
   *                                     several codes arrived and none is tied to this site
   * @param {boolean} [options.toast]    say so on the page
   * @param {string}  [options.sender]   display name of the mail's sender
   * @param {string}  [options.address]  the sender's address
   * @param {number}  [options.receivedAt]  when the mail arrived, so the picker can say how old it is
   * @param {string}  [options.site]     registrable domain of this page
   * @param {Array<{ code: string, sender: string, address: string, receivedAt: number }>} [options.alternatives]
   *   the other codes that arrived, for the card's picker
   * @param {Array<{ label: string, rule: string }>} [options.refused]
   */
  async function fill(
    target,
    code,
    {
      submit = false,
      hold = false,
      toast = false,
      sender = '',
      address = '',
      receivedAt = 0,
      site = '',
      alternatives = [],
      refused = [],
    } = {},
  ) {
    const inputs = inputsOf(target);
    if (!write(target, code)) return { filled: false, reason: 'rejected', why: target.why, refused };
    highlight(inputs);

    let outcome = { kind: false, pressed: '' };
    if (submit && !hold) {
      try {
        // From the last box: that is where the caret is after a segmented fill,
        // and where Enter would have been pressed.
        outcome = await submitFrom(inputs[inputs.length - 1] ?? inputs[0]);
      } catch {
        outcome = { kind: false, pressed: '' };
      }
    }

    lastFill = {
      target,
      code,
      sender,
      address,
      receivedAt: Number(receivedAt) || 0,
      site,
      submitWanted: submit,
      submitted: Boolean(outcome.kind),
      held: Boolean(hold),
      alternatives: alternatives.filter((other) => other && other.code && other.code !== code),
    };

    // After the submit attempt, so the wording describes what happened rather
    // than what was intended.
    const toasted = toast
      ? showCard(
          hold
            ? {
                tone: 'hold',
                title: 'Held — check the sender',
                detail: `2FA Paster · from ${address || sender || 'an unknown sender'}`,
                note: heldNote(site),
                offerSubmit: submit,
                rows: lastFill.alternatives,
              }
            : {
                tone: 'ok',
                title: outcomeTitle('Code filled in', outcome),
                detail: `2FA Paster · from ${address || sender || 'your inbox'}`,
                rows: lastFill.alternatives,
              },
        )
      : false;

    return {
      filled: true,
      kind: target.kind,
      boxes: inputs.length,
      label: targetLabel(target),
      why: target.why,
      submitted: Boolean(outcome.kind),
      submitKind: outcome.kind || '',
      pressed: outcome.pressed,
      held: Boolean(hold),
      refused,
      toasted,
    };
  }

  /** "Code filled in, Verify pressed" — the title of the card, from what happened. */
  function outcomeTitle(prefix, { kind, pressed }) {
    if (kind === 'clicked' && pressed && pressed.length <= 24) return `${prefix}, ${pressed} pressed`;
    if (kind === 'enter') return `${prefix}, Enter pressed`;
    if (kind) return `${prefix} and submitted`;
    return prefix;
  }

  /** Why a code was held rather than submitted, for the card. */
  function heldNote(site) {
    return site
      ? `Filled but not submitted: several codes arrived and none name ${site}.`
      : 'Filled but not submitted: several codes arrived and nothing ties this one to this page.';
  }

  /**
   * Submit the form the last fill went into — the card's "Submit anyway".
   *
   * @returns {Promise<{ submitted: boolean, submitKind: string, pressed: string }>}
   */
  async function submitLast() {
    const target = liveTarget();
    if (!target) return { submitted: false, submitKind: '', pressed: '' };
    const inputs = inputsOf(target);
    let outcome = { kind: false, pressed: '' };
    try {
      outcome = await submitFrom(inputs[inputs.length - 1] ?? inputs[0]);
    } catch {
      outcome = { kind: false, pressed: '' };
    }
    if (lastFill && outcome.kind) lastFill = { ...lastFill, submitted: true, held: false };
    return { submitted: Boolean(outcome.kind), submitKind: outcome.kind || '', pressed: outcome.pressed };
  }

  /** The last fill's boxes if the page still has them, otherwise a fresh look. */
  function liveTarget() {
    const remembered = lastFill?.target;
    if (remembered && inputsOf(remembered).every((input) => input.isConnected)) return remembered;
    return findTarget();
  }

  /**
   * Put a different code into the same boxes — a picker row was clicked.
   *
   * The person chose this one, so it is delivered the way a chosen code is:
   * submitted if submitting is on. The code it replaced moves into the picker,
   * in case the swap was the mistake.
   */
  async function swapTo(row) {
    if (!lastFill) return;
    const target = liveTarget();
    if (!target) {
      renderCard({ tone: 'hold', title: 'The code box is gone', detail: 'The page has moved on; nothing to swap into.' });
      return;
    }
    if (!write(target, row.code)) {
      renderCard({ tone: 'hold', title: 'The page would not take it', detail: `Could not type the code from ${row.address || row.sender}.` });
      return;
    }
    highlight(inputsOf(target));

    let outcome = { kind: false, pressed: '' };
    if (lastFill.submitWanted) {
      try {
        const inputs = inputsOf(target);
        outcome = await submitFrom(inputs[inputs.length - 1] ?? inputs[0]);
      } catch {
        outcome = { kind: false, pressed: '' };
      }
    }

    const previous = { code: lastFill.code, sender: lastFill.sender, address: lastFill.address, receivedAt: lastFill.receivedAt };
    lastFill = {
      ...lastFill,
      target,
      code: row.code,
      sender: row.sender,
      address: row.address,
      receivedAt: Number(row.receivedAt) || 0,
      submitted: Boolean(outcome.kind),
      held: false,
      alternatives: [previous, ...lastFill.alternatives.filter((other) => other.code !== row.code)],
    };

    renderCard({
      tone: 'ok',
      title: outcomeTitle('Swapped in', outcome),
      detail: `2FA Paster · from ${row.address || row.sender || 'your inbox'}`,
      offerSubmit: lastFill.submitWanted && !outcome.kind,
      rows: lastFill.alternatives,
    });
    tell({ type: 'code-used', action: 'swapped', code: row.code, submitted: Boolean(outcome.kind), pressed: outcome.pressed });
  }

  /** One message to the extension's own worker, and nowhere else. */
  function tell(message) {
    try {
      chrome.runtime.sendMessage(message, () => void chrome.runtime.lastError);
    } catch {
      // The extension was reloaded underneath us; nothing to do.
    }
  }

  /* ---------------------------------------------------------------- *
   * Saying so, on the page
   * ---------------------------------------------------------------- */

  const CARD_ID = '__twofa_paster_toast';
  /** A plain confirmation is read in a glance. */
  const CARD_MS = 4500;
  /** One with other codes to pick from deserves a longer look. */
  const CARD_WITH_ROWS_MS = 12000;
  /** A held code waits for a decision, but not forever. */
  const CARD_HELD_MS = 90000;
  /** Under this, the frame is a widget and a corner-anchored card would clip. */
  const CARD_MIN_WIDTH = 300;
  const CARD_MIN_HEIGHT = 200;

  let cardTimer = null;
  /** The mounted card, so a swap can redraw it in place rather than pop a second one. */
  let mounted = null;

  const CARD_STYLE = `
    :host { all: initial; }
    .card {
      display: grid;
      gap: 10px;
      box-sizing: border-box;
      width: max-content;
      max-width: 340px;
      min-width: 240px;
      padding: 12px 14px;
      border-radius: 13px;
      background: #ffffff;
      box-shadow: 0 2px 6px rgba(0,0,0,.09), 0 12px 32px rgba(0,0,0,.16);
      color: #1d1d1f;
      font: 500 13px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
      text-align: left;
      transition: opacity .18s ease, transform .18s ease;
    }
    .enter { opacity: 0; transform: translateY(8px); }
    .head { display: flex; align-items: flex-start; gap: 10px; }
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
      font-weight: 700;
      line-height: 1;
    }
    .mark.hold { background: #b46e00; }
    .copy { display: grid; gap: 2px; min-width: 0; flex: 1; }
    .title { font-weight: 640; }
    .detail { color: #6a6a74; font-size: 12px; font-weight: 450; overflow-wrap: anywhere; }
    .note { color: #8a5300; font-size: 12px; font-weight: 500; }
    .close {
      display: grid;
      place-items: center;
      width: 22px;
      height: 22px;
      flex: 0 0 auto;
      margin: -2px -4px 0 0;
      padding: 0;
      border: 0;
      border-radius: 6px;
      background: none;
      color: #8a8a94;
      font: 500 15px/1 inherit;
      cursor: pointer;
    }
    .close:hover { background: #f0eff5; color: #1d1d1f; }
    .actions { display: flex; gap: 8px; }
    .button {
      min-height: 30px;
      padding: 0 12px;
      border: 0;
      border-radius: 9px;
      background: #5b45e0;
      color: #fff;
      font: 620 12.5px/1 inherit;
      cursor: pointer;
    }
    .button:hover { background: #4a37c4; }
    .picker { display: grid; gap: 4px; padding-top: 8px; border-top: 1px solid rgba(60,60,67,.14); }
    .picker-title { color: #6a6a74; font-size: 11.5px; font-weight: 620; letter-spacing: .01em; }
    .row {
      display: grid;
      gap: 1px;
      width: 100%;
      padding: 6px 8px;
      border: 0;
      border-radius: 8px;
      background: #f4f3f8;
      color: #1d1d1f;
      font: inherit;
      text-align: left;
      cursor: pointer;
    }
    .row:hover { background: #e9e7f3; }
    .row strong { font-weight: 640; }
    .row strong b { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; letter-spacing: .06em; }
    .row small { color: #6a6a74; font-size: 11.5px; overflow-wrap: anywhere; }
    .button:focus-visible, .row:focus-visible, .close:focus-visible { outline: 2px solid rgba(91,69,224,.6); outline-offset: 1px; }
    @media (prefers-color-scheme: dark) {
      .card { background: #26262b; color: #f2f2f5; box-shadow: 0 2px 6px rgba(0,0,0,.4), 0 12px 32px rgba(0,0,0,.5); }
      .detail, .picker-title, .row small { color: #a3a3ad; }
      .note { color: #f0b849; }
      .close { color: #a3a3ad; }
      .close:hover { background: #32323a; color: #f2f2f5; }
      .row { background: #32323a; color: #f2f2f5; }
      .row:hover { background: #3c3c46; }
      .picker { border-top-color: rgba(235,235,245,.14); }
      .button { background: #6d5bff; }
    }
    @media (prefers-reduced-motion: reduce) {
      .card { transition: none; }
      .enter { opacity: 1; transform: none; }
    }
  `;

  /** "12s ago", for a picker row. */
  function ageOf(timestamp) {
    if (!timestamp) return '';
    const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
    if (seconds < 10) return 'just now';
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.round(seconds / 60);
    return minutes === 1 ? '1 min ago' : `${minutes} min ago`;
  }

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
   * DOM. The code that went in is never shown — it is on the screen already, in
   * the box. The *other* codes that arrived are, in the picker, because naming
   * them is the whole point of offering a swap.
   *
   * @param {{ tone: 'ok' | 'hold', title: string, detail: string, note?: string,
   *           offerSubmit?: boolean, rows?: Array<object> }} state
   * @returns {boolean} whether anything was actually put on screen
   */
  function showCard(state) {
    if (!document.body) return false;
    if (window.innerWidth < CARD_MIN_WIDTH || window.innerHeight < CARD_MIN_HEIGHT) return false;

    try {
      document.getElementById(CARD_ID)?.remove();
      mounted = null;

      const host = document.createElement('div');
      host.id = CARD_ID;
      host.style.cssText =
        'all: initial; position: fixed !important; right: 16px !important; bottom: 16px !important;' +
        'z-index: 2147483647 !important; width: auto !important; height: auto !important;' +
        'pointer-events: auto !important; contain: layout style;';

      const root = host.attachShadow({ mode: 'closed' });
      // A constructed stylesheet rather than a `<style>` element: it never enters
      // the page's DOM, so a strict `style-src` policy has nothing to object to.
      try {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(CARD_STYLE);
        root.adoptedStyleSheets = [sheet];
      } catch {
        const style = document.createElement('style');
        style.textContent = CARD_STYLE;
        root.append(style);
      }

      const card = document.createElement('div');
      card.className = 'card enter';
      card.setAttribute('role', 'status');
      card.setAttribute('aria-live', 'polite');
      root.append(card);
      document.body.append(host);

      mounted = { host, card, ms: CARD_MS };
      renderCard(state);

      // One frame later, so the transition has a starting point to move from.
      requestAnimationFrame(() => card.classList.remove('enter'));

      // Reading pauses the clock; leaving restarts it, for as long as this
      // kind of card gets — a held code is not hurried off the screen because
      // the pointer crossed it.
      card.addEventListener('mouseenter', () => clearTimeout(cardTimer));
      card.addEventListener('mouseleave', () => armDismiss(mounted?.ms ?? CARD_MS));
      return true;
    } catch {
      return false;
    }
  }

  function dismissCard() {
    clearTimeout(cardTimer);
    if (!mounted) return;
    const { host, card } = mounted;
    mounted = null;
    card.classList.add('enter');
    setTimeout(() => host.remove(), 200);
  }

  function armDismiss(ms) {
    clearTimeout(cardTimer);
    cardTimer = setTimeout(dismissCard, ms);
  }

  /** Draw, or redraw, the card's contents from a state. */
  function renderCard(state) {
    if (!mounted) return;
    const { card } = mounted;
    const rows = (state.rows ?? []).slice(0, 4);
    card.replaceChildren();

    const head = document.createElement('div');
    head.className = 'head';

    const mark = document.createElement('span');
    mark.className = `mark${state.tone === 'hold' ? ' hold' : ''}`;
    mark.setAttribute('aria-hidden', 'true');
    mark.textContent = state.tone === 'hold' ? '!' : '✓';

    const copy = document.createElement('span');
    copy.className = 'copy';
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = state.title;
    const detail = document.createElement('span');
    detail.className = 'detail';
    detail.textContent = state.detail;
    copy.append(title, detail);
    if (state.note) {
      const note = document.createElement('span');
      note.className = 'note';
      note.textContent = state.note;
      copy.append(note);
    }

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'close';
    close.setAttribute('aria-label', 'Dismiss');
    close.textContent = '×';
    close.addEventListener('click', dismissCard);

    head.append(mark, copy, close);
    card.append(head);

    if (state.offerSubmit) {
      const actions = document.createElement('div');
      actions.className = 'actions';
      const submit = document.createElement('button');
      submit.type = 'button';
      submit.className = 'button';
      submit.textContent = 'Submit anyway';
      submit.addEventListener('click', async () => {
        submit.disabled = true;
        const outcome = await submitLast();
        renderCard({
          tone: 'ok',
          title: outcomeTitle('Submitted', { kind: outcome.submitKind, pressed: outcome.pressed }).replace(
            /^Submitted, /,
            'Submitted — ',
          ),
          detail: state.detail,
          rows: lastFill?.alternatives ?? [],
        });
        tell({ type: 'code-used', action: 'submitted', code: lastFill?.code ?? '', submitted: outcome.submitted, pressed: outcome.pressed });
      });
      actions.append(submit);
      card.append(actions);
    }

    if (rows.length > 0) {
      const picker = document.createElement('div');
      picker.className = 'picker';
      const heading = document.createElement('span');
      heading.className = 'picker-title';
      heading.textContent = 'Other recent codes';
      picker.append(heading);
      for (const row of rows) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'row';
        const strong = document.createElement('strong');
        strong.append('Use ');
        const code = document.createElement('b');
        code.textContent = row.code;
        strong.append(code, ' instead');
        const small = document.createElement('small');
        small.textContent = [row.address || row.sender || 'unknown sender', ageOf(row.receivedAt)].filter(Boolean).join(' · ');
        button.append(strong, small);
        button.setAttribute('aria-label', `Use ${row.code} instead, from ${row.address || row.sender || 'an unknown sender'}`);
        button.addEventListener('click', () => {
          button.disabled = true;
          swapTo(row);
        });
        picker.append(button);
      }
      card.append(picker);
    }

    mounted.ms = state.tone === 'hold' || state.offerSubmit ? CARD_HELD_MS : rows.length > 0 ? CARD_WITH_ROWS_MS : CARD_MS;
    armDismiss(mounted.ms);
  }

  /* ---------------------------------------------------------------- *
   * Talking to the service worker
   * ---------------------------------------------------------------- */

  /**
   * The handlers stay silent when this frame has no code box.
   *
   * A code form is often inside an iframe, so the fill is addressed to every
   * frame in the tab at once. Chrome uses the first reply it gets, which means a
   * frame with nothing to offer must not reply at all — otherwise the outer
   * document answers "no field here" before the iframe that has the field gets a
   * word in. No reply from anywhere is the caller's signal that the page has no
   * code box, and its cue to ask `why-no-field`, which only the top frame
   * answers, with the fields it looked at and passed over.
   */
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'has-code-field') {
      const { target, refused } = survey();
      if (!target) return false;
      sendResponse({ ok: true, hasField: true, kind: target.kind, why: target.why, label: targetLabel(target), refused });
      return false;
    }

    if (message?.type === 'why-no-field') {
      if (window !== window.top) return false;
      let refused = [];
      try {
        refused = survey().refused;
      } catch {
        refused = [];
      }
      sendResponse({ ok: true, refused });
      return false;
    }

    if (message?.type === 'fill-code') {
      let looked;
      try {
        looked = survey();
      } catch {
        return false;
      }
      if (!looked.target) return false;

      // Answered asynchronously: submitting waits a moment for a button the page
      // has not enabled yet, and the caller wants to know whether that worked.
      fill(looked.target, String(message.code ?? ''), {
        submit: Boolean(message.submit),
        hold: Boolean(message.hold),
        toast: Boolean(message.toast),
        sender: String(message.sender ?? ''),
        address: String(message.address ?? ''),
        receivedAt: Number(message.receivedAt) || 0,
        site: String(message.site ?? ''),
        alternatives: Array.isArray(message.alternatives) ? message.alternatives : [],
        refused: looked.refused,
      })
        .then((result) => sendResponse({ ok: true, ...result }))
        .catch((error) =>
          sendResponse({ ok: true, filled: false, reason: 'error', error: String(error?.message ?? error) }),
        );
      return true;
    }

    if (message?.type === 'show-picker') {
      // The shortcut pressed again on a page that was just filled: the card comes
      // back with the other codes. Only the frame holding the fill answers, and
      // only while the boxes it filled are still on the page — otherwise the
      // worker treats the press as the ordinary fetch it would have been.
      if (!lastFill || !inputsOf(lastFill.target).every((input) => input.isConnected)) return false;
      const rows = (Array.isArray(message.rows) ? message.rows : []).filter(
        (row) => row && row.code && row.code !== lastFill.code,
      );
      lastFill = { ...lastFill, alternatives: rows };
      const held = Boolean(lastFill.held && !lastFill.submitted);
      const shown = showCard(
        held
          ? {
              tone: 'hold',
              title: 'Held — check the sender',
              detail: `2FA Paster · from ${lastFill.address || lastFill.sender || 'an unknown sender'}`,
              note: heldNote(lastFill.site),
              offerSubmit: lastFill.submitWanted,
              rows,
            }
          : {
              tone: 'ok',
              title: 'Already filled in',
              detail: `2FA Paster · from ${lastFill.address || lastFill.sender || 'your inbox'}`,
              note: rows.length > 0 ? '' : 'No other code has arrived.',
              offerSubmit: lastFill.submitWanted && !lastFill.submitted,
              rows,
            },
      );
      sendResponse({ ok: true, shown });
      return false;
    }

    if (message?.type === 'submit-code') {
      // Only the frame that did the fill has a form to press; the others stay
      // silent for the same reason as above.
      if (!lastFill) return false;
      submitLast()
        .then((outcome) => {
          if (mounted) {
            renderCard({
              tone: 'ok',
              title: outcomeTitle('Submitted', { kind: outcome.submitKind, pressed: outcome.pressed }).replace(/^Submitted, /, 'Submitted — '),
              detail: `2FA Paster · from ${lastFill.address || lastFill.sender || 'your inbox'}`,
              rows: lastFill.alternatives,
            });
          }
          sendResponse({ ok: true, ...outcome });
        })
        .catch(() => sendResponse({ ok: true, submitted: false, submitKind: '', pressed: '' }));
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
    tell({ type: 'code-field-seen', href: at });
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

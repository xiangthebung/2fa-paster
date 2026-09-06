/**
 * Popup: the manual path, and the switch for the automatic one.
 *
 * All the work happens in the service worker — this reads a status object and
 * renders it. The one thing it does for itself is copying, because a popup is
 * focused and allowed to use the async clipboard API directly, which is a shorter
 * route than asking the worker to spin up an offscreen document.
 *
 * The centre of it is the decision card. It used to be a status line — "Filled it
 * in and submitted the form" — which said that something happened and nothing
 * about whether it was the right thing. The card says whose mail the code came
 * from, by address, and whether that is the site in front of you; what was
 * filled; which button was pressed; which fields were skipped and why; and, when
 * the sender could not be tied to the page, that the submit was held for you.
 */

import { SITE_ORIGINS } from './settings.js';
import { senderAddress, senderName } from './domains.js';
import { CATEGORY_LABELS, CATEGORY_NAMES } from './inbox-feed.js';

const $ = (id) => document.getElementById(id);

const els = {
  account: $('account'),
  settingsButton: $('settings-button'),
  notice: $('notice'),
  noticeTitle: $('notice-title'),
  noticeBody: $('notice-body'),
  noticeAction: $('notice-action'),
  noticeAlt: $('notice-alt'),
  ready: $('ready'),
  targetSite: $('target-site'),
  targetField: $('target-field'),
  pasteButton: $('paste-button'),
  pasteLabel: $('paste-label'),
  guideCard: $('guide-card'),
  guideShortcut: $('guide-shortcut'),
  guideKey: $('guide-key'),
  guideAuto: $('guide-auto'),
  guideDismiss: $('guide-dismiss'),
  codeCard: $('code-card'),
  codeValue: $('code-value'),
  codeSource: $('code-source'),
  codeAddress: $('code-address'),
  openMail: $('open-mail'),
  codeOrigin: $('code-origin'),
  codeOutcome: $('code-outcome'),
  heldActions: $('held-actions'),
  submitAnyway: $('submit-anyway'),
  heldAlternatives: $('held-alternatives'),
  codeWhy: $('code-why'),
  codeConfidence: $('code-confidence'),
  codeReasons: $('code-reasons'),
  copyButton: $('copy-button'),
  fillButton: $('fill-button'),
  emptyCard: $('empty-card'),
  emptyBody: $('empty-body'),
  openSearch: $('open-search'),
  retryButton: $('retry-button'),
  upgradeButton: $('upgrade-button'),
  status: $('status'),
  historyCard: $('history-card'),
  historyCount: $('history-count'),
  historyList: $('history-list'),
  historyClear: $('history-clear'),
  autoFill: $('auto-fill'),
  autoNote: $('auto-note'),
  autoSubmit: $('auto-submit'),
  watchBanner: $('watch-banner'),
  watchText: $('watch-text'),
  stopWatchButton: $('stop-watch-button'),
  shortcutHint: $('shortcut-hint'),
};

/** The same sentence the worker uses for a page extensions cannot touch. */
const UNFILLABLE_PAGE = 'Chrome does not allow filling on this page';

/** Latest status from the worker, so click handlers know the current tab. */
let state = null;
/** Kept so the age line can tick without another round trip. */
let shownCode = null;
/** The bound shortcut, for the button and the one-time tip. */
let shortcut = '';
/**
 * True after a search that found nothing, until the next one.
 *
 * The empty card takes the code card's place while it is up: "Nothing found"
 * above a large code from ten minutes ago reads as a contradiction, and the old
 * code is still one click away in the recent list.
 */
let emptyShown = false;
/**
 * A code this popup put on the clipboard itself.
 *
 * The worker only knows about the copies it made, and the decision card is
 * rendered from the worker's record, so a copy made here would otherwise vanish
 * from the card on the next poll.
 */
let copiedHere = '';

/**
 * Re-read the status this often while the popup is open.
 *
 * The backstop, not the main mechanism: storage changes below cover everything the
 * worker does, and this catches what it does not announce — the tab underneath
 * revealing a code box, a watch running out, a permission granted elsewhere.
 */
const POLL_MS = 2000;
/** Re-paint ages and the countdown this often, from state already in hand. */
const TICK_MS = 1000;

let pollTimer = null;
let tickTimer = null;
/**
 * Non-zero while a setting is being written.
 *
 * A poll landing between the switch flipping and the write returning would render
 * the old value and flick the switch back under the user's finger.
 */
let writing = 0;

/** @param {string} type @param {object} [payload] */
async function send(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...payload });
  if (!response) throw new Error('The extension did not respond. Try reloading it.');
  return response;
}

function setStatus(text, tone = '') {
  els.status.textContent = text ?? '';
  els.status.className = `status-message${tone ? ` is-${tone}` : ''}`;
}

function relativeAge(timestamp) {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  return minutes === 1 ? 'a minute ago' : `${minutes} min ago`;
}

/**
 * The same, to the minute.
 *
 * Used for the recent list, whose rows are a record rather than a countdown. Second
 * granularity there would mean rebuilding the list on every tick, which is both
 * wasteful and a good way to swallow a click.
 */
function coarseAge(timestamp) {
  const minutes = Math.floor(Math.max(0, Date.now() - timestamp) / 60000);
  if (minutes < 1) return 'just now';
  return minutes === 1 ? '1 min ago' : `${minutes} min ago`;
}

/** The tab's site, or the one the code was found for. */
const siteFor = (code) => code?.site || state?.tab?.site || '';

/* ------------------------------------------------------------------ *
 * The decision card
 * ------------------------------------------------------------------ */

/**
 * Where the sender stands with the page.
 *
 * Three answers. A confirmed match is reassurance: with several services mailing
 * codes, knowing this one came from the site in front of you is the difference
 * between pasting and checking first. Ambiguous is the opposite — several codes
 * arrived and nothing tied any of them here — and when the code went in, that is
 * the held state: filled, not submitted, waiting for a person. In between, the
 * sender simply is not tied to the page, which is said quietly.
 */
function renderOrigin(code) {
  const site = siteFor(code);
  const pill = els.codeOrigin;

  const say = (tone, title, note = '') => {
    pill.hidden = false;
    pill.className = `code-origin is-${tone}`;
    const strong = document.createElement('strong');
    strong.textContent = title;
    pill.replaceChildren(strong);
    if (note) {
      const span = document.createElement('span');
      span.textContent = note;
      pill.append(span);
    }
  };

  if (code.siteMatch) {
    say('match', code.senderSite ? `Sent by ${code.senderSite} — the site you are on` : 'This mail came from the site you are on');
    return;
  }
  if (code.ambiguous) {
    const heldInPage = Boolean(code.outcome?.filled && !code.outcome?.submitted);
    say(
      'unsure',
      heldInPage ? 'Held — check the sender' : 'Check the sender first',
      site
        ? `Several codes just arrived and none name ${site}.`
        : 'Several codes just arrived and nothing ties this one to this page.',
    );
    return;
  }
  if (site && code.senderSite && !code.outcome?.swapped) {
    say('neutral', `Not tied to ${site} by its sender`);
    return;
  }
  pill.hidden = true;
}

/**
 * What was done, one line each.
 *
 * Rendered from the record the worker keeps, not from the reply to a click, so a
 * popup opened after an automatic fill — the one nobody was watching — still
 * says what was filled, what was pressed and what was skipped.
 */
function renderOutcome(code) {
  const outcome = code.outcome;
  const list = els.codeOutcome;
  if (!outcome) {
    list.hidden = true;
    list.replaceChildren();
    return;
  }

  const rows = [];
  const row = (tone, text) => rows.push({ tone, text });

  if (outcome.filled) {
    if (outcome.kind === 'segmented') row('ok', `Filled ${outcome.boxes} boxes`);
    else row('ok', outcome.label ? `Filled “${outcome.label}”` : 'Filled the code box');

    if (outcome.submitted) {
      if (outcome.pressed) row('ok', `Pressed ${outcome.pressed}`);
      else if (outcome.submitKind === 'enter') row('ok', 'Pressed Enter');
      else row('ok', 'Submitted the form');
    } else if (outcome.held) {
      row('hold', 'Not submitted — check the sender first');
    } else if (outcome.submitWanted) {
      row('skip', 'Not submitted — the form had nothing to press');
    }
  } else if (outcome.fillReason === 'blocked') {
    row('bad', UNFILLABLE_PAGE);
  } else if (outcome.fillReason === 'no-field') {
    row('bad', 'No code box found on this page');
  } else if (outcome.fillReason === 'rejected') {
    row('bad', 'The page would not accept a typed value');
  } else if (outcome.fillReason === 'no-tab') {
    row('bad', 'No page here to fill');
  }

  for (const refusal of outcome.refused ?? []) {
    row('skip', `Skipped “${refusal.label}” — ${refusal.rule}`);
  }
  if (outcome.copied || copiedHere === code.code) row('ok', 'Copied to your clipboard');

  list.hidden = rows.length === 0;
  list.replaceChildren(
    ...rows.map(({ tone, text }) => {
      const item = document.createElement('li');
      item.className = `is-${tone}`;
      item.textContent = text;
      return item;
    }),
  );
}

/**
 * The held state's two ways out: press the button after all, or put a different
 * code in. Both one click, and both the same click the page's own card offers.
 */
function renderHeld(code) {
  const held = Boolean(code.held && code.outcome?.filled && !code.outcome?.submitted);
  els.heldActions.hidden = !held;
  if (!held) return;

  els.submitAnyway.hidden = !code.outcome.submitWanted;

  const rows = (state?.history ?? []).filter((entry) => entry.code !== code.code).slice(0, 2);
  els.heldAlternatives.replaceChildren(
    ...rows.map((entry) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'alt-button';
      button.dataset.code = entry.code;

      const strong = document.createElement('strong');
      strong.append('Use ');
      const value = document.createElement('b');
      value.textContent = entry.code;
      strong.append(value, ' instead');

      const small = document.createElement('small');
      small.textContent = [senderAddress(entry.from) || senderName(entry.from), coarseAge(entry.receivedAt)]
        .filter(Boolean)
        .join(' · ');

      button.append(strong, small);
      return button;
    }),
  );
}

function renderCode(code) {
  shownCode = code;
  if (!code || emptyShown) {
    els.codeCard.hidden = true;
    return;
  }

  els.codeCard.hidden = false;
  els.codeValue.textContent = code.code;
  els.codeConfidence.textContent = `${code.confidence}% sure`;
  els.codeReasons.replaceChildren(
    ...(code.reasons ?? []).map((reason) => {
      const item = document.createElement('li');
      item.textContent = reason;
      return item;
    }),
  );
  els.codeWhy.hidden = (code.reasons ?? []).length === 0;

  // The address, not only the display name: a spoofed name is indistinguishable
  // from a real one, and the address is what a person checks. With two mailboxes
  // signed in, also which of them the code landed in.
  const address = code.address || senderAddress(code.from);
  const several = (state?.accounts?.length ?? 0) > 1 && code.account;
  els.codeAddress.textContent = several ? `${address || 'unknown address'} → ${code.account}` : address;
  els.codeAddress.hidden = !address && !several;
  els.openMail.hidden = !code.link;

  renderOrigin(code);
  renderOutcome(code);
  renderHeld(code);
  paintAges();
}

/**
 * Re-paint everything that is only a function of the clock.
 *
 * Runs on a local timer with no round trip, so the age and the countdown stay
 * honest between polls.
 */
function paintAges() {
  if (shownCode) {
    els.codeSource.textContent = `From ${senderName(shownCode.from)} · ${relativeAge(shownCode.receivedAt)}`;
  }
  if (state?.watching) {
    const secondsLeft = Math.max(0, Math.round((state.watching.until - Date.now()) / 1000));
    els.watchText.textContent = `Watching your inbox — ${secondsLeft}s left`;
  }
}

/* ------------------------------------------------------------------ *
 * Nothing found
 * ------------------------------------------------------------------ */

/**
 * What the search read, said plainly, and the two ordinary reasons a code is not
 * in it: it was opened on the phone, or Gmail filed it under another tab. The
 * second is now checked automatically; the first has a button.
 */
function renderEmpty() {
  els.emptyCard.hidden = !emptyShown;
  if (!emptyShown) return;
  const minutes = state?.settings?.freshnessMinutes ?? 10;
  const feed = state?.source === 'feed';
  els.emptyBody.textContent = feed
    ? `No one-time code in unread mail from the last ${minutes} minutes. This reads unread Primary mail, ` +
      `and checked the ${inboxTabs()} tabs too.`
    : `No one-time code in mail from the last ${minutes} minutes that matched the code search.`;
  els.upgradeButton.hidden = !feed;
}

/** "Updates, Promotions, Social and Forums" — named from the list the reader actually probes. */
function inboxTabs() {
  const names = CATEGORY_LABELS.map((label) => CATEGORY_NAMES[label]).filter(Boolean);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names.join('');
}

/** A Gmail search for the mail this could not see: recent, and worded like a code. */
function gmailSearchUrl() {
  const index = state?.accounts?.[0]?.index ?? 0;
  const query = 'newer_than:1d (code OR verification OR passcode OR OTP OR "one-time")';
  return `https://mail.google.com/mail/u/${index}/#search/${encodeURIComponent(query)}`;
}

/* ------------------------------------------------------------------ *
 * Recent codes
 * ------------------------------------------------------------------ */

/**
 * Codes seen in the last few minutes, and who each was for.
 *
 * The list exists for the moments the automatic path cannot be right about: two
 * services mailing within seconds of each other, a code filled into the tab you
 * had before this one, a page that swallowed one without saying so. Naming the
 * sender is most of the value — a bare list of six-digit numbers would not tell
 * you which is which.
 *
 * The row currently on show is left out. It is already the biggest thing on
 * screen, and repeating it costs a line that could hold the code you are after.
 */
/** Rebuilt only when it would actually look different. */
let historyPainted = '';

function renderHistory(entries) {
  const rows = (entries ?? []).filter((entry) => entry.code !== shownCode?.code);
  els.historyCard.hidden = rows.length === 0;
  if (rows.length === 0) {
    historyPainted = '';
    return;
  }

  // The list is rebuilt wholesale, so it is only rebuilt when something in it
  // changed. Polling every two seconds through `replaceChildren` would otherwise
  // pull the rows out from under a click, and reset any row being hovered.
  const signature = rows
    .map((entry) => [entry.code, entry.site, entry.filled, entry.submitted, coarseAge(entry.receivedAt)].join(':'))
    .join('|');
  if (signature === historyPainted) return;
  historyPainted = signature;

  els.historyCount.textContent = rows.length === 1 ? '1 more' : `${rows.length} more`;
  els.historyList.replaceChildren(
    ...rows.map((entry) => {
      const item = document.createElement('li');

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'history-row';
      button.dataset.code = entry.code;
      button.title = [senderAddress(entry.from), entry.subject].filter(Boolean).join(' — ') || `Code from ${senderName(entry.from)}`;

      const code = document.createElement('span');
      code.className = 'history-code';
      code.textContent = entry.code;

      const meta = document.createElement('span');
      meta.className = 'history-meta';
      // "who it came from · where it went · how long ago". The middle part is
      // only there when it went somewhere, which is what makes the list readable
      // when half the rows were filled and half were only seen.
      meta.textContent = [senderName(entry.from), entry.site ? `→ ${entry.site}` : '', coarseAge(entry.receivedAt)]
        .filter(Boolean)
        .join(' · ');

      button.append(code, meta);
      if (entry.filled) {
        const tag = document.createElement('span');
        tag.className = 'history-tag';
        tag.textContent = entry.submitted ? 'sent' : 'filled';
        button.append(tag);
      }

      item.append(button);
      return item;
    }),
  );
}

/* ------------------------------------------------------------------ *
 * The rest of the popup
 * ------------------------------------------------------------------ */

/**
 * What to say when a code cannot be fetched yet.
 *
 * Each case names one action. The inbox feed's only prerequisite is a Gmail
 * session, so its remedy is "open Gmail" — not a setup process, because it does
 * not have one.
 *
 * @returns {{ title: string, body: string, action: string, run: () => Promise<void> | void,
 *             alt?: string, runAlt?: () => void } | null}
 */
function blocker(status) {
  if (status.ready) return null;

  if (status.source === 'feed') {
    return {
      title: 'Sign in to Gmail',
      body:
        'This reads your inbox through the Gmail session already in this browser, so there is nothing to set up — ' +
        'but no signed-in Gmail was found. Open Gmail, sign in, then come back.',
      action: 'Open Gmail',
      run: async () => {
        await chrome.tabs.create({ url: 'https://mail.google.com/' });
        window.close();
      },
      alt: 'Check again',
      runAlt: async () => {
        const response = await send('connect');
        if (response.ok) render(response.status);
        else setStatus(explain(response.error), 'error');
      },
    };
  }

  if (!status.apiConfigured) {
    return {
      title: 'Set up full messages',
      body:
        'Reading whole messages uses the Gmail API and a Google OAuth client ID that belongs to you. ' +
        'The setup page has a six-step animated walkthrough, or you can keep using the no-setup inbox preview.',
      action: 'Open visual setup guide',
      run: () => chrome.runtime.openOptionsPage(),
      alt: 'Keep using inbox preview',
      runAlt: async () => {
        const response = await send('settings', { patch: { source: 'feed' } });
        if (response.ok) await refreshStatus();
      },
    };
  }

  return {
    title: 'Connect your Gmail',
    body: 'Setup looks complete. Grant access and 2FA Paster can read the messages that carry a code.',
    action: 'Connect Gmail',
    run: async () => {
      const response = await send('connect');
      if (response.ok) {
        render(response.status);
        setStatus('Connected. Ready when you need a code.', 'good');
        await checkField();
      } else {
        setStatus(explain(response.error), 'error');
      }
    },
  };
}

function renderNotice(status) {
  const blocking = blocker(status);
  els.notice.hidden = !blocking;
  els.ready.hidden = Boolean(blocking);
  if (!blocking) return;

  els.noticeTitle.textContent = blocking.title;
  els.noticeBody.textContent = blocking.body;
  els.noticeAction.textContent = blocking.action;
  els.noticeAction.onclick = () =>
    busy(els.noticeAction, 'Working…', async () => {
      try {
        await blocking.run();
      } catch (error) {
        setStatus(error.message, 'error');
      }
    });

  els.noticeAlt.hidden = !blocking.alt;
  if (blocking.alt) {
    els.noticeAlt.textContent = blocking.alt;
    els.noticeAlt.onclick = async () => {
      try {
        await blocking.runAlt();
      } catch (error) {
        setStatus(error.message, 'error');
      }
    };
  }
}

/**
 * The note under the automatic-filling switch.
 *
 * The one thing it has to say before the switch is flipped: Chrome will ask for
 * the permission, and the popup closes to make room for the prompt. Saying it
 * afterwards is too late — the popup is gone.
 */
function autoNote(status) {
  if (status.settings.autoFill && !status.autoGranted) {
    return 'Needs permission to run on the sites you visit — click to grant it';
  }
  if (!status.settings.autoFill && !status.autoGranted) {
    return 'Chrome asks once to run on the sites you visit; the popup closes while it asks';
  }
  return 'Watches for a code box and fills it as soon as the mail lands';
}

function render(status) {
  state = status;
  renderNotice(status);

  if (!status.ready) {
    els.account.textContent = status.source === 'feed' ? 'No Gmail session' : 'Not connected';
    els.account.title = '';
  } else if ((status.accounts?.length ?? 0) > 1) {
    // Two addresses do not fit on one line, and an ellipsis in the middle of an
    // address is worse than a count. The addresses are in the tooltip, and the
    // one a code came from is on the code itself.
    els.account.textContent = `${status.accounts.length} accounts`;
    els.account.title = status.accounts.map((account) => account.account).join(', ');
  } else {
    els.account.textContent = status.email || 'Reading your inbox';
    els.account.title = status.email || '';
  }
  els.account.classList.toggle('is-connected', Boolean(status.ready && status.email));

  els.targetSite.textContent = status.tab?.site || status.tab?.title || 'This page';

  // Left alone while a write is in flight: a poll answering with the pre-toggle
  // value would flick the switch back while the user is still looking at it.
  if (writing === 0) {
    els.autoFill.checked = status.settings.autoFill;
    els.autoSubmit.checked = status.settings.autoSubmit;
  }

  els.autoNote.textContent = autoNote(status);

  // Not while it is mid-fill: `busy` has borrowed the caption and will put back
  // whatever it finds here when it is done.
  if (!els.fillButton.disabled) {
    els.fillButton.textContent = status.settings.autoSubmit ? 'Fill and submit' : 'Fill this page';
  }

  els.watchBanner.hidden = !status.watching;

  els.guideCard.hidden = !status.guide;
  els.guideAuto.hidden = status.settings.autoFill;

  renderEmpty();
  renderCode(status.lastCode);
  renderHistory(status.history);
  paintAges();
}

/* ------------------------------------------------------------------ *
 * Actions
 * ------------------------------------------------------------------ */

/**
 * Wrap a click so the button reports that it is working and cannot double-fire.
 *
 * @param {HTMLButtonElement} button
 * @param {string} busyText
 * @param {() => Promise<unknown>} work
 * @param {HTMLElement} [labelEl] element holding the caption, when it is not the button itself
 */
async function busy(button, busyText, work, labelEl = button) {
  const original = labelEl.textContent;
  button.disabled = true;
  button.classList.add('is-busy');
  labelEl.textContent = busyText;
  try {
    return await work();
  } finally {
    button.disabled = false;
    button.classList.remove('is-busy');
    labelEl.textContent = original;
  }
}

/**
 * Report a failure, and re-render if it means the source stopped being usable.
 *
 * A signed-out Gmail or a revoked grant is not really a message to show next to a
 * button — it is a change of state, and the adaptive notice says what to do about
 * it far better than a line of red text.
 */
function explain(error) {
  const kind = error?.kind ?? 'unknown';
  if (['signed-out', 'not-configured', 'needs-consent', 'no-account'].includes(kind)) {
    refreshStatus().catch(() => {});
  }
  return error?.message ?? 'Something went wrong.';
}

async function refreshStatus() {
  const response = await send('status');
  if (response.ok) render(response.status);
  return response;
}

/**
 * Write a setting, holding off the render that would otherwise race the switch.
 *
 * @param {Record<string, unknown>} patch
 */
async function saveSetting(patch) {
  writing += 1;
  try {
    return await send('settings', { patch });
  } finally {
    writing -= 1;
  }
}

/**
 * Ask the page whether it has somewhere to put a code.
 *
 * Three answers, each said differently: a box was found; Chrome will not let an
 * extension into this page at all; or no box, and the fields that were looked at
 * and passed over — "skipped 'Security code' (card field)" — which is the safety
 * story told before anything has been pressed.
 */
async function checkField() {
  if (!state?.tab?.id) return;
  try {
    const response = await send('has-field', { tabId: state.tab.id, url: state.tab.url ?? '' });
    const refused = response.refused ?? [];
    let text;
    if (response.hasField) text = 'Code box found — ready to fill';
    else if (response.blocked) text = response.reason || UNFILLABLE_PAGE;
    else if (refused.length > 0) text = `No code box — skipped “${refused[0].label}” (${refused[0].rule})`;
    else text = 'No code box found here';
    els.targetField.textContent = text;
    els.targetField.title = refused.map((entry) => `Skipped “${entry.label}” — ${entry.rule}`).join('\n');
    els.targetField.classList.toggle('is-found', Boolean(response.hasField));
    els.targetField.classList.toggle('is-blocked', Boolean(response.blocked));
  } catch {
    els.targetField.textContent = 'Cannot read this page';
  }
}

/** Show a fill's result, then re-read the worker's record so the card reflects what it kept. */
async function showResult(result) {
  emptyShown = false;
  renderEmpty();
  renderCode(result);
  await refreshStatus();
}

/**
 * Fetch and fill — the main button, and "Try again" on the empty card.
 *
 * @param {HTMLButtonElement} button    the one that was pressed, so it shows the work
 * @param {HTMLElement} [labelEl]
 */
function fetchCode(button, labelEl = button) {
  return busy(
    button,
    'Looking in Gmail…',
    async () => {
      setStatus('');
      try {
        const response = await send('paste', {
          tabId: state?.tab?.id ?? null,
          url: state?.tab?.url ?? '',
        });
        if (!response.ok) {
          setStatus(explain(response.error), 'error');
          return;
        }
        if (!response.found) {
          emptyShown = true;
          renderEmpty();
          renderCode(state?.lastCode ?? null);
          return;
        }
        await showResult(response.result);
      } catch (error) {
        setStatus(error.message, 'error');
      }
    },
    labelEl,
  );
}

els.pasteButton.addEventListener('click', () => fetchCode(els.pasteButton, els.pasteLabel));
els.retryButton.addEventListener('click', () => fetchCode(els.retryButton));

/**
 * Put a code on the clipboard.
 *
 * Written from here rather than through the worker because the popup is focused,
 * so the write is permitted and needs no offscreen document — but the wipe timer
 * belongs to the worker, which is the only thing still alive once this window
 * closes. Forgetting to arm it is why "wipe the clipboard after 30 seconds" used
 * to hold for a code the extension copied on your behalf and silently not for one
 * you copied yourself, which is the opposite of what the setting says.
 *
 * @param {string} text
 */
async function copy(text) {
  if (!text) return false;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // No clipboard access from here; the worker's offscreen document arms its own
    // timer, so this path needs nothing further.
    const ok = Boolean((await send('copy', { text })).ok);
    if (ok) copiedHere = text;
    return ok;
  }
  copiedHere = text;
  try {
    await send('clipboard-written');
  } catch {
    // The code is on the clipboard either way. Reporting a failure here would
    // describe the wrong thing.
  }
  return true;
}

async function copyShownCode() {
  if (!shownCode) return;
  const ok = await copy(shownCode.code);
  if (ok) renderOutcome(shownCode);
  setStatus(ok ? 'Copied to your clipboard.' : 'Could not reach the clipboard.', ok ? 'good' : 'error');
}

els.copyButton.addEventListener('click', copyShownCode);
// The code is the obvious thing to click, so clicking it does the obvious thing.
els.codeValue.addEventListener('click', copyShownCode);

els.fillButton.addEventListener('click', () =>
  busy(els.fillButton, 'Filling…', async () => {
    if (!state?.tab?.id) return;
    setStatus('');
    try {
      const response = await send('refill', { tabId: state.tab.id, url: state.tab.url ?? '' });
      if (!response.ok) {
        setStatus(explain(response.error), 'error');
        return;
      }
      if (!response.found) {
        setStatus('No code in hand. Fetch one first.', 'warn');
        return;
      }
      await showResult(response.result);
    } catch (error) {
      setStatus(error.message, 'error');
    }
  }),
);

/**
 * Press the button for a code that was held.
 *
 * The person has looked at the sender and decided. If the page has moved on since
 * the fill — the form re-rendered, the tab navigated — there is nothing to press,
 * and the card says so rather than pretending.
 */
els.submitAnyway.addEventListener('click', () =>
  busy(els.submitAnyway, 'Submitting…', async () => {
    setStatus('');
    try {
      const response = await send('submit', { tabId: state?.tab?.id ?? null });
      if (!response.ok) {
        setStatus(explain(response.error), 'error');
        return;
      }
      if (!response.found) {
        setStatus('No code in hand. Fetch one first.', 'warn');
        return;
      }
      if (!response.result.outcome?.submitted) {
        setStatus('Nothing to submit — the page may have moved on. Fill it again first.', 'warn');
      }
      await showResult(response.result);
    } catch (error) {
      setStatus(error.message, 'error');
    }
  }),
);

/**
 * Picking a code is how you correct a wrong guess, so it does the whole job:
 * clipboard and page, without another trip to Gmail. Shared by the recent list
 * and the held card's "Use … instead" buttons.
 */
async function useCode(code) {
  setStatus('');
  const copied = await copy(code);
  if (!state?.tab?.id) {
    setStatus(copied ? 'Copied it. There is no page here to fill.' : 'There is no page here to fill.', 'warn');
    return;
  }

  try {
    const response = await send('refill', { tabId: state.tab.id, url: state.tab.url ?? '', code });
    if (!response.ok) {
      setStatus(explain(response.error), 'error');
      return;
    }
    if (!response.found) {
      setStatus('That code is no longer in hand.', 'warn');
      return;
    }
    await showResult(response.result);
  } catch (error) {
    setStatus(error.message, 'error');
  }
}

els.historyList.addEventListener('click', (event) => {
  const row = event.target.closest('.history-row');
  if (row?.dataset.code) useCode(row.dataset.code);
});

els.heldAlternatives.addEventListener('click', (event) => {
  const button = event.target.closest('.alt-button');
  if (button?.dataset.code) useCode(button.dataset.code);
});

els.historyClear.addEventListener('click', async () => {
  await send('forget-history');
  await refreshStatus();
  setStatus('Recent codes cleared.');
});

els.openMail.addEventListener('click', () => {
  if (shownCode?.link) chrome.tabs.create({ url: shownCode.link });
});

els.openSearch.addEventListener('click', () => {
  chrome.tabs.create({ url: gmailSearchUrl() });
});

els.upgradeButton.addEventListener('click', () => chrome.runtime.openOptionsPage());

els.guideDismiss.addEventListener('click', async () => {
  els.guideCard.hidden = true;
  try {
    await send('dismiss-guide');
  } catch {
    // It will come back next time; that is the worst case.
  }
});

// No status message: the switch is the confirmation, and a line of text appearing
// underneath it only moves the thing that was just clicked.
els.autoSubmit.addEventListener('change', async () => {
  await saveSetting({ autoSubmit: els.autoSubmit.checked });
  await refreshStatus();
});

els.autoFill.addEventListener('change', async () => {
  const wanted = els.autoFill.checked;
  setStatus('');

  // Write the preference before asking for the permission. Chrome closes this
  // popup to show the prompt — the note under the switch says so beforehand —
  // and this way the grant is still matched by a setting when the worker
  // reconciles them afterwards.
  await saveSetting({ autoFill: wanted });

  if (!wanted) {
    await refreshStatus();
    return;
  }

  let granted = state?.autoGranted ?? false;
  if (!granted) {
    try {
      granted = await chrome.permissions.request({ origins: SITE_ORIGINS });
    } catch {
      granted = false;
    }
  }

  if (!granted) {
    // A refusal is an outcome, not a state the switch can show, so this one does
    // get said out loud.
    await saveSetting({ autoFill: false });
    await refreshStatus();
    setStatus('Automatic filling needs permission to run on the pages you visit.', 'warn');
    return;
  }

  await send('sync-auto');
  await refreshStatus();
});

els.stopWatchButton.addEventListener('click', async () => {
  await send('stop-watch');
  await refreshStatus();
  setStatus('Stopped watching.');
});

els.settingsButton.addEventListener('click', () => chrome.runtime.openOptionsPage());

/* ------------------------------------------------------------------ *
 * Staying current
 * ------------------------------------------------------------------ */

/**
 * Show the shortcut on the button that does the same thing.
 *
 * Hidden when nothing is bound, which happens when the suggested combination is
 * already taken. The options page is where that gets sorted out.
 */
async function showShortcut() {
  try {
    const commands = await chrome.commands.getAll();
    shortcut = commands.find((command) => command.name === 'paste-code')?.shortcut ?? '';
  } catch {
    shortcut = '';
  }
  els.shortcutHint.textContent = shortcut;
  els.shortcutHint.hidden = !shortcut;
  els.guideKey.textContent = shortcut;
  els.guideShortcut.hidden = !shortcut;
}

/**
 * Keep the popup honest for as long as it is open.
 *
 * Three mechanisms, because they cover different things and the cheap ones cover
 * most of it.
 *
 *   Storage events are instant and free. Everything the worker does lands in
 *   storage first — a code found, a watch started or expired, a setting changed
 *   from the options page — so this is what makes a code appear the moment it
 *   arrives, with the popup already open and nothing touched.
 *
 *   A one-second local tick re-paints the age and the countdown from state already
 *   in hand. No messaging, so it costs nothing.
 *
 *   A two-second poll is the backstop for what the worker never announces: the page
 *   underneath revealing a code box, a permission granted in another window, a
 *   Gmail session appearing after a sign-in elsewhere. That last one is why there is
 *   no longer any reason to press "Check again" — it re-checks itself.
 */
function goLive() {
  chrome.storage.onChanged.addListener(() => {
    refreshStatus().catch(() => {});
  });

  tickTimer = setInterval(paintAges, TICK_MS);
  pollTimer = setInterval(() => {
    refreshStatus()
      .then(() => (state?.ready ? checkField() : undefined))
      .catch(() => {
        // A poll that fails is not worth a message; the next one will say so if it
        // is a real problem, and the one that opened the popup already reported.
      });
  }, POLL_MS);
}

(async () => {
  await showShortcut();
  try {
    const response = await refreshStatus();
    if (!response.ok) {
      setStatus(explain(response.error), 'error');
      return;
    }
    if (state?.ready) await checkField();
  } catch (error) {
    setStatus(error.message, 'error');
  } finally {
    goLive();
  }
})();

window.addEventListener('unload', () => {
  clearInterval(pollTimer);
  clearInterval(tickTimer);
});

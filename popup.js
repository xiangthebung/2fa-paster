/**
 * Popup: the manual path, and the switch for the automatic one.
 *
 * All the work happens in the service worker — this reads a status object and
 * renders it. The one thing it does for itself is copying, because a popup is
 * focused and allowed to use the async clipboard API directly, which is a shorter
 * route than asking the worker to spin up an offscreen document.
 */

import { SITE_ORIGINS } from './settings.js';
import { senderName } from './domains.js';

const $ = (id) => document.getElementById(id);

const els = {
  account: $('account'),
  settingsButton: $('settings-button'),
  notice: $('notice'),
  noticeTitle: $('notice-title'),
  noticeBody: $('notice-body'),
  noticeAction: $('notice-action'),
  noticeAlt: $('notice-alt'),
  upgradeHint: $('upgrade-hint'),
  upgradeButton: $('upgrade-button'),
  ready: $('ready'),
  targetSite: $('target-site'),
  targetField: $('target-field'),
  pasteButton: $('paste-button'),
  pasteLabel: $('paste-label'),
  pasteSpinner: $('#paste-button .spinner'),
  codeCard: $('code-card'),
  codeValue: $('code-value'),
  codeSource: $('code-source'),
  codeOrigin: $('code-origin'),
  codeWhy: $('code-why'),
  codeConfidence: $('code-confidence'),
  codeReasons: $('code-reasons'),
  copyButton: $('copy-button'),
  fillButton: $('fill-button'),
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

/** Latest status from the worker, so click handlers know the current tab. */
let state = null;
/** Kept so the age line can tick without another round trip. */
let shownCode = null;

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

/**
 * Say whether this code belongs to the page, but only when that is worth saying.
 *
 * A confirmed match is reassurance: with several services mailing codes, knowing
 * this one came from the site in front of you is the difference between pasting
 * and checking first. `ambiguous` is the opposite — several codes arrived and
 * nothing tied any of them here, so the pick is a guess and should read like one.
 * Everything in between is silent, which is the common case.
 */
function renderOrigin(code) {
  const site = state?.tab?.site ?? '';

  if (code.siteMatch) {
    els.codeOrigin.hidden = false;
    els.codeOrigin.className = 'code-origin is-match';
    els.codeOrigin.textContent = code.senderSite
      ? `Sent by ${code.senderSite} — the site you are on`
      : 'This mail came from the site you are on';
    return;
  }
  if (code.ambiguous) {
    els.codeOrigin.hidden = false;
    els.codeOrigin.className = 'code-origin is-unsure';
    els.codeOrigin.textContent = site
      ? `Several codes just arrived and none name ${site}. Check this one first.`
      : 'Several codes just arrived. Check this one before using it.';
    return;
  }
  els.codeOrigin.hidden = true;
}

function renderCode(code) {
  shownCode = code;
  if (!code) {
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
  renderOrigin(code);
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
  // Use absolute timestamps (rounded to minutes) in the signature — not formatted
  // age strings — so the signature stays stable within each minute and does not
  // rebuild mid-hover when the text changes from "1 min ago" to "2 min ago".
  const signature = rows
    .map((entry) => {
      const minutes = Math.floor(Math.max(0, Date.now() - entry.receivedAt) / 60000);
      return [entry.code, entry.site, entry.filled, entry.submitted, entry.receivedAt, minutes].join(':');
    })
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
      button.title = entry.subject || `Code from ${senderName(entry.from)}`;

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

function render(status) {
  state = status;
  renderNotice(status);

  if (!status.ready) {
    els.account.textContent = status.source === 'feed' ? 'No Gmail session' : 'Not connected';
  } else {
    els.account.textContent = status.email || 'Reading your inbox';
  }
  els.account.classList.toggle('is-connected', Boolean(status.ready && status.email));

  // The upgrade only helps the feed's blind spot, so it is not offered otherwise,
  // and only after a search has actually come up empty.
  if (status.source !== 'feed') els.upgradeHint.hidden = true;

  els.targetSite.textContent = status.tab?.site || status.tab?.title || 'This page';

  // Left alone while a write is in flight: a poll answering with the pre-toggle
  // value would flick the switch back while the user is still looking at it.
  if (writing === 0) {
    els.autoFill.checked = status.settings.autoFill;
    els.autoSubmit.checked = status.settings.autoSubmit;
  }

  // The one thing worth saying about this row that the switch cannot: it is on,
  // but it cannot do anything until the permission is granted.
  els.autoNote.textContent =
    status.settings.autoFill && !status.autoGranted
      ? 'Needs permission to run on the sites you visit — click to grant it'
      : 'Watches for a code box and fills it as soon as the mail lands';

  // Not while it is mid-fill: `busy` has borrowed the caption and will put back
  // whatever it finds here when it is done.
  if (!els.fillButton.disabled) {
    els.fillButton.textContent = status.settings.autoSubmit ? 'Fill and submit' : 'Fill this page';
  }

  els.watchBanner.hidden = !status.watching;

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
  // Show spinner if available (for paste button), otherwise just change text
  if (els.pasteSpinner && button === els.pasteButton) {
    els.pasteSpinner.hidden = false;
    labelEl.textContent = 'Looking…';
  } else {
    labelEl.textContent = busyText;
  }
  try {
    return await work();
  } finally {
    button.disabled = false;
    button.classList.remove('is-busy');
    if (els.pasteSpinner && button === els.pasteButton) {
      els.pasteSpinner.hidden = true;
    }
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

function describeOutcome(result) {
  if (result.filled) {
    const done = result.submitted ? 'Filled it in and submitted the form' : 'Filled it in';
    return [`${done}.${result.copied ? ' Copied it too.' : ''}`, 'good'];
  }
  if (result.fillReason === 'blocked') {
    return ['Copied it. Chrome does not allow filling on this page.', 'warn'];
  }
  if (result.fillReason === 'no-field') {
    return [
      result.copied ? 'Copied it — no code box found here, so paste it yourself.' : 'No code box found on this page.',
      'warn',
    ];
  }
  if (result.fillReason === 'rejected') {
    return ['Copied it. The page would not accept a typed value, so paste it instead.', 'warn'];
  }
  return [result.copied ? 'Copied it to your clipboard.' : 'Found a code.', 'good'];
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

/** Ask the page whether it has somewhere to put a code. */
async function checkField() {
  if (!state?.tab?.id) return;
  try {
    const response = await send('has-field', { tabId: state.tab.id });
    els.targetField.textContent = response.hasField ? 'Code box found — ready to fill' : 'No code box found here';
    els.targetField.classList.toggle('is-found', Boolean(response.hasField));
  } catch {
    els.targetField.textContent = 'Cannot read this page';
  }
}

els.pasteButton.addEventListener('click', () =>
  busy(
    els.pasteButton,
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
          setStatus('Nothing in the last few minutes looks like a one-time code.', 'warn');
          // Now is the moment the upgrade is worth mentioning: the feed was read
          // successfully and the code was not in it.
          els.upgradeHint.hidden = state?.source !== 'feed';
          return;
        }
        els.upgradeHint.hidden = true;
        renderCode(response.result);
        const [text, tone] = describeOutcome(response.result);
        setStatus(text, tone);
        await refreshStatus();
      } catch (error) {
        setStatus(error.message, 'error');
      }
    },
    els.pasteLabel,
  ),
);

/** @param {string} text */
async function copy(text) {
  if (!text) return false;
  try {
    // The popup is focused, so this is allowed and needs no offscreen document.
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return Boolean((await send('copy', { text })).ok);
  }
}

async function copyShownCode() {
  if (!shownCode) return;
  const ok = await copy(shownCode.code);
  setStatus(ok ? 'Copied to your clipboard.' : 'Could not reach the clipboard.', ok ? 'good' : 'error');
}

els.copyButton.addEventListener('click', copyShownCode);
// The code is the obvious thing to click, so clicking it does the obvious thing.
els.codeValue.addEventListener('click', copyShownCode);

els.fillButton.addEventListener('click', () =>
  busy(els.fillButton, 'Filling…', async () => {
    if (!state?.tab?.id) return;
    const response = await send('refill', { tabId: state.tab.id });
    if (!response.ok) {
      setStatus(explain(response.error), 'error');
      return;
    }
    if (!response.found) {
      setStatus('No code in hand. Fetch one first.', 'warn');
      return;
    }
    const [text, tone] = describeOutcome(response.result);
    setStatus(text, tone);
  }),
);

/**
 * Picking a row is how you correct a wrong guess, so it does the whole job:
 * clipboard and page, without another trip to Gmail.
 */
els.historyList.addEventListener('click', async (event) => {
  const row = event.target.closest('.history-row');
  if (!row) return;
  const code = row.dataset.code;
  if (!code) return;

  await copy(code);
  if (!state?.tab?.id) {
    setStatus('Copied it. There is no page here to fill.', 'warn');
    return;
  }

  try {
    const response = await send('refill', { tabId: state.tab.id, code });
    if (!response.ok) {
      setStatus(explain(response.error), 'error');
      return;
    }
    const [text, tone] = describeOutcome({ ...response.result, copied: true });
    setStatus(text, tone);
  } catch (error) {
    setStatus(error.message, 'error');
  }
});

els.historyClear.addEventListener('click', async () => {
  await send('forget-history');
  await refreshStatus();
  setStatus('Recent codes cleared.');
});

els.upgradeButton.addEventListener('click', () => chrome.runtime.openOptionsPage());

// No status message: the switch is the confirmation, and a line of text appearing
// underneath it only moves the thing that was just clicked.
els.autoSubmit.addEventListener('change', async () => {
  await saveSetting({ autoSubmit: els.autoSubmit.checked });
  await refreshStatus();
});

els.autoFill.addEventListener('change', async () => {
  const wanted = els.autoFill.checked;
  setStatus('');

  // Write the preference before asking for the permission. Chrome may close this
  // popup to show the prompt, and this way the grant is still matched by a
  // setting when the worker reconciles them afterwards.
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
    const shortcut = commands.find((command) => command.name === 'paste-code')?.shortcut;
    els.shortcutHint.textContent = shortcut ?? '';
    els.shortcutHint.hidden = !shortcut;
  } catch {
    els.shortcutHint.hidden = true;
  }
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

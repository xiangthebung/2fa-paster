/**
 * Setup walkthrough and settings.
 *
 * The setup half exists because this extension cannot work until you have made
 * your own Google OAuth client, and that is a genuinely fiddly five minutes. The
 * page shows the extension's own ID — which is the piece of information the Cloud
 * console asks for and which nothing else tells you — and links straight to the
 * console pages in the order you need them.
 *
 * The `<all_urls>` grant for automatic filling is requested here rather than from
 * the popup: Chrome dismisses a popup to show the permission prompt, which loses
 * whatever the popup was in the middle of.
 */

import { SITE_ORIGINS } from './settings.js';

const $ = (id) => document.getElementById(id);

const els = {
  sourceChip: $('source-chip'),
  sourceDetail: $('source-detail'),
  sourceStatus: $('source-status'),
  sourceFeed: $('source-feed'),
  sourceApi: $('source-api'),
  primaryAction: $('primary-action'),
  openGmailButton: $('open-gmail-button'),
  disconnectButton: $('disconnect-button'),
  setupSection: $('setup-section'),
  setupChip: $('setup-chip'),
  searchSection: $('search-section'),
  extensionId: $('extension-id'),
  copyIdButton: $('copy-id-button'),
  autoFill: $('auto-fill'),
  autoCopy: $('auto-copy'),
  autoSubmit: $('auto-submit'),
  inPageToast: $('in-page-toast'),
  notify: $('notify'),
  freshness: $('freshness'),
  clipboardClear: $('clipboard-clear'),
  historyMinutes: $('history-minutes'),
  scanAll: $('scan-all'),
  extraQuery: $('extra-query'),
  shortcutValue: $('shortcut-value'),
  shortcutButton: $('shortcut-button'),
  optionsStatus: $('options-status'),
};

let state = null;

async function send(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...payload });
  if (!response) throw new Error('The extension did not respond. Try reloading it from chrome://extensions.');
  return response;
}

function setStatus(element, text, tone = '') {
  element.textContent = text ?? '';
  element.className = `status-message${tone ? ` is-${tone}` : ''}`;
}

/** Pick the option whose value matches, falling back to the first. */
function selectValue(select, value) {
  const wanted = String(value);
  select.value = [...select.options].some((option) => option.value === wanted) ? wanted : select.options[0].value;
}

/**
 * Everything about the source card, which has four states across two sources.
 *
 * Written as one function because the states are mutually exclusive and the
 * failure mode of spreading them out is a stale button left over from the
 * previous render.
 */
function renderSource(status) {
  const usingFeed = status.source === 'feed';
  els.sourceFeed.checked = usingFeed;
  els.sourceApi.checked = !usingFeed;

  // The setup steps and the search options only bear on the API reader. They stay
  // visible so they can be read before switching, but they stop shouting.
  els.setupSection.classList.toggle('is-dimmed', usingFeed);
  els.searchSection.classList.toggle('is-dimmed', usingFeed);
  els.setupChip.textContent = !status.apiConfigured
    ? 'Setup needed'
    : !usingFeed && status.ready
      ? 'Connected'
      : 'Client added';
  els.setupChip.className = `chip ${status.apiConfigured ? 'is-good' : 'is-warn'}`;

  els.openGmailButton.hidden = true;
  els.disconnectButton.hidden = true;
  els.primaryAction.disabled = false;

  if (usingFeed) {
    if (status.ready) {
      els.sourceChip.textContent = 'Working';
      els.sourceChip.className = 'chip is-good';
      const names = status.accounts.map((account) => account.account).join(', ');
      els.sourceDetail.textContent = status.accounts.length > 1
        ? `Reading the inbox preview for ${status.accounts.length} signed-in accounts: ${names}.`
        : `Reading the inbox preview for ${names || 'your signed-in account'}.`;
      els.primaryAction.textContent = 'Re-check accounts';
    } else {
      els.sourceChip.textContent = 'No Gmail session';
      els.sourceChip.className = 'chip is-warn';
      els.sourceDetail.textContent =
        status.problem?.message ??
        'No signed-in Gmail was found in this browser. Sign in to Gmail and check again — there is nothing else to set up.';
      els.primaryAction.textContent = 'Check again';
      els.openGmailButton.hidden = false;
    }
    return;
  }

  if (!status.apiConfigured) {
    els.sourceChip.textContent = 'Needs setup';
    els.sourceChip.className = 'chip is-warn';
    els.sourceDetail.textContent =
      'This build does not contain an OAuth client ID yet. Complete steps 1–5 below, rebuild and reload, then use step 6 to connect.';
    els.primaryAction.textContent = 'Connect Gmail';
    els.primaryAction.disabled = true;
    return;
  }

  if (!status.ready) {
    els.sourceChip.textContent = 'Not connected';
    els.sourceChip.className = 'chip';
    els.sourceDetail.textContent = 'Setup looks complete. Connect to let the extension read code emails.';
    els.primaryAction.textContent = 'Connect Gmail';
    return;
  }

  els.sourceChip.textContent = 'Connected';
  els.sourceChip.className = 'chip is-good';
  els.sourceDetail.textContent = status.email
    ? `Reading full messages from ${status.email}.`
    : 'Connected to Gmail.';
  els.primaryAction.textContent = 'Re-check connection';
  els.disconnectButton.hidden = false;
}

function render(status) {
  state = status;
  els.extensionId.textContent = status.extensionId;
  renderSource(status);

  els.autoFill.checked = status.settings.autoFill;
  els.autoCopy.checked = status.settings.autoCopy;
  els.autoSubmit.checked = status.settings.autoSubmit;
  els.inPageToast.checked = status.settings.inPageToast;
  els.notify.checked = status.settings.notify;
  els.scanAll.checked = status.settings.scanAllRecentMail;
  els.extraQuery.value = status.settings.extraQuery;
  selectValue(els.freshness, status.settings.freshnessMinutes);
  selectValue(els.clipboardClear, status.settings.clipboardClearSeconds);
  selectValue(els.historyMinutes, status.settings.historyMinutes);
}

async function refresh() {
  const response = await send('status');
  if (!response.ok) {
    setStatus(els.sourceStatus, response.error?.message ?? 'Could not read the extension state.', 'error');
    return null;
  }
  render(response.status);
  return response.status;
}

/** @param {Partial<Record<string, unknown>>} patch */
async function save(patch, note = 'Saved.') {
  const response = await send('settings', { patch });
  if (!response.ok) {
    setStatus(els.optionsStatus, response.error?.message ?? 'Could not save that.', 'error');
    return null;
  }
  setStatus(els.optionsStatus, note, 'good');
  return response.settings;
}

/* ------------------------------------------------------------------ *
 * Connection
 * ------------------------------------------------------------------ */

els.sourceFeed.addEventListener('change', () => switchSource('feed'));
els.sourceApi.addEventListener('change', () => switchSource('api'));

/** @param {'feed' | 'api'} source */
async function switchSource(source) {
  setStatus(els.sourceStatus, 'Switching…');
  const response = await send('settings', { patch: { source } });
  if (!response.ok) {
    setStatus(els.sourceStatus, response.error?.message ?? 'Could not switch.', 'error');
    return;
  }
  const status = await refresh();
  if (!status) return;

  if (source === 'feed') {
    setStatus(
      els.sourceStatus,
      status.ready ? 'Using the inbox preview. Nothing to set up.' : 'Using the inbox preview.',
      status.ready ? 'good' : '',
    );
  } else {
    setStatus(
      els.sourceStatus,
      status.apiConfigured
        ? 'Using full messages.'
        : 'Full messages needs the setup below before it can sign in.',
      status.apiConfigured ? 'good' : 'warn',
    );
  }
}

/**
 * One button, because the useful action depends entirely on the current state:
 * re-probe the signed-in mailboxes, or start an OAuth grant.
 */
els.primaryAction.addEventListener('click', async () => {
  const label = els.primaryAction.textContent;
  els.primaryAction.disabled = true;
  setStatus(els.sourceStatus, state?.source === 'feed' ? 'Checking Gmail…' : 'Waiting for Google…');
  try {
    const response = await send('connect');
    if (!response.ok) {
      setStatus(els.sourceStatus, describeAuthError(response.error), 'error');
      return;
    }
    render(response.status);
    if (response.status.ready) {
      setStatus(els.sourceStatus, state?.source === 'feed' ? 'Gmail found.' : 'Connected.', 'good');
    } else {
      setStatus(els.sourceStatus, 'Still nothing. Sign in to Gmail in this browser and try again.', 'warn');
    }
  } catch (error) {
    setStatus(els.sourceStatus, error.message, 'error');
  } finally {
    els.primaryAction.disabled = false;
    els.primaryAction.textContent = label;
  }
});

els.openGmailButton.addEventListener('click', () => chrome.tabs.create({ url: 'https://mail.google.com/' }));

/** Sign-in failures at this stage almost always mean a setup step went astray. */
function describeAuthError(error) {
  if (error?.kind === 'signed-out') {
    return `${error.message} Nothing else is needed — the inbox preview only wants a signed-in Gmail.`;
  }
  if (error?.kind === 'bad-client') {
    return (
      `${error.message} The Item ID on the OAuth client must be exactly ` +
      `"${state?.extensionId ?? 'this extension\u2019s ID'}", and the client ID has to be rebuilt in.`
    );
  }
  if (error?.kind === 'needs-consent') {
    return (
      'Google did not grant access. If the consent screen said the app is not verified, ' +
      'add your account under Test users on the consent screen and try again.'
    );
  }
  return error?.message ?? 'Sign-in failed.';
}

els.disconnectButton.addEventListener('click', async () => {
  els.disconnectButton.disabled = true;
  try {
    const response = await send('disconnect');
    if (response.ok) {
      render(response.status);
      setStatus(els.sourceStatus, 'Disconnected. The Gmail permission has been revoked at Google.', 'good');
    } else {
      setStatus(els.sourceStatus, response.error?.message ?? 'Could not disconnect.', 'error');
    }
  } finally {
    els.disconnectButton.disabled = false;
  }
});

els.copyIdButton.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(state?.extensionId ?? '');
    setStatus(els.sourceStatus, 'Extension ID copied.', 'good');
  } catch {
    setStatus(els.sourceStatus, 'Could not copy. Select the ID and copy it by hand.', 'warn');
  }
});

/* ------------------------------------------------------------------ *
 * Settings
 * ------------------------------------------------------------------ */

els.autoFill.addEventListener('change', async () => {
  const wanted = els.autoFill.checked;

  if (!wanted) {
    await save({ autoFill: false }, 'Automatic filling is off.');
    await refresh();
    return;
  }

  let granted = state?.autoGranted ?? false;
  if (!granted) {
    setStatus(els.optionsStatus, 'Waiting for the permission prompt…');
    try {
      granted = await chrome.permissions.request({ origins: SITE_ORIGINS });
    } catch {
      granted = false;
    }
  }

  if (!granted) {
    els.autoFill.checked = false;
    await save({ autoFill: false }, '');
    setStatus(
      els.optionsStatus,
      'Automatic filling needs permission to run on the pages you visit, so it stays off.',
      'warn',
    );
    await refresh();
    return;
  }

  await save({ autoFill: true }, 'On. A code box on any page will now start a short inbox watch.');
  await send('sync-auto');
  await refresh();
});

els.autoCopy.addEventListener('change', () => save({ autoCopy: els.autoCopy.checked }));
els.autoSubmit.addEventListener('change', () =>
  save(
    { autoSubmit: els.autoSubmit.checked },
    els.autoSubmit.checked
      ? 'Forms will be submitted for you after filling.'
      : 'The code will go in and stop there.',
  ),
);
els.inPageToast.addEventListener('change', () =>
  save(
    { inPageToast: els.inPageToast.checked },
    els.inPageToast.checked ? 'Fills will be confirmed on the page.' : 'No card will appear on the page.',
  ),
);
els.notify.addEventListener('change', () => save({ notify: els.notify.checked }));
els.historyMinutes.addEventListener('change', () =>
  save(
    { historyMinutes: Number(els.historyMinutes.value) },
    Number(els.historyMinutes.value) === 0 ? 'The recent list is off, and has been cleared.' : 'Saved.',
  ),
);
els.scanAll.addEventListener('change', () =>
  save(
    { scanAllRecentMail: els.scanAll.checked },
    els.scanAll.checked ? 'Recent mail will be checked when the keyword search comes up empty.' : 'Saved.',
  ),
);
els.freshness.addEventListener('change', () => save({ freshnessMinutes: Number(els.freshness.value) }));
els.clipboardClear.addEventListener('change', () =>
  save({ clipboardClearSeconds: Number(els.clipboardClear.value) }),
);

els.extraQuery.addEventListener('change', () => save({ extraQuery: els.extraQuery.value }));

/* ------------------------------------------------------------------ *
 * Shortcut
 * ------------------------------------------------------------------ */

// chrome:// pages cannot be reached from a link, only opened by the extension.
els.shortcutButton.addEventListener('click', () => {
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});

$('open-extensions-button').addEventListener('click', () => {
  chrome.tabs.create({ url: 'chrome://extensions' });
});

async function showShortcut() {
  try {
    const commands = await chrome.commands.getAll();
    const shortcut = commands.find((command) => command.name === 'paste-code')?.shortcut;
    els.shortcutValue.textContent = shortcut
      ? `Press ${shortcut} on any page to fetch the newest code and fill it in.`
      : 'No keyboard shortcut is set.';
  } catch {
    // Leave the default text.
  }
}

/* ------------------------------------------------------------------ *
 * Animated setup walkthrough
 * ------------------------------------------------------------------ */

const TOUR_SCENE_MS = 6500;

/**
 * A small, self-contained player rather than a video: its labels stay crisp,
 * it contains no account data, and every scene remains useful when motion is
 * disabled. The textual checklist is still the source of truth.
 */
function setupTour() {
  const root = $('setup-tour');
  const scenes = [...root.querySelectorAll('[data-tour-scene]')];
  const dots = [...root.querySelectorAll('[data-tour-index]')];
  const jumpButtons = [...document.querySelectorAll('[data-tour-jump]')];
  const location = $('tour-location');
  const caption = $('tour-caption');
  const announcer = $('tour-announcer');
  const autoButton = $('tour-auto-button');
  const motionButton = $('tour-play-button');
  const previousButton = $('tour-prev-button');
  const nextButton = $('tour-next-button');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  let current = 0;
  let autoAdvance = !reducedMotion.matches;
  let motionPaused = reducedMotion.matches;
  let timer = null;

  function clearTimer() {
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
  }

  function scheduleNext() {
    clearTimer();
    if (!autoAdvance || document.hidden) return;
    timer = window.setTimeout(() => showScene(current + 1), TOUR_SCENE_MS);
  }

  function paintAutoplay() {
    autoButton.textContent = autoAdvance ? 'Pause autoplay' : 'Start autoplay';
    autoButton.setAttribute(
      'aria-label',
      autoAdvance ? 'Pause automatic walkthrough steps' : 'Start automatic walkthrough steps',
    );
  }

  function setAutoAdvance(next) {
    autoAdvance = next;
    paintAutoplay();
    if (autoAdvance) scheduleNext();
    else clearTimer();
  }

  function paintMotion() {
    root.classList.toggle('is-paused', motionPaused);
    if (reducedMotion.matches) {
      motionButton.disabled = true;
      motionButton.textContent = 'Motion off';
      motionButton.setAttribute('aria-label', 'Motion is disabled by your system preference');
      return;
    }
    motionButton.disabled = false;
    motionButton.textContent = motionPaused ? 'Play motion' : 'Pause motion';
    motionButton.setAttribute(
      'aria-label',
      motionPaused ? 'Play the illustration motion' : 'Pause the illustration motion',
    );
  }

  /**
   * @param {number} requested
   * @param {{ scroll?: boolean, announce?: boolean }} [options]
   */
  function showScene(requested, options = {}) {
    current = (requested + scenes.length) % scenes.length;
    const active = scenes[current];

    for (const scene of scenes) {
      scene.classList.remove('is-active');
      scene.hidden = scene !== active;
    }
    // Force a fresh animation timeline when a scene is replayed.
    void active.offsetWidth;
    active.classList.add('is-active');

    dots.forEach((dot, index) => {
      const selected = index === current;
      dot.classList.toggle('is-current', selected);
      dot.setAttribute('aria-pressed', String(selected));
    });
    location.textContent = active.dataset.tourLocation ?? '';
    caption.textContent = active.dataset.tourCaption ?? '';

    if (options.announce) {
      announcer.textContent = '';
      window.requestAnimationFrame(() => {
        const stepLabel = dots[current].querySelector('span')?.textContent ?? String(current + 1);
        announcer.textContent = `Walkthrough step ${stepLabel}. ${caption.textContent}`;
      });
    }
    if (options.scroll) {
      root.scrollIntoView({
        behavior: reducedMotion.matches ? 'auto' : 'smooth',
        block: 'center',
      });
    }
    scheduleNext();
  }

  function showManualScene(requested, options = {}) {
    setAutoAdvance(false);
    showScene(requested, { ...options, announce: true });
  }

  autoButton.addEventListener('click', () => setAutoAdvance(!autoAdvance));
  motionButton.addEventListener('click', () => {
    if (reducedMotion.matches) return;
    motionPaused = !motionPaused;
    paintMotion();
  });
  previousButton.addEventListener('click', () => showManualScene(current - 1));
  nextButton.addEventListener('click', () => showManualScene(current + 1));
  dots.forEach((dot) => {
    dot.addEventListener('click', () => showManualScene(Number(dot.dataset.tourIndex)));
  });
  jumpButtons.forEach((button) => {
    button.addEventListener('click', () =>
      showManualScene(Number(button.dataset.tourJump), { scroll: true }),
    );
  });

  document.addEventListener('visibilitychange', scheduleNext);
  reducedMotion.addEventListener?.('change', (event) => {
    motionPaused = event.matches;
    if (event.matches) setAutoAdvance(false);
    paintMotion();
  });

  paintAutoplay();
  paintMotion();
  showScene(0);
}

/* ------------------------------------------------------------------ *
 * First paint
 * ------------------------------------------------------------------ */

setupTour();

(async () => {
  try {
    await refresh();
    await showShortcut();
  } catch (error) {
    setStatus(els.sourceStatus, error.message, 'error');
  }
})();

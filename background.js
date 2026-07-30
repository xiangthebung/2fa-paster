/**
 * Service worker: everything that has to happen between "a code was sent to your
 * email" and "the code is in the box".
 *
 * Two ways in.
 *
 *   Manual — you open the popup or press the shortcut. One search, one fill, one
 *   copy. No confidence threshold: the code is on screen and you can see whether
 *   it is the right one.
 *
 *   Auto — the content script notices a code box, and this starts a short watch
 *   over the inbox, polling every few seconds until the mail arrives or the watch
 *   times out. That path is stricter. It only accepts a code that arrived around
 *   the time the box appeared, only one it has not already delivered, and only
 *   one it is reasonably sure about, because filling the wrong code
 *   unsupervised is how an account gets locked.
 *
 * The watch state lives in `chrome.storage.session` rather than in a variable,
 * because this worker is not guaranteed to stay alive between two polls. An alarm
 * ticks alongside it and restarts the loop if the worker was shut down mid-watch.
 */

import { AuthError, forgetToken, getToken, isConfigured, isConnected, signOut } from './auth.js';
import { GmailError, fetchCandidateMessages, getProfileEmail } from './gmail.js';
import { FeedError, discoverAccounts, fetchCandidateEntries } from './inbox-feed.js';
import { AUTO_FILL_CONFIDENCE, findBestCode } from './code-finder.js';
import { senderName, siteOf } from './domains.js';
import {
  SITE_ORIGINS,
  SOURCES,
  clearHistory,
  clearUsedMessageIds,
  forgetLastCode,
  markMessageUsed,
  onSettingsChanged,
  readFeedAccounts,
  readHistory,
  readLastCode,
  readSettings,
  readUsedMessageIds,
  readWatch,
  recordHistory,
  rememberCode,
  writeFeedAccounts,
  writeSettings,
  writeWatch,
} from './settings.js';

/** Id of the content script registered for auto mode, so it can be removed again. */
const AUTO_SCRIPT_ID = 'code-field-watcher';

const ALARM_WATCH = 'watch-tick';
const ALARM_CLEAR_CLIPBOARD = 'clear-clipboard';
const ALARM_CLEAR_BADGE = 'clear-badge';

/**
 * How far before a watch started a code may have been sent.
 *
 * The mail and the page race each other: sometimes the code arrives while you
 * are still being redirected, sometimes the box is on screen a few seconds before
 * the mail lands. Two minutes covers the first case without reaching back to a
 * code from a previous sign-in.
 */
const WATCH_BACKDATE_MS = 120000;

/** Only one poll loop per worker instance. */
let watching = false;
/** In-flight offscreen document creation, so two callers cannot both create one. */
let creatingOffscreen = null;

/**
 * The signed-in address, cached for this worker's life.
 *
 * Reading it costs a Gmail API call, and the popup asks for the status every couple
 * of seconds while it is open. The address cannot change without a disconnect, which
 * clears this.
 */
let profileEmail = null;

/**
 * Earliest time another account-discovery probe is worth making.
 *
 * Discovery costs one request per account slot and only runs when nothing is cached
 * — which is exactly the signed-out state the popup polls hardest, hoping to notice
 * a sign-in. Without a floor, that hope costs five requests every two seconds.
 */
let nextAccountProbe = 0;
const ACCOUNT_PROBE_INTERVAL_MS = 5000;

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function setBadge(text, color) {
  try {
    await chrome.action.setBadgeText({ text });
    if (color) await chrome.action.setBadgeBackgroundColor({ color });
  } catch {
    // The action is unavailable while the browser is shutting down.
  }
}

async function flashBadge(text, color, seconds = 20) {
  await setBadge(text, color);
  chrome.alarms.create(ALARM_CLEAR_BADGE, { delayInMinutes: Math.max(0.5, seconds / 60) });
}

/* ------------------------------------------------------------------ *
 * Clipboard
 * ------------------------------------------------------------------ */

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (contexts.length > 0) return;
  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }
  creatingOffscreen = chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['CLIPBOARD'],
    justification: 'Copy the one-time code so it can be pasted by hand.',
  });
  try {
    await creatingOffscreen;
  } catch (error) {
    // A parallel call may have won the race; anything else is a real failure.
    if (!String(error?.message ?? '').includes('Only a single offscreen')) throw error;
  } finally {
    creatingOffscreen = null;
  }
}

/**
 * Put text on the clipboard from the service worker.
 *
 * @param {string} text
 * @returns {Promise<boolean>}
 */
async function copyText(text) {
  try {
    await ensureOffscreen();
    const result = await chrome.runtime.sendMessage({
      target: 'offscreen-clipboard',
      type: 'copy',
      text,
    });
    return Boolean(result?.ok);
  } catch {
    return false;
  }
}

async function scheduleClipboardClear(seconds) {
  if (!seconds) return;
  // Chrome will not schedule an alarm sooner than 30 seconds, so anything
  // shorter is rounded up rather than silently dropped.
  chrome.alarms.create(ALARM_CLEAR_CLIPBOARD, { delayInMinutes: Math.max(0.5, seconds / 60) });
}

/* ------------------------------------------------------------------ *
 * Gmail
 * ------------------------------------------------------------------ */

/**
 * Run a Gmail call, replacing the token once if it has gone stale.
 *
 * Chrome caches access tokens for an hour, but a token can be revoked from the
 * Google account page at any moment. The cached copy then looks fine and fails
 * with 401 on use, so the only fix is to drop it and ask for another.
 *
 * @template T
 * @param {(token: string) => Promise<T>} call
 * @returns {Promise<T>}
 */
async function withToken(call) {
  const token = await getToken({ interactive: false });
  try {
    return await call(token);
  } catch (error) {
    if (error instanceof GmailError && error.isExpiredToken) {
      await forgetToken(token);
      const fresh = await getToken({ interactive: false });
      return call(fresh);
    }
    throw error;
  }
}

/**
 * Mailboxes to read the feed from, discovering them if we have not yet.
 *
 * Discovery costs one request per account slot, so the answer is cached and only
 * recomputed when the cache is empty or when asked for explicitly. An empty
 * result still returns slot zero, so a first read is attempted rather than
 * skipped.
 *
 * @param {{ force?: boolean }} [options]
 */
async function feedAccounts({ force = false } = {}) {
  if (!force) {
    const cached = await readFeedAccounts();
    if (cached.length > 0) return cached;
    // Nothing cached means nothing is signed in, and re-asking a few times a second
    // will not change that. Returning empty is safe: a read with no accounts falls
    // back to slot zero, which is all a signed-out browser could offer anyway.
    if (Date.now() < nextAccountProbe) return cached;
  }
  nextAccountProbe = Date.now() + ACCOUNT_PROBE_INTERVAL_MS;
  const found = await discoverAccounts({ fetchImpl: fetch });
  return writeFeedAccounts(found);
}

/**
 * Search for a usable code, from whichever source is configured.
 *
 * The two readers differ in what they can see, not in how the result is judged:
 * both produce `{ id, from, subject, text, receivedAt }` and hand it to the same
 * scorer. The feed gives a snippet of each unread inbox message; the API gives
 * whole bodies of everything matching a keyword search.
 *
 * @param {object} [options]
 * @param {string} [options.site]            registrable domain of the page in front of you
 * @param {Set<string>} [options.skip]       messages already delivered
 * @param {number} [options.minReceivedAt]   ignore anything older than this
 * @returns {Promise<ReturnType<typeof findBestCode>>}
 */
async function searchForCode({ site, skip, minReceivedAt } = {}) {
  const settings = await readSettings();
  const now = Date.now();

  const pick = (messages) => {
    const fresh = minReceivedAt
      ? messages.filter((message) => message.receivedAt >= minReceivedAt)
      : messages;
    return findBestCode(fresh, { site, now, skipMessageIds: skip });
  };

  if (settings.source === SOURCES.feed) {
    try {
      return pick(
        await fetchCandidateEntries({
          accounts: await feedAccounts(),
          windowMinutes: settings.freshnessMinutes,
          now,
          fetchImpl: fetch,
        }),
      );
    } catch (error) {
      // Signing out of Gmail invalidates the cached mailbox list. Dropping it
      // here is what stops the popup reporting "working" against a session that
      // no longer exists; the next status read re-probes and reports the truth.
      if (error instanceof FeedError && error.kind === 'signed-out') await writeFeedAccounts([]);
      throw error;
    }
  }

  const look = (broad) =>
    withToken((token) =>
      fetchCandidateMessages({
        token,
        broad,
        windowMinutes: settings.freshnessMinutes,
        extraQuery: settings.extraQuery,
        now,
        fetchImpl: fetch,
      }),
    );

  let found = pick(await look(false));
  if (!found && settings.scanAllRecentMail) found = pick(await look(true));
  return found;
}

/* ------------------------------------------------------------------ *
 * Delivering a code
 * ------------------------------------------------------------------ */

/**
 * Try to type the code into a tab.
 *
 * The filler is injected rather than always present, so a page that never asks
 * for a code never runs any of our script. `allFrames` matters: code forms are
 * regularly inside an iframe, and only the frame holding the field answers.
 *
 * @param {number} tabId
 * @param {string} code
 * @param {{ submit?: boolean, toast?: boolean, sender?: string }} [options]
 */
async function fillTab(tabId, code, { submit = false, toast = false, sender = '' } = {}) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['content.js'],
    });
  } catch (error) {
    return { filled: false, reason: 'blocked', error: String(error?.message ?? error) };
  }

  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      type: 'fill-code',
      code,
      submit,
      toast,
      sender,
    });
    return response?.filled ? response : { filled: false, reason: response?.reason ?? 'no-field' };
  } catch {
    // Nothing answered, which means no frame in this tab has a code box.
    return { filled: false, reason: 'no-field' };
  }
}

/** @param {number} tabId */
async function tabHasCodeField(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['content.js'] });
    const response = await chrome.tabs.sendMessage(tabId, { type: 'has-code-field' });
    return Boolean(response?.hasField);
  } catch {
    return false;
  }
}

/**
 * Note what arrived in the recent list.
 *
 * Everything the search turned up goes in, not only the code that was used. When
 * two services mail you within a minute of each other, the one this picked is the
 * interesting row and the other one is the reason you opened the list.
 *
 * @param {object} found                 result from `findBestCode`
 * @param {object} outcome
 * @param {string} outcome.site          page the code was filled into, if any
 * @param {boolean} outcome.filled
 * @param {boolean} outcome.submitted
 * @param {number} outcome.keepMinutes
 */
async function noteHistory(found, { site, filled, submitted, keepMinutes }) {
  if (!keepMinutes) return;
  const seenAt = Date.now();
  await recordHistory(
    [
      {
        code: found.code,
        messageId: found.messageId,
        from: found.from,
        subject: found.subject,
        senderSite: found.senderSite ?? '',
        receivedAt: found.receivedAt,
        seenAt,
        confidence: found.confidence,
        site: filled ? site : '',
        filled,
        submitted,
      },
      ...(found.alternatives ?? []).map((other) => ({
        code: other.code,
        messageId: other.messageId,
        from: other.from,
        subject: other.subject,
        senderSite: other.senderSite ?? '',
        receivedAt: other.receivedAt,
        seenAt,
        confidence: other.confidence,
        site: '',
        filled: false,
        submitted: false,
      })),
    ],
    { keepMinutes },
  );
}

/**
 * @param {object} found      result from `findBestCode`
 * @param {object} options
 * @param {number | null} options.tabId  tab to fill, or null to only copy
 * @param {boolean} options.auto         true when nobody asked for this directly
 * @param {string} [options.site]        registrable domain of that tab
 */
async function deliver(found, { tabId, auto, site = '' }) {
  const settings = await readSettings();

  const record = {
    code: found.code,
    messageId: found.messageId,
    from: found.from,
    subject: found.subject,
    senderSite: found.senderSite ?? '',
    receivedAt: found.receivedAt,
    foundAt: Date.now(),
    confidence: found.confidence,
    reasons: found.reasons,
    siteMatch: Boolean(found.siteMatch),
    ambiguous: Boolean(found.ambiguous),
    site,
  };
  await rememberCode(record);

  const copied = settings.autoCopy || !tabId ? await copyText(found.code) : false;
  if (copied) await scheduleClipboardClear(settings.clipboardClearSeconds);

  const fill = tabId
    ? await fillTab(tabId, found.code, {
        submit: settings.autoSubmit,
        toast: settings.inPageToast,
        sender: senderName(found.from),
      })
    : { filled: false, reason: 'no-tab' };
  if (auto || fill.filled) await markMessageUsed(found.messageId);

  await noteHistory(found, {
    site,
    filled: Boolean(fill.filled),
    submitted: Boolean(fill.submitted),
    keepMinutes: settings.historyMinutes,
  });

  // Two confirmations for one event is noise. The page said it already if the
  // toast landed, so the desktop notification is kept for the case the page could
  // not be told — which is also the case where the code itself is still needed.
  const confirmedOnPage = Boolean(fill.filled && fill.toasted);
  if (settings.notify && !confirmedOnPage) {
    await notify(found, { filled: fill.filled, submitted: Boolean(fill.submitted), copied });
  }
  await flashBadge(fill.filled ? '✓' : '•', fill.filled ? '#1b8a3a' : '#5b45e0');

  return {
    ...record,
    filled: fill.filled,
    fillReason: fill.reason,
    submitted: Boolean(fill.submitted),
    copied,
  };
}

/**
 * @param {object} found
 * @param {{ filled: boolean, submitted: boolean, copied: boolean }} outcome
 */
async function notify(found, { filled, submitted, copied }) {
  const sender = senderName(found.from);
  // The code is shown only when it did not make it into the page, because then
  // reading it off the notification is the fastest way to finish. On success
  // there is no reason to put a live credential on screen.
  const message = filled
    ? `${submitted ? 'Filled and submitted' : 'Filled in'} a ${found.code.length}-character code from ${sender}.${
        copied ? ' Also copied.' : ''
      }`
    : `${found.code} — from ${sender}.${copied ? ' Copied to your clipboard.' : ''}`;

  try {
    await chrome.notifications.create({
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
      title: filled ? (submitted ? 'Code filled and submitted' : 'Code filled in') : 'Code ready',
      message,
      priority: filled ? 0 : 2,
      silent: filled,
    });
  } catch {
    // Notifications can be switched off at the OS level.
  }
}

/* ------------------------------------------------------------------ *
 * The manual path
 * ------------------------------------------------------------------ */

/**
 * Fetch the newest code and put it wherever it can go.
 *
 * Deliberately does not skip codes it has delivered before: asking twice usually
 * means the first attempt was mistyped, and answering "nothing new" would be
 * unhelpful.
 *
 * @param {{ tabId?: number | null, url?: string }} [options]
 */
async function pasteNow({ tabId = null, url = '' } = {}) {
  const site = siteOf(url);
  const found = await searchForCode({ site });
  if (!found) return { ok: true, found: false };
  const delivered = await deliver(found, { tabId, auto: false, site });
  return { ok: true, found: true, result: delivered };
}

/* ------------------------------------------------------------------ *
 * The watch
 * ------------------------------------------------------------------ */

/**
 * Begin watching for a code on behalf of a tab.
 *
 * @param {{ tabId: number, url: string }} target
 */
async function startWatch({ tabId, url }) {
  const settings = await readSettings();
  const existing = await readWatch();
  // Re-arm rather than stack: a single-page login flow can announce its code box
  // several times as the form re-renders.
  if (existing && existing.tabId === tabId && existing.until > Date.now()) return existing;

  const now = Date.now();
  const watch = {
    tabId,
    origin: siteOf(url),
    startedAt: now,
    until: now + settings.watchSeconds * 1000,
  };
  await writeWatch(watch);
  chrome.alarms.create(ALARM_WATCH, { periodInMinutes: 0.5 });
  await setBadge('…', '#5b45e0');
  runWatchLoop();
  return watch;
}

/**
 * @param {{ clearBadge?: boolean }} [options]
 *   The success path has just flashed a tick, so it stops the watch without
 *   wiping it — otherwise the confirmation disappears in the same tick it appears.
 */
async function stopWatch({ clearBadge = true } = {}) {
  await writeWatch(null);
  chrome.alarms.clear(ALARM_WATCH);
  if (clearBadge) await setBadge('');
}

/**
 * Poll until the code turns up, the watch expires, or the tab goes away.
 *
 * Idempotent by design. The alarm calls it every half minute in case this worker
 * was shut down between two polls, and the `watching` flag keeps a second loop
 * from starting inside one worker instance.
 */
async function runWatchLoop() {
  if (watching) return;
  watching = true;
  /** Last message offered to the popup but not filled, so it is only stored once. */
  let unsureMessageId = null;
  try {
    for (;;) {
      const watch = await readWatch();
      if (!watch) return;
      if (Date.now() >= watch.until) {
        await stopWatch();
        return;
      }

      // A watch belongs to a tab. If it has closed or navigated somewhere else,
      // there is nothing left to fill.
      let tab = null;
      try {
        tab = await chrome.tabs.get(watch.tabId);
      } catch {
        tab = null;
      }
      if (!tab) {
        await stopWatch();
        return;
      }

      const settings = await readSettings();
      if (!settings.autoFill) {
        await stopWatch();
        return;
      }

      try {
        const found = await searchForCode({
          site: watch.origin,
          skip: await readUsedMessageIds(),
          minReceivedAt: watch.startedAt - WATCH_BACKDATE_MS,
        });

        // Two independent bars, because they fail differently. Confidence asks
        // whether this number is a code at all; `ambiguous` asks whether it is
        // *this page's* code. A well-worded code mail from an unidentifiable
        // sender clears the first easily and can still be the wrong one, which is
        // exactly the case that locks an account, so the second bar exists: with
        // several codes in the inbox and nothing tying any of them to this site,
        // nothing gets typed in unasked.
        if (found && found.confidence >= AUTO_FILL_CONFIDENCE && (found.siteMatch || !found.ambiguous)) {
          await deliver(found, { tabId: watch.tabId, auto: true, site: watch.origin });
          await stopWatch({ clearBadge: false });
          return;
        }

        if (found && found.messageId !== unsureMessageId) {
          // Not sure enough to type into a page unasked, but sure enough to hand
          // over if you come looking. Keep watching in case a clearer mail is
          // still on its way.
          unsureMessageId = found.messageId;
          await rememberCode({
            code: found.code,
            messageId: found.messageId,
            from: found.from,
            subject: found.subject,
            senderSite: found.senderSite ?? '',
            receivedAt: found.receivedAt,
            foundAt: Date.now(),
            confidence: found.confidence,
            reasons: found.reasons,
            siteMatch: Boolean(found.siteMatch),
            ambiguous: Boolean(found.ambiguous),
            site: watch.origin,
          });
          await noteHistory(found, {
            site: watch.origin,
            filled: false,
            submitted: false,
            keepMinutes: settings.historyMinutes,
          });
          await setBadge('?', '#8a5300');
        }
      } catch (error) {
        // A watch runs unattended, so a failure here stops it quietly rather
        // than retrying into a rate limit. The popup still reports the reason.
        const fatal =
          error instanceof AuthError ||
          (error instanceof FeedError && error.kind === 'signed-out') ||
          (error instanceof GmailError && error.isRateLimited);
        if (fatal) {
          await stopWatch({ clearBadge: false });
          await flashBadge('!', '#b3261e');
          return;
        }
      }

      await sleep(Math.max(2, settings.pollSeconds) * 1000);
    }
  } finally {
    watching = false;
  }
}

/* ------------------------------------------------------------------ *
 * Auto mode registration
 * ------------------------------------------------------------------ */

/**
 * Keep the always-on content script in step with the setting.
 *
 * Auto mode needs a script on every page to notice a code box appearing, which
 * needs access to every site. That is a real ask, so it is an optional permission
 * requested from the options page, and the script is registered only once both
 * the setting and the grant are in place. Registrations survive browser
 * restarts, so this also runs on startup to clean up after a revoked permission.
 *
 * @param {object} [settings] already-read settings, to save a storage round trip
 */
async function syncAutoRegistration(settings) {
  const resolved = settings ?? (await readSettings());
  const granted = await chrome.permissions.contains({ origins: SITE_ORIGINS });
  const wanted = resolved.autoFill && granted;

  let registered = [];
  try {
    registered = await chrome.scripting.getRegisteredContentScripts({ ids: [AUTO_SCRIPT_ID] });
  } catch {
    registered = [];
  }

  if (wanted && registered.length === 0) {
    await chrome.scripting.registerContentScripts([
      {
        id: AUTO_SCRIPT_ID,
        js: ['content.js'],
        matches: SITE_ORIGINS,
        runAt: 'document_idle',
        allFrames: true,
      },
    ]);
  } else if (!wanted && registered.length > 0) {
    await chrome.scripting.unregisterContentScripts({ ids: [AUTO_SCRIPT_ID] });
  }
  return wanted;
}

/* ------------------------------------------------------------------ *
 * Status, for the popup and the options page
 * ------------------------------------------------------------------ */

/**
 * Everything the popup and the options page render from.
 *
 * `ready` is the single question both pages actually care about: can this thing
 * fetch a code right now? What makes it true differs per source — a live Gmail
 * session for the feed, a granted OAuth token for the API — and neither page
 * should have to know that.
 */
async function buildStatus() {
  const [settings, lastCode, watch] = await Promise.all([readSettings(), readLastCode(), readWatch()]);
  const history = await readHistory({ keepMinutes: settings.historyMinutes });
  const usingFeed = settings.source === SOURCES.feed;

  let ready = false;
  let accounts = [];
  let problem = null;
  let email = '';

  if (usingFeed) {
    try {
      accounts = await feedAccounts();
      ready = accounts.length > 0;
      email = accounts.map((account) => account.account).join(', ');
    } catch (error) {
      problem = describeError(error);
    }
  } else if (isConfigured()) {
    ready = await isConnected();
    if (ready) {
      if (profileEmail === null) {
        try {
          profileEmail = await withToken((token) => getProfileEmail({ token, fetchImpl: fetch }));
        } catch {
          profileEmail = '';
        }
      }
      email = profileEmail;
    }
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const autoGranted = await chrome.permissions.contains({ origins: SITE_ORIGINS });

  return {
    source: settings.source,
    ready,
    problem,
    email,
    accounts,
    // Only meaningful for the API source, but the options page shows the setup
    // state regardless of which source is active.
    apiConfigured: isConfigured(),
    settings,
    lastCode,
    // Carried in the status rather than fetched separately: the popup already
    // re-reads the status after everything that could change the list.
    history,
    watching: watch && watch.until > Date.now() ? watch : null,
    autoGranted,
    extensionId: chrome.runtime.id,
    tab: tab ? { id: tab.id, url: tab.url ?? '', site: siteOf(tab.url ?? ''), title: tab.title ?? '' } : null,
  };
}

/** Turn a thrown error into something the UI can render and act on. */
function describeError(error) {
  if (error instanceof FeedError) {
    if (error.kind === 'signed-out') {
      return {
        kind: 'signed-out',
        message: 'No Gmail session found in this browser. Open Gmail and sign in, then try again.',
      };
    }
    return { kind: error.kind === 'unreachable' ? 'offline' : 'feed', message: error.message };
  }
  if (error instanceof AuthError) return { kind: error.kind, message: error.message };
  if (error instanceof GmailError) {
    if (error.isExpiredToken) return { kind: 'needs-consent', message: 'Gmail rejected the saved permission.' };
    if (error.isRateLimited) {
      return { kind: 'rate-limited', message: 'Gmail is rate limiting these requests. Try again in a moment.' };
    }
    if (error.status === 0) return { kind: 'offline', message: error.message };
    return { kind: 'gmail', message: error.message };
  }
  return { kind: 'unknown', message: String(error?.message ?? error) };
}

/* ------------------------------------------------------------------ *
 * Message routing
 * ------------------------------------------------------------------ */

const handlers = {
  async status() {
    return { ok: true, status: await buildStatus() };
  },

  /**
   * Make the active source usable.
   *
   * What that means depends on the source, which is the point: for the feed
   * there is nothing to authorise, so "connect" is just a re-check of which
   * mailboxes this browser is signed in to.
   */
  async connect() {
    const settings = await readSettings();
    profileEmail = null;
    if (settings.source === SOURCES.feed) {
      const accounts = await feedAccounts({ force: true });
      return { ok: true, status: await buildStatus(), accounts };
    }
    // Interactive, so it has to come from a click in the popup or options page.
    await getToken({ interactive: true });
    return { ok: true, status: await buildStatus() };
  },

  async disconnect() {
    await signOut();
    profileEmail = null;
    await Promise.all([forgetLastCode(), clearUsedMessageIds(), clearHistory(), stopWatch()]);
    await writeFeedAccounts([]);
    await writeSettings({ autoFill: false });
    await syncAutoRegistration();
    return { ok: true, status: await buildStatus() };
  },

  async paste({ tabId = null, url = '' }) {
    return pasteNow({ tabId, url });
  },

  /**
   * Re-fill a code already in hand, without going back to Gmail.
   *
   * `code` is optional and comes from the recent list: picking a row is how you
   * correct a wrong guess, and it should not cost another inbox read.
   */
  async refill({ tabId, code }) {
    const [last, settings] = await Promise.all([readLastCode(), readSettings()]);
    const wanted = typeof code === 'string' && code ? { ...(last ?? {}), code } : last;
    if (!wanted?.code) return { ok: true, found: false };
    if (typeof tabId !== 'number') {
      return { ok: true, found: true, result: { ...wanted, filled: false, fillReason: 'no-tab' } };
    }
    const fill = await fillTab(tabId, wanted.code, {
      submit: settings.autoSubmit,
      toast: settings.inPageToast,
      sender: senderName(wanted.from ?? ''),
    });
    return {
      ok: true,
      found: true,
      result: {
        ...wanted,
        filled: fill.filled,
        fillReason: fill.reason,
        submitted: Boolean(fill.submitted),
      },
    };
  },

  async copy({ text }) {
    const copied = await copyText(String(text ?? ''));
    if (copied) await scheduleClipboardClear((await readSettings()).clipboardClearSeconds);
    return { ok: copied };
  },

  async settings({ patch }) {
    const settings = await writeSettings(patch ?? {});
    await syncAutoRegistration(settings);
    if (!settings.autoFill) await stopWatch();
    // Turning the recent list off has to take the existing list with it, or the
    // setting only stops the popup from showing what is still being kept.
    if (!settings.historyMinutes) await clearHistory();
    return { ok: true, settings };
  },

  async forget() {
    await Promise.all([forgetLastCode(), clearUsedMessageIds(), clearHistory()]);
    await setBadge('');
    return { ok: true };
  },

  /** Drop the recent list without touching the code currently in hand. */
  async 'forget-history'() {
    await clearHistory();
    return { ok: true, status: await buildStatus() };
  },

  async 'has-field'({ tabId }) {
    return { ok: true, hasField: await tabHasCodeField(tabId) };
  },

  async 'sync-auto'() {
    const active = await syncAutoRegistration();
    return { ok: true, active };
  },

  async 'stop-watch'() {
    await stopWatch();
    return { ok: true };
  },
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Clipboard replies are the offscreen document's business, not ours.
  if (message?.target === 'offscreen-clipboard') return false;

  if (message?.type === 'code-field-seen') {
    (async () => {
      const settings = await readSettings();
      if (!settings.autoFill) return;
      const tabId = sender.tab?.id;
      if (typeof tabId !== 'number') return;
      await startWatch({ tabId, url: sender.tab?.url ?? message.href ?? '' });
    })().catch(() => {
      // A watch that cannot start is not worth interrupting browsing for.
    });
    return false;
  }

  const handler = handlers[message?.type];
  if (!handler) return false;

  handler(message ?? {})
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: describeError(error) }));
  return true;
});

/* ------------------------------------------------------------------ *
 * Browser events
 * ------------------------------------------------------------------ */

chrome.commands.onCommand.addListener((command) => {
  if (command !== 'paste-code') return;
  (async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    try {
      const result = await pasteNow({ tabId: tab?.id ?? null, url: tab?.url ?? '' });
      if (!result.found) {
        await flashBadge('–', '#6a6a70', 8);
        const settings = await readSettings();
        if (settings.notify) {
          await chrome.notifications.create({
            type: 'basic',
            iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
            title: 'No code found',
            message: 'Nothing recent in Gmail looks like a one-time code.',
          });
        }
      }
    } catch (error) {
      await flashBadge('!', '#b3261e', 8);
      const described = describeError(error);
      const settings = await readSettings();
      if (settings.notify) {
        await chrome.notifications.create({
          type: 'basic',
          iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
          title: 'Could not get a code',
          message: described.message,
        });
      }
    }
  })();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_WATCH) {
    // Restart the loop if this worker was shut down partway through a watch.
    runWatchLoop().catch(() => {});
    return;
  }
  if (alarm.name === ALARM_CLEAR_CLIPBOARD) {
    copyText('').catch(() => {});
    return;
  }
  if (alarm.name === ALARM_CLEAR_BADGE) {
    (async () => {
      const watch = await readWatch();
      // Do not wipe the "watching" badge if a watch is still running.
      await setBadge(watch && watch.until > Date.now() ? '…' : '', '#5b45e0');
    })().catch(() => {});
  }
});

/** A watch is tied to one page. Navigating away or closing it ends the watch. */
chrome.tabs.onRemoved.addListener((tabId) => {
  readWatch()
    .then((watch) => (watch?.tabId === tabId ? stopWatch() : undefined))
    .catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (!change.url) return;
  readWatch()
    .then((watch) => {
      if (!watch || watch.tabId !== tabId) return undefined;
      // Same site, probably the next step of the same flow: keep watching.
      return siteOf(change.url) === watch.origin ? undefined : stopWatch();
    })
    .catch(() => {});
});

chrome.permissions.onRemoved.addListener(() => {
  syncAutoRegistration().catch(() => {});
});

chrome.permissions.onAdded.addListener(() => {
  syncAutoRegistration().catch(() => {});
});

onSettingsChanged((settings) => {
  syncAutoRegistration(settings).catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  (async () => {
    await writeWatch(null);
    await setBadge('');
    await syncAutoRegistration();
  })().catch(() => {});
});

chrome.runtime.onInstalled.addListener((details) => {
  (async () => {
    await syncAutoRegistration();
    // A fresh install cannot do anything until it has an OAuth client ID, so
    // send people straight to the page that explains how to get one.
    if (details.reason === 'install' && !isConfigured()) await chrome.runtime.openOptionsPage();
  })().catch(() => {});
});

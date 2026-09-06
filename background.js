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
 * One rule both paths share: a code that cannot be tied to the site in front of
 * you, when several arrived at once, is typed in but never submitted. The fill
 * is cheap to undo and the submit is not. The page's card and the popup both say
 * "Held — check the sender", and each offers the submit and the other codes as
 * one click.
 *
 * The watch state lives in `chrome.storage.session` rather than in a variable,
 * because this worker is not guaranteed to stay alive between two polls. An alarm
 * ticks alongside it and restarts the loop if the worker was shut down mid-watch.
 */

import { AuthError, forgetToken, getToken, isConfigured, isConnected, signOut } from './auth.js';
import { GmailError, fetchCandidateMessages, getProfileEmail } from './gmail.js';
import { FeedError, discoverAccounts, fetchCandidateEntries, fetchCategoryEntries } from './inbox-feed.js';
import { AUTO_FILL_CONFIDENCE, findBestCode } from './code-finder.js';
import { senderAddress, senderName, siteOf } from './domains.js';
import {
  SITE_ORIGINS,
  SOURCES,
  clearHistory,
  clearUsedMessageIds,
  forgetLastCode,
  guideDue,
  markMessageUsed,
  onSettingsChanged,
  readFeedAccounts,
  readHistory,
  readLastCode,
  readOnboarding,
  readSettings,
  readUsedMessageIds,
  readWatch,
  recordHistory,
  rememberCode,
  writeFeedAccounts,
  writeOnboarding,
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

/**
 * While watching, how often the inbox tabs beyond Primary are checked.
 *
 * Every poll reads Primary; every third one also asks Updates, Promotions,
 * Social and Forums. A code Gmail has filed under Updates still lands within
 * twelve seconds, and the other two polls cost one request each instead of five.
 */
const CATEGORY_PROBE_EVERY = 3;

/**
 * The one message for a page an extension cannot touch.
 *
 * `chrome://` pages, the Web Store and other extensions' pages are off limits to
 * every extension. The popup's target card and the outcome after a fill used to
 * say two different things about the same page; both now say this.
 */
const UNFILLABLE_PAGE = 'Chrome does not allow filling on this page';

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

/** A page whose address says an extension may run in it. */
function fillableUrl(url) {
  return /^(https?|file):/i.test(String(url ?? ''));
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
 * The feed is read in two steps. The plain feed is the Primary tab, and that is
 * where a code mail usually is — but Gmail files a good deal of transactional
 * mail under Updates or Promotions, unread and in the inbox and invisible to the
 * plain feed. So when Primary has nothing, the other tabs are asked, and any of
 * them failing to answer counts as "nothing there" rather than as an error.
 *
 * @param {object} [options]
 * @param {string} [options.site]            registrable domain of the page in front of you
 * @param {Set<string>} [options.skip]       messages already delivered
 * @param {number} [options.minReceivedAt]   ignore anything older than this
 * @param {boolean} [options.categories]     look beyond Primary when it comes up empty
 * @returns {Promise<ReturnType<typeof findBestCode>>}
 */
async function searchForCode({ site, skip, minReceivedAt, categories = true } = {}) {
  const settings = await readSettings();
  const now = Date.now();

  const pick = (messages) => {
    const fresh = minReceivedAt
      ? messages.filter((message) => message.receivedAt >= minReceivedAt)
      : messages;
    return findBestCode(fresh, { site, now, skipMessageIds: skip });
  };

  if (settings.source === SOURCES.feed) {
    const accounts = await feedAccounts();
    const read = { accounts, windowMinutes: settings.freshnessMinutes, now, fetchImpl: fetch };
    let entries;
    try {
      entries = await fetchCandidateEntries(read);
    } catch (error) {
      // Signing out of Gmail invalidates the cached mailbox list. Dropping it
      // here is what stops the popup reporting "working" against a session that
      // no longer exists; the next status read re-probes and reports the truth.
      if (error instanceof FeedError && error.kind === 'signed-out') await writeFeedAccounts([]);
      throw error;
    }
    const found = pick(entries);
    if (found || !categories) return found;
    return pick(await fetchCategoryEntries(read));
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
 * Ask the top frame which fields it looked at and passed over.
 *
 * Sent only after a fill or a field check went unanswered, which is the signal
 * that no frame has a code box. The answer is what lets the popup say "Skipped
 * 'Security code' — card field" instead of a bare "no code box found".
 *
 * @param {number} tabId
 * @returns {Promise<Array<{ label: string, rule: string }>>}
 */
async function askWhyNoField(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: 'why-no-field' });
    return Array.isArray(response?.refused) ? response.refused : [];
  } catch {
    return [];
  }
}

/**
 * Try to type the code into a tab.
 *
 * The filler is injected rather than always present, so a page that never asks
 * for a code never runs any of our script. `allFrames` matters: code forms are
 * regularly inside an iframe, and only the frame holding the field answers.
 *
 * @param {number} tabId
 * @param {string} code
 * @param {object} [options]
 * @param {boolean} [options.submit]      press the button after filling
 * @param {boolean} [options.hold]        fill only; the submit is left for a person
 * @param {boolean} [options.toast]       show the card on the page
 * @param {string} [options.sender]       display name of the sender
 * @param {string} [options.address]      the sender's address
 * @param {number} [options.receivedAt]   when the mail arrived, for the page's picker
 * @param {string} [options.site]         registrable domain of the tab
 * @param {Array<object>} [options.alternatives]  other codes, for the page's picker
 */
async function fillTab(
  tabId,
  code,
  { submit = false, hold = false, toast = false, sender = '', address = '', receivedAt = 0, site = '', alternatives = [] } = {},
) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['content.js'],
    });
  } catch (error) {
    return { filled: false, reason: 'blocked', error: String(error?.message ?? error), refused: [] };
  }

  let response = null;
  try {
    response = await chrome.tabs.sendMessage(tabId, {
      type: 'fill-code',
      code,
      submit,
      hold,
      toast,
      sender,
      address,
      receivedAt,
      site,
      alternatives,
    });
  } catch {
    // Nothing answered, which means no frame in this tab has a code box.
    response = null;
  }
  if (response?.filled) return response;
  if (response) return { filled: false, reason: response.reason ?? 'no-field', refused: response.refused ?? [] };
  return { filled: false, reason: 'no-field', refused: await askWhyNoField(tabId) };
}

/**
 * Does this tab have somewhere to put a code — and if not, why not?
 *
 * Three answers, kept apart because the popup says different things for each:
 * a field was found; no field, with the ones that were skipped and why; or the
 * page cannot be looked at, which is Chrome's decision and not this code's. The
 * injection error used to be swallowed into "no field", which had the popup
 * calling a `chrome://` page a page with no code box.
 *
 * @param {number} tabId
 * @param {string} [url]
 * @returns {Promise<{ hasField: boolean, blocked: boolean, reason?: string, error?: string,
 *                     kind?: string, why?: string[], label?: string,
 *                     refused: Array<{ label: string, rule: string }> }>}
 */
async function tabHasCodeField(tabId, url = '') {
  if (url && !fillableUrl(url)) return { hasField: false, blocked: true, reason: UNFILLABLE_PAGE, refused: [] };
  try {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['content.js'] });
  } catch (error) {
    return { hasField: false, blocked: true, reason: UNFILLABLE_PAGE, error: String(error?.message ?? error), refused: [] };
  }

  let response = null;
  try {
    response = await chrome.tabs.sendMessage(tabId, { type: 'has-code-field' });
  } catch {
    response = null;
  }
  if (response?.hasField) {
    return {
      hasField: true,
      blocked: false,
      kind: response.kind,
      why: response.why ?? [],
      label: response.label ?? '',
      refused: response.refused ?? [],
    };
  }
  return { hasField: false, blocked: false, refused: await askWhyNoField(tabId) };
}

/**
 * The other codes worth offering beside the one that went in.
 *
 * What the search turned up alongside the winner, then the recent list, one row
 * per code, the delivered one left out. The page's card and the popup both show
 * these, which is how a wrong pick gets corrected in one click.
 *
 * @param {object} options
 * @param {string} options.exclude
 * @param {Array<object>} [options.alternatives]
 * @param {number} options.keepMinutes
 */
async function pickerRows({ exclude, alternatives = [], keepMinutes }) {
  const history = keepMinutes ? await readHistory({ keepMinutes }) : [];
  const seen = new Set([exclude]);
  const rows = [];
  for (const entry of [...alternatives, ...history]) {
    if (!entry?.code || seen.has(entry.code)) continue;
    seen.add(entry.code);
    rows.push({
      code: entry.code,
      sender: senderName(entry.from),
      address: senderAddress(entry.from),
      receivedAt: Number(entry.receivedAt) || 0,
    });
    if (rows.length === 4) break;
  }
  return rows;
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
        link: found.link ?? '',
        account: found.account ?? '',
        siteMatch: Boolean(found.siteMatch),
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
        link: other.link ?? '',
        account: other.account ?? '',
        siteMatch: Boolean(other.siteMatch),
        site: '',
        filled: false,
        submitted: false,
      })),
    ],
    { keepMinutes },
  );
}

/**
 * What a fill attempt amounted to, in the shape the popup's decision card reads.
 *
 * Kept on the stored code rather than only returned, so a popup opened after an
 * automatic fill — the one nobody was watching — can still say what was filled,
 * what was pressed and what was skipped.
 *
 * @param {object} fill     what `fillTab` returned
 * @param {object} context
 * @param {boolean} context.copied
 * @param {boolean} context.hold
 * @param {boolean} context.submitWanted
 */
function outcomeOf(fill, { copied, hold, submitWanted }) {
  return {
    filled: Boolean(fill.filled),
    fillReason: fill.filled ? '' : fill.reason ?? '',
    kind: fill.kind ?? '',
    boxes: Number(fill.boxes) || 0,
    label: fill.label ?? '',
    submitted: Boolean(fill.submitted),
    submitKind: fill.submitKind ?? '',
    pressed: fill.pressed ?? '',
    held: Boolean(hold && fill.filled),
    submitWanted: Boolean(submitWanted),
    refused: Array.isArray(fill.refused) ? fill.refused : [],
    copied: Boolean(copied),
    error: fill.error ?? '',
  };
}

/** The first time a code goes into a page is when the one-time tip becomes due. */
async function noteFirstFill() {
  const onboarding = await readOnboarding();
  if (!onboarding.firstFillAt) await writeOnboarding({ firstFillAt: Date.now() });
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

  // Several codes, and nothing tying this one to the page: it goes in, because
  // seeing it in the box is how you judge it, and it stays there, because
  // submitting the wrong one is what locks an account.
  const hold = Boolean(found.ambiguous && !found.siteMatch);

  const record = {
    code: found.code,
    messageId: found.messageId,
    from: found.from,
    address: senderAddress(found.from),
    subject: found.subject,
    senderSite: found.senderSite ?? '',
    receivedAt: found.receivedAt,
    link: found.link ?? '',
    account: found.account ?? '',
    foundAt: Date.now(),
    confidence: found.confidence,
    reasons: found.reasons,
    siteMatch: Boolean(found.siteMatch),
    ambiguous: Boolean(found.ambiguous),
    held: hold,
    site,
    outcome: null,
  };
  await rememberCode(record);

  const copied = settings.autoCopy || !tabId ? await copyText(found.code) : false;
  if (copied) await scheduleClipboardClear(settings.clipboardClearSeconds);

  const fill = tabId
    ? await fillTab(tabId, found.code, {
        submit: settings.autoSubmit,
        hold,
        toast: settings.inPageToast,
        sender: senderName(found.from),
        address: record.address,
        receivedAt: record.receivedAt,
        site,
        alternatives: await pickerRows({
          exclude: found.code,
          alternatives: found.alternatives,
          keepMinutes: settings.historyMinutes,
        }),
      })
    : { filled: false, reason: 'no-tab', refused: [] };
  if (auto || fill.filled) await markMessageUsed(found.messageId);

  const outcome = outcomeOf(fill, { copied, hold, submitWanted: settings.autoSubmit });
  const delivered = { ...record, held: outcome.held || (hold && !fill.filled), outcome };
  await rememberCode(delivered);

  await noteHistory(found, {
    site,
    filled: outcome.filled,
    submitted: outcome.submitted,
    keepMinutes: settings.historyMinutes,
  });
  if (outcome.filled) await noteFirstFill();

  // Two confirmations for one event is noise. The page said it already if the
  // toast landed, so the desktop notification is kept for the case the page could
  // not be told — which is also the case where the code itself is still needed.
  const confirmedOnPage = Boolean(fill.filled && fill.toasted);
  if (settings.notify && !confirmedOnPage) {
    await notify(found, { filled: outcome.filled, submitted: outcome.submitted, held: outcome.held, copied, site });
  }
  // One call per glyph, each on its own line: the README's badge table is
  // checked against the literals on the lines that set a badge.
  if (!outcome.filled) await flashBadge('•', '#5b45e0');
  else if (outcome.held) await flashBadge('?', '#8a5300');
  else await flashBadge('✓', '#1b8a3a');

  return {
    ...delivered,
    filled: outcome.filled,
    fillReason: outcome.fillReason,
    submitted: outcome.submitted,
    copied,
  };
}

/**
 * @param {object} found
 * @param {{ filled: boolean, submitted: boolean, held: boolean, copied: boolean, site: string }} outcome
 */
async function notify(found, { filled, submitted, held, copied, site }) {
  const sender = senderName(found.from);
  // The code is shown only when it did not make it into the page, because then
  // reading it off the notification is the fastest way to finish. On success
  // there is no reason to put a live credential on screen.
  let title;
  let message;
  if (filled && held) {
    title = 'Code filled in, not submitted';
    message =
      `Filled a ${found.code.length}-character code from ${sender} and held it: several codes arrived and ` +
      `none name ${site || 'this site'}. Check the sender before submitting.`;
  } else if (filled) {
    title = submitted ? 'Code filled and submitted' : 'Code filled in';
    message = `${submitted ? 'Filled and submitted' : 'Filled in'} a ${found.code.length}-character code from ${sender}.${
      copied ? ' Also copied.' : ''
    }`;
  } else {
    title = 'Code ready';
    message = `${found.code} — from ${sender}.${copied ? ' Copied to your clipboard.' : ''}`;
  }

  try {
    await chrome.notifications.create({
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
      title,
      message,
      priority: filled ? 0 : 2,
      silent: filled && !held,
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

/**
 * Put a code already in hand back into a page — a chosen one.
 *
 * Choosing is what settles the sender question: a code picked from the list by a
 * person is never held, and is delivered the way any chosen code is. The record
 * is rebuilt from the row that was picked, so the popup names that code's sender
 * rather than the previous code's.
 *
 * @param {{ tabId?: number | null, url?: string, code?: string }} options
 */
async function refillNow({ tabId = null, url = '', code = '' }) {
  const [last, settings] = await Promise.all([readLastCode(), readSettings()]);
  const site = siteOf(url) || last?.site || '';
  const wanted = String(code ?? '');

  let base = last;
  if (wanted && wanted !== last?.code) {
    const history = await readHistory({ keepMinutes: settings.historyMinutes });
    const row = history.find((entry) => entry.code === wanted);
    base = row
      ? {
          code: row.code,
          messageId: row.messageId,
          from: row.from,
          subject: row.subject,
          senderSite: row.senderSite,
          receivedAt: row.receivedAt,
          link: row.link,
          account: row.account,
          confidence: row.confidence,
          reasons: [],
          siteMatch: Boolean(row.siteMatch),
        }
      : { ...(last ?? {}), code: wanted, reasons: [] };
  }
  if (!base?.code) return { ok: true, found: false };

  const record = {
    code: base.code,
    messageId: base.messageId ?? '',
    from: base.from ?? '',
    address: senderAddress(base.from ?? ''),
    subject: base.subject ?? '',
    senderSite: base.senderSite ?? '',
    receivedAt: Number(base.receivedAt) || Date.now(),
    link: base.link ?? '',
    account: base.account ?? '',
    foundAt: Date.now(),
    confidence: Number(base.confidence) || 0,
    reasons: base.reasons ?? [],
    siteMatch: Boolean(base.siteMatch),
    ambiguous: false,
    held: false,
    site,
    outcome: null,
  };

  if (typeof tabId !== 'number') {
    const outcome = outcomeOf(
      { filled: false, reason: 'no-tab', refused: [] },
      { copied: false, hold: false, submitWanted: settings.autoSubmit },
    );
    return { ok: true, found: true, result: { ...record, outcome, filled: false, fillReason: 'no-tab', submitted: false } };
  }

  const fill = await fillTab(tabId, record.code, {
    submit: settings.autoSubmit,
    toast: settings.inPageToast,
    sender: senderName(record.from),
    address: record.address,
    receivedAt: record.receivedAt,
    site,
    alternatives: await pickerRows({ exclude: record.code, keepMinutes: settings.historyMinutes }),
  });
  const outcome = outcomeOf(fill, { copied: false, hold: false, submitWanted: settings.autoSubmit });
  const delivered = { ...record, outcome };
  await rememberCode(delivered);
  if (outcome.filled) {
    if (record.messageId) await markMessageUsed(record.messageId);
    await recordHistory(
      [{ ...record, seenAt: Date.now(), site, filled: true, submitted: outcome.submitted }],
      { keepMinutes: settings.historyMinutes },
    );
    await noteFirstFill();
    await flashBadge('✓', '#1b8a3a');
  }
  return {
    ok: true,
    found: true,
    result: { ...delivered, filled: outcome.filled, fillReason: outcome.fillReason, submitted: outcome.submitted },
  };
}

/**
 * Press the button for a code that was held — the popup's "Submit anyway".
 *
 * @param {{ tabId?: number | null }} options
 */
async function submitNow({ tabId = null }) {
  const [last, settings] = await Promise.all([readLastCode(), readSettings()]);
  if (!last?.code) return { ok: true, found: false };

  let response = null;
  if (typeof tabId === 'number') {
    try {
      response = await chrome.tabs.sendMessage(tabId, { type: 'submit-code' });
    } catch {
      response = null;
    }
  }
  const submitted = Boolean(response?.submitted);
  const outcome = {
    ...(last.outcome ?? outcomeOf({ filled: true, refused: [] }, { copied: false, hold: true, submitWanted: true })),
    submitted,
    submitKind: submitted ? response.submitKind ?? '' : '',
    pressed: submitted ? response.pressed ?? '' : '',
    held: Boolean(last.outcome?.held) && !submitted,
  };
  const record = { ...last, held: Boolean(last.held) && !submitted, outcome };
  await rememberCode(record);
  if (submitted) {
    await recordHistory(
      [{ ...record, seenAt: Date.now(), site: last.site ?? '', filled: true, submitted: true }],
      { keepMinutes: settings.historyMinutes },
    );
    await flashBadge('✓', '#1b8a3a');
  }
  return { ok: true, found: true, result: { ...record, filled: true, submitted } };
}

/**
 * The page's own card was used: "Submit anyway" or a swap.
 *
 * The content script reports it so the popup, opened afterwards, describes what
 * actually happened rather than what the fill left behind.
 *
 * @param {{ action: string, code: string, submitted: boolean, submitKind?: string, pressed: string }} message
 * @param {chrome.runtime.MessageSender} sender
 */
async function noteUsedOnPage({ action, code, submitted, submitKind = '', pressed = '' }, sender) {
  const [last, settings] = await Promise.all([readLastCode(), readSettings()]);
  const site = siteOf(sender.tab?.url ?? '') || last?.site || '';
  const done = Boolean(submitted);

  if (action === 'submitted') {
    if (!last?.code) return;
    const outcome = {
      ...(last.outcome ?? {}),
      submitted: done,
      submitKind: done ? submitKind : last.outcome?.submitKind ?? '',
      pressed: done ? pressed : last.outcome?.pressed ?? '',
      held: Boolean(last.outcome?.held) && !done,
    };
    await rememberCode({ ...last, held: Boolean(last.held) && !done, outcome });
    if (done) {
      await recordHistory(
        [{ ...last, seenAt: Date.now(), site, filled: true, submitted: true }],
        { keepMinutes: settings.historyMinutes },
      );
      await flashBadge('✓', '#1b8a3a');
    }
    return;
  }

  if (action !== 'swapped' || !code) return;
  const history = await readHistory({ keepMinutes: settings.historyMinutes });
  const row = history.find((entry) => entry.code === code) ?? (last?.code === code ? last : null);
  const record = {
    code,
    messageId: row?.messageId ?? '',
    from: row?.from ?? '',
    address: senderAddress(row?.from ?? ''),
    subject: row?.subject ?? '',
    senderSite: row?.senderSite ?? '',
    receivedAt: Number(row?.receivedAt) || Date.now(),
    link: row?.link ?? '',
    account: row?.account ?? '',
    foundAt: Date.now(),
    confidence: Number(row?.confidence) || 0,
    reasons: [],
    siteMatch: Boolean(row?.siteMatch),
    ambiguous: false,
    held: false,
    site,
    outcome: {
      ...outcomeOf(
        {
          filled: true,
          kind: last?.outcome?.kind,
          boxes: last?.outcome?.boxes,
          label: last?.outcome?.label,
          refused: last?.outcome?.refused,
        },
        { copied: false, hold: false, submitWanted: settings.autoSubmit },
      ),
      submitted: done,
      submitKind: done ? submitKind : '',
      pressed: done ? pressed : '',
      swapped: true,
    },
  };
  await rememberCode(record);
  if (record.messageId) await markMessageUsed(record.messageId);
  await recordHistory(
    [{ ...record, seenAt: Date.now(), site, filled: true, submitted: done }],
    { keepMinutes: settings.historyMinutes },
  );
  await flashBadge('✓', '#1b8a3a');
}

/**
 * The shortcut pressed again, on the page that was just filled.
 *
 * The first press put a code in the box. A second one is not a request for the
 * same code twice; it is the only gesture there is without opening anything, and
 * what it asks is "was that the right one?". So the page's own card comes back
 * with the other codes — anything newer in the inbox, then the recent list — each
 * one click from taking the box over. Nothing is typed in and nothing is pressed
 * until a row is chosen; a code that was held comes back held, with the submit
 * still on offer.
 *
 * Only while the first fill is still on screen. The tab has to be on the site the
 * code went into, the code has to be within the freshness window, and the page
 * answers only if it still holds the boxes that were filled. Otherwise the press
 * is an ordinary fetch, which is what it always was.
 *
 * @param {{ id: number, url?: string }} tab
 * @returns {Promise<boolean>} whether the page put its card up
 */
async function offerPicker(tab) {
  const [last, settings] = await Promise.all([readLastCode(), readSettings()]);
  const site = siteOf(tab.url ?? '');
  if (!last?.outcome?.filled || !site || last.site !== site) return false;
  if (Date.now() - (Number(last.foundAt) || 0) > settings.freshnessMinutes * 60000) return false;

  // Anything that has arrived since is worth a row, so the inbox is read once
  // more. Read only: nothing found here is delivered.
  let fresh = [];
  try {
    const found = await searchForCode({ site });
    if (found) fresh = [found, ...(found.alternatives ?? [])];
  } catch {
    // The inbox could not be read just now; the recent list is still worth offering.
  }
  const rows = await pickerRows({ exclude: last.code, alternatives: fresh, keepMinutes: settings.historyMinutes });

  const tabId = tab.id;
  let response = null;
  try {
    response = await chrome.tabs.sendMessage(tabId, { type: 'show-picker', rows });
  } catch {
    // No frame in this tab holds a fill any more: the form went, or the page did.
    response = null;
  }
  return Boolean(response?.shown);
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
  let tick = 0;
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
          categories: tick % CATEGORY_PROBE_EVERY === 0,
        });
        tick += 1;

        // Confidence asks whether this number is a code at all; below the bar,
        // nothing is typed in unasked. Whether it is *this page's* code is the
        // other question, and `deliver` answers it the same way for both paths:
        // a code nothing ties to the site goes in and is held, never submitted.
        if (found && found.confidence >= AUTO_FILL_CONFIDENCE) {
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
            address: senderAddress(found.from),
            subject: found.subject,
            senderSite: found.senderSite ?? '',
            receivedAt: found.receivedAt,
            link: found.link ?? '',
            account: found.account ?? '',
            foundAt: Date.now(),
            confidence: found.confidence,
            reasons: found.reasons,
            siteMatch: Boolean(found.siteMatch),
            ambiguous: Boolean(found.ambiguous),
            held: false,
            site: watch.origin,
            outcome: null,
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
  const [settings, lastCode, watch, onboarding] = await Promise.all([
    readSettings(),
    readLastCode(),
    readWatch(),
    readOnboarding(),
  ]);
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
    // The one-time tip: due once a code has gone in, until it is closed.
    guide: guideDue(onboarding),
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
  async refill({ tabId = null, url = '', code = '' }) {
    return refillNow({ tabId, url, code });
  },

  /** Press the button for a code that was filled and held. */
  async submit({ tabId = null }) {
    return submitNow({ tabId });
  },

  async copy({ text }) {
    const copied = await copyText(String(text ?? ''));
    if (copied) await scheduleClipboardClear((await readSettings()).clipboardClearSeconds);
    return { ok: copied };
  },

  /**
   * The popup wrote to the clipboard itself; arm the wipe.
   *
   * The popup can reach the clipboard directly because it is focused, which is
   * faster and avoids building an offscreen document. The timer cannot live
   * there: the popup is gone the moment it loses focus, and an alarm set by a
   * dead page never fires.
   */
  async 'clipboard-written'() {
    await scheduleClipboardClear((await readSettings()).clipboardClearSeconds);
    return { ok: true };
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

  async 'has-field'({ tabId, url = '' }) {
    return { ok: true, ...(await tabHasCodeField(tabId, url)) };
  },

  /** The one-time tip was read; it does not come back. */
  async 'dismiss-guide'() {
    await writeOnboarding({ dismissedAt: Date.now() });
    return { ok: true };
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

  if (message?.type === 'code-used') {
    // Only a page this extension put a card into can send this, and the only
    // thing it changes is the record of what happened there.
    if (!sender.tab) return false;
    noteUsedOnPage(message, sender).catch(() => {});
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
      // On the page that was just filled, a second press is a question about the
      // first, not a request to type the same code in twice.
      if (tab?.id && (await offerPicker(tab))) return;
      const result = await pasteNow({ tabId: tab?.id ?? null, url: tab?.url ?? '' });
      if (!result.found) {
        await flashBadge('–', '#6a6a70', 8);
        const settings = await readSettings();
        if (settings.notify) {
          await chrome.notifications.create({
            type: 'basic',
            iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
            title: 'No code found',
            message:
              'Nothing unread in Gmail looks like a one-time code. Read it on your phone already? ' +
              'Mark it unread, then try again.',
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
    const settings = await readSettings();
    await syncAutoRegistration(settings);

    // Open the setup page only when the reader that is actually selected cannot
    // work without it. This used to open on any install without a client ID,
    // which is every default install — so a first run landed on a seven-step
    // Google Cloud walkthrough that the default reader does not need and never
    // asks for. The honest first run is no page at all: sign in to Gmail, press
    // the button. Anyone whose synced settings already select the API reader does
    // still need those steps, and gets them.
    if (details.reason === 'install' && settings.source === SOURCES.api && !isConfigured()) {
      await chrome.runtime.openOptionsPage();
    }
  })().catch(() => {});
});

/**
 * Settings, their defaults, and the small amount of per-session state.
 *
 * Two stores, on purpose:
 *
 *   chrome.storage.sync    preferences. Small, and worth carrying between your
 *                          machines.
 *   chrome.storage.session the last code found, and which messages have already
 *                          been used. Memory-backed and dropped when the browser
 *                          closes, which is the right lifetime for a credential
 *                          that is only valid for a few minutes anyway.
 *
 * `normalizeSettings` is separated from the storage calls so the clamping rules
 * can be tested without a browser.
 */

/** Where codes are read from. */
export const SOURCES = {
  /**
   * Gmail's Atom inbox feed, authenticated by the browser's existing Gmail
   * session. Needs no setup, and is the default for that reason. Sees unread
   * inbox mail: sender, subject, and a snippet of the body.
   */
  feed: 'feed',
  /**
   * The Gmail API over OAuth. Sees whole message bodies, at the cost of a
   * one-time Google Cloud setup.
   */
  api: 'api',
};

export const DEFAULTS = {
  /** Which reader to use. See SOURCES. */
  source: SOURCES.feed,
  /** Codes older than this are ignored. Most services expire them in 5-10 min. */
  freshnessMinutes: 10,
  /** Watch pages for a code box and fill it the moment the mail lands. */
  autoFill: false,
  /** Also put the code on the clipboard, so Ctrl+V works if the fill misses. */
  autoCopy: true,
  /**
   * Submit the form after filling.
   *
   * On by default, because typing a code and then pressing the only button on
   * the page is not a decision anybody makes — it is a step. The care goes into
   * *how* it submits rather than whether: the same form only, a button that reads
   * like a submit button, and the Enter key when there is no form to submit. See
   * `submitFrom` in content.js.
   */
  autoSubmit: true,
  /**
   * Say so on the page after filling.
   *
   * The fill happens while you are looking at the page, so that is where the
   * confirmation belongs — particularly once submitting is automatic, where the
   * form can be gone before you have read it.
   */
  inPageToast: true,
  /** Desktop notification when a code is delivered. */
  notify: true,
  /**
   * When the keyword search finds nothing, scan recent mail regardless of
   * subject. Catches unusual senders, at the cost of reading more messages, so
   * it is off unless you need it.
   */
  scanAllRecentMail: false,
  /** Overwrite the clipboard with a blank after this long. 0 leaves it alone. */
  clipboardClearSeconds: 0,
  /**
   * How long a code stays in the recent list. 0 keeps no list at all.
   *
   * The list answers "what was that code, and who was it for?" a minute after
   * the fact — when a code was filled into the wrong tab, or two arrived at once,
   * or a page ate one without saying so. Half an hour outlives any code worth
   * asking about.
   */
  historyMinutes: 30,
  /** How often to re-check Gmail while watching for a code to arrive. */
  pollSeconds: 4,
  /** How long a watch runs before giving up. */
  watchSeconds: 120,
  /** Extra Gmail search terms, ANDed with the built-in query. Usually empty. */
  extraQuery: '',
};

const BOUNDS = {
  freshnessMinutes: [1, 120],
  clipboardClearSeconds: [0, 600],
  historyMinutes: [0, 240],
  pollSeconds: [2, 30],
  watchSeconds: [15, 600],
};

const BOOLEANS = ['autoFill', 'autoCopy', 'autoSubmit', 'inPageToast', 'notify', 'scanAllRecentMail'];

/**
 * The optional grant that automatic filling needs, in one place.
 *
 * Three files ask about it — the worker to decide whether to register the
 * watcher, the popup and the options page to request it — and if their patterns
 * ever disagreed the grant would be requested but never recognised.
 *
 * Scoped to http and https rather than `<all_urls>` so it matches the registered
 * content script exactly, and does not quietly include `file://` pages.
 */
export const SITE_ORIGINS = ['http://*/*', 'https://*/*'];

/** Gmail rejects overlong queries, and a runaway value here is never intended. */
const EXTRA_QUERY_LIMIT = 200;

/** Highest account slot that can be stored. Mirrors MAX_ACCOUNT_INDEX. */
const ACCOUNT_INDEX_LIMIT = 4;

function clamp(value, [min, max], fallback) {
  // `Number(null)`, `Number('')` and `Number(false)` are all 0, which would be
  // clamped to the minimum and look like a deliberate choice. Treat them as
  // absent instead, so a half-written storage entry restores the default rather
  // than silently setting the most aggressive value available.
  if (value === null || value === '' || typeof value === 'boolean') return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

/**
 * Coerce whatever is in storage into a usable settings object.
 *
 * Storage can hold values written by an older version, or by a hand-edited
 * export, so every field is checked rather than trusted.
 *
 * @param {Record<string, unknown>} [raw]
 * @returns {typeof DEFAULTS}
 */
export function normalizeSettings(raw = {}) {
  const settings = { ...DEFAULTS };
  for (const key of BOOLEANS) {
    if (raw[key] !== undefined) settings[key] = Boolean(raw[key]);
  }
  for (const [key, bounds] of Object.entries(BOUNDS)) {
    if (raw[key] !== undefined) settings[key] = clamp(raw[key], bounds, DEFAULTS[key]);
  }
  if (raw.extraQuery !== undefined) {
    settings.extraQuery = String(raw.extraQuery).replace(/\s+/g, ' ').trim().slice(0, EXTRA_QUERY_LIMIT);
  }
  if (raw.source !== undefined) {
    // An unrecognised source would leave the extension unable to read anything,
    // so anything unexpected falls back to the one that needs no setup.
    settings.source = raw.source === SOURCES.api ? SOURCES.api : SOURCES.feed;
  }
  return settings;
}

/**
 * The mailboxes signed in to this browser, as discovered by probing feed slots.
 *
 * Deliberately not part of the synced settings: which Google accounts are signed
 * in, and in what order, is a property of one browser profile. Syncing it would
 * have a second machine polling account slots that do not exist there.
 *
 * @param {unknown} raw
 * @returns {Array<{ index: number, account: string }>}
 */
export function normalizeFeedAccounts(raw) {
  return (Array.isArray(raw) ? raw : [])
    .map((entry) => ({ index: Number(entry?.index), account: String(entry?.account ?? '') }))
    .filter((entry) => Number.isInteger(entry.index) && entry.index >= 0 && entry.index <= ACCOUNT_INDEX_LIMIT)
    .slice(0, ACCOUNT_INDEX_LIMIT + 1);
}

export async function readFeedAccounts() {
  const stored = await chrome.storage.local.get('feedAccounts');
  return normalizeFeedAccounts(stored.feedAccounts);
}

/** @param {Array<{ index: number, account: string }>} accounts */
export async function writeFeedAccounts(accounts) {
  const normalized = normalizeFeedAccounts(accounts);
  await chrome.storage.local.set({ feedAccounts: normalized });
  return normalized;
}

export async function readSettings() {
  const raw = await chrome.storage.sync.get(Object.keys(DEFAULTS));
  return normalizeSettings(raw);
}

/** @param {Partial<typeof DEFAULTS>} patch */
export async function writeSettings(patch) {
  const merged = normalizeSettings({ ...(await readSettings()), ...patch });
  await chrome.storage.sync.set(merged);
  return merged;
}

/** @param {(settings: typeof DEFAULTS) => void} listener */
export function onSettingsChanged(listener) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    if (!Object.keys(changes).some((key) => key in DEFAULTS)) return;
    readSettings().then(listener);
  });
}

/* ------------------------------------------------------------------ *
 * Session state
 * ------------------------------------------------------------------ */

const SESSION_KEYS = {
  lastCode: 'lastCode',
  usedMessageIds: 'usedMessageIds',
  watch: 'watch',
  history: 'codeHistory',
};

/**
 * How many message ids to remember as "already delivered".
 *
 * The list exists so a second look at the same inbox does not re-deliver a code
 * you have already used. It only has to outlive the freshness window, so it can
 * stay small.
 */
const USED_HISTORY_LIMIT = 40;

/**
 * @typedef {object} DeliveredCode
 * @property {string} code
 * @property {string} messageId
 * @property {string} from        Display name or address the mail came from.
 * @property {string} subject
 * @property {number} receivedAt  When Gmail received it, epoch ms.
 * @property {number} foundAt     When we read it, epoch ms.
 * @property {number} confidence
 */

/** @param {DeliveredCode} code */
export async function rememberCode(code) {
  await chrome.storage.session.set({ [SESSION_KEYS.lastCode]: code });
}

/** @returns {Promise<DeliveredCode | null>} */
export async function readLastCode() {
  const stored = await chrome.storage.session.get(SESSION_KEYS.lastCode);
  return stored[SESSION_KEYS.lastCode] ?? null;
}

export async function forgetLastCode() {
  await chrome.storage.session.remove(SESSION_KEYS.lastCode);
}

/** @returns {Promise<Set<string>>} */
export async function readUsedMessageIds() {
  const stored = await chrome.storage.session.get(SESSION_KEYS.usedMessageIds);
  return new Set(stored[SESSION_KEYS.usedMessageIds] ?? []);
}

/** @param {string} messageId */
export async function markMessageUsed(messageId) {
  const used = await readUsedMessageIds();
  used.delete(messageId);
  const next = [...used, messageId].slice(-USED_HISTORY_LIMIT);
  await chrome.storage.session.set({ [SESSION_KEYS.usedMessageIds]: next });
}

export async function clearUsedMessageIds() {
  await chrome.storage.session.remove(SESSION_KEYS.usedMessageIds);
}

/* ------------------------------------------------------------------ *
 * Recent codes
 * ------------------------------------------------------------------ */

/**
 * Rows kept in the recent list, regardless of the time window.
 *
 * The window is the real limit; this is only here so a pathological afternoon
 * cannot grow the record without bound.
 */
const HISTORY_LIMIT = 12;

/**
 * @typedef {object} HistoryEntry
 * @property {string} code
 * @property {string} messageId
 * @property {string} from        Raw `From` header.
 * @property {string} subject
 * @property {string} senderSite  Registrable domain the mail came from, when known.
 * @property {number} receivedAt  When Gmail received it, epoch ms.
 * @property {number} seenAt      When we read it, epoch ms.
 * @property {number} confidence
 * @property {string} link        Gmail's address for the message, when known.
 * @property {string} account     Mailbox it was read from, when known.
 * @property {boolean} siteMatch  Whether the mail was tied to the page it was found for.
 * @property {string} site        Page it was filled into, when it was.
 * @property {boolean} filled
 * @property {boolean} submitted
 */

/**
 * Fold new sightings into the list.
 *
 * Pure, so the pruning rules can be tested without a browser. Newest first, one
 * row per code, and a re-sighting updates the row it already has rather than
 * adding a second — asking for the same code twice is the ordinary way to recover
 * from a mistyped one, and it should not read as two arrivals.
 *
 * @param {HistoryEntry[]} existing
 * @param {Partial<HistoryEntry>[]} additions
 * @param {{ keepMinutes: number, now?: number, limit?: number }} options
 * @returns {HistoryEntry[]}
 */
export function foldHistory(existing, additions, { keepMinutes, now = Date.now(), limit = HISTORY_LIMIT }) {
  if (!keepMinutes) return [];

  /** @type {Map<string, HistoryEntry>} */
  const byCode = new Map();
  for (const entry of [...(Array.isArray(existing) ? existing : []), ...(additions ?? [])]) {
    if (!entry?.code) continue;
    const key = `${entry.messageId ?? ''}|${entry.code}`;
    const previous = byCode.get(key);
    byCode.set(key, {
      code: String(entry.code),
      messageId: String(entry.messageId ?? previous?.messageId ?? ''),
      from: String(entry.from ?? previous?.from ?? ''),
      subject: String(entry.subject ?? previous?.subject ?? ''),
      senderSite: String(entry.senderSite ?? previous?.senderSite ?? ''),
      receivedAt: Number(entry.receivedAt ?? previous?.receivedAt ?? now),
      seenAt: Number(previous?.seenAt ?? entry.seenAt ?? now),
      confidence: Number(entry.confidence ?? previous?.confidence ?? 0),
      link: String(entry.link || previous?.link || ''),
      account: String(entry.account || previous?.account || ''),
      siteMatch: Boolean(entry.siteMatch || previous?.siteMatch),
      // A later sighting can only add to what is known about a row: a code that
      // was filled stays filled even if a later pass only copied it.
      site: String(entry.site || previous?.site || ''),
      filled: Boolean(entry.filled || previous?.filled),
      submitted: Boolean(entry.submitted || previous?.submitted),
    });
  }

  const cutoff = now - keepMinutes * 60000;
  return [...byCode.values()]
    .filter((entry) => Math.max(entry.receivedAt, entry.seenAt) >= cutoff)
    .sort((a, b) => b.receivedAt - a.receivedAt)
    .slice(0, limit);
}

/**
 * @param {Partial<HistoryEntry>[]} additions
 * @param {{ keepMinutes: number }} options
 * @returns {Promise<HistoryEntry[]>}
 */
export async function recordHistory(additions, { keepMinutes }) {
  if (!keepMinutes) {
    await clearHistory();
    return [];
  }
  const next = foldHistory(await readHistory({ keepMinutes }), additions, { keepMinutes });
  await chrome.storage.session.set({ [SESSION_KEYS.history]: next });
  return next;
}

/**
 * @param {{ keepMinutes: number }} options
 * @returns {Promise<HistoryEntry[]>}
 */
export async function readHistory({ keepMinutes }) {
  if (!keepMinutes) return [];
  const stored = await chrome.storage.session.get(SESSION_KEYS.history);
  // Pruned on the way out as well as on the way in, so a list that has simply
  // gone stale reads as empty without waiting for the next arrival to tidy it.
  return foldHistory(stored[SESSION_KEYS.history] ?? [], [], { keepMinutes });
}

export async function clearHistory() {
  await chrome.storage.session.remove(SESSION_KEYS.history);
}

/**
 * @typedef {object} Watch
 * @property {number} tabId
 * @property {string} origin
 * @property {number} startedAt  epoch ms
 * @property {number} until      epoch ms
 */

/** @param {Watch | null} watch */
export async function writeWatch(watch) {
  if (watch) await chrome.storage.session.set({ [SESSION_KEYS.watch]: watch });
  else await chrome.storage.session.remove(SESSION_KEYS.watch);
}

/** @returns {Promise<Watch | null>} */
export async function readWatch() {
  const stored = await chrome.storage.session.get(SESSION_KEYS.watch);
  return stored[SESSION_KEYS.watch] ?? null;
}

/* ------------------------------------------------------------------ *
 * First run
 * ------------------------------------------------------------------ */

/**
 * @typedef {object} Onboarding
 * @property {number} firstFillAt   When the first code went into a page, epoch ms; 0 until then.
 * @property {number} dismissedAt   When the one-time tip was closed, epoch ms; 0 until then.
 */

/**
 * The one piece of state that has to outlive a browser session: whether the
 * first-fill tip has been shown. It carries no code and no mail — two
 * timestamps — and lives in `local` rather than `sync` because it is a fact
 * about this install, not a preference.
 *
 * @param {unknown} raw
 * @returns {Onboarding}
 */
export function normalizeOnboarding(raw) {
  const stamp = (value) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Math.trunc(Number(value)) : 0);
  return { firstFillAt: stamp(raw?.firstFillAt), dismissedAt: stamp(raw?.dismissedAt) };
}

/** @returns {Promise<Onboarding>} */
export async function readOnboarding() {
  const stored = await chrome.storage.local.get('onboarding');
  return normalizeOnboarding(stored.onboarding);
}

/** @param {Partial<Onboarding>} patch */
export async function writeOnboarding(patch) {
  const merged = normalizeOnboarding({ ...(await readOnboarding()), ...patch });
  await chrome.storage.local.set({ onboarding: merged });
  return merged;
}

/** Whether the one-time tip is due: a code has gone in, and nobody has closed it yet. */
export function guideDue(onboarding) {
  return Boolean(onboarding?.firstFillAt) && !onboarding?.dismissedAt;
}

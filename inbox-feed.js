/**
 * Reading Gmail with no setup at all.
 *
 * Gmail still serves a per-account Atom feed of unread inbox mail at
 * `https://mail.google.com/mail/u/<n>/feed/atom`, authenticated by the ordinary
 * Gmail session cookie. An extension with a host permission for
 * `mail.google.com` can fetch it with `credentials: 'include'` and get sender,
 * subject, a snippet of the body, and a timestamp — without OAuth, without a
 * Cloud project, without the user doing anything but being signed in to Gmail.
 * This is the mechanism the long-standing Gmail checker extensions use, and it is
 * why they appear to need no setup.
 *
 * Two things to be honest about.
 *
 * 1. It is a legacy endpoint. Google's own documentation now describes it as
 *    available for Workspace accounts, and says nothing about the cookie-
 *    authenticated consumer case that in practice still works. It could be
 *    withdrawn. `gmail.js` exists so there is somewhere to go if it is.
 *
 * 2. `<summary>` is a snippet, not the body. For one-time codes that is nearly
 *    always sufficient — the code is in the subject or the opening sentence,
 *    because that is what makes a code mail useful — but "nearly always" is not
 *    "always", and the Gmail API path is the answer when it is not.
 *
 * Two things it is unexpectedly good at. The feed lists only *unread inbox* mail,
 * so it is naturally scoped to messages that just arrived and have not been dealt
 * with, which is exactly what a one-time code is. And it carries far less text
 * than a full message, so there are fewer decoy numbers to score against.
 *
 * The parsing is done by hand rather than with DOMParser, which does not exist in
 * a service worker. The format is Atom 0.3 and has not changed in twenty years.
 */

import { decodeEntities } from './text.js';

const FEED_ORIGIN = 'https://mail.google.com';

/**
 * How many signed-in account slots to probe when discovering mailboxes.
 *
 * Gmail numbers concurrently signed-in accounts from zero. Five covers any
 * realistic setup, and discovery only runs when asked.
 */
export const MAX_ACCOUNT_INDEX = 4;

export class FeedError extends Error {
  /** @param {'signed-out' | 'unreachable' | 'unexpected'} kind */
  constructor(kind, message) {
    super(message);
    this.name = 'FeedError';
    this.kind = kind;
  }
}

/** @param {number} index */
export function feedUrl(index = 0) {
  return `${FEED_ORIGIN}/mail/u/${Math.max(0, Math.trunc(index))}/feed/atom`;
}

/** First occurrence of a tag's text content, entity-decoded. */
function tagText(source, tag) {
  const match = source.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i'));
  if (!match) return '';
  return decodeEntities(match[1])
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * "Gmail - Inbox for someone@example.com" -> "someone@example.com".
 *
 * Used to tell mailboxes apart, and to notice when a probe for a signed-out slot
 * has quietly been answered with the primary account's feed instead.
 */
function accountFromTitle(title) {
  const match = String(title).match(/([\w.+-]+@[\w.-]+\.\w+)/);
  return match ? match[1].toLowerCase() : '';
}

/**
 * Parse an Atom inbox feed.
 *
 * @param {string} xml
 * @returns {{ account: string, unreadCount: number,
 *             entries: Array<{ id: string, from: string, subject: string, text: string, receivedAt: number }> }}
 */
export function parseInboxFeed(xml) {
  const source = String(xml ?? '');
  if (!/<feed[\s>]/i.test(source)) {
    // A signed-out request answers with Google's login page, which is HTML.
    throw new FeedError('signed-out', 'Gmail did not return a feed. Sign in to Gmail in this browser.');
  }

  const head = source.split(/<entry[\s>]/i)[0];
  const title = tagText(head, 'title');
  const unreadCount = Number(tagText(head, 'fullcount')) || 0;

  const entries = [];
  for (const match of source.matchAll(/<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi)) {
    const entry = match[1];
    const subject = tagText(entry, 'title');
    const summary = tagText(entry, 'summary');
    // Atom 0.3 dates the entry with <issued>; <modified> is the fallback.
    const issued = tagText(entry, 'issued') || tagText(entry, 'modified');
    const name = tagText(entry, 'name');
    const email = tagText(entry, 'email');

    entries.push({
      id: tagText(entry, 'id') || `${issued}|${subject}`,
      from: name && email ? `${name} <${email}>` : name || email,
      subject,
      // The scorer wants one field of body text. The subject is scored separately,
      // so only the snippet goes here.
      text: summary,
      receivedAt: Date.parse(issued) || 0,
    });
  }

  return { account: accountFromTitle(title), unreadCount, entries };
}

/**
 * Fetch and parse one account's feed.
 *
 * `credentials: 'include'` is the whole trick: the request carries the Gmail
 * session cookie, so Google authenticates it as the signed-in user. A service
 * worker may do this cross-origin for hosts in `host_permissions`, which is
 * exactly why this work does not live in a content script.
 *
 * @param {{ index?: number, fetchImpl?: typeof fetch }} [options]
 */
export async function fetchInboxFeed({ index = 0, fetchImpl = globalThis.fetch } = {}) {
  let response;
  try {
    response = await fetchImpl(feedUrl(index), {
      credentials: 'include',
      // A cached feed would mean missing the code that just arrived.
      cache: 'no-store',
      headers: { Accept: 'application/atom+xml, application/xml, text/xml' },
    });
  } catch {
    throw new FeedError('unreachable', 'Could not reach Gmail. Check your connection.');
  }

  if (response.status === 401 || response.status === 403) {
    throw new FeedError('signed-out', 'Gmail rejected the request. Sign in to Gmail in this browser.');
  }
  if (!response.ok) {
    throw new FeedError('unexpected', `Gmail returned ${response.status} for the inbox feed.`);
  }

  return parseInboxFeed(await response.text());
}

/**
 * Which mailboxes this browser is signed in to.
 *
 * Probing is necessary because nothing exposes the list. A slot nobody is signed
 * in to does not reliably fail: Gmail may answer with the primary account's feed
 * instead, so results are deduplicated by address and a repeat ends the probe.
 *
 * @param {{ fetchImpl?: typeof fetch, max?: number }} [options]
 * @returns {Promise<Array<{ index: number, account: string, unreadCount: number }>>}
 */
export async function discoverAccounts({ fetchImpl, max = MAX_ACCOUNT_INDEX } = {}) {
  const found = [];
  const seen = new Set();

  for (let index = 0; index <= max; index++) {
    let feed;
    try {
      feed = await fetchInboxFeed({ index, fetchImpl });
    } catch (error) {
      // Nothing signed in at all is worth reporting; a gap after the first hit
      // just means we have reached the end of the list.
      if (index === 0) throw error;
      break;
    }

    const account = feed.account || `account ${index}`;
    if (seen.has(account)) break;
    seen.add(account);
    found.push({ index, account, unreadCount: feed.unreadCount });
  }

  return found;
}

/**
 * Unread inbox mail across the given accounts, newest first.
 *
 * @param {object} options
 * @param {Array<{ index: number }>} [options.accounts]
 * @param {number} options.windowMinutes
 * @param {number} [options.now]
 * @param {typeof fetch} [options.fetchImpl]
 * @returns {Promise<Array<{ id: string, from: string, subject: string, text: string, receivedAt: number }>>}
 */
export async function fetchCandidateEntries({
  accounts = [{ index: 0 }],
  windowMinutes,
  now = Date.now(),
  fetchImpl,
}) {
  const indexes = accounts.length > 0 ? accounts.map((account) => account.index) : [0];
  const feeds = await Promise.allSettled(
    indexes.map((index) => fetchInboxFeed({ index, fetchImpl })),
  );

  // One signed-out mailbox among several should not sink the whole read; only a
  // complete failure is worth raising.
  const fulfilled = feeds.filter((result) => result.status === 'fulfilled');
  if (fulfilled.length === 0) {
    throw feeds[0]?.reason ?? new FeedError('unreachable', 'No Gmail account could be read.');
  }

  // Deduplicated by message id, because a probe for an account slot that is not
  // signed in can be answered with the primary account's feed, which would
  // otherwise return the same message twice.
  const cutoff = now - windowMinutes * 60000;
  const byId = new Map();
  for (const entry of fulfilled.flatMap((result) => result.value.entries)) {
    if (entry.receivedAt < cutoff) continue;
    if (!byId.has(entry.id)) byId.set(entry.id, entry);
  }

  return [...byId.values()].sort((a, b) => b.receivedAt - a.receivedAt);
}

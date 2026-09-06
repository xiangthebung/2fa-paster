/**
 * The slice of the Gmail REST API this extension needs, plus the MIME handling
 * to get from a message resource to readable text.
 *
 * Nothing here touches `chrome.*`. Every entry point takes the access token and,
 * optionally, a `fetch` to use, which keeps the request shaping, the base64url
 * decoding and the HTML flattening testable without a browser — and those are
 * exactly the parts that quietly return mojibake or an empty string if they are
 * wrong.
 *
 * This is the optional path. By default the extension reads the Atom inbox feed
 * instead (see inbox-feed.js), which needs no setup at all. The API is here for
 * the case the feed cannot serve: a code that is further into the body than the
 * feed's snippet reaches.
 */

import { decodeEntities, htmlToText } from './text.js';

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';

/**
 * How much decoded body text to keep per message.
 *
 * A marketing-heavy HTML mail can flatten to a great deal of text, and the code
 * is never at the end of it. This is a bound on scoring work, not a guess about
 * where the code is.
 */
const BODY_LIMIT = 16000;

export class GmailError extends Error {
  /** @param {number} status @param {string} message */
  constructor(status, message) {
    super(message);
    this.name = 'GmailError';
    this.status = status;
  }
  /** A 401 means the cached token is dead and the caller should retry with a new one. */
  get isExpiredToken() {
    return this.status === 401;
  }
  get isRateLimited() {
    return this.status === 429 || this.status === 403;
  }
}

/**
 * Subjects and phrases that identify a code mail, as a Gmail query.
 *
 * Two reasons this is a search rather than "read the last few messages":
 * it keeps the extension from decoding unrelated mail, and it keeps the polling
 * loop cheap enough to run every few seconds. The trade is that an unusually
 * worded mail can be missed, which is what `scanAllRecentMail` is for.
 */
const KEYWORD_QUERY =
  '(subject:(code OR verification OR verify OR otp OR 2fa OR mfa OR passcode OR pin OR ' +
  'authenticate OR authentication OR confirm OR confirmation OR security OR "sign in" OR ' +
  'signin OR login OR "log in") OR "verification code" OR "security code" OR "one-time code" OR ' +
  '"one time code" OR "one-time password" OR "one-time passcode" OR "authentication code" OR ' +
  '"confirmation code" OR "login code" OR "sign-in code" OR "access code" OR "your code" OR ' +
  '"two-factor" OR "two-step" OR "2-step" OR passcode OR otp)';

/** Places a one-time code will never legitimately be read from. */
const EXCLUSIONS = '-in:chats -in:drafts -in:sent -in:trash -in:spam';

/**
 * @param {{ broad?: boolean, extraQuery?: string, days?: number }} [options]
 * @returns {string}
 */
export function buildQuery({ broad = false, extraQuery = '', days = 1 } = {}) {
  // Gmail's relative-date operator only understands days, months and years, so
  // the real freshness window is applied client-side against internalDate.
  const parts = [`newer_than:${Math.max(1, Math.round(days))}d`, EXCLUSIONS];
  if (!broad) parts.push(KEYWORD_QUERY);
  const extra = String(extraQuery ?? '').trim();
  if (extra) parts.push(extra);
  return parts.join(' ');
}

/**
 * Decode a base64url payload to text.
 *
 * Gmail encodes part bodies as base64url without padding. Going through bytes
 * and TextDecoder rather than `atob` alone is what keeps non-ASCII intact; a
 * naive decode turns a UTF-8 pound sign into two characters of noise.
 *
 * @param {string} data
 * @returns {string}
 */
export function decodeBase64Url(data) {
  if (!data) return '';
  const base64 = String(data).replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  } catch {
    return '';
  }
}

/** @param {Array<{ name: string, value: string }>} headers @param {string} name */
export function header(headers, name) {
  const wanted = name.toLowerCase();
  return headers?.find((entry) => entry.name?.toLowerCase() === wanted)?.value ?? '';
}

/**
 * Collect the text of every readable part, depth first.
 *
 * Both the plain and the HTML alternative are kept. They normally carry the same
 * code, and a candidate that appears in both is corroborated rather than
 * duplicated — `findCodeInMessage` merges by value and treats a repeat as a
 * small positive.
 *
 * @param {object} payload
 * @returns {{ plain: string, html: string }}
 */
export function collectParts(payload) {
  const plain = [];
  const html = [];

  const walk = (part, depth = 0) => {
    if (!part || depth > 12) return;
    const mimeType = String(part.mimeType ?? '').toLowerCase();
    const data = part.body?.data;

    if (data && mimeType === 'text/plain') plain.push(decodeBase64Url(data));
    else if (data && mimeType === 'text/html') html.push(htmlToText(decodeBase64Url(data)));
    else if (data && !part.parts && mimeType.startsWith('text/')) plain.push(decodeBase64Url(data));

    for (const child of part.parts ?? []) walk(child, depth + 1);
  };

  walk(payload);
  return { plain: plain.join('\n').trim(), html: html.join('\n').trim() };
}

/**
 * Turn a Gmail message resource into the flat shape the scorer wants.
 *
 * @param {object} raw
 * @returns {{ id: string, from: string, subject: string, snippet: string, text: string,
 *             receivedAt: number, link: string }}
 */
export function normalizeMessage(raw) {
  const headers = raw?.payload?.headers ?? [];
  const { plain, html } = collectParts(raw?.payload);
  const snippet = decodeEntities(raw?.snippet ?? '');
  const id = String(raw?.id ?? '');

  // Prefer the real body; fall back to the snippet, which is all that is left
  // for a message whose parts are attachments or an unsupported encoding.
  const body = [plain, html].filter(Boolean).join('\n') || snippet;

  return {
    id,
    from: header(headers, 'from'),
    subject: header(headers, 'subject'),
    snippet,
    text: body.slice(0, BODY_LIMIT),
    receivedAt: Number(raw?.internalDate) || Date.parse(header(headers, 'date')) || 0,
    // The API hands back no web address for a message, but Gmail's own UI opens
    // any message by its id, so one can be written. Opened by the person, in a
    // tab; nothing here fetches it.
    link: id ? `https://mail.google.com/mail/#all/${encodeURIComponent(id)}` : '',
  };
}

/**
 * @param {string} path
 * @param {{ token: string, fetchImpl?: typeof fetch, params?: Record<string, string | number> }} options
 */
async function request(path, { token, fetchImpl = globalThis.fetch, params }) {
  const url = new URL(`${API}${path}`);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }

  let response;
  try {
    response = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } });
  } catch {
    throw new GmailError(0, 'Could not reach Gmail. Check your connection.');
  }

  if (!response.ok) {
    // The API puts something useful in error.message; a failed read of the body
    // must not mask the status, which is what the caller actually routes on.
    let detail = '';
    try {
      const body = await response.json();
      detail = body?.error?.message ?? '';
    } catch {
      // Ignore.
    }
    throw new GmailError(response.status, detail || `Gmail returned ${response.status}.`);
  }

  return response.json();
}

/**
 * @param {{ token: string, query: string, maxResults?: number, fetchImpl?: typeof fetch }} options
 * @returns {Promise<string[]>}
 */
export async function listMessageIds({ token, query, maxResults = 10, fetchImpl }) {
  const body = await request('/messages', {
    token,
    fetchImpl,
    params: { q: query, maxResults },
  });
  return (body?.messages ?? []).map((message) => message.id).filter(Boolean);
}

/** @param {{ token: string, id: string, fetchImpl?: typeof fetch }} options */
export async function getMessage({ token, id, fetchImpl }) {
  return request(`/messages/${encodeURIComponent(id)}`, { token, fetchImpl, params: { format: 'full' } });
}

/** The signed-in address, for showing which mailbox is connected. */
export async function getProfileEmail({ token, fetchImpl }) {
  const body = await request('/profile', { token, fetchImpl });
  return body?.emailAddress ?? '';
}

/**
 * Recent messages that might carry a code, newest first.
 *
 * The freshness window is enforced here rather than in the query, because Gmail
 * cannot express "the last ten minutes". A code that expired eight minutes ago is
 * worse than no code at all: it gets typed in, rejected, and blamed on the site.
 *
 * @param {object} options
 * @param {string} options.token
 * @param {number} options.windowMinutes
 * @param {boolean} [options.broad]        search all recent mail, not just keyword hits
 * @param {string} [options.extraQuery]
 * @param {number} [options.max]
 * @param {number} [options.now]
 * @param {typeof fetch} [options.fetchImpl]
 */
export async function fetchCandidateMessages({
  token,
  windowMinutes,
  broad = false,
  extraQuery = '',
  max = 10,
  now = Date.now(),
  fetchImpl,
}) {
  const query = buildQuery({ broad, extraQuery });
  const ids = await listMessageIds({ token, query, maxResults: max, fetchImpl });
  if (ids.length === 0) return [];

  const raw = await Promise.all(ids.map((id) => getMessage({ token, id, fetchImpl })));
  const cutoff = now - windowMinutes * 60000;

  return raw
    .map(normalizeMessage)
    .filter((message) => message.id && message.receivedAt >= cutoff)
    .sort((a, b) => b.receivedAt - a.receivedAt);
}

/**
 * Find the one-time code in an email.
 *
 * This is the part that has to be right. A 2FA mail is mostly noise — dates,
 * order numbers, tracking ids, years in a copyright line, phone numbers in a
 * footer — and the code itself is usually just a run of six digits with no
 * markup to distinguish it. Grabbing the first number in the message gets the
 * wrong answer often enough to be useless.
 *
 * So instead of one pattern, this scores candidates:
 *
 *   - the message has to look like a code delivery at all (`looksLikeCodeMail`),
 *     otherwise a newsletter with a big number in it can never win;
 *   - candidates come from the subject and the body, and where they came from
 *     matters — subjects like "123456 is your code" are common and unambiguous;
 *   - proximity to a phrase like "verification code" counts for a lot, and
 *     proximity to "order number" counts against;
 *   - shapes that are obviously something else (years, times, money, fragments
 *     of longer numbers, phone numbers) are thrown out before scoring.
 *
 * Everything here is pure and synchronous so it can be tested directly. The
 * scores are arbitrary but relative, and `confidence` is the winning score
 * rescaled to 0-100 for display.
 */

import {
  domainLabel,
  isGenericLabel,
  isRelayDomain,
  relatedLabels,
  senderDomain,
} from './domains.js';

/** Phrases that all but name the thing. Worth a lot when they sit next to a candidate. */
const STRONG_PHRASES = [
  'verification code',
  'verify code',
  'confirmation code',
  'authentication code',
  'authorisation code',
  'authorization code',
  'security code',
  'one-time code',
  'one time code',
  'one-time password',
  'one time password',
  'one-time passcode',
  'one time passcode',
  'single-use code',
  'login code',
  'log in code',
  'sign-in code',
  'sign in code',
  'access code',
  'access token',
  'recovery code',
  'device code',
  'pairing code',
  '2fa code',
  'mfa code',
  'otp code',
  'two-factor code',
  'two-step code',
  'your code is',
  'code is',
  'code:',
  'passcode',
  'one-time pin',
  'otp',
];

/** Weaker, but still the vocabulary of a code mail. */
const WEAK_KEYWORDS = [
  'code',
  'verify',
  'verifying',
  'verification',
  'authenticate',
  'authentication',
  'confirm',
  'confirming',
  'two-factor',
  'two-step',
  '2-step',
  'multi-factor',
  'sign in',
  'sign-in',
  'log in',
  'login',
  'pin',
  'token',
  'security',
];

/**
 * Boilerplate that shows up in code mail and almost nowhere else. It never
 * points at a particular number, so it is a small bonus applied to the whole
 * message rather than to a candidate.
 */
const CODE_MAIL_TELLS = [
  'do not share',
  "don't share",
  'never share',
  'do not give',
  'expires in',
  'expires shortly',
  'will expire',
  'valid for',
  'valid until',
  'if you did not request',
  "if you didn't request",
  'someone requested',
  'requested a',
  'enter this',
  'enter the code',
  'use this code',
  'to complete your',
  'to finish signing in',
];

/**
 * Phrases that mean the number after them is an identifier, not a credential.
 * A hit close before a candidate is close to disqualifying.
 */
const DECOY_PHRASES = [
  'order number',
  'order no',
  'order #',
  'order id',
  'invoice number',
  'invoice #',
  'invoice no',
  'reference number',
  'reference #',
  'ref #',
  'ref:',
  'tracking number',
  'tracking #',
  'ticket number',
  'ticket #',
  'case number',
  'account number',
  'account #',
  'account ending',
  'ending in',
  'customer number',
  'customer id',
  'member number',
  'member id',
  'membership number',
  'policy number',
  'transaction id',
  'transaction number',
  'confirmation number',
  'receipt number',
  'serial number',
  'zip code',
  'postal code',
  'post code',
  'postcode',
  'suite',
  'phone number',
  'call us at',
  'call ',
  'tel:',
  'fax',
  'copyright',
  'all rights reserved',
  'unsubscribe',
  'version',
];

/** Any of these anywhere in the mail is the gate for considering it at all. */
const GATE_RE =
  /\b(code|otp|passcode|pin|verif\w*|authenticat\w*|two[- ]?factor|two[- ]?step|2fa|mfa|one[- ]time|token|sign[- ]?in|log[- ]?in)\b/i;

const STRONG_WINDOW = 64;
const WEAK_WINDOW = 44;
const DECOY_WINDOW = 30;

/**
 * Digit runs, optionally split once by a space or a dash.
 *
 * The lookarounds are what keep this honest: a candidate may not touch another
 * letter or digit, so a 9-digit account number yields nothing at all rather than
 * its first 8 digits. The optional second group catches the common "123 456" and
 * "123-456" presentation.
 */
const DIGIT_RUN_RE = /(?<![\dA-Za-z])(\d{3,8})(?:[ \u00a0\-\u2010-\u2015](\d{3,5}))?(?![\dA-Za-z])/g;

/**
 * Mixed letter-and-digit codes, upper case, 6-8 characters. These are only
 * accepted next to a strong phrase, because at this length the pattern also
 * matches plenty of things that are not codes.
 */
const ALNUM_RE = /(?<![\dA-Za-z])(?=[A-Z0-9]{6,8}(?![\dA-Za-z]))(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{6,8}/g;

const MIN_DIGITS = 4;
const MAX_DIGITS = 8;

/** Zero-width characters, which some senders sprinkle through the code itself. */
const INVISIBLE_RE = /[\u200b-\u200f\u2060\ufeff\u00ad]/g;

/**
 * Flatten a message region into something scannable.
 *
 * Newlines survive, because "the code is alone on its line" is one of the
 * strongest signals available once an HTML mail has been reduced to text.
 *
 * @param {string} value
 * @returns {string}
 */
export function normalizeText(value) {
  return String(value ?? '')
    .replace(INVISIBLE_RE, '')
    // Defensive: the caller should have stripped markup already, but a stray
    // tag would otherwise put attribute values in scoring range of a candidate.
    .replace(/<[^>]*>/g, ' ')
    // Links carry long digit runs and tracking ids that are never the code.
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, ' ')
    .replace(/\bwww\.\S+/gi, ' ')
    .replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/** @param {string} text @param {string[]} phrases */
function phraseHits(text, phrases) {
  const hits = [];
  for (const phrase of phrases) {
    let from = 0;
    for (;;) {
      const at = text.indexOf(phrase, from);
      if (at < 0) break;
      hits.push({ at, end: at + phrase.length, phrase });
      from = at + 1;
    }
  }
  return hits;
}

/**
 * Gap in characters between a candidate and the nearest hit, plus the phrase
 * that was closest. Overlapping counts as zero.
 */
function nearestHit(hits, start, end) {
  let best = null;
  for (const hit of hits) {
    const distance = hit.end <= start ? start - hit.end : hit.at >= end ? hit.at - end : 0;
    if (!best || distance < best.distance) best = { distance, phrase: hit.phrase, before: hit.end <= start };
  }
  return best;
}

/** Linear falloff: full weight when adjacent, nothing past the window. */
function proximityScore(hit, window, weight) {
  if (!hit || hit.distance > window) return 0;
  return weight * (1 - hit.distance / window);
}

/**
 * Is this message a code delivery at all?
 *
 * Cheap gate, but it is what stops a receipt or a newsletter from ever
 * contributing a candidate.
 *
 * @param {{ subject?: string, text?: string }} message
 */
export function looksLikeCodeMail(message) {
  return GATE_RE.test(`${message?.subject ?? ''}\n${message?.text ?? ''}`);
}

/**
 * Shapes that are definitely not a one-time code, judged from the characters
 * around the match rather than the match itself.
 *
 * @returns {string | null} why it was rejected, or null to keep it
 */
function structuralRejection(text, start, end, digits) {
  const before2 = text.slice(Math.max(0, start - 2), start);
  const prev = before2.slice(-1);
  const next = text.slice(end, end + 1);
  const next2 = text.slice(end, end + 2);

  // Part of a longer number: "1,234", "3.14159", "10.50".
  if ((prev === ',' || prev === '.') && /\d/.test(before2.slice(0, 1))) return 'fragment of a longer number';
  if ((next === ',' || next === '.') && /\d/.test(text.slice(end + 1, end + 2))) return 'fragment of a longer number';

  // Clock times and ratios.
  if (prev === ':' || next === ':') return 'part of a time';

  // Slash-formatted dates, and "3/4" style fractions.
  if (prev === '/' || next === '/') return 'part of a date';

  // Money and percentages.
  if (/[$£€¥₹]/.test(prev)) return 'a monetary amount';
  if (next === '%') return 'a percentage';

  // A run of digits inside a dotted version or IP.
  if (prev === '.' || (next === '.' && /^\.\d/.test(next2))) return 'part of a dotted number';

  // Phone numbers: the shape "(555) 123-4567" and "+1 555 123 4567" both leave a
  // bracket or a country code just behind the candidate.
  const runway = text.slice(Math.max(0, start - 14), start);
  if (/[)(]\s*$/.test(runway) || /\+\d{1,3}[\s.-]*$/.test(runway)) return 'part of a phone number';

  // A bare year, unless something nearby insists it is a code.
  const value = Number(digits);
  if (digits.length === 4 && value >= 1900 && value <= 2100) {
    const nearby = text.slice(Math.max(0, start - 16), end + 16);
    if (!/\b(code|otp|pin|passcode)\b/i.test(nearby)) return 'a year';
  }

  return null;
}

/**
 * Every plausible code in one region of the message, scored.
 *
 * @param {string} rawText
 * @param {{ region: 'subject' | 'body' }} options
 */
function scoreRegion(rawText, { region }) {
  const text = normalizeText(rawText);
  if (!text) return [];
  const lower = text.toLowerCase();

  const strong = phraseHits(lower, STRONG_PHRASES);
  const weak = phraseHits(lower, WEAK_KEYWORDS);
  const decoys = phraseHits(lower, DECOY_PHRASES);
  const lines = text.split('\n');

  /** Character offset of the start of each line, for the isolation test. */
  const lineStarts = [];
  let cursor = 0;
  for (const line of lines) {
    lineStarts.push(cursor);
    cursor += line.length + 1;
  }
  const lineFor = (index) => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (lineStarts[mid] <= index) low = mid;
      else high = mid - 1;
    }
    return lines[low] ?? '';
  };

  const candidates = [];

  const consider = ({ code, start, end, kind }) => {
    const reasons = [];
    const rejection = structuralRejection(text, start, end, code);
    if (rejection) return;

    let score = 0;

    // Length. Six digits is the overwhelming default; four is common at banks;
    // five and seven are rare enough to be suspicious.
    const byLength = { 4: 26, 5: 18, 6: 40, 7: 16, 8: 24 };
    score += byLength[code.length] ?? 10;
    reasons.push(`${code.length} ${kind === 'alnum' ? 'characters' : 'digits'}`);

    const strongHit = nearestHit(strong, start, end);
    const strongScore = proximityScore(strongHit, STRONG_WINDOW, 46);
    if (strongScore > 0) {
      score += strongScore;
      reasons.push(`near "${strongHit.phrase}"`);
    }

    const weakHit = nearestHit(weak, start, end);
    const weakScore = proximityScore(weakHit, WEAK_WINDOW, 20);
    // Only add the weak signal when no strong phrase already claimed it, so
    // "verification code" is not counted twice via its own "code".
    if (strongScore === 0 && weakScore > 0) {
      score += weakScore;
      reasons.push(`near "${weakHit.phrase}"`);
    }

    const decoyHit = nearestHit(decoys, start, end);
    if (decoyHit && decoyHit.distance <= DECOY_WINDOW) {
      // Only the text leading up to a number labels it, so a decoy behind the
      // candidate counts for much more than one after it.
      const weight = decoyHit.before ? 52 : 16;
      const penalty = weight * (1 - decoyHit.distance / DECOY_WINDOW);
      score -= penalty;
      reasons.push(`but near "${decoyHit.phrase.trim()}"`);
    }

    if (region === 'subject') {
      score += 30;
      reasons.push('in the subject');
    } else if (lineFor(start).trim() === code) {
      // An HTML mail that shows the code in its own large element reduces to a
      // line containing nothing else.
      score += 28;
      reasons.push('alone on its line');
    }

    // An alphanumeric candidate is only credible as a labelled code.
    if (kind === 'alnum') {
      if (strongScore === 0) return;
      score -= 6;
    }

    candidates.push({ code, score, reasons, region });
  };

  for (const match of text.matchAll(DIGIT_RUN_RE)) {
    const code = `${match[1]}${match[2] ?? ''}`;
    if (code.length < MIN_DIGITS || code.length > MAX_DIGITS) continue;
    // A split candidate needs the halves to look deliberate, not two unrelated
    // numbers that happen to be adjacent.
    if (match[2] && (code.length < 6 || match[1].length < 3)) continue;
    consider({ code, start: match.index, end: match.index + match[0].length, kind: 'digits' });
  }

  for (const match of text.matchAll(ALNUM_RE)) {
    consider({
      code: match[0],
      start: match.index,
      end: match.index + match[0].length,
      kind: 'alnum',
    });
  }

  return candidates;
}

/**
 * Does this message belong to the site the user is looking at?
 *
 * Two inboxes deep in a login flow, the deciding factor is often which service
 * sent the mail, so this is checked from several angles: the sender's domain, the
 * display name, the subject, and the body naming the site outright.
 *
 * @param {{ from?: string, subject?: string, text?: string }} message
 * @param {string} [site] registrable domain of the page, e.g. "github.com"
 */
export function matchesSite(message, site) {
  if (!site) return false;
  const target = String(site).toLowerCase();
  const label = domainLabel(target);
  if (label.length < 3) return false;

  const from = String(message?.from ?? '').toLowerCase();
  if (from.includes(target) || from.includes(label)) return true;

  const domain = senderDomain(from);
  if (domain && (domain === target || relatedLabels(domainLabel(domain), label))) return true;

  if (String(message?.subject ?? '').toLowerCase().includes(label)) return true;

  // The body naming the site outright — "you are signing in to github.com" — is
  // as good as the sender doing it. The bare label is not: on its own it is a
  // common enough word that a mention proves nothing.
  return String(message?.text ?? '').toLowerCase().includes(target);
}

/**
 * How a message relates to the page in front of you.
 *
 * The three-way answer is the point. `other` is not "does not match" — it is
 * "identifiably belongs to somebody else", which is a much stronger claim and the
 * only one worth acting on. A code from a domain that names a different company
 * can be set aside; a code from `sendgrid.net` signed "Security" cannot, because
 * nothing about it says who sent it.
 */
export const AFFINITY = {
  /** Sender, subject or body ties this message to the site. */
  match: 'match',
  /** Sender names a different company. */
  other: 'other',
  /** No way to tell: a relay, a channel-named domain, or no site to compare to. */
  unknown: 'unknown',
};

/**
 * @param {{ from?: string, subject?: string, text?: string }} message
 * @param {string} [site] registrable domain of the page
 * @returns {typeof AFFINITY[keyof typeof AFFINITY]}
 */
export function siteAffinity(message, site) {
  if (!site) return AFFINITY.unknown;
  if (matchesSite(message, site)) return AFFINITY.match;

  const domain = senderDomain(message?.from ?? '');
  if (!domain) return AFFINITY.unknown;
  if (isRelayDomain(domain)) return AFFINITY.unknown;

  const label = domainLabel(domain);
  if (label.length < 3 || isGenericLabel(label)) return AFFINITY.unknown;
  return AFFINITY.other;
}

/**
 * The best candidate in a single message.
 *
 * @param {{ id?: string, from?: string, subject?: string, text?: string, receivedAt?: number }} message
 * @param {{ site?: string }} [options]
 * @returns {{ code: string, score: number, reasons: string[] } | null}
 */
export function findCodeInMessage(message, { site } = {}) {
  if (!looksLikeCodeMail(message)) return null;

  const candidates = [
    ...scoreRegion(message.subject ?? '', { region: 'subject' }),
    ...scoreRegion(message.text ?? '', { region: 'body' }),
  ];
  if (candidates.length === 0) return null;

  // The same code usually appears more than once — in the subject and again in
  // the body, or twice in an HTML mail that also carries a text part. Keep the
  // best showing of each, and treat a repeat as mild corroboration.
  const byCode = new Map();
  for (const candidate of candidates) {
    const existing = byCode.get(candidate.code);
    if (!existing) {
      byCode.set(candidate.code, { ...candidate, seen: 1 });
      continue;
    }
    existing.seen += 1;
    if (candidate.score > existing.score) {
      existing.score = candidate.score;
      existing.reasons = candidate.reasons;
      existing.region = candidate.region;
    }
  }

  const messageBonus = (() => {
    let bonus = 0;
    const haystack = `${message.subject ?? ''}\n${message.text ?? ''}`.toLowerCase();
    if (CODE_MAIL_TELLS.some((tell) => haystack.includes(tell))) bonus += 12;
    if (matchesSite(message, site)) bonus += 34;
    return bonus;
  })();

  const ranked = [...byCode.values()]
    .map((candidate) => ({
      ...candidate,
      score: candidate.score + messageBonus + (candidate.seen > 1 ? 8 : 0),
      reasons: [
        ...candidate.reasons,
        ...(candidate.seen > 1 ? ['repeated in the message'] : []),
        ...(matchesSite(message, site) ? [`sent by ${site}`] : []),
      ],
    }))
    .sort((a, b) => b.score - a.score || a.code.length - b.code.length);

  const winner = ranked[0];
  return winner.score > 0 ? { code: winner.code, score: winner.score, reasons: winner.reasons } : null;
}

/**
 * Confidence needed before a code is filled in without being asked.
 *
 * The arithmetic behind the number: a plain "Your verification code is 123456"
 * scores about 95 — six digits, a strong phrase four characters away, and the
 * usual "do not share" boilerplate — which lands near 68. A match with nothing
 * going for it but a lone "code" somewhere in the paragraph scores 60, or about
 * 43. Fifty-five sits between them, so the second kind never gets typed into a
 * page on its own.
 *
 * Manual use has no threshold: the code is on screen and you can see for
 * yourself whether it is the right one.
 */
export const AUTO_FILL_CONFIDENCE = 55;

/**
 * 140 is roughly what a textbook case scores: six digits, in the subject, next to
 * "verification code", from the site you are signing in to.
 *
 * @param {number} score
 */
function confidenceOf(score) {
  return Math.max(1, Math.min(100, Math.round((score / 140) * 100)));
}

/**
 * How much a code from an unidentified sender gives up to one from this site.
 *
 * Not a disqualification, because plenty of services mail from a relay that
 * names nobody. But when one message demonstrably comes from the site in front of
 * you, an anonymous one has to be dramatically better written to win — worth
 * about two thirds of the site-match bonus itself.
 */
const OFF_SITE_PENALTY = 30;

/** Other codes reported alongside the winner, for the popup's recent list. */
const MAX_ALTERNATIVES = 4;

/**
 * Pick the single best code across a batch of messages.
 *
 * Two things are being decided at once, and they are not the same question.
 *
 * *Which number is a code* is `findCodeInMessage`'s job, and it is about wording.
 *
 * *Which code is yours* is this function's job, and it is about the sender. With
 * one code in the inbox the distinction never comes up. With five — one per
 * service you are signed in to, which is the ordinary state of an inbox during a
 * busy afternoon — it is the whole problem, and the best-written mail is not
 * necessarily the one for the page you are looking at.
 *
 * So the sender decides first:
 *
 *   - a message tied to this site by sender, subject or body is preferred;
 *   - once any message is tied to this site, messages identifiably from *other*
 *     companies are removed from consideration entirely rather than outscored,
 *     because a code from another service is never the right answer here;
 *   - messages from senders that name nobody — a relay, a channel-named domain —
 *     stay in, penalised, because they might well be from this site.
 *
 * Age still breaks ties at half a point per minute, which inside a ten-minute
 * freshness window separates two equally-worded mails without letting a weak new
 * one beat a strong slightly-older one.
 *
 * `ambiguous` reports the case this cannot resolve: several codes, from several
 * different senders, none of which can be tied to the page. The manual path still
 * offers its best guess — you can see it and judge — but nothing should be typed
 * into a page unattended on that basis.
 *
 * @param {Array<{ id: string, from?: string, subject?: string, text?: string, receivedAt?: number }>} messages
 * @param {{ site?: string, now?: number, skipMessageIds?: Set<string> | string[] }} [options]
 * @returns {{ code: string, confidence: number, messageId: string, from: string, subject: string,
 *             senderSite: string, receivedAt: number, reasons: string[], siteMatch: boolean,
 *             ambiguous: boolean, alternatives: Array<object> } | null}
 */
export function findBestCode(messages, { site = '', now = Date.now(), skipMessageIds } = {}) {
  const skip = skipMessageIds instanceof Set ? skipMessageIds : new Set(skipMessageIds ?? []);

  const candidates = [];
  for (const message of messages ?? []) {
    if (!message || skip.has(message.id)) continue;
    const found = findCodeInMessage(message, { site });
    if (!found || found.score <= 0) continue;

    candidates.push({
      code: found.code,
      score: found.score,
      reasons: found.reasons,
      affinity: siteAffinity(message, site),
      messageId: message.id,
      from: message.from ?? '',
      subject: message.subject ?? '',
      senderSite: senderDomain(message.from ?? ''),
      receivedAt: message.receivedAt ?? now,
      ageMinutes: Math.max(0, (now - (message.receivedAt ?? now)) / 60000),
    });
  }
  if (candidates.length === 0) return null;

  const anyMatch = candidates.some((candidate) => candidate.affinity === AFFINITY.match);
  const pool = anyMatch
    ? candidates.filter((candidate) => candidate.affinity !== AFFINITY.other)
    : candidates;

  const ranked = pool
    .map((candidate) => ({
      ...candidate,
      adjusted:
        candidate.score -
        candidate.ageMinutes * 0.5 -
        (anyMatch && candidate.affinity !== AFFINITY.match ? OFF_SITE_PENALTY : 0),
    }))
    .sort((a, b) => b.adjusted - a.adjusted || a.code.length - b.code.length);

  const winner = ranked[0];

  // Everything else that was found, including the codes set aside as another
  // company's, newest first. The popup lists these as recent arrivals, which is
  // how you get at the right one when this picked wrong.
  const seen = new Set([winner.code]);
  const alternatives = [...candidates]
    .sort((a, b) => b.receivedAt - a.receivedAt)
    .filter((candidate) => {
      if (seen.has(candidate.code)) return false;
      seen.add(candidate.code);
      return true;
    })
    .slice(0, MAX_ALTERNATIVES)
    .map((candidate) => ({
      code: candidate.code,
      confidence: confidenceOf(candidate.score),
      messageId: candidate.messageId,
      from: candidate.from,
      subject: candidate.subject,
      senderSite: candidate.senderSite,
      receivedAt: candidate.receivedAt,
      siteMatch: candidate.affinity === AFFINITY.match,
    }));

  return {
    code: winner.code,
    confidence: confidenceOf(winner.score),
    messageId: winner.messageId,
    from: winner.from,
    subject: winner.subject,
    senderSite: winner.senderSite,
    receivedAt: winner.receivedAt,
    reasons: winner.reasons,
    siteMatch: winner.affinity === AFFINITY.match,
    // Distinct codes from distinct senders, and nothing tying any of them to the
    // page: a guess, however well scored. A claim about a site, so it needs one —
    // with no page to be wrong about, there is nothing here to be unsure of.
    ambiguous:
      Boolean(site) &&
      !anyMatch &&
      new Set(candidates.map((candidate) => candidate.code)).size > 1 &&
      new Set(candidates.map((candidate) => candidate.senderSite || candidate.from)).size > 1,
    alternatives,
  };
}

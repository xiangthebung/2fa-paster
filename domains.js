/**
 * Who sent this, and what site am I on?
 *
 * Deciding which of several codes belongs to the page in front of you is a
 * domain comparison, and every part of the extension that has an opinion about
 * it used to answer the question slightly differently. The service worker
 * reduced a tab URL to a registrable domain; the scorer did a substring test on
 * the sender; the popup pulled a display name out of a `From` header with its
 * own regex. Three answers to one question is how "it filled the wrong code"
 * becomes hard to reproduce.
 *
 * So all of it lives here: pure string work, no `chrome.*`, testable without a
 * browser, imported by the scorer, the worker and the popup alike.
 */

/**
 * Suffixes where the registrable domain is three labels, not two.
 *
 * An approximation of the public suffix list. It only has to be good enough to
 * tell "the mail came from the site I am signing in to" from "the mail came from
 * somewhere else", so the long tail is not worth shipping.
 */
const MULTI_LABEL_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'co.jp', 'ne.jp', 'or.jp', 'co.kr',
  'com.au', 'net.au', 'org.au', 'edu.au', 'co.nz', 'com.br', 'com.mx', 'com.ar',
  'co.in', 'co.za', 'com.sg', 'com.hk', 'com.tw', 'com.cn', 'co.il', 'com.tr', 'com.ua',
]);

/**
 * Bulk senders and transactional mail providers.
 *
 * A code that arrives from `sendgrid.net` says nothing about which service sent
 * it, so the domain must not be read as a brand — otherwise every service using
 * the same provider looks like the same sender, and none of them look like the
 * site you are on.
 */
const RELAY_DOMAINS = new Set([
  'sendgrid.net', 'amazonses.com', 'mailgun.org', 'mailgun.net', 'mailgunhq.com',
  'postmarkapp.com', 'mtasv.net', 'mandrillapp.com', 'sparkpostmail.com', 'sparkpost.com',
  'mailchimpapp.net', 'mcsv.net', 'rsgsv.net', 'mailjet.com', 'mailjet.net',
  'sendinblue.com', 'brevo.com', 'klaviyomail.com', 'customeriomail.com',
  'intercom-mail.com', 'zendesk.com', 'freshdesk.com', 'smtp2go.net', 'mailersend.net',
  'resend.dev', 'mailtrap.io', 'amazonaws.com', 'sendpulse.com', 'elasticemail.com',
]);

/**
 * Labels that are a mail subdomain rather than a brand.
 *
 * `noreply.example.com` reduces to `example.com` and is fine, but plenty of
 * services own a whole domain that names the channel instead of the company —
 * `accountprotection.net`, `email-service.io`. Treating those as a brand would
 * have the extension confidently deciding a code belongs to someone else.
 */
const GENERIC_LABELS = new Set([
  'mail', 'email', 'emails', 'mails', 'mailer', 'notify', 'notifications', 'notification',
  'noreply', 'no-reply', 'donotreply', 'account', 'accounts', 'accountprotection',
  'auth', 'authentication', 'identity', 'id', 'login', 'signin', 'secure', 'security',
  'app', 'apps', 'web', 'online', 'cloud', 'service', 'services', 'support', 'help',
  'info', 'team', 'alerts', 'alert', 'messages', 'messaging', 'sso', 'verify', 'otp',
]);

/** Below this, a label is too short to compare fuzzily without false matches. */
const MIN_FUZZY_LABEL = 4;

/**
 * "accounts.google.com" -> "google.com".
 *
 * @param {string} hostname
 * @returns {string} empty when there is nothing usable
 */
export function registrableDomain(hostname) {
  const labels = String(hostname ?? '')
    .trim()
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^www\./, '')
    .split('.')
    .filter(Boolean);
  if (labels.length === 0) return '';
  if (labels.length <= 2) return labels.join('.');
  const lastTwo = labels.slice(-2).join('.');
  return MULTI_LABEL_SUFFIXES.has(lastTwo) ? labels.slice(-3).join('.') : lastTwo;
}

/**
 * The registrable domain of a page.
 *
 * Web pages only. `chrome://extensions` parses as a URL with a hostname of
 * "extensions", and treating that as a site would have the extension deciding
 * that a code mail does or does not belong to it.
 *
 * @param {string} url
 * @returns {string} empty for anything that is not a web page
 */
export function siteOf(url) {
  try {
    const parsed = new URL(String(url ?? ''));
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    return registrableDomain(parsed.hostname);
  } catch {
    return '';
  }
}

/**
 * The address out of a `From` header.
 *
 * @param {string} from  e.g. `GitHub <noreply@github.com>`
 */
export function senderAddress(from) {
  const value = String(from ?? '').trim();
  const angled = value.match(/<([^>]+)>/);
  const address = (angled ? angled[1] : value).trim();
  return /^[^\s@]+@[^\s@]+$/.test(address) ? address.toLowerCase() : '';
}

/**
 * The registrable domain a message came from.
 *
 * @param {string} from
 * @returns {string} empty when the header has no parseable address
 */
export function senderDomain(from) {
  const address = senderAddress(from);
  if (!address) return '';
  return registrableDomain(address.slice(address.lastIndexOf('@') + 1));
}

/**
 * The name to show for a sender.
 *
 * `"GitHub" <noreply@github.com>` -> `GitHub`, and a bare address falls back to
 * its domain rather than to `noreply`, which is nobody.
 *
 * @param {string} from
 */
export function senderName(from) {
  const value = String(from ?? '').trim();
  const named = value.match(/^"?([^"<]+?)"?\s*</);
  if (named && named[1].trim()) return named[1].trim();
  const domain = senderDomain(value);
  if (domain) return domain;
  return value.replace(/[<>]/g, '').trim() || 'your inbox';
}

/**
 * The brand-carrying label of a domain. `github.com` -> `github`.
 *
 * @param {string} domain
 */
export function domainLabel(domain) {
  const labels = String(domain ?? '').toLowerCase().split('.').filter(Boolean);
  return labels.length > 1 ? labels[0] : (labels[0] ?? '');
}

/** @param {string} domain */
export function isRelayDomain(domain) {
  return RELAY_DOMAINS.has(String(domain ?? '').toLowerCase());
}

/**
 * Does this label name a company, or just a mail channel?
 *
 * @param {string} label
 */
export function isGenericLabel(label) {
  return GENERIC_LABELS.has(String(label ?? '').toLowerCase());
}

/**
 * Are these two labels plausibly the same brand?
 *
 * Containment rather than equality, because a service that mails from a
 * dedicated domain usually keeps its name in it: `githubmail`, `slack-mail`,
 * `notion-static`. Both sides have to be long enough that containment means
 * something.
 *
 * @param {string} a
 * @param {string} b
 */
export function relatedLabels(a, b) {
  const left = String(a ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const right = String(b ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!left || !right) return false;
  if (left === right) return true;
  if (left.length < MIN_FUZZY_LABEL || right.length < MIN_FUZZY_LABEL) return false;
  return left.includes(right) || right.includes(left);
}

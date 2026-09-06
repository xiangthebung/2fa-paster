/**
 * Settings arrive from storage, which means they can have been written by an
 * older version or edited by hand. Everything is clamped on the way out.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULTS, foldHistory, guideDue, normalizeOnboarding, normalizeSettings } from '../settings.js';

test('an empty store yields the defaults', () => {
  assert.deepEqual(normalizeSettings(), DEFAULTS);
  assert.deepEqual(normalizeSettings({}), DEFAULTS);
});

test('the defaults that need a permission or extra reading stay off', () => {
  // Both of these cost something the user has not agreed to yet: watching every
  // page needs a broad host grant, and the fallback scan reads more mail.
  assert.equal(DEFAULTS.autoFill, false);
  assert.equal(DEFAULTS.scanAllRecentMail, false);
});

test('a code that has been filled in is submitted and confirmed by default', () => {
  // Typing a code and then pressing the only button on the page is a step, not a
  // decision. The care lives in how it submits, not in whether — and the on-page
  // card is what keeps an automatic submit from looking like the page acting alone.
  assert.equal(DEFAULTS.autoSubmit, true);
  assert.equal(DEFAULTS.inPageToast, true);
  assert.equal(DEFAULTS.autoCopy, true);
});

test('recent codes are kept for a while, and the window is bounded', () => {
  assert.equal(DEFAULTS.historyMinutes, 30);
  assert.equal(normalizeSettings({ historyMinutes: -10 }).historyMinutes, 0);
  assert.equal(normalizeSettings({ historyMinutes: 99999 }).historyMinutes, 240);
  assert.equal(normalizeSettings({ historyMinutes: 'ages' }).historyMinutes, DEFAULTS.historyMinutes);
});

test('numbers are clamped to a sane range', () => {
  assert.equal(normalizeSettings({ freshnessMinutes: 0 }).freshnessMinutes, 1);
  assert.equal(normalizeSettings({ freshnessMinutes: 9999 }).freshnessMinutes, 120);
  assert.equal(normalizeSettings({ pollSeconds: 0 }).pollSeconds, 2);
  assert.equal(normalizeSettings({ pollSeconds: 500 }).pollSeconds, 30);
  assert.equal(normalizeSettings({ watchSeconds: 1 }).watchSeconds, 15);
  assert.equal(normalizeSettings({ watchSeconds: 10000 }).watchSeconds, 600);
  assert.equal(normalizeSettings({ clipboardClearSeconds: -5 }).clipboardClearSeconds, 0);
  assert.equal(normalizeSettings({ clipboardClearSeconds: 99999 }).clipboardClearSeconds, 600);
});

test('unusable numbers fall back to the default rather than to zero', () => {
  assert.equal(normalizeSettings({ freshnessMinutes: 'soon' }).freshnessMinutes, DEFAULTS.freshnessMinutes);
  assert.equal(normalizeSettings({ pollSeconds: NaN }).pollSeconds, DEFAULTS.pollSeconds);
  assert.equal(normalizeSettings({ watchSeconds: null }).watchSeconds, DEFAULTS.watchSeconds);
  assert.equal(normalizeSettings({ freshnessMinutes: 12.6 }).freshnessMinutes, 13);
});

test('booleans are coerced, not trusted', () => {
  assert.equal(normalizeSettings({ autoFill: 'yes' }).autoFill, true);
  assert.equal(normalizeSettings({ autoFill: 0 }).autoFill, false);
  assert.equal(normalizeSettings({ notify: undefined }).notify, DEFAULTS.notify);
});

test('extra search terms are collapsed and bounded', () => {
  assert.equal(normalizeSettings({ extraQuery: '  from:bank.example   ' }).extraQuery, 'from:bank.example');
  assert.equal(normalizeSettings({ extraQuery: 'a\n\nb' }).extraQuery, 'a b');
  assert.equal(normalizeSettings({ extraQuery: 'x'.repeat(500) }).extraQuery.length, 200);
});

test('unknown keys are dropped', () => {
  const settings = normalizeSettings({ nonsense: true, autoCopy: false });
  assert.equal('nonsense' in settings, false);
  assert.equal(settings.autoCopy, false);
  assert.deepEqual(Object.keys(settings).sort(), Object.keys(DEFAULTS).sort());
});

/* ------------------------------------------------------------------ *
 * The recent list
 * ------------------------------------------------------------------ */

const minutes = (n) => n * 60000;

/** @param {object} overrides */
const seen = (overrides) => ({
  code: '123456',
  messageId: 'm1',
  from: 'GitHub <noreply@github.com>',
  subject: 'Your code',
  senderSite: 'github.com',
  receivedAt: Date.now(),
  seenAt: Date.now(),
  confidence: 80,
  site: '',
  filled: false,
  submitted: false,
  ...overrides,
});

test('the recent list is newest first and bounded by the window', () => {
  const now = Date.now();
  const list = foldHistory(
    [],
    [
      seen({ code: '111111', messageId: 'a', receivedAt: now - minutes(2), seenAt: now - minutes(2) }),
      seen({ code: '222222', messageId: 'b', receivedAt: now - minutes(1), seenAt: now - minutes(1) }),
      seen({ code: '333333', messageId: 'c', receivedAt: now - minutes(90), seenAt: now - minutes(90) }),
    ],
    { keepMinutes: 30, now },
  );
  assert.deepEqual(list.map((entry) => entry.code), ['222222', '111111']);
});

test('asking for the same code twice is one row, not two', () => {
  const now = Date.now();
  const first = foldHistory([], [seen({ receivedAt: now, seenAt: now })], { keepMinutes: 30, now });
  const second = foldHistory(
    first,
    [seen({ receivedAt: now, seenAt: now, filled: true, submitted: true, site: 'github.com' })],
    { keepMinutes: 30, now },
  );
  assert.equal(second.length, 1);
  // What is known about a row only grows: a later copy-only sighting must not
  // erase the fact that it was filled and submitted.
  assert.equal(second[0].filled, true);
  assert.equal(second[0].submitted, true);
  assert.equal(second[0].site, 'github.com');

  const third = foldHistory(second, [seen({ receivedAt: now, seenAt: now })], { keepMinutes: 30, now });
  assert.equal(third[0].filled, true);
  assert.equal(third[0].site, 'github.com');
});

test('the same code from two different messages stays two rows', () => {
  const now = Date.now();
  const list = foldHistory(
    [],
    [seen({ messageId: 'a', receivedAt: now }), seen({ messageId: 'b', receivedAt: now - 1000 })],
    { keepMinutes: 30, now },
  );
  assert.equal(list.length, 2);
});

test('a window of zero keeps nothing at all', () => {
  assert.deepEqual(foldHistory([seen({})], [seen({ code: '999999' })], { keepMinutes: 0 }), []);
});

test('the list is capped even inside the window', () => {
  const now = Date.now();
  const additions = Array.from({ length: 40 }, (_, index) =>
    seen({ code: String(100000 + index), messageId: `m${index}`, receivedAt: now - index * 1000 }),
  );
  const list = foldHistory([], additions, { keepMinutes: 60, now });
  assert.equal(list.length, 12);
  assert.equal(list[0].code, '100000');
});

test('a row keeps where its mail can be opened and which mailbox it came from', () => {
  const now = Date.now();
  const first = foldHistory(
    [],
    [seen({ receivedAt: now, seenAt: now, link: 'https://mail.google.com/mail?message_id=1', account: 'a@gmail.com', siteMatch: true })],
    { keepMinutes: 30, now },
  );
  assert.equal(first[0].link, 'https://mail.google.com/mail?message_id=1');
  assert.equal(first[0].account, 'a@gmail.com');
  assert.equal(first[0].siteMatch, true);

  // A later sighting that does not carry them does not erase them.
  const second = foldHistory(first, [seen({ receivedAt: now, seenAt: now })], { keepMinutes: 30, now });
  assert.equal(second[0].link, 'https://mail.google.com/mail?message_id=1');
  assert.equal(second[0].account, 'a@gmail.com');
  assert.equal(second[0].siteMatch, true);

  // And a row that never had them is well-formed rather than undefined.
  const bare = foldHistory([], [seen({ receivedAt: now, seenAt: now })], { keepMinutes: 30, now });
  assert.equal(bare[0].link, '');
  assert.equal(bare[0].account, '');
  assert.equal(bare[0].siteMatch, false);
});

test('junk rows are dropped rather than stored half-formed', () => {
  const now = Date.now();
  const list = foldHistory([null, { code: '' }, 'nonsense'], [seen({ receivedAt: now })], {
    keepMinutes: 30,
    now,
  });
  assert.equal(list.length, 1);
  assert.equal(typeof list[0].confidence, 'number');
});

/* ------------------------------------------------------------------ *
 * The first-run tip
 * ------------------------------------------------------------------ */

test('the first-run tip is due after the first fill and never again once closed', () => {
  assert.deepEqual(normalizeOnboarding(undefined), { firstFillAt: 0, dismissedAt: 0 });
  // Two timestamps and nothing else, whatever storage held.
  assert.deepEqual(normalizeOnboarding({ firstFillAt: 'soon', dismissedAt: -5, code: '123456' }), {
    firstFillAt: 0,
    dismissedAt: 0,
  });
  assert.deepEqual(normalizeOnboarding({ firstFillAt: 1000.9, dismissedAt: '2000' }), { firstFillAt: 1000, dismissedAt: 2000 });

  assert.equal(guideDue(normalizeOnboarding({})), false, 'nothing has been filled yet');
  assert.equal(guideDue({ firstFillAt: 1000, dismissedAt: 0 }), true, 'a code went in and nobody has closed the tip');
  assert.equal(guideDue({ firstFillAt: 1000, dismissedAt: 2000 }), false, 'closed is closed');
  assert.equal(guideDue(null), false);
});

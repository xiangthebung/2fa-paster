/**
 * The scorer is the only part of this extension whose correctness cannot be
 * checked by looking at it, so the cases here are written from real code mail:
 * the code in the subject, the code alone in a big HTML element, the code sharing
 * a paragraph with an order number, and the various numbers that are never the
 * code but always in the message.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AFFINITY,
  AUTO_FILL_CONFIDENCE,
  findBestCode,
  findCodeInMessage,
  looksLikeCodeMail,
  matchesSite,
  normalizeText,
  siteAffinity,
} from '../code-finder.js';

/** @param {object} overrides */
const mail = (overrides) => ({
  id: 'm1',
  from: 'Example <noreply@example.com>',
  subject: '',
  text: '',
  receivedAt: Date.now(),
  ...overrides,
});

const codeIn = (message, options) => findCodeInMessage(mail(message), options)?.code ?? null;

test('the gate keeps non-code mail out entirely', () => {
  assert.equal(
    looksLikeCodeMail({ subject: 'Your order 5512347 has shipped', text: 'Tracking number 998877.' }),
    false,
  );
  assert.equal(
    codeIn({ subject: 'Your order 5512347 has shipped', text: 'Tracking number 998877 arrives 2026.' }),
    null,
  );
  assert.equal(looksLikeCodeMail({ subject: 'Your verification code', text: '' }), true);
});

test('a code in the subject line', () => {
  assert.equal(
    codeIn({
      subject: '123456 is your GitHub verification code',
      text: 'Your verification code for GitHub is 123456. It expires in 10 minutes.',
    }),
    '123456',
  );
});

test('a code in a sentence', () => {
  assert.equal(
    codeIn({
      subject: 'Verify your email',
      text: 'Your verification code is 847291. Do not share it with anyone.',
    }),
    '847291',
  );
});

test('a code alone on its line, as an HTML mail flattens to', () => {
  assert.equal(
    codeIn({
      subject: 'Confirm your email address',
      text: 'Confirm your email\nEnter this code to continue\n392014\nThis code expires in 10 minutes.',
    }),
    '392014',
  );
});

test('a four digit code', () => {
  assert.equal(
    codeIn({ subject: 'Your passcode', text: 'Your one-time passcode is 4821. Never share this code.' }),
    '4821',
  );
});

test('a code printed in two halves', () => {
  assert.equal(codeIn({ subject: 'Security code', text: 'Your security code is 123 456' }), '123456');
  assert.equal(codeIn({ subject: 'Security code', text: 'Your security code is 481-902' }), '481902');
});

test('an alphanumeric code, but only when it is labelled', () => {
  assert.equal(codeIn({ subject: 'Verify', text: 'Your verification code is A4B9K2' }), 'A4B9K2');
  // The same token with nothing calling it a code is not a candidate.
  assert.equal(codeIn({ subject: 'Sign-in code', text: 'Reference A4B9K2 was logged.' }), null);
});

test('the order number in the same paragraph is not the code', () => {
  assert.equal(
    codeIn({
      subject: 'Your security code',
      text: 'Order number 4471002. Your security code is 550129. Copyright 2026 Acme.',
    }),
    '550129',
  );
});

test('years, dates and times are never the code', () => {
  assert.equal(
    codeIn({
      subject: 'Verification code',
      text: 'Requested at 10:45 on 07/29/2026. Copyright 2025 Example. Code: 664401',
    }),
    '664401',
  );
});

test('a phone number in the footer is not the code', () => {
  assert.equal(
    codeIn({
      subject: 'Verify it is you',
      text: 'Your verification code is 220481. Questions? Call us at (555) 123-4567.',
    }),
    '220481',
  );
});

test('a long account number contributes nothing, not even a slice of itself', () => {
  const found = findCodeInMessage(
    mail({
      subject: 'Verification code',
      text: 'Account 123456789012 was accessed. Your verification code is 445566.',
    }),
  );
  assert.equal(found.code, '445566');
});

test('money and percentages are left alone', () => {
  assert.equal(
    codeIn({
      subject: 'Your security code',
      text: 'Balance $12,450 and 15% APR. Your security code is 730155.',
    }),
    '730155',
  );
});

test('zero-width characters inside the code are stripped, not treated as a break', () => {
  assert.equal(normalizeText('12\u200b3456'), '123456');
  assert.equal(
    codeIn({ subject: 'Verify', text: 'Your verification code is 12\u200b3456. Do not share it.' }),
    '123456',
  );
});

test('a repeat across subject and body counts in its favour', () => {
  const once = findCodeInMessage(mail({ subject: 'Sign-in code', text: 'Your sign-in code is 553311.' }));
  const twice = findCodeInMessage(
    mail({ subject: '553311 is your sign-in code', text: 'Your sign-in code is 553311.' }),
  );
  assert.ok(twice.score > once.score);
  assert.ok(twice.reasons.includes('repeated in the message'));
});

test('mail from the site you are signing in to wins a close race', () => {
  const now = Date.now();
  const messages = [
    mail({
      id: 'other',
      from: 'Acme <security@acme.com>',
      subject: 'Your Acme verification code',
      text: 'Your verification code is 111222.',
      receivedAt: now - 30000,
    }),
    mail({
      id: 'github',
      from: 'GitHub <noreply@github.com>',
      subject: 'Your GitHub verification code',
      text: 'Your verification code is 333444.',
      receivedAt: now - 40000,
    }),
  ];

  assert.equal(findBestCode(messages, { site: 'github.com', now }).code, '333444');
  assert.equal(findBestCode(messages, { site: 'acme.com', now }).code, '111222');
});

test('matchesSite reads the sender and the subject, and needs a real label', () => {
  assert.equal(matchesSite({ from: 'GitHub <noreply@github.com>' }, 'github.com'), true);
  assert.equal(matchesSite({ from: 'no-reply@sendgrid.net', subject: 'Your Github code' }, 'github.com'), true);
  assert.equal(matchesSite({ from: 'no-reply@sendgrid.net', subject: 'Your code' }, 'github.com'), false);
  assert.equal(matchesSite({ from: 'a@b.co' }, ''), false);
});

test('newer mail is preferred, but not enough to beat a much stronger match', () => {
  const now = Date.now();
  const strongOld = mail({
    id: 'old',
    subject: '246810 is your verification code',
    text: 'Your verification code is 246810. Do not share it. It expires in 10 minutes.',
    receivedAt: now - 4 * 60000,
  });
  const weakNew = mail({
    id: 'new',
    subject: 'Welcome',
    text: 'We logged your sign in. Reference 998812 for the code desk.',
    receivedAt: now - 5000,
  });

  assert.equal(findBestCode([weakNew, strongOld], { now }).code, '246810');

  // Two equally strong messages: the newer one is the one you just asked for.
  const newerStrong = mail({
    id: 'newer',
    subject: '135791 is your verification code',
    text: 'Your verification code is 135791. Do not share it. It expires in 10 minutes.',
    receivedAt: now - 10000,
  });
  assert.equal(findBestCode([strongOld, newerStrong], { now }).code, '135791');
});

test('messages already delivered can be skipped', () => {
  const now = Date.now();
  const messages = [
    mail({ id: 'used', subject: 'Your code', text: 'Your verification code is 111111.', receivedAt: now }),
    mail({ id: 'fresh', subject: 'Your code', text: 'Your verification code is 222222.', receivedAt: now - 1000 }),
  ];
  assert.equal(findBestCode(messages, { now, skipMessageIds: ['used'] }).code, '222222');
  assert.equal(findBestCode(messages, { now, skipMessageIds: new Set(['used', 'fresh']) }), null);
});

test('confidence separates a labelled code from an incidental number', () => {
  const now = Date.now();
  const clear = findBestCode(
    [
      mail({
        subject: 'Your verification code',
        text: 'Your verification code is 615243. Do not share this code with anyone.',
        receivedAt: now,
      }),
    ],
    { now },
  );
  assert.ok(
    clear.confidence >= AUTO_FILL_CONFIDENCE,
    `a plain code mail should clear the auto threshold, scored ${clear.confidence}`,
  );

  const vague = findBestCode(
    [
      mail({
        subject: 'Weekly summary',
        text: 'Your sign-in activity is below. Support code 884412 may be quoted if you need help.',
        receivedAt: now,
      }),
    ],
    { now },
  );
  assert.ok(
    !vague || vague.confidence < AUTO_FILL_CONFIDENCE,
    `an incidental number should stay below the auto threshold, scored ${vague?.confidence}`,
  );
});

test('confidence stays inside 1-100 and reasons are reported', () => {
  const found = findBestCode(
    [
      mail({
        from: 'GitHub <noreply@github.com>',
        subject: '123456 is your GitHub verification code',
        text: 'Your GitHub verification code is 123456. Do not share it. It expires in 10 minutes.',
      }),
    ],
    { site: 'github.com' },
  );
  assert.ok(found.confidence > 0 && found.confidence <= 100);
  assert.ok(found.reasons.length > 0);
  assert.ok(found.reasons.some((reason) => reason.includes('github.com')));
});

test('an empty batch and empty messages are handled', () => {
  assert.equal(findBestCode([]), null);
  assert.equal(findBestCode(undefined), null);
  assert.equal(findBestCode([null, mail({})]), null);
  assert.equal(findCodeInMessage({}), null);
});

test('normalizeText drops links and addresses but keeps line structure', () => {
  const text = normalizeText('Code below\nhttps://example.com/verify?t=99887766\nreply to a@b.com\n445566');
  assert.ok(!text.includes('99887766'));
  assert.ok(!text.includes('a@b.com'));
  assert.equal(text.split('\n').at(-1), '445566');
});

test('a tracking link cannot supply the code', () => {
  assert.equal(
    codeIn({
      subject: 'Your verification code',
      text: 'Open https://track.example.com/c/882291044 to continue. Your verification code is 907311.',
    }),
    '907311',
  );
});

/* ------------------------------------------------------------------ *
 * Which code is *this page's* code
 *
 * The cases below are the ordinary state of an inbox on a busy afternoon:
 * several services have mailed a code within a few minutes of each other, and
 * only one of them is for the page in front of you. Picking the best-written mail
 * is not good enough here — it has to be the right sender.
 * ------------------------------------------------------------------ */

/** A textbook code mail from a named sender. */
const codeMail = (id, brand, domain, code, agoMs = 0) =>
  mail({
    id,
    from: `${brand} <no-reply@${domain}>`,
    subject: `Your ${brand} verification code`,
    text: `Your ${brand} verification code is ${code}. It expires in 10 minutes. Do not share it.`,
    receivedAt: Date.now() - agoMs,
  });

test('with five services mailing at once, the one for this site is chosen', () => {
  const now = Date.now();
  const inbox = [
    codeMail('a', 'Acme', 'acme.com', '111111', 10000),
    codeMail('b', 'Dropbox', 'dropbox.com', '222222', 20000),
    codeMail('c', 'GitHub', 'github.com', '333333', 30000),
    codeMail('d', 'Stripe', 'stripe.com', '444444', 40000),
    codeMail('e', 'Notion', 'notion.so', '555555', 50000),
  ];

  for (const [site, expected] of [
    ['acme.com', '111111'],
    ['dropbox.com', '222222'],
    ['github.com', '333333'],
    ['stripe.com', '444444'],
    ['notion.so', '555555'],
  ]) {
    const found = findBestCode(inbox, { site, now });
    assert.equal(found.code, expected, `on ${site} it should pick ${expected}, picked ${found.code}`);
    assert.equal(found.siteMatch, true);
    assert.equal(found.ambiguous, false);
  }
});

test('a newer, better-written code from another company cannot win', () => {
  const now = Date.now();
  // The intruder has everything going for it except being the right sender: it is
  // newer, it repeats the code in the subject, and it is worded perfectly.
  const intruder = mail({
    id: 'intruder',
    from: 'Acme Security <security@acme.com>',
    subject: '999999 is your Acme verification code',
    text: 'Your Acme verification code is 999999. Do not share it. It expires in 10 minutes.',
    receivedAt: now,
  });
  const wanted = mail({
    id: 'wanted',
    from: 'GitHub <noreply@github.com>',
    subject: 'Sign-in code',
    text: 'Your sign-in code is 424242.',
    receivedAt: now - 60000,
  });

  const found = findBestCode([intruder, wanted], { site: 'github.com', now });
  assert.equal(found.code, '424242');
  assert.equal(found.siteMatch, true);
});

test('a code from a sender that names nobody still gets through', () => {
  const now = Date.now();
  // Relays are how a great many services actually send, so an unrecognisable
  // sender must not be treated as somebody else's code.
  const viaRelay = mail({
    id: 'relay',
    from: 'Security <bounce@sendgrid.net>',
    subject: 'Your verification code',
    text: 'Your verification code is 616161. Do not share it.',
    receivedAt: now,
  });

  const found = findBestCode([viaRelay], { site: 'example-app.com', now });
  assert.equal(found.code, '616161');
  assert.equal(found.siteMatch, false);
  // One candidate is not a choice, so there is nothing ambiguous about it.
  assert.equal(found.ambiguous, false);
});

test('two unidentifiable senders is reported as ambiguous rather than guessed at', () => {
  const now = Date.now();
  const first = mail({
    id: 'one',
    from: 'Security <bounce@sendgrid.net>',
    subject: 'Your verification code',
    text: 'Your verification code is 717171. Do not share it.',
    receivedAt: now,
  });
  const second = mail({
    id: 'two',
    from: 'Verify <no-reply@amazonses.com>',
    subject: 'Your login code',
    text: 'Your login code is 818181. It expires in 10 minutes.',
    receivedAt: now - 5000,
  });

  const found = findBestCode([first, second], { site: 'example-app.com', now });
  assert.ok(found, 'the manual path should still get an answer to show');
  assert.equal(found.ambiguous, true, 'nothing ties either code to the page, so this is a guess');
  assert.equal(found.siteMatch, false);
});

test('a site match settles what would otherwise be ambiguous', () => {
  const now = Date.now();
  const relay = mail({
    id: 'relay',
    from: 'Security <bounce@sendgrid.net>',
    subject: 'Your verification code',
    text: 'Your verification code is 717171.',
    receivedAt: now,
  });
  const found = findBestCode([relay, codeMail('gh', 'GitHub', 'github.com', '333333', 30000)], {
    site: 'github.com',
    now,
  });
  assert.equal(found.code, '333333');
  assert.equal(found.ambiguous, false);
});

test('with no site to compare to, nothing is set aside', () => {
  const now = Date.now();
  const inbox = [
    codeMail('a', 'Acme', 'acme.com', '111111', 60000),
    codeMail('b', 'GitHub', 'github.com', '333333', 1000),
  ];
  // The keyboard shortcut on a page with no address still has to answer.
  const found = findBestCode(inbox, { now });
  assert.equal(found.code, '333333', 'the newest of two equally strong mails');
  assert.equal(found.ambiguous, false, 'ambiguity is only meaningful against a site');
});

test('the codes that were set aside are still reported, for the recent list', () => {
  const now = Date.now();
  const inbox = [
    codeMail('a', 'Acme', 'acme.com', '111111', 10000),
    codeMail('c', 'GitHub', 'github.com', '333333', 30000),
    codeMail('d', 'Stripe', 'stripe.com', '444444', 40000),
  ];
  const found = findBestCode(inbox, { site: 'github.com', now });
  assert.equal(found.code, '333333');

  const others = found.alternatives.map((entry) => entry.code);
  assert.deepEqual(others, ['111111', '444444'], 'newest first, and the winner is not repeated');
  assert.equal(found.alternatives[0].senderSite, 'acme.com');
  assert.equal(found.alternatives[0].siteMatch, false);
});

test('sender subdomains and dedicated mail domains still count as the site', () => {
  assert.equal(siteAffinity({ from: 'GitHub <noreply@email.github.com>' }, 'github.com'), AFFINITY.match);
  assert.equal(siteAffinity({ from: 'Slack <no-reply@slack-mail.com>' }, 'slack.com'), AFFINITY.match);
  assert.equal(siteAffinity({ from: 'Acme <s@acme.com>' }, 'github.com'), AFFINITY.other);
  assert.equal(siteAffinity({ from: 'Bounce <b@sendgrid.net>' }, 'github.com'), AFFINITY.unknown);
  // A domain that names the channel rather than a company proves nothing either.
  assert.equal(siteAffinity({ from: 'Security <s@accountprotection.net>' }, 'github.com'), AFFINITY.unknown);
  assert.equal(siteAffinity({ from: 'Acme <s@acme.com>' }, ''), AFFINITY.unknown);
});

test('the body naming the site outright is as good as the sender doing it', () => {
  assert.equal(
    siteAffinity(
      { from: 'Security <bounce@sendgrid.net>', subject: 'Your code', text: 'Signing in to github.com' },
      'github.com',
    ),
    AFFINITY.match,
  );
});

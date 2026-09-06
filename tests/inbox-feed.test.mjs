/**
 * The Atom inbox feed is what makes this extension need no setup, so the parser
 * for it is load-bearing. It is also hand-rolled — a service worker has no
 * DOMParser — which means the usual failure is a quietly empty result rather than
 * an exception.
 *
 * The fixtures are shaped like the real thing: Atom 0.3, no namespace prefix,
 * `<fullcount>`, `<issued>` rather than `<published>`, entity-encoded subjects,
 * and the account address only discoverable from the feed title.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CATEGORY_LABELS,
  CATEGORY_NAMES,
  FeedError,
  discoverAccounts,
  feedUrl,
  fetchCandidateEntries,
  fetchCategoryEntries,
  fetchInboxFeed,
  parseInboxFeed,
} from '../inbox-feed.js';
import { findBestCode } from '../code-finder.js';

/** @param {{ account?: string, entries?: string[], unread?: number }} options */
function feedXml({ account = 'me@example.com', entries = [], unread = entries.length } = {}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed version="0.3" xmlns="http://purl.org/atom/ns#">
<title>Gmail - Inbox for ${account}</title>
<tagline>New messages in your Gmail Inbox</tagline>
<fullcount>${unread}</fullcount>
<link rel="alternate" href="https://mail.google.com/mail" type="text/html" />
<modified>2026-07-29T12:00:00Z</modified>
${entries.join('\n')}
</feed>`;
}

/**
 * @param {{ subject: string, summary?: string, name?: string, email?: string,
 *           issued?: string, id?: string }} entry
 */
function entryXml({
  subject,
  summary = '',
  name = 'Example',
  email = 'noreply@example.com',
  issued = '2026-07-29T11:59:00Z',
  id = 'tag:gmail.google.com,2004:1838000000000000001',
}) {
  return `<entry>
<title>${subject}</title>
<summary>${summary}</summary>
<link rel="alternate" href="https://mail.google.com/mail?view=conv" type="text/html" />
<modified>${issued}</modified>
<issued>${issued}</issued>
<id>${id}</id>
<author><name>${name}</name><email>${email}</email></author>
</entry>`;
}

test('the feed url is per account slot', () => {
  assert.equal(feedUrl(0), 'https://mail.google.com/mail/u/0/feed/atom');
  assert.equal(feedUrl(2), 'https://mail.google.com/mail/u/2/feed/atom');
  assert.equal(feedUrl(-1), 'https://mail.google.com/mail/u/0/feed/atom');
  assert.equal(feedUrl(), 'https://mail.google.com/mail/u/0/feed/atom');
});

test('a feed parses into the shape the scorer wants', () => {
  const feed = parseInboxFeed(
    feedXml({
      account: 'someone@gmail.com',
      unread: 4,
      entries: [
        entryXml({
          subject: 'Your verification code',
          summary: 'Your verification code is 481920. Do not share it.',
          name: 'GitHub',
          email: 'noreply@github.com',
          id: 'tag:gmail.google.com,2004:1',
        }),
      ],
    }),
  );

  assert.equal(feed.account, 'someone@gmail.com');
  assert.equal(feed.unreadCount, 4);
  assert.equal(feed.entries.length, 1);

  const [entry] = feed.entries;
  assert.equal(entry.id, 'tag:gmail.google.com,2004:1');
  assert.equal(entry.from, 'GitHub <noreply@github.com>');
  assert.equal(entry.subject, 'Your verification code');
  assert.equal(entry.text, 'Your verification code is 481920. Do not share it.');
  assert.equal(entry.receivedAt, Date.parse('2026-07-29T11:59:00Z'));
});

test('entity-encoded subjects and snippets are decoded', () => {
  const feed = parseInboxFeed(
    feedXml({
      entries: [
        entryXml({
          subject: 'Acme &amp; Co: your code is 5&#53;1204',
          summary: 'Use &quot;551204&quot; to sign in &#8212; expires soon',
        }),
      ],
    }),
  );

  assert.equal(feed.entries[0].subject, 'Acme & Co: your code is 551204');
  assert.equal(feed.entries[0].text, 'Use "551204" to sign in — expires soon');
});

test('an empty or self-closing summary does not break the entry', () => {
  const withEmpty = parseInboxFeed(feedXml({ entries: [entryXml({ subject: '224466 is your code' })] }));
  assert.equal(withEmpty.entries[0].text, '');
  assert.equal(withEmpty.entries[0].subject, '224466 is your code');

  const selfClosing = parseInboxFeed(
    `<feed version="0.3"><title>Gmail - Inbox for a@b.com</title><fullcount>1</fullcount>
     <entry><title>Your code</title><summary/><issued>2026-07-29T11:00:00Z</issued>
     <id>tag:1</id><author><name>A</name><email>a@x.com</email></author></entry></feed>`,
  );
  assert.equal(selfClosing.entries[0].text, '');
  assert.equal(selfClosing.entries[0].subject, 'Your code');
});

test('multi-line snippets collapse to one line', () => {
  const feed = parseInboxFeed(
    feedXml({ entries: [entryXml({ subject: 'Code', summary: 'Your code is\n  774411\n  Thanks' })] }),
  );
  assert.equal(feed.entries[0].text, 'Your code is 774411 Thanks');
});

test('an entry with no id still gets a stable one', () => {
  const xml = feedXml({ entries: [entryXml({ subject: 'Your code 909090' })] }).replace(
    /<id>[^<]*<\/id>/,
    '',
  );
  const feed = parseInboxFeed(xml);
  assert.ok(feed.entries[0].id.includes('Your code 909090'));
});

test('an empty inbox is a valid feed, not an error', () => {
  const feed = parseInboxFeed(feedXml({ entries: [], unread: 0 }));
  assert.equal(feed.unreadCount, 0);
  assert.deepEqual(feed.entries, []);
  assert.equal(feed.account, 'me@example.com');
});

test('a login page instead of a feed is reported as signed out', () => {
  assert.throws(
    () => parseInboxFeed('<!DOCTYPE html><html><body>Sign in to continue</body></html>'),
    (error) => {
      assert.ok(error instanceof FeedError);
      assert.equal(error.kind, 'signed-out');
      return true;
    },
  );
  assert.throws(() => parseInboxFeed(''), FeedError);
});

test('a 401 is signed out rather than a generic failure', async () => {
  await assert.rejects(
    () => fetchInboxFeed({ fetchImpl: async () => ({ status: 401, ok: false }) }),
    (error) => {
      assert.equal(error.kind, 'signed-out');
      return true;
    },
  );
});

test('the request carries cookies and refuses the cache', async () => {
  let seen = null;
  await fetchInboxFeed({
    index: 1,
    fetchImpl: async (url, init) => {
      seen = { url, init };
      return { ok: true, status: 200, text: async () => feedXml({ account: 'second@gmail.com' }) };
    },
  });

  assert.equal(seen.url, 'https://mail.google.com/mail/u/1/feed/atom');
  // Without credentials Gmail cannot tell who is asking, which is the whole
  // mechanism; without no-store a stale feed could miss the code that just came.
  assert.equal(seen.init.credentials, 'include');
  assert.equal(seen.init.cache, 'no-store');
});

test('a transport failure is reported as unreachable', async () => {
  await assert.rejects(
    () =>
      fetchInboxFeed({
        fetchImpl: async () => {
          throw new TypeError('Failed to fetch');
        },
      }),
    (error) => {
      assert.equal(error.kind, 'unreachable');
      return true;
    },
  );
});

/** A fetch stand-in that maps account slot to a feed body. */
function fakeAccounts(bySlot) {
  return async (url) => {
    const slot = Number(String(url).match(/\/u\/(\d+)\//)[1]);
    const body = bySlot[slot];
    if (!body) return { ok: false, status: 401 };
    return { ok: true, status: 200, text: async () => body };
  };
}

test('discovery finds every signed-in mailbox', async () => {
  const accounts = await discoverAccounts({
    fetchImpl: fakeAccounts({
      0: feedXml({ account: 'first@gmail.com', unread: 2 }),
      1: feedXml({ account: 'second@gmail.com', unread: 0 }),
    }),
  });

  assert.deepEqual(accounts, [
    { index: 0, account: 'first@gmail.com', unreadCount: 2 },
    { index: 1, account: 'second@gmail.com', unreadCount: 0 },
  ]);
});

test('discovery stops when a slot repeats the primary account', async () => {
  // Gmail answers a probe for a slot nobody is signed in to with the primary
  // account's feed, which would otherwise be discovered again and again.
  const primary = feedXml({ account: 'only@gmail.com' });
  const accounts = await discoverAccounts({
    fetchImpl: fakeAccounts({ 0: primary, 1: primary, 2: primary }),
  });
  assert.deepEqual(accounts, [{ index: 0, account: 'only@gmail.com', unreadCount: 0 }]);
});

test('discovery with nothing signed in raises rather than returning empty', async () => {
  await assert.rejects(
    () => discoverAccounts({ fetchImpl: fakeAccounts({}) }),
    (error) => {
      assert.equal(error.kind, 'signed-out');
      return true;
    },
  );
});

test('candidates are filtered to the freshness window and sorted newest first', async () => {
  const now = Date.parse('2026-07-29T12:00:00Z');
  const feed = feedXml({
    entries: [
      entryXml({ subject: 'Older code', issued: '2026-07-29T11:56:00Z', id: 'tag:a' }),
      entryXml({ subject: 'Newest code', issued: '2026-07-29T11:59:30Z', id: 'tag:b' }),
      entryXml({ subject: 'Stale code', issued: '2026-07-29T11:00:00Z', id: 'tag:c' }),
    ],
  });

  const entries = await fetchCandidateEntries({
    windowMinutes: 10,
    now,
    fetchImpl: fakeAccounts({ 0: feed }),
  });

  assert.deepEqual(
    entries.map((entry) => entry.subject),
    ['Newest code', 'Older code'],
  );
});

test('the same message reachable through two slots is only counted once', async () => {
  const now = Date.parse('2026-07-29T12:00:00Z');
  const feed = feedXml({ entries: [entryXml({ subject: 'Your code 313131', id: 'tag:same' })] });

  const entries = await fetchCandidateEntries({
    accounts: [{ index: 0 }, { index: 1 }],
    windowMinutes: 10,
    now,
    fetchImpl: fakeAccounts({ 0: feed, 1: feed }),
  });

  assert.equal(entries.length, 1);
});

test('one signed-out mailbox does not sink a read of the others', async () => {
  const now = Date.parse('2026-07-29T12:00:00Z');
  const entries = await fetchCandidateEntries({
    accounts: [{ index: 0 }, { index: 1 }],
    windowMinutes: 10,
    now,
    fetchImpl: fakeAccounts({
      1: feedXml({ entries: [entryXml({ subject: 'Your code 646464', id: 'tag:live' })] }),
    }),
  });

  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, 'tag:live');
});

test('every mailbox failing does raise', async () => {
  await assert.rejects(
    () =>
      fetchCandidateEntries({
        accounts: [{ index: 0 }, { index: 1 }],
        windowMinutes: 10,
        fetchImpl: fakeAccounts({}),
      }),
    FeedError,
  );
});

test('candidates say which mailbox they were read from', async () => {
  const now = Date.parse('2026-07-29T12:00:00Z');
  const entries = await fetchCandidateEntries({
    accounts: [{ index: 0 }, { index: 1 }],
    windowMinutes: 10,
    now,
    fetchImpl: fakeAccounts({
      0: feedXml({ account: 'first@gmail.com', entries: [entryXml({ subject: 'Your code 111111', id: 'tag:a' })] }),
      1: feedXml({ account: 'second@gmail.com', entries: [entryXml({ subject: 'Your code 222222', id: 'tag:b' })] }),
    }),
  });
  assert.deepEqual(
    entries.map((entry) => [entry.id, entry.account]),
    [
      ['tag:a', 'first@gmail.com'],
      ['tag:b', 'second@gmail.com'],
    ],
  );
});

test("each entry keeps Gmail's own address for the message", () => {
  const feed = parseInboxFeed(feedXml({ entries: [entryXml({ subject: 'Your code' })] }));
  assert.equal(feed.entries[0].link, 'https://mail.google.com/mail?view=conv');

  // The real feed entity-encodes the query string; it decodes.
  const encoded = feedXml({ entries: [entryXml({ subject: 'x' })] }).replace(
    'href="https://mail.google.com/mail?view=conv"',
    'href="https://mail.google.com/mail?account_id=1&amp;message_id=abc&amp;view=conv"',
  );
  assert.equal(
    parseInboxFeed(encoded).entries[0].link,
    'https://mail.google.com/mail?account_id=1&message_id=abc&view=conv',
  );

  // A link anywhere but Gmail is dropped rather than offered as "Open in Gmail".
  const elsewhere = feedXml({ entries: [entryXml({ subject: 'x' })] }).replace(
    'https://mail.google.com/mail?view=conv',
    'https://phishing.example/open',
  );
  assert.equal(parseInboxFeed(elsewhere).entries[0].link, '');
});

/* ------------------------------------------------------------------ *
 * The other inbox tabs
 * ------------------------------------------------------------------ */

test('a tab feed is the plain feed with the label appended', () => {
  assert.equal(
    feedUrl(0, '^sq_ig_i_notification'),
    'https://mail.google.com/mail/u/0/feed/atom/^sq_ig_i_notification',
  );
  assert.equal(feedUrl(2, '^sq_ig_i_promo'), 'https://mail.google.com/mail/u/2/feed/atom/^sq_ig_i_promo');
  assert.equal(feedUrl(1, ''), 'https://mail.google.com/mail/u/1/feed/atom');
  // Primary is what the plain feed already returned, so it is not in the list;
  // and every label has a name the popup can print.
  assert.ok(!CATEGORY_LABELS.some((label) => /personal/.test(label)));
  for (const label of CATEGORY_LABELS) assert.ok(CATEGORY_NAMES[label], `${label} has no on-screen name`);
});

test('the other tabs are read after Primary, and a tab that is not there is not an error', async () => {
  const now = Date.parse('2026-07-29T12:00:00Z');
  const asked = [];
  const entries = await fetchCategoryEntries({
    windowMinutes: 10,
    now,
    fetchImpl: async (url) => {
      asked.push(String(url));
      const label = String(url).split('/feed/atom/')[1] ?? '';
      // Updates has the code; Promotions does not exist on this account;
      // Social answers with a login page; Forums answers 401.
      if (label === '^sq_ig_i_notification') {
        return {
          ok: true,
          status: 200,
          text: async () => feedXml({ entries: [entryXml({ subject: 'Your code 313131', id: 'tag:updates' })] }),
        };
      }
      if (label === '^sq_ig_i_promo') return { ok: false, status: 404 };
      if (label === '^sq_ig_i_social') {
        return { ok: true, status: 200, text: async () => '<!DOCTYPE html><html><body>Sign in</body></html>' };
      }
      return { ok: false, status: 401 };
    },
  });
  assert.deepEqual(entries.map((entry) => entry.id), ['tag:updates']);
  assert.deepEqual(asked, CATEGORY_LABELS.map((label) => feedUrl(0, label)));
});

test('a message filed under two tabs is one candidate', async () => {
  const now = Date.parse('2026-07-29T12:00:00Z');
  const same = feedXml({ entries: [entryXml({ subject: 'Your code 424242', id: 'tag:same' })] });
  const entries = await fetchCategoryEntries({
    windowMinutes: 10,
    now,
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => same }),
  });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].account, 'me@example.com');
});

test('every tab failing is an empty answer, never an error', async () => {
  const entries = await fetchCategoryEntries({
    accounts: [{ index: 0 }, { index: 1 }],
    windowMinutes: 10,
    fetchImpl: async () => ({ ok: false, status: 404 }),
  });
  assert.deepEqual(entries, []);

  const offline = await fetchCategoryEntries({
    windowMinutes: 10,
    fetchImpl: async () => {
      throw new TypeError('Failed to fetch');
    },
  });
  assert.deepEqual(offline, []);
});

test('a real-shaped feed yields the code, end to end', async () => {
  const now = Date.parse('2026-07-29T12:00:00Z');
  const entries = await fetchCandidateEntries({
    windowMinutes: 10,
    now,
    fetchImpl: fakeAccounts({
      0: feedXml({
        account: 'me@gmail.com',
        entries: [
          entryXml({
            subject: 'Sign-in attempt blocked',
            summary: 'We noticed a new sign-in to your account on 29 July 2026 at 11:58.',
            name: 'Acme Security',
            email: 'alerts@acme.com',
            issued: '2026-07-29T11:58:00Z',
            id: 'tag:noise',
          }),
          entryXml({
            subject: '739104 is your GitHub verification code',
            summary: 'Your verification code is 739104. Do not share this code with anyone.',
            name: 'GitHub',
            email: 'noreply@github.com',
            issued: '2026-07-29T11:59:40Z',
            id: 'tag:real',
          }),
        ],
      }),
    }),
  });

  const found = findBestCode(entries, { site: 'github.com', now });
  assert.equal(found.code, '739104');
  assert.equal(found.messageId, 'tag:real');
  assert.ok(found.confidence >= 55, `expected an auto-fillable confidence, got ${found.confidence}`);
});

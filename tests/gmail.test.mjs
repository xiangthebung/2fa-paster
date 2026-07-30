/**
 * MIME handling and request shaping.
 *
 * These are the failures that look like success: a body that decodes to an empty
 * string, a UTF-8 pound sign that arrives as two characters of noise, or a search
 * that quietly returns a message from yesterday. None of them throw.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GmailError,
  buildQuery,
  collectParts,
  decodeBase64Url,
  fetchCandidateMessages,
  header,
  normalizeMessage,
} from '../gmail.js';

const b64 = (value) => Buffer.from(value, 'utf8').toString('base64url');

test('base64url bodies decode, including non-ASCII', () => {
  assert.equal(decodeBase64Url(b64('Your code is 123456')), 'Your code is 123456');
  assert.equal(decodeBase64Url(b64('Café — £5 · 日本語')), 'Café — £5 · 日本語');
  assert.equal(decodeBase64Url(''), '');
  assert.equal(decodeBase64Url(undefined), '');
});

test('base64url decoding tolerates missing padding and rubbish', () => {
  // "abc" is 3 bytes, so its base64 needs one "=" that Gmail omits.
  assert.equal(decodeBase64Url(Buffer.from('abc').toString('base64url')), 'abc');
  assert.equal(decodeBase64Url('!!!!not base64!!!!'), '');
});

test('headers are read case-insensitively', () => {
  const headers = [
    { name: 'From', value: 'GitHub <noreply@github.com>' },
    { name: 'SUBJECT', value: 'Your code' },
  ];
  assert.equal(header(headers, 'from'), 'GitHub <noreply@github.com>');
  assert.equal(header(headers, 'Subject'), 'Your code');
  assert.equal(header(headers, 'missing'), '');
  assert.equal(header(undefined, 'from'), '');
});

test('nested multipart payloads yield both alternatives', () => {
  const payload = {
    mimeType: 'multipart/mixed',
    parts: [
      {
        mimeType: 'multipart/alternative',
        parts: [
          { mimeType: 'text/plain', body: { data: b64('Plain: 123456') } },
          { mimeType: 'text/html', body: { data: b64('<p>HTML: <b>123456</b></p>') } },
        ],
      },
      { mimeType: 'application/pdf', body: { attachmentId: 'x' } },
    ],
  };

  const { plain, html } = collectParts(payload);
  assert.equal(plain, 'Plain: 123456');
  assert.equal(html, 'HTML: 123456');
});

test('a single-part message still produces a body', () => {
  const { plain } = collectParts({ mimeType: 'text/plain', body: { data: b64('Code 445566') } });
  assert.equal(plain, 'Code 445566');
});

test('normalizeMessage flattens a message resource', () => {
  const message = normalizeMessage({
    id: 'abc123',
    internalDate: '1700000000000',
    snippet: 'Your code is 123456 &amp; expires soon',
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'From', value: 'GitHub <noreply@github.com>' },
        { name: 'Subject', value: '123456 is your code' },
      ],
      body: { data: b64('Your verification code is 123456.') },
    },
  });

  assert.equal(message.id, 'abc123');
  assert.equal(message.from, 'GitHub <noreply@github.com>');
  assert.equal(message.subject, '123456 is your code');
  assert.equal(message.receivedAt, 1700000000000);
  assert.ok(message.text.includes('123456'));
  assert.equal(message.snippet, 'Your code is 123456 & expires soon');
});

test('a message with no readable parts falls back to the snippet', () => {
  const message = normalizeMessage({
    id: 'only-snippet',
    internalDate: '1700000000000',
    snippet: 'Your code is 998877',
    payload: { mimeType: 'multipart/mixed', headers: [], parts: [{ mimeType: 'image/png', body: { attachmentId: 'a' } }] },
  });
  assert.equal(message.text, 'Your code is 998877');
});

test('a message with no internalDate falls back to the Date header', () => {
  const message = normalizeMessage({
    id: 'dated',
    payload: { headers: [{ name: 'Date', value: 'Tue, 14 Nov 2023 22:13:20 +0000' }] },
  });
  assert.equal(message.receivedAt, Date.parse('Tue, 14 Nov 2023 22:13:20 +0000'));
});

test('the query narrows by date and never reads spam, trash, drafts or sent mail', () => {
  const query = buildQuery();
  assert.match(query, /newer_than:1d/);
  for (const excluded of ['-in:spam', '-in:trash', '-in:drafts', '-in:sent', '-in:chats']) {
    assert.ok(query.includes(excluded), `expected ${excluded} in the query`);
  }
  assert.match(query, /verification code/);
});

test('the broad query drops the keyword clause but keeps the exclusions', () => {
  const broad = buildQuery({ broad: true });
  assert.ok(!broad.includes('verification code'));
  assert.match(broad, /-in:spam/);
  assert.match(broad, /newer_than:1d/);
});

test('extra search terms are appended', () => {
  assert.match(buildQuery({ extraQuery: 'from:bank.example' }), /from:bank\.example$/);
  assert.equal(buildQuery({ extraQuery: '   ' }).endsWith(')'), true);
});

/**
 * A fetch stand-in that answers the two endpoints this module uses.
 *
 * @param {{ ids: string[], messages: Record<string, object>, onList?: (url: URL) => void }} plan
 */
function fakeFetch({ ids, messages, onList }) {
  return async (url) => {
    const target = new URL(url);
    if (target.pathname.endsWith('/messages')) {
      onList?.(target);
      return { ok: true, json: async () => ({ messages: ids.map((id) => ({ id })) }) };
    }
    const id = decodeURIComponent(target.pathname.split('/').pop());
    return { ok: true, json: async () => messages[id] };
  };
}

const codeMessage = (id, receivedAt, code) => ({
  id,
  internalDate: String(receivedAt),
  snippet: '',
  payload: {
    mimeType: 'text/plain',
    headers: [{ name: 'Subject', value: 'Your verification code' }],
    body: { data: b64(`Your verification code is ${code}.`) },
  },
});

test('candidates are filtered to the freshness window and sorted newest first', async () => {
  const now = 1_700_000_000_000;
  const messages = {
    fresh: codeMessage('fresh', now - 60000, '111111'),
    fresher: codeMessage('fresher', now - 10000, '222222'),
    stale: codeMessage('stale', now - 45 * 60000, '333333'),
  };

  const found = await fetchCandidateMessages({
    token: 'test-token',
    windowMinutes: 10,
    now,
    fetchImpl: fakeFetch({ ids: ['fresh', 'fresher', 'stale'], messages }),
  });

  assert.deepEqual(
    found.map((message) => message.id),
    ['fresher', 'fresh'],
  );
});

test('the search passes the query and the result cap to Gmail', async () => {
  let seen = null;
  await fetchCandidateMessages({
    token: 'test-token',
    windowMinutes: 10,
    max: 7,
    extraQuery: 'from:bank.example',
    fetchImpl: fakeFetch({ ids: [], messages: {}, onList: (url) => (seen = url) }),
  });

  assert.equal(seen.searchParams.get('maxResults'), '7');
  assert.match(seen.searchParams.get('q'), /from:bank\.example/);
});

test('an empty search does not go on to fetch messages', async () => {
  let gets = 0;
  const found = await fetchCandidateMessages({
    token: 'test-token',
    windowMinutes: 10,
    fetchImpl: async (url) => {
      const target = new URL(url);
      if (target.pathname.endsWith('/messages')) return { ok: true, json: async () => ({}) };
      gets += 1;
      return { ok: true, json: async () => ({}) };
    },
  });

  assert.deepEqual(found, []);
  assert.equal(gets, 0);
});

test('an API error surfaces its status and message', async () => {
  const failing = async () => ({
    ok: false,
    status: 401,
    json: async () => ({ error: { message: 'Invalid Credentials' } }),
  });

  await assert.rejects(
    () => fetchCandidateMessages({ token: 'stale', windowMinutes: 10, fetchImpl: failing }),
    (error) => {
      assert.ok(error instanceof GmailError);
      assert.equal(error.status, 401);
      assert.equal(error.isExpiredToken, true);
      assert.match(error.message, /Invalid Credentials/);
      return true;
    },
  );
});

test('a transport failure is reported as an unreachable Gmail', async () => {
  await assert.rejects(
    () =>
      fetchCandidateMessages({
        token: 'x',
        windowMinutes: 10,
        fetchImpl: async () => {
          throw new TypeError('Failed to fetch');
        },
      }),
    (error) => {
      assert.equal(error.status, 0);
      assert.match(error.message, /Could not reach Gmail/);
      return true;
    },
  );
});

test('rate limiting is distinguishable from other failures', () => {
  assert.equal(new GmailError(429, 'slow down').isRateLimited, true);
  assert.equal(new GmailError(403, 'quota').isRateLimited, true);
  assert.equal(new GmailError(500, 'boom').isRateLimited, false);
  assert.equal(new GmailError(500, 'boom').isExpiredToken, false);
});

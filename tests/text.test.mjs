/**
 * Entity decoding and HTML flattening, shared by both mail readers.
 *
 * Both failures here are silent: an entity left undecoded hides a code from the
 * digit patterns, and an HTML mail flattened with spaces instead of newlines
 * loses the "the code is alone on its line" signal that is often the only thing
 * marking it out.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { decodeEntities, htmlToText } from '../text.js';

test('entities decode, numeric ones included', () => {
  assert.equal(decodeEntities('&#49;&#50;&#51;&#52;&#53;&#54;'), '123456');
  assert.equal(decodeEntities('&#x34;&#x38;'), '48');
  assert.equal(decodeEntities('Tom &amp; Jerry&nbsp;said &quot;hi&quot;'), 'Tom & Jerry said "hi"');
  // Zero-width joiners used to break up a code disappear rather than becoming text.
  assert.equal(decodeEntities('12&zwnj;3456'), '123456');
  // An entity that is not recognised is left as written rather than dropped.
  assert.equal(decodeEntities('&unknownthing;'), '&unknownthing;');
  assert.equal(decodeEntities(undefined), '');
});

test('an out-of-range numeric entity is dropped, not thrown on', () => {
  assert.equal(decodeEntities('a&#1114112;b'), 'ab');
  assert.equal(decodeEntities('a&#x110000;b'), 'ab');
});

test('HTML flattens with block tags as line breaks', () => {
  assert.equal(htmlToText('<div>Your code</div><div><strong>123456</strong></div>'), 'Your code\n123456');
  assert.equal(htmlToText('one<br>two'), 'one\ntwo');
  assert.equal(htmlToText('<td>A</td><td>551122</td>'), 'A\n551122');
  assert.equal(htmlToText(''), '');
});

test('scripts, styles and image alt text are removed before flattening', () => {
  const html =
    '<html><head><style>.a{content:"999999"}</style></head><body>' +
    '<script>var code = "888888";</script>' +
    '<img src="x.png" alt="777777">' +
    '<!-- 666666 -->' +
    '<p>Your code is 123456</p></body></html>';
  const text = htmlToText(html);
  assert.ok(!text.includes('999999'), 'CSS should not reach the scorer');
  assert.ok(!text.includes('888888'), 'script bodies should not reach the scorer');
  assert.ok(!text.includes('777777'), 'alt text should not reach the scorer');
  assert.ok(!text.includes('666666'), 'comments should not reach the scorer');
  assert.ok(text.includes('123456'));
});

test('a code in its own big element ends up alone on a line', () => {
  // This is the shape that matters: the scorer's isolation bonus depends on it.
  const text = htmlToText(
    '<table><tr><td><p>Enter this code to continue</p></td></tr>' +
      '<tr><td><h1 style="font-size:40px">392014</h1></td></tr></table>',
  );
  assert.ok(text.split('\n').includes('392014'), `expected 392014 on its own line, got ${JSON.stringify(text)}`);
});

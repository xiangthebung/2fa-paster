/**
 * Turning mail into plain text.
 *
 * Shared by both ways of reading Gmail: the Atom inbox feed, whose subjects and
 * snippets arrive entity-encoded, and the Gmail API, whose parts arrive as whole
 * HTML documents. Both end up feeding the same scorer, so both have to flatten to
 * text the same way.
 */

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  zwnj: '',
  zwj: '',
  shy: '',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  rsquo: '\u2019',
  lsquo: '\u2018',
  rdquo: '\u201d',
  ldquo: '\u201c',
};

function safeCodePoint(code) {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

/**
 * Decode the entities that survive into subjects, snippets and HTML bodies.
 *
 * @param {string} value
 * @returns {string}
 */
export function decodeEntities(value) {
  return String(value ?? '')
    // Numeric entities matter more than they look: a sender that writes the code
    // as &#49;&#50;&#51; is otherwise invisible to a digit pattern.
    .replace(/&#(\d+);/g, (_match, code) => safeCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex) => safeCodePoint(Number.parseInt(hex, 16)))
    .replace(/&([a-z]+);/gi, (match, name) => {
      const replacement = NAMED_ENTITIES[name.toLowerCase()];
      return replacement === undefined ? match : replacement;
    });
}

/**
 * Flatten an HTML mail part to text.
 *
 * Block-level tags become newlines rather than spaces, which is what lets the
 * scorer notice that a code sits on a line of its own — in an HTML mail that is
 * usually the only thing marking it out as special.
 *
 * @param {string} html
 * @returns {string}
 */
export function htmlToText(html) {
  return decodeEntities(
    String(html ?? '')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(script|style|head|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      // Alt text is not body copy, and it is a common home for stray numbers.
      .replace(/<img\b[^>]*>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|tr|td|th|li|h[1-6]|table|section|article|blockquote)\s*>/gi, '\n')
      .replace(/<(p|div|tr|li|h[1-6]|table|section|article|blockquote)\b[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

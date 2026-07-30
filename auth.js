/**
 * Google sign-in, via chrome.identity.
 *
 * Chrome owns the token: it prompts, caches, and refreshes it, so there is no
 * refresh token to store and nothing sensitive kept by the extension. The whole
 * surface is "give me a token" and "throw it away".
 *
 * The error handling is more than usual because the first run of this extension
 * fails in several distinct ways, and they need different advice. "You have not
 * created an OAuth client yet" and "you dismissed the consent screen" both
 * arrive as a generic runtime error, and telling them apart is the difference
 * between a useful setup page and a shrug.
 */

const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';

/** @typedef {'not-configured' | 'needs-consent' | 'no-account' | 'bad-client' | 'offline' | 'unknown'} AuthErrorKind */

export class AuthError extends Error {
  /** @param {AuthErrorKind} kind @param {string} message */
  constructor(kind, message, cause) {
    super(message);
    this.name = 'AuthError';
    this.kind = kind;
    this.cause = cause;
  }
}

/**
 * True once manifest.json carries a real client ID.
 *
 * The committed manifest holds a placeholder; the build swaps in the real value
 * from a git-ignored file. Checking for the placeholder means the extension can
 * explain itself instead of surfacing Chrome's "bad client id" error.
 */
export function isConfigured() {
  const clientId = chrome.runtime.getManifest().oauth2?.client_id ?? '';
  return clientId.endsWith('.apps.googleusercontent.com') && !clientId.startsWith('REPLACE_WITH');
}

/** The scopes the manifest asks for, for display on the setup page. */
export function requestedScopes() {
  return chrome.runtime.getManifest().oauth2?.scopes ?? [SCOPE];
}

/** Chrome's messages are not user-facing, but they are specific enough to route on. */
function classify(message) {
  const text = String(message ?? '').toLowerCase();
  if (text.includes('bad client id') || text.includes('invalid client')) {
    return new AuthError(
      'bad-client',
      'Google did not recognise this extension. The OAuth client ID and the extension ID ' +
        'have to match — open the setup page to check them.',
      message,
    );
  }
  if (text.includes('not signed in') || text.includes('no accounts')) {
    return new AuthError('no-account', 'No Google account is signed in to this Chrome profile.', message);
  }
  if (
    text.includes('not granted') ||
    text.includes('revoked') ||
    text.includes('user interaction required') ||
    text.includes('user cancelled') ||
    text.includes('user canceled') ||
    text.includes('access denied')
  ) {
    return new AuthError('needs-consent', 'Access to Gmail has not been granted yet.', message);
  }
  if (text.includes('network')) {
    return new AuthError('offline', 'Could not reach Google. Check your connection.', message);
  }
  return new AuthError('unknown', message ? `Google sign-in failed: ${message}` : 'Google sign-in failed.', message);
}

/**
 * An OAuth access token for the Gmail scope.
 *
 * @param {{ interactive?: boolean }} [options]
 *   `interactive: false` never shows UI, so it is what background work should
 *   use — it fails cleanly instead of throwing a consent window at someone who
 *   is in the middle of something else.
 * @returns {Promise<string>}
 */
export function getToken({ interactive = false } = {}) {
  if (!isConfigured()) {
    throw new AuthError(
      'not-configured',
      'This extension has no Google OAuth client ID yet. Open the setup page to add one.',
    );
  }

  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (result) => {
      if (chrome.runtime.lastError) {
        reject(classify(chrome.runtime.lastError.message));
        return;
      }
      // Chrome 105 and later resolve to an object; older builds hand back a
      // bare string. Accept both rather than depending on the shape.
      const token = typeof result === 'string' ? result : result?.token;
      if (!token) {
        reject(new AuthError('needs-consent', 'Google did not return a token.'));
        return;
      }
      resolve(token);
    });
  });
}

/**
 * Drop one token from Chrome's cache.
 *
 * Called when Gmail answers 401: the cached token has been revoked or has
 * expired early, and the next `getToken` has to go and fetch a fresh one rather
 * than hand back the same dead string.
 *
 * @param {string} token
 */
export function forgetToken(token) {
  return new Promise((resolve) => {
    chrome.identity.removeCachedAuthToken({ token }, () => resolve());
  });
}

/**
 * Disconnect: revoke the grant at Google, then clear Chrome's cache.
 *
 * Revoking first matters. Clearing the local cache alone would leave the
 * extension still authorised, so the next sign-in would silently succeed without
 * a consent prompt — which is not what "disconnect" implies.
 */
export async function signOut() {
  let token = null;
  try {
    token = await getToken({ interactive: false });
  } catch {
    // Nothing granted, so there is nothing to revoke.
  }

  if (token) {
    try {
      await fetch(`${REVOKE_ENDPOINT}?token=${encodeURIComponent(token)}`, { method: 'POST' });
    } catch {
      // Offline. The local clear below still takes effect, and Google's grant
      // can be removed from the account's permissions page.
    }
    await forgetToken(token);
  }

  await new Promise((resolve) => chrome.identity.clearAllCachedAuthTokens(() => resolve()));
}

/** Is there a usable grant right now, without prompting? */
export async function isConnected() {
  if (!isConfigured()) return false;
  try {
    await getToken({ interactive: false });
    return true;
  } catch {
    return false;
  }
}

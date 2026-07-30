/**
 * Clipboard writer for the service worker.
 *
 * `navigator.clipboard.writeText` needs a focused document, and an offscreen
 * document is never focused, so this uses the old `execCommand('copy')` path
 * against a real textarea. That works with the `clipboardWrite` permission and
 * without a user gesture, which is the whole reason this file exists — the popup
 * can copy for itself, but a code that arrives while you are looking at the page
 * has no popup to do it.
 */

const staging = document.getElementById('staging');

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== 'offscreen-clipboard') return false;

  if (message.type === 'copy') {
    staging.value = String(message.text ?? '');
    staging.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    // Do not leave the code sitting in the DOM afterwards.
    staging.value = '';
    sendResponse({ ok });
    return false;
  }

  return false;
});

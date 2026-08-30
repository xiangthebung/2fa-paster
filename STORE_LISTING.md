# Chrome Web Store submission copy — 2FA Paster

This file is the paste-ready source for the Store dashboard. Keep it aligned with
`manifest.json`, `PRIVACY_POLICY.md`, `README.md` and the behaviour of the uploaded
ZIP. Every claim below was written from the code rather than from the other
documents, and each one names the file it came from so it can be checked again when
something changes.

Read **Before you submit** first. One decision about the OAuth scope has to be made
before any of this can go in, and it decides two paragraphs of the description.

## Name

**2FA Paster — codes from Gmail**

Verbatim from `manifest.json`, 29 characters. `short_name` is `2FA Paster`, which is
what the toolbar and the popup show. Version 1.2.0.

## Summary

Pulls the newest two-factor code out of your Gmail and drops it into the page, or onto your clipboard.

Verbatim from the manifest's `description`, 102 characters, inside the store's 132.
Keeping the two identical means the install prompt and the listing cannot disagree.

## Category

Productivity — "Workflow & Planning" where the dashboard uses the newer names. The
tempting alternative is Privacy & Security, and it would be the wrong one: this
moves a code that has already been sent to you, and makes no account safer than the
site made it. Filing it under security would be a claim the code cannot support.

## Single purpose

Take the one-time sign-in code that has just arrived in the user's own Gmail and put
it where the sign-in needs it: typed into the code box on the page in front of them,
or on their clipboard.

## Detailed description

A one-time code lands in your inbox and has to get from there into a box on a page,
usually within a few minutes, usually while you are switching windows to read it.
2FA Paster does the moving.

Open the popup or press Ctrl+Shift+2. It reads the mail that has just arrived, works
out which number in it is the code, types that into the code box on the page and —
unless you switch it off — presses the button that finishes the step. The code stays
on screen while it does, so you can see for yourself whether it picked the right one.

Two ways to read your mail, and the default needs no setup at all:

- **Inbox preview**, the default. Uses the Gmail session your browser is already
  signed in to. It sees unread inbox mail only, and of it only the sender, the
  subject, a snippet of the body and a time — which is where a one-time code almost
  always is, because that is what makes a code mail useful. No account, no consent
  screen, nothing to configure.
- **Full messages**, optional. Reads whole message bodies through the Gmail API, for
  the handful of recent messages that match a code search. It exists for the case
  the preview cannot serve: a code further into the message than the snippet reaches.

Picking the right number is most of the work. A code mail is mostly noise — dates,
order numbers, tracking ids, a year in the copyright line, a phone number in the
footer — and the code itself is usually a bare run of six digits. So candidates are
scored rather than grabbed:

- The message has to read like a code delivery before any number in it is considered.
- Where a number sits matters. "123456 is your code" in a subject line is worth a
  great deal; sitting alone on its own line in an HTML mail is worth almost as much;
  sitting next to "verification code" or "expires in 10 minutes" counts for more
  again.
- Shapes that are something else are thrown out before scoring: clock times, dates,
  money, percentages, dotted version numbers, phone numbers, fragments of longer
  numbers, and bare years unless something adjacent insists otherwise.
- Wording that labels a number as an identifier — "order number", "invoice #",
  "tracking number", "account ending" — counts heavily against anything just after it.
- With several codes in the inbox at once, the sender decides. A message tied to the
  site you are signing in to wins; messages that identifiably come from a *different*
  company are set aside rather than merely outscored; messages from a bulk sender
  that names nobody stay in, penalised, because they may well be from this site.
- The popup shows the score and the reasons under "Why this one", so a wrong answer
  is a legible wrong answer rather than a mystery.

What it will not fill, at all: a password field, a card number, a CVV or expiry, a
postcode, a phone number, a search box, a promo or coupon code. Those are
disqualified by name rather than outscored, because "security code" is what a CVV is
called on most checkout pages and outscoring is not a strong enough guarantee for
that.

What it will not press: anything reading as resend, cancel, dismiss, "try another
way", or as deleting, removing, deactivating, revoking, terminating, disconnecting or
signing out — in every inflection, so "Confirm account deletion" is caught as surely
as "Delete". Only buttons inside the same form as the field it just filled are
considered at all. "Resend code" is the case this exists for: it is a submit button
on plenty of real forms, it usually comes first, and pressing it invalidates the code
that was just typed in.

Also here:

- **Fill it in automatically**, off until you turn it on. The extension notices a
  code box appearing, watches your inbox for a couple of minutes and fills the code
  the moment it lands. This needs standing access to the sites you visit, so Chrome
  asks you for that separately, and switching it back off unregisters the script.
  Unattended filling is held to a higher bar than filling you asked for: the code has
  to score above a confidence threshold, it has to be one that arrived around the time
  the box appeared, it must not already have been used, and if several codes have
  arrived and nothing ties any of them to this site, nothing is typed in.
- **A confirmation card on the page** after a fill, drawn in a closed shadow root the
  page cannot read or restyle. It never repeats the code — the code is already in the
  box in front of you. It exists so an automatic fill never looks like the site acting
  on its own.
- **Recent codes**, for when two services mail you inside the same minute. Each row
  names its sender and where the code went; one click puts a different one into the
  page. The list is memory-only, is capped at 12, expires after your chosen window —
  30 minutes by default — and "do not keep a list" switches it off entirely.
- **Copy as well as fill**, on by default, so Ctrl+V works when a page refuses the
  typed value. An optional timer overwrites the clipboard afterwards.
- **A desktop notification** when a code is delivered. It shows the code only when
  the code could not be put into the page, because reading it off the notification is
  then the fastest way to finish; on success it says so without repeating it.
- Settings for the freshness window, how long the recent list lives, how long a watch
  runs, and extra Gmail search terms.

Free. There is no paid tier, no account, no trial, no payment processor and no
third-party code anywhere in the source — the extension has no dependencies at all.

Nothing is sent to the developer, because there is nowhere to send it. The extension
contacts three hosts and all three are Google's: `mail.google.com` for the inbox
feed, `gmail.googleapis.com` for the optional API reader, and `oauth2.googleapis.com`
to revoke a token when you disconnect. The content security policy in the manifest
names those three and nothing else, and a test in the repository fails if a fourth
appears. There is no analytics, no telemetry and no crash reporting.

Some things it cannot do, and does not attempt. Codes in spam are never read, by
either reader. `chrome://` pages, the Chrome Web Store and other extensions' pages
are off limits to every extension, so a code cannot be typed into one — the popup
says so and hands you the code instead. A page that renders its own code box in a
closed shadow root is invisible to it. Gmail is the only mailbox it reads. And the
inbox feed the default reader uses is a long-standing endpoint that Google could
withdraw; the API reader is where you would go if that happened.

## Permission justifications

Each of these is used by the shipped code, and the file that uses it is named.

- **`identity`** — the optional full-messages reader, and nothing else. `auth.js`
  calls `chrome.identity.getAuthToken` so Chrome, not this extension, obtains and
  caches the access token; `removeCachedAuthToken` drops one that Gmail answered 401
  for; `clearAllCachedAuthTokens` runs on **Disconnect**. The extension never sees a
  refresh token and stores no token of its own. Under the default reader this
  permission is never exercised.
- **`storage`** — three areas, for three lifetimes, all in `settings.js`.
  `chrome.storage.sync` holds preferences only: which reader, the freshness window,
  the toggles, the poll and watch durations, and an optional extra search term.
  `chrome.storage.local` holds the list of Gmail addresses signed in to this browser,
  so the popup does not re-probe five account slots every two seconds.
  `chrome.storage.session` — memory-backed, dropped when Chrome closes — holds the
  most recent code and what it was found in, the recent-codes list (12 maximum), the
  ids of the last 40 messages already delivered so an unattended fill cannot deliver
  the same code twice, and the current watch.
- **`activeTab`** — the manual path. Opening the popup or pressing the shortcut is
  the gesture that grants access to the current tab, which is what lets the worker
  inject the filler into it (`fillTab` in `background.js`) and ask it whether this
  page has a code box (`tabHasCodeField`, which is how the popup can say "Code box
  found" before you press anything). Access ends with the tab and does not extend to
  any other.
- **`scripting`** — two uses, both in `background.js`. `executeScript` injects
  `content.js` into the current tab on demand, so a page you never ask for a code on
  never runs any of this extension's script. `registerContentScripts` /
  `unregisterContentScripts` install and remove the always-on watcher for automatic
  filling, and `syncAutoRegistration` re-runs on startup and on every permission
  change so a revoked grant cannot leave a registration behind.
- **`alarms`** — three, all in `background.js`, all for work that has to survive the
  service worker being shut down between events. `watch-tick` restarts the inbox poll
  if Chrome stopped the worker mid-watch; `clear-clipboard` performs the optional
  clipboard overwrite; `clear-badge` clears the toolbar badge. A `setTimeout` inside
  an MV3 worker cannot be relied on to fire, which is the whole reason for this.
- **`notifications`** — one per delivery, and only while the user leaves "Show a
  desktop notification" on. `notify()` in `background.js` shows the code itself only
  when it could not be put into the page, because reading it off the notification is
  then the fastest way to finish; on a successful fill it reports the fill without
  repeating the code. The keyboard shortcut also uses one to say that nothing was
  found, since there is no popup open to say it in.
- **`offscreen`** — a service worker has no document, and the asynchronous Clipboard
  API needs a focused one. `offscreen.html` is a hidden page holding a single
  textarea; `offscreen.js` copies from it with `execCommand('copy')`. It is created
  on demand with reason `CLIPBOARD` and is what lets a code that arrives while you are
  looking at the page reach the clipboard with no popup open. The same path writes the
  empty string when the clipboard timer fires.
- **`clipboardWrite`** — the copy itself: the automatic copy that accompanies a
  delivery, the popup's **Copy** button, clicking the code, and the timed overwrite.
- **Host access to `https://mail.google.com/*`** — the default reader.
  `inbox-feed.js` fetches `/mail/u/<n>/feed/atom` with `credentials: 'include'`, so
  Gmail authenticates the request as the user already signed in to this browser. A
  credentialed cross-origin fetch from a service worker needs the host permission;
  this is why that work is not in a content script. Worth stating plainly, because a
  reviewer will notice it: Chrome grants access per host, not per URL, so this
  permission technically permits any request to Gmail's web endpoints carrying that
  session. The extension is confined to the feed by its own code — `inbox-feed.js` is
  the only file that builds a `mail.google.com` URL — not by anything Chrome enforces.
- **Host access to `https://gmail.googleapis.com/*`** — the optional API reader, in
  `gmail.js`: `users/me/messages` to list ids matching the code search,
  `users/me/messages/{id}` to read those messages, and `users/me/profile` once, to
  show which mailbox is connected.
- **Host access to `https://oauth2.googleapis.com/*`** — one endpoint, `/revoke`,
  POSTed by `signOut()` when the user chooses **Disconnect and forget**. Revoking
  before clearing Chrome's cache is deliberate: clearing the cache alone would leave
  the grant standing, so the next sign-in would succeed silently, which is not what
  "disconnect" means.
- **`optional_host_permissions` for `http://*/*` and `https://*/*`** — automatic
  filling only, and not requested at install. The user turns automatic filling on,
  Chrome asks for the grant at that moment, and `syncAutoRegistration` registers the
  content script only when the setting and the grant are both in place. Removing
  either unregisters it. The pattern is `http`/`https` rather than `<all_urls>` so it
  matches the registered script exactly and does not quietly include `file://` pages.
  Everything the script does with that access is finding a code box and filling it: it
  fetches nothing, and the only thing it sends anywhere is one message to this
  extension's own worker saying that this page has a code box.
- **OAuth scope `https://www.googleapis.com/auth/gmail.readonly`** — see the next
  section, which the reviewer will read first.

Two manifest entries that are not permissions and show no install warning:
`commands` registers Ctrl+Shift+2, handled by `chrome.commands.onCommand`; `action`
provides the popup, the toolbar badge and the tooltip. `minimum_chrome_version` is
116, which is where `chrome.runtime.getContexts` arrived — the call that stops two
callers creating two offscreen documents. There is no `tabs` permission: the worker
reads a tab's URL through `chrome.tabs.query` on the active tab, which `activeTab`
covers, and through `chrome.tabs.onUpdated` while automatic filling holds its own
grant.

## The `gmail.readonly` scope, in full

Google treats `gmail.readonly` as a restricted scope, so this section is the one that
decides the review. Everything in it is checkable in `gmail.js`, `code-finder.js` and
`settings.js`.

**When it is used at all.** Only when the user changes the reader to "Full messages"
on the options page. `DEFAULTS.source` in `settings.js` is the inbox feed, which uses
no OAuth, no token and no scope. A user who never opens that setting never grants
anything.

**Why the scope is this wide.** A one-time code is in the body of the message.
Google publishes no narrower read scope that includes message bodies —
`gmail.metadata` is headers only — so a narrower request is not available rather than
not preferred.

**What is read.** Not the mailbox. Each search is
`newer_than:1d -in:chats -in:drafts -in:sent -in:trash -in:spam`, plus a keyword
clause matching the vocabulary of a code delivery ("verification code", "one-time
passcode", "two-factor", and the rest). At most ten message ids come back, and only
those messages are fetched. The results are then filtered again on the device to the
user's freshness window, ten minutes by default, so mail that matched the search but
is too old to hold a usable code is discarded without being looked at further. One
setting, off by default and labelled where it is turned on, drops the keyword clause
— and only after a keyword search has already come back empty.

**What is extracted.** From each message: the sender, the subject, the internal
date, the id, and the decoded body text, capped at 16,000 characters. That text is
scanned by `code-finder.js` for a 4-to-8 character code and then dropped. The body is
held in a local variable for the length of one search and is never written anywhere.

**What is kept, and where.** In `chrome.storage.session`, which is memory-backed and
disappears when Chrome closes: the code, the id of the message it came from, the
sender and subject line of that message, its timestamp, the confidence and the
reasons, and the registrable domain of the page it was filled into. The recent list
holds the same fields for up to 12 codes for at most the user's window. The ids of
the last 40 delivered messages are kept so the same code is not filled twice. Nothing
from a message body is stored, ever. Nothing is written to disk.

**Where it goes.** Nowhere. There is no server, no analytics endpoint and no
third-party code. The only outbound requests in the entire extension are to the three
Google hosts named above, and the manifest's `connect-src` is limited to exactly
those three, so the extension's own pages and worker cannot reach anywhere else even
by mistake. The access token is held by Chrome's identity cache, not by this
extension.

**How the user withdraws it.** **Disconnect and forget** on the options page revokes
the grant at Google, clears Chrome's token cache, and clears the stored code, the
recent list and the used-message ids. Google Account → Third-party access revokes it
from Google's side. Removing the extension deletes its storage.

**Limited Use.** The data obtained through this scope is used only to provide the
user-facing feature described in the single purpose — finding a one-time code and
delivering it to the user — is not transferred to anyone, is not used for advertising
or any other purpose, is not used to determine creditworthiness, and is not read by
any human. There is no server to read it on.

## Published policy URLs

Paste these into the Developer Dashboard. They are live now — check them before
you submit rather than after, because a reviewer following a dead privacy link is
a rejection, and this collection has already shipped one extension whose in-product
legal links pointed at a host that did not exist.

```
Privacy policy   https://personal-website.xiangli3625.workers.dev/legal/two-factor-paster/privacy
```

The copy in this repository is the original. The portfolio site keeps a vendored
copy and its test suite diffs the two, so edit the file here and re-copy — never
the published page on its own.

## Privacy practices selections

Answer **Yes** to "Does this item collect or use user data?", then disclose these and
only these. The wording after each one is what to put in the justification box.

- **Personal communications — yes.** The extension reads the user's own email in
  order to find a one-time code in it. Under the default reader that is the sender,
  subject, snippet and time of unread inbox mail; under the optional reader it is the
  bodies of the few recent messages matching a code search. Message contents are used
  only to locate a code, are not transmitted anywhere, and are not stored.
- **Authentication information — yes.** The one-time code itself is a credential. It
  is held in memory-backed session storage until Chrome closes or the user clears it,
  written to the clipboard when the user asks or when the "also copy" setting is on,
  and typed into the page. It is never transmitted.
- **Personally identifiable information — yes.** Email addresses: the Gmail addresses
  signed in to this browser, kept in `chrome.storage.local` so the popup need not
  re-probe them, and the sender's name and address on a code mail, kept in session
  memory so the popup can say who a code came from. Neither is transmitted.
- **Website content — yes.** To find the code box the injected script reads each
  input's attributes and label, up to 400 characters of the text around it, and the
  text on the form's buttons. None of it is stored or transmitted; the only message
  the script sends is to this extension's own service worker, reporting that this page
  has a code box.
- **Web history — yes**, in the narrow sense only, and say which. The registrable
  domain of a page a code was filled into — `github.com`, not the address — is kept
  beside that code in session memory so the recent list can say where each code went.
  No URL, path, query string, page title or visit history is recorded, and no history
  of any kind is transmitted.

Answer **no** to health information, to financial and payment information — payment
fields are disqualified from filling by name in `content.js`, and there is no payment
code in the extension — to location, and to user activity: no clicks, keystrokes or
mouse movement are recorded anywhere. The extension dispatches events; it does not
collect them.

Select **No, I am not using remote code.** Every executable line is packaged in the
ZIP. There are no dependencies, no CDN, and nothing evaluated from a network response.

Certify all three: the data is not sold or transferred to third parties outside the
approved use cases, is not used or transferred for any purpose unrelated to the item's
single purpose, and is not used or transferred to determine creditworthiness or for
lending purposes. All three are true trivially, because nothing leaves the device.

Put this URL in the Privacy policy field:

https://github.com/xiangthebung/2fa-paster/blob/main/PRIVACY_POLICY.md

No homepage URL is declared in the manifest.

## Reviewer test instructions

Paste these into the Store's test-instructions field. They need a Gmail account
signed in to the review browser; no credentials of the developer's are needed, and
none should be supplied.

1. Install and pin 2FA Paster. No setup is required: the default reader uses whatever
   Gmail session the browser already has.
2. Sign in to Gmail in the same browser. The popup's header should show the address
   it can read.
3. From another account, send that mailbox a message reading "Your verification code
   is 123456". Leave it unread in the inbox — the default reader sees unread inbox
   mail only.
4. Open any page with a one-time-code field and click **Get my code**. The code is
   found, shown with its score under "Why this one", and typed into the field. With
   "Submit it too" on, the form's own submit button is pressed; a button reading
   "Resend code" or anything destructive is skipped.
5. To see the optional reader, open **Settings → How it reads your mail → Full
   messages**. What happens next depends on the OAuth decision below; if the shipped
   build carries the placeholder client ID, this path reports that the extension has
   no client ID rather than prompting for consent.
6. Nothing needs a network host other than Google's. The extension can be watched in
   DevTools to confirm it contacts only `mail.google.com`, `gmail.googleapis.com` and
   `oauth2.googleapis.com`.

## Required visual assets

Regenerate every file below with:

```
npm run store:assets
```

It builds first and then renders from `dist/` — the directory `npm run zip` packages
— by loading it into a real headless Chrome, the same one `npm run test:browser`
finds, or the one named by `CHROME_PATH`. No extra install: the script reuses the
repository's own browser harness rather than adding Playwright, because this project
has no dependencies to add one to. It measures every PNG it writes from the file's
own header and fails the run rather than emitting one that is the wrong size for the
store.

- Store icon: `dist/icons/icon-128.png` (`icons/icon-128.png` in the source tree).
- Screenshots, all exactly 1280×800:
  - `store-assets/01-code-1280x800.png` — the popup with a code in hand: the sender,
    that the mail came from the site being signed in to, and "Why this one" open on
    the score and the reasons.
  - `store-assets/02-fill-1280x800.png` — a sign-in page with the code typed into its
    field by `content.js` and the extension's own confirmation card in the corner.
  - `store-assets/03-guard-1280x800.png` — the same, on a form whose buttons include
    "Resend code" and "Remove this device". The page keeps its own record of which of
    its buttons were pressed, and the record is in the shot: Continue pressed, the
    other two not.
  - `store-assets/04-recent-1280x800.png` — three codes in the inbox at once, the
    recent list naming each sender, and the inbox watch running.
  - `store-assets/05-privacy-1280x800.png` — the options page's reader chooser and its
    "What this can see" panel, which is the answer to the question the scope raises.
- Small promotional tile: `store-assets/promo-440x280.png`, exactly 440×280.

Every pixel of extension interface in those files was rendered by the shipped build,
driven through its own interface: the popup and options panels are `dist/popup.html`
and `dist/options.html` laying themselves out, and the code in the sign-in pages was
put there by `dist/content.js` doing its real field-finding, filling and
button-choosing. What is not real is the mail. Three services that do not exist, on
the reserved `.example` domain, with invented codes; no mailbox is read and no
network request is made during the run. The service worker's reply is stubbed, and
nothing else is. The confidence figure and the "Why this one" reasons on screen are
computed by importing the shipped `code-finder.js` and running it over those invented
messages, so a picture cannot show a score the extension would not produce. Each
frame says as much in its own caption.

Nothing in the images depicts, names or imitates a real service, and no address,
client ID, token or real code appears in any of them.

## Before you submit

Two things in this repository assume the reader built the extension themselves, and a
Store user cannot.

**The OAuth client.** `manifest.json` ships
`REPLACE_WITH_YOUR_OAUTH_CLIENT_ID.apps.googleusercontent.com` on purpose, and the
build substitutes the real value from the git-ignored `client-id.local`. A published
ZIP therefore lands in one of two states, and the description above has to match:

- *Built with the placeholder.* The full-messages reader is inert for every Store
  user: `isConfigured()` is false, the popup and options page say the extension has no
  client ID, and the default reader carries the whole product. This is the honest,
  shippable option today. If you take it, cut the "Full messages, optional" bullet
  and the sentence about a code being further into the mail than the preview reaches
  from the description, and delete the `gmail.readonly` scope, the `identity`
  permission and the `gmail.googleapis.com` and `oauth2.googleapis.com` hosts from the
  manifest before you build — asking for a restricted scope the shipped build cannot
  use is the fastest way to fail a review.
- *Built with your own client ID.* Everyone who installs it uses your OAuth client,
  so that client needs its consent screen published and Google's verification for a
  restricted scope, including the third-party security assessment. `README.md` already
  says as much under Limits. Until that is done, users see an unverified-app warning
  and only accounts you list as testers can consent at all.

**The setup walkthrough in the options page** (`options.html`, step 5) tells the user
to create `client-id.local` and run `npm run build`. That is correct for someone
working from the source and impossible for someone who installed from the Store. If
the full-messages path ships enabled, that step has to be rewritten before submission;
if it ships disabled, the whole walkthrough should be hidden in the build rather than
shown to people who cannot follow it.

The same page's "What this can see" panel — the one in screenshot 05 — ends with
"the OAuth client belongs to your Google account, not to this extension's author".
That is true of a build made from source and false of a build carrying your client
ID, so it has to change in step with the decision above, along with the equivalent
paragraph in `PRIVACY_POLICY.md` under "Your Google credentials". Do not paste a
listing that says one thing while the settings page in its own screenshot says the
other.

Neither of these is a listing problem that copy can solve, which is why they are here
rather than in the description.

## Claims to avoid

Everything below is something the code cannot support. Keeping it out is not modesty;
each one is a refund request or a rejection waiting to happen.

- **Do not call it a security product, an authenticator, or a password manager.** It
  generates nothing and protects nothing. It moves a code that the site has already
  sent, and an account is exactly as safe afterwards as the site made it. It does not
  hold secrets, seeds or TOTP keys.
- **Do not say it works with any two-factor code.** It reads Gmail and nothing else.
  Codes delivered by SMS, by an authenticator app, by push, or to a different mail
  provider are invisible to it. Codes in spam are deliberately never read.
- **Do not promise it always finds the code.** The default reader sees a snippet, so a
  code buried further down the message is out of its reach — that limitation is the
  entire reason the API reader exists, and it should be described as the fix for a
  known gap rather than as a bonus.
- **Do not describe the scoring as certain.** It is a heuristic over wording and the
  sender. It reports how sure it is precisely because it can be wrong, and the recent
  list exists so the user can reach the code it did not pick.
- **Do not say it never fills the wrong field.** The strong claim it can make is the
  narrow one: fields that name a password, a card, a CVV, an expiry, a postcode, a
  phone number or a search box are disqualified outright, and anything else has to
  clear a threshold. That is a floor, not a guarantee.
- **Do not say it never presses the wrong button.** What it does is refuse to press
  anything reading as resend, cancel, or as destructive, in any inflection, and
  consider only buttons inside the same form as the field it filled. On a form with no
  such button it asks the form to submit, or presses Enter — and a page is free to
  have wired either of those to something surprising.
- **Do not say automatic filling is on.** It is off until the user turns it on, and it
  cannot do anything until Chrome's separate permission prompt is accepted.
- **Do not claim the inbox feed is a supported Google API.** It is a long-standing
  endpoint that Google's current documentation describes for Workspace accounts and
  says nothing about for the cookie-authenticated consumer case that in practice still
  works. It could be withdrawn without notice.
- **Do not say nothing ever leaves your device without qualification.** Nothing is
  sent to the developer, and there is no server to send it to — but the extension does
  make requests to Google to read the user's mail, and settings live in
  `chrome.storage.sync`, so Chrome's own sync carries the preferences between the
  user's signed-in Chrome installs. Say "no server of ours, no analytics, nothing to
  anyone but Google", and let the policy cover sync.
- **Do not say the clipboard is cleared.** The optional timer overwrites it with an
  empty string. Anything that read the clipboard in the meantime still has the code,
  and a clipboard-history tool may keep it regardless; Chrome will also not schedule
  an alarm sooner than 30 seconds, so a shorter setting is rounded up.
- **Do not say the desktop notification hides the code.** It hides it on a successful
  fill. When the fill failed it shows the code deliberately, and the operating system
  may keep that notification in a history that outlives the code.
- **Do not imply any affiliation with Google or Gmail.** It is a third-party tool that
  reads the user's own mailbox with the user's own permission. Do not use Gmail's
  logo, wordmark or colours in any asset.
- **Do not describe the confidence percentage as a probability.** It is a score
  rescaled for display, where roughly 140 points is a textbook case; a plain
  "Your verification code is 123456" from the site you are on reaches the top of the
  scale, which means "nothing about this is ambiguous", not "certainly correct".
- **Do not claim Firefox or Safari support.** Chromium only, Chrome 116 or later.

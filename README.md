# 2FA Paster

Gets the one-time code out of your Gmail and puts it where you need it, so you
stop switching to a mail tab, hunting for the newest message, and copying six
digits by hand.

Two ways to use it:

- **Ask for it.** Press the keyboard shortcut. It reads your recent mail, works out
  which number is the code, types it into the code box on the page you are on,
  submits the form, and copies the code as well — without opening anything. The
  toolbar button does the same job in two steps: it opens the popup, which shows
  you what it is about to do and has the same button on it.
- **Let it happen.** Turn on automatic filling. When a page shows a code box, it
  watches your inbox for a couple of minutes and the code lands in the box on its
  own, a second or two after the mail arrives.

Either way it says so on the page afterwards, and with several services mailing codes
at once it works out which one belongs to the site you are actually on.

## Install

```
npm run build
```

Then `chrome://extensions` → **Developer mode** → **Load unpacked** → pick
`dist/`.

That is the whole setup. If you are signed in to Gmail in this browser, it works
immediately — no accounts to create, no credentials to paste, no permission
prompts beyond the install.

---

## How it reads your mail

There are two readers. The default needs nothing from you; the other sees more.

### Inbox preview (default, no setup)

Gmail serves a per-account Atom feed of unread inbox mail at
`https://mail.google.com/mail/u/<n>/feed/atom`, authenticated by the ordinary
Gmail session cookie. With a host permission for `mail.google.com`, the extension
fetches it with `credentials: 'include'` and gets the sender, subject, a snippet
of the body, and a timestamp. This is the mechanism the long-standing Gmail
checker extensions use, and it is why they appear to need no setup either.

For one-time codes it is a good fit, in ways that are not obvious:

- The feed lists **only unread inbox mail**, so it is naturally scoped to messages
  that just arrived and have not been dealt with — which is exactly what a code is.
- It carries far less text than a full message, so there are fewer decoy numbers
  to score against.

Two honest limitations:

- **The snippet is not the body.** If a code sits further into the message than the
  preview reaches, and is not in the subject, this reader cannot see it. In
  practice that is rare, because a code mail's whole job is to put the code where
  you will see it first.
- **It is a legacy endpoint.** Google's current documentation describes the feed as
  a Workspace feature and says nothing about the cookie-authenticated consumer
  case that still works in practice. It could be withdrawn, which is why the other
  reader exists.

### Full messages (optional, one-time setup)

The Gmail API over OAuth, reading whole message bodies. It finds codes the preview
cannot reach and lets you narrow the search with Gmail query syntax. The tradeoff
is a Google Cloud OAuth client of your own — free and usually 5–10 minutes to set
up.

Switch between the two on the options page. The popup also offers the upgrade at
the moment it is actually relevant: after a search comes up empty.

---

## Setting up full messages

Only needed if you choose that reader. Google grants Gmail access to a registered
application rather than to extensions in general, so you register one in a Cloud
project you control. No third party sits in the middle. You never need to share or
enter your Google password, a verification code, or a client secret.

The options page is the best place to follow this process: it includes a
step-by-step animated walkthrough, direct links, your extension ID, success checks
for every step, replay controls, and a reduced-motion mode.

1. **Copy the extension ID.** Use the copy button on the options page. Google uses
   this exact 32-character value as the OAuth client's **Item ID**. An unpacked
   extension's ID can change if you move its project folder, so finish the setup
   before moving it — or see [Pinning the extension ID](#pinning-the-extension-id).

2. **Create a project and enable Gmail API.**
   [Create or select a project](https://console.cloud.google.com/projectcreate),
   open the [Gmail API](https://console.cloud.google.com/apis/library/gmail.googleapis.com),
   and click **Enable**. It is ready when that button changes to **Manage**.

3. **Configure consent, audience, and access.** Under **Google Auth platform →
   Branding**, click **Get started** if Google asks, enter `2FA Paster` as the app
   name, and use your own support and contact email. Under
   [Audience](https://console.cloud.google.com/auth/audience), choose **External**,
   leave the publishing status at **Testing**, and add the exact Gmail address you
   plan to connect under **Test users**. Then open
   [Data Access](https://console.cloud.google.com/auth/scopes), choose **Add or
   remove scopes**, select `https://www.googleapis.com/auth/gmail.readonly`, and
   save. This is the only Gmail scope the extension requests.

4. **Create the OAuth client.** Open
   [Google Auth platform → Clients](https://console.cloud.google.com/auth/clients),
   choose **Create client**, set the application type to **Chrome Extension**, name
   it `2FA Paster`, and paste the extension ID from step 1 into **Item ID**. Copy
   the generated client ID. It ends in `.apps.googleusercontent.com`; no client
   secret is required.

5. **Add the client ID and rebuild.** Create `client-id.local` beside
   `package.json` — not inside `dist` — and put only the client ID on one line,
   without quotes or JSON:

   ```text
   1234567890-abcdefghijklmnopqrstuvwxyz.apps.googleusercontent.com
   ```

   Then run:

   ```powershell
   npm run build
   ```

   The file is git-ignored. `GMAIL_CLIENT_ID` in the environment is also supported,
   and it wins over the file — worth knowing if you have exported it once and then
   wonder why editing `client-id.local` changes nothing.

6. **Reload and connect.** Open `chrome://extensions`, reload the 2FA Paster card
   that was loaded from `dist`, return to the options page, and click **Connect
   Gmail**. Select the same address you added as a test user. A personal app left
   in Testing may be described as unverified; continue only after confirming that
   the app name and Cloud project are the ones you just created. Setup is complete
   when the options page says **Connected**.

If **Connect Gmail** remains disabled, check that `client-id.local` is beside
`package.json`, contains one client ID with no quotes, the build succeeded, the
loaded extension points to `dist`, and the OAuth client's Item ID exactly matches
the extension ID shown on the options page.

### Pinning the extension ID

Only needed if you plan to move the project folder or load it on another machine,
since a moved unpacked extension gets a new ID and the OAuth client stops
matching.

Upload the zip from `npm run zip` to the Chrome Web Store dashboard without
publishing, open **Package** → **View public key**, and put the key — one line, no
`BEGIN`/`END` markers — in `extension-key.local`. The build writes it into the
manifest as `key`, fixing the ID.

---

## Using it

**The popup.** Shows whether the current page has a code box, fetches the newest
code, and displays it large enough to read at a glance — click it to copy. When the
mail demonstrably came from the site you are on, it says so; when several codes
arrived and none of them did, it says that instead. *Why this one* lists the signals
that picked it, which is worth a look the first few times and when a message is
unusual. Below that, a collapsed list of the codes that arrived recently and who each
was from.

**The keyboard shortcut.** `Ctrl+Shift+2` by default — `Command+Shift+2` on macOS,
which Chrome substitutes on its own. Fetch and fill without opening anything, which
is the fastest way to use this, so the popup prints the shortcut on the button that
does the same job rather than hiding it in a footnote.

`Ctrl+Shift+<digit>` is the conventional range for extension shortcuts, and Chrome
requires every combination to include `Ctrl` or `Alt` — a bare key is not available
to any extension. If something else has already claimed the combination, Chrome
leaves the command unbound and the popup omits the hint; assign your own at
`chrome://extensions/shortcuts`. Note that changing the suggestion here does not
rebind an extension that is already installed.

**Automatic filling.** Off by default, because it needs permission to run on the
sites you visit — a code box can appear on any page, so there is no narrower way
to notice one. With it on, a code box starts a two-minute inbox watch; the first
confidently-identified code that arrives gets filled in and the watch ends.

Automatic filling is deliberately more cautious than the manual path. It only
accepts a code that arrived around the time the box appeared, never re-uses one it
has already delivered, and requires a confidence score of 55 or better. A number
that merely sits near the word "code" will not be typed into a page unasked; the
popup holds it instead.

It also declines to guess between services. If several codes have arrived and none
of them can be tied to the site in front of you, nothing is typed in — the popup
holds the best candidate and says why it is unsure. See
[which code is yours](#which-code-is-yours).

**The toolbar badge.** The only status there is when the popup is closed, which is
most of the time and all of the time during an automatic fill:

| Badge | Meaning |
| --- | --- |
| `…` | Watching your inbox for a code |
| `✓` | A code was filled into the page |
| `•` | A code was found but could not be filled — open the popup |
| `?` | A code arrived that is not certain enough to type in unasked; the popup has it |
| `!` | The read failed — the popup says why |
| `–` | Nothing recent in Gmail looks like a code |

`✓`, `•`, `!` and `–` clear themselves on a timer. `…` and `?` stay until the watch
ends, because both mean there is still something to come back to.

### Settings worth knowing about

| Setting | Default | Why you might change it |
| --- | --- | --- |
| How it reads your mail | Inbox preview | Switch to full messages if a code is ever too far into the body to appear in the preview |
| Ignore codes older than | 10 minutes | Shorter if you get a lot of code mail; longer for services that are slow to send |
| Also copy to the clipboard | On | Leave on — it is the fallback when a page refuses a typed value |
| Submit the form after filling | **On** | Off if you would rather look at the code before it is used |
| Confirm it on the page | On | Off if you find the corner card in the way |
| Keep recent codes for | 30 minutes | Off if you would rather nothing were remembered; longer if you want a wider view |
| Show a desktop notification | On | Off if you find it repetitive. It is skipped when the on-page card already said the same thing, so with "Confirm it on the page" switched off it fires on every fill. When the code could not be filled in, the notification shows the code itself — which your operating system may keep in a history |
| Wipe the clipboard after | Never | Set it if you would rather not leave a code in the clipboard |
| Fall back to all recent mail | Off | Full-messages reader only: on if a service words its mail unusually |
| Extra search terms | empty | Full-messages reader only. Gmail search syntax, e.g. `from:*.bank.example` |

### Submitting, and why it is on

Typing a code and then pressing the only button on the page is not a decision
anybody makes — it is a step. So the extension takes it, and the care goes into
*how* rather than *whether*:

- Only inside the form holding the field that was filled. Nothing on the wider page
  is ever pressed.
- A never-press list is checked first, against every candidate, including the
  form's declared submit button. Anything reading `Resend`, `Cancel`, `Try another
  way`, `Sign out`, or naming a destructive action — delete, remove, deactivate,
  revoke and their inflections — is skipped outright. Pressing "Resend code" would
  invalidate the code just filled in, and "Confirm account deletion" reads exactly
  like a button that finishes a code step.
- Then a button that reads like one: `Verify`, `Continue`, `Submit` and the like.
  A button the page declares as its submit button is also accepted when it carries
  no text at all, since an unlabelled submit button is unambiguous about its job in
  a way an unlabelled `<div role="button">` is not.
- A button that is disabled until the page catches up is waited for, briefly. That
  is the ordinary state of a code form a few milliseconds after the value lands, and
  clicking the page's own button is the path it designed and tested.
- If no button qualifies, the form is asked to submit itself. If there is no form
  at all — a modal handling the key itself — Enter is pressed, which is what a
  person would do.

Each of those is covered by `npm run test:browser`, against fixture pages built
around the cases that matter: a checkout form whose CVV box is labelled "Security
code", a form offering both "Resend confirmation code" and "Verify", and one whose
only buttons are destructive.

A small card appears in the corner of the page afterwards saying what happened. It
matters most here: with submitting automatic, the form can be gone before you have
worked out why.

### Recent codes

The popup keeps a collapsed list of what arrived in the last half hour, each row
naming its sender and, when it was filled, the site it went into. It is there for the
cases nothing automatic can get right — two services mailing within seconds of each
other, a code filled into the tab you had open before this one, a page that swallowed
one without saying so. Clicking a row copies that code and fills it into the current
page.

The code currently on display is left out of the list. It is already the largest
thing in the popup, and a second copy of it costs the line that would have held the
one you are looking for.

The list lives in memory with everything else, so it goes when Chrome closes, and
**Clear** empties it on the spot.

---

## How it works

```
popup.js / options.js      UI. Reads a status object, sends commands.
        │
background.js              Service worker. Orchestrates everything.
        ├── inbox-feed.js   Default reader: Atom feed over the Gmail session.
        ├── gmail.js        Optional reader: Gmail REST + MIME.
        │   └── auth.js     chrome.identity: token in, token out.
        ├── text.js         Entity decoding and HTML flattening, shared.
        ├── code-finder.js  Which number is the code. Pure, and tested.
        │   └── domains.js  Who sent it, and what site am I on. Pure.
        ├── settings.js     Every read and write of storage: preferences (sync),
        │                   session state (memory), mailbox list (local).
        ├── content.js      Injected into the page: find the box, type into it.
        └── offscreen.js    Clipboard, which a service worker cannot reach.
```

Both readers produce a `{ id, from, subject, text, receivedAt }` record and hand it
to the same scorer, so switching between them changes what can be seen, not how it
is judged.

Three parts carry the interesting problems.

**`code-finder.js` — which number is the code.** A code mail is mostly other
numbers: dates, order references, a year in the copyright line, a phone number in
the footer, tracking ids in every link. Taking the first six-digit run gets it
wrong often enough to be useless. So candidates are scored: how close they sit to
a phrase like "verification code", whether they appear in the subject, whether
they stand alone on their own line, whether the sender matches the site you are
signing in to — against a penalty for sitting just after "order number".

Shape is handled before scoring rather than through it: a run of digits that reads
as a year, a clock time, a monetary amount, a phone number or a fragment of a
longer number is thrown out entirely, because no amount of nearby wording should be
able to rescue it. Links and email addresses are removed before scanning, and
zero-width characters — which some senders scatter through the code to defeat
scrapers — are stripped rather than treated as breaks.

<a id="which-code-is-yours"></a>

**`code-finder.js` and `domains.js` — which code is yours.** A separate question from
the one above, and it only shows up once the inbox has more than one code in it —
which, on an ordinary afternoon, it does. The best-written code mail is not
necessarily the one for the page you are looking at, so wording cannot decide this;
the sender has to.

A message is tied to the site in front of you by its sender's domain, its display
name, its subject, or the body naming the site outright — `email.github.com` and
`slack-mail.com` count, because a service that mails from a dedicated domain usually
keeps its name in it. Once *any* message is tied to the site, messages identifiably
from other companies are removed from consideration entirely rather than merely
outscored: a code from Stripe is never the right answer on a GitHub login, however
well the mail is written.

The interesting part is what is *not* treated as belonging to somebody else. A great
many services mail through SendGrid or Amazon SES, or from a domain naming the
channel rather than the company. Those senders prove nothing, so they stay in
contention with a penalty. And when several codes arrive with nothing tying any of
them to the page, that is reported as ambiguous rather than resolved: the popup still
shows its best guess, because you can see it and judge, but the unattended path
refuses to type it in.

**`content.js` — which input is the code box.** `autocomplete="one-time-code"`
settles it when present, and often it is absent. Everything else is inference from
names, labels and shape, including the row-of-single-character-boxes pattern. The
expensive mistake is a false positive, so anything resembling a card number, a
CVV, a postcode or a password is disqualified outright rather than merely
outscored — note that "security code" is the CVV label on most checkout pages.
Writing the value is its own problem: a React-controlled input discards a plain
`.value =` assignment, so the write goes through the prototype's setter with the
events a real keystroke would produce, and every fill is read back afterwards with
a synthetic paste as the fallback.

---

## What it can see

- **Inbox preview.** Unread inbox mail only, and only its sender, subject, snippet
  and timestamp. Never a full message, and never anything you have already read.
  Authenticated by the Gmail cookie your browser already has; the extension never
  sees a password. Note that the `mail.google.com` host permission is broader than
  that: Chrome grants access per host, not per URL, so the restriction to the feed
  is enforced by this code rather than by the browser.
- **Full messages.** The `gmail.readonly` scope, because Google has no narrower
  scope that includes bodies. Used only to run the code search and read the few
  matching messages. Spam, trash, drafts and sent mail are excluded from every
  query.
- **Codes.** Held in `chrome.storage.session`, which is memory-backed and dropped
  when Chrome closes. No code, sender, subject or message body is ever written to
  disk. Two other things are: your settings go to `chrome.storage.sync`, which
  Chrome replicates through your Google account, and the list of Gmail addresses
  signed in to this browser goes to `chrome.storage.local`. Both are cleared by
  **Forget everything stored** on the options page.
- **Pages.** By default the filler runs only in the tab you are on, and only when
  it has something to do there: when you ask for a code, and while the popup is
  open, because the popup reports whether this page has a code box and cannot know
  without looking. Automatic filling needs the broader grant, asks for it
  explicitly, and then runs on every page you open.
- **Network.** `mail.google.com`, `gmail.googleapis.com`, `oauth2.googleapis.com`,
  and nothing else. The manifest's `connect-src` names those three, which covers
  the extension's own pages and its service worker — where all the network work
  happens. It does not cover the injected page script, which runs under the host
  page's policy; that script makes no requests at all, and a test fails if it ever
  does.

See [PRIVACY_POLICY.md](PRIVACY_POLICY.md).

---

## Development

```
npm test             the pure logic, plus the privacy-policy and wiring checks
npm run build        assemble dist/
npm run test:browser drive dist/ in headless Chrome (skips if there is none)
npm run verify       test, build, then test:browser
npm run watch        rebuild on change
npm run zip          build, then a verified artifacts/2fa-paster-<version>.zip
npm run clean        remove dist/ and artifacts/
npm run icons        re-export the PNGs after editing icons/icon.svg
```

`npm test` needs nothing but Node: no install step, and there is nothing to
install — `package.json` has no dependencies at all.

`npm run test:browser` needs a Chrome or Chromium on the machine, found in the
usual places or named by `CHROME_PATH`, and a `dist/` to drive. Without one it
prints what it would have covered and exits zero, so it never blocks work that
does not touch the browser.

`npm run icons` is the exception to the no-dependencies rule: it borrows `sharp`
from a sibling project in the same workspace rather than adding it here, and does
nothing if it cannot find one. The PNGs are committed, so a normal build never
needs it — only editing `icons/icon.svg` does.

Plain ES modules, no runtime dependencies. The build is a copy plus the client-ID
substitution, from an explicit allowlist in `scripts/build.mjs`. It reads the
assembled output back and fails if the manifest, the HTML or the modules reference
a file that is not there, and it parses every shipped script — a broken
`content.js` would otherwise only announce itself in the page's console, where
nobody is looking.

`content.js` is a classic script, not a module, because Chrome does not load
content scripts as modules. The build fails if an `import` appears in it.

### What the tests cover

The parts that fail quietly. A scorer that picks the order number, a MIME decoder
that returns an empty string, a feed parser that returns no entries, a domain
comparison that decides your own bank is a different company — none of these throw.
So `code-finder`, `domains`, `inbox-feed`, `gmail`, `text` and the recent list are
covered directly, including the awkward cases: split codes (`123 456`), four-digit
bank codes, alphanumeric codes, zero-width characters mid-code, entity-encoded
subjects, an account slot that answers with the wrong mailbox, `co.uk` domains, and
messages where the right answer sits next to a year, a phone number and an order
reference.

The five-services case has its own tests: five code mails in one inbox, and the
right one picked for each of the five sites — plus the case where none of them can
be tied to the page, which has to report itself as a guess rather than resolve.

`tests/wiring.test.mjs` checks the seams that only meet at runtime and only
through strings: element ids against the HTML, message types against the worker's
handlers, the CSP against the hosts actually called.

`tests/privacy-policy.test.mjs` checks `PRIVACY_POLICY.md` against the source, on
the theory that a privacy policy is the one document where going stale is a false
statement about someone's email. It asserts that the hosts named in the document
are the hosts in the manifest and the only ones any runtime file mentions, that
only `settings.js` writes to storage and only `auth.js` touches a token, that the
page script makes no requests, and that the numbers quoted in the prose are the
constants in the code.

`npm run test:browser` covers what needs a layout engine, which is all of
`content.js` and the two extension pages. Which input gets filled and which button
gets pressed are questions about a rendered page — there is nothing to import and
no return value to assert on — so those checks load fixture pages in headless
Chrome and drive the built `content.js` through the same messages the service
worker sends. They also hold the popup and options page to hit-testing (a click on
a switch reaches the checkbox), layout stability (nothing moves when a switch is
flipped), and horizontal containment down to 320px.

What is still unverified: everything that needs a real Gmail account and a real
extension id. The two readers are tested against fixture responses, not against
Gmail; OAuth consent, token refresh and revocation are exercised only through
their error paths.

---

## Limits

- **Gmail only.** Another provider would need its own reader; `inbox-feed.js` and
  `gmail.js` are where that would go.
- **The preview can miss a buried code.** Switch readers if it happens.
- **Not publishable as-is.** A public listing requesting `gmail.readonly` needs
  Google's restricted-scope verification and a security assessment. As a personal
  tool, none of that applies.
- **Codes in spam are not read**, deliberately, by either reader.
- **Some pages cannot be filled.** `chrome://` pages, the Web Store and other
  extensions' pages are off limits to every extension. The popup says so and shows
  the code to copy; with "Also copy to the clipboard" left on, it is already there.

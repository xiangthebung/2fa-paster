# Privacy policy — 2FA Paster

Effective: 29 August 2026

2FA Paster runs entirely inside your browser. It has no server, no account, and no
operator with access to anything. There is nothing for the author of this extension
to collect, because nothing is ever sent to them.

## What it accesses

There are two readers, and they see different amounts. The default sees less.

### Inbox preview (the default)

Fetches Gmail's own Atom inbox feed using the session cookie your browser already
holds. No password is entered anywhere, and no OAuth grant is involved.

The feed returns, per message: the sender's name and address, the subject, a short
snippet of the body, and a timestamp. It does **not** return full messages, and it
covers **unread inbox mail only** — anything you have read, archived, or that was
filed outside the inbox is not visible to it at all.

One point worth being exact about, because it cuts the other way. Riding the
browser session means the *permission* is broader than the use. Chrome grants
access per host, not per URL, so `https://mail.google.com/*` technically permits
any request to Gmail's web endpoints carrying your live session — the extension is
limited to the feed by its own code, not by anything Chrome or Google enforces.
The OAuth reader is the opposite trade: it sees more of your mail, but
`gmail.readonly` is a scope Google's servers enforce, and you can revoke it from
your Google account page.

So: the default reader sees less **content**; the optional reader has narrower
**authority**. Neither is strictly more private than the other, and which matters
more is a judgement about what you are guarding against.

### Full messages (optional)

If you switch to this reader, the extension uses the Gmail API with the
`gmail.readonly` scope. Google has no narrower scope that includes message bodies,
and a one-time code is in the body, so a narrower request is not available.

Within that access it reads as little as it can:

- Every search is limited to mail received in the last day, and results are then
  filtered to your freshness window — ten minutes by default.
- Searches exclude spam, trash, drafts and sent mail.
- By default, only messages whose subject or body uses the vocabulary of a code
  delivery are read at all. The optional "fall back to all recent mail" setting
  widens this, and says so where you turn it on.

Under either reader, message contents are used only to locate a one-time code, and
are discarded as soon as that is done.

**The page you are on.** To type a code into a box, the extension needs to run a
script in the page. By default it does this only in the tab you are looking at, and
only when it has something to do there: when you ask for a code, and also while the
popup is open, because the popup tells you whether this page has a code box and it
cannot know that without looking. Automatic filling needs standing access to the
sites you visit, so it is off until you turn it on, Chrome asks you to grant that
access separately, and while it is on the script runs on every page you open so it
can notice a code box appearing.

What that script reads, it reads in order to find the right box, and none of it is
stored or sent out of your browser:

- each input field's attributes, its label, and up to 400 characters of the text
  around it — "verification code" is often written above the field rather than in
  it, and a checkout page's "security code" is how a CVV box gets labelled, so this
  text is what tells the two apart;
- the text on the form's buttons, to find the one that submits the code step and to
  avoid the ones that must never be pressed for you.

It sends one message, to the extension's own service worker and nowhere else: that
this page has a code box, with the page's address, so automatic filling knows to
start watching for the mail. The worker reduces that to the site's domain and keeps
only the domain. Nothing about the page leaves your browser.

The one thing it adds to the page is a small confirmation card in the corner after a
fill, so an automatic fill never looks like the page acting on its own. It never
shows the code, and it is drawn in a closed shadow root the page cannot read or
restyle.

**Which site you were on.** When a code is filled in, the site's domain — `github.com`,
not the full address — is kept alongside it in the recent list, so the list can say
which code went where. It stays in session memory with everything else and is never
sent anywhere.

## What is stored, and for how long

| What | Where | Lifetime |
| --- | --- | --- |
| The most recent code, its sender, subject, timestamps, the id of the message it came from, the site it was filled into, and why it was picked (its score and the reasons shown under "Why this one") | `chrome.storage.session` | Until Chrome closes, or you forget it |
| The recent-codes list: the same details for up to 12 codes, plus which site each was filled into | `chrome.storage.session` | Your chosen window — 30 minutes by default, and "do not keep a list" switches it off |
| Ids of messages already delivered (the last 40) | `chrome.storage.session` | Until Chrome closes |
| The current inbox watch, if any | `chrome.storage.session` | Minutes; cleared when the watch ends |
| Which Gmail addresses are signed in to this browser | `chrome.storage.local` | Until you disconnect or re-check |
| Your settings | `chrome.storage.sync` | Until you change them or remove the extension |
| Your Gmail access token, if you use the API reader | Managed by Chrome, not by this extension | Chrome refreshes and expires it |

`chrome.storage.session` is memory-backed and is not written to disk. Settings are
preferences only — freshness window, which toggles are on — and contain no message
data and no credentials.

Message bodies are never stored. They are decoded, scanned for a code, and dropped.

## Where data goes

Three hosts, all Google's:

- `mail.google.com` — the inbox feed described above
- `gmail.googleapis.com` — the searches and message reads, if you use the API reader
- `oauth2.googleapis.com` — revoking the token when you disconnect

Those are the only three the code contacts, and a test in the repository fails if a
fourth appears. The extension's content security policy names the same three, which
covers its own pages and the background worker — the parts that do all the network
work. It does not cover the script injected into web pages, which runs under the
page's own policy; that script makes no requests at all, but that is a fact about
the code rather than something Chrome is enforcing.

There is no analytics, no telemetry, no crash reporting, and no third-party code of
any kind. The extension has no dependencies.

## The clipboard, and the notification

When a code is copied, it is written to your system clipboard, which makes it
available to other applications until something replaces it — this is how the
clipboard works generally, and is the point of copying. The "wipe the clipboard
after" setting overwrites it on a timer if you would rather not leave it there. It
applies to every copy the extension makes, including the ones you ask for by
pressing Copy or clicking a code.

Desktop notifications are the other place a code can end up outside the extension.
When the code could not be put into the page — no code box, or a page extensions are
not allowed to touch — the notification shows the code itself, because reading it
off the notification is then the fastest way to finish. Your operating system may
keep that notification in a history that outlives the code. When the fill did
succeed, the notification says so without repeating the code. Switching off "Show a
desktop notification" stops all of it.

## Your Google credentials

Under the default reader there are no credentials at all. The extension rides the
Gmail session your browser already has; it cannot see your password, and it holds
no token.

If you switch to the API reader, the OAuth client it uses is one you create in your
own Google Cloud project. The extension's author has no involvement in it and no
visibility into it.

You can withdraw access at any time:

- **Clear** in the popup's recent-codes list drops that list immediately.
- **Forget everything stored** on the options page clears the stored code, the
  recent list, the ids of messages already used and the list of signed-in
  addresses, and switches automatic filling off. Under the API reader the same
  button reads **Disconnect and forget** and additionally revokes the OAuth token
  at Google.
- Signing out of Gmail, or removing the `mail.google.com` permission, stops the
  default reader.
- [Google Account → Third-party access](https://myaccount.google.com/connections)
  revokes an OAuth grant from Google's side.
- Removing the extension deletes its storage.

## Children

This extension is a developer tool with no content aimed at children and no
age-gated functionality.

## Changes

Any change to what is accessed or stored will be reflected here, with the date
above updated. Since the extension is distributed as source you build yourself, you
can confirm all of it for yourself: `inbox-feed.js` and `gmail.js` are the only two
files that fetch mail, `auth.js` is the only one that touches a token, `settings.js`
is the only one that writes to storage, and `content.js` is the whole of what runs
inside a web page.

## Contact

Questions or privacy concerns: **xiangli3625@gmail.com**.

An issue on the repository this extension came from works too, and is the better
place for anything that is not about your own data — but a privacy policy has to
name somebody you can reach privately, and a public issue tracker is not that.

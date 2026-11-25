# P00RIJA Chat 2.20.22

Version 2.20.22 · build chat-v40

A new version string, so that a device holding a partial or broken copy of the app —
a cache that took some of 2.20.1's files and not others, a page served by a server
mid-deploy — fetches the whole of this one: the release tag is what the worker's cache,
the page's links and the reload key are named by.

**Fixed (the build on GitHub)**

- The CI workflow ran `test:release37`, a suite retired in 2.20.0 (it drives a card of
  the old vault tab, and fails by design); it is no longer run, and the script is gone.
- `smoke` counted the app's probe of a relay (`/chat-health`, which the CI's static-only
  server answers with a 404 by construction) as a script that did not resolve; it now
  asks only whether the page's files resolve.
- The Rust step, which failed on 2.17.1 for the lockfile reason fixed in 2.20.0, passes:
  `cargo test` over `src-tauri` ran clean.

**Servers**

- The build cache of the images' earlier server-side builds (3–8 GB on each server) and
  the archived system journals older than two weeks (1–2.5 GB on most) were removed from
  all eight servers; two of them were over 90 % and 83 % full. Nothing of the app, its
  data or its mailboxes was touched.

# P00RIJA Chat 2.20.2

Version 2.20.2 · build chat-v39

The deployment's own verification, taught the built web root (2.20.1 deployed it and
then reported failure, because it compared the served files with the source tree's).

**Fixed**

- `sync-to-server.sh` checks a built web root for what can be checked about one: every
  script file is named by the hash of its content, every one is in the page and in the
  worker, and both carry the release tag. `deploy.sh`'s check of what a server serves asks
  for every script the page names (and the worker), and for the offline sealing and the
  carrier flow inside the module bundle, instead of the source tree's files, which a
  built root does not have.

Nothing the app or the servers run changed.

# P00RIJA Chat 2.20.1

Version 2.20.1 · build chat-v38

What the servers serve is now the **built** web root, built once on the machine that
deploys. Servers and apps of 2.20.0 keep working with this one.

**Changed**

- **The app image serves a built, minified web root.** `config/Dockerfile` has a first
  stage that runs `tools/build-web.mjs` (the page's hundred-odd scripts become six
  files named by their content; the classic scripts are minified with esbuild, whitespace
  and syntax only, so no global name changes) and an nginx stage that serves the result.
  The first stage runs on the builder's own architecture: its output is byte for byte
  the same built natively on arm64 and under emulation for amd64 (checked).
- **`scripts/deploy.sh` builds the images here, once, and every server pulls them**
  (`--prebuilt`, which was how ir5 was already deployed, is the default now;
  `--build-on-server` is the old way). No server needs the npm registry or Docker Hub,
  and every server runs the same image digests.

**Fixed**

- **The service worker of the built web root was a syntax error.** The build appended
  its files after a list entry that had no trailing comma, so the worker could never
  register: a server serving that build would have had no offline use at all. It had
  never been served, which is why nothing noticed. The build is fixed and
  `check:web-build` now parses `sw.js`.
- **The suites can run against the built root** (`POORIJA_WEB_ROOT=dist/web`): the
  local stack and the three suites with their own proxy honour it, and the eight that
  asserted the source tree's structure (a file's path, an identifier in a function's
  text) assert the build's equivalent. The whole gate was run that way; on the built
  root the app registers its worker, caches one generation, boots with no network and
  renders all eight tabs offline.
- `profilecard` no longer depends on the hour (a second city that is on another day
  put two day letters in a shape that expects one).

Tests: the gate on the source tree and on `dist/web`.

# P00RIJA Chat 2.20.0

Version 2.20.0 · build chat-v37

A review of 2.17 turned up a list of faults; each was checked against the code
first, and the ones that were real are fixed here. Servers and apps of 2.17.x keep
working with this one.

**Fixed**

- **The native builds could not be built.** `src-tauri/Cargo.lock` had been given
  the app's version on another crate (`security-framework-sys`, which is at 2.17.0
  and nowhere else), by the version bump of 2.17.1; every Tauri build then asked
  for a crate that does not exist. Repaired, and the bump is now a tool
  (`tools/bump-version.cjs`) that touches only the app's own block of each lock
  file; `check:versions` asks `cargo metadata --locked` whether the lock is one cargo
  accepts. A `test:native` script exists for the CI job that named it.
- **A call whose media never came up was not restarted.** The nine-second watch for
  ICE stuck at new or checking sat after a `return` and never ran. It is armed once
  per call and cancelled on connected, completed and closed (`icestall`).
- **A receipt kept for a connected socket that was not reading was kept for good.**
  The relay marked receipts `receipt: 1` only on the path for an absent person; the
  other path left it off, so the 48-hour and 300-per-mailbox rules never reached it
  (`receiptkeep`).
- **A notification key could travel in the clear.** `notice-key` went over the live
  channel with no session encryption, and as an unsealed envelope whenever the
  prekey was past its window. It now goes only inside the live session's own
  encryption or inside a sealed body (and waits otherwise), and is believed only so.
- **The same account on a second device overwrote the first device's keys.** A
  contact now keeps up to four devices' keys and a hint carries a part for each.
- **A withdrawn notification key that could not be delivered was forgotten**, and the
  contact kept believing it. It is kept as owed and sent when they can be reached.
- **The security line of a conversation said "RSA-OAEP-3072" for every session.** It
  now says what the session is keyed with (Double Ratchet with X25519 and ML-KEM-768,
  ML-KEM-768 with ECDH, ECDH, or the key exchange not yet done).
- **The tests**: a stale `ton://` link check, the mirrored self-view default, and
  `native-shell` (which does run) are repaired; `nativeui`, `release37` and `uxfixes`,
  written for things this app no longer has, are retired with their reasons.

**Changed**

- **The page runs no code written into it.** `script-src` no longer has
  `'unsafe-inline'` — in the web server's policy, the development server's and the
  native shell's. The 138 `onclick`/`onchange` attributes and the two inline scripts
  of `index.html` are now `js/inline-actions.js`, `js/boot-shell.js` and
  `js/boot-fonts.js` (bound to the same elements, in the same places); the native
  bootstrap is `js/native-bootstrap.js`. A script an attacker manages to put into a
  page no longer runs. `tools/extract-inline.cjs` did the move; `sourceaudit` now
  fails on any inline handler or script, and holds the `.innerHTML =` sites to a
  ceiling (215, down from 250: the 35 that only cleared a node are `replaceChildren()`).
- **Documents**: `docs/PROTOCOL.md` describes identity v4, `kex-offer/4` and the
  ratchet; `docs/SPEC.md` §8 records the wire of 2.16–2.20.

**Not changed, and why**

- *Dropping the profile key when the app locks* (the plan's `sealed-inbox`): a locked
  app keeps receiving, which needs the identity, the prekeys and the history in the
  page; none of that is a thing to drop. The 2.16.8 fix writes through with the key
  that is already there. The ten keys `audit:prelock` lists are all on the vault's
  device-level list on purpose, and the audit now checks that.
- *Minifying the classic scripts, a multi-stage image that builds the web root, and
  splitting the five largest files*: each is a change to how every server is built or
  to thousands of lines, and none was needed by what was found. The module bundle is
  minified already; the CSS rule pruner finds nothing left to remove.

The full gate (246 suites) found three more, fixed: the two notification switches of
2.17 had no on-colour in the legacy settings list (`linkpreviewrelay`), `sealedsender`
still expected a receipt for an absent person to be refused (it has been kept since
2.16.4), and `chatnavfit` measures a strip the messenger skin hides (quarantined; it
fails the same on 2.17.2).

Tests: `icestall` and `inlineactions` (every one of the page's 135 controls is pressed
and reaches the function it names) are new; `receiptkeep`, `noticehints` (34),
`sourceaudit`, `csp` and `native-shell` changed. Gate: 235 passed, 3 passed on the
second run, 5 quarantined, 6 not runnable on a development machine.

# P00RIJA Chat 2.17.2

Version 2.17.2 · build chat-v36

**Fixed**

- **A contact in a conversation that has a lock is given no notification key,
  whether the lock is open at that moment or not.** 2.17.1 asked only whether it
  was engaged, so a conversation unlocked for a minute handed its contact a key.
  The check runs every minute, so a lock set later takes the key back.

Said, not changed: the names the worker shows are kept in its IndexedDB beside
the keys (outside the vault, because a worker cannot open the vault); encrypting
them under keys stored in the same place would protect nothing. They are only the
names of contacts, only while a switch is on.

# P00RIJA Chat 2.17.1

Version 2.17.1 · build chat-v35

Hardening of 2.17.0's notification switches, from a review of them.

**Fixed**

- **The name on a notification is the one this device saved for the contact,
  never the one the hint carries.** A contact holding a key could otherwise have
  signed a notification as someone else. A name and a line that open under
  different contacts' keys are not believed.
- **A contact in a locked conversation is given no key**, so nothing of theirs
  can show on a lock screen (the worker cannot see locks; the page decides who
  is given one, and takes the key back when a conversation is locked).

Not changed, and said so: a hint replayed within a day and a half shows the old
line again (the relay can already raise any push it likes; the hint can say only
what a real contact really sent), and an app lock does not stop a notification
the person asked to name or quote — the setting says so.

Tests: `noticehints` 27 checks.

# P00RIJA Chat 2.17.0

Version 2.17.0 · build chat-v34

What a notification says, in the person's hands. The protocol is extended (a
sealed message of one new kind and one optional field on the envelope); apps and
servers of 2.16.x keep working with this one, and a server that is not yet
updated simply never carries the new field.

**New**

- **Two switches, off by default: the sender's name, and the message.**
  Settings → Notifications and sounds → *What a notification says*. Off, a
  notification says only that an encrypted message arrived, as before. On, it
  can say "New message from Ali", and show the start of a text or what a media
  message is (sticker, GIF, photo, video, voice message, audio, file, location),
  in the language of the device. They work with the app closed.

  The relay and the push service of Google or Apple never learn either. Each
  switch that is on gives this device a key *for each contact* — never one that
  everybody holds, so a contact can speak only as themselves and can be cut off
  alone (blocked, removed, or the switch turned off) — handed to that contact
  sealed like any message. A contact writing to an absent person adds the name and the
  kind-and-start-of-text to the envelope, each encrypted under the matching key
  and padded to a fixed size; the relay passes them on inside the push as bytes it
  cannot open (and drops anything that is not that shape), and the service worker
  opens them with the keys the app left for it in IndexedDB, believing none that
  is more than a day and a half old. A switch that is off
  has no key anywhere, so nothing is encrypted for it and nothing is on the wire;
  turning it off takes the key back from the contacts. Anyone who can see a
  locked screen can read what it shows — the settings say so — and a locked app,
  chat tab or conversation still shows the bare line on the desktop shell.

**Fixed**

- The desktop and native shells' own notification takes its title from the same
  place, so it can carry the name when asked.

Tests: `noticehints` is new (22 checks): the line a phone shows from a hint in
both languages, every case where it must stay the fixed line, and two real apps
and a relay (off: no hint; on: keys handed over, the hint in the mailbox with no
name or word readable, the worker saying who wrote and what; off again: keys
withdrawn, no hint). `unifiedpush` checks the relay's shape rule;
`notificationprivacy` now holds the new invariant: nothing but the fixed line
unless asked.

# P00RIJA Chat 2.16.8

Version 2.16.8 · build chat-v33

A message that arrived while the app was locked could be lost for good. That is
the report of a phone that rang for a message and showed none when it was opened.

**Fixed**

- **A message taken by a locked app is kept, and told to the relay only when it
  is kept.** The lock is a screen: the app stays connected and receives. But
  what it received while locked was held in memory until the password was typed,
  and the relay was told at once that it had arrived and so destroyed its own
  copy. A phone that discards a backgrounded app — an iPhone does, within
  minutes — took the page, the memory and the only copy with it: the notification
  was all that was left, and opening the app showed nothing. Now the chat writes
  to storage with the screen locked exactly as it does open (the key is in the
  page either way), and an acknowledgement waits until nothing the chat holds is
  unsaved — a locked page that holds no key, or a store that failed to write,
  holds it until it can. What waits stays on the relay, which hands it over again.

Tests: `offlinerecv` is new (27 checks, Chromium and WebKit): the receiver away
and back, the page frozen and thawed, the sender restarting under a receiver that
keeps its page, and a locked receiver discarded by the system, over the relay and
over the live channel. `offlinefuzz` draws such orders at random from a seed.

# P00RIJA Chat 2.16.7

Version 2.16.7 · build chat-v32

The native apps, and the scripts that build them and put them on GitHub. The
protocol and the servers are unchanged.

**New**

- **The native release is one door.** `bash build-native.sh all` builds macOS
  (universal, Apple silicon, Intel), Windows (x64, ARM64), Linux (x86-64 and ARM64:
  .deb, .rpm, AppImage, pacman package, portable archive) and Android (universal and
  arm64 APK, AAB), one after another, with Docker for what the host cannot build
  natively, and collects every file in `Export/GitHub/` with `SHA256SUMS.txt` and a
  `RELEASE-NOTES.md` that holds a table of which file is for which machine and the
  history of every release from 1.0.0. A platform the host cannot build is skipped and
  named, never silently left out; the release is refused if a file it lists is missing.
- **iOS: the project, not a build.** `bash build-native.sh ios` generates the Xcode
  project and zips it with the web payload and a `README-SIGNING.txt`; iOS installs
  only what is signed with your own Apple identity, so nothing is signed here.

**Fixed**

- **The updater takes the right file for the machine.** An Android phone is offered
  the APK for its own chip, else the universal one; an Intel Mac the Intel build when
  the release has one; a universal Mac install stays on the universal file and an Apple
  silicon install on its own; the app bundle and the iOS project are never offered as
  an update.

Tests: `updatepick` covers the new files (18 checks).

# P00RIJA Chat 2.16.6

Version 2.16.6 · build chat-v31

**Fixed**

- **"Seen" is sent for a message that arrives right after another.** The pass that
  sends the seen receipts of an open conversation is held to one every 400
  milliseconds, and a message that arrived inside that window waited for something
  else to draw the conversation again before its receipt went out; across relays,
  about one pair in ten lost it. It now tries again just after the window.

Checked, live, across all eight relays: every one of the 56 ordered pairs, online
and with the receiver away (the message waits on the relay and comes when the
receiver does), gets its message, its delivered tick and its seen tick.

# P00RIJA Chat 2.16.5

Version 2.16.5 · build chat-v30

Finishes 2.16.4: the app now sends receipts the way the relay keeps them.

**Fixed**

- **A sealed receipt is sent as mail that the relay keeps and that is sent again.**
  2.16.4 taught the relays to keep a receipt for somebody away, but the app still
  marked its receipts as not to be kept and left them untagged, so nothing was
  kept and a link that was down at that moment still lost the tick. They are now
  persisted and tagged, which also puts them in the outbox that sends a transit
  envelope again, with backoff, until the far relay takes it.

# P00RIJA Chat 2.16.4

Version 2.16.4 · build chat-v29

Delivered and seen ticks no longer get lost.

**Fixed**

- **A receipt for somebody who is away is kept.** A delivered or seen tick was
  sent once and dropped by the relay if the person it was for was not connected
  at that moment, or if a link between two relays was down: nothing kept it and
  nothing sent it again, so the sender's message stayed at *sent* or *delivered*
  for good. In a run across eight relays, eighteen of fifty-six senders never got
  their tick (the same run across five relays lost none). Receipts are now kept
  on the sender's relay for two days, without waking anybody, at most 300 to a
  mailbox, and delivered when the sender's app is next there. What a relay can
  see of one is that it is a receipt, no more than it could see of its being
  small and sent a moment after a message.

Tests: `receiptkeep` is new (a typing indicator for somebody away is dropped, a
receipt is kept and expires, mail is as it was).

# P00RIJA Chat 2.16.3

Version 2.16.3 · build chat-v28

Messages written from one relay to a person who lives on another now reach them
even when the sender's app did not know where they live.

**Fixed**

- **Mail parked on the wrong relay is carried on by the relays themselves.** A
  device that does not know where a contact lives writes to its own relay; that
  relay had never seen the person, kept the message and said "queued", and it
  stayed in that mailbox for good unless the app, still running and on that
  conversation, asked the family where the person lived and sent it again. Found
  between the Finland relay and an Iran one: eighteen messages for one person
  (who had moved home between two Iran relays) sat on the Finland relay. A relay
  now does what the app would have: it asks the relays it is linked to, sealed,
  whether the person lives with them, and sends what it holds to the one that
  answers. It asks again every few minutes, less often after three empty answers,
  and never for mail that arrived from another relay, so two relays cannot hand
  one message back and forth. It asks about at most twenty people a minute, keeps
  a table of who was asked to a size, and carries mail on only when exactly one
  relay says the person lives with it (2.16.2 was cut and not deployed past the
  first server; this is the release that carries the change).

**Checked, live**

- A message, its reply, the ticks and a call, in both directions, between the
  Finland relay and an Iran relay, between two users made for the test, also after
  one of them moved its home to a third relay; and between the Sweden relay and
  an Iran relay that are not linked to each other, by way of the others.

Tests: `strangermail` is new (three relays: mail written to the wrong one is
carried to the right one, once; a person nobody hosts, and a person of the relay
itself, are left alone).

# P00RIJA Chat 2.16.1

Version 2.16.1 · build chat-v26

Three things found on an iPhone, on top of 2.16.0 — the first release published
on GitHub.

**Fixed**

- **The self-view in a video call no longer has a black margin all round it.**
  On iOS the picture was drawn at half size in the middle of its own tile until
  the tile was dragged, because WebKit lays a video out for the box it had when
  the first frame arrived and the tile changes shape a moment later. The video is
  laid out again when that happens.
- **The other person's picture is brought back when it stays black.** On iOS it
  was sometimes black for the whole call and came right only after closing and
  opening the app a few times. The picture is looked at for the first twenty
  seconds and again whenever the app returns to the front: a video that is
  paused or has no frame is attached again, asked to play again, and — if iOS
  refuses until a touch — shown the moment the screen is touched once. A call
  whose media path is still at *checking* after nine seconds is restarted by the
  caller, as one that fails is.

**New**

- **Your own picture is mirrored by default**, the way every camera app shows it,
  and **Settings, Server and connection, Calls** has a switch to turn that off.
  It changes only what you see: the other side is asked to see the mirrored
  picture only when you press the mirror button in a call.

Tests: `navfixes` gained the mirror default, the Settings switch and a stalled
remote video (42 checks); `callfix` and `callmirror` follow the new default.
Not tried on a phone: the two iOS fixes were written from the symptoms and from
WebKit's behaviour, and Playwright's WebKit cannot connect a call here.

# P00RIJA Chat 2.16.0

Version 2.16.0 · build chat-v25

The first release published on GitHub, with the fixes found by using 2.15 on
phones. The protocol and the servers are unchanged; apps and servers of 2.15.x
keep working with this one.

**Fixed**

- **A call through a peer is one line in its conversation, "via peer".** A call
  that came by an id no contact record held (a relay call named by fingerprint, a
  second device of a contact) was written under that raw id, and the chat list
  grew a conversation named after it. An id the device already knows by any of its
  keys now resolves to the contact; one that is nobody's stays in the call log
  and makes no conversation (an id that merely extends a contact's is never
  attributed to them: anybody can register one); a thread of nothing but call
  lines is not listed. Every
  call row, in the conversation and in the call log, now says which road it took:
  *via peer* or *via relay*.
- **The menus of a call, voice and video, are one arrangement.** The extras menu
  (hold, picture-in-picture, fullscreen, devices, and in a video call screen share,
  screenshot, mirror, swap) drew each item as a round button with its label inside,
  so "Picture in picture" and "Mic / camera / speaker" were cut off and the last
  row hung to one side. The tiles are equal rounded squares with the label under
  the icon; the reactions, the present sheet, the device pickers and the two cards
  (verification, connection quality) take the same width and the same place above
  the dock; opening one closes the others. The device pickers' labels follow the
  language, and their close button no longer sits on the first picker.
- **Settings shows the live state.** A page was drawn when it was opened, so a
  status on it stayed as it was until you went to another page and back. The page
  on screen is drawn again when the app says something changed, and a few times a
  second as a net, only when what it says differs (so nothing flickers and a
  half-pressed button is not lost, and never while a field has the keyboard). The
  Server and connection page now begins with the state, the server and how many
  contacts are online. The word "Disconnected" no longer paints the dot as
  connecting.
- **A Settings page opens at its top, and back returns to where you were.** The
  page that scrolls is the app's main area, not the Settings container, so the
  reset did nothing and a page opened at the bottom of the last one.
- **Back and forward work.** Android's back gesture and button, a browser's back,
  and iOS's edge swipe used to leave the app, because the app told the browser
  nothing about its screens. Every screen change (a tab, a list, a conversation on
  a phone, a page of Settings) is a history entry now; back and forward restore
  them. With a sheet, a viewer, a dialog or a menu open, back closes that and stays;
  a call in full screen goes to its small window and is never hung up. At the first
  screen the same gesture leaves the app. In a home-screen app on iOS, where there
  is no edge swipe to history, one is provided (left edge to the right is back,
  right edge to the left is forward).
- **A burst of messages is one toast per conversation, counted.** The first
  message shows what it says; after that the same toast reads "3 stickers, 1
  message" and updates in place. Different people stay separate toasts.

**New**

- **`install.sh`**, the installer: one line on a bare Linux server. An easy install
  asks where people will reach the server (a domain, the public IP, or this
  network), an e-mail and a port; a custom install is the full wizard. It finds a
  certificate the server already has (3X-UI, certbot, acme.sh) and offers it before
  issuing one; Let's Encrypt for names and for public IPs (renewed by the stack),
  self-signed for the rest; `--cert-dir` serves a folder where it is. `update`,
  `status` and `uninstall` too. `scripts/setup.sh --quick` gained `--port`, `--ip`
  and `--local`.
- **`build-native.sh`**, one door for the native apps: macOS, Windows, Linux,
  Android, all of them, and a check of what the machine lacks.
- **A README in Persian and English**, with the architecture, the installer, the
  certificates, the ports and the native builds.

**Corrected**

- The native build and release scripts still named P00RIJA Cryptography: the
  binary, the package names, the updater repository. They name this app now, and
  the Linux build had two `npm run` scripts it called that did not exist.
- `package.json`, the relay package and the central panel pointed at the other
  project's repository; they point at `Poorija/P00RIJA-CHAT`.

Tests: `navfixes` is new (38 checks: the call route, the menus' geometry, Settings
scroll and live state, back and forward, the toasts).

# P00RIJA Chat 2.15.1

Version 2.15.1 · build chat-v23

Everything 2.15.0 has, with every file that names the version saying the same
one: the npm lockfile and the desktop/Android app's Cargo lockfile still said
2.13.2. The version check now reads them too, so they cannot fall behind
again. No change in what the app or the servers do.

# P00RIJA Chat 2.15.0

Version 2.15.0 · build chat-v22

Six weaknesses found while writing the protocol down for auditors are closed.
Nothing changes in how the app looks; apps update each other's protection as
they meet, and older apps keep working.

- **The start of a conversation cannot be weakened on the way.** The signature
  on the key exchange now covers how the conversation is to be protected (the
  message ratchet and its keys), not only the keys. Someone carrying the first
  messages could take that part out before; now that is refused.
- **A server cannot rewrite the labels of a group call's media**, such as marking
  one person's frame as another's, and two people can no longer end up with the
  same frame key by chance.
- **A server signs its key log with a key kept only for that**, apart from the key
  that protects traffic between servers.
- **Three hardenings inside the app:** a conversation's key is never sent wrapped
  in the long-term key to a contact who has better; the record that stops a
  message from being accepted twice is kept long enough for every key still in
  use; a key confirmation is compared in constant time.

# P00RIJA Chat 2.14.0

Version 2.14.0 · build chat-v21

The start of phases 4 and 5: the app on the desktop and on Android, and what an
independent audit needs.

- **Settings pages, all in one style.** Change password, recovery questions, the
  decoy password and My devices were old cards inside the new pages; they are
  Settings rows now, like the rest.
- **A group call cannot be silenced by the server.** In a large group call, one
  forged packet from the forwarding server could make a member inaudible for the
  rest of the call. It is now ignored.
- **The protocol, written down for auditors** (`docs/SPEC.md`): every key, message
  and step, the threat model and the test vectors.
- **The same source gives the same server software.** Building a release twice
  now gives byte-identical images, so anyone can check that what runs is what the
  source says. Releases are signed, with a list of every file they contain.
- **Desktop and Android apps** (P00RIJA Chat for macOS, Windows, Linux and
  Android) can be built from this repository, as an app of their own beside
  P00RIJA Cryptography. They are not signed for distribution yet.

# P00RIJA Chat 2.13.2

Version 2.13.2 · build chat-v20

- **Videos play full screen, as in Telegram and WhatsApp.** In the conversation a
  video is a still with a play button; a tap opens it full screen in the app's own
  player, with a button to save it. The browser's own full screen is no longer
  used: on Android it closed the app and asked for the fingerprint again.
- **A video picked from an iPhone's gallery is sent as a video**, not as a file.
- **The sending sheet says Media**, not Photo, since a video goes through it too.
- **No note above the messages once the encrypted session is up.** The line under
  the message box says what the messages are encrypted with.

# P00RIJA Chat 2.13.1

Version 2.13.1 · build chat-v19

- **A contact who put the app away is shown as away even while a direct
  connection to them is open.** In 2.13.0 the open connection's own keep-alive
  still counted as them being there, on contacts of another server.

# P00RIJA Chat 2.13.0

Version 2.13.0 · build chat-v18

Fixes from using the app on phones: the message box, the chat list's menu,
photos and videos, and whether a contact is shown as online.

- **The message box behaves like a messenger's.** A long message grows the box a
  line at a time up to about seven lines (less while the keyboard takes half the
  screen) and then scrolls inside it; it no longer slides under the keyboard or
  pushes the conversation's header off the top. A draft comes back at its full
  height when you return to the chat. Selecting text in the box shows the text
  tools (bold, italic, strikethrough, code, hidden, clear) above it.
- **The encryption line says what the app uses:** Double Ratchet with X25519 and
  ML-KEM-768, AES-256-GCM per message. It stays at the bottom and is hidden while
  you type instead of riding up with the keyboard. The session note above the
  messages says the same.
- **Every item in a conversation's menu works.** Pin, mute, archive, mark unread,
  export, lock, block, and Unarchive in the archive: after the first long press,
  the menu's next choice was swallowed and did nothing. Each conversation now
  shows a ⋯ button that opens the menu, and a row can be swiped as in Telegram:
  toward the end of the line to archive, the other way to mark it read or unread.
- **Videos and albums.** A video can be sent as a video, which plays in the
  conversation with its length shown, or as a file. Up to 25 photos and videos
  chosen together are sent as one album and shown as one grid.
- **Reactions on photos and videos.** A long press (or right click) on a photo or
  video opens its menu with reactions; a tap still opens the photo.
- **Online status is live and the same on every server.** A contact on another
  server of the family was shown as online while their app was in the background,
  because the app's own background traffic told their server they were back. Their
  server now answers whether they are actually using the app. The status updates
  by itself within seconds; nothing has to be reopened. An active direct
  connection counts as being there, so the header no longer says Offline while
  messages are going both ways. Switching between Wi-Fi and mobile data
  reconnects at once instead of after half a minute.
- **Readable in every theme.** The last 15 places with low text contrast (device
  ids, the sticker panel in Pastel and Nord, the danger buttons) now read at 4.5:1.

Tests: rowmenu (the menu, the ⋯ button and swipes on a phone-sized page), albums
(video, file, album of four, the 25 limit, a reaction on a photo) and
presencelive (online, away and back, on one server and across two) are new.

# P00RIJA Chat 2.12.0

Version 2.12.0 · build chat-v17

Large group calls now take in people on the other servers of the family, and the
app's code is reorganised underneath.

- **Group calls across servers.** A call of five or more goes through the
  server's encrypted forwarding (new in 2.11) even when some of the people in it
  are on another server of the same family; they connect to the caller's server
  over the same secure connection. People on servers outside the family keep the
  call working as before.
- **Your contacts learn what your app can do, wherever they are.** Two people on
  different servers who talked directly never learnt each other's app features,
  so group messages and large calls left them out. The first message of a
  conversation now carries them.
- **Under the hood.** The chat's 68 parts are now JavaScript modules, each with a
  scope of its own, behaving exactly as before; a built version of the app loads
  them as three files. Two leftover pieces of the page nothing used are gone.

Tests: sfucall checks a call across two servers; every suite runs on the
modules.

# P00RIJA Chat 2.11.0

Version 2.11.0 · build chat-v16

Groups and group calls get the protection one-to-one chats have, and a blocked
relay address no longer costs most of a minute.

- **Group messages are sealed once, by their sender.** Each member keeps a chain
  of keys for each group and signs what it sends with a key of its own. A group
  message is encrypted once under the next key of the sender's chain; every
  member gets that one sealed copy and the chain to open it with, inside the
  encrypted session they already share with the sender. When anyone leaves or is
  removed, every member starts a new chain for those still in, so the one who
  left reads nothing said after; someone who joins reads nothing said before.
  Members on an older app get the message as before.
- **Large group calls, encrypted end to end through the server.** A call of five
  or more people on the same relay now goes through the relay's own forwarding
  server instead of every phone sending to every other: each device sends its
  picture and voice once. Every frame is encrypted on the device (SFrame, RFC
  9605) with a key only the people in the call have, so the server carries what
  it cannot open. When someone leaves the call, everyone still in moves to new
  keys. It runs over the same secure connection as everything else, so it needs
  no extra ports. Smaller calls, and calls with people on other relays, work as
  they did.
- **A blocked address is passed by in about a second.** When the relay's main
  address does not answer, the app now tries every address it knows for that
  relay at once and takes the first good one, after checking that it really
  leads to the same relay. It used to wait 25 seconds and then try them one by
  one.
- **Under the hood.** The relay's program is split into small parts, the code
  that does the cryptography is type-checked, a built version of the web app
  loads its scripts as three files instead of a hundred, and about a thousand
  lines of styles for screens that no longer exist are gone.

Tests: senderkeys and sfucall are new, with unit tests of the sender keys and of
SFrame against the RFC's own vectors; relaymirrors checks the race.

# P00RIJA Chat 2.10.0

Version 2.10.0 · build chat-v15

The relays now keep a public, signed record of the keys they hand out, so one that
lies about a contact's key is caught by the others. The relay's state moves into a
database, and the relay's own settings are back in Settings.

- **Key transparency.** Each relay keeps an append-only log of the account keys it
  has seen proven, and signs where the log stands. The relays hand each other these
  signatures, and the app keeps the last one it saw of each relay. A relay that
  shows one person a different log from the one it showed before — the way it would
  slip someone a key that is not their contact's — is caught by the app and by the
  other relays. The safety panel says whether a contact's key is in their relay's
  log, and once a day the app checks that nobody has registered a key under your
  own name.
- **Compare before something big.** Before a file over 10 MB, or sharing the
  screen, with a contact whose safety number you have never compared, one line above
  the message box says so, with Compare now and Not now. It never stops the send.
- **The relay keeps its state in SQLite.** The mailboxes, the copies held for
  linked devices, push subscriptions and the rest move from many JSON files into one
  database. Writing one person's queue now writes one row, and a backup is one
  consistent copy. The first start imports everything and leaves the old files
  renamed `.imported`, so going back is possible.
- **Relay settings are back.** Settings › Server and connection shows the relay's
  fingerprint again, the relay family it belongs to, and the best-relay choice —
  Automatic, Suggest only or Off — with each relay measured from your device and a
  way to move there. They had been missing from the settings pages since 2.5.

Tests: keytransparency is new, with unit tests of the log against the RFC 6962
vectors; the nginx route check now runs in the gate.

# P00RIJA Chat 2.9.0

Version 2.9.0 · build chat-v14

A conversation now heals itself: if someone copies everything a device holds, they
lose the conversation again within a round trip.

- **The session heals.** Since 2.8 every message has a key of its own, but whoever
  copied a device's chain keys could keep reading every message still to come on
  them. Now every message also carries a fresh key of the sender's ratchet, and each
  time the other side answers, both move to a new secret made with a private key that
  did not exist before. Someone who took a copy of a device's keys — even one who sees
  every message on the wire afterwards — is locked out as soon as that device has made
  a key they never saw.
- **Post-quantum, inside the conversation.** Every 50 messages or once a day, the
  step also mixes in a fresh ML-KEM-768 secret, and each side then rotates its
  post-quantum key. A recording kept for a future quantum computer has to break it
  again at each of those points, not only at the start.
- **Nothing to do.** Between two 2.9 apps this happens by itself; with a 2.8 app the
  conversation runs as it did in 2.8 until it updates, and a contact seen once at this
  level is never accepted at a lower one again. Messages in flight while the keys move
  still open, and file transfers are keyed by a message of their own.

Tests: ratchetpcs is new, with unit tests of the ratchet steps.

# P00RIJA Chat 2.8.0

Version 2.8.0 · build chat-v13

Every message now has a key of its own, and nothing kept on the device can open a
message that has already been read.

- **A key per message.** A conversation used one encryption key for everything,
  kept on the device and reused for up to seven days, and every message queued for
  somebody who was away carried that key inside it. Whoever got hold of one device's
  storage or memory at any moment of that week could read the whole week, in both
  directions. Now the key exchange only starts two chains, one for each direction:
  every message takes the next key from its chain and the key it came from is thrown
  away. What is left on a device after a message is read opens nothing that was
  already read, and the long-lived session key is no longer stored at all.
- **Messages that arrive out of order still open, once.** A message that overtakes
  others (one through the relay, one live) leaves the keys of the ones it passed
  waiting — at most a thousand, for at most two days, encrypted on the device — and
  each is deleted once used. A copy of a message is refused.
- **Files** take one key from the chain per transfer, with a key of its own for every
  piece, and a piece can still be sent again.
- **Offline messages** no longer carry the conversation's key.
- Between two 2.8 apps this is automatic; with an older app the conversation works
  as before until it updates, and a contact seen once on the new keys is never
  accepted on the old ones again.

Tests: ratchetfs is new, with unit tests of the chains.

# P00RIJA Chat 2.7.0

Version 2.7.0 · build chat-v12

An account is no longer one RSA key that does everything. It moves, by itself, to two
keys that each do one job, and the people it talks to see an upgrade, not a warning.

- **Two keys instead of one.** Every account had a single RSA-3072 key that both
  opened what was sealed to it and signed what it sent, which modern cryptography
  forbids. On its first connection to a relay that can prove it (every relay since
  2.6.0), an account moves to an **Ed25519** key that only signs and an **X25519**
  key that only seals, signed by the first. Keys and signatures are a fraction of the
  size, so the identity QR is smaller and reads more easily.
- **An upgrade, not a key change.** The old RSA key signs that the new keys are its
  successor. A contact checks that against the key they saved for you, keeps the same
  conversation and its history, stays verified if they had verified you, and sees one
  quiet line instead of the red "key changed" banner. A move whose signatures do not
  check changes nothing.
- **Nothing is lost on the way.** The RSA key is kept for ninety days, so mail written
  to it before the move still opens; the relay delivers what was queued for the old
  address to the new one. After ninety days the old key is deleted.
- **Every device of an account moves together**, from the device that made it (or its
  primary); linked devices receive the new keys in the device sync or the portable
  profile. A browser without both curves stays on RSA, which is always safe.
- No compatibility with P00RIJA Cryptography is kept from this release (the owner's
  decision); its interoperability test is retired.

Tests: identitymigrate is new, and the unit tests check the app and the relay against
each other byte for byte.

# P00RIJA Chat 2.6.0

Version 2.6.0 · build chat-v11

The first release on the road to 3.0 (docs/ROADMAP-3.0.md). A second password is
called what it is, every message under a session key is bound to its place, and the
relay learns to recognise the account keys the next release will move to.

- **The decoy password says what it does.** The second password opens a complete
  decoy profile and erases nothing; its row, page, card and description called it an
  "emergency erase password" and promised that everything was wiped, so somebody
  under duress who believed it would think their data gone when it was not. It is now
  the *decoy profile password* in a group of its own, and erasing everything on the
  device is a separate red row in a *Danger zone*, which still asks twice. The lock
  screen's erase button is named for erasing.
- **Every message is bound to its session, its sender, its recipient, its kind and its
  place in the order.** A payload under a session key was AES-GCM with no additional
  data: the same message could be delivered twice under a new id and shown twice, a
  text could be delivered as an edit that rewrote an older message, and nothing said
  which way it was written. Between two 2.6 apps every payload now carries that binding
  and a sequence number, a copy is refused without resetting the session, file chunks
  are bound to their transfer and position, and a contact seen once to bind is never
  accepted unbound again. Older apps keep working unbound until they update.
- **The relay knows identity v4.** It can now prove an account whose key is Ed25519
  rather than RSA, check the statement that moves an account from one to the other
  (signed by both keys), and keep the old mailbox pointed at the new one for ninety
  days. Nothing moves yet: the app that moves accounts is the next release, and it is
  shipped only once every relay runs this one.

Tests: decoywording, replayaad and relayv4 are new; the unit tests of the new
cryptography modules run in the regression gate. 
# P00RIJA Chat 2.5.0

Version 2.5.0 · build chat-v10

The messenger is laid out for the device it is on, and it can be made your own: a
desktop window and a tablet get a workspace of their own, there are seven more
themes and new avatars, and the Profile page follows what you type. On a phone the
layout is what it was. The protocol, the cryptography and the relay are not touched.

- **A workspace for a window.** From 768 px the tabs are a branded rail beside the
  list and the conversation, and the list is narrowed so a tablet keeps a usable
  thread. From 1200 px the workspace is inset with a soft corner and shadow, the
  messages sit in a bounded column and the composer is compact. The rail carries the
  app's mark, a theme button and a profile button, which press the original controls
  and keep no state of their own. An empty conversation offers New chat and Search
  instead of a blank panel.
- **The keyboard.** Cmd/Ctrl+K opens global search; the tabs and the popup menus take
  the arrow keys, Home and End, say whether they are open to a screen reader, and give
  focus back to what opened them on Escape. A button jumps to the latest message when
  you have scrolled away from it.
- **Reactions on your own messages** as well as on theirs, on text, photos, files and
  stickers.
- **Seven more themes** in Appearance: Ocean, Forest, Aurora, Sunset, Nord, Solarized
  and Pastel, each with the full set of messenger colours, in both languages.
- **Avatars.** The six presets are redrawn as local CC0 vector art (the licence is
  with them); nothing is fetched from another site.
- **Profile and text size.** The text-size percentage is shown in full in both
  directions, and the Profile page changes its name and picture as you type and after
  you save, without rebuilding the open dialog or losing the focus.
- **Readable in every theme.** Solarized and Pastel are a step darker in their accent
  and secondary ink so that text reads at 4.5:1 on their light grounds; a red button
  (the panic password, reset to defaults) is white on a red white can be read on in every
  theme, where it had been 1.1:1 to 2.6:1; the QR options' labels no longer fade to
  2.8:1.
- **Tests.** `tests/e2e/personalization.mjs` and `tests/e2e/message-actions.mjs`; the
  build tools' `@babel/parser` and `@babel/traverse` are declared.

# P00RIJA Chat 2.4.1

Version 2.4.1 · build chat-v9

The world clocks stand beside your picture, a voice message can be sent from the
button, a frozen phone no longer reads as online, and the first full audit of the
app — every screen, in both languages, at five sizes, in fifteen themes, and every
end-to-end suite — found and fixed what is listed here. Relays and the web server
config change too; update them with the app.

- **World clocks.** A column left of your picture, as tall as the picture, in both
  languages: your own time with both calendars (Persian and Gregorian) on one line,
  then each city under it, every line centred, in a tile with the same 9 px corner
  as the doors beside it. A city whose day is not yours has one letter in front of
  its time: T or Y in English, ف or د in Persian. The pixel companion is on the
  other side, and the Identity door has its card glyph.
- **Photos.** Save has its icon, stickers and GIFs are sent without a frame, the
  corners of the crop frame point the right way in Persian, and the editor has a
  Draw tab: a pen in six colours, a mosaic brush for a face or a number, undo.
  The pixel companion can be turned back on from Profile.
- **Calls.** The six symbols a call shows are made from the call's own DTLS
  fingerprints as well as the two identities, so a server that carries the
  signalling and ends the encryption at itself changes them.
- **A voice message can be sent.** The button at the end of the composer stayed a
  microphone while a recording waited in the preview, and a tap on it started a
  second recording. It is Send while a recording waits.
- **A stranger's message can be accepted or blocked.** The request card was laid out
  below the screen, and Accept was white text on a white button.
- **Presence.** The table the app lives on never said whether a peer is awake, so a
  frozen phone read as online and "seen" was said of messages not yet read. The
  relay now says, and notices a heartbeat that lapses. An app that does not know the
  field ignores it.
- **Language.** Changing the language half-way through setting a password cleared the
  three security questions; the identity QR and start-chat sheets stayed in the old
  language; the appearance preview showed Persian digits in English.
- **Settings.** The live preview showed the chosen wallpaper as plain white; a blurred
  picture showed a pale edge inside the thread.
- **Legible.** The encryption note under the composer, the seen tick on a light
  bubble, the QR density line and the counts in the filter chips were between 1.9:1
  and 2.8:1 and are now at least 4.4:1; icon buttons have names for a screen reader;
  a disclosure line is at least 28 px tall; two links to other sites carry
  `rel="noopener noreferrer"`. No `ResizeObserver loop` error any more.
- **Server.** `/sw.js`, the manifest and `/relay-speed` were served without HSTS,
  `nosniff`, `Referrer-Policy` and `Permissions-Policy` (nginx drops every inherited
  header when a location adds one); each repeats the set. The relay removes the file
  holding the first password before it answers that the password was changed.
- **Build and tests.** The native web payload could not be prepared (a file of the
  project this app was cut from was required). `tests/regression.mjs` is the
  regression gate (isolated stack per suite, flakes named, quarantine and
  not-runnable declared with reasons); `docs/REGRESSION.md` has the method and the
  audit, `docs/SUITES.md` every suite.

# P00RIJA Chat 2.4.0

Version 2.4.0 · build chat-v8

A picture is a picture now: sent as one, seen in the thread, opened, saved, turned,
cropped. A locked app stays connected, a message can be written with no connection
and goes by itself, and the top of every screen is one colour, on an iPhone and in
Chrome on Android.

- **Photos.** The gallery button opens a sheet with the pictures, a caption, and a
  choice between Photo and File. A photo is redrawn at no more than 2560 px (which
  also leaves behind what the camera and the place stored in the file) and arrives
  in the thread as the picture, with its caption under it; a GIF is sent as it is
  so that it keeps moving. A tap opens a viewer: pinch and double-tap to zoom,
  swipe between the photos of the conversation, drag down to close, Save (the share
  sheet on a phone), Share, Forward, and Edit, which turns, flips, crops to a shape
  and adjusts brightness, contrast, saturation and warmth, then sends the result or
  saves it. The receiver looks at the bytes before drawing a picture, so a file that
  only says it is one is drawn as a file. On the wire a photo is the file message it
  always was with a flag, so an older build shows a file.
- **Your profile picture** opens in the viewer first, with Save, Edit and Change.
- **A locked app stays connected.** Every path that repairs the connection asked
  whether the vault was open, so a socket that died while the phone was locked was
  not repaired until the password was typed. A locked app now makes only the relay
  socket again; the full build, the relay-identity question and the peer rebuild
  still wait for the person. The relay socket also no longer waits for PeerJS to
  open: on a network where `/peerjs` never answered the app said "Connecting" for
  good with the relay reachable and nothing could be sent or received.
- **Writing with no connection.** The send, file and voice buttons were disabled
  when the relay was down, which is when a message most needs somewhere to wait.
  A text is queued; a small file, photo or voice note is kept and sent from the
  vault copy when the connection is back, also after the app was closed and opened;
  a message to a group is retried. The notice says "waiting for the connection",
  and "went through the relay" only when it did.
- **World clocks kept.** A saved city was gone after every relaunch: the read
  touched a constant before its script had run, the error was swallowed, and an
  empty list was kept in its place.
- **One colour at the top.** The bar under the phone's clock was a translucent glass,
  the lock screen a gradient over a flat strip, a light theme left a pale strip over
  the dark lock screen, and changing the theme faded each at its own pace. They are
  one flat colour now, and nothing fades while the theme changes.
- **Chrome on Android.** The page is dark from the first byte: the canvas is declared
  dark until the stylesheets arrive (Chrome shows its own, white, canvas until then),
  the saved theme no longer paints the start screen pale, and the browser's bar
  (`theme-color`) is the dark of the start screens instead of the light theme's white.
  The install screen is no longer cut off at the top on a short phone, and runs left
  to right when the language is English.
- **Settings.** The profile card is centred (picture, name, status, connection,
  clocks, three actions). Local is a row of Settings, and a tab of the bar if you add
  it there (Appearance, Tab bar).
- `docs/PROTOCOL-ROADMAP.md` lists the protocols the leading messengers use, the new
  ones still being written, and what fits this app.

# P00RIJA Chat 2.3.1

Version 2.3.1 · build chat-v7

The app stays connected when you come back to it, the world clocks keep every
city you add, the pages that still looked like the older app are Telegram's
pages, and the wide window is drawn like Telegram Desktop. The central panel
reads every server and draws its history.

- **Coming back to the app reconnects it.** A phone that slept left the transport
  in states nothing looked for, and the app stayed on "Disconnected" until it was
  closed completely: the late close of a socket that had been given up ran after
  a new one was up and printed "disconnected" over it, stopping its heartbeat; a
  connect suspended between two awaits stayed "in flight" for good and every later
  connect waited behind it; and a socket that said open was believed alive on no
  evidence. Each handler now belongs to its own socket, a stuck connect is dropped
  after 25 seconds, and an open socket has to answer a ping (4.5 seconds) before it
  is trusted. Checked on return to the foreground, on `pageshow`, `resume`, `focus`
  and `online`, and every 10 seconds while the page is in front.
- **World clocks.** The page read the chat's state as `window.chatState`, which
  does not exist, so it never saw a clock kept and every city replaced the one
  before. Two cities are kept, listed on the page and shown on the profile card.
  The same lookup is fixed for your name and your stickers in Local Link.
- **Migration and backup, File manager, Help, About and the sticker packs manager**
  are drawn as Telegram draws its settings: a small header over each group, one
  rounded surface of rows, a sentence under it, and full-width buttons. The
  backup file to restore is a row, not the browser's English "Choose File".
  The chat wallpapers are a grid of thumbnails with the chosen one ticked.
- **Buttons.** What a page asks you to press (Connect, Reconnect, Discover local,
  Export and Import the connection config, the status report) is a button in
  Telegram's shapes (filled, tinted, red), not a row of a menu.
- **The profile card** is laid out in tiers: the picture, the name with your status
  beside it, the connection, the clocks across the card, and three actions.
- **An empty list of chats** says so and has a Start chatting button that opens the
  same menu as the pencil.
- **The composer** keeps the plus on the left and send (the microphone while the
  field is empty) on the right in both languages, as Telegram's does, and the line
  under it says what the messages are encrypted with.
- **Android.** The installed app's start screen and the system navigation bar took
  the manifest's light grey; both are the app's dark now.
- **Desktop.** The open chat is a solid blue row, the messages are a centred column,
  the header is plain and the composer is docked under the messages.
- **The central panel** reads a server that names no folder of its own (it looked
  for `~` inside quotes and never found the password), draws the last hours of every
  server again after a restart instead of one dot, runs on port 1223 in its own
  volume, and says P00RIJA Chat.
- **Repository.** Commits are refused unless they are authored and committed by
  p00rija and carry no trailer (`tools/git-hooks`), and a verified deploy updates
  the code graph.

# P00RIJA Chat 2.3.0

Version 2.3.0 · build chat-v6

The pages that still wore the older app's look are the new app's, Chat
appearance does what it says, and what was cut off or out of place on a phone
is where it belongs. Found by running the app on iOS 27 WebKit.

- **Settings, all of it, in Telegram's terms.** Privacy and security, Data and
  storage, Server and connection and My devices are rows and switches now, not
  the cards of the app this was cut from. The passcode row ("Off") and the whole
  shared-lock card are gone: the app already opens with your master password,
  and the controls that remain are auto-lock, biometrics and two-step
  verification. The Secure chat switch is gone from Server and connection (a
  messenger does not turn its messages off). The file manager's note no longer
  describes the shared lock.
- **World clocks open in Settings.** The row, and the clock on the profile card,
  open a page of Settings; they used to open a sheet in the Chats tab, which you
  saw only after leaving Settings.
- **The profile card is the size of the original's**: a 64pt picture, a 38pt
  button, a 20pt clock, the pixel companion.
- **Chat appearance works.** The chat's theme, bubble colours, transparency,
  corner radius, text zoom, wallpaper, blur, your own picture and the colours
  of the ticks were written as custom properties that the new bubbles did not
  read. They do now (`followAppearance` copies what was chosen; css/ui/30-thread.css
  reads it), and the live preview is the first thing on the page, kept in sight
  while you change an option under it.
- **Text size is a slider** (80% to 140%) and reaches the whole app: every size
  in the interface layer is multiplied by `--fs`, and the root font size follows,
  so rows, bars, bubbles and the profile card all grow. The font you pick was
  already everywhere; it was checked again on bubbles, composer, rows and bar.
- **Menus are solid**, not translucent: the three dots above a conversation, the
  menu behind the plus, the dialogs. The plus menu sits at the left, inside the
  screen, and never taller than what the keys leave (it opened at -194pt, off
  the screen, and under the keys it ran off the top). A reaction no longer hangs
  over the time of a bubble.
- **With the keys up the field sits on them.** A rule that cleared the home
  indicator held 34pt of padding under the field after the keys had taken that
  space; it was out-ranked. Toasts start under the island, measured from the
  device's own safe area, not twice.
- **Accepting a changed relay fingerprint** works even when the question had
  already been asked and was waiting; the button no longer depends on that.
- **Dialogs** have no ring on the focused button (it showed as a thick line).

Not checked: the real keyboard (the simulator would not raise it for a scripted
focus), the glass on a device, and the Telegram-style rework of the help pages.

---

# P00RIJA Chat 2.2.0 (earlier)

Version 2.2.0 · build chat-v5

What was wrong on a phone and on the desktop, found by running the app in the
iOS 27 simulator and in a desktop window instead of in one browser engine.

- **The bar of tabs sits lower** (a safe area plus a margin used to leave 44pt
  of nothing under it; it is 16pt now) and the space under the last row of every
  page is one clearance for the bar, not three on top of each other (a Settings
  page ended with 360pt of empty ground).
- **The glass is read off the system's own**: nearly clear, a little frosted, a
  ring of light that is brightest at two opposite corners, a faint glow inside
  the rim, and the selected tab a brighter piece of the same glass. The
  displacement the real thing adds needs an SVG filter Safari does not draw, so
  it is not attempted.
- **Settings starts with the profile card** of P00RIJA Cryptography: avatar and
  the pixel companion, name and status, connection, your clock and the cities
  you keep, and three doors (identity, profile, lock). Saved messages and Recent
  calls are no longer in Settings: Saved messages is in the menu of Chats, calls
  are the Calls tab.
- **Notifications and sounds is rows, like the pages beside it**: the switch,
  background notifications, and for each of the two sounds the choice and, on one
  line, Test, Custom sound and Remove. **One set of controls** for the whole app
  (`css/ui/57-controls.css`): the buttons, the switches, the checkboxes, the
  colour wells and the sliders look the same on a Settings page, in a sheet, on
  Local and in a dialog; a slider is as wide as its row and fills as far as its
  knob, from the right in Persian.
- **In a conversation** the plus and the microphone/send button are both at the
  left in Persian (the field takes the writing side), the time in a bubble no
  longer lands on the text in a right-to-left bubble (it did in Safari: a rule
  of lower weight lost to the base placement), and when the keys come up the
  conversation ends where they begin. The shell had stayed full height because
  this layer out-ranked the old rule that shortened it.
- **A call's buttons fit**: seven (video) share one capsule of glass instead of a
  fixed width that ran out of the screen; the hero no longer says what the
  header already says.
- **On the desktop** the tab rail is flat with a rounded-square lens (it could be
  measured as tall as the rail), and the conversation's column has no composer
  while nothing is open: in Calls it holds the call tools, centred.
- **The Telegram bot** the panel manages can be given its token and chat; see
  INSTALL-LINUX-SERVER.md.

Checked in the iOS 27.2 simulator (WebKit, dark and light) and a desktop window.
Not checked: the real keyboard (the simulator would not raise it for a scripted
focus; the layout was checked with the keyboard's height set), real glass on a
device, and the feel of the motion.

---

# P00RIJA Chat 2.1.0 (earlier)

Version 2.1.0 · build chat-v4

Settings drawn the way a messenger draws them, and a bar of tabs that moves like
the system's glass.

- **Settings are Telegram's.** You at the top, then Saved messages, Recent calls
  and My devices; Notifications and sounds, Privacy and security, Data and
  storage, Appearance, Language, Server and connection; Help and About me. Each
  is a page with a way back and a short list of rows, and the page you were on
  is kept when you go to another tab. Nothing on them belongs to the encryption
  suite this app was cut from: the algorithms, the order of tabs and the
  Security Center are gone from every page.
- **Your profile is one page.** Picture, name, status, key fingerprint, QR code,
  portable profile, linked devices: all of it where you are, with nothing that
  opens a sheet to edit.
- **One place for the lock.** The "shared lock" of sensitive sections is replaced
  by Privacy and security: the passcode, auto-lock and how long, hiding the
  screen when switching apps, biometrics and the passkey, two-step verification,
  the master password and recovery questions, and the emergency erase password.
- **Server and connection is rows**: the switches for connecting, relays and
  discovery; the relay's address and fingerprint; calls (video, noise removal,
  STUN) and the TURN server; and the actions. Read receipts and link previews
  moved to Privacy and security, where a messenger keeps them. **My devices**
  now lists the devices; it was showing an empty box.
- **The font you choose is the font you see**, and the text size now reaches the
  messages, the composer and the chat list, not only the pages.
- **The bar of tabs is glass that moves.** The selection is a lens that slides,
  stretches and settles with a spring when you change tab, and can be dragged
  from one tab to another. With reduced motion or reduced transparency set in
  the system it is a plain surface.
- **The dark theme is the one of P00RIJA Cryptography** (slate, not near-black);
  the light theme is a cool grey.
- **The screens before the app** (language, install, first password) can be
  read in the light theme: white text sat on a white card. The register screen
  shows the app's icon and "end-to-end encrypted messenger" in place of the
  shield and "advanced encryption suite".
- **About me** is in Settings, with the project's text.
- Smaller: the help page and the first-password screen no longer say
  "cryptography dashboard" and "master password panel"; the help search field
  showed a literal `…`; the Local status was not redrawn when the language
  changed; the grey unread badge, the sticker panel and the device chips were
  unreadable in the light theme; the eye and keyboard buttons of password
  fields sat over the first letters.

New diagnostics (not suites): `_shots-gate.mjs`, `_audit-contrast.mjs`,
`_check-font.mjs`, `_dump-page.mjs`. `messenger.mjs` now also checks that a
switch on a page is the app's own switch, that read receipts are on the privacy
page, that the devices page lists this device, and that the text size reaches the
messages.

---

# P00RIJA Chat 2.0.1 (earlier)

Version 2.0.1 · build chat-v3

- **The icon is the one drawn for it**: a padlock knotted with a speech bubble, in
  teal and blue on navy (`assets/ICON.png`). Every size the app uses is made from
  it: the install icons (192, 512), the maskable pair with the picture inside the
  safe zone, the home-screen icon (full-bleed, since iOS rounds it itself), the
  favicon and the macOS icon. It replaces the mark of 2.0.0.

---

# P00RIJA Chat 2.0.0 (earlier)

Version 2.0.0 · build chat-v2

A new interface, and an app of its own: the chat now looks and moves like the
messengers people already know, and nothing about it any longer belongs to
P00RIJA Cryptography but the files it can still open.

## The interface

- **The arrangement of Telegram and WhatsApp.** A bar of tabs (Chats, Calls,
  Groups, Local, Settings); under a large title, a search field and filters
  (All, Online, and so on); rows of an avatar, a name, the last message, the time,
  the unread count and a pin. A conversation has its header with the voice and
  video buttons, bubbles with the time and the delivery ticks inside them on a
  wallpaper, and a composer whose last button is a microphone until there is
  something to send. What a row used to show as seven buttons is on a long press
  or a right click.
- **The look of iOS 26/27.** Glass for the bars and menus only, a floating tab bar
  that becomes a rail on a wide window, grouped lists with a coloured tile for
  each icon, springs for motion, light and dark, and a fallback to plain surfaces
  where blur or transparency is off. Details and the reasons: `docs/DESIGN.md`.
- **Ticks that are drawn**: one tick sent, two delivered, two blue read, a clock
  while waiting, the same on every system font.
- **Left to right is left to right.** The chat's frame had `direction: rtl`
  pinned on it whatever the language, so an English chat was laid out backwards.
  It follows the page now, in both languages.
- **How it is built.** `css/ui/*.css` is compiled by `tools/build-ui-css.cjs` into
  one cascade layer of `!important` rules, which beats `css/styles.css` without
  an arms race of specificity. `node tools/build-ui-css.cjs --check` is the guard.
- **A new mark** in every size the app uses (replaced in 2.0.1).

## An app of its own

- **Its own ports**, so that it runs beside other stacks on the same machine:
  the app on **1122**, the relay on 11220 to 11222 (not exposed), TURN on 11478
  and 11349 with the relay range 40000 to 40500 (UDP).
- **Its own containers, network and compose project** (`P00RIJA-Chat_*`,
  `p00rija_chat_net`, project `p00rija-chat`) and images (`p00rija-chat*`). The
  project name is fixed in the compose files and in the scripts: a stack named
  after its folder (`config`) would have been taken by compose for the other
  app's and recreated.
- **Its own install directory** on a server (`work/p00rija-chat`) and settings
  directory (`~/.config/p00rija-chat/`).
- **Its own update source.** The relay's "new release" check and update used to
  look at the other app's releases and could have put them on a chat server.
- **Documentation for what it is**: `README.md` (and `README.fa.md`), `INSTALL.md`,
  `INSTALL-LINUX-SERVER.md`, `docs/PROTOCOL.md`, `docs/DESIGN.md`,
  `docs/MONITOR-SERVER.md`, `docs/RELAY-NETWORK.md`, `docs/DEVELOPMENT.md`,
  `HANDOFF.md`, `CONTRIBUTING.md`.

## Checked

- `tests/e2e/messenger.mjs` (34) now describes the new shell: the list's own head,
  a rail on a wide window and a floating bar on a phone.
- The protocol suites and the delivery, sibling, receipt, group and file suites
  pass on the new interface unchanged.
- `tests/e2e/_shots-chat.mjs`, `_shots-states.mjs` and `_inspect.mjs` are for
  looking: screenshots in both languages and both schemes, and the computed style
  of anything.

## Not done

- Native shells (desktop, Android, iOS) are not built; each needs its own bundle
  identifier, icons and signing.
- One key per connection rather than per message; no MLS for large groups; no
  independent audit. `docs/PROTOCOL.md` says the rest.

---

# P00RIJA Chat 1.0.0 (earlier)

Version 1.0.0 · build chat-v1

The first cut of P00RIJA Chat: the Secure Chat of P00RIJA Cryptography 2.98.95
as an app of its own.

## What it is

- The messenger, Local Link, the file manager, the security center, migration,
  settings, help and about. The relay, its monitor, and the install and deploy
  scripts came with it.
- The same protocol and the same relay as P00RIJA Cryptography 2.98.95, so the
  two apps talk to each other.

## What changed from the tree it was taken from

- Twenty tabs that are not the messenger were removed from the page, the
  sidebar, the mobile bar and the help, with `js/games.js` and `js/ssh-keys.js`.
- The app opens on the chat.
- `applySettings` no longer calls into the file-encryption panel. With the panel
  gone that call threw on every start, before the vault could be set up.
- Deploy and panel settings moved to `~/.config/p00rija-chat/`, and the default
  install directory on a server to `p00rija-chat`.
- The update check looks at this project's releases.

## Post-quantum

- **A live session's key comes from two secrets.** The exchange was ECDH on
  P-256, sealed under RSA — both things a large quantum computer breaks, and a
  conversation can be recorded today and kept until one exists. The offer now
  carries an ML-KEM-768 public key made for that exchange, the answer a
  ciphertext to it, and the session key is derived from the curve's secret and
  ML-KEM's together, so it falls only if both do. Each side signs what it sent,
  a contact seen to do this is refused the old exchange from then on, and the
  side that answers does not use the key until the other has confirmed it.
  `tests/e2e/hybrid.mjs`.
- ML-KEM-768 is `@noble/post-quantum` 0.7.1, bundled to `vendor/mlkem/`.
  `tools/check-mlkem.cjs` checks it against OpenSSL's: the same seed gives the
  same key, and each opens what the other encapsulates.
- **So does the seal on a message for somebody who is away.** That message
  waits on the relay until it is collected, which makes it the one thing this
  app sends that sits on somebody else's disk. A prekey now has an ML-KEM-768
  half, signed in with the rest, and the seal is made under a key derived from
  both. A prekey with both halves is not given up for one with only the first,
  so a relay cannot make a sender forget the second by repeating the prekey
  without it. A contact who publishes no second half is sealed to as before.
  `tests/e2e/prekeyhybrid.mjs`; `tests/e2e/forwardsecrecy.mjs` looks at the
  envelope the relay is actually holding.
- **And a contact who has that half is not sealed to with less.** The relay
  hands the prekey over, so a relay that left the second half out, handed over
  nothing, or let the prekey run out got a message sealed to the curve alone or
  to the identity key. For a contact once seen with both halves, nothing is
  sealed without them now: the message stays on this device, marked as waiting,
  and goes by itself when a signed prekey with both arrives. In a group, that
  member's copy is remembered as missed and sent then. The cost: a contact who
  has been away longer than their prekey lasts (fifteen days) cannot be left a
  message until they are back; and a file, a card or a poll for a contact in
  that state fails with a notice rather than waiting, as do receipts and call
  signalling by the relay. `tests/e2e/holdhybrid.mjs`.
- Not yet: there is one key per session rather than one per message. A contact
  never seen with a second half has nothing to stop a relay leaving it out, and
  a presence record is about 2.3 kB larger; what that does to a busy relay's
  peer list has not been measured.

## Security

- **A live session is keyed by the exchange or not at all.** An answer to the
  key exchange that arrived four seconds late made the sender wrap a key to the
  identity key, which never changes, and talk under it. Whoever carries the
  traffic decides how late an answer is, so holding one frame switched forward
  secrecy off. The wrapped key is no longer made, accepted, or revived from
  storage. `tests/e2e/downgrade.mjs`.
- **A prekey is signed, and checked before anything is sealed to it.** The
  prekey a message for an offline device is sealed to reaches the sender by the
  relay, and it travelled bare: a relay could hand out its own, open the
  message, and seal it again to the real one. It is now signed by the identity
  key and checked against the key pinned for the contact at the moment of use.
  `tests/e2e/prekeysig.mjs`.
- **A relay is answered with a signature, never by opening something.** To
  prove an identity the client opened a nonce the relay had sealed to its
  public key and sent it back. A message key for somebody who is away is
  sealed to that same key, the same way, and is the same 32 bytes: a relay
  could send the seal of an envelope it was holding as a "challenge" and be
  handed the message key by the recipient's own device. The client now signs
  the relay's nonce under a label nothing else it signs begins with, and opens
  nothing. A relay too old to ask for a signature gets no answer, so this
  client is not announced on one. `tests/e2e/oracle.mjs`.
- **Two devices of one account have a key owner.** With one fingerprint between
  them neither offered the exchange; their relay addresses now decide it.
- Still open: a relay can withhold a prekey, and the message is then sealed to
  the identity key — unreadable to the relay, but without the fifteen-day
  window. A contact on a build that does not sign its prekey is written to the
  same way.

## The shell

- One bar at the bottom — Chats, Calls, Groups, Local, Settings — in place of
  the sidebar and the chat's own menu. `tests/e2e/messenger.mjs`.
- The removed tools' code is out of `js/app.js` (28% smaller).

## What was run

`check:versions`, `check:assets`, `check:collisions`, `check:relay-parity`, and
these suites, each against its own relay, all passing:

chatonly, messenger, hybrid, prekeyhybrid, downgrade, prekeysig, oracle, devicegovern, forwardsecrecy, offline, siblingsync,
keyverify, grouptwo, contactcard, forwardall, sealedsender, delivery,
messagerequests, deleteconversation, profilesync, devicelink, stickermanage,
formatbar, composeextras.

siblingsync failed on and off while a session between two devices of one
account had nobody to offer the key exchange; it has passed every run since
that was given an owner.

`interop.mjs` opens a page from this tree and one from P00RIJA Cryptography
2.98.96 on one relay — once on this tree's relay, once on the other's — and a
live session and a sealed message cross each way, with each of the two as the
side that offers the key exchange. Between the two apps a session is keyed by
the curve alone and a message for somebody away is sealed to a P-256 prekey:
P00RIJA Cryptography has no post-quantum half to offer.

The other suites in `tests/e2e/` have not been run in this tree. Seven of them
still name something that was removed and will need adapting: release48,
chatticks, langswitch, locallink, native-shell, release37, nativeui.

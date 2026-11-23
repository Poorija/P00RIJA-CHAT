# Regression gate and audit

What is checked before a release, how, and what the first full audit found. The gate is
`tests/regression.mjs`; what each suite covers is in [SUITES.md](SUITES.md) (generated).

## Running it

```bash
node tests/regression.mjs                      # every guard and every suite, 4 workers
node tests/regression.mjs --workers 3          # fewer workers if the machine is slow (see "Load")
node tests/regression.mjs --only photos,push   # some suites
node tests/regression.mjs --area calls         # one area
node tests/regression.mjs --static             # only the guards (about a minute)
node tests/regression.mjs --list               # what would run, and what is declared not runnable
node tests/regression.mjs --allow-flaky        # a suite that passes on its retry is a warning
```

The report is written to `tests/regression-report/<stamp>/` (git-ignored): `report.md` (read this),
`report.json`, and one log per suite and attempt. The exit code is 0 only when everything that can
run passed.

One suite on its own, on an isolated stack: `node tests/e2e/_local-stack.mjs <suite>` (a suite run
directly with `node tests/e2e/<suite>.mjs` needs a static server and a relay already up).

## What makes it strict

1. **Isolation.** Every suite runs through `tests/e2e/_local-stack.mjs`: its own relay, its own
   stores, its own port block. One suite's leftovers cannot pass or fail another.
2. **A suite that proves nothing is not a pass.** No tally printed, or a tally of zero checks, or a
   non-zero exit with a clean tally, is `CRASH` or `EMPTY`.
3. **A failure is run again on a fresh stack.** If the second run passes the suite is `FLAKY`,
   named, with both logs, and `FLAKY` fails the gate: a test that sometimes lies is a defect of its own.
4. **Nothing is skipped silently.** A suite that cannot run on this machine is in `NOT_RUNNABLE`
   with the reason (no docker, no WebKit, no `src-tauri`, needs two deployments). A suite on disk
   that is neither run nor declared fails the gate itself.
5. **Quarantine is a debt, not a pass.** A suite known to fail for a reason that is not the app's is
   in `QUARANTINE` with that reason. It still runs, is reported apart from the passes, and the gate
   **fails when a quarantined suite passes**, so nothing stays there after it is mended.
6. **Guards first**: every shipped script parses; every suite and helper parses; each
   `check:*` script of package.json (versions, assets, UI build, collisions, relay pins, relay parity, ML-KEM).

### Load

The suites drive real browsers. On four workers a ten-core laptop runs at a load average of 20–50,
and timing-based checks flake (the first full run had 4 `FLAKY` and several suites that failed only
under load and passed alone). Use `--workers 2` or `3` for a result you can trust; the retry exists
to *name* what is load-sensitive, not to hide it.

## Areas

`calls`, `groups`, `stickers-gifs`, `qr`, `push-notifications`, `security-crypto`,
`delivery-offline`, `relay-network`, `panel-monitor`, `install-update-native`, `ui-messaging`
(the pattern for each is `AREAS` in the gate; SUITES.md lists the suites under each).

Beyond the per-feature suites there are suites that know no feature and ask the same questions of
every screen:

| suite | asks | of |
| --- | --- | --- |
| `sweep` | errors, overflow, clipped text, target size (24px), accessible names, overlap, raw values (`undefined`, an untranslated key), broken images, duplicate ids, contrast (hard floor 3:1; text between 3:1 and 4.5:1 is counted and may only go down), the wrong language | every tab, every Settings page, a conversation and its sheets, in Persian and English, at 320–1280px, in all fifteen themes |
| `i18nparity` | a key missing from one language table, written twice with different words, named by `data-i18n*` and defined nowhere, empty, or left in the other language | `js/app.js`, `index.html` (no browser) |
| `sourceaudit` | duplicate ids, dangling labels, images without alt, links without `rel`, inline handlers and inline scripts (counted; may only go down), manifest icons that exist at the size they claim, every link and every command in every Markdown file | `index.html`, `manifest.webmanifest`, the documents (no browser) |

## The audit of 2026-11-16

Method: one full run of all 225 suites to a baseline (162 passed first time; 63 did not), then every
non-passing suite read and classified — **a defect of the app**, **a suite that guards something
that has since changed on purpose**, **the environment** — and each defect fixed with a test that
fails without the fix.

### Defects of the app, found and fixed

| # | what a person met | cause | commit |
| --- | --- | --- | --- |
| 1 | A message from a stranger could be neither accepted nor blocked: the request card was below the screen; and Accept was white text on a white button | a rule for every child of the thread made the card `position: relative`; the card was drawn in the legacy dark colours | 7e9d027 |
| 2 | A voice message could not be sent from the button: a tap started a **second** recording | "nothing to send" was decided from the text box alone, so with a recording waiting the button stayed a microphone | a8a121c |
| 3 | A frozen phone read as online to the app; "seen" was said of messages not yet read off the wire | the presence table the app lives on (first whole table and every delta) is built from a record that left out whether a peer is awake, so the relay never announced a change | 4cad6c0 |
| 4 | `/sw.js`, the manifest and `/relay-speed` were served without HSTS, `nosniff`, `Referrer-Policy`, `Permissions-Policy` | nginx drops every inherited `add_header` the moment a location adds one of its own; three locations did | 4cad6c0 |
| 5 | The native bundle could not be prepared at all | `scripts/prepare-tauri-web.js` required `js/ssh-keys.js`, a file of the parent project | a8a121c |
| 6 | The live preview in Settings showed the wallpaper just chosen as plain white | the rule that makes a legacy block's children white cards also made the preview one | 8614cec |
| 7 | A blurred picture background showed a pale soft edge inside the thread | the layer was inset by one blur; a blur fades over about two | 8614cec |
| 8 | Changing language half-way through setting a password cleared the three security questions | the options were rebuilt and the choice kept only for the settings group | a7b63df |
| 9 | After a language change the identity QR and start-chat sheets stayed in the old language | built on first use with that moment's words, then cached | a7b63df |
| 10 | Text a reader could not read: the encryption note under the composer (2:1 on the light theme), the seen tick (2.3:1), the QR density line, the unread/filter counts (2.6–2.8:1) | tokens at 55–75% opacity | 7e9d027, 8614cec, a7b63df |
| 11 | Icon-only buttons with no name for a screen reader (header More, the two sheet close buttons); a disclosure line 22px tall | missing `aria-label`; no minimum height | 7e9d027, 8614cec |
| 12 | `ResizeObserver loop completed with undelivered notifications` in every log | five observers wrote a size back inside the callback; each now runs on the next frame, once | 8614cec |
| 13 | The English appearance preview showed Persian digits; the Persian table held `unlock` twice with different words | static markup; a duplicate key | a7b63df, 7e9d027 |
| 14 | Two links to other sites without `rel="noopener noreferrer"` | markup | 7e9d027 |
| 15 | The dev server served the monitor client under the app's policy, so it failed with "Failed to fetch" against any address but `localhost` | no native config to read, fall back to the app's `connect-src` | a7b63df |

### Suites that guarded something that changed on purpose (repaired, so the behaviour is guarded again)

Forty suites were repaired or retargeted, and four written (`voicesend`, `sweep`, `i18nparity`, `sourceaudit`, with the shared `_push-proof.mjs`). The patterns, which are the useful part:

- **The relay now asks for proof.** `/push/subscribe` takes no fingerprint's word for it (a challenge
  answered with the identity key). Five push suites sent bare subscriptions and got 403, which read as
  "the push never fires". They use `tests/e2e/_push-proof.mjs`. The proof is a hardening worth keeping; the suites were the stale party.
- **The relay rate-limits `get-peers`** (a burst of three, then one per ten seconds) and the app is
  sent deltas. `awaypush` polled and read the broadcast the way the app does.
- **Isolation inherited by a relay a suite starts itself.** `relayscale` and `retention` read an
  empty directory because the isolated stack's `CHAT_OFFLINE_STORE_DIR` came along into their relay.
- **Names that changed when the app became its own**: image names (`p00rija-chat…`), the TURN port
  (11478), the relay port (11220), the update checker's Linux archive, the version number (2.4.x).
- **Things that moved in the redesign** (the rail became the Settings pages; the chat list's row
  markup; the thread's wallpaper layering; the file manager moved to the Data page; the lock gate
  became the shared section gate): suites that read the old markup now read what the person sees.
- **The parent project's tools** (a converter, SSH keys, a password manager, a twelve-tab sidebar)
  no longer exist here: thresholds and dropdown lists that named them were retargeted or found by query.
- **A suite that outlived its stack.** `lockdefence` opened a second browser through the harness and
  never closed it, so the run read as a timeout after 28 passing checks.

### Not runnable on this machine (declared in the gate, with the reason)

`twoservers` (needs two real deployments), `native-shell` and `nativeui` (need `src-tauri/`, which this
repository does not contain — the native shell's sources are not part of the standalone tree),
`chatnavfit`, `history-restart`, `panelui` (need Playwright's WebKit/Firefox: `npx playwright install webkit firefox`).
Suites that need docker report the same when it is absent.

### Quarantined (known stale, a debt)

See the "Quarantined" section of each report. Seven: `callreal`, `chataudit`, `controls`, `formatbar`,
`release37`, `sileotoasts`, `uxfixes`. Each entry names what is wrong with the suite, not with the app.

### The five findings that were open after the audit

Five suites had been quarantined as possible app defects ("to be looked at"). Each was looked at. Four were the suite, not
the app (and one of those a design the suite misjudged); the fifth is a capacity question this machine cannot settle, and
stays open for a Linux host. All five are out of quarantine and in the gate.

1. **`calllayout`** (2 of 31). *The desktop receives the phone's portrait stream:* the suite asked Chromium's fake camera
   for 720 × 1280 with an `ideal` constraint, which the fake device ignores (it answers 640 × 480), so no portrait picture
   ever travelled and the desktop correctly drew a landscape one "cover". The picture is now drawn on a canvas and captured,
   and a new check says the desktop letterboxes a tall picture in a wide window (it does: `contain`).
   *Header controls "wrap onto three rows":* at phone width the encryption badge and the quality pill are taken out of
   the row and stacked under the header with the safety-code strip (`css/styles.css`, the narrow-screen block). That looks
   deliberate, so the check now asks that the controls share one row and that what is stacked under it is on screen and
   overlaps neither the controls, nor each other, nor the self-view. The owner looked at it
   (`tests/e2e/screenshots/call-phone.png`) and decided on 2026-11-17 to leave them stacked, so the check stands as written.
2. **`guestmode`** (75 checks, three relays). It was never failing the move itself. It runs 725 s alone against a 600 s limit
   (the gate killed it; the last snapshot in the log read as "the follower never connects"), so it has the heavy limit.
   Two real flakes under load were then found with the diagnostics now in the suite: the harness handed a port back to the
   operating system before using it (`freePort()`), and another suite's browser took it (`EADDRINUSE` at the start of the
   move section), so listening retries on a collision; and the second device was pointed at home *before* linking had
   finished, then pointed back at alice's door by the settings the link hands over as it ends, a door the test filters
   next, which read as "the other device never follows" (connection resets, home's log silent). The link finishes first now.
   The move section passes 16 of 16 under ten busy loops (it failed 3 of 3 before the reorder); the whole suite, alone, 75 of 75.
3. **`linkroomfit`** (1 of 35 alone, 11 under load). The suite never got past the first-password screen and, on a phone's
   user agent, the "install this app" gate, both of which sit over every tab, so the scan preview was measured inside a
   `display: none` tab (0 × 0). It signs in now. *After a room, scanning again* (the finding's own words) is now a check made
   with the buttons a person has — "cut and start over", then scan — and the preview is 331 × 186 with frames. The pairing
   took a fixed six seconds, which a busy machine does not give; and once, in a gate run, a WebRTC connection failed one-way
   (one side held the other, the other held nobody) and did not mend by waiting. The suite waits for the connection and
   starts over (up to three attempts, the count is in the check's detail). That one-way failure has not been reproduced
   since; in five runs under a load average of 50–95 the first attempt always connected.
4. **`release48`**. Written for the parent project's twelve tabs ("more than ten offered", Passwords and Notes). This app has
   eight: three always covered and five that can be added (`locallink`, `migration`, `securitycenter`, `help`, `about`);
   the suite asks for those. 26 of 26, nothing in the app changed. The old note asked whether the chat lock gate being
   full-bleed while the vault and settings gates are inset was by design; the owner decided on 2026-11-17 that it stays as it is.
5. **`prodready`** (a Docker relay with 2 CPUs, 4000–8000 sockets) — **open for a Linux host.** In the container (through Docker
   Desktop) the relay "lost" 4–50 of 12,000–16,000 messages at 6000–8000 sockets, with p99 of 1.4–5.9 s. Looked at:
   a fixed six-second wait counted late messages lost (it now waits for stragglers); what still never arrived involved a
   socket that had closed (`bothOpen: 0` in every run — no message was lost with both ends open), the closes were all code
   1006 (no close frame), and the relay's log has no reap, refusal or overflow line for them. The same relay, the same load
   generator and the same machine **natively**: 8000 sockets, 15,998 of 15,998 delivered, none closed, p99 107 ms.
   So the sockets end somewhere between the generator and the relay inside Docker Desktop, not in a path the relay logs;
   that is likely the VM's port forwarding, but it was not shown, and it is not shown that a Linux host is clean. The load
   generator also gives way at about 3000 sockets in the container. So off Linux the two sections that measure how many
   people the relay carries (`steady`, `capacity`) are not run unless asked (`PROD_CAPACITY=1` or `PROD_ONLY`); the run says
   so, the gate lists it under "Ran in part" in the report's summary, and the other four sections — security, persistence,
   leaks, abuse; 19 checks — run and pass. Capacity is **not certified** by this machine. (`PROD_LOGS=<dir>` keeps each relay's
   whole log.)

### Known debts, measured and fenced

- **Inline handlers and scripts.** `index.html` has 139 inline event handlers; the policy still allows
  them (`script-src 'unsafe-inline'`), which an injected script would use too. `sourceaudit` counts them and
  fails if the number grows. Replacing them with listeners is what allows dropping `'unsafe-inline'`.
- **Low-contrast text.** 106 distinct places between 3:1 and 4.5:1 (two languages, fifteen themes, five sizes), the same
  number on two runs of the 2.5.0 tree; it was 383 on 2026-11-16, before the 2.5 token set moved the dark themes' reds,
  oranges and blues off the grey cells. `sweep` fails if the count grows, and fails on anything below 3:1.
- **No unit tests.** jest is configured and there are no `*.test.js` files; every behaviour is covered end to end.
- **The native shell** is not in this repository (see above).

## Adding a test

A suite is `tests/e2e/<name>.mjs`: a header that says what it checks, `createChecks()` from `_check.mjs`,
and a last line that prints `===== N failed of M =====` and exits non-zero on failure. Start it with
`startTwoStacks()` for two clients on isolated relays, or `openApp()` for one. A new suite is picked up by
the gate on its own and must appear in SUITES.md (`node tools/suite-catalogue.cjs`). It must fail on the
code it was written for: run it against `git archive HEAD~1` before relying on it.

Measure; do not snapshot. A rectangle, a computed colour, a byte on disk, what is painted at a point
(`document.elementFromPoint`) — each of the bugs above was found because something was asked of the page
that a screenshot would have shown only to a reader who knew where to look.

## Last full run

2026-11-16, 3 workers, on the committed tree (a5f8c80), after the audit above:

- **guards: 9 of 9.** Every shipped script and every suite parses; the seven `check:*` guards pass.
- **suites: 223 run — 209 passed first time, 1 flaky, 1 crashed, 12 quarantined; 6 declared not runnable.**
- **checks: 5132 of 5172 passed** (the 40 that did not are the quarantined suites' own, listed above, and the crash).
- The two that were not clean were then repaired and run again, on the tree that is committed now: the
  sweep's count of low-contrast places differed between two identical runs (734 and 806) because a
  screen fading in is read at partial opacity, so the sweep finishes what animates before it reads
  (383 on both of two parallel runs, on the 2.4.1 tree); and `upgrade` was interrupted by the service worker on the first
  navigation of a fresh profile under load, and asks again once. Run again on the committed tree
  (`--only sweep,upgrade`): both pass first time — sweep 15 of 15 in 817 s, upgrade 38 of 38 — with the 9 guards.
  Every other suite is as the full run above left it; the tree has changed since by those two suites and this document only.
- After that, the five open findings were looked at (above) and the quarantine is down from 12 suites to 7 (`prodready` is in the gate but runs in part off Linux). Through the gate
  with three workers: `linkroomfit` 35 of 35, `release48` 26 of 26, `guestmode` 75 of 75 (773 s) and `prodready` 19 of 19
  (in part: not its capacity sections) passed first time; `calllayout` failed its first attempt, because it waited a fixed twelve seconds for a ring and seven for the
  picture, and was then made to wait for the call instead — three of three first-time passes at a load average of 96.
  The other suites in this run were not run again, and nothing in the app changed.
- Before the audit (4 workers, a tree with its suites stale): 162 of 225 passed first time, 4 flaky,
  42 failed, 16 crashed, 1 timed out; 4793 of 4923 checks.

By area (suites, of which passed first time): calls 25 (23), groups 4 (4), stickers-gifs 12 (12), qr 6 (6),
push-notifications 9 (9), security-crypto 32 (31), delivery-offline 28 (28), relay-network 25 (25),
panel-monitor 12 (12), install-update-native 11 (9), ui-messaging 59 (50); the rest of each area is the
quarantined and the not-runnable, named above.

Not covered here, and said so: a physical iPhone or Android phone (the layout was looked at in the iOS
simulator's WebKit and in Chromium, not on a device), the native shell, two real deployments, WebKit and
Firefox through Playwright, and any load beyond what one laptop can generate.

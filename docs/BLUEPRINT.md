# P00RIJA Chat — Project Blueprint

> **Document type:** complete project reference (product requirements, architecture, protocol, data model, interface, operations, history, open work) — written to be read cold by a human or by any AI model that has never seen the repository.
> **Describes:** P00RIJA Chat **2.3.0**, build tag **`chat-v6`** (git `b0e118d`, 2026-11-14).
> **Repository:** `P00RIJA-CHAT/` (its own git repository, branch `main`, 20 commits, not pushed to any remote).
> **License:** GNU AGPL-3.0-only.
> **Language of this file:** English. User-visible strings quoted from the interface are shown in Persian (fa) where that is the original, with the English counterpart.

---

## How to use this document

If you are an AI model asked to work on this project, read in this order and stop when you have what you need:

1. **§1 What it is** and **§2 Rules of the house** — thirty seconds, prevents the expensive mistakes.
2. **§4 Repository map** — where everything lives.
3. The section for your task: protocol (**§7–§9**), relay (**§10–§12**), interface (**§13–§17**), settings (**§18**), tests (**§22**), operations (**§23–§26**).
4. **§28 Known gaps and open work** before you promise anything.
5. **§29 Gotchas** before you edit anything.

Conventions used below: `code` is a file, identifier, command, header or storage key; **bold** marks a rule or a decision; “fa/en” means the app ships both a Persian and an English string. File paths are relative to `P00RIJA-CHAT/`. A line count is the count at the time of writing and will drift; the file name will not.

**Nothing in this document is a secret.** It contains no password, key, token, IP address, host name or SSH detail. The only personal identifier is the public author line (`p00rija <p00rija@tutamail.com>`) that already heads every source file. Where a value is secret (the Telegram bot token, the operator’s chat id, server credentials), only the *place* it lives is named.

---

## Table of contents

1. [What it is](#1-what-it-is)
2. [Rules of the house](#2-rules-of-the-house)
3. [History](#3-history)
4. [Repository map](#4-repository-map)
5. [Architecture at a glance](#5-architecture-at-a-glance)
6. [Technology and dependencies](#6-technology-and-dependencies)
7. [Identity, vault and storage on the device](#7-identity-vault-and-storage-on-the-device)
8. [Live conversations: the key exchange and message protection](#8-live-conversations-the-key-exchange-and-message-protection)
9. [Messages for people who are away: prekeys, seals, mailboxes](#9-messages-for-people-who-are-away-prekeys-seals-mailboxes)
10. [The relay (`scripts/server.js`)](#10-the-relay-scriptsserverjs)
11. [Several relays](#11-several-relays)
12. [Calls](#12-calls)
13. [The interface: concept and design system](#13-the-interface-concept-and-design-system)
14. [The interface: shell, tabs, lists, conversation, composer](#14-the-interface-shell-tabs-lists-conversation-composer)
15. [The interface: calls, groups, Local](#15-the-interface-calls-groups-local)
16. [The interface: glass, motion, themes, text size, languages](#16-the-interface-glass-motion-themes-text-size-languages)
17. [The interface: desktop layout (≥ 1000 px)](#17-the-interface-desktop-layout--1000-px)
18. [Settings, page by page](#18-settings-page-by-page)
19. [Features in detail](#19-features-in-detail)
20. [Local Link: chat with no server](#20-local-link-chat-with-no-server)
21. [Telegram integration](#21-telegram-integration)
22. [Tests and guards](#22-tests-and-guards)
23. [Build, versions, releases](#23-build-versions-releases)
24. [Deployment and the fleet](#24-deployment-and-the-fleet)
25. [Monitoring and the central panel](#25-monitoring-and-the-central-panel)
26. [Server configuration reference](#26-server-configuration-reference)
27. [Data and storage reference (on the device)](#27-data-and-storage-reference-on-the-device)
28. [Known gaps and open work](#28-known-gaps-and-open-work)
29. [Gotchas that cost a day each](#29-gotchas-that-cost-a-day-each)
30. [Verification status of this document](#30-verification-status-of-this-document)
31. [Appendices](#31-appendices)
   - [Appendix A — Every script, in load order](#appendix-a--every-script-in-load-order)
   - [Appendix B — Every end-to-end suite](#appendix-b--every-end-to-end-suite)
   - [Appendix C — Relay HTTP surface (`scripts/server.js`, all behind nginx on :1122)](#appendix-c--relay-http-surface-scriptsserverjs-all-behind-nginx-on-1122)
   - [Appendix D — Relay WebSocket message kinds](#appendix-d--relay-websocket-message-kinds)
   - [Appendix E — Glossary](#appendix-e--glossary)

---

## 1. What it is

**P00RIJA Chat is an end-to-end encrypted messenger** — one-to-one chat, groups, voice and video calls (one-to-one and group), file and media transfer, stickers, and chat on the same Wi-Fi with no server at all — delivered as a **web app that installs to the home screen** (PWA), plus a **relay server the operator runs**. There is no phone number, no account with any company, no cloud. The relay moves sealed envelopes and holds the ones for people who are away; it cannot read any of them.

It is **independent** of its parent project, *P00RIJA Cryptography* (an encryption-tool suite of which this was the “Secure Chat” tab). It has its own repository, port (**1122**), containers (`P00RIJA-Chat_*`), compose project (`p00rija-chat`), settings directory (`~/.config/p00rija-chat/`), release numbering and icon. The two apps can still talk to each other through one relay (`tests/e2e/interop.mjs`); between them the key exchange falls back to the classical one, because the parent has no post-quantum half.

**Audience.** People who want a messenger whose server operator (a friend, themselves) cannot read anything and cannot be forced to; Persian speakers first (right-to-left is first-class), English second.

**Platforms.** Any current browser; installed as a PWA on iOS (Safari, “Add to Home Screen”), Android (Chrome/Edge/Samsung), macOS/Windows/Linux (Chrome/Edge install). **Native shells (Tauri desktop, Android, iOS) are not built** — the repository contains scripts for them inherited from the parent, but no shell project; see §28.

**Interface language.** Persian and English, switchable at runtime; the page `dir` follows the language. Light and dark themes (plus automatic), Persian-first typography (Vazirmatn) with a font picker.

### 1.1 Feature inventory (what a user can do)

| Area | Capabilities |
|---|---|
| **Chats** | Text with replies, edits, reactions, forwarding, pins, in-conversation search and global search, inline formatting (`*bold*`, `_italic_`, `~strike~`, `` `code` ``, `\|\|spoiler\|\|`), link previews (opt-in, relay-fetched), drafts per conversation, scheduled messages, self-destructing messages (timers 10 s … 10 h), hidden messages, view-once media, polls, stickers (Telegram import, local packs, animated) and GIFs, voice messages (waveform, preview, optional voice effect), photos/videos/files of any size, location once or live, contact cards, **Saved messages** (notes to yourself), per-conversation lock (PIN), mute/pin/archive/block, message requests from strangers. |
| **Calls** | One-to-one voice and video, group voice/video (mesh), screen sharing, reactions and raised hands in group calls, noise suppression, camera flip, speaker, call log with sections (all/incoming/outgoing/missed), verification emoji shown on both screens, adaptive path (direct → TURN). |
| **Groups** | Roster with roles (owner/admin/member) and per-member permissions, mentions, invite codes, avatar/description, group calls, “Requests” inbox for groups put on you by strangers. Messages are sent to each member separately (no shared group key). |
| **Local** | Chat and calls with people on the same Wi-Fi, no server: pairing by QR or clipboard, rooms up to 16 people. |
| **Multi-device** | A primary device and linked devices on one identity: signed device roster, link by QR, sibling sync of history and files, revocation. |
| **Privacy** | Master-password vault, decoy (duress) profile, emergency erase password, auto-lock, screen guard, biometric/passkey unlock, TOTP two-step, safety numbers (emoji + QR), key-change blocking for verified contacts, metadata stripping on files, sealed-sender envelopes, envelope padding. |
| **Operator** | Dashboard (`/Monitor_Server`), Telegram bot (status, alerts, commands), central panel for a fleet, installer endpoint, backups, updates, TURN, transit links between relays, mirrors and front doors for blocked networks, guest relays. |

### 1.2 What it is not

No phone-number identity, no contact upload, no cloud history, no server-side search, no bots/channels, no payments, no ads, no telemetry. Not audited (see `SECURITY.md`, §9, §28).

---

## 2. Rules of the house

These are standing instructions from the project owner. They override defaults.

1. **Commits** are authored **and** committed as `p00rija <p00rija@tutamail.com>`, with **no** `Co-Authored-By` trailer and **no** mention of any tool or assistant in commit messages or code. A **release is two commits**: first the change (`feat:`/`fix:`/`refactor:`/`test:`/`docs:` …), then a commit that **only** moves the version (`release: X.Y.Z — summary`).
2. **Never push** unless asked. Never commit unless it is part of the established flow (change then release) or asked.
3. **Deploy to the fleet when asked** (`bash scripts/deploy.sh --server NAME --yes`), then verify with `bash scripts/deploy.sh --check` — **the exit code of a deploy is not a verdict**.
4. **A security fix is a test that fails first** — the attacker is played in a real browser (`downgrade`, `prekeysig`, `oracle`, `holdhybrid` are the pattern) — then the fix. Crypto changes are agreed with the owner before implementation.
5. **Both languages for every string** a person reads: `t('persian', 'english')`.
6. **Never edit a served file while a suite runs** (the suites load the working tree) and never run two suites on one port.
7. **Never put a secret in the repository**: tokens, passwords, keys, chat ids and SSH details live outside it (`~/.config/p00rija-chat/`, server `.env` files, server data directories). `.env`, `certs/`, `data/` are git-ignored.
8. **Do not touch the parent project** (`P00RIJA-Cryptography/`) from here. It is a separate app.
9. **Do not rename the identity-card prefixes** (`poorija-chat-v1:` legacy/current card format, `poorija-chat-v3:` QR identity prefix) and keep fields that still say `P00RIJA Cryptography` inside cards, backups and exports: changing them makes one app refuse the other’s files.
10. **The UI is Telegram’s in arrangement, iOS 26/27 in drawing.** Anything new follows `docs/DESIGN.md` and the rules in §13.
11. **The user speaks Persian**; answers in this project’s working conversations are given in Persian, terse. Documents in the repository are English (and Persian where a Persian twin exists: `README.fa.md`, `SECURITY.md`).

---

## 3. History

### 3.1 Origin

*P00RIJA Cryptography* is a large single-page web app (about two dozen tools: file encryption, password manager, secret sharing, steganography, QR tools, a “Secure Chat” tab with calls, a desktop/mobile/native build matrix, a monitor, a deploy system). **On 2026-11-12 its Secure Chat at version 2.98.95 was cut out as an app of its own** and released as **P00RIJA Chat 1.0.0** (commit `6fb8aed`): the messenger, Local Link, the vault and the relay, without the encryption-tool suite.

The chat module had been one 22,096-line IIFE (`js/chat.js`); it was split into ordered classic scripts by `tools/split-chat.cjs` (a Babel-based splitter that asserts the concatenation reproduces the original byte for byte). The split is why the code lives in `js/chat/NN-*.js` sharing one global scope (see §29).

### 3.2 Chronology (git history)

| Date | Commit | What |
|---|---|---|
| 2026-11-12 | `6fb8aed` | **1.0.0** — the Secure Chat as an app of its own. |
| 2026-11-12 | `0148619` | One bottom bar instead of a sidebar plus a second menu (Chats, Calls, Groups, Local, Settings). |
| 2026-11-12 | `f19d73f` | Removed tools’ code taken out of `js/app.js` (the page had lost twenty tools; the script kept their functions). |
| 2026-11-12 | `3cf2d94` | **Security:** nobody on the path can talk a live session out of forward secrecy (a kex answer delayed four seconds made the sender wrap a key to the never-changing identity key). Legacy chat-key path removed. |
| 2026-11-12 | `e719e5a` | **Security:** a relay cannot hand out a prekey of its own — prekeys are now **signed** by the identity key and checked against the pinned key. |
| 2026-11-12 | `d67255a` | **Security:** a relay cannot borrow a device’s private key — identity proof became *sign a nonce*, never *open whatever was sealed to you* (the oracle). |
| 2026-11-12 | `840fec7` | **Post-quantum live key exchange:** session key from ECDH P-256 **and** ML-KEM-768 together (`kex-offer/3`, `kex-answer/3`). |
| 2026-11-12 | `8227e9e` | A contact seen doing the hybrid exchange stays known as one after the app is closed (persisted pin). |
| 2026-11-12 | `6d8c8e5` | **Hybrid offline prekeys:** messages for people away are sealed under two secrets (ECDH + ML-KEM-768). |
| 2026-11-12 | `9cc28e2` | Interop suite: this app and P00RIJA Cryptography talk to each other. |
| 2026-11-12 | `4941860` | A contact who can open a post-quantum seal is not sealed to with less; the message waits instead (`prekeyHybridOwed`). |
| 2026-11-13 | `9cc4acb` | **2.0.0 — a new interface and an app of its own** (Telegram/WhatsApp arrangement, iOS 26 drawing), port 1122, own containers/docs/installer/monitoring. |
| 2026-11-13 | `06b560d` | The deployment DOM audit stopped on 48 leftover element ids; list reconciled. |
| 2026-11-13 | `b3b9a99` | **2.0.1** — the app’s icon (padlock knotted with a speech bubble). |
| 2026-11-13 | `9d419be` / `5cc562c` | **2.1.0** — Telegram-style Settings, Liquid-Glass tab bar with a sliding lens, slate dark theme, text size reaches everything, readable pre-login screens. |
| 2026-11-14 | `7bd7d1e` / `842dd43` | **2.2.0** — fixes found by running on iOS 27 WebKit: tab bar position, glass recipe, profile card, unified controls, bubble-time bug, call dock, desktop rail. |
| 2026-11-14 | `24d3df9` / `b0e118d` | **2.3.0** — Settings fully native rows/switches, Chat appearance wired, text-size slider, solid menus, keyboard fix. |

### 3.3 Release notes in brief

* **1.0.0** — extraction; post-quantum hybrid design landed in the following days (the 1.0.0 notes list “What changed from the tree it was taken from”, “Post-quantum”, “Security”, “The shell”).
* **2.0.0** — interface redesign (details in `RELEASE-NOTES.md` sections “The interface”, “An app of its own”, “Checked”, “Not done”).
* **2.0.1** — icon: every size derives from `assets/ICON.png` (install icons 192/512, maskable pair, apple-touch, favicon, macOS icns).
* **2.1.0** — Settings as views over the app’s controls; Telegram order (profile; Saved messages, Recent calls, Devices; Notifications, Privacy, Data, Appearance, Language, Server; Help, About); register page logo; no crypto-algorithm settings; Security Center removed; slate dark palette from P00RIJA Cryptography; glass lens tab bar; text size reaches bubbles/composer/list; light-theme gate screens made readable; “About me” page.
* **2.2.0** — tab bar 16 pt from the edge instead of 44; glass recipe (near-clear, rim light, glow, lighter lens); profile card of the original; Notifications and sounds as rows; **one controls stylesheet** (`css/ui/57-controls.css`); plus/send at the left in Persian; time-in-bubble specificity bug fixed; keyboard shell fix; call dock fits seven buttons; desktop rail flat; no composer in empty desktop thread.
* **2.3.0** — world-clocks page in Settings; compact profile card; Privacy without the shared-lock card and “Off” row; native Data/Connection/Devices; “Secure chat” switch removed; Chat appearance bridged (`followAppearance`) with live preview first; **text-size slider 80–140 %** scaling the whole app via `--fs`; solid menus; plus menu at the left and bounded by the keyboard; reaction chips in flow; dialog focus ring removed; toast from the safe area; relay-fingerprint “accept” button made robust.

### 3.4 How the last three releases were produced (method)

The owner reviewed the deployed app on a real iPhone and a macOS window and sent screenshots with numbered complaints. Because the browser-based test tools only exercised Chromium, **a rig was built to see the app on real iOS WebKit**: a one-file Swift WKWebView shell installed in the iOS 27.2 simulator (scene-lifecycle manifest required by iOS 27; page told it is standalone through `navigator.standalone`; a polling file channel `/tmp/simshell/cmd.js` to run scripts and `simctl io screenshot` to see results), a local dev stack (static server + relay behind one origin), and a second client (Playwright harness) for real conversations and calls. That rig found bugs Chromium hid (time overlapping text in right-to-left bubbles; composer under the keys; a menu opening at x = −194). It could **not** raise the software keyboard for a scripted focus, so keyboard layout was verified only with the keyboard’s height set by hand (§30).

Each release followed: reproduce → fix in `css/ui/` or `js/messenger*.js` → rebuild `css/chat-ui.css` → re-check on the simulator in dark and light → run suites → compare any failing legacy suite against a baseline copy of the previous commit → two commits → deploy to all eight servers in dependency order → verify each server’s `/chat-health`.

---

## 4. Repository map

```
P00RIJA-CHAT/
├── index.html                  The whole page (≈285 KB, 715 element ids, 574 data-i18n nodes); script order is the load order
├── sw.js                       Service worker: precache list, network-first shell, never caches relay answers
├── manifest.webmanifest        PWA manifest (name "P00RIJA Chat", standalone, rtl, fa)
├── package.json                Scripts (dev, relay, setup, test:*, check:*), build tag `chat-v6`
├── .env.example                Every server setting with comments (see §26)
├── LICENSE                     AGPL-3.0-only
├── README.md / README.fa.md    Product README (en / fa)
├── HANDOFF.md                  Short handoff for the next human or AI
├── INSTALL.md                  Installing the PWA on a device
├── INSTALL-LINUX-SERVER.md     Running the server (ports, .env, Telegram section)
├── SECURITY.md                 Vulnerability policy and what the app does not claim (en + fa)
├── CONTRIBUTING.md             Contribution rules
├── RELEASE-NOTES.md            Per-release notes, newest first (1.0.0 … 2.3.0)
├── docs/
│   ├── PROTOCOL.md             How messages and calls are protected (code-checkable)
│   ├── RELAY-NETWORK.md        Several servers: transit, roles, clusters, TURN
│   ├── MONITOR-SERVER.md       The dashboard
│   ├── DESIGN.md               The interface and its design system
│   ├── DEVELOPMENT.md          Working on it: run, test, build, version
│   ├── BLUEPRINT.md            This document
│   └── screenshots/            9 PNGs used by the README (phone/desktop, light/dark, fa/en)
├── js/
│   ├── chat/NN-*.js            The messenger: 63 ordered classic scripts (Appendix A)
│   ├── messenger.js            The shell (tabs, heads, menus, composer, appearance mirror, text-size follow); loaded after the chat
│   ├── messenger-settings.js   Settings as pages that are views over existing controls
│   ├── app.js                  Vault, lock, settings, i18n, theme, PWA, push, version (10,029 lines)
│   ├── vault-profiles.js       Two indistinguishable vaults (master + duress)
│   ├── crypto-core.js          Synchronous AES-GCM storage cipher and primitives WebCrypto lacks
│   ├── crypto-config.js        Algorithm registry (settings UI for it is removed)
│   ├── advanced-crypto.js      Argon2id (WASM), Shamir sharing (code kept, tools removed)
│   ├── backup.js               Full encrypted vault backup/restore
│   ├── local-link.js / local-mesh.js / local-room.js   Chat with no server (§20)
│   ├── stego.js                Hiding an encrypted message in a photo
│   ├── qr-kit.js               Every QR drawn or read, decided once
│   ├── metadata.js             Read/edit/strip file metadata (EXIF etc.)
│   ├── image-formats.js        HEIC/DNG opening
│   ├── screen-guard.js         Keep content out of screenshots/app switcher
│   ├── dialogs.js              alert/confirm/prompt that work in native webviews
│   ├── voice-changer.js        Voice effects (honestly labelled as effects)
│   ├── tools-extra.js          QR bridge and other small tools
│   ├── help-content.js         The help guide as data (searchable)
│   ├── update-check.js         Opt-in release check for native builds
│   ├── monitor-client.js       Desktop monitor client
│   ├── desktop-bridge.js       Single place that knows about Tauri (`window.__TAURI__`)
│   └── relay-hints.js          Tiny relay hints
├── css/
│   ├── ui/00…99-*.css          Sources of the interface layer (14 files)
│   ├── chat-ui.css             BUILT from css/ui (one @layer, every declaration !important) — never hand-edit
│   ├── styles.css              The old frame’s stylesheet (≈28,000 lines) — read-only in practice
│   ├── messenger.css           Hides the old controls the chat still holds by id
│   └── monitor-client.css
├── scripts/
│   ├── server.js               THE RELAY (13,533 lines): signalling, mailboxes, push, monitor, transit, Telegram
│   ├── lib/*.js                19 relay modules (identity, peers, transit, guests, partners, alerts, Telegram, updates…)
│   ├── deploy.sh               Deploy to one/all servers, `--check`, `--prebuilt`, `--dry-run`
│   ├── setup*.sh, docker-install.sh, quick-install.sh, update-server.sh, apply-update.sh, sync-to-server.sh, server-backup.sh, cert-renewer.sh, link-relays.sh, panel.sh, prepare-relay-host.sh
│   ├── build-*.sh, native-build-wizard.sh, release-all.sh, …   Inherited native/packaging scripts (no native shell project present)
│   └── dev-static.js           Static dev server
├── standalone-relay/           A relay with no app (role `relay`): server.js (34 lines), Dockerfile, compose, setup.sh
├── config/                     nginx.conf, docker-compose.yaml, Dockerfiles, coturn/cert settings, relay-defaults.json, relay-overrides.json
├── docker/                     compose.yaml + Docker Hub README
├── tools/                      Guards (check-*.cjs, audit-*.cjs), build-ui-css.cjs, split-chat.cjs, vendor builders (mlkem, sileo), relay-directory.mjs, admin-key.mjs, central panel (panel/)
├── tests/e2e/                  240 `.mjs` files, harnesses included (§22)
├── vendor/                     Third-party code, vendored (§6)
├── fonts/                      Vazirmatn, Inter and ~15 more families, tahoma
├── assets/                     ICON.png (master), pwa-icons/, icon-app.*, profile-avatars/, desktop-icons/
├── data/                       Relay state when run natively (git-ignored; holds other people’s queued ciphertext)
├── certs/                      TLS material (git-ignored)
└── graphify-out/               A knowledge-graph index of the repository (git-ignored)
```

**Size at the time of writing:** `js/` 3.6 MB, `css/` 1.4 MB, `assets/` 4.5 MB, `fonts/` 30 MB, `vendor/` 2.7 MB, `scripts/` 1.6 MB, `tools/` 15 MB, `tests/` 6.6 MB, `docs/` ~1 MB.

---

## 5. Architecture at a glance

### 5.1 Components

```
                         ┌──────────────────────────── a server you run ─────────────────────────────┐
  Browser / PWA          │  nginx :1122 (TLS)  ──►  chat-app container: serves index.html, js/, css/ │
  (index.html + js/)     │        │                                                                  │
        │  HTTPS         │        ├─ /chat-signal  (WebSocket) ┐                                      │
        ├───────────────►│        ├─ /peerjs       (WebRTC signalling)                                │
        │                │        ├─ /relay-link, /turn-config, /push/*, /link-preview,               │
        │  WebSocket     │        │  /telegram-stickers/*, /relay-identity, /relay-mirrors,           │
        ├───────────────►│        │  /Monitor_Server, /admin/*, /chat-health, /ready, /live …         │
        │                │        ▼                                                                  │
        │                │  chat-signal container: scripts/server.js (Node, Express, ws, PeerJS)     │
        │                │     ports 11220 signalling+HTTP · 11221 presence · 11222 bootstrap        │
        │                │     state in data/ (mailboxes, push, identity, transit peers, …)          │
        │  UDP/TCP       │  coturn container: TURN 11478 (udp/tcp), 11349 (tls), relay range 40000-40500 │
        └───────────────►│  cert-renewer container: Let's Encrypt / self-signed / existing           │
   WebRTC media/data     └────────────────────────────────────────────────────────────────────────────┘
   (direct when possible,                        ▲ transit links (sealed to the other relay's key)
    else via TURN)                               ▼
                                         other relays (role `app` or `relay`)
```

* **Client** — a static web app. All cryptography is in the browser (WebCrypto, plus vendored ML-KEM-768, Argon2id WASM, noble-style XChaCha20-Poly1305 in `crypto-core.js`). The page is a single HTML document with one global script scope (§29).
* **Relay** — one Node process (`scripts/server.js`) that is at once: WebSocket signalling and presence, offline mailbox store, push (Web Push/VAPID and UnifiedPush), TURN credential issuer, link-preview fetcher, Telegram sticker proxy, operator dashboard (`/Monitor_Server`), transit link to other relays, directory/identity authority checker, Telegram alert bot, bootstrap installer, update stager.
* **nginx** — TLS terminator and static server in front of the relay; its CSP is generated and includes the mirror origins (`CHAT_MIRROR_ORIGINS`).
* **coturn** — TURN server so a call can cross a network that blocks direct paths. Credentials are short-lived (HMAC with `TURN_SECRET`).
* **cert-renewer** — keeps `certs/` (one folder read in place by nginx, coturn and the relay).

### 5.2 Message paths (what takes which road)

| Situation | Path |
|---|---|
| Both online, direct path exists | WebRTC data channel (PeerJS signalling through `/peerjs`); session key from the hybrid exchange (§8) |
| Both online, no direct path | **Relay link** (`43-relay-link.js`): the same frames carried through the relay socket, still sealed end to end |
| Recipient away | **Offline envelope** (`28-offline-envelopes.js`) sealed to the recipient’s current signed prekey (§9), parked in the relay’s mailbox, delivered on next connect |
| Recipient on another relay | **Transit envelope**: sealed to the other relay’s key on top of the recipient seal (§11); route found by `40-route-finder.js` |
| Relay unreachable (blocked) | **Mirror** or **front door** (§11) |
| Same Wi-Fi, no server | **Local Link** (§20): WebRTC offer/answer carried by QR or clipboard |

### 5.3 Frontend layering (why the code is shaped this way)

1. **Legacy frame** — `index.html` still contains the markup of the app the chat was cut from (hidden tabs, settings panes, ~700 ids). Code in `js/chat/` finds many controls **by id**, so hidden controls **stay in the page**; the interface layer hides them with CSS and, in Settings, *moves* the live nodes into new pages (never copies, never deletes).
2. **Chat engine** — `js/chat/01…63` plus `js/app.js`: state (`chatState`), crypto, transport, rendering, features.
3. **Interface layer** — `css/ui/*.css` → `css/chat-ui.css` (one cascade layer, every declaration `!important`, beating the 28,000-line legacy stylesheet whatever the specificity) and `js/messenger.js` + `js/messenger-settings.js` (the shell: tab bar, list heads, menus, composer behaviour, Settings pages).
4. **Mirrors of state** — small observers translate engine state into CSS-readable form: `followTextSize` (`--ui-text`, `--fs`), `followRanges` (`--fill-pct`), `followAppearance` (`--ap-*`), keyboard measurement from `js/app.js` (`--app-keyboard-inset`, `keyboard-open`).

---

## 6. Technology and dependencies

| Layer | What | Notes |
|---|---|---|
| Language | JavaScript (classic scripts, no bundler for the app), Node 20+ for the relay and tools | The app loads ~100 `<script defer>` tags in order (`index.html`) |
| Crypto in browser | WebCrypto: AES-256-GCM, RSA-OAEP and RSASSA-PKCS1-v1_5 / SHA-256 (both from the one identity RSA-3072 key pair), ECDH P-256, HKDF, SHA-256; `vendor/mlkem/` ML-KEM-768 (`@noble/post-quantum` 0.7.1, checked against OpenSSL by `tools/check-mlkem.cjs`); `js/crypto-core.js` XChaCha20-Poly1305 (vault, vectors from RFC 8439 / draft-irtf-cfrg-xchacha-03); `vendor/hash-wasm/` Argon2id | |
| Realtime | PeerJS (`vendor/peerjs/`, server `peer` npm package), WebSocket (`ws`) | `maxPayload` 12 MB on the peer server |
| Relay | Express, `ws`, `peer`, `web-push` | One file, `scripts/server.js` (13,533 lines) + `scripts/lib/` |
| Styling | Tailwind output (`vendor/tailwind/tailwind.generated.css`) for the legacy frame; **hand-written CSS** for the interface layer; Font Awesome icons (`vendor/fontawesome/`) | Icons are Font Awesome classes (`fas fa-…`) |
| Toasts | **sileo** (React-based, bundled to `vendor/sileo/sileo.bundle.min.js` by `tools/vendor-sileo`) | Reached only through `window.PoorijaSileo`; plain fallback if the bundle fails |
| QR | `vendor/qrcodejs/`, `vendor/jsqr/` and `js/qr-kit.js` | |
| Archives | `vendor/jszip/` | exports/backups |
| 2FA | `vendor/otpauth/` | TOTP |
| Animation | `vendor/lottie/` | animated stickers |
| Audio | `vendor/noise-suppressor/` (WASM, RNNoise-style) | call noise suppression |
| Tests | Playwright (Chromium; optional WebKit via `E2E_ENGINE=webkit`) | `tests/e2e/` |
| Containers | Docker Compose (project `p00rija-chat`), nginx, coturn 4.18 alpine | |
| Fonts | Vazirmatn (default Persian), Inter (default Latin), and ~15 more; `tahoma.ttf` | User-selectable in Appearance |

---

## 7. Identity, vault and storage on the device

### 7.1 Identities and keys held

* **Identity key** — RSA-3072 pair that never changes. It is generated once as an **RSA-OAEP / SHA-256** key (`initializeChatIdentity`, `19-forward-secrecy.js`: `encrypt`/`decrypt`, used to open what is sealed to the identity) and the same PKCS#8 bytes are imported again as **RSASSA-PKCS1-v1_5 / SHA-256** (`importIdentitySigningKey`, `28-offline-envelopes.js`) for every signature: key-exchange offers and answers, prekeys, relay proofs, device-sync rows. The **fingerprint** is its hash; it is the name of the person. A contact’s key is **pinned** the first time it is seen. A later change is announced in the conversation and, for a **verified** contact, **blocks sending** until re-verified (`48-key-verify.js`: `verifiedKeyChangeBlocksSend`, `refuseIfVerifiedKeyChanged`).
* **Device key** (`58-device-roster.js`) — per-device signing key; a **device roster** signed by the primary device lists the devices of one identity (§19.7).
* **Prekeys** (`19-forward-secrecy.js`, storage key `poorija_chat_prekeys`) — ECDH P-256 + ML-KEM-768, signed by the identity key, lifetime **15 days** (`PREKEY_LIFETIME_MS`), rotated at one third of it.
* **Session keys** — ephemeral, per connection, re-negotiated at least every **7 days** (`SESSION_KEY_LIFETIME_MS`).
* **Storage key** — derives from the master password through Argon2id (see 7.2); salt in `poorija_storage_key_salt_v3`.

### 7.2 The vault: two indistinguishable slots (`js/vault-profiles.js`)

* `poorija_vault = { v: 4, kdf: { alg, t, m, p, salt }, slots: [ {n, ct}, {n, ct} ] }` — **always two slots** of 272 bytes of ciphertext, order reshuffled on every write. **No password hash is stored.** Unlocking derives one key from the password and tries both slots; whichever authenticates is the vault you get.
* **Both profiles are created at install**, always (the *real* one and an *alternate* filled with generated plausible content and sealed under a random password that is thrown away). Setting a duress password later only re-seals the alternate’s envelope — an installation where duress is never configured has the same shape as one where it is.
* The old design (separate `poorija_panic_hash`, panic wipe) was replaced because two visible credentials and a visible wipe are tells. What this buys: inspection of stored data cannot prove a second vault exists. What it does not: someone who watched you type, an unlocked running device, a recording of an earlier session, or hiding that the app is installed.
* **The decoy profile password** (Settings → Privacy and security → group *Decoy profile* → row “رمز پروفایل طعمه / Decoy profile password” → `panic` page, input `panicPasswordInput_dz`, `setPanicPassword` in `js/app.js`): at least 8 characters, stored by `PoorijaVault.setAlternatePassword` — it **re-seals the alternate slot**. **Entering it on the login screen opens the decoy profile; nothing is erased** (a password equal to the real one is refused with `DUPLICATE_PASSWORD`). Since 2.5.1 the row, the page and `panicDesc` (fa/en) say exactly that; the real erase is a separate red row in the *Danger zone* group (`resetAppSettings`, asks twice). `tests/e2e/decoywording.mjs` keeps the old “emergency erase” wording from coming back. The legacy `poorija_panic_hash` key is only read for old installs.
* **Real wipes** still exist and are separate: `emergencyWipe()` / `window.wipeAllData()` / `resetAppSettings()` in `js/app.js` clear localStorage, IndexedDB, Cache Storage, the service worker and the in-memory keys of the chat (optionally purging the relay’s mailbox) and reload to first run; they are reached from the Danger Zone “reset everything” control, from the shared-lock wipe rule (`startSharedLockWipe`, `js/chat/07-conversation-lock.js`), from `window.triggerPanic()` (the “biohazard button”, exercised by `emergency.mjs`) **and from pressing Escape twice within 500 ms anywhere in the page** (`document.addEventListener('keydown', …)` near the end of `js/app.js`). That last one used to call `triggerPanic()` → `wipeAllData(true)` → `emergencyWipe({ purgeRelay: true })` **with no confirmation**; it now calls `askBeforePanic()`, which opens a confirmation dialog (“Erase everything?”, danger-styled OK, **focus on Cancel**, key repeats ignored, never a second dialog while one is open, and **no wipe at all if the dialog helper is missing**) and wipes only if the person confirms (§28 #20, suite `panicconfirm`). The login screen has **no** panic branch any more (`js/app.js` ≈ line 6775 says so in a comment).
* **Storage cipher** (`js/crypto-core.js`): synchronous authenticated encryption **XChaCha20-Poly1305** (192-bit random nonce, no counter to reset on a restored backup) for the vault; **AES-256-GCM** through WebCrypto for files and messages. Poly1305 uses the 17-limb TweetNaCl structure because JS doubles are only exact to 2^53; verified against published vectors by `tests/e2e/cryptocore.mjs`.
* **Auto-lock** (setting `autoLockToggle` + `autoLockTime`), **screen guard** (`js/screen-guard.js`: hide content from the app switcher/screenshots where the platform allows), **biometric/passkey quick unlock** (`poorija_passkey_*` keys), **TOTP two-step** (`poorija_2fa`), lockout counters (`poorija_failed_logins`, `poorija_lock_until`), recovery questions (`poorija_sq*`).

### 7.3 What lives where (local storage map)

`localStorage` (names with prefix `poorija_` / `poorija-`) holds settings and small records; large data is in **IndexedDB** (media vault `02-media-vault.js`: `openMediaDb`, `ensureMediaKey`; stickers `16-…`: `openStickerDb`). The full storage-key reference is in §27.

---

## 8. Live conversations: the key exchange and message protection

(This section extends `docs/PROTOCOL.md`; function names are real anchors in `js/chat/19-forward-secrecy.js` unless stated.)

### 8.1 The hybrid exchange (per connection)

1. **Offer** — the side whose fingerprint sorts first creates a fresh **ECDH P-256** key **and** a fresh **ML-KEM-768** public key, signs the offer with its identity key: wire kind `kex-offer/3` (`kexOfferSignBytes`, `kexSign`).
2. **Answer** — the other side replies with its own ECDH key and an **ML-KEM ciphertext** to the offered key, signed: `kex-answer/3` (`kexAnswerSignBytes`).
3. **Derivation** — both compute the session key with **HKDF** over the ECDH secret **and** the ML-KEM secret, bound to the whole transcript: context string `poorija-session-v3|<transcript>` (`deriveHybridKeys`, `kexDigest`). It falls only if **both** primitives are broken.
4. **Confirmation** — the answering side does not use the key until the other proves it holds it: `kex-confirm` (`kexConfirmTag`). While settling, `kexSettling` holds sending so a delayed answer can never switch forward secrecy off.
5. **Messages** — each message is **AES-256-GCM** under the session key. Ephemeral private keys are discarded at session end → **forward secrecy per connection**.

### 8.2 No downgrade

* A contact **seen doing the hybrid exchange is never again offered the older one** (`kexPinned`, goes only up; persisted so it survives closing the app — commit `8227e9e`).
* The older ECDH-only exchange (`poorija-session-v2`) is used **only** with peers that cannot do the new one (P00RIJA Cryptography).
* The first versions wrapped a session key under the RSA identity key; this path was **removed outright** (commit `3cf2d94`) because a relay that suppressed the exchange could force it.
* Suites that play the attacker: `downgrade.mjs`, `holdhybrid.mjs`.

### 8.3 The relay is never an oracle (`relay-proof/1`)

A relay may ask a device to prove its identity (hand over a mailbox, register push). The device **signs a nonce** with its identity key (`signRelayProof`, `relayProofBytes`, `30-file-transfer-2.js`); it **never decrypts anything the relay sends**, because anything a device opens on request could be a message key in disguise (commit `d67255a`). The relay still accepts the sealed-challenge form for old builds while checking the new signature. Suite: `oracle.mjs`.

### 8.4 Sealed sender, padding, capabilities (`51-envelope-privacy.js`)

* **Sealed sender** — fields that used to travel in the clear in queued envelopes (sender fingerprint/peer id, signature, inner type, timestamp) are inside a small box encrypted under the same key that opens the body. The relay sees: a recipient, a seal, a box, a body, a retention class, and whether to wake the device. It stores the item **without a sender**; the signature inside the box also covers the recipient so an envelope cannot be re-sealed to someone else. It is only used toward a contact whose build advertises capability **`ss1`**.
* **Take-back** — each sealed envelope carries the hash of a secret only the sender can derive, so a sender can withdraw a queued envelope without being identifiable by name (`withdrawSecretFor`, `withdrawHashFor`).
* **Padding** — sealed bodies are padded to a fixed ladder **512, 1024, 2048, 4096, 8192, 16384, 32768, 65536 bytes**, then **16 KB steps** (`PAD_LADDER`, `PAD_STEP_ABOVE`, `padTargetFor`); every small live frame (≤ 16 KB, `LIVE_PAD_LIMIT`) gets a filler field to the same ladder. Capability **`pad1`**.
* **`pd1`** — this build reads the relay’s presence table as **deltas** (`peers-delta`) after the first whole one.
* Capability flags: `LOCAL_CAPS = ['ss1', 'pad1', 'pd1']`.

### 8.5 What the relay can see

That a device is connected, to which relay, how much it sends and when; who an envelope is addressed to (a mailbox name derived from a key, not a name); retention class; sizes (padded to a ladder). It cannot read content, cannot forge a contact’s prekey unnoticed, cannot force weaker encryption without refusal or hold. It still sees which socket handed it a frame at the moment of sending (sealed sender removes the sender from what is **kept** and **forwarded**, not from the moment of sending).

---

## 9. Messages for people who are away: prekeys, seals, mailboxes

### 9.1 Prekeys

Each device publishes a **prekey** (`prekey/2`): an ECDH P-256 key and an ML-KEM-768 key, **signed by the identity key**, lifetime **15 days**, rotated at a third of it (`ensurePrekey` in `19-forward-secrecy.js`, lines ~406–421). A sender checks the signature against the key it has **pinned** for that contact **before sealing anything to it**. A relay handing out a prekey of its own is therefore noticed (commit `e719e5a`). Suite: `prekeysig.mjs`.

### 9.2 Seals

* The message’s own key is generated, used, and **thrown away after sealing**; it is wrapped to the prekey with a key derived from **both halves**: context `poorija-offline-v3|…`, **seal version 3** (`sealWithPrekey`, `openPrekeySeal`, `sealSessionKeyFor`, `28-offline-envelopes.js`). A contact with only the ECDH half gets **seal version 2** (`poorija-offline-v2`).
* The recipient keeps the private prekey only until it expires. After 15 days an undelivered message is not “hard to read”: **the key it needs exists on no device** (documented to the user in the interface).
* Envelopes are signed (`signOfflineEnvelope`, `verifyOfflineEnvelopeSender`) and carry a retention class: **text** (kept until delivered, however long — but unopenable after the prekey dies) or **media** (held 7 days, `CHAT_MEDIA_RETENTION_MS`, then dropped leaving a note that something arrived and expired).

### 9.3 The hold policy — a contact who can do better is not sealed to with less

For a contact once seen with both halves, the app seals **with both or not at all**. With no valid hybrid prekey in hand (the relay left the second half out, or the prekey ran out) the message **stays on the device marked as waiting** (`prekeyHybridOwed`) and goes by itself when a signed prekey with both halves arrives. Cost: somebody away longer than the prekey lifetime cannot be left a message until they are back. Suites: `prekeyhybrid.mjs`, `holdhybrid.mjs`.

### 9.4 Relay mailbox behaviour (`scripts/server.js`)

* Store-and-forward in `data/` (JSON store + per-mailbox directory), two classes (text / media). Per-recipient byte quota and text-entry limit are **derived from the machine** (`capacityProfile()`: sockets ≈ RAM/0.35 MB clamped 500–50,000; per-IP sockets 64 + RAM/16 clamped 64–2,000; media quota ≈ 0.35 × RAM MB clamped 128–4,096 MB; default request rate 150 × CPUs per minute clamped 150–3,000; text mailbox limit RAM MB × 4 clamped 1,000–100,000), all overridable by environment variable.
* A retention sweep runs every 15 minutes (`CHAT_RETENTION_SWEEP_MS`). The **expiry ledger** (`CHAT_EXPIRY_LOG_*`, 30 days) records what was removed and why.
* **Wake/push** — Web Push (VAPID) and UnifiedPush; wording in `scripts/lib/push-wording.js` is minimal (the relay does not know content).

### 9.5 Honest limits (also in `SECURITY.md`)

* One key per connection, **not per message** (no double ratchet): a stolen live session key opens that connection until it rotates.
* A contact’s **first** prekey is trusted on first sight: a relay that leaves out the second half is not noticed until the contact has been seen with both. Compare safety numbers for anyone who matters.
* Metadata is not hidden. No independent audit.

---

## 10. The relay (`scripts/server.js`)

One Node process, one file (13,533 lines) plus 19 modules in `scripts/lib/`. It listens on **11220** (HTTP + WebSocket signalling + PeerJS), **11221** (presence), **11222** (bootstrap installer; `CHAT_BOOTSTRAP_PORT=0` switches it off). These ports answer only loopback and the Docker bridge (`CHAT_LISTEN_HOSTS=127.0.0.1,docker0`); the internet reaches the relay through nginx on **1122**.

**The relay refuses to start without `MONITOR_PASSWORD`** (≥ 12 characters; there is no built-in default and no recovery) unless `ALLOW_INSECURE_DEFAULTS=1`.

### 10.1 Responsibilities (each is a region of `server.js` and, where noted, a lib module)

| Responsibility | Notes |
|---|---|
| **Signalling and presence** | WebSocket `/chat-signal`; PeerJS `/peerjs` (discovery **off**: the roster is not given to anyone who asks); keep-alive ping/pong every 15 s; `alive_timeout` 600 s so frozen phone tabs are not evicted; `maxPayload` 12 MB; per-IP and total socket ceilings derived from RAM; token-bucket flood control (`CHAT_WS_RATE_*`). |
| **Offline store-and-forward** | Two classes (text/media), per-recipient quotas, retention sweep, expiry ledger (§9.4). Files: `offline-messages.json`, `mailboxes/`. |
| **Sealed envelopes** | Stores/forwards without a sender (§8.4). |
| **Push** | Web Push with VAPID (`vapid.json`; set `VAPID_*` to keep subscriptions across restarts), `push-subscriptions.json`, UnifiedPush poll tokens (`poll-tokens.json`), wording minimal (`lib/push-wording.js`); `/push/challenge`, `/push/subscribe`, `/push/unsubscribe`, `/push/mailbox`, `/push/poll-token`. |
| **TURN credentials** | `GET /turn-config` hands each client an expiring credential (HMAC with `TURN_SECRET`, TTL `CHAT_TURN_TTL_SECONDS` default 12 h) rather than a static pair. |
| **Identity** | `lib/relay-identity.js`: an X25519 key pair **and** an ML-KEM key; the relay’s **name is the hash of its public key**; `GET /relay-identity`. Clients **pin** it (`relayPins`, “اثر انگشت رله / Relay fingerprint”). |
| **Relay proof** | `POST /relay-prove` — the relay proves it holds its key (used to authenticate mirrors). |
| **Transit** | `lib/relay-link.js` (authenticated link between two relays, frames bound to the handshake), `lib/relay-peers.js` (dial/redial/answer; **fail closed**: carries transit for nobody until an operator names who), `lib/relay-transit.js` (the envelope a relay carries without knowing who it is for: the client seals the real envelope to the **recipient’s relay** and hands its own relay something it cannot open). |
| **Family and directory** | `lib/relay-directory.js` + `lib/operator-signature.js`: a family’s directory is signed by the operator key; a relay that trusts an operator links with whatever its newest directory names and drops what it leaves out. `GET /relay-directory`, `/operator-handover`, `/transit-peers`, `/relay-gateways`. |
| **Partners** | `lib/relay-partners.js`: two families (different operators) meet only at their gateways after the asked admin approves (`/relay-join`, `/Monitor_Server/partners/*`). |
| **Front doors** | `lib/relay-front.js` (§11.4). |
| **Guest mode** | `lib/relay-guests.js` (§11.5). |
| **Updates** | `lib/update-package.js` (plain tar: `manifest.json`, `manifest.sig`, `source.tar.gz`, `images.tar.gz`; signed by the operator key), `lib/relay-updates.js` (keep only signed newer packages, pass along the family, apply at the right time); `/p00rija-update/offer`, `/p00rija-update/package/:version`; dashboard `updates/*`. |
| **Link preview** | `POST /link-preview` (`lib/link-preview.js`): public addresses only, no cross-site redirect, size/time capped, **keeps nothing**; off with `CHAT_LINK_PREVIEWS=0`; app switch is **off until a person turns it on** and says the relay sees the link. |
| **Telegram** | Alerts, status cards, commands, sticker proxy (§21). |
| **Dashboard** | `/Monitor_Server` (HTML in `lib/monitor-dashboard.js`, 1,596 lines) and `/admin/*` JSON; 8 surfaces (§25). |
| **Bootstrap installer** | `curl … :11222/install \| bash …` with a single-purpose token (no data, identity or secret travels). |
| **Self-destruct records** | `POST /self-destruct/records`, `GET /self-destruct/records/:id`, `…/open` (support for messages that destroy themselves). |
| **Health** | `/chat-health` (`ok`, `service: poorija-chat-signal`, `version`, `buildTag`, `telegramStickers`, link state), `/ready`, `/live`, `/healthz`, `/cert-status`. |
| **Mirrors** | `/relay-mirrors` (list; POST to learn), `/relay-fronts`, `/relay-speed`. |

### 10.2 Admin surface and auth

* Login: `POST /admin/login` with `MONITOR_USER` (default `admin`) and `MONITOR_PASSWORD`; session lasts while used (`MONITOR_SESSION_TTL_MS`, default 12 h); **three wrong guesses lock for ten minutes**; rate limits keyed per address (`CHAT_RATE_LOGIN`, default 10/min).
* **Signed dashboard requests** (`lib/operator-signature.js`): harmful actions (kick, change password, approve a partner, restore a backup, apply a release) may carry a signature from a key on the admin’s own computer (the operator key, or an admin key the operator listed in the family’s signed directory). With `CHAT_REQUIRE_OPERATOR_SIGNATURE=1` a locked relay takes those actions only signed, so a leaked dashboard password no longer reaches them. `CHAT_CENTRAL_CONTROL=1` lets the central panel’s signed requests through.
* Actions include: queue inspect/drop/flush, suspend/kick/resume peers, allowlist (add/remove/mode), broadcast, clear memory/offline, optimize RAM, backups (create/list/download/restore/delete), disk/memory/image/stack operations (`ops-*`), GitHub update check/apply/rollback, transit add/remove, partners, gateways, guests, announce, bootstrap token, telegram settings/preview/alert-test.

### 10.3 Server-side state (the `data/` directory; `/data` when the container mounts one)

`offline-messages.json`, `mailboxes/` · `relay-identity.json` · `known-identities.json` · `transit-peers.json` · `relay-directory.json`, `operator-handovers.json` · `relay-partners.json` · `guests.json` · `push-subscriptions.json`, `vapid.json`, `poll-tokens.json` · `beacons/`, `rosters/`, `siblings/` (multi-device sync, §19.7) · `self-destruct-records.json` · `expiry-log.json` · `server-policy.json`, `server-config.json` · `updates/` · `telegram-settings.json`, `telegram-token` (owner-only file) · `status-report-day.txt` · `.monitor-bundle.tar.gz` · `initial-monitor-password`. **This directory contains other people’s queued ciphertext and the server’s identity — never commit it, never copy it between servers** (a copied identity makes two relays claim one name).

### 10.4 Standalone relay

`standalone-relay/` runs only the relay (role `relay` in `deploy.conf`): `server.js` (34 lines wrapper), `Dockerfile.relay`, `docker-compose.yaml`, `setup.sh`. It carries traffic and runs TURN and serves no app, so it cannot change the code anyone runs (trust difference in §24.1).

---

## 11. Several relays

(Condensed from `docs/RELAY-NETWORK.md`, extended with code anchors.)

### 11.1 Why

One relay is enough for friends. More than one gives **reach** (people on different servers still talk), **resilience** (a blocked/down server does not take the conversation), and **short calls** (TURN near the callers).

### 11.2 What links relays

* **Transit envelopes** — a message for someone on another relay crosses as an envelope sealed to the *other* relay’s key; neither relay can read the message inside (sealed to the recipient). Each relay has a **self-certifying identity** (key pair; name = hash of public key; `GET /relay-identity`). The link key exchange has an ML-KEM-768 half as the app’s does.
* **Route finding** (`js/chat/40-route-finder.js`): the app learns which relay reaches a contact, **parks** the message at the relay seen to reach them, and withdraws the copy once delivered (`discoverHomeRelay`, `parkedEntriesFor`, `resendParkedMessages`).
* **Mirrors** (`52-relay-mirrors.js`): several addresses for one relay so a device can switch when the main name is blocked. The client switches **only after the mirror proves it holds the relay’s key** (`/relay-prove`) and switches back when the main address answers. The page’s CSP lists them (`CHAT_MIRROR_ORIGINS`).
* **Directory and families** (`61-relay-directory.js`, `lib/relay-directory.js`): the relays one operator runs, signed by the operator key; `CHAT_OPERATOR_KEY`, `CHAT_DIRECTORY_SOURCES`, `CHAT_DIRECTORY_MIN_SERIAL`; operator **handover** is verified (`operatorHandoverHolds`, `followOperatorHandovers`).
* **Relay choice** (`63-relay-choice.js`): measures relays (`measureRelays`, `scoreRelays`, `maybeMoveHome`) and may move a new account’s home relay when another is clearly better (`moveDecision`).

### 11.3 Roles, clusters, gateways (`deploy.conf`, per server)

| Key | Meaning |
|---|---|
| `<NAME>_ROLE` | `app` (serves the web app **and** relays; users must trust it as they trust the author, because it serves the JavaScript) or `relay` (only the standalone relay) |
| `<NAME>_CLUSTER`, `<NAME>_REGION` | Servers with the same cluster name are one cluster; a cluster whose members reach each other directly keeps working when cut off from the internet (members use **inside** addresses `<NAME>_INSIDE`) |
| `<NAME>_GATEWAY` | which member speaks for the cluster to others |
| `<NAME>_JUMP` | reach this server through another (SSH hop that forwards the connection only; holds no key for the target) |
| `<NAME>_SSH_*`, `<NAME>_REMOTE_DIR`, `<NAME>_PUBLIC_URL` | connection and where it lives |

### 11.4 Front door (`lib/relay-front.js`)

**Measured on 2026-10-10 (documented in code):** from outside Iran every TLS connection to a relay inside Iran completes its handshake and then receives nothing, while that relay can still open TLS connections **outward** — which is why the transit link stays up (the Iranian relay dials). So “the way in is the way out”: a reachable relay answers at a separate address for the hidden one (`CHAT_FRONTS=<hidden id>@https://<this domain>:1123`, `APP_FRONT_BIND`, `APP_FRONT_PORT=1123`), carrying each connection over the transit link; the hidden relay sets `CHAT_FRONT_DOORS` and `CHAT_MIRROR_ORIGINS`. Clients **prove the door leads to the relay they pinned** before using it.

### 11.5 Guest mode (`62-guest-mode.js`, `lib/relay-guests.js`)

When a person’s home relay is unreachable, the app **stays for a while on another relay of the same operator’s family — a guest, never a resident**. A guest’s statements are **signed with their own identity key** (“this device is a guest at G until T”, “my home moves from H to G”); TTL `CHAT_GUEST_TTL_MS` 24 h, retention 3 days, forward window 7 days, per-IP new-guest limit. Setting: Server and connection → “رلهٔ مهمان از همین خانواده / Guest relay of the same family”.

### 11.6 Where TURN belongs and call path

A call goes through TURN only when no direct path exists. Put coturn on a server **both callers can reach, in the callers’ region** (a TURN across a border adds the border to every call). Each `app` server runs its own and tells its own clients (`/turn-config`).

---

## 12. Calls

### 12.1 One-to-one (`32-file-transfer-4.js`: `startCall`, `bindMediaCall`; screen layer `03-call-screen.js`, `04-call-layout.js`, `31-file-transfer-3.js`)

* **WebRTC**: DTLS-SRTP between the two devices. **Signalling** (offer/answer/candidates) is carried **inside the encrypted conversation**.
* Ring timeout `CALL_RING_TIMEOUT_MS`; offline ring (`offlineRingPeerArrived`) when the callee is away.
* **Controls**: mute, hold, video on/off, flip camera, speaker, reactions, “more” sheet, end. Floating/minimised call window (`setCallDisplayMode`, `toggleCallDisplayMode`, `beginFloatingCallDrag`), chrome that auto-hides and re-shows on activity (`startCallChromeWatcher`, `revealCallChrome`).
* **Verification emoji**: the same pictures on both screens when both ends hold the keys they think they do (`09-the-emoji-key.js`: `verificationEmoji`, `syncCallVerification`).
* **Quality panel** inside the call (not three taps away in settings); adaptive codecs/bitrates (suites `callquality`, `callcodec`, `calltuning`, `callladder`).
* **Noise suppression** (`60-call-audio.js`, `vendor/noise-suppressor/`): needs WASM SIMD; falls back to raw microphone when unusable (`fallBackToRawMicrophone`); toggle in Settings → Server and connection → Calls.
* **TURN credentials** short-lived; HMAC secret shared by relay and coturn.

### 12.2 Path management (`42-path-manager.js`) — a hard-won rule

**Measured between the Finland and Iran servers on 2026-10-10:** a UDP flow that a machine *inside* Iran starts towards a foreign address is cut after seven to nine packets, while a flow started from outside survives in both directions. So ICE can report success and the path dies a second later. The path manager reads the selected candidate pair on every quality sample; a direct path that disconnects or stays bad is replaced by an **ICE restart with `iceTransportPolicy: 'relay'` on both ends**, and the contact is **remembered for a day** so the next call starts on a relay path. It also mixes TURN servers so both ends use one they can reach (`buildIceConfigFor`, `watchCallPath`, `escalateCallToRelay`, `handleCallPathRelayRequest`).

### 12.3 Calls over the relay (`39-relay-call.js`)

When WebRTC cannot form at all, a call can be carried through the relay socket (`makeRelayCall`, `placeRelayCall`, `handleRelayCallSignal`, `callNeedsRelay`).

### 12.4 Group calls (`12…16`)

* **Mesh** of 1:1 legs, **maximum 8 participants** (`GROUP_CALL_MAX = 8`; the constant used to be declared and never enforced — N² legs), same protection per leg.
* **Stage** (`13-group-call-stage.js`): screen/picture presentation (`startGroupPresentation`, `pictureTrackFromFile`), pin, reactions (`sendCallReaction`), raised hands (`toggleGroupCallHand`), layout choice (`setGroupCallLayout`), masonry grid (`fitGroupCallGrid`), speaking indicators (`startGroupLevelMeters`).
* **Roster/invite**: add people to a live call (`addPeopleToLiveCall`), invite card (`showGroupCallInvite`).
* **Suites**: `gcall` (mesh), `gcallui` (stage), `callmirror`, `callreal`, `calllog`.

### 12.5 Call log (`20-call-rows.js`, `25-call-log.js`)

One call is exactly one row on each side in the right section; sections: All / Incoming / Outgoing / Missed; rows grouped; search; select mode; deletion paths (one, a run, a section, older than 30 days, everything). Status vocabulary: `ended, missed, rejected, failed, busy, declined, cancelled`; unanswered attempts within 30 s merge into one row (`CALL_MERGE_WINDOW_MS`).

---

## 13. The interface: concept and design system

### 13.1 Concept

> **Telegram’s arrangement, iOS 26/27’s drawing.** The arrangement (tabs, list rows, bubbles, composer, Settings as a list of pages with coloured icon tiles, “You” first) follows Telegram and WhatsApp so the app is familiar on first contact. The drawing (Liquid Glass navigation layer, inset-grouped lists, springs, large titles, concentric corners) follows Apple’s system design. **Nothing about how the app works changed with the interface**: the same scripts encrypt, send, receive and call. Only what is drawn, and where, is new.

**Hard rules applied** (from the design brief; violating one is a defect):

1. The tab bar **only navigates** (3–5 top-level nouns). Actions never live in it.
2. One primary action per screen (the compose/“+” in the list head); no duplicate triggers.
3. Detail = push; create/edit = sheet; destructive = inside an edit sheet / swipe / menu **with confirmation**.
4. One row = one tap target; no “View ›” text beside a row that is itself tappable.
5. Inset-grouped lists for everything tabular; chevron = navigates; icon tile on the leading side.
6. Glass belongs to the **navigation layer only** (tab bar, bars, floating controls); **content is never glass**; **menus and dialogs are solid** (2.3.0: translucent menus were unreadable).
7. **Never depend on transparency or blur for legibility** (`prefers-reduced-transparency` turns glass into the plain surface).
8. Springs, not eases; motion respects `prefers-reduced-motion` and never exceeds ~0.6 s.
9. Hit targets ≥ 44 pt; semantic colours only; dark mode from the start.
10. Design for real data: ALL-CAPS names, long strings, zero items, missing pictures, huge counts.
11. No emoji as icons; no card inside a card; no placeholder behaviour (a button that only says “coming soon”).
12. **One look per control kind** wherever it appears (`css/ui/57-controls.css`, §13.4).

### 13.2 What follows what

| Part | Takes from | Where |
|---|---|---|
| Bottom tab bar: Chats, Calls, Groups, Local, Settings | WhatsApp (five tabs), Telegram (floating bar), iOS 26 floating tab bar | `js/messenger.js` (`TABS`, `renderBar`), `css/ui/10-shell.css`, `15-glass.css` |
| Large title, search field, filter chips above the list | WhatsApp chat filters | `buildHead`/`renderHead` in `js/messenger.js`, `css/ui/20-list.css` |
| A row: avatar, name, last message, time, unread count, pin | Telegram/WhatsApp | `js/chat/24-settings-panels.js` (`renderPeers`), `css/ui/20-list.css` |
| Long press / right click on a row: pin, mute, archive, lock, block | Both | `openRowMenu` |
| Bubbles with time and ticks inside, wallpaper behind | WhatsApp | `css/ui/30-thread.css` |
| One tick sent, two delivered, two blue read; clock while waiting | WhatsApp | `.chat-msg-status` (ticks are drawn with CSS masks, identical on every font) |
| Composer: plus, field, microphone that becomes send when there is text | Both | `wireComposer`, `css/ui/30-thread.css` |
| Calls: history/contacts switch, filter chips, group call buttons | WhatsApp | `css/ui/40-calls.css` |
| Settings: profile card; Devices; Notifications, Privacy and security, Data and storage, Appearance, Language, Server and connection; Help, About me; each row a page with a way back | Telegram Settings | `js/messenger-settings.js`, `css/ui/50-settings.css`, `55-pages.css` |
| The bar’s selection is a glass **lens** that slides, stretches and settles with a spring, and can be dragged | iOS 26/27 tab bar | `placeLens`, `wireLens`, `css/ui/15-glass.css` |
| On a wide window: tabs as a rail on the side, list and conversation side by side | WhatsApp Desktop, Telegram Desktop | `css/ui/10-shell.css` (≥ 1000 px) |

Outgoing bubbles are on the **right** and incoming on the **left** in both writing directions (as in both reference apps); everything else mirrors with the language.

### 13.3 Tokens (`css/ui/00-tokens.css`)

All colours, sizes and curves are named tokens in a light set (`html.msgr`) and a dark set (`html.msgr.dark`). Components use the names, never a hex.

| Token | Meaning | Light | Dark |
|---|---|---|---|
| `--tint`, `--tint-fill`, `--tint-press`, `--on-tint` | the one colour for what you can press | `#0284c7` / `#0284c7` / `#0369a1` / `#fff` | `#38bdf8` / `#0284c7` / `#7dd3fc` |
| `--green`, `--red`, `--orange`, `--yellow`, `--gray` | status colours | `#34c759 #ff3b30 #ff9500 #ffcc00 #8e8e93` | `#30d158 #ff453a #ff9f0a` |
| `--bg` | page ground | `#f1f5f9` | **`#0f172a`** (P00RIJA Cryptography’s slate-900) |
| `--cell`, `--cell-press` | list surface, pressed | `#ffffff`, `#e2e8f0` | `#1e293b`, `#334155` |
| `--label`, `--label-2`, `--label-3` | text, secondary, tertiary | `#111827`, `#64748b`, 55 % | `#f8fafc`, `#94a3b8`, 55 % |
| `--sep`, `--fill`, `--fill-2` | hairline, soft fill, stronger fill | slate alphas | slate alphas |
| `--wall`, `--wall-ink` | conversation wallpaper and its dot pattern | `#e8eef5` | `#080d1f` |
| `--bubble-in/-out`, `-ink`, `-meta`, `--tick-read` | bubbles | in `#fff`, out `#dbeafe` | in `#1e293b`, out `#2563eb` |
| `--glass-*` | legacy glass tokens for bars | | |
| `--lg-*` | Liquid Glass recipe (§16.1) | | |
| `--r-card` 20 px, `--r-bubble` 18 px, `--r-bubble-tail` 5 px | radii | | |
| `--gutter` 16 px, `--tabbar-h` 62 px, `--rail-w` 76 px, `--list-w` 380 px | metrics | | |
| `--bar-gap`, `--bar-clear` | where the floating bar sits (`max(safe-bottom − 18px, 8px)`) and what a scroller keeps free below the last row | | |
| `--ease` `cubic-bezier(.32,.72,0,1)`, `--spring` `cubic-bezier(.34,1.4,.64,1)` | motion | | |
| `--ui-font` | `-apple-system, "SF Pro Text", Inter, Vazirmatn, …` | | |
| `--ui-text`, `--fs` | runtime: body font size in px, and its factor against 16 px (0.75–1.5) | set by `followTextSize` | |
| `--ap-*` | runtime: what the person chose in Chat appearance (§18.9) | set by `followAppearance` | |

### 13.4 The stylesheet pipeline — **read this before touching CSS**

`css/styles.css` (≈ 28,000 lines, > 6,000 `!important`) is the legacy frame’s stylesheet; **do not edit it to change how something looks**. The interface layer is written in `css/ui/*.css` (14 files, plain CSS) and **built** by `node tools/build-ui-css.cjs` into `css/chat-ui.css`: **one `@layer chat-ui` in which every declaration is `!important`**. Among important declarations those in a *layer* beat those *outside* any layer whatever the specificity, so the new rules win without specificity wars.

| File | Contents |
|---|---|
| `00-tokens.css` | tokens, reduced-motion/transparency/contrast fallbacks |
| `10-shell.css` | the frame: app header, tab bar placement, chat-shell layout (phone: one screen at a time; ≥ 1000 px: rail + list + thread), keyboard shell rules, `html { font-size: calc(16px * var(--fs)) }` |
| `15-glass.css` | Liquid Glass recipe (`--lg-*`), the bar, the lens, desktop-rail override |
| `20-list.css` | list head (`ui-head`), search pill, filter chips, rows, badges, list bottom clearance |
| `30-thread.css` | conversation header, wallpaper, bubbles, time/ticks, reactions, composer, plus/send, menus (`.chat-actions-sheet`), live-preview of Appearance, `--ap-*` bridge |
| `40-calls.css` | Calls tab (switch, chips, group call buttons), desktop calls pane |
| `45-local.css` | Local tab |
| `50-settings.css` | Settings root/hero card, old settings-card normalisation, profile screens |
| `55-pages.css` | Settings pages: rows, switches rows, fields, fingerprints, stats, devices, clocks, legacy-node normalisation |
| `57-controls.css` | **the one set of controls** (buttons, switches, checkboxes, colour wells, sliders) |
| `60-sheets.css` | dialogs (solid), toasts, sheets, plus/thread menus |
| `70-call.css` | call screen, header, dock (one glass capsule), reactions |
| `80-gate.css` | the screens before the app (language, install, first password) — always-dark glass card |
| `99-hidden.css` | hides old controls the code still holds by id |

**Build rules**

* `node tools/build-ui-css.cjs` writes; `--check` fails if `chat-ui.css` is stale (CI guard `npm run check:ui`).
* **`!normal` opt-out.** A property that a script sets *inline* (a drag, a slide, a custom property such as `--fill-pct`, an animated `opacity`) must be written `prop: value !normal` in the source so the build leaves it a normal declaration; an inline style (and a CSS animation) **loses to an `!important` rule** and the motion would freeze. Examples in the tree: `--fill-pct: 50% !normal` (slider fill), `opacity: 0 !normal` (pixel pet frames).
* **Inline `!important` also loses** to layered `!important` — which is why the legacy keyboard servo that pinned the composer inline had no effect until the shell rules were re-stated in the layer (§14.7).
* **Every pixel font size is multiplied by `--fs`** (`font-size: calc(Npx * var(--fs, 1))`, done mechanically over 142 declarations in 2.3.0) so the text-size slider reaches everything. New CSS must write sizes that way.
* **Logical properties** (`inset-inline`, `padding-inline`, `margin-inline`, `border-inline-*`) everywhere except where the layout is deliberately identical in both directions (the side a bubble sits on, the physical left for plus/send in Persian).

### 13.5 The unified controls (`css/ui/57-controls.css`)

Three kinds of control had two looks each (the new interface and the old screens). This file is their single description and **names both structures**, so a control looks the same on a Settings page, in a sheet, on Local, in a dialog.

* **Button** — 44 pt tall, 12 pt radius, 16 pt semibold. *Soft* (tint at 14 %) is the default; *primary* is the tint itself; *danger* is red at 14 %. Classes covered: `.msgr-pill`, `.chat-soft-btn`, `.chat-primary-btn`, `.chat-danger-soft-btn`, `.chat-lock-btn`, `.chat-secondary-btn`, and buttons inside `.msgr-legacy`. A line of buttons is `.msgr-actions-row` (side by side, sharing the width).
* **Switch** — 51 × 31 pt, white knob springing across, green when on. Applies to the new `.msgr-switch`, to the old Tailwind `div:has(> .toggle-checkbox + .toggle-label)` structure, and (inside Settings pages) to bare `input[type=checkbox]` (drawn with an SVG knob via `background-position`, mirrored for RTL). Outside Settings pages a bare checkbox is a **round tick** (24 pt).
* **Slider** — the full width of its row, 6 pt track that fills with the tint as far as the knob (`--fill-pct` written by `followRanges`; in RTL the fill runs from the right), 28 pt white knob. `.msgr-slider-row` and `.chat-appearance-row:has(> input[type=range])` lay out label + value on one line and the slider under them.
* **Colour well** — 48 × 32 pt, 9 pt radius.

### 13.6 Settings framework (the key idea): **pages are views over existing controls**

`js/messenger-settings.js` draws the Settings list and pages and **owns no setting**. A switch/choice/field on a page is a *view of the control the app already had* (its id, its listeners, the code that reads it): it shows the value and, when changed, sets the original and fires its own `change`/`input`. A button presses the original. What is too large to rebuild (the storage card’s file manager, the diagnostics body) is **moved** (never copied) into its page — node and listeners together. Details and every page in §18.

---

## 14. The interface: shell, tabs, lists, conversation, composer

### 14.1 Root state classes (on `<html>`)

`msgr` (interface layer active) · `dark` · `data-msgr="chats|calls|groups|local|settings"` (the lit tab; set by `sync()`) · `chat-screen-active` (the chat tab is showing) · `chat-conversation-active` (a conversation is open, phone) · `chat-composer-focused` · `keyboard-open` · `pwa-standalone` · `mobile-browser-context` · `touch-device` · `ios-device` · `safe-notched` · `safe-home-bar` · `tabbar-wide-on` · `has-language` · `pwa-installed-runtime`.

### 14.2 The shell (`js/messenger.js`, 634 lines)

* **`TABS`**: `chats` (`fa-comment`), `calls` (`fa-phone`), `groups` (`fa-user-group`) are *views of the chat* (`chatState.activeView`); `local` (`fa-tower-broadcast`, tab `locallink`) and `settings` (`fa-gear`) are app tabs. The bar hides that difference: `go(id)` switches the tab then the view.
* **`ROWS`** (what Settings can open that is not a page): `vault` (File manager), `migration` (Migration and backup), `help`, `about`.
* API: `window.PoorijaMessenger = { TABS, ROWS, go, openRow, openProfile, activeId, title, renderBar, sync, openMenu, closeMenu }`.
* Functions: `renderBar`, `placeLens`, `wireLens` (pointer drag of the lens), `renderTop` (top bar for non-chat screens: title, back, search), `renderHead`/`buildHead` (list head), `sync` (everything follows the app’s own state), `openMenu`/`openRowMenu` (solid menu), `wireRows`, `wireComposer`, `followTextSize`, `followRanges`, `followAppearance`, `init`.
* It **does not own chat state**: it calls the same `switchTab()` and `setChatView()` the old buttons called, and reads the same two values to know what is lit. It is the **last script**.

### 14.3 The list screens (Chats / Calls / Groups)

* **Head** (`#uiHead`, built into `.chat-rail`): large title with connection dot (`#uiHeadStatus`, mirrors `chatConnectionDot`); two circle buttons — “more” (`#uiHeadMore`) and “new” (`#uiHeadNew`, hidden on Calls); a permanent search pill (`#uiHeadSearch` → `chatSearchOpenBtn`).
* **More menu (Chats)**: **Saved messages**, Import chats, Export chats, *separator*, Clear all history (danger). *Saved messages lives here, not in Settings.*
* **Filter chips** (`21-chat-list-filters.js`): All, Unread, Pinned, Online (+ **Requests** chip when message requests exist, `49-message-requests.js`).
* **Rows**: avatar (photo/initial, presence dot), name, last-message preview, time, unread badge (muted style when the chat is muted), pin icon; **long-press / right-click** opens a solid menu built from the row’s own action buttons (pin, mute, archive, lock, block …).
* **Empty state**: “هنوز موردی وجود ندارد / Nothing here yet”.

### 14.4 The conversation (`.chat-thread`)

* **Header** (back chevron, avatar, name with verified-shield, status “آنلاین • چت رمزنگاری‌شده / Online • Encrypted chat”, mood chip (“on Work”), voice call, video call, **three-dot thread menu**). Thread menu (`#chatThreadMenu`, **solid**): Create secure session (`chatStartSessionBtn`), Verify key (`chatVerifyKeyBtn`), Lock conversation (`chatLockNowBtn`), Search in this conversation (`chatSearchInChatBtn`), Group info (`chatSpaceInfoBtn`), Delete conversation (`chatDeleteConversationBtn`, danger).
* **Wallpaper**: `--wall` + a faint dot pattern (`.chat-thread::before`), or the person’s chosen background (`--ap-bg`) and/or own picture with blur (`.chat-thread::after`, `--ap-image`, `--ap-blur`).
* **Bubbles**: `.chat-message-bubble.me|.them`; width `fit-content`, max `min(80%, 560px)`; radius `var(--ap-radius, var(--r-bubble))` with a 5 px tail corner on the last of a run; colours `--ap-bubble-*` over tokens; **transparency** `color-mix(… var(--ap-alpha) …)`; text size `calc(var(--ui-text) * var(--ap-zoom))`.
* **Time and ticks**: for a text-only bubble, the meta is **absolutely positioned at the bottom corner** with a spacer (`::after` inline-block 58/78 px) so text never runs under it; the corner follows the text direction (left for RTL text — **a specificity bug put it on the text in Safari until 2.2.0: the RTL rule must carry the same `:not(:has(...))` weight as the base rule**); the time span is `unicode-bidi: isolate; direction: ltr` so “07:52 AM” keeps its order inside RTL.
* **Reactions** (`.chat-reaction-summary`): in the flow under the text as a pill (2.3.0; they used to hang on the bottom edge over the time).
* **Message types rendered**: text (with formatting and link preview card), reply quote, forwarded-from, voice (waveform, seek, speed), image/video/file cards (“دریافت فایل / Receive file”), sticker/GIF, poll, location (static/live), contact card, call event cards (“تماس تصویری برقرار شد — مدت 0:17”), hidden (tap to reveal), view-once, scheduled chip, system notices (secure session established, key change).
* **Selection mode** (`10-selection.js`): multi-select, forward, copy, delete, download; swipe-to-reply (`bindSwipeToReply`).

### 14.5 The composer (`footer.chat-composer-bar`)

* Controls: **plus** (`#chatComposerPlusBtn`), **send/microphone** (`#chatSendMessageBtn`, one button: **microphone when empty, paper-plane when there is text**), **field** (`#chatComposer`, autosizing `<textarea>`, `unicode-bidi: plaintext`).
* **Order**: in **Persian (RTL)** the field takes the writing side and **both buttons gather at the left** — plus outermost: visual left→right = **plus, send/mic, field** (`html[dir="rtl"]` rules `order: 1/2/3`). In **English (LTR)** the usual order: plus, field, send.
* The mic/send decision is made once at `pointerdown` (the chat sends on pointerdown so the keyboard keeps focus; a click follows). A press on an empty field starts a voice recording (`#chatVoiceMessageBtn`).
* **Plus menu** (`#chatComposerActions`, solid, anchored at the physical left, width `min(280px, 100vw − 24px)`, `max-height: min(60dvh, 100dvh − keyboard − 200px)`, scrolls): Stickers, GIF, Poll, Send location, Live location, Contact card, Send file, Send another way (carrier, `chatCarrierBtn`), Photo/video from gallery, Voice message (`chatVoiceMessageBtn`), Schedule send, Hidden message, Self-destruct timer (popover `chatTimerPopover`, `data-chat-timer` seconds: off / 10 / 30 / 60 / 300 / 1800 / 3600 / 36000, i.e. 10 s … 10 h).
* **Rich keyboard box** (`.chat-keyboard-catcher`): a contenteditable shown on touch screens so phone keyboards can insert stickers/Memoji/GIFs (the textarea only holds text); anything landing there is sent and the box empties (`55-gifs-and-keyboard-stickers.js`).
* **Format bar** (`#chatFormatBar`): appears over selected text; bold `*`, italic `_`, strike `~`, code `` ` ``, spoiler `||`, clear.
* **Drafts** per conversation (`22-drafts.js`), **scheduled messages** (`47-scheduled-send.js`), **link-preview chip** (`54-link-preview.js`).

### 14.6 Menus, dialogs, sheets, toasts

* **Menus** (`.chat-actions-sheet`, row menu, thread menu): **solid `--cell`**, 18 px radius, hairline + shadow; never translucent.
* **Dialogs** (`PoorijaDialogs` in `js/dialogs.js`; classes `.poorija-dialog*`): solid 26 px card, centred text, actions under hairlines (stacked when long); **no focus ring on the autofocused OK** (it drew a thick line); implemented in JS because wry (Tauri) provides no native `alert/confirm/prompt` — they would silently answer “no”.
* **Sheets** (`openFullSheet` in `34-sheets-profile-clocks.js`): full-screen sheets that **adopt** live controls and return them on close. (World clocks no longer use a sheet — see §18.2.)
* **Toasts**: sileo, positioned from the **device’s own safe area**: `.toast-stack { top: 0 }`, `[data-sileo-viewport] { padding-top: max(8px, env(safe-area-inset-top) − 6px) }` so a toast starts under the Dynamic Island on phones with one and near the top elsewhere. Reads `PoorijaApp.toasts.recent()` in tests.

### 14.7 The keyboard — the logic and the failure it had

* **Measurement** (`syncResponsiveShell` / `updateViewportHeight` in `js/app.js`): `keyboardInset = innerHeight − visualViewport.height − offsetTop`; the keyboard counts as open when a text field is focused **and** the inset exceeds `max(140 px, 20 % of the window)` (hysteresis: `max(80, 12 %)` once open). It sets `html.keyboard-open`, `--app-keyboard-inset`, `--app-keyboard-pan`, `--mobile-keyboard-bottom`.
* **Layout** (`css/ui/10-shell.css`, phone): `html.keyboard-open { --shell-bottom: var(--app-keyboard-inset) }`; `.chat-shell { position: fixed; inset-block-start: var(--shell-top); inset-block-end: var(--shell-bottom) }` — **the shell ends exactly where the keys begin**, so the composer is directly above them. `html.keyboard-open … .chat-composer-bar { padding-bottom: 6px }` (written with the same id-weight as the base rule — the 34 pt home-indicator padding used to survive the keys: a 40 pt dead strip).
* **Why it broke in 2.1/2.2**: the layer’s `!important` out-ranks the legacy rule that shortened the shell, and out-ranks the legacy servo’s *inline* `!important` pins (`composerKeyboardOverlapFix` in `js/chat/20-call-rows.js`). The rules were re-stated in the layer.
* **Plus menu with keys up** is bounded by the formula above and scrolls.
* **iOS note**: iOS 26 shows a floating form-accessory bar (^ v ✓) above the keys when several inputs exist; its height is included in the visual-viewport shrink. The composer sits above it.
* **Not verified**: a real software keyboard in the simulator (scripted `focus()` does not raise it). The layout was verified with `keyboard-open` and `--app-keyboard-inset: 336px` set by hand (§30).

---

## 15. The interface: calls, groups, Local

### 15.1 Calls tab

`.chat-calls-panel`: a **History / Contacts** segmented switch, filter chips (All, Incoming, Outgoing, Missed — each with a count), two buttons **Group voice call / Group video call** (`.chat-adhoc-call-bar`, equal width, one line), a search field with select-mode and delete-all, then the **call rows** (`20-call-rows.js`). On a phone the panel sits in the list column; on a wide window the conversation column is **replaced by the call tools, centred (max 560 px)** — no composer and no empty bubble field while the Calls tab shows.

### 15.2 Groups tab

List of groups with the “new group” button (`fa-users`); empty state; a **group maker** (`#chatGroupMaker`): name, picture, description, members, permissions. Group conversation header shows member count; **group info** sheet (roles, add/remove, permissions per member, invite code, delete). A group put on you by a stranger appears under **Requests** until accepted.

### 15.3 Local tab (`#content-locallink`, `js/local-*.js`)

Status chip (“متصل نیست / Not connected”, connecting, open), **Start a new link** (tint, primary), **Scan the other side’s code** (soft), **No camera: with text or file** (soft), **Disconnect and start over**, and an explanatory note about hotspots/guest Wi-Fi. Buttons follow the unified style (primary + soft; the old green was removed with its contrast failure). §20.

### 15.4 The call screen (`css/ui/70-call.css`, `.chat-floating-call*`)

Full-screen dark ground; header (end-call red circle, add person, title “تماس صوتی/تصویری فعال”, duration, back arrow; latency chips “او / من” with dots; verification strip with the six emoji and a shield); the **hero** (avatar with rings, big name) for voice; remote video + self-view tile (draggable) for video. **The dock is one glass capsule** (`.chat-call-control-row`: flex, `space-evenly`, rim light, blur) containing round buttons (`flex: 1 1 0; max-width: 60px; aspect-ratio: 1`) — voice shows five, video seven; all fit at 320 pt width (a fixed 64 px width used to push the first button off-screen). The dock sits at `bottom: max(safe-bottom, --pwa-safe-bottom) + 8px` (the legacy suite requires ≥ 30 px clear of the home indicator).

---

## 16. The interface: glass, motion, themes, text size, languages

### 16.1 Liquid Glass recipe (`css/ui/15-glass.css`) — what is and is not reproduced

Read off Safari’s own tab bar in iOS 27: the pane is **nearly clear and only a little frosted** so what scrolls under it stays recognisable; its edge is a **thin ring of light brightest at two opposite corners** (a 1.2 px border painted with a two-peaked gradient through a mask); a **faint glow runs just inside the rim** (`inset 0 0 14px`); it sits on a **soft shadow**; the **selected tab is a second, brighter piece of the same glass** (the lens: `backdrop-filter: blur(6px) saturate(210%) brightness(1.18)`, 1 px rim). Tokens `--lg-fill` (light `rgba(255,255,255,.52)`, dark `rgba(30,41,59,.34)`), `--lg-blur` (16/18 px), `--lg-rim`, `--lg-rim-dim`, `--lg-glow`, `--lg-lens`, `--lg-lens-rim`, `--lg-shadow`. **Not reproduced:** refraction (bending what is behind), which needs an SVG filter inside `backdrop-filter` that **Safari does not draw**.
* **Position**: the bar floats `--bar-gap` (16 pt on a notched phone, 8 pt elsewhere) from the bottom, 14 px from each side, 62 pt tall, 999 px radius; a gradient fade (`body::after`) under it.
* **Fallbacks**: `prefers-reduced-transparency: reduce` → plain surface; no blur → plain surface; `prefers-reduced-motion` → no lens transition.

### 16.2 Motion

Lens: `transform .62s cubic-bezier(.3,1.35,.5,1)` plus a stretch keyframe proportional to distance travelled (`--stretch`), pressed scale 1.1 × 1.14, draggable (pointer events on the bar). Pages push/pop (`msgr-push`/`msgr-pop`, 0.42 s, mirrored for RTL). Buttons press with a spring scale. Switch knob 0.36 s spring.

### 16.3 Themes

Light, Dark, **Automatic** (follows `prefers-color-scheme`; key `poorija_theme_auto`). `setTheme('light'|'dark')` toggles `html.dark` and stores `poorija_theme`. The dark palette is **P00RIJA Cryptography’s slate** (not near-black); light is a cool grey. The screens before the app (language, install gate, first password) are an **always-dark glass card in both themes** (`80-gate.css`) so text stays readable.

### 16.4 Text size and fonts

* **Text size** is a **slider, 80 %–140 %** (Settings → Appearance → Text → “اندازهٔ نوشتار / Text size”). It maps to a body font size of `16 px × value` stored in `state.settings.typography.fontSize` (arbitrary values allowed; the old three-option select `#settingFontSize` now carries any value). `followTextSize` publishes `--ui-text` (px) and `--fs` (factor 0.75–1.5, clamped); every font size in the interface layer is `calc(Npx * var(--fs))` and `html.msgr { font-size: calc(16px * var(--fs)) }` scales rem-based legacy rules. Verified on the simulator: at 130 % a row label went 17 → 22 px, the tab-bar label 10 → 13 px, bubbles 16 → 20.8 px.
* **Fonts**: separate Persian and English choices (`#settingFontFa`, `#settingFontEn`), applied to `document.body.style.fontFamily` by language; every interface rule uses `font: inherit`/`font-family: inherit`, so the choice reaches bubbles, composer, rows, the bar and the card (verified with Tahoma on all of them in 2.3.0). Default: Vazirmatn (fa), Inter (en). Available: Vazirmatn, Inter, Roboto, Rubik, Open Sans, Lato, Noto Naskh Arabic, IBM Plex Sans Arabic, Harmattan, Parastoo, Zain, Playpen Sans Arabic, Beiruti, El Messiri, Baloo Bhaijaan 2, Cascadia Code, Handjet, BYekan, Tahoma.

### 16.5 Languages and direction

`translations = { fa: {…}, en: {…} }` in `js/app.js` (≈ 760 Persian keys at lines 207–763, English from 764); `data-i18n` attributes in the HTML (574 nodes); `getTranslatedText(key)`; `switchLanguage()`/`updateLanguage()`; the page `dir` follows; a `poorija:language-changed` event lets dynamic views redraw. Dynamic strings in new code use `t('persian', 'english')`. **Guards**: `tools/audit-i18n.cjs` (keys present in English but not Persian), `tests/e2e/tabsweep.mjs` (no untranslated string on any tab). Numbers use Persian digits where the app localises (clocks, dates in Jalali with `toLocaleDigits`).

---

## 17. The interface: desktop layout (≥ 1000 px)

* **Rail** (`#mobileTabBar` becomes a side rail, `--rail-w` 76 px): a **flat surface** (`--cell`), tabs as rounded-square buttons (58 px), the lit tab a rounded-square lens (`max-height: 64px`; it could be measured as tall as the rail itself when the bar was measured before the grid settled — clamped in `placeLens`). No glass on the rail (glass is the phone’s floating bar), no `body::after` fade.
* **Columns**: `grid-template-columns: var(--list-w) minmax(0,1fr)` — list (380 px) and conversation side by side; thread padding `8 %` for readable line length.
* **Empty thread**: no composer while nothing is open (`.chat-thread-empty > .chat-composer-bar { display: none }`), and in the Calls tab the call tools take the column.
* **Settings on a wide window**: pages are centred (`max-width: 640px`) with the profile card at the top.
* A Tauri desktop shell would set `desktop-runtime` and show window controls; **no shell project exists in the repository** (§28).

---

## 18. Settings, page by page

**Files:** `js/messenger-settings.js` (889 lines, draws everything below), `css/ui/50-settings.css`, `55-pages.css`, `57-controls.css`. **Public API:** `window.PoorijaSettingsPages = { open(id), back(), reset(), refresh(), depth(), title(), current(), pages() }`.

### 18.1 How a page is built

| Concept | Meaning |
|---|---|
| `definePage(id, { title, root?, blocks, onBuild? })` | registers a page; `title` is a function (language-aware) |
| **block** | one of `{ native: () => html, after?: (holder) => void }` (drawn again each time the page is shown, so it shows live values) or `{ legacy: () => nodes, wrap?, header? }` (existing DOM nodes *moved* into the page, filled once) |
| Stack | `stack = ['root', …]`; `open(id)` pushes with a push animation, `back()` pops (pop animation); `reset()` returns to root; the shell’s back button asks `PoorijaSettingsPages.depth()` |
| `row(o)` | a button row: `icon` tile (`--tile` colour), `label`, `value`, chevron (when `go`/`arrow`), `danger`, `go` = open page, `fn` = action |
| `toggle(o)` | a switch row bound to a checkbox the app already has (`data-bind="<sourceId>"`); omitted if the source node does not exist |
| `choice(o)` | a row whose value is the text of the selected `<option>` of a source `<select>`; opens a **choice page** (list of options with a check) |
| `field(o)` | label + input bound to a source input (`data-field="<sourceId>"`); typing sets the original and fires its own `input`/`change` |
| `group(header, rows, footer)` | an inset-grouped list with optional header/footer text |
| `buttonsRow([{label, icon, fn, danger, on}])` | a row of small buttons side by side sharing the width |
| `act(fn)` | registers a click handler; the markup carries `data-a="<n>"`, a single delegated listener on the host runs it (ids kept in a map, trimmed at 4000 entries) |
| helpers | `press(id)` clicks an original button; `call(name, …)`; `textOf(id)`; `hintOf(id)` reads the sentence the old page put under a switch to use as a group footer (hidden hint ⇒ feature not on offer); `offered(id)`; `visible(id)`; `paneNodes(name)` and `cardOf(controlId)` pull legacy nodes |
| `refresh()` | redraws the current page keeping scroll position; called after state changes, on `poorija:language-changed` and `poorija:tab-switched` |
| Theme-auto helpers | `readAuto/writeAuto/applyAuto` with key `poorija_theme_auto` |

**Why “views over existing controls”:** the app’s code reads settings from controls by id (`autoLockToggle`, `settingFontFa`, `chatSendReceipts` …). Re-implementing each setting would fork behaviour and tests. The old Settings tab’s cards that belong to no page (the cipher-suite algorithms, tab order, the old desktop shell) are **parked** in `#msgrParked` (hidden, not deleted) because the code that reads settings still names them.

### 18.2 The pages

All page titles are shown by the shell’s top bar (`PoorijaMessenger.title()`); each pushed page has a glass back chevron and no title text next to it.

#### Root (list)

1. **Profile card** (`.msgr-hero-card`) — the same card P00RIJA Cryptography has, not a thumbnail row:
   * Top-start: three quick round buttons — *Identity and QR* (`fa-id-card`, presses `chatShowIdentityQrBtn`), *Profile* (`fa-gear` → page `me`), *Lock the app* (`fa-lock-open`, `lockApp()`).
   * Main: **name** (button → `me`), **mood chip** (“Status” if empty → `me`), **connection line** (dot coloured by `chatState.connectionState`: connected/connecting/offline; text = `chatConnectionStatus`), **clocks strip** (the live `#chatProfileClocks` node, moved in; tapping it opens page `clocks`).
   * Side: **avatar** (64 px, photo or initial → `me`) and the **pixel pet** (`#chatPet`, moved in).
   * The clocks and pet nodes are *parked* in `#msgrParked` before each redraw so their timers/listeners survive.
   * Size was cut in 2.3.0 (padding, avatar, name, quick buttons; pet 72→44 px).
2. **Group:** *My devices* (`fa-mobile-screen-button`, orange) → `devices`.
3. **Group:** *Notifications and sounds* (red bell) → `notifications`; *Privacy and security* (grey lock) → `privacy`; *Data and storage* (green) → `data`; *Appearance* (cyan palette) → `appearance`; *Language* (purple; value Persian/English) → `language`; *Server and connection* (indigo) → `connection`.
4. **Group:** *Help* (opens the app’s Help view via `PoorijaMessenger.openRow('help')`); *About me* (`openRow('about')`).
5. **Group:** *Lock the app* (danger row) → `lockApp()`.

> **Removed from Settings on purpose (2.3.0 feedback):** *Saved messages* (moved to the Chats “more” menu) and *Calls* (it is a tab) — Telegram’s own Settings repeats them but here they were duplicates; *“Secure chat switch”* and the row *“رمز قفل / خاموش”* — meaningless in this app (it is always secure; there is one lock, the master password).

#### `clocks` — World clocks

* Group “Your clocks”: **Local time** row (read-only, `formatZoneTime()`), then each kept zone with label, UTC-offset small text, current time and a **trash button** (`saveClocks(zones minus this)`); footer explains the limit when `CHAT_MAX_CLOCKS` (default 2) is reached.
* Group “Add a city”: a search input (`data-clock-search`); typing lists up to 30 matching IANA zones (`knownTimeZones()`), each row with `+`; selecting adds `{ tz, label }` through `saveClocks` and redraws; over the limit shows a warning toast.
* This used to be a full-screen sheet opened from the card; it is a normal Settings page since 2.3.0.

#### `me` — Profile (everything on one page, no sheets)

* **Hero**: tappable avatar (96 px, camera badge → `chatProfileAvatarBtn`), name, connection text.
* **Name** field (max 40; on change writes `chatProfileName` and presses `chatSaveProfileBtn`) — footer “Your contacts see this name.”
* **Status** field (max 40; `saveMood()` writes `chatState.profile.mood`, encrypts `CHAT_PROFILE_STORAGE_KEY`, redraws the mood chip, `broadcastHello()` and `announceProfileToContacts()`) — shown beside the name in conversations.
* **Secure identity** group: *Key fingerprint* (32 hex chars shown, tap copies), *Device id* (22 chars, tap copies), *Show my QR code*, *Copy my identity card* (`copyChatFullIdentity()`), *Export / Import portable profile*, *Link this device to an account*, *Linked devices* (value = count) → `devices`.
* Row *World clocks* → `clocks`.
* Danger row **Reset chat key** (`chatResetIdentityBtn`) — footer: “Everyone has to accept the new key again.”

#### `devices` — My devices

* A legacy pane moved in (`paneNodes('devices')`), wrapped in one plain card; `onBuild` sets `chatState.settingsPane = 'devices'` and calls `renderDevicesCard()` so a device coming or going redraws it. Shows this device (rename, id), the other devices of the same identity (linked via `chat-link`/`identity-link`), per-device remove, and the linked-device count. Styled to the Telegram “devices” look in 2.3.0 (`55-pages.css`).

#### `notifications` — Notifications and sounds (native since 2.3.0)

| Group | Rows (source control id) |
|---|---|
| Notifications | **Show notifications** switch (`notificationsToggle`); footer = permission hint (`notificationPermissionHint`) |
| Background notifications | **Notify while the app is closed** (`pushBackgroundToggle`); *Remove the subscription after* (`pushTtlSelect`: 30/60/90/120/180 days — only when visible); footer = `pushStatusHint` |
| Call ringtone | *Sound* choice (`chatRingtoneSelect`: classic / pulse / signal / soft); a **side-by-side buttons row**: Test (`chatTestRingtoneBtn`), Custom sound (`chatImportRingtoneBtn`), Remove (`chatDeleteRingtoneBtn`, only when a custom sound exists) |
| Message sound | *Sound* choice (`chatMessageToneSelect`: chime / pop / ping / bell / silent); Test, Custom sound, Remove (same pattern) |
| UnifiedPush | the legacy card `upState` moved in only when `unifiedPushCard` is visible (Android without Google Play) |

#### `privacy` — Privacy and security

* **Lock**: *Auto-lock* switch (`autoLockToggle`), *Lock after* choice (`autoLockTime`: 1 / 5 / 15 / 30 min / custom), *Hide the screen when switching apps* (`screenGuardToggle`); footer: “The app opens with your master password. Auto-lock closes it again after a while.”
* **Unlocking**: *Biometrics / passkey* (value On/Off → `togglePasskeyQuickUnlock()`), *Two-step verification* (value On/Off → `toggle2FA()`; the authenticator’s scanning camera opens in a dialog since 2.98.95 of the parent).
* **Master password**: *Change master password* → `password`; *Recovery questions* → `recovery`.
* **Decoy profile**: row *Decoy profile password* → `panic` (opens the decoy profile, erases nothing, §7.2). **Danger zone**: row *Erase everything on this device* → `resetAppSettings()` (confirmation, then a typed word).
* **Messages**: *Send read receipts* (`chatSendReceipts`), *Link previews* (`chatLinkPreviews`, only when offered) with hints as footer.
* **Files**: *Strip metadata when sending a file* (`chatStripMetadataToggle`), *Offer to convert HEIC photos to JPEG* (`chatConvertHeicToggle`).
* Sub-pages `password` (`changePasswordSection`), `recovery` (`changeSecurityQuestionsSection`), `panic` (card of `panicPasswordInput_dz`) are **legacy forms moved in** — functional, still the old card look (open work, §28).

#### `data` — Data and storage (native since 2.3.0)

* **Encrypted storage** stats (counted when the page opens by `renderStorageCard()`; re-drawn 0.8 s later because quota arrives async): rows copied from `#chatStorageStats` (messages, media bytes, stickers, quota, …); footer: AES-256-GCM on this device, key protected by the master password, never leaves it.
* **Automatic download** choice (`chatAutoDownloadLimit`: 1 / 5 / 10 / 25 / 50 / 100 MB / never-ask); footer = storage note.
* **Free up space**: Clear older than 30 days (`chatClearOldMediaBtn`), Clear all media, Delete all sticker packs (danger).
* **Chats**: Export, Import, Clear all history.
* **Files and backup**: *Local files* (`chatFileManagerToggle`, reveals `chatFileManager` below), *Manage sticker packs*, *File manager* (`openRow('vault')`), *Migration and backup* (`openRow('migration')`).

#### `appearance`

1. **Live preview** (`#chatLivePreview`, the legacy card **moved to the top and kept in sight** while sliders are used; five sample bubbles: two incoming, three outgoing with the sent/delivered/seen ticks). It is a faithful miniature of the thread: it reads `--ap-*` (§13.3).
2. **Theme**: Light / Dark / Automatic (check mark; automatic follows `prefers-color-scheme` and stores `poorija_theme_auto`).
3. **Text** group: **Text size slider** (80–140 %, shows `NN%`), **Persian font** and **English font** choices (rows are drawn in their own typeface).
4. **Chat appearance** (header; legacy pane `appearance` moved in, wrapped):
   * *Chat theme* select (`chatChatTheme`): Follow the app theme · Midnight · Parchment · Forest · Rose · Slate (each sets `bubbleMe/bubbleThem/textMe/textThem/background`).
   * *Bubble* section: **My bubble** colour (`chatBubbleMineColor`), **Their bubble** colour (`chatBubbleTheirsColor`), **Transparency** 35–100 % (`chatBubbleAlpha`), **Corner radius** 2–26 px (`chatBubbleRadius`), **Chat text zoom** 85–140 % (`chatZoom`).
   * *Background* section: grid of presets (None, Dusk, Ink, Sand, Mint, Plum, Grid, …; `chatBackgroundGrid`), **Blur** 0–24 px (`chatBackgroundBlur`), **Custom picture** upload (`chatBackgroundUploadBtn`, accepts images/HEIC/HEIF/DNG; stored only on this device and **never sent**) and remove.
   * *Message ticks*: **Tick profile** select (`chatAppearanceProfile`: Theme colours (default) · High contrast (`#cbd5e1 / #fff / #4ade80`)), **Sent / Delivered / Seen** colours (`chatTickSentColor`, `…DeliveredColor`, `…SeenColor`), *Back to theme colour*, **Reset all appearance** (danger), and a **measured contrast ratio** per colour (`tickContrastReport()`, warns under 3:1).
   * Everything is stored as one JSON in `localStorage['poorija_chat_appearance']` (`{ profile, colors, chatTheme, bubble:{me,them,alpha,radius}, background, zoom, blur }`) and applied by `applyChatAppearance()` as `--chat-*` properties; `followAppearance()` mirrors them to `--ap-*` for the interface layer and the live preview.

#### `language`

Two rows, **فارسی / English**, check on the active one; `switchLanguage()` toggles and fires `poorija:language-changed`; every page redraws.

#### `connection` — Server and connection

* **Connection** switches: *Connect automatically* (`chatAutoConnect`), *Cross-relay communication* (`chatCrossRelayComm`), *Guest relay of the same family* (`chatUseGuestRelays`), *Local discovery* (`chatAutoDiscovery`), *Suspension countdown* (`chatShowSuspensionCountdown`).
* **Server**: *Relay address* field (`chatServerUrl`, LTR), **relay fingerprint** row (`chatRelayIdentityValue`, amber when it changed), **Accept the new identity** row (visible only when a pin change is waiting; clears `chatState.relayPinPromptOpen` and calls `promptRelayPinChange()` — the confirm dialog), *Proxy* field and *Save and restart* (only when the proxy field is shown, i.e. in the native shells).
* **Calls**: *Video calls* (`chatAllowVideo`), *Background noise removal* (`chatCallNoiseToggle`), *Public STUN (Google / Twilio)* (`chatPublicStun`); **TURN server** fields: Address, Username, Password (`chatTurnUrl`, `…Username`, `…Credential`).
* **Actions**: Connect, Reconnect, Discover local, Export / Import connection config.
* **Diagnostics**: *Chat status report* (`chatDiagBtn`, fills `chatDiagBody`, moved in below), *Remove unused contacts* (`chatPruneContactsBtn`).

#### Vault / Migration / Help / About rows

Not pages of this file: `PoorijaMessenger.openRow('vault' | 'migration' | 'help' | 'about')` opens the app’s own sections (File manager, Migration and backup, Help, About) as full views with a back arrow to Settings. They are the **most legacy-looking** screens left (§28).

### 18.3 Interactions worth knowing

* **Everything is live**: change a switch and the original control’s `change` handler runs; the page redraws 50 ms later to show derived hints.
* **Pages are rebuilt when the language changes** (`poorija:language-changed`), so Persian ↔ English is instant.
* **Choice pages** are one generic page: `openChoice({source, label, fonts?})` lists the `<option>`s; picking sets the original `<select>`, fires `change`, pops back, and refreshes.
* **Text-size slider**: writes the select `#settingFontSize` (adding an `<option>` for the odd value, e.g. `19.2px`) then `applyAppearanceSettings()`; `followTextSize()` publishes `--ui-text`/`--fs` (§16.4).
* **First open** builds every page once (`setTimeout 0`) so their legacy nodes leave the old cards immediately; what no page claims is parked.

---

## 19. Features in detail

Each feature lists **what the user sees**, **how it works**, and **where the code is** (module numbers are `js/chat/NN-*.js`, §31 Appendix A). All of it runs in the browser (or the native shell’s webview); the relay only carries sealed envelopes and signalling.

### 19.1 Text, replies, formatting
* **Formatting markers** travel as plain characters inside the encrypted text, so an older build shows them as typed and nothing needs negotiating: `*bold*`, `_italic_`, `~strike~`, `` `code` ``, ```` ```block``` ````, `||spoiler||`, links (module 45). The composer’s **format bar** wraps the selection.
* **Reply, edit, delete-for-everyone, forward (with “forwarded from”), reactions, pin, copy, multi-select** (27 render, 10 selection with swipe-to-reply).
* **Drafts** per conversation, “mark as unread”, jump to first unread (22). **Scheduled messages** are kept encrypted *on this device* and sent through the ordinary send path at their time — no server holds a message for later; the interface says the app must be open (47).
* **Link previews** are off until enabled; the desktop shell fetches the page itself (`src-tauri/src/link_preview.rs`, public addresses only, pinned against DNS rebinding, capped); the web/phone apps cannot read other sites, so the relay fetches through `scripts/lib/link-preview.js` (SSRF-guarded) and the person is told who fetches (54).
* **Search**: in-conversation and global (engine, popup, preview, jump) (08); saved messages (46) — a conversation with nobody but this account, mirrored to its other devices.

### 19.2 Structured messages (05)
One wire type, `rich` (an ordinary encrypted message whose plaintext is JSON with a `kind`, so it inherits the session key, receipts, offline envelope and self-destruct timer), carries four kinds (`RICH_KINDS`): **poll** (2–10 options; **votes travel the same way** — a ballot is content, not metadata, and the relay must not read it for an offline peer), **location** (static), **contact card**, **live location** (50: one card, then small encrypted updates for a chosen time; updates are never stored by a relay for someone away and never ring a phone), **call event cards** (25).

### 19.3 Voice messages, files and media
* **Voice messages**: record with the microphone button; waveform, playback speed, seek.
* **Files** (29–32 streaming transfer): chunked, encrypted, resumable transfers over the direct data channel when one exists, otherwise sealed relay envelopes (media mailbox keeps them 7 days); “Receive file” cards; automatic download up to a limit (§18 `data`); **metadata stripping** (JPEG/PNG EXIF, `js/metadata.js`), HEIC→JPEG offer (`js/image-formats.js`), steganography helper (`js/stego.js`, a tool carried over, not a chat feature).
* **Media vault** (02): every attachment is encrypted (AES-256-GCM) into IndexedDB so it survives reloads; **file manager** (17–18) browses/exports/deletes local files.
* **Between your own devices** (57): a device asks a sibling that is online for a file and the bytes go device-to-device over a DTLS data channel, never through the relay.
* **View once**, **hidden message** (tap to reveal), **self-destruct timers** (10 s … 10 h, set from the plus menu; the timer lives with the message on both sides).

### 19.4 Stickers and GIFs
* **Packs** are stored locally (encrypted). Import sources: image files, a ZIP, **a Telegram share link** (see §21.4), and ones pasted or inserted from the phone keyboard.
* **Three ways in for GIFs/stickers** (55): paste (browser “Copy image”, a sticker long-pressed in another messenger), the keyboard (Gboard GIFs/stickers, iOS Memoji/stickers via the rich keyboard box), and a built-in picker.
* **Motion** (56): animated GIF/WebP/PNG are forced to loop forever, each sticker has a still, a sticker can be held up to look at.

### 19.5 Conversations: lock, requests, verification
* **Conversation lock** (07): a **separate PIN** for the chat — “a second door”, because conversations are the most sensitive thing in the app and the likeliest to be read over a shoulder. ≥ 4 digits (Persian/Arabic digits are folded to ASCII before hashing, so ۱۲۳۴ and 1234 are the same PIN); **the PIN is never stored**, only a PBKDF2-SHA256 digest with a per-install salt at **600 000 iterations** (the record carries its own iteration count; older locks at 150 000 keep working); key `poorija_chat_lock`; optional biometrics (`poorija_chat_lock_biometrics`) and attempt counter (`poorija_chat_lock_attempts`); per-conversation lock list `poorija_convo_locks`; a locked conversation shows no preview; after too many wrong PINs the shared-lock wipe rule (`startSharedLockWipe`) can erase the app’s data. Suites `chatlock2`, `lockdefence`.
* **Message requests** (49): anything from a non-contact waits under **Requests** — no sound, no notification, **no read receipt**, no link preview, no auto-download — until accepted; accepting makes them a contact.
* **Verification**: six-emoji key shown on both screens of a call (09), **safety numbers** (emoji + QR), **scan-to-verify** (48: each side shows a code holding both fingerprints in its own order; the scanner accepts only a code that names the scanner’s key — a relay that handed each side its own key produces two codes that do not fit); a **verified** contact’s key change **blocks** sending until re-verified.
* **Block, mute, archive, pin, leave, delete conversation** — from the row menu and the thread menu.

### 19.6 Groups (06, 11, 41)
* Group = owner + admins + members with **per-member permissions** (11: write, send media, add members, change info, start calls, pin, …; the first four are the group’s own defaults), invite codes, avatar and description, mentions.
* **No group key**: a group message is one sealed send **per member** (so each member’s own session protects it); **member cards** (41) carry each member’s public key and home relay, so a group spanning several relays reaches everyone, not only those who swapped cards.
* **Group calls**: full mesh (12–16, see §12): stage with pinning and presenting (13), roster (who talks, who wants to — raise hand, 14), patch-not-rebuild rendering (15), signalling (16).
* **Roster messages** to members: join, leave, role change, rename — all encrypted per member.

### 19.7 Calls
See §12 for transport. User-visible: voice/video from the thread header or the Calls tab; **emoji verification**; **noise suppression** (RNNoise in an AudioWorklet, 60); camera flip; speaker; mute; screen share; **call log** with filters and per-call delete (25); ringtone choices and custom ringtone (§18); **cross-relay calls** (39: offer, answer and ICE candidates travel as relay payloads sealed to the peer); **path manager** (42: reads the selected ICE pair and, when a direct path dies, moves media to a TURN both ends can reach — measured behaviour of cross-border UDP flows).

### 19.8 Several devices (44, 57–59)
* Every device of an account holds the **same identity key** (so contacts see one account) **plus a key of its own** (ECDSA P-256, never exported). The **primary** signs a **roster** (58) that lists the devices; a device not on the roster is not a device of the account.
* **Linking** (59): the Telegram/WhatsApp way — one device shows a QR, the other scans (modes *add* and *join*; either side may show). The QR carries a meeting point, not a secret worth stealing; the link is finished over an encrypted channel with a short human check.
* **History sync** (44): device-to-device while both are online; **no server keeps history/files/sessions for a second device**; a device that was away catches up when a sibling is online. (The shared mailbox that used to break this rule is gone.)
* **Revocation** removes a device from the roster; it can no longer receive new sessions.

### 19.9 Privacy and anti-censorship tools
* **Sealed sender** and **padding** (51, §9) hide who wrote and how long; the dashboard and relay never see inner type or time.
* **Relay mirrors** (52): further addresses of the same relay the operator declared (`/relay-mirrors`, HMAC under a secret sealed to the relay key) for when the main address is blocked.
* **Front doors**, **guest relays**, **relay directory**, **smart relay choice** (61–63, §11): the app keeps a signed list of the operator’s relays, picks the best home, and falls back to a guest relay while home is unreachable — without overwriting the configured address.
* **Carrier** (38, UI “Send another way”; suites `carrier`, `carriersheet`): when the relays cannot be reached, the messengers that still work are the ones permitted to work *because they can be read*. Tunnelling through one starts a detection race, and a detected tunnel is attributed to the **person**, so the app does not tunnel. Instead it **hides a message sealed to the contact’s key inside an ordinary photograph** (steganography, `js/stego.js`, always the **DCT** codec, the one that survives a messenger re-encoding the photo; the wrapped key alone is 384 bytes of the ≈ 3 KB a small photo holds, so the wire format is length-prefixed binary). The person sends the photo through whatever carrier works; the recipient’s app extracts and opens it. **Honest limits** (the UI repeats them): the carrier still learns that a photo went to that person; a statistical analyst can tell something was embedded but cannot read it; cropping or resizing destroys it, re-encoding does not.
* **Native proxy** (53): a local v2ray/xray/Tor in front of the relay in the desktop shell; on phones it must be set system-wide.
* **Route finder** (40): if the recipient’s home relay is unknown, ask linked relays; a queued-at-wrong-place envelope is re-sent when the right relay becomes known (the relay answers `known:false`).
* **Tools** (37, the chat’s own “Tools” pane; reachable from the Server and connection page’s diagnostics rows) — four tools, each answering a question the app could not answer before: **Which relay works** (probe every origin the installation knows — configured, built in, in use — through `/chat-health`, with its speed); **Start the session** (drop the session key so the next message negotiates fresh ones — “forward secrecy on demand”, and the way out when a restored backup or a reinstalled peer makes every message fail to decrypt); **What is still out** (what has left this device and not been acknowledged, and how long ago — “sent” is not “delivered”); **How is this call** (round-trip time, loss, jitter and bitrate read from the peer connection itself).

### 19.10 Vault, lock, panic
Master password → vault (§7); **auto-lock**, **screen guard** (blank on app switch, `js/screen-guard.js`), **biometric/passkey** quick unlock, **TOTP two-step**, **recovery questions**, **duress password** (shown in Settings as “Emergency erase password”; typing it on the login screen **opens the alternate space and erases nothing** — see §7.2 and the label inconsistency in §28 #19), **decoy profile** (the second vault slot, created at install, indistinguishable by design), **emergency wipe** (`emergencyWipe`: a real erase of storage, databases, caches, the service worker and in-memory keys, also asking the relay to purge what it holds for this identity; reached from “reset everything”, the shared-lock wipe rule, `triggerPanic()` and **a double press of Escape within 500 ms — which first asks for confirmation, §28 #20**), **file manager** with export/import of a portable profile (`vault-profiles.js`, `backup.js`).

---

## 20. Local Link: chat with no server

**Files:** `js/local-link.js` (1110 lines), `js/local-mesh.js` (1215), `js/local-room.js` (865), `js/qr-kit.js`, `css/ui/45-local.css`. Tab: **Local** (`#content-locallink`).

* **LAN pairing**: a machine that runs the relay on the local network shows its address as a QR code and others read it with the camera (typing `http://192.168.1.34:11220` on a phone is the step that fails).
* **Direct link** (no relay at all): two devices on one Wi-Fi exchange WebRTC session descriptions through **QR codes** (~1 550 characters in total, chunks of 700 chars per QR) or a clipboard, then talk over an encrypted data channel. The two introduction texts are the introduction; the channel is **ECDH → HKDF → AES-256-GCM** with its own key per pair (the public key travelled through a camera, the strongest introduction in the app).
* **Measured**: browsers replace local IPs in ICE candidates with mDNS names, which sounds like it would defeat this but does not — both sides resolve each other on the same network. What it cannot survive is **client isolation** (the default on guest/public Wi-Fi); the interface says so rather than failing silently.
* **Rooms (mesh)**: up to **16** people; joining costs exactly one QR scan **with the host**, however many are in the room; the host brokers the introductions (passes two session descriptions) then the two talk directly. Sixteen → 120 links, 15 per device; the call code **warns above six cameras** and offers audio-only (~1/100 of the bandwidth). Every link has its own key.
* **No camera path**: *With text or file* (copy-paste the two blobs, or save/load a file).
* **UI** (15.3): status chip, *Start a new link*, *Scan the other side’s code*, *No camera: with text or file*, *Disconnect and start over*, note about hotspots/guest Wi-Fi. The room opens by itself when the first link forms (`local-room.js` renders from mesh events only — a view with its own list could disagree with the room).
* **Why it matters**: works with the Internet down; nothing here touches a relay, the operator, or the vault’s identity (a Local peer is a local identity, not a contact).

---

## 21. Telegram integration

The operator’s Telegram bot is **a monitoring and convenience channel of the relay**, not a messaging path for users. Users’ messages never touch Telegram. Two things use it: **server status/alerts to the operator** and **sticker-pack import for users**. (P00RIJA Cryptography has the same arrangement; this app’s copy is independent.)

### 21.1 Where the pieces are
| Piece | File |
|---|---|
| Alert engine (disk, memory, relay memory, open files, TURN, bandwidth, peer relays) | `scripts/lib/relay-alerts.js` |
| Card rendering, fleet report | `scripts/lib/relay-report.js` |
| All wording, Persian and English | `scripts/lib/telegram-text.js` |
| Settings model, validation, defaults from `.env` | `scripts/lib/telegram-settings.js` |
| Sticker pack fetching (Bot API) | `scripts/lib/telegram-stickers.js` |
| Command reader, sender, daily report, delivery policy | `scripts/server.js` (≈ lines 4416–4480 stickers/settings, 8831 delivery, 9260 reader, daily report below it) |
| Central panel Telegram tab | `tools/panel/*`, `tools/control-panel.js` |
| Client: import dialog | `js/chat/35-sheets-profile-clocks-2.js` (menu “From a Telegram link”), link parsing in `js/chat/16-group-call-signalling.js` (`t.me/addstickers/<name>`, `telegram.me`, `telegram.dog`, `addstickers?set=`) |

### 21.2 Settings (operator-changed at runtime from the central panel; `.env` gives defaults; what the panel sets wins)
`enabled` · `language` (`fa`/`en`, default fa) · `label` (≤ 60 chars) · `chatId` (numeric id or `@channel`) · `topics` (a forum topic id per kind: `alerts`, `reports`, `security`, `updates`, `other`) · `categories` (each of `warn critical resolved reminder start security partner update test peer report` on/off + sound/silent; defaults silent for `resolved reminder start report`) · `alertKeys` (each of `disk memory relay-memory files turn-down turn-ports bandwidth peer peer-via` on/off) · `thresholds` (`diskFreePct 10`, `diskFreeGb 2`, `memoryFreePct 10`, `relayMemoryPct 75`, `filesPct 80`, `turnPct 80`, `linkMbps 0`, `linkPct 80`, `peerDownMinutes 10`) · `checkSeconds` (default 60, min 5) · `remindHours` (default 6) · `minGapSeconds` · `quiet` (hours, mode `silent`/hold, *critical passes*) · `timezone` (default `Asia/Tehran`) · `report` (daily report on/off, `at` default `09:00`, or `off`) · `commands` (each on/off) · `admins` (other chats allowed to use commands) · `buttons` (inline “mute an hour”, “status”) · `templates` (`style`: classic/boxed/compact/minimal/detailed/custom; `separator`: heavy/light/double/dots/none; `direction`, `icons`, `quote`, `footer`, `showIdentity`, `showSnapshot`, operator `custom` template) · `muteUntil`.
Stored in the relay’s data folder beside the offline store (`telegram-settings.json`, owner-only).

### 21.3 Commands
`/status` (this server), `/servers` (the fleet), `/alerts` (what is wrong now), `/updates`, `/version`, `/mute` (one hour or given), `/unmute`, `/help`. The relay long-polls Telegram for them (`readTelegramCommands`; disabled by `CHAT_TELEGRAM_COMMANDS=0` or `CHAT_ALERTS=0`); only the configured chat (and `admins`) may use them.

### 21.4 Sticker import (users)
* A user pastes a Telegram share link; the app extracts the pack name (`/^[A-Za-z0-9_]{1,64}$/`) and asks **its own relay** `GET /telegram-stickers/set?name=…` then `GET /telegram-stickers/file?id=…` (file id `/^[A-Za-z0-9_-]{20,200}$/`).
* Telegram hands packs out only through the **Bot API**, which needs a bot token, and Telegram is unreachable from some networks the app is used on. So **a relay that has the token asks Telegram on the client’s behalf**; **a relay that has none but can reach one that does (`TELEGRAM_STICKERS_UPSTREAM`) passes the question along**. The token never leaves the relay; Telegram sees the relay’s address, not the person’s; the relay keeps only a short cache of which files make up a pack.
* Limits: a file ≤ 2 MB, a JSON reply ≤ 1 MB, 15 s timeout, ≤ 240 stickers per pack, `CHAT_TELEGRAM_MAX_IN_FLIGHT` (default 12) concurrent requests (503 `busy` beyond), rate-limited (`rateLimit('telegram')`). It speaks **only** to Telegram about a name or id whose shape it checked — **not a proxy for anything else**.
* `/chat-health` reports `telegramStickers: true` when the relay can answer (token present or upstream set); the client greys the option out otherwise.

### 21.5 Where the token lives (rules)
The bot token is a secret of the **operator**, never part of the repository, a build, a document, a log or a request to anything except `api.telegram.org`. It is held in `telegram-token` (owner-only) in the data folder of **the one relay that talks to Telegram**; the other relays of the fleet only set `TELEGRAM_STICKERS_UPSTREAM` to that relay. The panel shows whether a token is set and its **last characters only**; one removed from the panel stays removed whatever `.env` says. (The deployed fleet follows exactly this arrangement; no secret appears in this document.)

---

## 22. Tests and guards

### 22.1 Philosophy
**Every suite exists because something shipped broken.** The end-to-end suites drive two or three **real browsers** (Playwright; Chromium by default, WebKit with `E2E_ENGINE=webkit`) against a **real relay** with real WebRTC, and **measure** (box widths, aspect ratios, video element ids, bytes on disk) instead of taking snapshots. The security suites **play the attacker** and *failed before the fix they cover* (`oracle`, `prekeysig`, `downgrade`, `holdhybrid`, `sealedsender`…). “Write the failing test first.” A failing suite is evidence.

### 22.2 How to run
| Command | What |
|---|---|
| `npm run test:all` | guards (`check:versions`, `check:ui`, `check:assets`, `check:collisions`, `check:mlkem`) + core suites (`chatonly`, `messenger`, `composer`, `hybrid`, `downgrade`, `prekeysig`, `oracle`, `prekeyhybrid`, `holdhybrid`, `interop`…) |
| `node tests/e2e/<name>.mjs` | one suite on its own (what you do while fixing one thing) |
| `npm run test:e2e [-- a b]` | `run-all.mjs`: every suite against a running instance (≈ 25 min), one table at the end |
| `npm run test:local -- name…` | `_local-stack.mjs`: an isolated same-origin stack (static + relay on one port, fresh stores, auto shutdown) |
| `npm test` | Jest (jsdom) unit tests via `config/jest.config.cjs` (`--passWithNoTests`) |
| `npm run test:relays` | relay throughput/mail-delivery/offline-size/UnifiedPush/allow-list tests against `standalone-relay/server.js` and `scripts/server.js` |
| `npm run audit`, `audit:prelock` | static audits (`tests/e2e/audit.mjs`: no `eval`/`Function`, no third-party origin, no key material in the console; `tools/prelock-audit.cjs`) |

### 22.3 Three kinds of suite (by what they need)
1. **Bring up their own relay** (import `_two-stacks.mjs`): `messenger`, `chatonly`, `hybrid`, `holdhybrid`, `delivery`, `siblingsync`, `receipts`, `sealedsender`, `interop`, most newer ones. Nothing to start.
2. **Want page and relay on one origin** (older): `groups`, `grouplife`, `groupparity` → `E2E_PORT=8261 node tests/e2e/_local-stack.mjs groups grouplife groupparity`. Run with split static+relay ports they all fail at the first network step — **the setup, not a regression**.
3. **Want a private relay with its data in a directory**: `forwardsecrecy`, `offline` — start `scripts/server.js` with `CHAT_DATA_DIR`, `CHAT_OFFLINE_STORE_PATH`, `MONITOR_PASSWORD`; give the suite `PKG_URL`, `PKG_RELAY`, `RELAY_URL` and the same two paths.
**Do not edit a served file while a suite runs** — suites load the working tree.

### 22.4 Harnesses (helpers, names start with `_`)
`_chat-harness.mjs` (two-peer harness the chat suites share; toasts are read from `PoorijaApp.toasts.recent()`), `_chat-source.mjs` (the chat source as one string), `_local-stack.mjs`, `_two-stacks.mjs` (two complete linked deployments on loopback — the shape of the Finland/Iran pair), `_three-stacks.mjs`, `_relay-fleet.mjs` (any number of real relays + clients that prove their key), `_relay-identity.mjs`, `_relay-lib.mjs`, `_relay-store.mjs`, `_panel-run.mjs` (the central panel for a suite), `_settle.mjs`, `_shots*.mjs` (screenshots), `_inspect.mjs`, `_audit-contrast.mjs`, `_stress-worker.mjs`.

### 22.5 Guards (not browser suites)
| Guard | Command | Fails when |
|---|---|---|
| versions | `check:versions` (`tools/check-versions.cjs`) | the nine places that state the version disagree (§23) |
| stylesheet | `check:ui` (`tools/build-ui-css.cjs --check`) | `css/chat-ui.css` is stale |
| assets | `check:assets` (`tools/check-assets.cjs`) | an asset referenced by `index.html`/`sw.js` is missing or lacks a `?v=` tag |
| global collisions | `check:collisions` (`tools/global-collisions.cjs`) | two classic scripts declare the same top-level name (they share one scope) |
| ML-KEM | `check:mlkem` | the vendored ML-KEM does not match its known-answer tests |
| relay pins / parity | `check:relay-pins`, `check:relay-parity` | the embedded relay pin list or the standalone vs. main relay drift |
| nginx routes | `tools/check-nginx-routes.cjs` | a route the relay serves has no `location` in `config/nginx.conf` (it would fall through to the SPA) |
| i18n | `tools/audit-i18n.cjs` | a key exists in English but not Persian (or inverse) |
| DOM / handlers | `tools/audit-dom.cjs`, `audit-handlers.cjs` | an id referenced by code is not in the markup; a handler is wired twice |
| dead code | `tools/dead-code.cjs` | unreferenced functions (informational) |
| forbidden strings | `tools/forbidden-strings.txt`, `forbidden-paths.txt`, `private-strings.txt` | the working tree contains something that must never ship (secrets, personal data) |

### 22.6 Suite families (full list in Appendix B)
* **Protocol/security:** `hybrid`, `prekeyhybrid`, `holdhybrid`, `downgrade`, `prekeysig`, `oracle`, `forwardsecrecy`, `keytrust`, `sealedsender`, `cryptocore`, `duress`, `emergency`, `atrest`, `final3` (Argon2id, no password record), `panicconfirm` (double Escape asks before it wipes), `csp`, `audit`, `security`, `security3`, `legacypurge`, `upgrade`.
* **Delivery/relay:** `offline`, `delivery`, `maildelivery`, `retention`, `receipts`, `awaypush`, `push*`, `allowlist`, `relaythroughput`, `siblingsync`, `transit*`, `centralpanel`, `alerts`, `bootstrapinstall`, `applyupdate`, `certkeeper`.
* **Calls:** `callbasics`, `calls`, `callvideo`, `callmirror`, `callfix`, `calllayout`, `calllog`, `callreal`, `callquality`, `callcodec`, `callladder`, `calltuning`, `callroute`, `callchrome`, `calldup`, `adhoccall`, `gcall`, `gcallui`.
* **Interface:** `messenger` (the shell), `composer`, `settingsui`, `chatappearance`, `controls`, `chatticks`, `tabsweep` (every tab, no untranslated string), `chatonly`, `langswitch`, `langpanels`, `sileotoasts`, `scroll`, `scrollmob`, `uifix`, `nativeui`.
* **Features:** `groups`, `grouplife`, `groupparity`, `stickers`, `gifstickers`, `stickerthumbs`, `filemgr`, `filetransfer`, `bigfile`, `avatars`, `contacts`, `persist`, `chatlab`, `chattools`, `chataudit`, `carrier`, `carriersheet`, `locallink`, `localroom`, `linkroom*`, `qr*`.
* **Interop:** `interop` opens a page from **each tree** — this app and **P00RIJA Cryptography**, the parent suite whose Secure Chat this app was cut from — on one relay (the relay and first page from the tree the file is in, the second from `OTHER_ROOT`) and checks three things: **live** (a session is keyed and a message crosses each way, whichever side offers the exchange), **by relay** (a message sealed by one is opened by the other, each way), **honestly** (the side that can do more does not pretend: the session is not called hybrid, and the other is not remembered as able). Every other suite loads one build on both sides and would not notice the two drifting apart — and they have drifted on purpose: this app offers a post-quantum key exchange and prekey, the parent knows neither.

### 22.7 Known state of the suites (honest)
* **Baseline failures** (fail on `main` before 2.2.0 and were not introduced by it): `settingsui`, `chatappearance`, `controls`, `chatticks`, `calllayout` — they encode assumptions of the old interface (a section named “Settings” with no list heading, old appearance card geometry, a tab bar position). They need rewriting for the new interface (§28). `messenger`, `chatonly`, `composer` pass.
* The wide regression after 2.3.0 ran the UI suites listed above (13 failures found, fixed down to `calllayout` 2 pre-existing) plus the repository guards; the full suite run was **not** repeated after 2.3.0 (`emergency` has one baseline failure, “every database is gone — 2 left”: the new install recreates two empty databases, `poorija-media` and `poorija-stickers`, before the check; identical on the pristine 2.3.0 tree).

---

## 23. Build, versions, releases

### 23.1 There is no bundler
The app is **static files served as they are**: `index.html` loads classic scripts in order (`<script defer>`), `css/styles.css` (legacy, built from Tailwind input) and `css/chat-ui.css` (built from `css/ui/*.css`). Only two generated artefacts: `css/chat-ui.css` (`npm run build:ui`) and the Tailwind output (`config/tailwind.config.cjs`, legacy). `vendor/` holds third-party code **vendored** (no CDN): `fontawesome`, `hash-wasm` (Argon2id), `jsqr`, `jszip`, `lottie`, `mlkem` (ML-KEM-768, `tools/vendor-mlkem`), `noise-suppressor` (RNNoise worklet), `otpauth`, `peerjs`, `qrcodejs`, `sileo` (toasts, rebuilt from `tools/vendor-sileo`), `tailwind`.

### 23.2 The version is stated in nine places (`npm run check:versions`)
`package.json` (`version` = **2.3.0**, `buildTag` = **chat-v6**), `standalone-relay/package.json`, `sw.js` (`CACHE_NAME = 'poorija-chat-v2.3.0-chat-v6'`), `index.html` (every `?v=2.3.0-chat-v6` asset query), `js/app.js`, `scripts/server.js`, `config/relay-overrides.json`, `README.md`, head of `RELEASE-NOTES.md`. The build tag goes up with every release so browsers and the service worker fetch the new files. (`tools/check-versions.cjs` also knows `src-tauri/*`, `npm-package/package.json` and the mobile projects but compares them only if present — **none exists in this repository**.)

### 23.3 A release is two commits
1. **the change** (everything that changes behaviour, with its release notes and tests),
2. **a `release:` commit that only moves the version** (all nine places).
Authored and committed as `p00rija <p00rija@tutamail.com>`; no `Co-Authored-By`; never pushed unless asked (the repository has **no remote** configured). Deploying is a separate, explicit step (§24).

### 23.4 Release line (git, newest first)
`b0e118d` release 2.3.0 (chat-v6) · `24d3df9` messenger UI fixes (world clocks as a page, profile card, keyboard shell, solid menus, native Settings pages, live preview, text size, fonts, toast) · 2.2.0 (chat-v5) UI overhaul + Telegram wiring · 2.1.0 (chat-v4) · 2.0.1 initial independent stack · … (20 commits total; full table in §3.2).

### 23.5 Service worker (`sw.js`)
Cache name = app version + build tag; on `activate` deletes every other cache; **network-first** for the app shell (`SHELL_PATTERN` = `.html/.css/.js/.webmanifest`, so a deployed fix reaches installed PWAs on the next launch instead of being pinned by a cache-first match that ignores `?v=`; nginx also sends no-cache headers for them), **network-only** for live endpoints (`/Monitor_Server`, `/healthz`, `/admin/`, `/peerjs`, `/chat-signal`, `/chat-health`, `/turn-config`, `/cert-status`, `/push/`), cache fallback offline; also handles `push` and `notificationclick` (wording comes from the relay, `scripts/lib/push-wording.js`).

---

## 24. Deployment and the fleet

### 24.1 What a server runs (`config/docker-compose.yaml`, project name `p00rija-chat`)
| Service (container) | Image / build | Role |
|---|---|---|
| `chat-app` (`P00RIJA-Chat_App`) | `config/Dockerfile` (`nginx:1.31.8-alpine`, 16 384 connections per worker) | serves the static app and reverse-proxies the relay on **port 1122** (TLS); templated `nginx.conf` with `APP_DOMAIN`, `APP_ORIGIN`, `APP_ORIGIN_WS`, optional front-door ports 1123+ |
| `chat-signal` (`P00RIJA-Chat_ChatSignal`) | `config/Dockerfile.chat-signal` (`node:26.12.1-alpine`, runs `scripts/server.js`) | the relay: WebSocket `/chat-signal` (11220), PeerJS `/peerjs`, presence (11221), bootstrap installer (11222), mailboxes, push, transit, Telegram, dashboard |
| `coturn` (`P00RIJA-Chat_Coturn`) | `coturn/coturn:4.18.0-alpine`, **host network** | STUN/TURN on **11478** (UDP/TCP) and TLS **11349**, relay ports 40000–40500; REST-secret auth when `TURN_SECRET` is set, else static user |
| `cert-renewer` (`P00RIJA-Chat_CertRenewer`) | `config/Dockerfile.cert-renewer` (`docker:29.9.2-cli`, `scripts/cert-renewer.sh`) | keeps the certificate (found / Let’s Encrypt / self-signed), renews `CERT_RENEW_BEFORE_DAYS` (10) before expiry, checks every `CERT_CHECK_INTERVAL_SECONDS` (21600) |
Logs are bounded (`json-file`, 10 MB × 3). Standalone alternatives: `standalone-relay/` (a relay-only package with its own Dockerfile/compose/setup), `docker/compose.yaml`, `config/control-panel.compose.yaml` (the central panel image).

### 24.2 Ports
`1122` (public, TLS, nginx) · `11220` (relay WebSocket, loopback/proxy only) · `11221` (presence) · `11222` (bootstrap installer; `0` disables) · `11478`/`11349` (TURN) · `40000–40500` (TURN relay range) · `1123+` (front doors, loopback unless a server keeps a front door). The plain-HTTP relay ports answer only the machine and the proxy; they are not for the internet.

### 24.3 `scripts/deploy.sh` (the one way to ship)
```
bash scripts/deploy.sh                   # copy, rebuild, verify — EVERY configured server in turn
bash scripts/deploy.sh --server NAME --yes [--prebuilt]
bash scripts/deploy.sh --check           # report what each server serves; change nothing
bash scripts/deploy.sh --dry-run | --skip-bump | --reconfigure | --edit | --where | --help
```
* Settings (servers, accounts, key paths, public URLs) live **outside the repository** in `${XDG_CONFIG_HOME:-~/.config}/p00rija-chat/deploy.conf` (owner-only). Env vars win (`POORIJA_SSH_HOST/USER/PORT/KEY`, `POORIJA_REMOTE_DIR`, `POORIJA_PUBLIC_URL`). **Key authentication only**, deliberately.
* **Never touches** `data/`, `certs/`, `.env` on the server (mailboxes, TLS material, secrets).
* A server with no `.env` is **installed first** (domain, certificate mode, email asked or given by `--domain --email --cert found|found-owner|letsencrypt|self-signed --cert-dir`).
* `--prebuilt`: build every image **once, here, for linux/amd64**, and each server pulls only the missing layers through an SSH tunnel from a registry on `127.0.0.1` — every server runs the same images and none needs npm or Docker Hub (needed for servers that cannot reach the internet). `<NAME>_JUMP='<other server>'` sends a slow server’s connections through a faster one.
* **The exit code is not a verdict**: read the check output (`matches this working tree yes (2.3.0-chat-v6)`, `✓ The server is up to date.`, `▶ Are they in step? ✓ every server is serving 2.3.0-chat-v6`).

### 24.4 The fleet (names and roles only)
Eight servers, each a full independent relay of one operator’s **signed family**: `fl`, `de`, `se` (abroad, by naming Finland / Germany / Sweden) and `ir`, `ir2`, `ir3`, `ir4`, `ir5` (inside Iran). They link to each other as **transit peers** (`CHAT_TRANSIT_PEERS`, kept in `data/transit-peers.json`), so a conversation between people on different relays works (§11). The deploy order used for 2.2.0 and 2.3.0 was `fl de ir ir3 ir2 ir4 se ir5` with `ir5` shipped `--prebuilt` (a scratch script, not in the repository). After each deploy: `curl /chat-health` on every server must report `version`, `buildTag` and `telegramStickers: true`. **Both releases are live on all eight** (verified by health probes; `deploy.sh --check` for 2.3.0 was **not** run — only 2.2.0’s check was, §30). No host name, address or key of any server is written in this repository or this document.

### 24.5 Installers
`INSTALL.md` (user-level), `INSTALL-LINUX-SERVER.md` (server), `scripts/setup*.sh`/`.ps1` (Linux/macOS/Windows/auto/server), `scripts/quick-install.sh`, `docker-install.sh`, and the relay’s own **bootstrap installer**: `curl -sSL http://HOST:11222/install | bash -s -- http://HOST:11222 <token> ~/p00rija-chat` (the token is made on the dashboard’s Bootstrap surface; **nothing from the source server except the application and stack** — no data, no identity, no secret — travels). `scripts/update-server.sh`/`apply-update.sh`, `server-backup.sh` (bounded backups), `sync-to-server.sh` (older rsync flow, `npm run sync:server`).
**Not present in this repository:** native app projects (`src-tauri`, Android, iOS). Scripts such as `build-android.sh`, `build-macos.sh`, `build-windows*.sh` are carried scaffolding from the parent and have nothing to build here until a shell project exists (§28).

---

## 25. Monitoring and the central panel

### 25.1 The relay dashboard (`/Monitor_Server`, `scripts/lib/monitor-dashboard.js`, `monitor-client.html`, `js/monitor-client.js`)
Served by every relay for its operator. **Login**: user `admin` (or `MONITOR_USER`), password `MONITOR_PASSWORD` (≥ 12 chars; **the relay refuses to start without one** — no built-in default; `ALLOW_INSECURE_DEFAULTS=1` exists for throwaway closed networks only); three wrong guesses lock the login for ten minutes (`CHAT_RATE_LOGIN` 10 per window); session `MONITOR_SESSION_TTL_MS` (12 h) while used. Nothing in it can see a message: the relay holds none in the clear.

| Surface | Purpose |
|---|---|
| Overview | connected devices, CPU, memory (container vs limit), disk, queue, transit; live charts (devices, CPU, memory, messages/s, network, disk); why anything was dropped |
| Queues | offline mailboxes: per recipient count/size/oldest/newest; open one for **metadata only**; delete an item or the mailbox; deliver now; the **expiry ledger** (what was removed, when, why) |
| Users | connected devices; search by name, id or address; suspend/kick for a time or for good; allow-list (admission by invitation); **broadcast** to everyone (online, offline, push) |
| Relays | links to other relays: status, role, traffic per link; add/remove without restart (`data/transit-peers.json`) |
| Traffic | totals, busiest devices, per-link traffic |
| Machine | backups (create, list, download, restore with automatic safety backup, delete); per-container memory/CPU limits applied live; disk use and old-image cleaning; Docker image updates; release check + apply with safety backup and one-click rollback |
| Reports | live calls (1:1 and group with start times); cross-relay activity; hourly traffic for 48 h; event stream; CSV/JSON export |
| Bootstrap | the installer token for another machine |
| System | Node/host/load; whether TURN is on and its addresses; relay identity with copy button; free memory; change password; live log |
Four themes (dark, light, ocean, midnight), Persian and English, refresh 1 s … manual; keys 1–8 switch surface, `R` refreshes. The dashboard is a **standalone page** with its own scripts (it can also be wrapped as a native “monitor” app by `scripts/prepare-monitor-tauri.js` — not built here).

### 25.2 Health endpoints (no login, on the app’s own port)
`/chat-health` (`{ ok, version, buildTag, telegramStickers, transit… }`), `/ready`, `/live` (container manager), `/relay-identity` (public key and name = hash of the key), `/healthz`, `/cert-status`, `/relay-speed`, `/relay-directory`, `/relay-mirrors`, `/relay-fronts`, `/turn-config`, `/transit-peers`.

### 25.3 Alerts to the operator (`scripts/lib/relay-alerts.js`, `relay-report.js`)
Disk, server memory, relay memory (vs container limit), open files, TURN down, TURN port capacity, bandwidth vs link, **peer relay down** (`peerDownMinutes`) and “peer link via another route”. They go to the Telegram chat (§21) with thresholds, quiet hours, reminders and a **daily fleet report**; `CHAT_ALERTS=0` turns it all off.

### 25.4 The central panel (`tools/panel/`, `tools/control-panel.{html,js,mjs}`, `config/Dockerfile.control-panel`, `scripts/panel.sh`)
One panel for **all** the operator’s servers: the list of relays, the links between them, family signing (`family.mjs`), builds (`builds.mjs`), jobs (`jobs.mjs`: **fresh install** over SSH with the bootstrap installer, update, backup), deploy configuration (`deployconf.mjs`), account (`account.mjs`), and the **Telegram tab** that edits §21.2 live on a relay. Operator requests to relays are **signed** (`scripts/lib/operator-signature.js`; `CHAT_REQUIRE_OPERATOR_SIGNATURE`, `CHAT_OPERATOR_KEY`, `CHAT_CENTRAL_CONTROL`). `tools/admin-key.mjs` makes the operator key; `tools/relay-directory.mjs` signs the directory. **Not exercised in this stretch** beyond `centralpanel`/`alerts` suites (§30).

---

## 26. Server configuration reference

Everything is environment (usually from `.env` next to `config/docker-compose.yaml`; `.env.example` is the annotated template). Anything not listed below is a path under the data folder. Defaults are those in the code; **required** ones make compose or the relay refuse to start.

### 26.1 Required
| Variable | Meaning |
|---|---|
| `DOMAIN` | the name clients type; certificates must match; used in CSP, nginx, TURN realm |
| `MONITOR_PASSWORD` | dashboard password, ≥ 12 chars |
| `TURN_USER`, `TURN_PASSWORD` | static TURN credentials (also used when no REST secret) |
| `EXTERNAL_IP` | public IPv4 for coturn (`--external-ip`, `--relay-ip`) |

### 26.2 Common
`TURN_SECRET` (64 hex; REST credentials that expire: `CHAT_TURN_SECRET`, TTL `CHAT_TURN_TTL_SECONDS` 12 h; empty = static pair) · `CHAT_TURN_URL` (default `turn:DOMAIN:11478?transport=udp` etc.) · `CHAT_TURN_PORT_MIN/MAX` (40000/40500) · `APP_PORT` (1122) · `CHAT_ALLOWED_ORIGINS` · `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`/`VAPID_SUBJECT` (generated and stored in `data/vapid.json` when empty) · `SSL_CERT_PATH`/`SSL_KEY_PATH`/`CERTS_DIR`/`CERT_FILE`/`KEY_FILE`/`CERT_MODE`/`CERT_SANS`/`CERTBOT_EMAIL`/`CERT_RENEW_BEFORE_DAYS`/`CERT_CHECK_INTERVAL_SECONDS` · `COTURN_KEY_UID`.

### 26.3 Relay behaviour (all `CHAT_*`; default from code)
| Group | Variables (default) |
|---|---|
| Ports | `CHAT_SIGNAL_PORT` 11220, `CHAT_SIGNAL_HOST` 0.0.0.0, `CHAT_PRESENCE_PORT` 11221, `CHAT_BOOTSTRAP_PORT` 11222 (0 = off), `CHAT_LISTEN_HOSTS` (e.g. `127.0.0.1,docker0`), `CHAT_LISTEN_BACKLOG` 4096, `CHAT_TRUSTED_PROXIES` 1 |
| Retention | `CHAT_MEDIA_RETENTION_MS` 7 d, `CHAT_RETENTION_SWEEP_MS` 15 min, `CHAT_MEDIA_QUOTA_BYTES`, `CHAT_TEXT_QUOTA_BYTES`, `CHAT_TEXT_MAILBOX_LIMIT`, `CHAT_EXPIRY_LOG_RETENTION_MS` 30 d, `CHAT_SESSION_RESERVATION_MS` 72 h, `CHAT_SIBLING_MAX_BYTES` 256 MB |
| Limits | `CHAT_JSON_BODY_LIMIT` 256kb, `CHAT_JSON_RECORD_LIMIT` 8mb, `CHAT_RATE_WINDOW_MS` 60 s, `CHAT_RATE_DEFAULT`, `CHAT_RATE_WRITE`, `CHAT_RATE_LOGIN` 10, `CHAT_RATE_PREVIEW` 20, `CHAT_RATE_TELEGRAM` 300, `CHAT_WS_MAX_PER_IP`, `CHAT_WS_MAX_TOTAL`, `CHAT_WS_RATE_BURST` 1024, `CHAT_WS_RATE_REFILL_PER_SECOND` 256, `CHAT_WS_FLOOD_CLOSE_AFTER` 5000 (capacity numbers come from a `CAPACITY` profile in `scripts/server.js`) |
| Presence | `CHAT_PRESENCE_TTL_MS` 90 s, `CHAT_PRESENCE_FULL_PER_TICK` 50, `CHAT_APP_AWAKE_TTL_MS` 25 s, `CHAT_INSTANCE_ID` |
| Identity | `CHAT_RELAY_IDENTITY_PATH`, `CHAT_IDENTITY_PROOF_REQUIRED` (client must prove its key), `CHAT_KNOWN_IDENTITIES_PATH` |
| Family & transit | `CHAT_TRANSIT_PEERS`, `CHAT_TRANSIT_PEERS_STORE`, `CHAT_TRANSIT_QUERIES_PER_MINUTE` 1200, `CHAT_TRANSIT_WAIT_PER_CLIENT` 256, `CHAT_TRANSIT_LINK_SOFT_LIMIT_BYTES` 16 MB, `CHAT_TRANSIT_INSECURE_TLS`, `CHAT_OPERATOR_KEY`, `CHAT_DIRECTORY_SOURCES`, `CHAT_DIRECTORY_PATH`, `CHAT_DIRECTORY_PULL_MS` 5 min, `CHAT_DIRECTORY_MIN_SERIAL`, `CHAT_FAMILY_LINKS_MS` 60 s, `CHAT_PARTNERS_PATH`, `CHAT_PARTNER_PULL_MS`, `CHAT_PARTNER_ALLOW_PRIVATE`, `CHAT_GATEWAY_STABLE_MS` 60 s, `CHAT_GATEWAY_HANDOFF_MS` 120 s, `CHAT_REQUIRE_OPERATOR_SIGNATURE`, `CHAT_CENTRAL_CONTROL`, `CHAT_HANDOVER_PATH` |
| Fronts & mirrors | `CHAT_MIRROR_ORIGINS`, `CHAT_FRONTS`, `CHAT_FRONT_DOORS`, `CHAT_FRONT_PORT` 9011, `APP_FRONT_BIND`, `APP_FRONT_PORT` 1123, `CHAT_PUBLIC_RELAY_ORIGIN`, `CHAT_PUBLIC_PRESENCE_URL`, `CHAT_TRUST_CDN_HEADERS` |
| Guests | `CHAT_GUEST_SHARE`, `CHAT_GUEST_TTL_MS` 24 h, `CHAT_GUEST_IDLE_MS` 10 min, `CHAT_GUEST_RETENTION_MS` 3 d, `CHAT_GUEST_FORWARD_MS` 7 d, `CHAT_GUEST_NEW_PER_IP_10M` 20, `CHAT_GUEST_SWEEP_MS` 10 min, `CHAT_GUEST_BOOK_PATH`, `CHAT_MOVE_FORWARD_MS` 30 d, `CHAT_JOIN_PER_HOUR` 10, `CHAT_JOIN_WAITING_MAX` 20, `CHAT_JOIN_POLL_MS` 60 s |
| Push | `CHAT_PUSH_STORE_PATH`, `CHAT_VAPID_STORE_PATH`, `CHAT_PUSH_SALT`, `CHAT_ALLOW_PRIVATE_PUSH_ENDPOINTS`, `CHAT_POLL_TOKEN_STORE_PATH` |
| Link previews | `CHAT_LINK_PREVIEWS` (on/off), `CHAT_LINK_PREVIEW_MAX_IN_FLIGHT` 8, `CHAT_LINK_PREVIEW_ALLOW_PRIVATE` (test only) |
| Updates | `CHAT_UPDATE_REPO`, `CHAT_UPDATES_DIR`, `CHAT_UPDATE_START_MS` 60 s, `CHAT_UPDATE_NOTICE_MS` 120 s, `CHAT_UPDATE_PEER_MS` 10 min |
| Alerts/Telegram | `CHAT_ALERTS` (`0` off), `CHAT_ALERT_LABEL`, `CHAT_ALERT_PEERS`, `CHAT_ALERT_TELEGRAM_CHAT_ID`, `CHAT_ALERT_INTERVAL_MS` 60000, `CHAT_ALERT_REMIND_HOURS` 6, thresholds `CHAT_ALERT_DISK_FREE_PCT` 10, `…_DISK_FREE_GB` 2, `…_MEMORY_FREE_PCT` 10, `…_RELAY_MEMORY_PCT` 75, `…_FILES_PCT` 80, `…_TURN_PCT` 80, `…_LINK_MBPS` 0, `…_LINK_PCT` 80, `…_PEER_DOWN_MINUTES` 10, `CHAT_TELEGRAM_LANGUAGE` (fa), `CHAT_TELEGRAM_COMMANDS` (`0` off), `CHAT_TELEGRAM_MAX_IN_FLIGHT` 12, `CHAT_TELEGRAM_SETTINGS_PATH`, `CHAT_TELEGRAM_TOKEN_PATH`, `CHAT_STATUS_REPORT_AT` (`09:00`/`off`), `CHAT_STATUS_REPORT_CHECK_MS` 30000, `CHAT_STATUS_REPORT_PATH`, `CHAT_STATUS_WAIT_MS` 6000, `TELEGRAM_API_BASE` (test only), `TELEGRAM_STICKERS_UPSTREAM`, and the bot token itself (**secret**; §21.5) |
| Dashboard | `MONITOR_USER` admin, `MONITOR_PASSWORD`, `MONITOR_SESSION_TTL_MS` 12 h |
| Operations | `OPS_INSTALL_DIR`, `OPS_DATA_DIR`, `OPS_BACKUP_DIR`, `OPS_BACKUPS_KEPT` 2, `OPS_DOCKER_SOCKET`, `OPS_HUB_MIRROR`, `OPS_JOB_IMAGE` (`node:26.12.1-alpine`), `COTURN_CONTAINER` (`P00RIJA-Chat_Coturn`), `CHAT_BOOTSTRAP_TOKEN` |
| Tests only | `CHAT_TEST_HOOKS`, `CHAT_TEST_SATURATION`, `CHAT_SHUTDOWN_GRACE_MS` 8 s |
| Data paths | `CHAT_OFFLINE_STORE_DIR`/`CHAT_OFFLINE_STORE_PATH` (default under `data/chat-signal`), `CHAT_POLICY_STORE_PATH`, `CHAT_SELF_DESTRUCT_STORE_PATH`, `CHAT_BEACON_DIR`, `CHAT_ROSTER_DIR`, `CHAT_SIBLING_DIR`, `CHAT_EXPIRY_LOG_PATH`, `CHAT_ENV_FILE` |
> Treat the list as generated from the code on 2026-11-14 (138 variables across `scripts/server.js` and `scripts/lib/*.js`); the exact default of a few capacity variables comes from the `CAPACITY` profile, read the code before relying on a number.

### 26.4 What the relay stores (data folder `data/chat-signal/`)
Offline mailboxes (text until delivered; media 7 days) · push subscriptions · VAPID pair · relay identity key · known identities · policy store (suspensions, allow-list) · transit peers · family directory + handover · partners · guest book · self-destruct store · device beacon/roster/sibling stores · updates · expiry log · Telegram settings + token (owner-only) · daily-report day marker. **No plaintext message, no key** is stored; envelopes are sealed to the recipient and (since 2.98.9x) sealed-sender.

---

## 27. Data and storage reference (on the device)

### 27.1 Principle
All secrets at rest are **encrypted under keys derived from the master password** (Argon2id → XChaCha20-Poly1305 in `crypto-core.js`; AES-256-GCM for media/history). `atrest.mjs` asserts nothing secret is readable in `localStorage`. The vault is **two indistinguishable slots** (`poorija_vault`, format v4): the real profile and a decoy; an emergency password erases.

### 27.2 `localStorage` keys (observed in code; ★ = shell/app preference stored in the clear; others are encrypted blobs or non-secret)
| Key | Holds |
|---|---|
| `poorija_vault` | the vault: salt, KDF params, two slots (§7) |
| `poorija_storage_key_salt_v3`, `poorija_installation_secret` | key-derivation salt / per-install secret |
| `poorija_master_hash`, `poorija_panic_hash`, `poorija_sq`, `poorija_sq_failed`, `poorija_failed_logins`, `poorija_lock_until` | password verification, panic password, recovery questions, lockout counters |
| `poorija_2fa`, `poorija_passkey*`, `poorija_chat_lock*` | TOTP secret, passkey quick-unlock wrap, conversation-lock biometrics/attempts |
| `poorija_chat_identity` | the RSA-3072 identity (encrypted) |
| `poorija_chat_profile` | name, avatar, mood (encrypted) |
| `poorija_chat_contacts`, `…_blocklist`, `…_verified`, `poorija_revoked_trust`, `poorija_chat_known_devices` | address book, blocks, verified contacts, revoked trust |
| `poorija_chat_history`, `…_calls`, `…_deleted`, `…_drafts`, `…_unread_flags`, `…_spaces` (groups) | conversations, call log, tombstones, drafts, unread markers, groups |
| `poorija_chat_session_keys`, `poorija_chat_prekeys` | live session keys (7-day life), prekey bundle (15-day life) |
| `poorija_chat_media_key` | key for the media vault |
| `poorija_chat_device_id`, `…_device_key`, `…_device_roster`, `…_device_sync_all`, `…_device_sync_files` | multi-device identity, per-device key, signed roster, sync flags |
| `poorija_convo_locks` | which conversations are locked |
| `poorija_chat_prefs`, `poorija_settings`, `poorija_lang`, `poorija_theme`, `poorija_theme_auto`, `poorija_chat_appearance` ★ | preferences (fonts, text size, language, theme, chat appearance) |
| `poorija_chat_clocks`, `poorija_chat_pet`, `poorija_chat_settings_tab`, `poorija_chat_rail_width`, `poorija_tabbar_*`, `poorija_mobile_tabbar`, `poorija_gcall_layout` ★ | clocks, pet, last settings tab, desktop rail width, tab bar options, group-call layout |
| `poorija_sticker_*`, `poorija_gif_used` | sticker favourites/recents/pack order/active pack, GIF usage |
| `poorija_push_server_key`, `poorija_push_last_error`, `poorija_update_*`, `poorija_last_backup_at`, `poorija_desktop_vault_*`, `poorija_screen_guard`, `poorija_local_identity` | push, update check, backup stamp, desktop vault stamps, screen guard, Local identity |
| **Leftovers from the parent suite** (still read by old code, not part of the chat): `poorija_keys`, `poorija_passwords`, `poorija_history`, `poorija_secure_notes`, `poorija_totp_accounts`, `poorija_signature_history`, `poorija_share_history`, `poorija_qr_appearance` | the parent’s key manager, password manager, notes, authenticator — **dead in this app** (§28) |
Window events: `poorija:unlock`, `poorija:lock`, `poorija:language-changed`, `poorija:tab-switched`, `poorija:theme-changed`, `poorija:vault-changed`, `poorija:chat-unread`, `poorija:chat-read`, `poorija:notifications-enabled`, `poorija:section-lock`.

### 27.3 Other stores
* **IndexedDB** (three databases, read from the code): `poorija-media` (version 1; the media vault — encrypted attachments, key from `ensureMediaKey`, `02-media-vault.js`), `poorija-stickers` (sticker packs and stickers, `openStickerDb` in `16-group-call-signalling.js`), `poorija-chat-appearance` (the custom chat-background picture, `24-settings-panels.js`; never sent anywhere). `backup.js` enumerates databases by name for the encrypted full backup.
* **Cache Storage**: `poorija-chat-v2.3.0-chat-v6` (static assets, service worker).
* **Native shells** (not in this repository) would add the OS keychain/secure store and `desktop_vault_*` stamps.
* **Export formats** (`23-export-import.js`, `backup.js`, `vault-profiles.js`): an **encrypted JSON** (password set at export) for chats; a **portable profile** for identity (never contains the per-device key); a sync bundle between devices.

---

## 28. Known gaps and open work

Written down so that nobody — human or AI — assumes otherwise. Items are ordered by how much they matter, not by effort.

### 28.1 Security and protocol
| # | Gap | Detail |
|---|---|---|
| 1 | **No independent audit** | Everything in §8–§9 was reviewed only by its author, the test suites that play the attacker, and automated reviews. Do not market this as audited. |
| 2 | **No double ratchet** | One session key per connection (hybrid exchange, 7-day lifetime, rotates). **No post-compromise security**: whoever steals a live session key reads that session until it rotates. A key per message is the next protocol step. |
| 3 | **No MLS** | A group message is one sealed send per member; membership changes are roster messages, not a group key schedule. Large groups are costly and have no group-level forward secrecy beyond each pairwise session. |
| 4 | **First prekey is trusted on first sight** | A relay that leaves the post-quantum half out of a contact’s very first prekey is not noticed until the contact has been seen with both halves (then `prekeyHybridOwed` holds, never sends weaker). Mitigation: compare safety numbers for anyone who matters. |
| 5 | **Metadata is not hidden** | The relay sees who is online, who talks to whom, and when. Sealed sender (`ss1`) and padding (`pad1`) hide the sender fingerprint, inner type and size from a mailbox on disk, **not** from a relay that is watching live traffic. |
| 6 | **Queued messages expire** | A message never delivered stops being openable after **15 days**, when the prekey that sealed it is destroyed (text mailbox kept until delivered, media 7 days). |
| 7 | **History is only as strong as the master password** | The vault key derives from it (Argon2id); a weak password is a weak vault. |
| 8 | **Interop between P00RIJA Chat and P00RIJA Cryptography is classical** | The parent has no post-quantum half; sessions between the two apps use the classical exchange and are *honestly not called hybrid* (`interop.mjs`). |
| 9 | **Operator tooling is lightly exercised** | The central panel, family signing, partners, front doors and guest relays have suites, but only `centralpanel`/`alerts`/`bootstrapinstall` were touched in the recent stretch. |

### 28.2 Product and platform
| # | Gap | Detail |
|---|---|---|
| 10 | **No native shells** | No Tauri desktop project, no Android, no iOS in this repository. They need their own bundle identifier, icons and signing, or an install would replace the other app’s. The web app installs as a PWA (`manifest.webmanifest`, `sw.js`). Scripts like `build-android.sh`, `build-macos.sh`, `build-windows*.sh`, `native-build-wizard.sh` and `scripts/lib/pull-tunnel.sh` are inherited scaffolding with nothing to build yet. Desktop-only features referenced in code (`link_preview.rs`, native proxy, desktop vault stamps) assume a shell that is absent. |
| 11 | **Leftover code of the removed tools** | The parent’s tools (secret sharing, Argon2 tool, file encryption, password manager, authenticator…) were cut from the page. Commit `f19d73f` removed 73 calls, 164 functions and 326 translations from `js/app.js`; what remains in `js/app.js` and `js/advanced-crypto.js` is only reached from controls that are gone. `tools/audit-dom.removed.txt` lists the 48 ids the code still names; the DOM audit reports them as leftovers and fails on any **new** one. Cutting the code and the list down together is a job of its own. The `localStorage` keys in §27.2 (“leftovers from the parent suite”) belong here. |
| 12 | **Help, About, File manager and Migration screens** | Open from Settings rows but are the **most legacy-looking** screens; forms under *Privacy → Change master password / Recovery questions / Emergency erase password* and the *vault* views are legacy cards moved into pages (a card inside a page). |
| 13 | **Real device not verified** | Everything visual was verified on a **self-built iOS 27 WebKit simulator rig** and desktop Chromium/WebKit; not verified: the **real software keyboard** (scripted `focus()` does not raise it in the simulator; layout was verified with `keyboard-open` + `--app-keyboard-inset` set by hand), Liquid Glass look on a physical phone, haptics, animation feel, desktop after 2.3.0 not re-checked. |
| 14 | **Refraction not drawn** | Real Liquid Glass bends what is behind it (an SVG filter inside `backdrop-filter`); Safari does not draw that. The bar is the nearest honest approximation. |
| 15 | **Suites failing at baseline** | `settingsui`, `chatappearance`, `controls`, `chatticks`, `calllayout` (2 checks) encode the old interface; they need rewriting, not fixing the app. |
| 16 | **Packaging metadata still names the parent** | `package.json` `repository.url`, `bugs`, `homepage` point at `Poorija/P00RIJA-Cryptography`; no git remote is configured for this repository. |
| 17 | **Telegram sticker import depends on one relay** | The fleet’s other relays forward to the one that holds the bot token; if that relay is down, import fails with the interface saying so. |
| 18 | **Docs generated by hand** | `README.md`, `README.fa.md`, `docs/*.md`, `INSTALL*.md` are maintained by hand; this blueprint (§30) is a snapshot as of 2.3.0. |
| 19 | **Fixed in 2.5.1:** the “emergency erase” label and text | The row, page title, card and `panicDesc` now name a decoy profile password and say nothing is erased; the real erase is its own Danger zone row; `decoywording.mjs` guards it. |
| 20 | **Fixed in the working tree (not committed): Escape twice used to wipe everything** | The handler at the end of `js/app.js` called `triggerPanic()` → `wipeAllData(true)` → `emergencyWipe({ purgeRelay: true })` on a double Escape within 500 ms, **anywhere in the page, signed in or not, with no confirmation**: storage, IndexedDB, caches, the service worker and the in-memory keys went, the relay was asked to purge what it holds for the identity (`purge-me`), and the page reloaded to first run. Escape is the key every menu, sheet and dialog in this app closes on, so two quick presses to dismiss two layers was an ordinary thing to do. Inherited from the parent suite, undocumented in Help. **Fix:** `askBeforePanic()` in `js/app.js` opens a `PoorijaDialogs.confirm` (title “Erase everything?” / «همه‌چیز پاک شود؟», danger-styled OK, `focusCancel: true` added to `js/dialogs.js` so Enter lands on Cancel, key repeats ignored, one dialog at a time, no wipe if the dialog helper is absent); `window.triggerPanic()` itself still wipes at once (it is the button’s function and `emergency.mjs` calls it). **Test:** `tests/e2e/panicconfirm.mjs` (16 checks; on the old code it failed at the first double press, because the page wiped and reloaded). Still to do: the Help text does not mention the shortcut; whether to keep it at all is the owner’s call. |

### 28.3 Candidate next work (not committed to)
Fix the stale “emergency erase” wording first (§28 #19), commit the double-Escape confirmation (#20); rewrite the five baseline suites for the new interface; make the master-password / recovery / panic pages native rows; native Help/About; a native-keyboard verification on a real iPhone and Android; per-message ratchet design (agreed first, as every crypto change is); MLS evaluation; independent audit; native shells with their own identities; trim leftover code and `audit-dom.removed.txt` together.

---

## 29. Gotchas that cost a day each

1. **The scripts share one scope.** `js/chat/NN-*.js` are classic scripts loaded **in order** (the numbering is the order and must not change); `js/messenger.js` and `js/messenger-settings.js` are **last**. Top-level `const`/`let` is visible to later scripts and **not** on `window` (`chatState` is a `const`); `function` declarations are on `window` and can be wrapped (`window.applyChatAppearance = function…`) — that is how `messenger.js` follows the chat’s own functions. A duplicate top-level name between two scripts is a silent overwrite → `npm run check:collisions`.
2. **The old stylesheet wins every ordinary argument.** Never edit `css/styles.css` to change a look; add to `css/ui/` and `node tools/build-ui-css.cjs`. Layered `!important` beats unlayered `!important`, **inline `!important`** and **CSS animations**: a property a script sets inline (a drag, a slider fill, a pet frame) needs `!normal` in the source, or it freezes. The legacy keyboard servo’s inline pins lost for the same reason.
3. **The old frame pinned `direction: rtl`**, so an English chat was laid out right-to-left. `10-shell.css` undoes it. Use logical properties; keep physical ones only where the layout is deliberately direction-independent.
4. **A hidden element must stay in the page.** The chat holds many controls by id (row buttons, the old toolbar, settings panes). Hide with CSS; delete the markup only when the code that wires it goes too. The row menu, list head and mic button **press the originals**. The audit tool will list what the code names and the page lacks.
5. **Specificity of the time inside a bubble.** The RTL meta rule must carry the same `:not(:has(...))` weight as the base rule or Safari puts the time on the text.
6. **The mic/send button decides at `pointerdown`**, not at click: the chat sends on pointerdown to keep keyboard focus; deciding at click made one tap send a message *and* start a recording.
7. **A suite that fails in bulk at its first network step is the setup** (§22.3), not a regression; compare against a clean copy (`git archive HEAD` into a temp dir with `node_modules` symlinked) before calling anything a regression. **Never edit a served file while a suite runs**, never run two suites on one port.
8. **A deploy’s exit code is not a verdict.** `bash scripts/deploy.sh --check` (and `/chat-health` on each server).
9. **Compose project name** must stay `p00rija-chat` (set in the compose files; scripts pass `-p p00rija-chat`). A project named after its folder (`config`) would be taken by compose for any other stack in a folder of that name on the same host and recreated under this one’s settings.
10. **A relay answering `queued` is not delivery.** A relay that has never seen the recipient queues anyway (`known:false` since 2.98.x); the tick says “relayed”, not “delivered”; route finder re-sends when the right relay is learned.
11. **A PeerJS id only means something on the server that issued it.** Cross-relay calls and data channels are built with the offer/answer/ICE carried as relay payloads (39, 43); never `peer.call(otherRelaysId)`.
12. **A key that opens a seal must never also answer a challenge.** The relay once sent the seal of a stored envelope as an “identity challenge”; the client now signs the nonce (`relay-proof/1`) and opens nothing. Anything the client *opens* for the relay is an oracle.
13. **Never write a secret in the repository**, including test fixtures: `tools/forbidden-strings.txt` and `private-strings.txt` guard the tree; operator settings live in `~/.config/p00rija-chat/` (owner-only), the Telegram token only in the relay’s data folder.
14. **Browser `alert/confirm/prompt` do not exist in wry** (Tauri): always use `PoorijaDialogs`.
15. **Mobile keyboard:** the visual viewport shrinks, `html.keyboard-open` is set only when a text field has focus **and** the inset exceeds a threshold (hysteresis); the shell is fixed between `--shell-top` and `--shell-bottom`. Do not add padding for the home indicator under the keys.
16. **Text size is multiplied into every pixel font size** — a literal `font-size: 15px` in new CSS will not follow the slider.
17. **Settings pages redraw.** A native block’s HTML is rebuilt on every show; keep state in the *source* control, never in the drawn node.
18. **Two commits per release**, explicit file staging (a `git add -A` including `graphify-out` once aborted a release commit), identity `p00rija <p00rija@tutamail.com>`, no trailer.
19. **Escape twice asks to wipe the app.** The `document` keydown handler near the end of `js/app.js` (§28 #20) opens an “Erase everything?” confirmation on two Escapes within 500 ms (it used to wipe with no question). Do not bind anything else global to Escape, and do not add UI that needs two quick Escapes; `askBeforePanic` also ignores key repeats.

---

## 30. Verification status of this document

**Snapshot:** P00RIJA Chat **2.3.0**, build **chat-v6**, repository HEAD `b0e118d` (20 commits), working tree clean apart from this file, on **2026-11-14**. The document is a **description of the repository at that moment**; the code is authoritative where they differ.

### 30.1 How it was made
Facts were read from the code and the repository’s own documents (`README.md`, `HANDOFF.md`, `SECURITY.md`, `docs/*.md`, `RELEASE-NOTES.md`, `INSTALL*.md`, the header comment of every module and of every test suite), from `git log`, from `package.json`/`config/*`/`scripts/*`, and from what was done and observed while building 2.2.0 and 2.3.0 (iOS 27 simulator runs, desktop runs, deploys and health probes). Lists that can be generated (modules and line counts, test suites, environment variables, HTTP routes, WebSocket message kinds, localStorage keys, IndexedDB names, design tokens) were **extracted by script from the code on that date**.

### 30.2 Checked against the code (spot verification pass)
RSA-3072 identity (one key pair generated as RSA-OAEP, imported again as RSASSA-PKCS1-v1_5/SHA-256 for every signature) · vault v4: two slots of 272 bytes, XChaCha20-Poly1305, Argon2id · labels `kex-offer/3`, `kex-answer/3`, `kex-confirm/3`, `poorija-session-v3`, `poorija-offline-v3`, `prekey/2`, `relay-proof/1`, `kexPinned`, `prekeyHybridOwed` · prekey life 15 days, rotation at one third (`ensurePrekey`), session key life 7 days · padding ladder `[512 … 65536]`, step 16 384 · design tokens of §13.3 (light and dark) · the settings pages and every control id of §18 (read from `js/messenger-settings.js`) · plus-menu entries and self-destruct timers (read from `index.html`) · composer/menu/thread-menu ids · Telegram defaults, categories, alert keys, thresholds, commands (read from `scripts/lib/telegram-settings.js`) · sticker limits (read from `telegram-stickers.js`) · compose services, images and ports · service-worker strategy · IndexedDB database names · the nine places that state the version.

### 30.3 Defects found while writing
The verification pass read the code behind two security-relevant UI claims and found them wrong. **§28 #19** (the “Emergency erase password” label and text say the password wipes the app; it opens a decoy space and erases nothing) is **open**. **§28 #20** (a double press of Escape within 500 ms wiped all local data with no question) was **fixed afterwards in the working tree** (confirmation dialog, suite `panicconfirm`, 16 of 16) and is **not committed or deployed** — the fleet still runs 2.3.0 with the old behaviour until a release.

### 30.4 Not verified (read this before trusting these parts)
| Area | Status |
|---|---|
| Real-device behaviour | Not tested on a physical iPhone/Android: software keyboard, Liquid Glass look, haptics, animation feel. Simulator and desktop only. |
| Desktop after 2.3.0 | Not re-run visually after the last release. |
| Full suite run | The 240-suite run was **not repeated** after 2.3.0. UI suites and guards were run (§22.7); after the double-Escape fix: `panicconfirm` 16/16, `messenger` 41/41, `choosedialog` 50/50, `chatmenustack` 17/17, `duress` 64/64, and the guards. |
| `deploy.sh --check` for 2.3.0 | Not run; `/chat-health` was probed on all 8 servers (2.3.0, `telegramStickers: true`). The check for 2.2.0 passed on all. |
| Operator surfaces | Dashboard surfaces, central panel, partners, front doors, guest relays are described from code and docs; only a subset was exercised recently. |
| Protocol text in §8–§9 | Written from `docs/PROTOCOL.md` and the code; **no independent review**. A protocol reviewer should read `19-forward-secrecy.js`, `28-offline-envelopes.js`, `51-envelope-privacy.js`, `scripts/server.js` first. |
| Numbers in §26 | Defaults come from the code’s `\|\|` expressions on the first occurrence; some are computed from a `CAPACITY` profile. |
| Counts | “20 commits”, line counts, “240 suites” are as of the snapshot. |

### 30.5 What is deliberately not in this document
No server host names, addresses, SSH details or keys; no bot token, chat id or other secret; no personal data of any user. Where the real deployment matters (the fleet, Telegram) only roles and rules are given.

### 30.6 Keeping it current
Regenerate the generated lists (Appendices A–D, §26, §27.2) after a release; update §1.1, §3.2, §23.4, §28 and this section by hand; re-run the checks in §22.5. Treat any statement here that disagrees with a test as a bug in the document.

---

## 31. Appendices

### Appendix A — Every script, in load order

`index.html` loads, in this exact order (classic `<script defer>`, all with `?v=<version>-<buildTag>`): the **vendor** libraries (`qrcodejs`, `jsQR`, `otpauth`, `hash-wasm` Argon2, `jszip`, `peerjs`, `mlkem` bundle, `sileo`), then the **root modules**, then the **63 chat modules**, then the two **interface** scripts. Stylesheets: `fontawesome`, `tailwind.generated.css` (legacy), `css/styles.css` (legacy frame, 1.07 MB), `css/messenger.css` (the first shell layer: hides the frame’s own navigation, lays out the top bar and Settings rows), `css/chat-ui.css` (the built interface layer, §13.4). `css/monitor-client.css` belongs to `monitor-client.html`.

#### A.1 Root modules (`js/`)

| File | Lines | Role |
|---|---:|---|
| `js/crypto-core.js` | 520 | Primitives WebCrypto lacks: synchronous authenticated encryption (XChaCha20-Poly1305), Argon2id wrapper, storage encryption (`encryptStorageData`) |
| `js/vault-profiles.js` | 974 | Two vaults that cannot be told apart (real + decoy slot), unlock, emergency erase, portable profile |
| `js/screen-guard.js` | 115 | Keep the screen out of screenshots/recordings/app switcher where the platform allows |
| `js/stego.js` | 576 | Hide an encrypted message in a picture (`PoorijaStego`; DCT codec). Used by the carrier, “Send another way” (§19.9) |
| `js/qr-kit.js` | 937 | One place for every QR code the app draws or reads (chunking, camera scan, appearance) |
| `js/tools-extra.js` | 837 | QR bridge and other small tools (`PoorijaToolsExtra`); the QR bridge is used by Local Link and device linking |
| `js/local-link.js` | 1110 | Local Link: LAN pairing and direct link over QR (§20) |
| `js/local-mesh.js` | 1215 | Local Link rooms: mesh of up to 16, host as broker |
| `js/local-room.js` | 865 | Local Link room UI |
| `js/crypto-config.js` | 205 | Algorithm lists of the suite (inherited; not shown in Settings any more) |
| `js/dialogs.js` | 340 | `PoorijaDialogs`: alert/confirm/prompt that work in a native webview (§14.6) |
| `js/desktop-bridge.js` | 207 | The one place that knows the app runs inside Tauri (`window.__TAURI__`); inert on the web |
| `js/metadata.js` | 806 | Read and strip what a file says about itself (EXIF/GPS, etc.) |
| `js/voice-changer.js` | 309 | Voice effects (`PoorijaVoice`), honestly labelled as effects, not anonymisation |
| `js/help-content.js` | 225 | The Help guide as data (searchable list) |
| `js/relay-hints.js` | 12 | `window.__POORIJA_RELAY_HINTS__` list filled at build/deploy (empty by default) |
| `js/image-formats.js` | 155 | Open HEIC/DNG pictures (WebKit decodes HEIC, others via conversion) |
| `js/update-check.js` | 260 | Opt-in disclosed update check for native builds |
| `js/app.js` | 10063 | The frame: translations (`translations = { fa, en }`), themes, vault/unlock, notifications (sileo), shell state classes, responsive/keyboard logic, tab switching, appearance (`applyAppearanceSettings`), About, plus **leftover code of the removed tools** (§28) |
| `js/advanced-crypto.js` | 437 | Argon2id and the primitives WebCrypto lacks; partly leftover |
| `js/backup.js` | 481 | Full encrypted vault backup / migration |
| `js/messenger.js` | 634 | The shell: tab bar with lens, top bar, list head, row menus, composer wiring, text-size/range/appearance followers (§14.2) |
| `js/messenger-settings.js` | 889 | Settings pages (§18) |
| `js/monitor-client.js` | 1005 | The desktop monitor client (served by `monitor-client.html`, not part of the chat page) |

#### A.2 Chat modules (`js/chat/NN-*.js`) — the numbering is the load order and must not change

| # | File | Lines | Role |
|---|---|---:|---|
| 01 | `01-constants.js` | 238 | constants, storage keys, limits |
| 02 | `02-media-vault.js` | 451 | media vault — attachments that survive a reload (encrypted IndexedDB) |
| 03 | `03-call-screen.js` | 92 | call screen behaviour (FaceTime/Telegram habits) |
| 04 | `04-call-layout.js` | 285 | call layout — how local and remote pictures are fitted (crop vs letterbox, self-view tile) |
| 05 | `05-structured-messages.js` | 424 | structured messages — polls, location, contact cards |
| 06 | `06-groups.js` | 630 | group management (create, roster, invite codes, leave, delete) |
| 07 | `07-conversation-lock.js` | 1242 | conversation lock — a separate PIN (PBKDF2, 600k iterations) for locked conversations; shared-lock wipe rule; key verification and search UI helpers |
| 08 | `08-global-search.js` | 563 | global search — engine, popup, preview, jump |
| 09 | `09-the-emoji-key.js` | 207 | the emoji key — six-symbol call verification |
| 10 | `10-selection.js` | 272 | swipe-to-reply and multi-select |
| 11 | `11-group-permissions.js` | 469 | group permissions — what a member may do |
| 12 | `12-group-call-mesh.js` | 708 | group calls — full mesh |
| 13 | `13-group-call-stage.js` | 306 | group call stage — presenting, pinning, reactions |
| 14 | `14-group-call-roster.js` | 283 | group call roster — who is talking, who wants to |
| 15 | `15-group-call-render.js` | 264 | group call rendering — the stage is patched, never rebuilt |
| 16 | `16-group-call-signalling.js` | 2797 | group call signalling (and the Telegram sticker-link parser at its end) |
| 17 | `17-file-manager.js` | 3099 | local file manager (1/2) |
| 18 | `18-file-manager-2.js` | 1294 | local file manager (2/2) |
| 19 | `19-forward-secrecy.js` | 728 | forward secrecy — session keys, the live key exchange |
| 20 | `20-call-rows.js` | 1099 | one call, one row; legacy composer/keyboard servo |
| 21 | `21-chat-list-filters.js` | 79 | chat list filters (All, Unread, Pinned, Online) |
| 22 | `22-drafts.js` | 142 | drafts, mark as unread, jump to first unread |
| 23 | `23-export-import.js` | 661 | export / import of conversations (encrypted JSON) |
| 24 | `24-settings-panels.js` | 2004 | settings panes and group panels; chat appearance (themes, bubbles, backgrounds, ticks), `applyChatAppearance` |
| 25 | `25-call-log.js` | 150 | call history log (sections, delete) |
| 26 | `26-contacts.js` | 1096 | address book (contacts, requests, blocks) |
| 27 | `27-message-render.js` | 1940 | message rendering, reader’s place across re-render |
| 28 | `28-offline-envelopes.js` | 400 | offline envelopes seal themselves (prekey seal at send) |
| 29 | `29-file-transfer.js` | 3454 | streaming file transfer (1/4) |
| 30 | `30-file-transfer-2.js` | 3470 | streaming file transfer (2/4) |
| 31 | `31-file-transfer-3.js` | 2761 | streaming file transfer (3/4, Opus tuning `tuneOpus`, call media) |
| 32 | `32-file-transfer-4.js` | 715 | streaming file transfer (4/4) |
| 33 | `33-rail-header.js` | 253 | rail header folds away on scroll |
| 34 | `34-sheets-profile-clocks.js` | 1677 | full-screen sheets, profile card, world clocks (1/3) |
| 35 | `35-sheets-profile-clocks-2.js` | 2296 | full-screen sheets, profile card, world clocks (2/3; sticker import dialog) |
| 36 | `36-sheets-profile-clocks-3.js` | 1028 | full-screen sheets, profile card, world clocks (3/3) |
| 37 | `37-chat-tools.js` | 419 | chat tools — which relay works, start the session, diagnostics |
| 38 | `38-carrier.js` | 507 | carrier — send through a working but watched messenger |
| 39 | `39-relay-call.js` | 570 | relay call — a call between people on different relays |
| 40 | `40-route-finder.js` | 658 | route finder — get a message to the relay its recipient uses |
| 41 | `41-member-cards.js` | 298 | member cards — every group member reachable across relays |
| 42 | `42-path-manager.js` | 243 | path manager — direct vs relay path, TURN when needed |
| 43 | `43-relay-link.js` | 390 | relay link — live data channel across relays |
| 44 | `44-device-beacon.js` | 574 | device beacon — several devices, one history, device to device |
| 45 | `45-text-format.js` | 678 | text formatting (bold, italic, strike, code, spoiler, links) |
| 46 | `46-saved-messages.js` | 258 | saved messages (a conversation with nobody but this account) |
| 47 | `47-scheduled-send.js` | 369 | scheduled messages (on this device) |
| 48 | `48-key-verify.js` | 212 | key verify — scan-to-verify, verified-contact key-change block |
| 49 | `49-message-requests.js` | 279 | message requests — what a non-contact sends waits apart |
| 50 | `50-live-location.js` | 421 | live location |
| 51 | `51-envelope-privacy.js` | 198 | envelope privacy — sealed sender, padding |
| 52 | `52-relay-mirrors.js` | 362 | relay mirrors — other addresses of the same relay |
| 53 | `53-native-proxy.js` | 128 | native proxy (desktop shell only) |
| 54 | `54-link-preview.js` | 297 | link previews (sender-made) |
| 55 | `55-gifs-and-keyboard-stickers.js` | 1095 | GIFs and stickers from the phone’s own keyboard, paste, drop |
| 56 | `56-sticker-motion.js` | 730 | sticker motion — looping, stills, hold to look |
| 57 | `57-sibling-files.js` | 543 | files between the account’s own devices |
| 58 | `58-device-roster.js` | 996 | device roster — which devices are the account, which is primary |
| 59 | `59-device-link.js` | 718 | device link — QR linking (add / join) |
| 60 | `60-call-audio.js` | 226 | call audio — full band, RNNoise noise suppression |
| 61 | `61-relay-directory.js` | 503 | relay directory — the operator’s signed list of relays |
| 62 | `62-guest-mode.js` | 663 | guest mode — another relay of the family while home is unreachable |
| 63 | `63-relay-choice.js` | 519 | smart relay choice — measure and pick the best home |

#### A.3 Relay (`scripts/`)

| File | Lines | Role |
|---|---:|---|
| `scripts/server.js` | 13533 | the relay: HTTP + WebSocket + PeerJS, mailboxes, push, TURN credentials, transit, families, guests, alerts, Telegram, dashboard API |
| `scripts/lib/link-preview.js` | 326 | server-side link preview fetcher (SSRF-guarded) |
| `scripts/lib/monitor-dashboard.js` | 1596 | the dashboard page and its script |
| `scripts/lib/operator-signature.js` | 130 | signed operator requests |
| `scripts/lib/push-wording.js` | 117 | push notification wording that reveals nothing |
| `scripts/lib/relay-alerts.js` | 296 | alert engine (thresholds, reminders, quiet hours, delivery policy) |
| `scripts/lib/relay-directory.js` | 185 | family directory: canonical JSON, P-256 signature, verification order |
| `scripts/lib/relay-front.js` | 250 | front doors (a relay answering for another address) |
| `scripts/lib/relay-guests.js` | 398 | guest hosting for the family’s users |
| `scripts/lib/relay-identity.js` | 262 | the relay’s own key and name (hash of the key) |
| `scripts/lib/relay-link.js` | 398 | link between relays |
| `scripts/lib/relay-partners.js` | 407 | partner families |
| `scripts/lib/relay-peers.js` | 570 | transit peers |
| `scripts/lib/relay-report.js` | 370 | status cards and the fleet report (Telegram HTML) |
| `scripts/lib/relay-transit.js` | 137 | forwarding between relays |
| `scripts/lib/relay-updates.js` | 547 | update packages offered to clients and peers |
| `scripts/lib/telegram-settings.js` | 252 | Telegram settings model, validation, defaults from env |
| `scripts/lib/telegram-stickers.js` | 155 | sticker pack fetching by the Bot API |
| `scripts/lib/telegram-text.js` | 159 | all bot wording, Persian and English |
| `scripts/lib/update-package.js` | 242 | build/verify an update package |

Shell scripts in `scripts/` (deploy, setup, update, backup, cert renewal, installers, build scaffolding) are described in §24.

### Appendix B — Every end-to-end suite

`node tests/e2e/<name>.mjs`. Names starting with `_` are harnesses (§22.4). Descriptions are taken from each file’s own header; where a file has none the first thing it checks is given.

| Suite | What it proves |
|---|---|
| `adhoccall` | the Calls tab offers a group call without any group existing; a picker lists the contacts |
| `alerts` | Alerts to the operator (scripts/lib/relay-alerts.js). |
| `allowlist` | Admission by invitation. |
| `androidqr` | The QR code as a phone sees it. |
| `applyupdate` | scripts/apply-update.sh: |
| `atrest` | Nothing secret is left readable in localStorage. |
| `audit` | no eval/Function in shipped scripts; nothing loaded from a third-party origin; no key material in the console |
| `avatars` | A photograph, end to end: |
| `awaypush` | A backgrounded phone is not online, and the message has to reach it. |
| `batch4` | poll composer opens with two option rows, the poll arrives with all options, the question survives the trip |
| `bigfile` | A 4 GB ceiling has to be one the receiver can actually reach. |
| `bootstrapinstall` | The clean-server installer the panel's "Fresh install" command runs. |
| `callbasics` | a plain voice/video call is answered: the other phone rings, answered via direct or relay |
| `callchrome` | A call is activity, an hour is an hour, and a call log says what it moved. |
| `callcodec` | What the call asks Opus for, and what it leaves alone. |
| `calldup` | One call, one row. A call that was answered and hung up normally was also being logged as a missed call. |
| `callfix` | remote video fills the stage, crops instead of letterboxing, self-view is a small rounded tile |
| `callgrow` | two people on a call; a third is added |
| `callladder` | That the quality ladder listens to the encoder, not only to the link. |
| `calllayout` | call up on both sides; phone receives desktop 16:9 stream and vice versa; the pill clears the home indicator (baseline-failing, §22.7) |
| `calllog` | seven staged calls; four sections incl. All; All default |
| `callmirror` | the person called is centred on the desktop screen; pulse rings drawn around them; letterbox is real |
| `callquality` | Connection quality, without leaving the call. |
| `callreal` | four tabs, one row, equal quarters (call tab bar) |
| `callroute` | Two things a call could not say about itself, and both of them decide how good it sounds. |
| `calls` | incoming screen, blurred backdrop + three breathing rings, encryption badge |
| `calltuning` | What the connection is told before it is asked to carry a call. |
| `callvideo` | video mode detected; self-view PiP; drag/tap gestures bound |
| `carrier` | Carrying a message through a messenger that is working but watched. |
| `carriersheet` | "Send another way", driven the way a person drives it. |
| `centralpanel` | One panel for all of an operator's servers (docs/MONITOR-SERVER.md, "Managing all your servers from one place"). |
| `certkeeper` | The certificate keeper (scripts/cert-renewer.sh), in the image the servers run it in, against folders laid out the way a server's are: |
| `chatappearance` | The chat appearance card: |
| `chataudit` | A file-by-file, case-by-case audit of Secure Chat. |
| `chatlab` | The lab: several people in one room at the same time. |
| `chatlock2` | a conversation lock: PIN of at least four digits, set, enforced |
| `chatmenustack` | The thread menu opens over the conversation, not under it. |
| `chatnavfit` | Secure Chat's section tabs fit their labels on a phone. |
| `chatonly` | This app is the messenger out of P00RIJA Cryptography with the other tools taken away. |
| `chatticks` | The three states a sent message goes through, and the colour of the third. |
| `chattools` | The Tools pane inside Secure Chat settings. |
| `choosedialog` | A question with answers shows one way back out, not two. |
| `clientdirectory` | The operator's relay directory in the app (js/chat/61-relay-directory.js). |
| `clusters` | Clusters: groups of one family's relays, each able to carry on alone (docs/RELAY-NETWORK.md, "Clusters"). |
| `composeextras` | Three things the composer does that it did not before. |
| `composer` | The last button of the composer is a microphone while there is nothing to send and the send button once there is (js/messenger.js, wireComposer). |
| `connectionlabel` | What the profile card says about the connection, against a real relay. |
| `contactcard` | A contact handed on, on two real relays. |
| `contacts` | the relay is seen, address book empty, nothing about them written to storage until added |
| `controls` | One look for every control, on every theme, and legible on all of them. |
| `cryptocore` |  |
| `csp` |  |
| `deleteconversation` | Deleting a conversation, on a real relay. |
| `delivery` | A message is delivered whatever the live channel does. |
| `devicebeacon` | Two devices of one account, synced device to device, with the relay keeping nothing for the one that was away. |
| `devicegovern` | One account, several devices, one of them its primary. |
| `devicelink` | Linking a device with a QR code, both ways round, and a call's voice and picture. |
| `devicesync` | One identity, several machines, one relay that must not get in the way. |
| `devicesync2` | The history half of device sync, end to end in two real browsers. |
| `disconnect` | Going offline has to stay offline. |
| `dockerinstall` | The ready-made install: |
| `dockerrelease` | scripts/dockerhub-release.sh refuses to publish an image that carries a private string. |
| `downgrade` | Nobody on the path can talk a live session out of forward secrecy. |
| `duress` |  |
| `emergency` | emergency erase removes storage, databases, caches and the worker while the relay holds a queued envelope |
| `familycsp` | The page's connect-src allows the relays of its family (config/nginx-mirror-csp.sh). |
| `filemgr` | file manager opens; donut draws one arc per non-empty category; non-zero total |
| `filetransfer` | Does a file — any type, any size — actually arrive? npm run relay # terminal 1 PORT=8123 npm run dev # terminal 2 node tests/e2e/filetransfer.mjs FT_HUGE=1 adds a 450 MB pass. |
| `final3` | no password record of any kind; vault derives key with Argon2id at meaningful memory cost |
| `firstpassword` | A relay started with no monitor password — the ready-made Docker install sets none — makes a random one on its first start, keeps only its hash, and shows it once: |
| `formatbar` | The formatting bar, on a phone first and then on a desktop. |
| `formats` |  |
| `forwardall` | Everything forwards as itself. |
| `forwardsecrecy` | a prekey exists with the promised fifteen-day expiry; the message arrives; the envelope on the relay carries both halves |
| `frontdoor` | A front door: relay A answering, at an address of its own, for relay B — the way the relay outside Iran answers for the one inside, which people outside cannot reach over TLS. |
| `gcall` | three people see the group; caller gets a grid stage with own tile; group name and encryption badge |
| `gcalllayout` |  |
| `gcallui` | three on stage; every tile carries a live picture |
| `gifreopen` | The GIF shelf after a GIF is sent, closed and opened again. |
| `gifshelf` | The GIF shelf, kept stickers, picking messages, and saving files. |
| `gifstickers` | the + menu GIF row opens the GIF shelf; empty shelf explains how to fill it |
| `gifthread` | GIFs one after another in a conversation, and the thread holding still. |
| `grouplife` |  |
| `groupparity` |  |
| `groups` | group composer (name + member picker), group created locally |
| `grouptwo` | A group whose members live on two relays and do not all know each other. |
| `guestmode` | Guest mode in the app (js/chat/62-guest-mode.js), on three relays of one family (tests/e2e/_three-stacks.mjs). |
| `help` |  |
| `history-restart` | Real disk-backed Chromium + WebKit restarts, using production vault/chat code. |
| `holdhybrid` | A message for a contact who can do better is not sealed with less. |
| `homerelay` | Where a contact lives, and what that claim is worth. |
| `hostileframes` | Frames a relay must survive, from sockets that owe it nothing. |
| `hybrid` | A conversation recorded today is not readable when the curve falls. |
| `idbsafety` | No picture read from IndexedDB is ever written back to it as it came. |
| `interop` | P00RIJA Chat and P00RIJA Cryptography talk to each other. |
| `keytrust` | first-seen key is pinned; substituted key refused, not adopted |
| `keyverify` | Verifying a contact by scanning their code, and the rule for a verified contact whose key then changes. |
| `langpanels` | Two things the language sweep never reached, and one drawer that scrolled. |
| `langswitch` | Everything that has to change when the language button is pressed. |
| `legacypurge` |  |
| `linkpreview` | A sender-made link preview, from the composer to the other side's card. |
| `linkpreviewrelay` | Link previews fetched by the relay, for the web app and the phone apps. |
| `linkrelays` | scripts/link-relays.sh against two pretend servers on this machine. |
| `linkroomfit` | The room, fitted to a phone: |
| `linkroomui` | The room as a person uses it: |
| `livelocation` | Live location, with the browser's own geolocation moved by the test. |
| `locallink` | Local Link — the offline pair: |
| `localroom` | A room of several people on the local network, with no server anywhere. |
| `lockdefence` | What a lock does when somebody keeps getting it wrong. |
| `maildelivery` | That a mailbox is delivered completely, and once. |
| `mediaerrors` | What the app says when the camera or the microphone will not open. |
| `mediaheal` | A picture whose object URL dies is drawn again from the vault. |
| `messagerequests` | Message requests. STRANGER holds HOST's card; |
| `messenger` | The messenger's shell (js/messenger.js, css/messenger.css): |
| `monitor` | The server monitor, both of it. |
| `native-shell` | Does the payload that goes into the native bundle actually run? node tests/e2e/native-shell.mjs # chromium node tests/e2e/native-shell.mjs webkit # the engine macOS/Linux use It serves dist/tauri with |
| `nativeproxy` | The proxy row against a stand-in for the native shell. |
| `nativeui` | a key can be generated and kept in the native payload; one press runs once; one click opens one confirmation |
| `notificationprivacy` | That what somebody wrote never reaches the system notification surface. |
| `offline-file-size` | What the relay can actually carry for somebody who is offline. |
| `offline` | Can the app send to somebody who is not there? npm run relay # terminal 1 PORT=8123 npm run dev # terminal 2 node tests/e2e/offline.mjs One profile, one invented contact who has never been online. |
| `offlinepwa` |  |
| `opspanel` | The dashboard's server tools — backups and disk cleanup — against a Docker Engine that is ours. |
| `oracle` | The relay cannot borrow a device's private key. |
| `othercodes` | The two codes nothing else covers: |
| `panelaccount` | The panel's account, from the page: |
| `panelconnect` | How the central panel reaches its servers over SSH (tools/panel/core.mjs). |
| `panelfamily` | Clusters, the signed family list and the operator key, managed from the panel against real local relays. |
| `panellauncher` | scripts/panel.sh, the central panel's launcher, in --dry-run: |
| `panelmetrics` | The panel's live graphs and its server preparation, without a server: |
| `panelqr` | The panel's own QR encoder (tools/panel/qr.mjs), proven by reading its output back with the QR decoder the app already ships (vendor/jsqr): |
| `panelservers` | Servers managed from the panel: |
| `panelui` | The central panel's page, in Chromium and WebKit: |
| `panelupdates` | Server updates from the central panel (tools/panel/updates.mjs), with a stand-in docker and a stand-in ssh: |
| `panicconfirm` | two quick Escapes open an “Erase everything?” question and erase nothing; Escape or Cancel backs out; only the confirming button wipes (one press, or presses over half a second apart, ask nothing) |
| `peeridsuffix` | A device whose account address is already held still gets onto P2P. |
| `perf` | How the relay behaves as the room fills up. |
| `persist` | three attachments live on both sides and survive reload; stickers still render |
| `phantom` |  |
| `prekeyhybrid` | What is written to somebody who is away is not readable when the curve falls. |
| `prekeysig` | The relay cannot read what is written to somebody who is away. |
| `prodready` | Is the relay ready for production, and how many people can it carry? node tests/e2e/prodready.mjs # needs Docker The relay is built from the same Dockerfile production uses (config/Dockerfile.chat-sig |
| `profilesync` | A profile, as the people who see it see it — two real relays, five people. |
| `pulltunnel` | The tunnel `deploy.sh --prebuilt` pulls through (scripts/lib/pull-tunnel.sh). |
| `push` | connecting subscribes nobody; switch starts off at the shortest window; five windows offered |
| `pusherrors` | What the user is told when a push call does not get JSON back. |
| `pushrenew` | A switch that says "on" has to mean the phone will ring. |
| `pushurgency` | A notification the vendor is allowed to sit on is a notification nobody gets. |
| `qraudit` | The strict QR audit, run against every code the app can put on a screen. |
| `qrkit` | The QR kit: density, decoding, and the controls around them. |
| `qrscreen` | Every QR the app puts on a screen, read back off the screen. |
| `qrtext` | QR codes for text that is not English. |
| `reactions` | Reacting to a message, on a desktop-sized screen. |
| `receipts` | A read receipt can be turned off, and turning it off stops the reply. |
| `relaychoice` | Best relay (docs/RELAY-NETWORK.md, "Best relay"). |
| `relaydirectory` | Relay families: an operator-signed directory of relays (docs/RELAY-NETWORK.md, "Relay families"). |
| `relaydiscovery` | «کشف محلی» — finding a relay. |
| `relayguests` | Guest mode on the relays (scripts/lib/relay-guests.js and its wiring in scripts/server.js), driven by clients that prove their key as the app does. |
| `relayidentity` | A relay has a name it cannot lie about, and a client that checks it. |
| `relaylink` | Two relays that know which relay they are talking to. |
| `relaymirrors` | A relay reachable at two addresses, and an impostor that claims to be one. |
| `relaypartners` | Partners: families of relays run by different operators, linked through their gateways once an admin approves (docs/RELAY-NETWORK.md, "Linking with other operators"). |
| `relayscale` |  |
| `relaythroughput` | That queuing a file for an absent peer costs the same per chunk from the first chunk to the last. |
| `relayupdateroutes` | Two real relays (scripts/server.js) of one signed family, and an update: |
| `relayupdates` | A relay's updates (scripts/lib/relay-updates.js), with its network, its clock, its users and the step that applies a package all stood in for: |
| `release36` | Production UI regression: |
| `release37` | Production UI regression: |
| `release44` | chat-v44. Three things that shipped broken, each asserted on measured geometry rather than on a screenshot: |
| `release48` | chat-v48. - the phone's quick-access bar survives a lock and a quick-unlock; |
| `retention` | The retention rules, exercised directly against the relay's own store. |
| `run-all` | runs every suite against a running instance and prints one table |
| `screenguard` | The screen guard's page half, in a browser (the native halves are the platform's own switches and are compiled, not driven, here). |
| `scroll` | long thread scrolls; after sending it sits at the newest message; long press turns selection on |
| `scrollmob` | same as scroll at a phone viewport |
| `sealedsender` | Sealed sender and padding, read off the relay's own mailbox file. |
| `security` | What the relay gives away, and what it lets an unauthenticated stranger do. |
| `security3` | search finds a message across conversations, highlighted, with its conversation |
| `sendsession` | "They are offline" is the wrong thing to say to somebody whose recipient is online and typing. |
| `settingsui` | Settings section naming, no list heading, no placeholder card (baseline-failing, §22.7) |
| `siblingsync` | Two devices of one account, kept as one — while both are here, while one is away, and after the other has gone too. |
| `sileotoasts` | The toasts, drawn by sileo (vendor/sileo, built by tools/vendor-sileo). |
| `smartpath` | The route a connection across two relays takes, and what carries it. |
| `smoke` | the page loads with its title; every script tag resolves; every asset carries a version tag |
| `stego` |  |
| `stegoreal` |  |
| `stickerheavy` | A heavy sticker pack: |
| `stickerlib` | The sticker library: recent, favourites, order, and picking several. |
| `stickermanage` | Managing stickers and GIFs one by one. |
| `stickermotion` | Stickers that keep moving, a still for every sticker, a sticker held up. |
| `stickerperf` | Heavy moving packs on a desktop: |
| `stickers` | sticker panel opens from the + menu; empty state before any import |
| `stickerthumbs` | Thumbnails on the sticker pack manager's rows. |
| `stress` | How much the relay can actually hold at once. |
| `swapi` | The service worker hands out the app's own files, never the relay's answers. |
| `swnotify` | What arrives on a phone when a message does. |
| `tabsweep` | Every tab, one at a time, in both languages. |
| `telegram` | What the operator reads in Telegram (scripts/lib/relay-report.js). |
| `telegramsettings` | The Telegram bot's settings (scripts/lib/telegram-settings.js), which the central panel changes while the relay runs: |
| `telegramstickers` | A Telegram sticker pack from its share link, through the relay. |
| `transitpath` | A message crossing two relays, and the carrier learning nothing from it. |
| `transitqueries` | What two linked relays answer besides carrying mail, and what one of them does when the link between them blinks. |
| `transitseal` | The envelope a relay carries without knowing who it is for — and the two implementations of it agreeing. |
| `turnchoice` | Choosing between two TURN servers, per contact. |
| `turnserver` | The TURN server the stack ships, started from the image and with the arguments config/docker-compose.yaml gives it, and asked for what a call asks for: |
| `twoservers` | Two independent deployments, one conversation across them. |
| `uifix` | with two packs staged, picking the other pack does not close the panel and activates it |
| `unifiedpush` | Waking an Android phone without Google in the path. |
| `update-check` | The update checker's two decisions, neither of which is visible until it is wrong in front of a person: |
| `updatenotice` | What a person sees when their server is about to update: |
| `updatepackage` | An update package (scripts/lib/update-package.js): |
| `updatepick` | Which file of a GitHub release a native build offers when a newer version is out (js/update-check.js): |
| `upgrade` |  |
| `uxfixes` | The 2026-08 bug sweep and UX pass, one check per reported fault. |
| `vaultlock` |  |
| `webpanel` | The central panel as a web app (docs/CONTROL-PANEL.md). |
| `windowsnsis` | The Windows installer is made by Debian's NSIS in the builder image (config/Dockerfile.builder-windows), from Tauri's installer template. |

### Appendix C — Relay HTTP surface (`scripts/server.js`, all behind nginx on :1122)

| Path | Method | Purpose |
|---|---|---|
| `/healthz` | GET | liveness with load figures |
| `/chat-health` | GET | `{ ok, version, buildTag, telegramStickers, transit… }` |
| `/ready` | GET | readiness |
| `/live` | GET | liveness |
| `/relay-identity` | GET | relay public key and its name |
| `/relay-prove` | POST | relay proves it holds its key to a client (pin check) |
| `/relay-speed` | GET | speed probe used by smart relay choice |
| `/relay-directory` | GET | operator-signed family directory |
| `/operator-handover` | GET | operator key handover record |
| `/relay-mirrors` | GET / POST | other addresses of this relay (HMAC-authenticated list); POST to declare |
| `/relay-fronts` | GET | front-door ports/origins this relay answers for |
| `/relay-gateways` | GET | gateway relays of partner families |
| `/relay-join` | POST, GET `/relay-join/:id` | a relay asks to join a family; poll the answer |
| `/transit-peers` | GET | transit link state |
| `/cert-status` | GET | certificate expiry report |
| `/turn-config` | GET | TURN URLs and (REST-secret) expiring credentials |
| `/link-preview` | POST | server-side page preview (opt-in by the client) |
| `/telegram-stickers/set, /file` | GET | sticker pack JSON / one sticker file via the Bot API (§21.4) |
| `/push/vapid-public-key, /challenge, /subscribe, /unsubscribe, /poll-token, /poll-token-revoke, /mailbox` | GET / POST | Web Push and UnifiedPush subscription management, poll tokens |
| `/self-destruct/records, /records/:id` | GET / POST | self-destruct timer sync records |
| `/p00rija-update/offer, /package/:id` | GET | update offer and package for clients/peers |
| `/admin/login, /logout, /change-password` | POST | dashboard session |
| `/admin/kick-peer, /suspend-peer, /resume-peer, /unkick-peer` | POST | device moderation |
| `/admin/broadcast, /clear-offline, /optimize-ram, /clear-memory` | POST | operator actions |
| `/admin/allowlist, /allowlist-mode, /allowlist-add, /allowlist-remove` | GET / POST | admission by invitation |
| `/Monitor_Server` | GET | the dashboard page |
| `/Monitor_Server/queues, /queue-mailbox, /queue-drop, /queue-flush` | POST | mailbox inspection (metadata only) and deletion/flush |
| `/Monitor_Server/directory, /operator-handover` | POST | publish directory / handover |
| `/Monitor_Server/partners (+ /lookup /request /carry /approve /reject /remove), /gateways` | POST | partner families |
| `/Monitor_Server/transit, /transit-add, /transit-remove, /traffic, /reports, /expiry-log, /guests, /identities, /announce` | POST | links, traffic, reports, ledger, guests, known identities, announcements |
| `/Monitor_Server/ops-* (memory, memory-set, disk, cleanup, image-check, status, images, image-update, stack-restart, image-export, backup-create/list/download/delete/restore, bundle, github-check/apply/rollback)` | POST | machine operations (needs the Docker socket and install dir) |
| `/Monitor_Server/alert-test, /bootstrap-token` | POST | test alert; make the installer token |
| `/Monitor_Server/updates (+ /stage /policy /cancel /check)` | GET / POST | staged update packages |
| `/Monitor_Server/telegram (+ /preview, /log)` | GET / POST | Telegram settings, preview a card, delivery log |
| `:11222` `/install`, `/bootstrap/…` | GET | bootstrap installer (token-protected) |
| `/chat-signal` (WebSocket), `/peerjs` | WS | relay protocol (Appendix D) and PeerJS signalling |

The route list was read from `app.get/post/use` calls on 2026-11-14; nginx has a matching `location` for each (`tools/check-nginx-routes.cjs` fails otherwise).

### Appendix D — Relay WebSocket message kinds

Client → relay (`message.type` handled in `scripts/server.js`): `hello`, `ping`, `id-proof` (answer to `id-challenge`; signed nonce under `relay-proof/1`), `get-peers`, `presence-state`, `relay` (an envelope to deliver or queue), `relay-ack`, `relay-withdraw`, `transit` (between relays), `route-query`, `home-move`, `guest-end`, `purge-me`, `purge-space`, `beacon-put`, `beacon-get`, `beacon-drop`, `roster-put`, `roster-get`, `sibling-hold`, `sibling-fetch`, `sibling-ack`.

Relay → client (`type:` emitted): `welcome`, `id-challenge`, `spki`, `peers`, `presence`, `relay` (a delivered envelope), `queued` (with `known:false` when the recipient is a stranger to this relay), `route`, `guest-route`, `guest-at`, `guest-status`, `guest-ok`, `guest-refused`, `guest-ended`, `home-move`, `home-move-ok`, `home-move-refused`, `turn`, `roster`, `roster-stored`, `roster-refused`, `beacons`, `beacon-stored`, `beacon-dropped`, `beacon-changed`, `sibling-held`, `sibling-hold-ok`, `purged`, `withdrawn`, `kicked`, `suspended`, `not-allowed`, `device-revoked`, `expired-notice`, `system-note`, `system-broadcast`, `server-update`, `server-draining`, `unifiedpush`, `line`, `pong`, `error` (most common; carries a `reason`).

Inside an envelope the **inner kinds** (never visible to the relay when sealed-sender is on) include `kex-offer/3`, `kex-answer/3`, `kex-confirm`, `chat`, `receipt`, `typing`, `call-invite` and the call/group-call signalling kinds, `rich` (poll, location, live-location, contact), `roster` messages (group), sync rows (devices), `profile`, `hello`. The authoritative list is in `docs/PROTOCOL.md` and the handlers in `js/chat/19-forward-secrecy.js`, `28-offline-envelopes.js`, `16-group-call-signalling.js`, `44-device-beacon.js`.

### Appendix E — Glossary

| Term | Meaning here |
|---|---|
| Relay | the server (`scripts/server.js`) every client connects to; carries sealed envelopes and signalling; never holds plaintext or keys |
| Family | the set of relays one operator signs in a directory; clients may move between them (guest mode) and relays forward between them (transit) |
| Home relay | the configured relay address of an identity; the card the person hands out names home even while they are a guest elsewhere |
| Transit | forwarding of an envelope from one relay to the relay where its recipient lives |
| Front door | a relay port/address that answers for another address (for blocked networks) |
| Mirror | another address of the same relay (second domain, CDN) |
| Guest mode | staying temporarily on another relay of the family while home is unreachable; identity kept, configured address never overwritten |
| Identity | the person’s RSA-3072 key pair; its fingerprint is the account’s name; the same on every device of the account |
| Device key | an ECDSA P-256 key made on one install, never exported; signs roster entries |
| Roster | the account’s signed list of devices, written by its primary |
| Live session | a key shared by two online devices, made by the hybrid exchange (ECDH P-256 + ML-KEM-768), lifetime 7 days |
| kex-offer/3, kex-answer/3, kex-confirm | the three messages of the exchange; HKDF label `poorija-session-v3\|<transcript>` |
| Prekey | a short-lived public key (15-day life, rotated at one third) published for people who are away; since 2.98.9x it has an ML-KEM-768 half and a signature by the identity key |
| Seal | encryption of a message to a prekey (and, hybrid, to its post-quantum half) so a relay can store it for someone away; `poorija-offline-v3` |
| Sealed sender (`ss1`) | the envelope carries no sender fingerprint, signature, inner type or time in the clear |
| Padding (`pad1`) | envelopes padded up a ladder 512 … 65536 B then 16 KB steps |
| `prekeyHybridOwed` | hold policy: a contact once seen with both halves is never sealed to with less; the message waits on this device |
| Downgrade | making two parties use a weaker exchange than both can do; closed by `kexPinned` and by requiring the hybrid for contacts known to do it |
| `relay-proof/1` | the label under which a client signs the relay’s nonce to prove its key (it opens nothing) |
| Vault | the encrypted storage under the master password; two indistinguishable slots (real, decoy) |
| Decoy / duress | the second vault slot opened by the panic password; indistinguishable by design |
| Safety numbers | emoji and QR of both fingerprints used to verify a contact |
| Message request | a first message from a non-contact, held apart until accepted |
| Sibling | another device of the same account |
| Carrier | a watched-but-working messenger used to hand over a sealed message (“Send another way”) |
| Local Link | chat and calls with no server, introduced by QR |
| Lens | the glass piece that marks the selected tab and moves with a spring |
| `!normal` | build opt-out: a declaration the CSS builder leaves un-`!important` because a script animates it inline |
| Layer | the single `@layer chat-ui` that holds every interface rule |
| `--fs`, `--ui-text` | text-size factor and body size in px published by `followTextSize` |
| `--ap-*` | the person’s chat-appearance choices mirrored for the interface layer |
| Build tag | `chat-vN`, bumped every release to bust caches (service worker cache name includes it) |

---

*End of the blueprint.*

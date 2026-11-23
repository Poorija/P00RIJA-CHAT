# Phases 4 and 5 — platform and verification

> **Status:** started 2026-11-22, on 2.13.2. The source is `next_step.md` §5–§6
> (the review); this file is what is actually left of it, checked against the
> code, and the order it will be done in. Address-free, like `docs/BLUEPRINT.md`.
> Same rules as `docs/ROADMAP-3.0.md` §2: one item per release unless tiny, a
> test that fails on the old code, the full gate before a release, a canary
> server first.

---

## 0. Where we start (checked on 2026-11-22, `f093c30`)

| Review item | State in the code |
|---|---|
| 4.1 Settings pages in the iOS / Telegram style | The root and most pages are native rows (`js/messenger-settings.js`). Ten blocks still **move an old card in** (`legacy:`): devices, UnifiedPush, change password, security questions, panic password, file manager, live preview, chat appearance, two in Connection, diagnostics. They work and are themed, but look and behave like cards, not rows. |
| 4.2 Native shells (Tauri 2 desktop, Android, iOS) | **No `src-tauri/` in this repository.** The build scripts (`scripts/build-*.sh`) and `js/desktop-bridge.js` came over from P00RIJA Cryptography and still name its app (`P00RIJA Cryptography.app`). Its shell uses `com.p00rija.cryptography`; ours must not, or an install replaces it. No OS keychain, no VoIP push. |
| 5.1 Adversarial suites | `ratchetpcs` (a stolen key does not open later messages), `ratchetfs`, `replayaad` (replayed, re-typed, re-addressed frames refused), `senderkeys` (join cannot read before, leave cannot read after), `downgrade`, `keytransparency` exist and run in the gate. **Missing: key separation** — that the signing key cannot open a seal and the agreement key cannot make a signature that verifies. |
| 5.2 Audit readiness | `docs/PROTOCOL.md` describes every wire in prose with the byte layouts of the new parts. **Missing:** one specification an auditor can work from (every message, every key, every state machine, a threat model, the test vectors); reproducible builds (images are built from floating bases, no pinned digests, no `SOURCE_DATE_EPOCH`, nothing to check an image against its source); signed release tags / provenance; the audit itself (the owner's to commission). |

## 1. Order

| # | Item | Release | Needs from the owner |
|---|---|---|---|
| 5.1 | `keyseparation` suite (unit + e2e), and the review's four names mapped onto the suites that exist | 2.14.0 | — |
| 4.1 | The ten old cards become native pages (rows, toggles, sheets), page by page, each with its suite kept green | 2.14.x (several) | — |
| 5.2a | `docs/SPEC.md`: the formal specification (messages, keys, KDFs, state machines, AAD, threat model, vectors cross-checked by `tests/unit`) | 2.15.0 | — |
| 5.2b | Reproducible server images: base images pinned by digest, `SOURCE_DATE_EPOCH`, `npm ci` from the lockfile, `tools/verify-build.sh` rebuilds and compares; CI builds twice and compares | 2.15.0 | — |
| 5.2c | Signed release tags and a provenance file per release | 2.15.0 | a signing key (decision 2) |
| 4.2 | Native shells | 3.x | platforms, identifier, signing (decision 1) |
| 5.2d | External audit | — | the owner commissions it; 5.2a–c are the package handed over |

## 2. Decisions recorded

2026-11-22, the owner:

1. **Native shells: desktop and Android together, iOS later.** One Tauri 2
   project (`src-tauri/`, identifier `com.p00rija.chat`, product name
   P00RIJA Chat) for macOS, Windows, Linux and Android. iOS is skipped for now:
   there is no Apple Developer account, so no install outside the simulator and
   no VoIP push; the iPhone keeps the installed web app.
2. **Signing: a new SSH ed25519 key for p00rija on the owner's Mac.** The
   private key stays in `~/.ssh`; release tags are signed with it; the public key
   is published in the repository (`.github/allowed_signers`) so anyone can run
   `git tag -v`.
3. **The audit** is the owner's to commission; 5.2a–c are the package.

## 3. Progress

### 5.1 Adversarial suites — the review's four names, and where each is

| Review name | Suite here | What it shows |
|---|---|---|
| `ratchet-pcs` | `tests/e2e/ratchetpcs.mjs`, `ratchetfs.mjs`, `tests/unit/ratchet.test.mjs` | a session key taken from one side opens no message after the next ratchet step; past message keys are gone |
| `key-separation` | `tests/unit/key-separation.test.mjs` (new, 2026-11-22) | the signing key opens no seal, the agreement key signs nothing that verifies, one key's bytes are refused in the other's place, signatures and seals are bound to their purpose and account |
| `replay-aad` | `tests/e2e/replayaad.mjs`, `tests/unit/aad.test.mjs` | a frame replayed, re-typed, re-addressed or stripped of its binding is refused |
| `sender-keys` | `tests/e2e/senderkeys.mjs`, `tests/unit/sender-keys.test.mjs` | a member who joins cannot open what was sent before; one who leaves cannot open what is sent after (the chain is renewed) |

### 5.2a The specification — done (`docs/SPEC.md`, 2026-11-22)

1,200 lines, about 450 `file:line` references, written from the code: every
key and its one purpose, every message, KDF input, signature label, AEAD
construction and state machine, the threat model, and the index of the test
vectors (three fixed ones exist: RFC 6962 roots, RFC 9605 header and frame;
the rest are property tests). §6 lists where the prose documents had fallen
behind the code (23 items) and what an auditor may want to weigh.

**Findings from writing it, for the owner to decide (cryptography is not
changed without that):**

| # | Finding | Weight | Proposed |
|---|---|---|---|
| 26 | SFrame: the replay window moved before a frame authenticated, so a relay could silence a member with one forged frame | availability | **fixed** (no wire change) |
| 25 | The live handshake's signatures do not cover `v`, `dr`, `rp`, `rq`; stripping them is stopped only by the pins after a contact was seen once | downgrade on first contact | sign them (`kex-offer/4`), negotiated, old refused once both have it |
| 24 | The relay's P-256 key both signs key-log heads and receives transit seals | key separation | a second relay key for the log, announced in the head |
| 4 | An offline envelope can still be sealed to the identity key with the session key inside; only an implicit pin keeps that path from a ratchet session | defence in depth | refuse that path explicitly for a ratchet session, with a test |
| 26b | SFrame: the key-frame flag and the SFU slot are not authenticated; member KIDs are 31 random bits with no collision check | integrity of metadata | put both in the SFrame AAD; check KID collisions on join |
| 27 | The AAD replay memory keeps 256 session ids; an evicted one forgets its numbers | replay after many sessions | keep it per contact, persisted |
| 28 | The key-confirm tag is compared with `!==` | negligible in a browser | constant-time compare anyway |

### 5.2b Reproducible server images — done (2026-11-22)

* Every server image's base is pinned by digest as well as tag (`config/Dockerfile*`).
* The relay installs `config/relay-overrides.json`'s exact dependencies from
  `config/relay-lock.json` with `npm ci`; npm's cache and logs are removed in
  the same layer. `tools/check-relay-pins.cjs` checks pins, lock and Dockerfile
  agree (`--update-lock` rewrites the lock).
* `tools/verify-build.sh [ref|--worktree]` builds app, relay and SFU twice
  from a clean export, `SOURCE_DATE_EPOCH` = commit time, BuildKit
  `rewrite-timestamp`, no shared cache, and compares the OCI archives. On the
  2.13.2 tree the relay image was **not** reproducible (two builds differed);
  with these changes all three are byte-identical. CI runs it on every push.

### 5.2c Signed tags and provenance — done (2026-11-22)

* Release key: `~/.ssh/p00rija_release_signing` (ed25519, made on the owner's
  Mac; fingerprint `SHA256:TPtDvB0/SYYB2NISZUbM3nq+JULZLMwqOIdUhQa3N7U`). Its
  public half is `.github/allowed_signers` (namespaces `git` and
  `p00rija-release`). The repository is configured to sign tags with it
  (`tag.gpgSign`, `gpg.format ssh`).
* `npm run release:provenance -- vX.Y.Z [--images]` writes
  `release/provenance/X.Y.Z.json` (commit, tree, version, SHA-256 of every file,
  and with `--images` the reproducible image digests) and signs it;
  `npm run release:verify -- X.Y.Z` recomputes it from git, checks both
  signatures and the tag. `v2.13.2` is tagged and its provenance written.
* Tags are local until the owner pushes them.

### 4.1 Settings — the old cards (2026-11-22)

* Change master password, recovery questions and the decoy password are now
  inset-grouped Settings rows. The app's own inputs, selects and buttons are
  moved into the rows (`realForm` in `js/messenger-settings.js`), so the
  virtual keyboard, the eye and every handler stay as they were; the words
  follow the language at each draw.
* My devices: the list, the two switches and the two actions are drawn as
  Settings rows (switches at the end of the line) by `css/ui/55-pages.css`,
  over the chat's own markup and handlers.
* Already native and left as they are: Help, About, File manager, Migration.
* Still cards (they hold controls of their own, not a list): the chat
  appearance controls, the relay family and best-relay cards, UnifiedPush, the
  diagnostics output, the live preview (on purpose).

### 4.2 Native shells — desktop and Android (2026-11-22)

* `src-tauri/` comes from P00RIJA Cryptography's shell (same commands the
  web app already calls through `js/desktop-bridge.js`) with every name made
  this app's own: identifier and Android package `com.p00rija.chat`, product
  P00RIJA Chat, binary `p00rija-chat`, keychain service `com.p00rija.chat`
  (quick unlock `com.p00rija.chat.quickunlock`), JNI symbols, Android theme
  and strings, its own icons (from `assets/icon-app.png`). The Cryptography
  app's `.poorija` file associations are dropped. An install of one never
  replaces or reads the other.
* `npm run native:build:mac:arm64` / `native:build:linux` /
  `native:build:windows` / `native:build:android`; `native:prepare` builds
  `dist/tauri` (`scripts/prepare-tauri-web.js`).
* Checked here: `cargo check`, a release macOS `.app` (28 MB) that starts and
  keeps its data under `~/Library/Application Support/com.p00rija.chat`.
* The version is now declared in six places (`src-tauri/tauri.conf.json` and
  `src-tauri/Cargo.toml` with the four before); `check:versions` reads them.
* Not done: code signing and notarisation (macOS needs an Apple Developer ID;
  Windows a certificate), the in-app updater's release URLs point at
  `Poorija/P00RIJA-CHAT` releases that do not exist yet, iOS (decision 1).

## 4. The six findings — design (owner: "fix all of them", 2026-11-22)

Each is negotiated where it changes the wire (a capability or a version, the
old accepted until both sides have shown the new one, then refused), ships
with a test that fails on the old code, and is described in `docs/SPEC.md`.

| # | Fix | Wire | Negotiation |
|---|---|---|---|
| F1 (25) | `kex-offer/4`, `kex-answer/4`: the signed text also covers `v`, `dr`, and the digests of `rp`, `rq`; label `poorija-session-v4` so a v4 key can never equal a v3 key | yes | `v: 4` on the offer when the contact advertised cap `kx4`; once a contact has done v4, `kexPinned = 4` refuses v3 |
| F2 (24) | The relay signs key-log heads with a key of its own (`kt-key`, P-256 ECDSA), announced in `/kt/head` and signed once by the relay identity key; the identity key is then only for transit seals and its relay proof | yes (relay) | a head with `ktKey` is checked against it; a relay that has announced one is not believed signing with the identity key again |
| F3 (4) | `sealOfflineEnvelope` refuses the identity-seal path outright for a contact with a ratchet (`ratchetPinned ≥ 1`) or `kexPinned ≥ 3`, instead of relying on the call sites | no | — |
| F4 (26b) | SFrame: the key-frame flag and the slot enter the frame's AAD (metadata = kind ‖ flags ‖ slot); KIDs are checked for collision when a member's key arrives and a colliding member is asked to re-key | yes (SFU frames) | cap `sfu2`; a call where every member has `sfu2` uses the new AAD; mixed calls keep the old |
| F5 (27) | The AAD replay memory is kept per contact (not 256 sids overall) and survives a reload (in the vault) | no | — |
| F6 (28) | `kex-confirm` tag compared in constant time | no | — |

Order: F6, F5, F3 (local, no wire), then F4, F1, F2. One release (2.15.0).

### Status (2026-11-22): all six done, each with a test that fails on 2.14.0

F1 `kexbinding.mjs` 8/8 · F2 `kt.test.mjs` + `keytransparency.mjs` 24/24 ·
F3, F5 `replayaad.mjs` 18/18 · F4 `sfucall.mjs` 28/28 · F6 by construction
(HMAC verify). Described in `docs/SPEC.md` §7. Release 2.15.0.

# Road to 3.0 — the plan for phases 1 to 3

> **Status:** adopted 2026-11-19. Supersedes the order in `next_step.md` (kept as the source review) for phases 1–3; phases 4–5 of that file are unchanged and come after.
> **Owner's decisions recorded here:** (1) no wire compatibility with P00RIJA Cryptography is kept; (2) the old RSA identity key verifies for **90 days** after the migration, then is dropped; (3) the group-call media service (SFU) runs on the **same eight servers**, beside the stack that is already there, and must not collide with the P00RIJA Cryptography stack that also runs on them.
> **Companion documents:** `docs/PROTOCOL-ROADMAP.md` (why each protocol), `docs/PROTOCOL.md` (wire as it is), `docs/REGRESSION.md` (the gate).

This file is address-free, like `docs/BLUEPRINT.md`.

---

## 0. Where we start (checked in the code on 2026-11-19, 2.5.0 / `bdce9da`)

| Claim in the review | Verified | Where |
|---|---|---|
| One RSA-3072 key both decrypts (RSA-OAEP) and signs (RSASSA-PKCS1-v1_5) | yes | `js/chat/19-forward-secrecy.js` (prekey and handshake signatures), `js/chat/28-offline-envelopes.js` (envelope and space-sync signatures) |
| A live session key lives up to 7 days | yes | `SESSION_KEY_LIFETIME_MS` in `19-forward-secrecy.js` |
| `encryptForSession` uses AES-GCM with no `additionalData` | yes | `28-offline-envelopes.js` |
| The "emergency erase" row opens a decoy and erases nothing | yes | `panicDesc` in `js/app.js` (fa and en); `js/vault-profiles.js` |
| The live key exchange is classical only | **no** — it is already hybrid P-256 ECDH + ML-KEM (`poorija-session-v3`), offline prekeys too (`poorija-offline-v3`) | `19-forward-secrecy.js`, `vendor/mlkem` |
| `server.js` is ~13,500 lines | yes, 13,556 lines, 369 top-level functions | `scripts/server.js` |
| Mailboxes are whole JSON files with synchronous fsync | yes | `writeJsonAtomic` in `scripts/server.js` |

The ratchet is therefore built **on** the hybrid handshake that exists; it does not replace it.

## 1. Two changes to the review's order, and why

1. **New cryptography is written as ES modules from its first line** (`src/crypto/`), unit-tested in Node, and reached from the 65 global scripts through one small bridge. Migrating everything to ES modules *while* rewriting the crypto would edit the same files twice at once (`19`, `28`, `29`, `30`). This way phase 2.1 has already begun when phase 1 ends.
2. **The server work (2.3 split, 2.4 SQLite) runs in parallel with phase 1.** It shares no file with the client crypto, and it is the part that limits capacity today.

## 2. Rules for every step

* One item per release unless tiny. Each item ships with a test that **fails on the old code**.
* Every wire change is **version-negotiated** (a capability in the handshake); once both sides advertise the new version the old one is **refused**, never silently accepted (no downgrade). Nothing cryptographic is deployed half-done.
* Full gate before a release: `node tests/regression.mjs --workers 2` on a quiet machine.
* Deploy order: one canary server first, then the rest; `deploy.sh --check` afterwards.
* **Co-existence on the servers:** this stack keeps its own compose project (`p00rija-chat`), container names (`P00RIJA-Chat_*`), ports (1122 and the 112xx/114xx ranges), volumes and data directory. Any new service (SFU, database file) takes new names and ports from the same scheme and is checked against what is already listening on each host before it is enabled.
* Both languages for every user-visible string.

---

## Phase 1 — Cryptography and security

### 1.0 Decoy password wording (review task 1.5) — release 2.5.1, ~1–2 days
* The row and its page say what the code does: a **decoy profile password** opens a clean, working decoy profile and leaves the real data untouched.
* Real destruction lives in a **Danger zone** group, red, with a second confirmation.
* Test: `tests/e2e/decoywording.mjs` — fails while any string promises a wipe that does not happen.

### 1.1 Bound ciphertext and ordered messages (review task 1.3) — release 2.6, ~5 days
* Canonical binary AAD on every AES-GCM operation of a session: `version ‖ sessionId ‖ senderFingerprint ‖ recipientFingerprint ‖ kind ‖ seq` (length-prefixed fields, fixed order). As built: no separate timestamp — `seq` starts at the clock (ms × 1024), which also survives a lost counter; `sid` is derived from the session key; acceptance is a 2,048-number window rather than `seq > last`, because relay mail legitimately arrives behind live messages.
* A monotonic `seq` per direction; `seq ≤ last` is refused unless it matches a kept skipped key (from 1.3 onward).
* Failure is silent to the peer and recorded locally only.
* Comes before key separation because it is the smallest wire change and the ratchet needs this AAD layout anyway.
* Tests: `replay-aad.mjs` — a replayed message, a re-ordered `seq`, a ciphertext moved to another session: all dropped; a downgrade to the AAD-less format between two new clients is refused.

### 1.2 Separate keys, modern curves (review task 1.1) — release 2.7, ~10 days
* Identity **v4**: an **Ed25519** signing key and an **X25519** agreement key, separate. WebCrypto where the browser has them (current Chrome, Firefox, Safari 17+), a vendored audited fallback (`@noble/curves`) otherwise, chosen by feature detection.
* **Migration without false alarms:** the old RSA key signs the new keys once (cross-signature). A contact that knows the old key accepts the new one without a "key changed" warning. Safety numbers are recomputed and shown as *upgraded*, not *changed*.
* **The RSA key verifies for 90 days after the migration** (owner's decision 2026-11-19), then is deleted from the vault and is no longer accepted.
* Linked devices (`59-device-link.js`, sibling sync) carry the new identity.
* Interop with P00RIJA Cryptography ends here by design (owner's decision); the `interop` suite is declared not runnable in the gate from 2.7b (`tests/regression.mjs`).
* Tests: `key-separation.mjs` (a signing key cannot decrypt, an agreement key cannot sign); `identity-migrate.mjs` (an old account with old contacts upgrades, no warning, no lost history; after 90 days the RSA key is refused).

### 1.3 Double Ratchet with a post-quantum step (review task 1.2) — releases 2.8 and 2.9, ~14–20 days
* **2.8 — symmetric ratchet:** one message key per message from an HKDF chain, erased as soon as it is used. The 7-day session key goes.
* **2.9 — asymmetric ratchet:** a fresh X25519 step on every round trip, and a fresh ML-KEM-768 encapsulation mixed into the root key at intervals (PQ3 style). Full SPQR comes later (`PROTOCOL-ROADMAP.md` 2.3).
* Skipped message keys: encrypted in the vault, at most 1,000, at most 48 hours.
* The ratchet covers every path, not only live text: offline messages (the prekey message becomes the ratchet's first message), files (`29`, `30`), and every pair of devices (one ratchet per device pair).
* State survives reload and relay restart.
* Tests: `ratchet-pcs.mjs` (a stolen chain key does not open messages after the next DH step), `ratchet-ooo.mjs` (out-of-order and lost messages), reload in the middle of a chain.

### 1.4 Key transparency (review task 1.4) — release 2.10, ~10 days
* An append-only Merkle log on each relay of the v4 public keys and their rotations; signed tree heads exchanged over the existing transit links so a relay cannot show two different views.
* An "unverified contact" banner on high-risk actions (large files, screen share) until the safety number is compared.
* Needs 1.2 (the keys it logs are the Ed25519 ones).

---

## Phase 2 — Engineering and architecture

### 2.A Server (in parallel with phase 1)
* **2.3 Split `scripts/server.js`.** First a characterization harness that records today's HTTP and WebSocket behaviour; then extract one module at a time — `mailbox`, `push`, `transit`, `admin`, `ws` — each extraction followed by the gate (especially `relayscale`, `offline`, `retention`). No file over ~800 lines at the end.
* **2.4 SQLite in WAL mode** through Node's built-in `node:sqlite` (no native addon to compile in the image; the image's Node version is checked first). One-time import from the JSON stores, JSON kept as a read-only backup for one release. Canary on one server, then the rest. Capacity proved with `prodready` on a Linux host (it is not certifiable through Docker Desktop).

### 2.B Client (after 1.2)
* **2.1 Vite and ES modules.** `src/crypto/` already exists from phase 1; then `src/transport/`, `src/state/`, `src/ui/`. The current build stays beside it until every e2e suite is green on the new one; then `tools/split-chat.cjs` and `tools/global-collisions.cjs` go.
* **2.2 Types.** `checkJs` with JSDoc on `src/crypto` and the wire types first, `strict` after.
* **2.5 Legacy HTML and CSS.** Last, because `sweep.mjs` and the contrast ratchet stand behind it: one removal at a time, each checked by the sweep in all themes and sizes.

---

## Phase 3 — Protocols and network

### 3.1 Sender Keys for groups (review task 3.1) — after 1.2 and 1.3
* Each sender's chain key and Ed25519 signing key are delivered once over the existing pairwise ratchets; group messages are encrypted once and fanned out by the relay.
* A member leaving or removed: every remaining sender starts a new chain and redistributes it.
* Test: `sender-keys.mjs` — a new member cannot read earlier messages, a removed member cannot read later ones.
* MLS (RFC 9420) for very large groups stays on the watch list.

### 3.2 Group calls: SFU with end-to-end media encryption (review task 3.2) — last
* An SFU on **the same eight servers** (owner's decision), as its own container in this stack's compose project, on its own ports from this stack's range, never sharing a port, volume or container name with P00RIJA Cryptography.
* Media stays end-to-end encrypted with Insertable Streams / SFrame (RFC 9605); the SFU never holds a key.
* First version opt-in and only for calls of more than four people; mesh stays for small calls.

### 3.3 Censorship resistance (review task 3.3) — after 2.3
* What a browser can actually do: WebSocket on 443 behind ordinary TLS, several front doors, ECH at the relay proxy when available, and a parallel race between relays in `42-path-manager.js` that picks the first good path within 800 ms. (Choosing ALPN or carrying the signalling over HTTP/3 from page code is not possible and is not planned.)

---

## Order at a glance

```
client:  1.0 → 1.1 → 1.2 → 1.3a → 1.3b → 1.4 → 2.1 → 2.2 → 2.5 → 3.1 → 3.2
server:  2.3 (split) → 2.4 (SQLite) → 3.3
```

## Progress

| Step | State | Commit / release |
|---|---|---|
| 1.0 Decoy wording | released in 2.6.0 | live |
| 1.1 AAD + sequence | done 2026-11-19 in the tree: `js/crypto/aad.js` (first ES module, `node --test`), cap `aad1`, `aadPinned`; `replayaad` 16/16, 15 related suites 378/378 | released in 2.6.0, live |
| 1.2 relay half | released in 2.6.0 (deployed to all 8, 2026-11-19): v4 proof, continuation, 90-day mailbox alias (`scripts/lib/identity-v4.js`); `relayv4` 15/15, 22 relay suites 551/551 | live |
| 1.2 client half | released in 2.7.0 (deployed to all 8, 2026-11-20): v4 keys, cross-signed move, contact continuation, 90-day window, linked devices; `identitymigrate` 21/21; full gate 219 pass, 7 quarantined, 1 flaky, 1 fail (sweep contrast count 110 = the base tree's on this machine, see DEV-NOTES) | live |
| 1.3a key per message | released in 2.8.0 (deployed to all 8, 2026-11-20): symmetric chains, skipped keys 48 h/1,000, no session key in vault or envelopes, per-transfer file keys, cap dr1, ratchetPinned; `ratchetfs` 13/13; gate 219 pass | live |
| 1.3b the session heals | released in 2.9.0 (deployed to all 8, 2026-11-20): Double Ratchet DH step, ML-KEM-768 step every 50 messages/24 h, cap dr2, ratchetPinned as a level; `ratchetpcs` 10/10; gate 219 pass | live |
| 1.4 key transparency | done 2026-11-20 in the tree: append-only Merkle log of proven v4 keys and moves per relay (`scripts/lib/key-log.js`, RFC 9162 tree), signed head, `/kt/head` `/kt/proof` `/kt/consistency` `/kt/heads`, heads gossiped over transit links (`kt-head`), app check against the pinned relay key (`js/crypto/kt.js`, `kt-bridge.js`, `66-key-transparency.js`), safety-panel line, the unverified-contact line before large files and screen share; `keytransparency` 22/22, unit `kt.test.mjs` 7/7 | live in 2.10.0 on all 8 (2026-11-21) |
| 2.4 SQLite (server) | done 2026-11-20 in the tree, with 1.4: `scripts/lib/state-db.js`, `state.db` in WAL, every store a table row, one-time import per store with the JSON renamed `.imported`, `CHAT_STATE_DB=off` keeps the files | live in 2.10.0 on all 8 (2026-11-21) |
| 2.5 settings fix | Settings > Server and connection shows the relay fingerprint, the relay family and the best-relay choice again (`0b4c951`) | live in 2.10.0 on all 8 (2026-11-21) |
| 2.3 split server.js | done 2026-11-21 (`7c2adaf`, `76806fe`): the relay is 27 ordered parts in `scripts/server/` (largest 839 lines), joined and run as one module by `scripts/server-main.js` with a source map (stack traces name the part); monitor pages in `scripts/lib/monitor-pages.js`; guard `check:server-parts`; 19 relay suites pass | live in 2.11.0 on all 8 (2026-11-21) |
| 3.3 censorship resistance | done 2026-11-21 (`8b37c22`): every known address of the relay (configured, mirrors, front doors) raced at once, first good answer within 800 ms, proved before use; `relaymirrors` 14/14 (blocked address to mirror in ~8 s instead of 25+) | live in 2.11.0 on all 8 (2026-11-21) |
| 3.1 Sender Keys | done 2026-11-21 (`8aca581`): a group text sealed once under the sender's chain, signed, the chain renewed when anyone leaves; `senderkeys` 15/15, unit 9 | live in 2.11.0 on all 8 (2026-11-21) |
| 3.2 SFU + SFrame | done 2026-11-21 (`8aca581`): `scripts/sfu.js` in container `P00RIJA-Chat_Sfu` (port 11223, loopback/bridge only, nginx `/sfu`), WebCodecs + SFrame (RFC 9605 vectors), capability-gated rooms, keys renewed when a member leaves; calls of 5+ on one relay; `sfucall` 16/16 | live in 2.11.0 on all 8 (2026-11-21) |
| 2.2 types | done 2026-11-21 (`ac9e77c`): `tsconfig.json` checkJs strict over `js/crypto` and the relay's key/state/SFU modules, 0 errors; guard `check:types` | in the tree |
| 2.1 Vite and ES modules | done (`f293e8a`, `8beefb7`, `36f9ffc`): the 68 chat scripts are ES modules publishing their names as live accessors (`tools/esm-chat.cjs`); `npm run build:web` → `dist/web`, 105 scripts in 3 files; guards `check:web-build` | live in 2.12.0 on all 8 (2026-11-21) |
| 2.5 legacy CSS/HTML | done as far as it is dead (`f293e8a`, `8beefb7`): 214 CSS rules and the two pieces of markup nothing used; the other old sections are live features | live in 2.12.0 on all 8 (2026-11-21) |

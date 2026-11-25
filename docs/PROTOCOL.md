# How messages and calls are protected

This is what the app does, written so that it can be checked against the code.
The code is in `js/chat/`; the part numbers below are its file prefixes. The
relay (`scripts/server.js`) carries ciphertext and never holds a key that opens
it.

## What each side holds

- **An identity key**: since 2.7 an account is **identity v4** — an Ed25519 key
  that signs and an X25519 key that agrees (the fingerprint is the hash of the
  signing key, `scripts/lib/identity-v4.js`). Older accounts have RSA-3072, and
  an account moves from one to the other by a continuation signed by both keys;
  for 90 days after a move the old RSA key is still believed for what it signed
  before. The key is the name of the person: the fingerprint is its hash, and a
  contact's key is *pinned* the first time it is seen. A key that later changes
  is not accepted silently: the conversation says so and, for a contact whose
  key was verified, refuses to send until it is checked again.
- **A vault**: everything stored on the device (messages, contacts, keys) is
  encrypted under a master password. A second password opens a decoy profile.
- **Safety numbers**: the emoji key (`09-the-emoji-key.js`) and the QR code let
  two people compare their keys in person or over a call.

## A conversation while both are online

A live session is keyed by an exchange (`19-forward-secrecy.js`,
`29-file-transfer.js`), once per connection:

1. One side (the one whose fingerprint sorts first) offers: a fresh ECDH P-256
   key **and** a fresh ML-KEM-768 public key, signed with its identity key
   (`kex-offer/4` toward a contact that reads it, which also signs the ratchet
   keys it asks for; `kex-offer/3` otherwise — `docs/SPEC.md` §7 F1).
2. The other answers with its own ECDH key and an ML-KEM ciphertext to the
   offered key, signed (`kex-answer/3`).
3. Both derive the session key with HKDF from the ECDH secret and the ML-KEM
   secret together, with the whole transcript as context
   (`poorija-session-v3|<transcript>`). It falls only if **both** are broken,
   which is the point: a conversation recorded today cannot be opened by a
   quantum computer later through the curve alone.
4. The answering side does not use the key until the other has proved it holds
   it (`kex-confirm`).

Each message is then AES-256-GCM under a key of its own: with the **Double
Ratchet** (X25519 and ML-KEM-768 steps, `js/crypto/ratchet.js`) every payload is
sealed with the next message key of the sending chain, and a stolen key opens
one message and neither the ones before nor, after the next step, the ones
after; a contact that cannot do it is on the session key alone. The keys are ephemeral,
so a later theft of the identity key does not open recorded conversations
(forward secrecy per connection).

**Every payload is bound to its place** (since 2.6, `js/crypto/aad.js`, cap
`aad1`). Toward a contact whose build reads it, a payload is sealed with
additional data

    "poorija-aad/1" ‖ sid ‖ fromFingerprint ‖ toFingerprint ‖ kind ‖ seq

every field length-prefixed (u32 big-endian; `seq` as 8 bytes). `sid` is the
first 16 bytes, in hex, of `SHA-256("poorija-sid/1" ‖ rawSessionKey)` (both
length-prefixed), so it needs no wire field and changes with the key. `kind` is
the message type (`text`, `rich`, `edit`, `space-message`, `voice`, `file`,
`sticker`) or the type and field of a second payload (`text.preview`). `seq` is
`max(last + 1, nowMs × 1024)`, so a sender that lost its counter never repeats
one. The payload carries `seq` and `a: 1`.

The receiver checks the tag first, then the number against a window of the
2,048 newest it has accepted for that `sid` (kept encrypted with the other
stores, so a reload does not reopen it). A number seen is a replay, one older
than the window is stale; both are dropped without renegotiating the session
(`SessionPayloadRefused`) and acknowledged on the relay path. A payload that
does not authenticate under the binding (moved to another kind, the other
direction, another session, or a changed `seq`) fails like a wrong key.

File chunks are bound to `chunk:<transferId>` and their index instead of a
counter (`a: 1` on the `file-start`), because `file-resend` sends a chunk again.
A sealed envelope's own body is not bound — it is opened by the seal's key and
carries its own counter — but the payloads inside it are.

**No unbinding.** A contact seen once to send a bound payload is remembered
(`aadPinned`, only ever raised by what this device saw) and an unbound payload
or transfer from them is refused.

Not covered yet: two devices of one account share a fingerprint, so a frame
reflected between them is not stopped by the names in the binding; that is
fixed by one ratchet per device pair (`docs/ROADMAP-3.0.md` 1.3).

**No downgrade.** A contact seen to do the hybrid exchange is never again
offered the older one (`kexPinned`, which only goes up). The older exchange
(ECDH only, `poorija-session-v2`) is used only with contacts that cannot do the
new one, such as P00RIJA Cryptography; the key wrapped under RSA that the very
first versions used was removed outright, because a relay that suppressed the
exchange could otherwise make the app fall back to it.

## Identity v4 at the relay (2.7a)

Since 2.7a the relay also takes an **identity v4** account
(`scripts/lib/identity-v4.js`, `docs/design/1.2-identity-v4.md`): the
`publicKeyData` it sends is 32 raw Ed25519 bytes in base64 instead of an RSA
SPKI, and its fingerprint is `SHA-256(u32 len ‖ "poorija-id/4" ‖ u32 32 ‖ key)`.
A key is always judged under its own kind's rule, so a v4 key never passes as a
v3 fingerprint or the other way round.

* **Proof.** A v4 socket or push subscription is sent only a nonce to *sign*
  (`relay-proof/1`, the same text as RSA, signed with Ed25519); nothing sealed
  is ever offered to it, and an `id-proof` without a signature is refused.
  RSA accounts are challenged exactly as before. Guest statements and the
  device roster's certificate are checked with either kind.
* **Moving an account.** A v4 hello may carry `continuation`: the statement
  `"poorija-cont/4" ‖ oldFp ‖ newFp ‖ sk ‖ ak ‖ at` (each length-prefixed),
  signed by the **old RSA key** (PKCS#1 v1.5) and the **new Ed25519 key**, plus
  the agreement key `ak` signed by `sk` (`"poorija-agree/4" ‖ fp ‖ ak`). Once the
  new key is proven and both signatures hold, the relay folds the old mailbox
  into the new one and writes the alias to `identity-moves.json`: mail addressed
  to the old fingerprint goes to the new one, and a socket proving the old key
  is handed nothing, for **90 days** after `at`. The first move holds; a later
  statement pointing the old account elsewhere is refused.
* `/chat-health` says `identity: ["v3", "v4"]`; an app only moves an account
  against a relay that says so.

## Identity v4 in the app (2.7b)

From 2.7b an account is two keys (`js/crypto/identity.js`, bridged by
`js/crypto/identity-bridge.js`):

* **`sk`** — Ed25519, signs everything the RSA key used to sign: the key
  exchange, prekeys and their ML-KEM half, offline envelopes, profile cards,
  space records, relay proofs, the device roster's certificate, guest
  statements, device sync and sibling proofs. The fingerprint is
  `SHA-256(u32 len ‖ "poorija-id/4" ‖ u32 32 ‖ sk)`.
* **`ak`** — X25519, used for every seal that was RSA-OAEP to the identity key
  (the kex contribution, offline seals, device sync, the device beacon, sibling
  files, the photo carrier), signed by `sk` over `"poorija-agree/4" ‖ fp ‖ ak`.
  A seal is `0x04 ‖ ephemeral X25519 (32) ‖ iv (12) ‖ AES-256-GCM`, the key
  HKDF-SHA-256 of the shared secret with salt `ephemeral ‖ ak` and info
  `"poorija-seal-v4" ‖ purpose`, additional data `"poorija-seal-v4" ‖ purpose ‖
  fp`. Purposes in use: `kex`, `offline`.

A contact's `ak` is kept only after `akSig` checks against the `sk` pinned for
them; it arrives on the card (fields 9 and 10 of the camera card), the
session-hello, the relay's presence record, or a continuation.

**Moving.** On the first connection to a relay that says `identity: [..., "v4"]`
in its `welcome`, the device that founded the account (or its roster's
primary) generates `sk` and `ak`, signs the continuation with the RSA key and
`sk`, keeps the RSA key as `legacy` for 90 days, re-signs its prekeys, and sends
an `identity-move` to every contact (live, or in an envelope a contact opens
only to find that move). Linked devices receive the moved identity in the
portable profile or the device link. A browser without both curves stays on
RSA. `localStorage['poorija-identity-v4'] = 'off'` holds the move back.

**A contact receiving a move** checks the RSA signature against the key *it*
pinned, the Ed25519 signature and `akSig`; then the record moves to the new key
in the same conversation, a verification carries over, and one quiet line is
written instead of the key-change banner. A move that does not check changes
nothing. For 90 days the old fingerprint still resolves to the contact and
their old RSA key still verifies what was signed before the move; after that
both are forgotten (`retireLegacy`, `retireContactLegacyKeys`).

A pinned contact's fingerprint no longer moves on a presence record that names
another fingerprint without bringing a key.

## A key per message (2.8)

From 2.8 (`js/crypto/ratchet.js`, `ratchet-bridge.js`, cap `dr1`), when both
sides offer `dr: 1` in the key exchange, the exchange's 32-byte output is only a
seed and is not stored. It is turned into two chains, one per direction
(`o` offerer→answerer, `a` the other way):

    CK_0(dir) = HKDF-SHA-256(seed, salt 0^32, info "poorija-ratchet/1|dir|kid")
    chain id  = first 16 bytes, hex, of SHA-256("poorija-chain-id/1" ‖ CK_0)
    MK_n      = HMAC-SHA-256(CK_n, 0x01)      the key of message n, used once
    CK_n+1    = HMAC-SHA-256(CK_n, 0x02)      CK_n is then dropped

A payload is AES-256-GCM under `MK_n` with the 1.1 binding as additional data
(`sid` = chain id, `seq` = n + 1) and carries `{ r: 1, c, n }`. A receiver steps
its chain to `n`, keeps the keys of numbers it passed (at most 1,000, for 48
hours, encrypted in the vault) and removes a key once used; a number already
used, or more than 1,000 ahead, is refused without renegotiating. A frame that
does not authenticate does not move the chain. Chains are stored encrypted per
contact, so a reload continues them; nothing stored opens a message already
read. A file transfer takes one chain key and derives each chunk's key from it
(`HKDF(MK, "poorija-chunk/1|index")`), announced as `{ rc, rn }` on the
`file-start`. A sealed offline envelope no longer carries the session key.

A contact seen once on the chains (`ratchetPinned`) is refused a key exchange
or a payload without them. An app before 2.8 keeps the 2.7 behaviour with a
newer one. `localStorage['poorija-ratchet'] = 'off'` holds it back on a device.
The Diffie-Hellman step and the post-quantum step (session healing) are 2.9.

## The session heals (2.9)

From 2.9 (cap `dr2`) both sides add their first X25519 ratchet key and their
first ML-KEM-768 key to the key exchange (`dr: 2`, `rp`, `rq`); the four public
keys are hashed into the first root key, so a swapped one only makes the chains
disagree. On that the Double Ratchet runs:

    KDF_RK(rk, x) = HKDF-SHA-256(ikm x, salt rk, info "poorija-rk/2") → rk' ‖ ck

Every message carries the sender's current ratchet public key `d`. A side that
sees a new one makes the receiving step (`KDF_RK(rk, X25519(mine, d))`), a new
key pair, and the sending step (`KDF_RK(rk, X25519(new, d))`). The offerer
starts its sending chain at once; the answerer derives it as its first
receiving chain and starts its own, so either may speak first. Every 50
messages or 24 hours the side making a sending step also encapsulates to the
other's ML-KEM key and mixes the secret in (`X25519 ‖ ss`); that chain carries
the ciphertext `q`, and the side that opens it makes a new ML-KEM key and
announces it as `k` on its next chain. A payload is `{ r: 2, c, n, d, q?, k? }`;
receiving chains from before a step are kept (four at most, 48 hours) for
messages in flight. A header is tried on a copy of the state, kept only once the
message authenticates. A file's transfer key is 32 random bytes sent as a
ratchet message (`rk` on the `file-start`, kind `file-key:<transferId>`).

`ratchetPinned` is now a level (1 or 2); less is refused. A device can be held
at 2.8 with `localStorage['poorija-ratchet'] = '1'`.

## Key transparency (2.10)

Every relay keeps an append-only Merkle log of the v4 keys it has seen proven
and the identity moves it accepted (RFC 9162 tree hash, SHA-256). A leaf is

    lp("poorija-kt/1") ‖ u8 type ‖ lp(fp) ‖ lp(lp(sk) ‖ lp(ak) ‖ lp(akSig)) ‖ u64 at     type 1, a key
    lp("poorija-kt/1") ‖ u8 type ‖ lp(oldFp) ‖ lp(lp(newFp) ‖ lp(statement)) ‖ u64 at   type 2, a move

(`lp` is a u32 big-endian length then the bytes). A key goes in once, the first
time its holder answers the identity challenge with it; the same keys proven
again are not a new leaf. The relay signs its head with its own P-256 key (the
key its id is the SHA-256 of), ECDSA over

    lp("poorija-kt-head/1") ‖ lp(relayId) ‖ u64 size ‖ root ‖ u64 at

and serves `GET /kt/head`, `GET /kt/proof?fp=` (the entries of a fingerprint
with an inclusion proof each, against the newest head), `GET
/kt/consistency?from=&to=` and `GET /kt/heads` (its own head and the newest
head it holds of each linked relay). Over the transit link it sends `kt-head`
when the log changes (at most once a minute) and on connect, and answers
`kt-consistency` with a proof. A relay keeps each peer's newest head; one that
signed two heads that are not one log is marked forked, both heads kept, and an
alert raised.

The app checks a contact's v4 keys against the log of the contact's home relay
(or its own relay, which served them in presence): the head must be signed by
the relay key it pinned and extend the last head it holds of that relay; the
keys must be a leaf with a valid inclusion proof. The answer — logged, not yet
logged, the relay has no log, a different key logged, the relay showed two logs
— is shown in the safety panel. Once a day it checks its own fingerprint on its
own relay; another key logged under it is reported. Before a file over 10 MB or
a screen share to a contact whose safety number was never compared, one line
above the composer says so (Compare now, Not now for a day). It informs; it
does not block.

Not done: the index is not hidden (no VRF) — a fingerprint is not secret and the
log holds public keys only.

## A message for somebody who is away

The relay keeps it in a mailbox until they collect it. It is sealed so that the
relay cannot open it and so that, once the recipient has used up the key, nobody
can:

- Each device publishes a **prekey** with a lifetime of fifteen days (rotated at
  a third of it): an ECDH P-256 key and an ML-KEM-768 key, **signed by the
  identity key**. A sender checks the signature against the key it has pinned
  for that contact before sealing anything to it (`prekey/2`). A relay that
  hands out a prekey of its own is therefore noticed.
- The message's own key is thrown away after sealing; it is wrapped to the
  prekey with a key derived from both halves (`poorija-offline-v3|…`, seal
  version 3). With a contact that has only the ECDH half the seal is version 2.
- **A contact who can do better is not sealed to with less.** For a contact once
  seen with both halves, the app seals with both or not at all: with no valid
  prekey in hand (the relay left the second half out, or the prekey ran out) the
  message stays on the device, marked as waiting, and goes by itself when a
  signed prekey with both halves arrives. The cost is that somebody away longer
  than the prekey lasts cannot be left a message until they are back.

## The relay cannot be used as an oracle

A relay may ask a device to prove its identity (to hand over a mailbox, to
register for push). The device **signs** a nonce with its identity key
(`relay-proof/1`); it never decrypts what the relay sends, because anything a
device opens on request could be a message key in disguise (`30-file-transfer-2.js`).

## Calls

- Voice and video are WebRTC: DTLS-SRTP between the two devices, with the
  signalling (offer, answer, candidates) carried inside the encrypted
  conversation. A TURN server (coturn, `docs/DOCKER.md`) relays media only when
  a direct path is not possible; it sees encrypted packets.
- TURN credentials are short-lived (HMAC secret shared by the relay and coturn),
  not a password that anyone who can fetch a page could read.
- During a call the emoji key shows the same pictures on both screens when the
  two ends hold the keys they think they do.
- Group calls are a mesh of 1:1 connections between the members, with the same
  protection on each (`12-group-call-mesh.js`, `13-group-call-stage.js`).

## Groups

A group is a roster with roles and permissions (`06-groups.js`,
`11-group-permissions.js`). A message to a group is sent to **each member
separately**, sealed to that member exactly like a one-to-one message: there is
no shared group key to leak, and a removed member holds nothing of what comes
after. A member who is away gets theirs sealed to their prekey. A group put on
someone by a stranger waits under **Requests** until they accept it.

## What the relay can see

That a device is connected, to which relay, how much it sends and when;
who a sealed envelope is addressed to (a mailbox name derived from the key, not a
name); and the size of what it carries. It cannot read content, cannot forge a
contact's prekey without being noticed, and cannot make a conversation fall back
to weaker encryption without it being refused or held.

## What is not done

- There is one key per connection, not one per message (no double ratchet), so
  within a connection a stolen session key opens that connection's messages.
- The first time two people meet, nothing stops a relay leaving the second half
  out of a contact's *first* prekey: the weaker seal is used until they have been
  seen with both. Compare safety numbers for anyone who matters.
- The app has not had an independent audit. The suites in `tests/e2e/` play the
  attacker (`downgrade.mjs`, `prekeysig.mjs`, `oracle.mjs`, `holdhybrid.mjs`) and
  each failed before the fix it covers, but that is not the same thing.
- ML-KEM-768 is `@noble/post-quantum` 0.7.1, bundled in `vendor/mlkem/` and
  checked against OpenSSL (`tools/check-mlkem.cjs`).

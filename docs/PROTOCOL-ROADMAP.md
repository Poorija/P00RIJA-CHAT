# Protocols and features worth adding

What the messengers that lead on security and privacy use today, what is new or
still being written, and what of it fits this app. Written 2026-11-15 from
published sources; links are at the end of each item. Several of the drafts
named here change from month to month, and one source is a vendor blog — where a
claim was not confirmed against a primary source it says so.

## What the app has, so the list can be read against it

- Messages: AES-256-GCM, one key per session.
- Live sessions: an ephemeral ECDH P-256 exchange plus an ML-KEM-768 hybrid
  half; the key is renegotiated at least every 7 days.
- Offline messages: a signed prekey (15 days) with an ML-KEM-768 half, sealed
  into an envelope the relay stores and cannot read.
- Identity: one static RSA-3072 key per account (wraps and signs). Contacts are
  pinned and can be verified by QR or fingerprint.
- Relays: eight, federated by transit links; the relay's own identity is pinned
  by the client.
- Calls: WebRTC (DTLS-SRTP), with TURN; group calls are a mesh.
- Groups: every member is sent their own sealed copy (fan-out).

What it does not have: a ratchet inside a session (a session key stays the same
for up to 7 days, so a key stolen on day three opens the rest of that session),
post-compromise recovery, signatures that are post-quantum, key agreement for a
group as such, and a transparency log for keys. (It does have a call emoji key —
six symbols read aloud, Telegram's idea — but until 2.4.1 it was made from the two
pinned identity keys alone, which say who the contacts are and nothing about the
call; see 1.2.)

## 1. Fits now, worth doing first

### 1.1 A hash ratchet per message, and a post-quantum rekey every so often
What iMessage PQ3 does: post-quantum keys at the start *and* periodic rekeying
inside the conversation, hybrid with elliptic curves, so a compromise heals.
Apple ranks it "Level 3" and Signal's earlier PQXDH "Level 2" (initial key only).
Here: derive each message key from a chain key with HKDF (WebCrypto has it),
delete the key after use; every N messages or hours run an ML-KEM-768 + ECDH
exchange inside the session and mix it into the chain.
Feasibility: **high**. No new dependency; the work is in `19-forward-secrecy.js`
and the session code, with a version number in the session offer so an older
peer gets today's behaviour and a downgrade is refused, not silently accepted.
It turns "one key for up to a week" into "one key per message, healed on a
schedule".
Source: [Apple Security Research — iMessage PQ3](https://security.apple.com/tw/blog/imessage-pq3/).

### 1.2 Make the call's code a code of the call (done in 2.4.1)
Discord's DAVE shows a "voice privacy code" derived from the call's key state; ZRTP's
short authentication string is the older form. The app already showed six symbols to
read aloud, but made them from the two identity keys, which are pinned and the same
every call: a server that carries the signalling could answer each side with its own
DTLS fingerprint, end the encryption at itself and pass the media on, and both phones
would still show the same six symbols. Each phone now reads the fingerprints from the
descriptions it applied (`callTransportFingerprints`; exactly one fingerprint per
description, or no code is shown, so a server cannot steer it by listing several), sorts
the pair, and mixes it into the code under a different domain; a server in the middle has to make the two differ,
and the symbols differ with them. Checked with two real peer connections, honest and
with a substituted fingerprint (`tests/e2e/callcode.mjs`).
Source: [Discord — DAVE](https://discord.com/blog/meet-dave-e2ee-for-audio-video).

### 1.3 Passkey that actually holds the key (WebAuthn PRF)
A passkey with the PRF extension returns 32 deterministic bytes bound to that
credential; used as a key-encryption key it unwraps the vault key. The app already
offers "Passkey / Biometric" unlock; with PRF that unlock stops being a gate
in front of a password and becomes a key.
Feasibility: **medium**. Support depends on the credential manager more than the
browser (a 2026 report has Apple's and Google's managers working, some third-party
ones not, and a 1Password response that is not to spec). A deleted passkey takes
what it wrapped with it, so it must sit beside the password and a recovery key,
never replace them.
Source: [Corbado — passkeys and PRF](https://www.corbado.com/blog/passkeys-prf-webauthn).

### 1.4 Hide the client's address from the relay that holds its mail (OHTTP)
Oblivious HTTP (RFC 9458) sends a request through a second party so the server
that answers cannot tie it to the sender's address. Meta uses it in Messenger.
This app owns eight relays: a client of one can send its health, directory and
mailbox-poll requests through another.
Feasibility: **medium**. A relay endpoint and a key-config document on each
relay, HPKE in the page (the vendored ML-KEM does not cover it; WebCrypto has no
HPKE yet, so a small library). The gain is real only for requests that do not
need the address, which is most of them.
Source: [IETF — OHTTP](https://datatracker.ietf.org/doc/draft-ietf-ohai-ohttp/).

## 2. Fits, and is a difference nobody else has

### 2.1 Key transparency across the relay federation
WhatsApp runs an Auditable Key Directory and Apple's Contact Key Verification is a
key-transparency system; the IETF KEYTRANS working group is writing the
architecture (revision 10, October 2026) and the protocol (revision 04). Both are
drafts and say not to rely on them as reference.
Here: each relay publishes an append-only Merkle log of identity-to-key
bindings, signs its tree head, and the relays exchange tree heads over the transit
links; a client that sees two different heads for one relay has caught it lying.
With eight relays, a compromised or malicious one can be caught by the others,
which a single-server messenger cannot offer.
Feasibility: **medium to high effort**, high value. Start with the log and a
client check of the head; the gossip comes second.
Sources: [KEYTRANS architecture](https://www.ietf.org/archive/id/draft-ietf-keytrans-architecture-10.txt),
[Apple — Contact Key Verification](https://security.apple.com/blog/imessage-contact-key-verification/).

### 2.2 Post-quantum signatures for identity and prekeys
Encryption is hybrid post-quantum; the signatures that authenticate keys are RSA.
The MLS ciphersuite draft says plainly that suites with traditional signatures give
post-quantum *confidentiality* only. ML-DSA (FIPS 204) is the answer; Chrome has
announced ML-DSA and ML-KEM for WebCrypto as an experiment (June 2026) and says to
feature-detect and fall back.
Feasibility: **medium**. A vendored ML-DSA-65 next to the RSA signature (both must
verify), feature-detect WebCrypto first. Larger signatures (about 3.3 KB) ride in
the prekey and the hello.
Sources: [MLS PQ ciphersuites draft](https://www.ietf.org/archive/id/draft-ietf-mls-pq-ciphersuites-03.html),
[Chrome — signatures with WebCrypto](https://developer.chrome.com/docs/modern-web-guidance/guides/security/digital-signatures).

### 2.3 Triple Ratchet with a sparse post-quantum ratchet (Signal's SPQR)
Signal released it on 2 October 2025: a second ratchet, ML-KEM Braid, advancing
beside the Double Ratchet, with the two outputs mixed. An attacker must break both.
Downgrades happen automatically for older peers, and Signal plans to make it
mandatory once every client supports it.
Feasibility: **medium-low effort and risk**, and best done as the step after 1.1,
since 1.1 builds the chain this plugs into. The key and ciphertext are over 1,000
bytes each, which is what the Braid is for.
Source: [Signal — SPQR](https://signal.org/blog/spqr/).

## 3. Larger, worth planning

### 3.1 MLS (RFC 9420) for groups
Group key agreement in O(log n) with post-compromise security for the group.
Post-quantum suites are drafts (ML-KEM-768 + X25519, and a variant with a
post-quantum signature); the amortized PQ combiner is in working-group last call.
No maintained browser SDK was found: `mls-rs` lists WebAssembly support and
OpenMLS can target it, neither with a ready package.
Feasibility: **low for now**. Fan-out is correct and simple at the sizes this app
serves; MLS pays off past a few dozen members. Watch the drafts.
Source: [MLS PQ ciphersuites](https://www.ietf.org/archive/id/draft-ietf-mls-pq-ciphersuites-03.html).

### 3.2 SFrame (RFC 9605) on calls
Media is encrypted a second time, inside DTLS-SRTP, with keys from the E2E
session; WebRTC Encoded Transform exposes it. It matters when an SFU or a TURN
relay is trusted less, and for group calls routed through one. It costs CPU on
video and the W3C interface is still a working draft.
Feasibility: **medium**; worth it when group calls stop being a mesh.
Source: [RFC 9605](https://www.rfc-editor.org/rfc/rfc9605.txt).

### 3.3 Mesh for when there is no internet
Bitchat (Bluetooth mesh with Nostr as the internet path) and Briar do this; Bitchat
added store-and-forward in 2026. The app has Local Link already (now a row of
Settings); a store-and-forward of sealed envelopes between nearby phones would
extend it. Web Bluetooth is the obstacle on iOS.
Feasibility: **low** in a browser; high in the native shells.

## 4. New or still being written — watch, do not build on

- **ECH (RFC 9849, March 2026)** hides the relay's name from the network; Chrome
  and Firefox have shipped it, Safari had not, and it needs the relay's DNS and a
  server that supports it (nginx 1.29.4 does). Worth turning on at the relay when
  the proxy in front supports it; nothing for the client to build.
- **Post-quantum in WebRTC's DTLS** — no primary source found; the one claim is a
  vendor blog. Chrome and Firefox do negotiate X25519MLKEM768 in TLS to the relay,
  which already protects signalling and mailbox traffic.
- **MLS combiner and MLS PQ suites** — see 3.1.
- **SimpleX** (queues without user identifiers, a double ratchet with a sparse
  post-quantum step) and **Threema's Ibex** (an ECDH key per message, with a
  security proof) are the two designs closest in spirit to a self-hosted relay;
  neither needs anything this app lacks that 1.1 does not give.

## 5. Features users reach for, not cryptography

Already there (checked in the code): polls, mentions, pins, scheduled send, saved
messages, link previews, screen share, picture-in-picture, noise suppression,
background blur, live location, self-destruct and view-once, and a self-destruct
timer that is kept per conversation (set once in a chat, it applies to what is sent
there and survives a reload; the recipient is not told of it as a shared setting the
way Signal's is — that would be the improvement).
Not there: **round video messages**; **markup in the photo editor** (draw, text, a
blur for faces and numbers — the editor has the canvas and the crop to build it on);
**invite links or a QR for a group**, with the owner approving who joins (the owner's
signature on the invite keeps the relay out of it); a **quick-reply** list.

## Suggested order

1. Per-message hash ratchet with a periodic post-quantum rekey (1.1).
2. (done) The call code made from the call's own keys (1.2).
3. (exists) A self-destruct timer per conversation; next step is making it a shared setting both sides see.
4. Key transparency log on each relay, then the exchange of heads (2.1).
5. ML-DSA beside RSA (2.2), then SPQR on the ratchet (2.3).
6. Passkey PRF with a recovery key (1.3); OHTTP between relays (1.4).

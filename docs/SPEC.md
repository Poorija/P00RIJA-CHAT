# P00RIJA Chat — specification of the cryptographic wire protocols

Roadmap item 5.2a (`docs/ROADMAP-4-5.md`). This document is written for an
external cryptographic auditor. It describes what the code does, not what it
was meant to do: every label, info string and byte layout below was read from
the source and is cited as `file:line`. Where the prose documents
(`docs/PROTOCOL.md`, `docs/design/1.2-identity-v4.md`, `1.3-ratchet.md`,
`1.4-key-transparency.md`) disagree with the code, the code is described here
and the difference is listed in §6. Where a detail could not be settled from
the code that was read, the text says so ("not verified").

Paths are relative to the repository root. `js/chat/NN-*.js` are classic
scripts sharing one global scope; `js/crypto/*.js` are pure ES modules reached
through `js/crypto/*-bridge.js`; `scripts/` is the relay (Node).

---

## 1. Scope, notation, primitives

### 1.1 Scope

In scope: account identity (RSA v3, identity v4 and the continuation between
them), the relay identity proof, the live session handshake, signed prekeys and
offline envelopes (including sealed sender and padding), the 1.1 AAD binding
and counters, the per-message ratchet v1 and v2, file-transfer keys, the
relay transit seal, key transparency, Sender Keys for groups, and the SFU
capability plus SFrame for group calls.

Out of scope (not specified here, not reviewed for this document): the local
vault (`app().encryptStorageData` / `decryptStorageData`, reached from
`saveEncrypted`/`loadEncrypted`, `js/chat/17-file-manager.js:778`,
`js/chat/17-file-manager.js:804`); the relay–relay link itself
(`scripts/lib/relay-link.js`, `scripts/lib/relay-identity.js`, which has an
optional ML-KEM-768 key, `scripts/lib/relay-identity.js:90`); WebRTC
DTLS-SRTP for 1:1 and mesh calls and its binding to the emoji SAS
(`js/chat/09-the-emoji-key.js`); device roster certificates, device sync,
sibling files, the device beacon, guest statements and the photo carrier
(they use the primitives of §3.1 with purposes not enumerated here);
TURN credentials.

### 1.2 Notation

* `‖` — byte concatenation.
* `utf8(s)` — UTF-8 encoding of a JavaScript string. Numbers are turned into
  strings with `String(n)` (decimal, no padding) wherever a field function
  receives a number.
* `u8(n)`, `u16(n)`, `u32(n)`, `u64(n)` — unsigned integers, **big-endian**
  everywhere in this code base. `u64` is written as two `setUint32` halves,
  high then low (`js/crypto/kt.js:38-44`, `js/crypto/aad.js:63-70`,
  `scripts/lib/key-log.js:39`); values are JavaScript safe integers (< 2^53).
* `lp(x)` — length-prefixed field: `u32(len(x)) ‖ x`, where a string is
  `utf8(x)` and `null`/`undefined` is the empty string. This is exactly
  `field()` in `js/crypto/aad.js:49-55`, `js/crypto/identity.js:42-48` and
  `scripts/lib/identity-v4.js:46-51`, and `lp()` in `js/crypto/kt.js:45`,
  `js/crypto/sender-keys.js:66` and `scripts/lib/key-log.js:40`.
* `framed([a, b, …])` = `lp(a) ‖ lp(b) ‖ …` (`js/crypto/identity.js:49-55`,
  `scripts/lib/identity-v4.js:52-54`).
* `nl([a, b, …])` — the strings joined with a single `"\n"` and UTF-8
  encoded, **no length prefixes**. Several older signed statements use this
  form (kex, prekeys, relay proof, envelopes); their fields are hex, base64,
  ids or ISO dates, and none can contain a raw newline in normal operation,
  but the encoding itself is not injective.
* `H(x)` = SHA-256(x); `hexH(x)` = lowercase hex of `H(x)` (`sha256Hex`,
  `js/chat/18-file-manager-2.js:1346-1349`; `kexDigest` applies it to
  `utf8(text)`, `js/chat/19-forward-secrecy.js:103-106`).
* `b64(x)` — standard base64 with padding.
* `HKDF(ikm, salt, info, L)` — RFC 5869 HKDF-SHA-256 via WebCrypto or
  `node:crypto`. `0^32` is 32 zero bytes.
* `AES-GCM(k, iv, aad, pt)` — AES-GCM, 96-bit IV, 128-bit tag, output
  `ciphertext ‖ tag`. "no AAD" means `additionalData` absent.

### 1.3 Primitives and parameters

| Primitive | Parameters as used | Where |
|---|---|---|
| Ed25519 | WebCrypto `{name:'Ed25519'}`; raw 32-byte public keys; 64-byte signatures (length checked) | `js/crypto/identity.js:105-145`; relay `scripts/lib/identity-v4.js:86-98` (SPKI prefix `302a300506032b6570032100`) |
| X25519 | WebCrypto `{name:'X25519'}`, `deriveBits` 256 | `js/crypto/identity.js:166-169`, `js/crypto/ratchet.js:242-253` |
| ECDH P-256 | WebCrypto, SPKI public / PKCS#8 private, `deriveBits` 256 | `js/chat/19-forward-secrecy.js:48-66` |
| ECDSA P-256 | relay identity key; SHA-256; signature encoding IEEE P1363 | `scripts/lib/key-log.js:135-145`, `js/crypto/kt-bridge.js:65-75` |
| ML-KEM-768 (FIPS 203) | `@noble/post-quantum` bundled as `vendor/mlkem/mlkem.bundle.min.js`, exposed as `PoorijaMlKem` with `publicKeyBytes:1184, secretKeyBytes:2400, ciphertextBytes:1088, sharedSecretBytes:32`; lengths checked at use | `js/chat/19-forward-secrecy.js:274`, `js/chat/29-file-transfer.js:2825`, `js/chat/29-file-transfer.js:2887` |
| HKDF-SHA-256 | see each protocol | — |
| HMAC-SHA-256 | chain steps, confirmation tag, SFU capability | `js/crypto/ratchet.js:71-74`, `js/chat/19-forward-secrecy.js:161-164`, `scripts/lib/sfu-rooms.js:39-41` |
| AES-256-GCM | every content seal except SFrame | — |
| AES-128-GCM | SFrame suite `AES_128_GCM_SHA256_128` (0x0004) | `js/crypto/sframe.js:30-33` |
| SHA-256 | fingerprints, ids, Merkle tree | — |
| RSA-3072 (legacy, v3 accounts) | generated `modulusLength: 3072, publicExponent 65537, hash SHA-256` (`js/chat/19-forward-secrecy.js:487-492`); signatures RSASSA-PKCS1-v1_5/SHA-256 (`js/crypto/identity-bridge.js:41-52`); seals RSA-OAEP/SHA-256 (`js/crypto/identity-bridge.js:78-79`, `js/crypto/identity-bridge.js:93-94`) | — |

**RSA legacy window.** `LEGACY_WINDOW_MS = 90 * 24 * 60 * 60 * 1000`
(`js/crypto/identity.js:38`, `scripts/lib/identity-v4.js:40`).
`legacyUntil(at) = at + LEGACY_WINDOW_MS` (`js/crypto/identity.js:196-198`,
`scripts/lib/identity-v4.js:156-158`). Inside the window a moved account still
opens RSA-OAEP seals to its old key (`legacyKeyIfOpen`,
`js/crypto/identity-bridge.js:96-100`), a contact's old RSA key still verifies
(`verifyContactSignature`, `js/chat/28-offline-envelopes.js:474-480`), and the
relay aliases the old mailbox (§3.2.4). After it the legacy key is removed from
the identity record (`retireLegacy`, `js/crypto/identity-bridge.js:159-165`,
called from `js/chat/19-forward-secrecy.js:529-536`).

---

## 2. Keys

| Key | Type | Holder | Stored | Lifetime | Single purpose |
|---|---|---|---|---|---|
| RSA identity (v3) | RSA-3072 | each device of a v3 account | vault, record `chatState.identity` `{publicKeyData (SPKI b64), privateKeyData (PKCS#8 b64), fingerprint}` (`js/crypto/identity-bridge.js:14-20`) | until the account moves; then `legacy` for 90 days | **two** purposes for v3 accounts: PKCS#1 v1.5 signing *and* RSA-OAEP opening. This is the reason for identity v4. |
| `sk` (v4 signing) | Ed25519 | every device of a v4 account | vault, `signPrivate` (PKCS#8 b64) | permanent (no rotation implemented) | sign every statement in §3 |
| `ak` (v4 agreement) | X25519 | every device of a v4 account | vault, `agreePrivate` (PKCS#8 b64); public half signed `akSig` | permanent (KT leaves allow up to 8 per fingerprint, `scripts/lib/key-log.js:177`; no rotation code was found) | open seals of §3.1.4 (purposes `kex`, `offline`, and others out of scope) |
| Relay identity | ECDSA/ECDH P-256 | each relay | relay disk | long-term | (a) sign KT heads; (b) receive transit seals (ECDH). *Two purposes on one key*, see §6. `relayId = hexH(DER SPKI)` (`scripts/lib/relay-identity.js:64-68`) |
| Device key | ECDSA P-256 | each install | not verified | — | `poorija-device-proof` signature beside the relay proof (`js/chat/58-device-roster.js:133-135`, `scripts/server/26-wsserver.js:319-328`) |
| Kex ephemeral | ECDH P-256 | one side, one exchange | session memory only (`session.kexPrivate`) | one exchange | live handshake |
| Kex ML-KEM key | ML-KEM-768 | offerer, one exchange | session memory (`session.kexPq`) | one exchange | live handshake |
| Session key / ratchet seed | 32 bytes (AES-256-GCM key object) | both sides | without ratchet: vault `poorija_chat_session_keys`… (`persistSessionKey`, `js/chat/18-file-manager-2.js:1220-1241`), up to `SESSION_KEY_LIFETIME_MS = 7 d` (`js/chat/19-forward-secrecy.js:46`); with ratchet: **not** written (`forgetSessionKey`, `js/chat/29-file-transfer.js:2508`) but kept in memory as `session.cryptoKey` | one connection | AEAD key (no ratchet) or ratchet seed |
| Confirm key | HMAC-SHA-256 | both sides | memory | one exchange | `kex-confirm` tag |
| Chain keys / root key | 32 bytes | both sides | vault `poorija_chat_ratchets`, per contact fingerprint (`js/crypto/ratchet-bridge.js:28`, `js/crypto/ratchet-bridge.js:59`); dropped after 30 d idle (`js/crypto/ratchet-bridge.js:31`) | until next handshake | derive message keys |
| Ratchet DH key | X25519 | both sides | inside ratchet state (PKCS#8 b64) | one DH step | Double Ratchet |
| Ratchet KEM key | ML-KEM-768 | both sides | inside ratchet state | until used once | PQ step |
| Message key `MK_n` | 32 bytes | both | memory; skipped ones in vault ≤ 48 h | one message | AES-256-GCM key |
| Prekey | ECDH P-256 + ML-KEM-768 | each device | vault `poorija_chat_prekeys` (`js/chat/19-forward-secrecy.js:41`), last 4 kept (`js/chat/19-forward-secrecy.js:430`) | 15 days (`js/chat/19-forward-secrecy.js:43`), new one at 1/3 (`js/chat/19-forward-secrecy.js:404`); expired ones deleted (`js/chat/19-forward-secrecy.js:394-397`) | receive offline envelopes |
| Envelope key | AES-256-GCM, random | sender (dropped after send), recipient | wrapped inside the envelope | one envelope | body and sealed-sender box |
| Transfer key | 32 random bytes (v2) | both | memory | one transfer | HKDF to chunk keys |
| Sender-key chain | 32 bytes + counter | each member, per group | vault `poorija_chat_sender_keys` (`js/crypto/sender-keys-bridge.js:30`) | until a member leaves | group message keys |
| Sender-key signing key | Ed25519 (per chain) | the sending member | vault | one chain | sign group ciphertexts |
| SFrame base key | 16 random bytes | each call participant | memory | until rotation | SFrame key/salt derivation |
| SFU secret | HMAC key | relay | relay disk (`scripts/server/01-boot.js:147`, `scripts/server/01-boot.js:162`) | long-term | mint SFU capabilities |
| Withdraw seed | 32 random bytes | sender | vault (profile) | permanent | take back a sealed-sender envelope (`js/chat/51-envelope-privacy.js:134-147`) |

**Fingerprints.**
* v3: `hexH(DER SPKI)` (`js/chat/19-forward-secrecy.js:498`,
  `scripts/lib/identity-v4.js:75-77`).
* v4: `hexH(framed(["poorija-id/4", raw32(sk)]))`
  = `hexH(u32 12 ‖ "poorija-id/4" ‖ u32 32 ‖ sk)`
  (`js/crypto/identity.js:84-86`, `scripts/lib/identity-v4.js:70-74`).
* A key's kind is decided by shape: 32 raw bytes in base64 is v4, anything
  else RSA (`js/crypto/identity.js:79-82`, `scripts/lib/identity-v4.js:65-68`;
  the relay also requires canonical base64 and ≤ 64 characters,
  `scripts/lib/identity-v4.js:56-61`).
* Safety number: `H(utf8(sort([fpA, fpB]).join("|")))`
  (`js/chat/08-global-search.js:544-548`). Emoji SAS:
  `H(utf8("P00RIJA-call-verify-v1" [+"-bound"] ‖ "|" ‖ sorted fps ‖ ["|" binding]))`
  (`js/chat/09-the-emoji-key.js:68`, `js/chat/09-the-emoji-key.js:103-111`).

---

## 3. Protocols

### 3.1 Identity v4 and continuation from RSA

#### 3.1.1 Labels

| Constant | Value | Code |
|---|---|---|
| `ID_LABEL` | `poorija-id/4` | `js/crypto/identity.js:33`, `scripts/lib/identity-v4.js:36` |
| `AGREE_LABEL` | `poorija-agree/4` | `js/crypto/identity.js:34`, `scripts/lib/identity-v4.js:38` |
| `CONT_LABEL` | `poorija-cont/4` | `js/crypto/identity.js:35`, `scripts/lib/identity-v4.js:37` |
| `SEAL_LABEL` | `poorija-seal-v4` | `js/crypto/identity.js:36` |
| `SEAL_VERSION` | `0x04` | `js/crypto/identity.js:37` |

#### 3.1.2 Generation and the agreement-key signature

`generate()` (`js/crypto/identity.js:105-121`) makes an Ed25519 pair and an
X25519 pair (both extractable, for the vault), and

    akSig = Ed25519.sign(sk_priv, framed(["poorija-agree/4", fp, ak]))

where `fp` is the hex fingerprint text and `ak` the **base64 text** of the
raw X25519 key (`agreeKeyText`, `js/crypto/identity.js:123-125`;
relay `scripts/lib/identity-v4.js:120-122`). `verifyAgreeKey` checks both
keys are 32-byte, `fingerprintV4(sk) === fp`, then the signature
(`js/crypto/identity.js:148-152`, `scripts/lib/identity-v4.js:123-126`).

A contact's `ak` is stored only after `verifyAgreeKey` against the `sk`
pinned for them (session-hello: `js/chat/29-file-transfer.js:2665-2673`;
continuation: `js/chat/65-identity-move.js:89-108`). `sealTo` refuses a v4
contact whose `ak` does not verify (`js/crypto/identity-bridge.js:72-76`).

#### 3.1.3 Sign / verify dispatch

`PoorijaIdentity.sign(identity, bytes)`: Ed25519 with `signPrivate` when
`identity.v === 4`, else RSASSA-PKCS1-v1_5/SHA-256
(`js/crypto/identity-bridge.js:55-58`). `verify(publicKeyData, sig, bytes)`
dispatches on `keyKind` (`js/crypto/identity-bridge.js:60-63`). Every app
signature goes through `identitySignBytes`
(`js/chat/28-offline-envelopes.js:458-462`). Domain separation between
signed statements rests on each statement's leading label (listed per
protocol); the labels in use are `kex-offer/3`, `kex-answer/3`, `prekey/1`,
`prekey/2`, `relay-proof/1`, `poorija-agree/4`, `poorija-cont/4`, and the two
unlabelled statements of §3.4.6 and the space record
(`js/chat/28-offline-envelopes.js:569-576`), which begin with a fingerprint.

#### 3.1.4 The v4 seal (replaces RSA-OAEP to the identity key)

`seal({fp, ak}, purpose, plain)` (`js/crypto/identity.js:154-174`):

    (e, E) ← X25519 keygen            E = raw 32 bytes
    Z      = X25519(e, ak)            32 bytes
    K      = HKDF(ikm Z, salt E ‖ raw(ak), info framed(["poorija-seal-v4", purpose]), 256 bits) → AES-256-GCM
    iv     ← random 12
    C      = AES-GCM(K, iv, aad framed(["poorija-seal-v4", purpose, fp]), plain)
    out    = 0x04 ‖ E (32) ‖ iv (12) ‖ C

`fp` is the **recipient's** fingerprint; the sender is not bound. `purpose`
is required (`js/crypto/identity.js:165`). Purposes in this spec: `kex`
(`js/chat/29-file-transfer.js:2423`, `js/chat/29-file-transfer.js:2470`) and
`offline` (`js/chat/28-offline-envelopes.js:153`,
`js/chat/28-offline-envelopes.js:158`).

`isSeal`: length ≥ 61 and first byte `0x04` (`js/crypto/identity.js:175-178`).
`openSealed` (`js/crypto/identity-bridge.js:86-95`) takes the v4 path when the
account is v4, `isSeal` holds **and** the length is not 384 (an RSA-3072
OAEP output); otherwise RSA-OAEP with the active RSA key (v3) or the legacy
RSA key inside its window.

#### 3.1.5 The continuation (moving a v3 account to v4)

Statement object (`js/crypto/identity-bridge.js:111`):

    { oldFp, newFp, oldKey, sk, ak, at }      at = ms since epoch (integer)

Signed bytes (`continuationText`, `js/crypto/identity.js:193-195`,
`scripts/lib/identity-v4.js:130-132`):

    framed(["poorija-cont/4", oldFp, newFp, sk, ak, String(at)])

`oldKey` is **not** inside the signed bytes; it is bound because
`hexH(oldKey) === oldFp` is checked. The wire object is
`{ statement, akSig, oldSig, newSig }` with `oldSig` RSA PKCS#1 v1.5 by the
old key and `newSig` Ed25519 by the new `sk`, both over the same bytes
(`js/crypto/identity-bridge.js:112-114`, `js/crypto/identity-bridge.js:133`).

Who moves: only the device that generated the account or the roster's
primary, only if the home relay advertises `identity` including `v4`, and not
when `localStorage['poorija-identity-v4'] === 'off'`
(`identityMayMigrate`, `js/chat/19-forward-secrecy.js:570-576`); one move per
account is serialised (`js/chat/19-forward-secrecy.js:538-562`). After the move
the new record keeps the RSA key as `legacy { …, until }`
(`js/crypto/identity-bridge.js:127-132`) and prekeys are signed again
(`js/chat/19-forward-secrecy.js:406-413`, `js/chat/65-identity-move.js:65`).

Distribution: an `identity-move` frame
`{ type:'identity-move', continuation, peerId, createdAt }`
(`js/chat/65-identity-move.js:38-43`) to every contact, live or queued, not
sealed (`js/chat/65-identity-move.js:50-53`); and `move` in every
`session-hello` while the window is open (`js/chat/29-file-transfer.js:3524`).

Client verification (`checkContinuation`,
`js/crypto/identity-bridge.js:140-155`), in order: shape (`oldFp`, `newFp`
64 hex, different); `at` a safe integer not more than 10 min in the future;
`oldKey === pinnedOldKey` (the key **this device** pinned, never the
statement's); `hexH(oldKey) === oldFp`; `verifyAgreeKey(newFp, sk, ak, akSig)`;
RSA `oldSig`; Ed25519 `newSig`; `legacyUntil(at) > now`. On success the
contact record moves to `sk`/`newFp`, keeps `legacyKey`, `legacyFingerprint`,
`legacyUntil = at + 90 d`, carries a verification over, and clears the
pinned session keys (`js/chat/65-identity-move.js:89-131`). A failure changes
nothing.

Relay verification: §3.2.4.

#### 3.1.6 State and downgrade

* A v4 device never creates an RSA signature or seal toward a moved contact
  by construction of `sealTo`/`sign` (dispatch on the contact's key kind and
  on `identity.v`).
* A device whose browser lacks either curve stays on v3 (`supported`,
  `js/crypto/identity.js:90-101`; `migrate` returns `null`,
  `js/crypto/identity-bridge.js:107-109`).
* A pinned contact's fingerprint is not changed by a presence record that
  names another fingerprint without a key (PROTOCOL.md 2.7b; the merge code
  was not re-read for this document).

### 3.2 Relay identity proof

#### 3.2.1 Signed text

    relay-proof/1 \n purpose \n fingerprint \n nonceBase64

i.e. `nl(["relay-proof/1", purpose, fingerprint, nonce])`, client
`js/chat/30-file-transfer-2.js:405-407`, relay
`scripts/server/25-identity-proof.js:37-39`. `purpose` ∈ {`socket`
(`js/chat/30-file-transfer-2.js:433`, `scripts/server/26-wsserver.js:302`),
`push` (`scripts/server/07-where-a-push-endpoint.js:136`)}. The client refuses
a nonce that is not `^[A-Za-z0-9+/=]{16,128}$`
(`js/chat/30-file-transfer-2.js:411`), which keeps the `nl` encoding
unambiguous.

#### 3.2.2 Challenge

`beginIdentityChallenge` (`scripts/server/25-identity-proof.js:48-102`):

* v4 key: `id-challenge { sign: b64(32 random) }` only;
  `idSignOnly = true` (`scripts/server/25-identity-proof.js:58-71`).
* RSA key: `id-challenge { cipher: RSA-OAEP-SHA256(nonce₁), sign: b64(nonce₂) }`
  with two independent 32-byte nonces
  (`scripts/server/25-identity-proof.js:72-95`).
* Timeout 15 s (`scripts/server/25-identity-proof.js:10`).

#### 3.2.3 Answer and check

The client **never opens** `cipher`; it answers only `sign`, and does not
answer a challenge without one (`js/chat/30-file-transfer-2.js:426-441`).
Answer: `id-proof { sig, deviceSig }`, `deviceSig` = device-key ECDSA over
`utf8("poorija-device-proof|" ‖ fp ‖ "|" ‖ deviceId ‖ "|" ‖ nonce)`
(`js/chat/58-device-roster.js:133-135`).

Relay (`scripts/server/26-wsserver.js:281-329`): a late answer to a
superseded nonce is dropped (`scripts/server/26-wsserver.js:284-291`); with
`sig`, `identityProofSigned(publicKeyData, 'socket', fp, idSignNonce, sig)`
which first requires `keyMatchesFingerprint` and then `verifyProof`
(`scripts/server/25-identity-proof.js:40-46`, `scripts/lib/identity-v4.js:80-84`,
`scripts/lib/identity-v4.js:111-116`); without `sig`, a v4 account fails
(`scripts/server/26-wsserver.js:303-305`) and an RSA account may still answer
with the opened nonce (legacy path, `scripts/server/26-wsserver.js:306-312`).
The push endpoint is the same with `purpose = push` and a single-use
challenge (`scripts/server/07-where-a-push-endpoint.js:120-140`).

A proven v4 key is appended to the KT log (`logProvenKey`,
`scripts/server/06-load-balancer-probes.js:71-81`).

#### 3.2.4 Relay handling of a continuation

`acceptIdentityContinuation` (`scripts/server/20-accounts-that-moved-to.js:33`)
runs on a socket that has proven the **new** v4 key; it calls
`verifyContinuation(signed)` **without** a pinned old key
(`scripts/lib/identity-v4.js:137-153`: shape, `at ≥ 0`, not > 10 min in the
future, `oldKey` is RSA and hashes to `oldFp`, `fingerprintV4(sk) === newFp`,
`verifyAgreeKey`, RSA `oldSig`, Ed25519 `newSig`), requires
`newFp === record.fingerprint` and `legacyUntil > now`; **the first move
holds** — a later statement for the same `oldFp` to another `newFp` is
refused (`scripts/server/20-accounts-that-moved-to.js:51`); it records
`oldFp → {newFp, at, until}` (`scripts/server/20-accounts-that-moved-to.js:55`),
logs a move leaf (§3.10), and folds the old mailbox into the new
(`scripts/server/20-accounts-that-moved-to.js:63`).

### 3.3 Live session handshake (hybrid ECDH P-256 + ML-KEM-768)

#### 3.3.1 Roles and transport

Messages travel on the WebRTC data channel between the two devices
(`safeConnectionSend`, `js/chat/29-file-transfer.js:888-899`; frames are padded
by `padLiveFrame`, §3.4.7). The offerer is fixed:
`sessionKeyOwner` = `myFp < theirFp`, and for two devices of one account
`myPeerId < theirPeerId` (`js/chat/18-file-manager-2.js:1252-1264`). The other
side sends `chat-key-request { fingerprint }` and waits.

The first frame each way is `session-hello` (`js/chat/29-file-transfer.js:3514-3532`):

    { type:'session-hello', clientId, peerId, username, publicKeyData, fingerprint,
      move?: <continuation>, agreeKey?, agreeKeySig?, caps: [...], createdAt }

`caps` is noted only for a contact whose pinned key equals the hello's key
(`js/chat/29-file-transfer.js:2678-2681`); caps select features, never a
security level (pins of §3.3.6 do that).

#### 3.3.2 `kex-offer` (v = 3)

Built in `mintSessionKey` (`js/chat/29-file-transfer.js:2380-2466`):

    (x, X)  ← ECDH P-256; X as b64(SPKI)
    kid     = generateId('kex') = "kex-" ‖ Date.now() ‖ "-" ‖ hex(8 random)   (js/chat/17-file-manager.js:3004-3012)
    pub     = b64( sealToIdentity(peer, 'kex', utf8(X)) )                       (v4 seal §3.1.4, or RSA-OAEP)
    (pk, sk_pq) ← ML-KEM-768.keygen
    pq      = b64(pk)

    { type:'kex-offer', pub, kid, fingerprint: myFp,
      dr?: 1 | 2, rp?, rq?,          (ratchet capability, §3.6)
      v: 3, pq, sig }

    sig = Sign_identity( nl(["kex-offer/3", myFp, theirFp, kid, hexH(utf8(pub)), hexH(utf8(pq))]) )

(`kexOfferSignBytes`, `js/chat/19-forward-secrecy.js:110-113`; digests at
`js/chat/29-file-transfer.js:2449-2450`). `pubDigest` is over the base64
**text of the sealed contribution**, not over `X`. **Not signed:** `v`, `dr`,
`rp`, `rq`, `fingerprint` field (the signer's fp enters the signed text, but
the verifier uses the pinned fp).

#### 3.3.3 `kex-answer` (v = 3)

On `kex-offer` (`js/chat/29-file-transfer.js:2764-2860`):

1. `hybridOffer` = `v === 3` and `pq` present. A non-hybrid offer from a
   contact with `kexPinned ≥ 3` is **refused** (`js/chat/29-file-transfer.js:2781-2784`).
2. Verify `sig` with `kexVerify`: the identity key **pinned** for the contact
   (`trustedKey || publicKeyData`), from-fp = pinned fp, to-fp = own fp
   (`js/chat/19-forward-secrecy.js:125-141`, `js/chat/29-file-transfer.js:2786-2793`).
3. Open `pub` with own identity, purpose `kex` → `X` (`js/chat/29-file-transfer.js:2469-2472`).
4. Ratchet level: `offeredLevel` = 2 if `dr === 2` and `rp`,`rq` strings,
   else 1 if `dr ∈ {1,2}`, else 0; `answerLevel = min(local, offered)`;
   refused if `answerLevel < ratchetPinned` (`js/chat/29-file-transfer.js:2803-2809`).
5. `(y, Y)` ← ECDH; `pub' = b64(sealToIdentity(peer, 'kex', utf8(Y)))`;
   `(ct, ss) = ML-KEM.encapsulate(pk)` (pk length 1184 checked).

        { type:'kex-answer', dr?: answerLevel, rp?, rq?, pub: pub', kid, fingerprint: myFp,
          v: 3, pqct: b64(ct), sig }

        offerDigest = hexH(utf8(kid ‖ "|" ‖ hexH(pub) ‖ "|" ‖ hexH(pq)))
        sig = Sign_identity( nl(["kex-answer/3", myFp, theirFp, kid, hexH(utf8(pub')), hexH(utf8(pqct)), offerDigest]) )

   (`kexAnswerSignBytes`, `js/chat/19-forward-secrecy.js:116-119`;
   `js/chat/29-file-transfer.js:2829-2831`).
6. Derive (§3.3.5) and hold the result as `kexPending {kid, cryptoKey,
   confirmKey, ratchet…}`; the session has **no usable key** until
   `kex-confirm` (`js/chat/29-file-transfer.js:2844-2848`). A newer offer that
   arrived meanwhile wins (`js/chat/29-file-transfer.js:2837`).

#### 3.3.4 `kex-confirm`

On `kex-answer` (`js/chat/29-file-transfer.js:2861-2927`) the offerer drops an
answer whose `kid` differs from its current offer
(`js/chat/29-file-transfer.js:2867`), refuses a non-hybrid answer from a
`kexPinned` contact (`js/chat/29-file-transfer.js:2872-2875`), verifies the
answer signature against the pinned key, opens `pub'`, decapsulates `pqct`
(length 1088 checked), derives, checks the ratchet level against
`ratchetPinned` (`js/chat/29-file-transfer.js:2905-2909`), and sends

    { type:'kex-confirm', kid, tag }     tag = b64(HMAC(confirmKey, utf8("kex-confirm/3|offerer|" ‖ kid)))

(`kexConfirmTag`, `js/chat/19-forward-secrecy.js:161-164`;
`js/chat/29-file-transfer.js:2893`, `js/chat/29-file-transfer.js:2911`).
The answerer adopts its pending key only if `kid` matches and the tag equals
the expected string (`js/chat/29-file-transfer.js:2928-2950`; plain string
comparison, not constant-time). Only the `offerer` role label is ever used;
the answerer sends no confirmation, it is authenticated to the offerer by its
signature.

#### 3.3.5 Key derivation

    transcript = hexH(utf8(offerDigest ‖ "|" ‖ hexH(pub') ‖ "|" ‖ hexH(pqct)))     (js/chat/29-file-transfer.js:2832, :2889)
    ecdh       = ECDH-P256(x, Y)   (32 bytes)
    okm        = HKDF(ikm ecdh ‖ ss, salt 0^32, info utf8("poorija-session-v3|" ‖ transcript), 512 bits)
    cryptoKey  = okm[0..32]   AES-256-GCM (extractable)
    confirmKey = okm[32..64]  HMAC-SHA-256

(`deriveHybridKeys`, `js/chat/19-forward-secrecy.js:145-160`.) Identities enter
the key only through the signatures and the identity seals, not through the
KDF input.

`adoptHybridKey` (`js/chat/29-file-transfer.js:2488-2513`): with a ratchet the
raw `cryptoKey` is the ratchet **seed** (§3.6) and is not persisted; without, it
is the session AEAD key and is persisted for ≤ 7 days. It also raises
`kexPinned` to 3 (`pinKexHybrid`, `js/chat/19-forward-secrecy.js:173-178`) and
re-announces the prekey (§3.4.2).

#### 3.3.6 Version negotiation and anti-downgrade

| Pin on the contact record | Raised when | Refuses | Code |
|---|---|---|---|
| `kexPinned ≥ 3` | a hybrid exchange completes, or a prekey with a valid ML-KEM half is seen | non-hybrid offer/answer; any offline seal other than prekey v3 (§3.4.4) | `js/chat/19-forward-secrecy.js:173-181`, `js/chat/19-forward-secrecy.js:348-351` |
| `aadPinned` | a bound payload opened | unbound payloads and unbound transfers | `js/chat/28-offline-envelopes.js:312-317`, `js/chat/28-offline-envelopes.js:424-427`, `js/chat/29-file-transfer.js:3229-3232` |
| `ratchetPinned ∈ {1,2}` | a ratchet payload opened / ratchet started | handshake below that level, payloads without `r` | `js/chat/28-offline-envelopes.js:359-369`, `js/chat/28-offline-envelopes.js:402-405` |

Pins only rise (merge takes the max, `js/chat/18-file-manager-2.js:490-492`).
A record created from something not stored resets them to 0
(`js/chat/18-file-manager-2.js:409`). A first contact can be downgraded by an
active attacker on the channel (nothing is pinned yet).

**Legacy exchange (`poorija-session-v2`).** If neither side is hybrid:
`kex-offer`/`kex-answer` carry only `pub` (sealed ECDH key), **no signature**,
and the key is `HKDF(ECDH, salt 0^32, info "poorija-session-v2", 256)`
(`deriveSharedAesKey`, `js/chat/19-forward-secrecy.js:69-76`;
`completeKex`, `js/chat/29-file-transfer.js:2515-2534`). The offerer is
authenticated to the answerer only by the fact that its contribution was sealed
to the answerer's key, which anyone can do; the answerer to the offerer only by
being able to open the offerer's seal. This path is kept for contacts that
cannot do v3.

**Refused outright:** `chat-key` (a session key delivered wrapped to the
identity key) is never accepted (`js/chat/29-file-transfer.js:2739-2763`).

#### 3.3.7 Replay and concurrency

`kid` names an offer; an answer to a replaced offer is dropped by name. An
offer made < 5 s ago is not replaced by a key request
(`js/chat/29-file-transfer.js:2972`; `kexSettling`,
`js/chat/19-forward-secrecy.js:169-171`). No handshake transcript is
remembered across connections; replay of an old offer leads to a new answer
under fresh ephemerals whose `kex-confirm` the replayer cannot produce.

### 3.4 Signed prekeys and offline envelopes

#### 3.4.1 Prekey record and signatures

Local record (`js/chat/19-forward-secrecy.js:421-433`):
`{ id: generateId('pk'), publicKeyData (P-256 SPKI b64), privateKeyData,
createdAt, expiresAt (ISO), sig, signedBy, pqPublic, pqSecret, pqSig }`.

    sig   = Sign_identity( nl(["prekey/1", fp, prekeyId, prekeyPublic, prekeyExpiresAt]) )
    pqSig = Sign_identity( nl(["prekey/2", fp, prekeyId, prekeyPublic, prekeyExpiresAt, hexH(utf8(pqPublicB64))]) )

(`prekeySignBytes`, `js/chat/19-forward-secrecy.js:199-207`;
`prekeyPqSignBytes`, `js/chat/19-forward-secrecy.js:231-240`;
`completePrekey`, `js/chat/19-forward-secrecy.js:242-264`.) A prekey signed by
another account key than the current one is re-signed
(`js/chat/19-forward-secrecy.js:406-413`).

#### 3.4.2 Distribution and acceptance

Wire form (relay presence or live `prekey` frame,
`js/chat/29-file-transfer.js:2538-2550`):

    { prekeyId, prekeyPublic, prekeyExpiresAt, prekeySig, prekeyPq, prekeyPqSig }

`prekeyIsTheirs` (`js/chat/19-forward-secrecy.js:302-317`): signature against
the **pinned** identity key and fp; `expiresAt` in the future and not more than
15 d + 1 d ahead. `prekeyPqIsTheirs` (`js/chat/19-forward-secrecy.js:268-280`):
the P-256 half holds, `prekeyPq` is 1184 bytes, `prekey/2` verifies.
`considerPrekey` (`js/chat/19-forward-secrecy.js:322-359`): a candidate is
taken only if it verifies; an invalid ML-KEM half is stripped; a held prekey
with both halves is never replaced by one with only P-256; seeing either with
both halves raises `kexPinned` to 3.

#### 3.4.3 The prekey seal (`kex` field of an envelope)

`sealWithPrekey(peer, rawEnvelopeKey)` (`js/chat/28-offline-envelopes.js:73-119`):

Version 3 (both halves verified):

    (e, E)   ← ECDH P-256, E = b64(SPKI)
    (ct, ss) = ML-KEM.encapsulate(prekeyPq);  pqct = b64(ct)
    T        = hexH(utf8(prekeyId ‖ "|" ‖ E ‖ "|" ‖ pqct))
    W        = HKDF(ikm ECDH(e, prekey) ‖ ss, salt 0^32, info utf8("poorija-offline-v3|" ‖ T), 256)   (deriveHybridWrapKey, js/chat/19-forward-secrecy.js:284-296)
    kex      = { v:3, prekeyId, kex:E, pqct, iv: [12 bytes as numbers], key: b64(AES-GCM(W, iv, no AAD, rawEnvelopeKey)) }

Version 2 (P-256 half only):

    W   = HKDF(ikm ECDH(e, prekey), salt 0^32, info "poorija-offline-v2", 256)
    kex = { v:2, prekeyId, kex:E, iv, key }

Open (`openPrekeySeal`, `js/chat/28-offline-envelopes.js:122-146`): the private
prekey must still exist (`findPrekey`, `js/chat/19-forward-secrecy.js:450-461`);
a v3 seal is never opened with the curve alone.

#### 3.4.4 Which seal is used (`sendSealedRelay`)

`js/chat/29-file-transfer.js:904-1071`:

1. If the contact is `kexPinned ≥ 3` and no valid hybrid prekey is in hand,
   **nothing is sent**; the message waits on the device
   (`js/chat/29-file-transfer.js:921`, `prekeyHybridMissing`,
   `js/chat/19-forward-secrecy.js:373-383`).
2. A fresh AES-256 envelope key is wrapped with `sealWithPrekey`.
3. A `kexPinned` contact gets prekey v3 or nothing
   (`js/chat/29-file-transfer.js:939`).
4. Otherwise (no prekey) `seal = b64(sealToIdentity(peer, 'offline', raw(session.cryptoKey)))`
   (`sealSessionKeyFor`, `js/chat/28-offline-envelopes.js:148-155`;
   `js/chat/29-file-transfer.js:940`) — this wraps the **session key** (see §6).

#### 3.4.5 Envelope format

`offlineEnvelope` (`js/chat/28-offline-envelopes.js:220-270`):

    { type:'offline-chat', fromPeerId, fromFingerprint, seal, class, createdAt,
      inner?, signal?, mode?, notify?, scope?, kex?, body? | message?, tag?, to?, sig, sigv }

`body` (prekey path, `js/chat/29-file-transfer.js:965-1006`):

    body = { iv, cipher: b64(AES-GCM(envelopeKey, iv, no AAD,
               utf8(paddedJson({ message, sessionKeyRaw, homeRelay, caps })))), v: 2 }

`sessionKeyRaw` is the raw session key **only when the session has no ratchet**
(`js/chat/29-file-transfer.js:985-991`); with a ratchet it is `''` and the
`message` inside carries ratchet payloads (§3.6). Identity-seal path
(`js/chat/29-file-transfer.js:1007-1036`), only without a ratchet: `body`
encrypted unbound under the session key, with a per-sender counter `seq`
inside. Without either, `message` travels as is (its payloads already
encrypted).

Receiver (`js/chat/29-file-transfer.js:2053-2165`): opens the seal
(prekey or identity), decrypts `body`, drops an envelope whose inner `seq ≤
session.recvSeq` (`js/chat/29-file-transfer.js:2116-2122`), then handles
`message` with `session.cryptoKey` temporarily set to `sessionKeyRaw` or the
seal key (`js/chat/29-file-transfer.js:2199-2261`).

#### 3.4.6 Envelope signature

    sigBytes = nl([fromFingerprint, fromPeerId, createdAt,
                   body ? join(body.iv, ",") ‖ "|" ‖ body.cipher : "msg:" ‖ JSON.stringify(message),
                   (to ? "to:" ‖ to)])
    sig  = b64(Sign_identity(sigBytes));  sigv = to ? 2 : 1

(`offlineEnvelopeSignBytes`, `js/chat/28-offline-envelopes.js:484-498`;
`signOfflineEnvelope`, `js/chat/28-offline-envelopes.js:499-509`.) Not
covered: `seal`, `kex`, `class`, `notify`, `scope`, `inner`. No leading label.

`verifyOfflineEnvelopeSender` (`js/chat/28-offline-envelopes.js:523-555`)
returns `verified | forged | unsigned-pinned | unknown | unsigned`: `to ≠ own fp`
is forged; a claimed fp that disagrees with the relay-proven sender, with the
peer-id record or with the pinned fp (legacy fp allowed in its window) is
forged; an unsigned envelope naming a pinned contact passes only for
`receipt`, `typing`, `ping`, `pong` (`js/chat/29-file-transfer.js:2170-2173`).
First contact is trust-on-first-use.

#### 3.4.7 Sealed sender and padding

Capability `ss1` (`js/chat/51-envelope-privacy.js:59`). Only when a `body`
exists and the recipient reads `ss1` (`js/chat/29-file-transfer.js:1054-1069`):
`to = recipientFp` is set **before** signing, then
`sealEnvelopeSender(envelope, kex ? envelopeKey : session.cryptoKey)`
(`js/chat/51-envelope-privacy.js:151-169`) moves
`fromPeerId, fromFingerprint, sig, sigv, inner, createdAt, to`
(`js/chat/51-envelope-privacy.js:66`) into

    box = { iv, cipher: b64(AES-GCM(sameKey, iv, no AAD, utf8(paddedJson(hidden)))) }
    ss = 1;  eph = 1 (ephemeral types);  wd = hexH(hexH("poorija-withdraw-v1|" ‖ withdrawSeed ‖ "|" ‖ tag))

(`js/chat/51-envelope-privacy.js:142-147`). The box and the body are two
AES-GCM encryptions under one key with independent random IVs; they are not
bound to each other except through `sig` (which covers `body`).

Padding: `paddedJson` grows a JSON object with a `"pad":"000…"` field to the
next of 512, 1024, …, 65536 bytes, then 16 KB steps
(`js/chat/51-envelope-privacy.js:63-84`); live frames ≤ 16 KB other than
`file-chunk` and binary frames are padded the same way
(`js/chat/51-envelope-privacy.js:95-105`).

#### 3.4.8 Limits

Prekey 15 days; an envelope older than 24 h that will not open is
acknowledged as expired (`js/chat/29-file-transfer.js:2066-2100`); a recent
one is left queued. Replay: identity-seal path counter only
(`js/chat/29-file-transfer.js:2116-2122`); prekey-path envelopes rely on the
inner payloads' AAD/ratchet replay checks (§3.5, §3.6). The relay mailbox
retention rules are not specified here.

### 3.5 AAD binding and counters (1.1, cap `aad1`)

    AAD = lp("poorija-aad/1") ‖ lp(sid) ‖ lp(fromFp) ‖ lp(toFp) ‖ lp(kind) ‖ lp(u64(seq))

(`buildAad`, `js/crypto/aad.js:77-82`; labels `js/crypto/aad.js:36-37`; every
field required, `seq` a positive safe integer, `js/crypto/aad.js:63-70`.)
Note the `seq` field is length-prefixed: `u32 8 ‖ u64 seq`.

    sid = hex(H(lp("poorija-sid/1") ‖ lp(rawSessionKey)))[0..32]      (16 bytes as 32 hex chars)

(`sessionId`, `js/crypto/aad.js:87-91`.)

`kind`: the message type (`text`, `rich`, `edit`, `space-message`, `voice`,
`file`, `sticker`, …) or `type.field` for a second payload (e.g.
`text.preview`); required at both ends (`js/chat/28-offline-envelopes.js:327-331`).
`from`/`to` are the pinned fingerprints, never payload fields
(`sessionAadNames`, `js/chat/28-offline-envelopes.js:299-304`).

Sender: `seq = max(floor(nowMs) × 1024, sent + 1)` (`nextSeq`,
`js/crypto/aad.js:95-100`); `seal` returns
`{ iv:[12], cipher, seq, a: 1 }` (`js/crypto/aad.js:142-148`; bridge
`js/crypto/aad-bridge.js:89-96`).

Receiver (`open`, `js/crypto/aad.js:154-167`): tag first, then the window:
`classify` → `stale` if the window is full and `seq < min`, `replay` if seen,
else `new` (`js/crypto/aad.js:105-109`); `REPLAY_WINDOW = 2048`
(`js/crypto/aad.js:41`). Windows are persisted encrypted
(`poorija_chat_aad_windows`, `js/crypto/aad-bridge.js:24`), at most 256
session ids, least recently used evicted (`js/crypto/aad-bridge.js:26`,
`js/crypto/aad-bridge.js:67-79`). A `ReplayError` becomes
`SessionPayloadRefused` (dropped, acknowledged, no renegotiation;
`js/chat/28-offline-envelopes.js:374-380`, `js/chat/28-offline-envelopes.js:414-417`).

File chunks (without ratchet): `chunkAad = buildAad(sid, from, to,
kind "chunk:" ‖ transferId, seq index + 1)`, no window
(`js/crypto/aad.js:173-176`); `file-start` carries `a: 1`
(`js/chat/29-file-transfer.js:408`).

Selection (`encryptForSession`, `js/chat/28-offline-envelopes.js:327-344`):
ratchet if the session has one → AAD if the contact binds (`aadPinned` or cap
`aad1`, `js/chat/28-offline-envelopes.js:305-311`) → unbound AES-GCM.
Decryption order and refusals: `js/chat/28-offline-envelopes.js:381-434`.

### 3.6 Ratchet v1 (hash chains, cap `dr1`) and v2 (Double Ratchet + ML-KEM, cap `dr2`)

#### 3.6.1 Level selection

Local level: 0 if the module is absent or `poorija-ratchet = 'off'`, 1 if
`'1'` or ML-KEM missing, else 2 (`ratchetAvailable`,
`js/chat/28-offline-envelopes.js:350-357`). The offer carries `dr: 1` always
when available and `dr: 2, rp, rq` at level 2
(`js/chat/29-file-transfer.js:2431-2440`); the answer level is the minimum
(§3.3.3). `start` uses v2 only if `mine` and `theirs.rp/rq` exist
(`js/crypto/ratchet-bridge.js:75-88`). `kid` is the handshake's offer id;
`seed = raw(cryptoKey)` (`js/chat/29-file-transfer.js:2495-2499`). Roles:
`offerer` / `answerer` from the handshake.

#### 3.6.2 v1 chains

    CK_0(dir) = HKDF(ikm seed, salt 0^32, info utf8("poorija-ratchet/1|" ‖ dir ‖ "|" ‖ kid), 256)    dir ∈ {"o", "a"}
    chainId   = hex(H(utf8("poorija-chain-id/1") ‖ CK))[0..32]      (no length prefixes)
    MK_n      = HMAC(CK_n, 0x01)
    CK_{n+1}  = HMAC(CK_n, 0x02)

(`js/crypto/ratchet.js:37-38`, `js/crypto/ratchet.js:46-47`,
`deriveChains` `js/crypto/ratchet.js:79-95`, `stepChain`
`js/crypto/ratchet.js:97-103`.) `o` is offerer→answerer. The offerer sends on
`o`, receives on `a`.

Message: `AES-GCM(MK_n, iv, AAD(sid = chainId, from, to, kind, seq = n + 1), pt)`
(`messageAad`, `js/crypto/ratchet.js:165-167`; `encryptWith`,
`js/crypto/ratchet.js:172-177`). Wire payload
`{ iv:[12], cipher: b64, r: 1, c: chainId, n }`
(`js/crypto/ratchet-bridge.js:123-133`).

Receive (`recvKey`, `js/crypto/ratchet.js:120-143`): `n < state.n` → the
skipped key or `ChainError('replay')`; `n − state.n > 1000` →
`'too-far'` (`MAX_SKIP_PER_MESSAGE`, `js/crypto/ratchet.js:43`); skipped keys
kept as `{k, at}`, pruned after `SKIPPED_TTL_MS = 48 h` and capped at
`MAX_SKIPPED = 1000`, oldest index first (`js/crypto/ratchet.js:39-40`,
`js/crypto/ratchet.js:151-161`). The bridge works on a JSON copy and commits
only after the tag checks (`js/crypto/ratchet-bridge.js:154-166`). A
`ChainError` becomes `SessionPayloadRefused`
(`js/chat/28-offline-envelopes.js:383-399`).

#### 3.6.3 v2 Double Ratchet

Constants: `RK_LABEL = "poorija-rk/2"`, `ROOT_LABEL = "poorija-root/2"`,
`PQ_EVERY_MESSAGES = 50`, `PQ_EVERY_MS = 24 h`, `OLD_CHAINS = 4`
(`js/crypto/ratchet.js:220-226`).

Handshake contribution (`ratchetOffer`, `js/crypto/ratchet.js:261-265`): an
X25519 pair (`rp` = b64 raw public) and an ML-KEM-768 pair (`rq` = b64
public). Root key (`startV2`, `js/crypto/ratchet.js:269-299`):

    D   = H( utf8("poorija-root/2|keys|") ‖ utf8(o.rp) ‖ "|" ‖ utf8(o.rq) ‖ "|" ‖ utf8(a.rp) ‖ "|" ‖ utf8(a.rq) )   (base64 texts)
    RK0 = HKDF(ikm seed, salt 0^32, info utf8("poorija-root/2|" ‖ kid ‖ "|") ‖ D, 256)
    KDF_RK(rk, x) = HKDF(ikm x, salt rk, info "poorija-rk/2", 512) → (rk' = [0..32], ck = [32..64])      (js/crypto/ratchet.js:237-241)

Offerer: `RK, CK_s = KDF_RK(RK0, X25519(o.dh_priv, a.rp))`, sending chain with
`d = o.rp`. Answerer: runs `receiveStep(a.rp→o.rp)`, i.e. its first receiving
chain is the offerer's sending chain and it makes its own sending chain at once
(`js/crypto/ratchet.js:289-297`).

`receiveStep(theirPub, q, k)` (`js/crypto/ratchet.js:303-350`):

    if q: ss = ML-KEM.decapsulate(q, kem.priv); new kem pair; announceKem = true
    RK, CK_r = KDF_RK(RK, X25519(dhs.priv, theirPub) [‖ ss])
    old recv chain kept in `chains` (≤ 4, by time)
    dhr = theirPub; if k: peerKem = k
    fresh X25519 pair
    due = peerKem && (sincePq ≥ 50 || now − lastPqAt ≥ 24 h)
    if due: (ct, ss2) = ML-KEM.encapsulate(peerKem); sincePq = 0; lastPqAt = now; peerKem = null
    RK, CK_s = KDF_RK(RK, X25519(fresh.priv, theirPub) [‖ ss2])
    send = { id: chainId(CK_s), ck, n: 0, d: fresh.pub, q?: ct, k?: kem.pub (if announceKem) }

`sendV2` (`js/crypto/ratchet.js:360-368`) increments `sincePq` and returns
header `{ c, n, d, q?, k? }`; every message of a chain repeats `d`, and `q`/`k`
if that chain carries them. Wire payload
`{ iv, cipher, r: 2, c, n, d, q?, k? }` (`js/crypto/ratchet-bridge.js:113-121`);
AAD as v1 with `sid = c`, `seq = n + 1`. The header fields `d`, `q`, `k` are
**not** in the AAD; a changed `d/q/k` yields a different chain id or key and
fails the tag.

`recvV2` (`js/crypto/ratchet.js:373-386`) works on a deep copy: a known chain
id (current or one of the 4 old) is used directly; an unknown one with a new
`d` (≠ current `dhr`) triggers `receiveStep`; the resulting chain id must equal
`c` or `ChainError('unknown-chain')`. The copy becomes the state only after the
tag checks (`js/crypto/ratchet-bridge.js:143-147`). Old receiving chains expire
after 48 h (`pruneChains`, `js/crypto/ratchet.js:351-357`). A v1 payload on a
v2 ratchet is refused (`js/crypto/ratchet-bridge.js:153`).

There is no `pn` (previous chain length) field; messages lost from a replaced
chain more than 4 chains ago or more than 48 h ago cannot be opened.

#### 3.6.4 Persistence

State is JSON with base64 keys, stored encrypted per contact fingerprint
(`js/crypto/ratchet-bridge.js:75-111`), restored after a reload
(`js/crypto/ratchet-bridge.js:90-97`, `js/chat/28-offline-envelopes.js:387`).
One ratchet per contact fingerprint, **not** per device pair.

#### 3.6.5 File-transfer keys

Ratchet session (`js/chat/29-file-transfer.js:400-408`,
`js/crypto/ratchet-bridge.js:174-201`):

    TK      ← 32 random bytes
    rk      = ratchet.seal(TK, kind "file-key:" ‖ transferId)        (an ordinary ratchet message)
    file-start: { …, v: 2, a: 1, rk, totalChunks, chunkBytes }
    K_i     = HKDF(ikm TK, salt 0^32, info utf8("poorija-chunk/1|" ‖ i), 256) → AES-256-GCM
    chunk i = AES-GCM(K_i, iv, AAD(sid = rk.c, from, to, kind "chunk:" ‖ transferId, seq i + 1), bytes)
    wire    = { type:'file-chunk', transferId, index, iv, bin | chunk }

A 2.8 (v1) sender instead announces `{ rc, rn }` and the transfer key is
`MK_rn` of chain `rc` itself (`js/crypto/ratchet-bridge.js:188-195`,
`js/chat/29-file-transfer.js:3245-3257`). Without a ratchet, chunks are under
the session key with `chunkAad` (§3.5) if bound. Chunks may be resent
(`file-resend`, ≤ 256 indices per request,
`js/chat/29-file-transfer.js:3294-3326`); chunk index uniqueness is per transfer
(`js/chat/29-file-transfer.js:3334-3335`).

The `file-start` metadata (`name`, `mime`, `size`, `members`, …,
`js/chat/30-file-transfer-2.js:2629-2654`) is **not** encrypted at the
application layer on the live channel (only DTLS); over the relay it is inside
the sealed `body` when one is made.

### 3.7 Relay transit seal

Client `sealTransitEnvelope` (`js/chat/17-file-manager.js:2564-2587`), relay
`scripts/lib/relay-transit.js:93-117` (the KEM/KDF is `sealTo`/`openSealed` in
`scripts/lib/relay-link.js`, not re-read here; byte-equality is asserted by
`tests/e2e/transitseal.mjs` per the comment at
`js/chat/17-file-manager.js:2503-2507`):

    require hexH(DER(relaySPKI)) == toRelay                               (js/chat/17-file-manager.js:2558-2561)
    (e, E)  ← ECDH P-256, E = b64(SPKI)
    K       = HKDF(ikm ECDH(e, relayKey), salt = SPKI bytes of E, info "poorija-relay-seal-v1", 256)   (js/chat/17-file-manager.js:2541-2553)
    body    = u32(len(J)) ‖ J ‖ 0* to a multiple of 512,  J = utf8(JSON {exp: now + ttl, inner})        (js/chat/17-file-manager.js:2524-2532)
    ct      = AES-GCM(K, iv, aad utf8("poorija-transit-v1|" ‖ lower(toRelay)), body)
    wire    = { type:'transit', v: 1, toRelay, eph: E, iv: b64, ct: b64 }

Constants `js/chat/17-file-manager.js:2511-2517`: TTL 7 days, inner ≤ 24 MiB.
The receiving relay checks `v`, `toRelay`, the tag, and `exp`
(`scripts/lib/relay-transit.js:103-116`). The seal has no replay protection of
its own beyond `exp`.

### 3.8 (reserved — see §3.4.7 for sealed sender)

### 3.9 SFU capability tokens and SFrame

#### 3.9.1 Capability

Requested on the relay socket `{ type:'sfu-room', tag }`; only for a proven
account, ≤ 20 per hour (`scripts/server/26-wsserver.js:596-611`):

    room = hex(16 random)     exp = now + 6 h
    cap  = base64url(HMAC-SHA256(SFU_SECRET, utf8("poorija-sfu/1|" ‖ room ‖ "|" ‖ exp)))

(`scripts/lib/sfu-rooms.js:35-41`, `scripts/lib/sfu-rooms.js:48`.) The SFU checks
`room` matches `^[a-f0-9]{32}$`, `exp` a safe integer ≥ now, and compares in
constant time (`scripts/lib/sfu-rooms.js:42-47`, `scripts/sfu.js:91`). The
host hands `{room, exp, cap, url}` to members inside the encrypted call invite.
The capability authorises bandwidth only; any holder may join; it carries no
identity.

#### 3.9.2 SFU wire

    client → SFU: u8 kind ‖ u8 flags ‖ SFrame        kind 1 audio, 2 video; flags bit0 key frame
    SFU → client: u16 slot ‖ u8 kind ‖ u8 flags ‖ SFrame

(`scripts/lib/sfu-rooms.js:26-31`, `scripts/lib/sfu-rooms.js:83-105`,
`js/chat/68-sfu-call.js:168-181`, `js/chat/68-sfu-call.js:292-298`.) Frames
≤ 256 KiB. Control JSON: `hello {room, exp, cap}` → `welcome {slot, peers}`,
`peer-join`, `peer-leave`, `key-request {to}`, `bye`.

#### 3.9.3 SFrame (RFC 9605, suite 0x0004)

`js/crypto/sframe.js`:

    header        = config ‖ KID? ‖ CTR?   (§4.3; values < 8 inline, else minimal big-endian, KID first)   (:59-93)
    sframe_secret = HKDF-Extract(salt "", base_key)        (empty salt = 32 zero bytes HMAC key)        (:95-98)
    sframe_key    = HKDF-Expand(secret, "SFrame 1.0 Secret key "  ‖ u64(KID) ‖ u16(0x0004), 16)      (:113-127)
    sframe_salt   = HKDF-Expand(secret, "SFrame 1.0 Secret salt " ‖ u64(KID) ‖ u16(0x0004), 12)      (:127)
    nonce         = salt XOR u96(CTR)                                                              (:132-137)
    out           = header ‖ AES-128-GCM(key, nonce, aad = header ‖ metadata, frame), tag 128 bits  (:144-149)

`metadata` = the one byte `kind` (`js/chat/68-sfu-call.js:174`,
`js/chat/68-sfu-call.js:307`). The `flags` byte and the SFU's `slot` are **not**
authenticated.

#### 3.9.4 Keys, distribution, rotation

* Base key 16 random bytes; `KID` = 31 random bits
  (`js/chat/68-sfu-call.js:116-122`); `CTR` starts at 0 and increments per frame.
* Distribution: `gcall-sfkey { callId, slot, kid, key: b64(base), fromFingerprint }`
  (`js/chat/68-sfu-call.js:123-132`) sent with `signalGroupCall`, i.e. as a
  pairwise session event to each member (`js/chat/12-group-call-mesh.js:131-135`).
  Accepted only with the fingerprint the pairwise session authenticated
  (`js/chat/16-group-call-signalling.js:24-27`, `js/chat/68-sfu-call.js:149-164`);
  it records `kid → {keys, fp}` and `slot → fp`; earlier KIDs of that member are
  dropped after 5 s.
* Receive: a frame is accepted only if the KID is known, the slot maps to the
  same fp as the KID, the replay window (4096, `js/chat/68-sfu-call.js:334`)
  accepts `(kid, ctr)`, and the tag checks (`js/chat/68-sfu-call.js:300-308`).
  The replay window is updated **before** authentication.
* Rotation: a new base key and KID for everyone still in the call when a
  `gcall-leave` arrives (`js/chat/16-group-call-signalling.js:155-158`,
  `rotateSfuKey`, `js/chat/68-sfu-call.js:139-146`). No time- or
  counter-based rotation. No rotation on a member who disappears without a
  `gcall-leave` (not verified whether another path covers it).
* Use condition: > 4 people (`SFU_MIN_PEOPLE = 5`,
  `js/chat/68-sfu-call.js:36`), all advertise `sfu1`, all reach the relay's
  family, the relay reports `sfu: true` (`js/chat/68-sfu-call.js:96-111`).
* Sender authenticity among members: symmetric only — any member holding a
  member's base key can forge that member's frames.

### 3.10 Key transparency

#### 3.10.1 Leaf and head bytes

    leaf(type, fp, body[], at) = lp("poorija-kt/1") ‖ u8(type) ‖ lp(fp) ‖ lp( lp(body0) ‖ lp(body1) ‖ … ) ‖ u64(at)
    key  leaf: type 1, fp, body [sk, ak, akSig]          (base64 texts; ak/akSig may be "")
    move leaf: type 2, oldFp, body [newFp, JSON.stringify(statement)]
    head bytes = lp("poorija-kt-head/1") ‖ lp(relayId hex text) ‖ u64(size) ‖ root (32 raw bytes) ‖ u64(at)

(app `js/crypto/kt.js:25-28`, `js/crypto/kt.js:59-72`; relay
`scripts/lib/key-log.js:32-51`; move statement serialisation
`scripts/server/20-accounts-that-moved-to.js:58`.) The move leaf contains the
statement but **not** `oldSig`/`newSig`/`akSig`.

#### 3.10.2 Tree and proofs

RFC 9162: `leafHash = H(0x00 ‖ leaf)`, `node = H(0x01 ‖ l ‖ r)`, split at the
largest power of two `< n`, empty tree `H("")`
(`js/crypto/kt.js:74-88`, `scripts/lib/key-log.js:53-74`). Inclusion proof
`PATH`, consistency proof `SUBPROOF`; verifiers are RFC 9162 §2.1.3.2 and
§2.1.4.2 (`js/crypto/kt.js:118-167`, `scripts/lib/key-log.js:106-131`).

#### 3.10.3 Relay log

`createKeyLog` (`scripts/lib/key-log.js:184-264`): a key is logged when a v4
account proves it (§3.2.3), with `ak/akSig` only if they verify
(`scripts/server/06-load-balancer-probes.js:71-81`); the same
`(fp, sk|ak|akSig)` is never logged twice; ≤ 8 leaves per fp
(`scripts/lib/key-log.js:177`, `scripts/lib/key-log.js:206`); identical leaf
hashes are refused. `at` is the relay's clock. A head
`{ v:1, relayId, size, root (hex), at, sig }` is re-signed when the log grew or
the head is > 1 h old (`scripts/lib/key-log.js:238-249`);
`sig = b64(ECDSA-P256-SHA256-P1363(relayKey, headBytes))`
(`scripts/lib/key-log.js:135-137`). The `v` field is not signed.

Endpoints (`scripts/server/06-load-balancer-probes.js:43-64`): `GET /kt/head`,
`GET /kt/proof?fp=` → `{ head, entries: [{index, type, leaf, at, proof[]}] }`
(`scripts/lib/key-log.js:250-259`), `GET /kt/consistency?from=&to=`,
`GET /kt/heads`.

#### 3.10.4 Gossip

Over the authenticated relay link: `kt-head {head}` on connect and when the
head changed, at most every 61 s (`scripts/server/06-load-balancer-probes.js:87-102`);
`kt-consistency {id, from, to}` / `kt-consistency-answer {id, proof}`
(`scripts/server/06-load-balancer-probes.js:104-126`, 15 s timeout, ≤ 128 hashes).
`receiveKeyHead` requires `head.relayId === link.peerId` and checks the
signature with the link's pinned peer key
(`scripts/server/06-load-balancer-probes.js:128-139`). `createPeerHeads.note`
(`scripts/lib/key-log.js:290-330`): `same`/`extends`/`forked`; a fork keeps
both heads and is permanent; a proof that raced a newer head yields
`unchecked`.

#### 3.10.5 Client check

`PoorijaKeyLog.check(origin, relayPin, {fp, sk, ak, akSig})`
(`js/crypto/kt-bridge.js:104-132`): fetch `/kt/proof`; 404 → `unsupported`;
head well formed, `relayId === relayPin.id`, `hexH(relayPin.key) === relayId`,
ECDSA holds (`js/crypto/kt-bridge.js:65-75`); `noteHead`
(`js/crypto/kt-bridge.js:80-102`) compares with the stored head of that relay
(consistency proof fetched from the same origin; failure to get one →
`error/unchecked`, head not kept; a fork is stored with both heads); every
entry's inclusion proof must verify, else `error/bad-proof`; a type-1 entry
equal to `keyLeaf(fp, sk, ak, akSig, entry.at)` → `logged`; another type-1 key
→ `mismatch` (or `logged` with `otherKeys`). Heads are stored encrypted
(`poorija_chat_kt_heads`, `js/crypto/kt-bridge.js:27`). The verdict is
displayed; it never blocks (`js/chat/66-key-transparency.js:75`,
`js/chat/66-key-transparency.js:102`). The client does not fetch `/kt/heads`.

### 3.11 Sender Keys for groups (cap `sk1`)

`js/crypto/sender-keys.js`:

    keyId   = hex(H(lp("poorija-sk-id/1") ‖ lp(groupId) ‖ lp(senderFp) ‖ lp(ck0) ‖ lp(signPublic)))[0..32]   (:80-83)
    mk_n    = HMAC(ck_n, 0x01);  ck_{n+1} = HMAC(ck_n, 0x02)                                               (:68-74)
    AAD     = lp("poorija-sk/1") ‖ lp(groupId) ‖ lp(senderFp) ‖ lp(keyId) ‖ u32(n) ‖ lp(kind)            (:76-78)  kind default "space-message"
    c       = AES-256-GCM(mk_n, iv, AAD, pt)
    s       = Ed25519(signPrivate, AAD ‖ iv ‖ c)
    wire    = { sk: 1, g: keyId, n, iv: b64, c: b64, s: b64 }                                              (:116-129)
    distribution = { v:1, groupId, senderFp, keyId, ck (current), n (current), signPublic }               (:97-99)

`n` is a **u32** in the AAD (wraps at 2^32; not reachable in practice).
Acceptance of a distribution (`js/crypto/sender-keys.js:105-113`): group and
sender must match the authenticated ones, `keyId` 32 hex, `ck` and
`signPublic` 32 bytes, and **only when `n === 0`** is `keyId` recomputed.
Open (`js/crypto/sender-keys.js:142-175`): signature first, then a copy of the
chain; `n < chain.n` needs a kept key (else `replay`); `n − chain.n > 1000` is
`too-far`; skipped keys ≤ 2000 for 7 days (`js/crypto/sender-keys.js:38-40`).

Transport (`js/chat/30-file-transfer-2.js:1991-2050`,
`js/chat/29-file-transfer.js:3099-3110`): the sealed copy `sk` and the
distribution `skd` ride inside **each member's pairwise** `space-message`
payload (ratchet/AAD of §3.5–3.6); `senderFp` is the pairwise session's
authenticated sender (`authenticatedSenderOf`), never a payload field. A
receiver takes a distribution only for a `keyId` it does not hold, keeps ≤ 3
chains per sender (`js/crypto/sender-keys-bridge.js:31`,
`js/crypto/sender-keys-bridge.js:84-99`).

Rotation (`ownChain`, `js/crypto/sender-keys-bridge.js:60-73`): at the next
send, a new chain if anyone the chain was handed to is no longer in the member
list. No time- or count-based rotation. A joiner gets the current `ck`, which
derives forward only.

---

## 4. Threat model

### 4.1 Relay operator (the relay a device is connected to)

Can: see that a device is connected, when, how much it sends; the recipient
of a sealed envelope (mailbox = fingerprint), its padded size, `class`,
`notify`, `eph`, `scope`, `signal`/`mode` for calls, `kex.prekeyId`; the
sender's socket at submission time even with sealed sender
(`js/chat/51-envelope-privacy.js:31-36`); all `session-hello`, `caps`,
presence, prekeys and public keys; refuse, delay, reorder, drop or replay
anything it carries; withhold a contact's prekey or its ML-KEM half on
**first** contact (then v2 seal is used until `kexPinned`); serve a key it
generated under a fingerprint nobody has compared (detectable by KT and by the
safety number); keep a SFU room it minted open to anyone holding `cap`.

Cannot (by construction, assuming the primitives): read content; forge a
contact's prekey, kex signature, continuation or envelope signature against a
pinned key; open a v4 seal; use a device as a decryption oracle (§3.2: devices
only sign; the RSA `cipher` challenge is never opened by the app); make a
pinned contact fall back to a weaker exchange, binding or ratchet; redirect a
moved account's mailbox a second time (first move holds); show two different
logs to two parties holding each other's heads without the fork being
detectable.

### 4.2 Network attacker

Sees TLS to the relay and DTLS/SRTP between devices (via TURN when needed).
The live data channel's application payloads are encrypted (§3.5/§3.6), but
handshake frames, `session-hello`, `file-start` metadata and control frames on
it are protected by DTLS only. How DTLS fingerprints are authenticated end to
end (the SAS of `js/chat/09-the-emoji-key.js` binds them during calls) is
outside this document; an attacker who can terminate DTLS could still not
complete a v3 handshake against pinned keys, but could strip `dr`/`rp`/`rq`
or `v`/`pq` on a first contact.

### 4.3 Other relays of the family

Over transit a carrying relay sees `toRelay`, padded length and `exp`, not the
inner envelope (§3.7). Relays exchange KT heads; a lying relay can be
reported as forked by the others; a relay may refuse to gossip. A family relay
running the SFU sees the same as §3.9.

### 4.4 A malicious contact or group member

Can: send anything it could send honestly; in a group, read every message
while a member and the chains handed to it; forge SFrame media of another call
member whose base key it holds (§3.9.4); keep the SFrame key of a call it left
without sending `gcall-leave` until someone else triggers rotation; keep group
messages flowing to it until a member's next send after its removal. Cannot:
forge a group text as another member (per-chain Ed25519 signature,
`js/crypto/sender-keys.js:127`, `js/crypto/sender-keys.js:148`); read what was
sent before it joined (forward-only chains) or after a rotation that excluded
it.

### 4.5 Device theft / compromise

A stolen unlocked device yields: identity keys, prekeys still in their window
(→ every envelope sealed to them), ratchet states (→ messages not yet sent on
current chains, skipped keys ≤ 48 h), non-ratchet session keys ≤ 7 d, sender-key
chains (forward only), KT heads. v1 chains give no post-compromise security;
v2 heals after a DH round trip, and the PQ step at most every 50 messages /
24 h. With only the vault ciphertext, security reduces to the vault (out of
scope). Not covered: two devices of one account share chains with a contact
(one ratchet per contact, not per device pair) and share a fingerprint, so a
frame reflected between them is not stopped by the AAD names
(`docs/PROTOCOL.md:72-74`).

### 4.6 Explicitly out of scope / not done

From `docs/PROTOCOL.md` "What is not done" (`docs/PROTOCOL.md:301-312`) and
"What the relay can see" (`docs/PROTOCOL.md:293-299`), as still true in code:
first-contact prekey downgrade; no independent audit; KT has no VRF (the index
is public, `docs/PROTOCOL.md:240-241`); ML-KEM is a vendored JavaScript
implementation (`vendor/mlkem/`). Also: no per-device ratchet; no PQ
protection of the KT head signature or of the relay transit seal (P-256 only);
no deniability analysis; vault, roster, device sync and relay–relay link not
specified here.

---

## 5. Test-vector index

Only vectors and checks that exist in `tests/unit/` are listed. "Fixed
vector" means expected bytes are hard-coded; "property" means a round-trip or
refusal check with random keys.

| Construction | Test | Kind |
|---|---|---|
| AAD encoding unambiguous | `tests/unit/aad.test.mjs:29` | property |
| AAD fields required, `seq` positive integer | `tests/unit/aad.test.mjs:36` | property |
| `sid` depends on key only, 32 hex | `tests/unit/aad.test.mjs:44` | property |
| `nextSeq` monotone, clock floor | `tests/unit/aad.test.mjs:52` | property |
| bound seal/open, any other binding refused | `tests/unit/aad.test.mjs:64`, `tests/unit/aad.test.mjs:73` | property |
| replay vs out-of-order; forged frame cannot spend a number | `tests/unit/aad.test.mjs:83`, `tests/unit/aad.test.mjs:96` | property |
| window bound 2048, stale refused | `tests/unit/aad.test.mjs:112` | property |
| chunk AAD bound to transfer and index | `tests/unit/aad.test.mjs:122` | property |
| v4 fingerprint, `sk = 0x01×32` | `tests/unit/identity-v4.test.mjs:44` | fixed vector (computed in-test from the layout) |
| key kind, fingerprint rules | `tests/unit/identity-v4.test.mjs:52`, `tests/unit/identity-v4.test.mjs:60` | property |
| relay proof with either key | `tests/unit/identity-v4.test.mjs:70` | property |
| `akSig` | `tests/unit/identity-v4.test.mjs:79` | property |
| continuation, each signature required, 90 days | `tests/unit/identity-v4.test.mjs:87`, `:94`, `:112` | property |
| app ↔ relay agreement (fp, kind, akSig, proof, continuation) | `tests/unit/identity.test.mjs:25`, `:32`, `:44`, `:52`, `:61` | cross-implementation |
| v4 seal purpose/account; RSA-3072 seal not taken as v4 | `tests/unit/identity.test.mjs:73`, `:87` | property |
| key usages (`sk` cannot agree, `ak` cannot sign) | `tests/unit/identity.test.mjs:95`; `tests/unit/key-separation.test.mjs:36`, `:41`, `:50`, `:58`, `:66` | property |
| signature purpose labels, seal purpose/account | `tests/unit/key-separation.test.mjs:75`, `:84` | property |
| RFC 6962/9162 tree hash, 8 leaves + empty | `tests/unit/kt.test.mjs:36` | **fixed vectors** (RFC 6962 roots) |
| inclusion / consistency, all sizes ≤ 40 | `tests/unit/kt.test.mjs:48`, `:63` | property |
| fork detected | `tests/unit/kt.test.mjs:75` | property |
| leaf encoding unambiguous | `tests/unit/kt.test.mjs:89` | property |
| app `kt.js` ↔ relay `key-log.js` identical | `tests/unit/kt.test.mjs:102`, `:126` | cross-implementation |
| ratchet v1 agreement, directions, per-message keys, FS | `tests/unit/ratchet.test.mjs:36`, `:45`, `:52`, `:61` | property |
| skipped keys, TTL/cap, too-far, AAD, JSON state | `tests/unit/ratchet.test.mjs:73`, `:86`, `:100`, `:106`, `:113` | property |
| v2 either side first, PCS, in-flight, forged header, PQ schedule, swapped key | `tests/unit/ratchet.test.mjs:147`, `:154`, `:181`, `:193`, `:203`, `:230` | property |
| Sender Keys: once for all, replay, out of order, impersonation, tamper, join, removal, distribution checks, JSON | `tests/unit/sender-keys.test.mjs:29`, `:38`, `:49`, `:61`, `:70`, `:81`, `:91`, `:102`, `:110` | property |
| SFrame header | `tests/unit/sframe.test.mjs:28` | **fixed vectors** (RFC 9605 C.1) |
| SFrame keys and frame, suite 0x0004 | `tests/unit/sframe.test.mjs:48` | **fixed vector** (RFC 9605, kid 291, ctr 17767) |
| SFrame tamper / wrong KID / metadata; replay window | `tests/unit/sframe.test.mjs:60`, `:69` | property |

No unit test with fixed vectors exists for: the hybrid handshake KDF
(`poorija-session-v3`), the prekey seals (`poorija-offline-v2/v3`), the v4
seal bytes, the ratchet KDFs (`poorija-ratchet/1`, `poorija-root/2`,
`poorija-rk/2`), the chunk KDF, Sender Keys, the transit seal, the SFU
capability. (`tests/e2e/*.mjs` cover several of these behaviourally; not
indexed here.)

---

## 6. Discrepancies found (prose vs code; the code is what §3 describes)

**docs/PROTOCOL.md**

1. "What is not done": "There is one key per connection, not one per message
   (no double ratchet)" (`docs/PROTOCOL.md:303-304`) — stale; ratchet v1/v2
   exist (§3.6) and the same file describes them (`docs/PROTOCOL.md:151-203`).
2. "Groups": "there is no shared group key to leak"
   (`docs/PROTOCOL.md:287-290`) — since Sender Keys a group chain key is shared
   with all members (§3.11). The per-member pairwise delivery still exists,
   but carries the shared-key ciphertext.
3. "Calls": "Group calls are a mesh of 1:1 connections"
   (`docs/PROTOCOL.md:281-282`) — calls of > 4 people may use the SFU with
   SFrame (§3.9); not described in PROTOCOL.md.
4. 2.8: "A sealed offline envelope no longer carries the session key"
   (`docs/PROTOCOL.md:172`) — true for the `body.sessionKeyRaw` field, but the
   identity-seal path still puts `sealToIdentity(peer, 'offline',
   raw(session.cryptoKey))` in `seal` whenever no prekey seal was made
   (`js/chat/29-file-transfer.js:940`, `js/chat/28-offline-envelopes.js:148-155`),
   and for a ratchet session `session.cryptoKey` is the ratchet seed
   (`js/chat/29-file-transfer.js:2501`). For a v1 ratchet the seed and `kid`
   derive every chain. In normal operation this path is unreachable for a
   ratchet session, because adopting a hybrid key sets `kexPinned = 3`, which
   forbids any seal but prekey v3 (`js/chat/29-file-transfer.js:921`,
   `js/chat/29-file-transfer.js:939`); the invariant is implicit and worth
   checking (e.g. when `findPeerBySession` returns no record).
5. The relay-proof oracle reference cites `30-file-transfer-2.js`
   (`docs/PROTOCOL.md:269`) — correct; but PROTOCOL.md does not say the relay
   still sends the RSA `cipher` challenge to RSA accounts and accepts its
   opened nonce (`scripts/server/25-identity-proof.js:72-95`,
   `scripts/server/26-wsserver.js:306-312`). The app never answers it.

**docs/design/1.2-identity-v4.md**

6. Fingerprint `SHA-256("poorija-id/4" ‖ key)` (§3.2) — code length-prefixes
   both: `u32 12 ‖ label ‖ u32 32 ‖ key` (PROTOCOL.md is correct).
7. Agreement-key label `agree-key/4` (§3.1) — code `poorija-agree/4`.
8. Seal: "HKDF(`poorija-seal-v4|<purpose>`, eph‖AK‖shared) … with the purpose
   and both fingerprints as AAD" (§3.1) — code: ikm = shared, salt = eph ‖ ak,
   info = `framed(["poorija-seal-v4", purpose])`, AAD =
   `framed(["poorija-seal-v4", purpose, recipientFp])` — the **sender's**
   fingerprint is not bound.
9. "`kex-offer/4` uses the X25519 seal" (§3.7) — the seal is X25519 for v4
   contacts but the signed label is still `kex-offer/3` /
   `kex-answer/3` (`js/chat/19-forward-secrecy.js:111`, `:117`).
10. Continuation `{ oldFp, newFp, sk, ak, at }` — the wire statement also has
    `oldKey`, which is not in the signed bytes (bound via `oldFp`).
11. Linked devices "receive the v4 keys in the existing encrypted device-sync
    bundle (still sealed to the RSA key)" — not verified for this document.

**docs/design/1.3-ratchet.md**

12. `RK, CK_A→B, CK_B→A = HKDF(handshake secret, "poorija-ratchet/1" ‖
    transcript)`, directions by sorted fingerprints (§2.1) — v1 has no RK;
    `CK_0 = HKDF(seed, 0^32, "poorija-ratchet/1|o|a…|kid")`, direction by
    handshake role.
13. Payload `{ n, pn }` (§2.1) — code `{ r, c, n }` (v1) and
    `{ r, c, n, d, q?, k? }` (v2); there is no `pn`.
14. "one ratchet per device pair" (§2.3) — ratchets are stored per contact
    fingerprint (`js/crypto/ratchet-bridge.js:59`, `:82-85`); PROTOCOL.md
    acknowledges the gap.
15. Chunk keys `HKDF(MK, "chunk" ‖ index)` — code
    `HKDF(TK, 0^32, "poorija-chunk/1|" ‖ index)`, with `TK` random (v2) or
    `MK_rn` (v1).
16. "Unit tests of ratchet.js against fixed vectors" (§4) — the unit tests
    are property tests only; no fixed ratchet vectors exist.

**docs/design/1.4-key-transparency.md**

17. Leaf `"poorija-kt/1" ‖ u8 type ‖ u32 len ‖ fp ‖ …` — code length-prefixes
    the tag too: `lp("poorija-kt/1")` (PROTOCOL.md is correct).
18. Head `"poorija-kt-head/1" ‖ relayId(32) ‖ …` — code
    `lp("poorija-kt-head/1") ‖ lp(relayId as 64 hex characters) ‖ …`.
19. Move body `oldFp ‖ newFp ‖ statement` — code `fp = oldFp`, body
    `[newFp, JSON.stringify(statement)]`; signatures are not in the leaf, and
    JSON is not a canonical encoding.
20. "A new head is signed when the log grows, at most once a minute" — the
    head is re-signed at once when the log grew (`headEveryMs = 0`); the
    once-a-minute limit applies to gossip (`scripts/lib/key-log.js:170-173`).
21. "the client … fetches its own home relay's `/kt/heads` … and compares" —
    no client code fetches `/kt/heads` (searched `js/`).
22. Unit tests "for every size up to 64" — the tests go to 40
    (`tests/unit/kt.test.mjs:48`, `:63`).
23. Storage `kt_leaves(idx, fp, type, leaf, at)` — code store `kt-leaf` keyed
    by zero-padded index (`scripts/lib/key-log.js:26-28`, `:213`).

**Code-level observations an auditor may want to weigh (not prose
mismatches)**

24. The relay P-256 identity key both signs KT heads (ECDSA) and receives
    transit seals (ECDH) — one key, two purposes.
25. Kex signatures do not cover `v`, `dr`, `rp`, `rq`; their stripping is
    stopped only by pins after a first observation (§3.3.6).
26. SFrame replay window was advanced before the tag was checked — **fixed
    2026-11-22**: `fresh()` before opening, `accept()` only after the frame
    authenticated (`js/crypto/sframe.js` `createReplayWindow`,
    `js/chat/68-sfu-call.js` `receiveSfuFrame`; tests in
    `tests/unit/sframe.test.mjs` and `tests/e2e/sfucall.mjs`). Still open: the `flags` (key-frame) byte and the
    SFU `slot` are unauthenticated; KIDs are 31 random bits with no
    collision handling across members (`keysByKid` keyed by KID only).
27. The AAD replay window is kept for at most 256 session ids
    (`js/crypto/aad-bridge.js:26`); an evicted sid's numbers are forgotten.
28. `kex-confirm` tag compared with `!==` on strings (not constant time),
    `js/chat/29-file-transfer.js:2937`.


## 7. Changes after this document was first written (2.15.0, 2026-11-22)

Each closes a finding of §6; see `docs/ROADMAP-4-5.md` §4 for the design.

* **F1 — key exchange binding 4 (cap `kx4`).** `kex-offer` and `kex-answer`
  carry `b: 4`; the signed text is
  `nl(["kex-offer/4", fromFp, toFp, kid, H(pub), H(pq), "v=" ‖ v, "dr=" ‖ dr, H(rp)|"", H(rq)|""])`
  and `nl(["kex-answer/4", fromFp, toFp, kid, H(pub'), H(pqct), offerDigest, "v=" ‖ v, "dr=" ‖ dr, H(rp)|"", H(rq)|""])`
  (`kexOfferSignBytes`, `kexAnswerSignBytes`, `js/chat/19-forward-secrecy.js`).
  Offered at 4 to a contact advertising `kx4` or pinned there; the contact
  record's `kexBinding` is raised to 4 on a completed binding-4 exchange and
  then a binding-3 offer or answer from that contact is refused. The KDF is
  unchanged (`poorija-session-v3|…`): what changed is what is authenticated.
  Test: `tests/e2e/kexbinding.mjs`.
* **F2 — key-log key.** A relay holds a second P-256 key (`keys.ktSign` in its
  identity file, grown on first start). Heads are `v: 2` with
  `ktKey` (SPKI base64) and `ktKeySig = ECDSA_identity("poorija-kt-key/1\n" ‖ relayId ‖ "\n" ‖ ktKey)`,
  and `sig = ECDSA_ktKey(headBytes)`; `headBytes` is as in §3.10. A verifier
  holding a v2 head of a relay refuses a v1 head of it (relay: `createPeerHeads`,
  app: `noteHead` → `unchecked`). The identity key then only agrees transit
  seals and proves the relay. Tests: `tests/unit/kt.test.mjs`, `tests/e2e/keytransparency.mjs`.
* **F3** — `sealSessionKeyFor` refuses itself for a session with a ratchet or a
  contact with `kexPinned ≥ 3` or `ratchetPinned ≥ 1` (`js/chat/28-offline-envelopes.js`).
* **F4 — SFU metadata v2 (cap `sfu2`).** When every member has `sfu2` the call
  invitation carries `sfu.aad = 2` and the SFrame metadata is
  `u8 kind ‖ u8 flags ‖ u16 slot` (big-endian, the sender's slot); otherwise
  `u8 kind`. A key message whose KID another member holds is refused and its
  sender sent `gcall-sfkey-clash`; a member whose own KID clashes re-keys.
  Capability lists are kept to 32 entries (were 8) by relay and app.
  Test: `tests/e2e/sfucall.mjs`.
* **F5** — AAD replay windows are kept for 8 days after last use (were: the 256
  most recent session ids). Test: `tests/e2e/replayaad.mjs`.
* **F6** — `kex-confirm` is checked with HMAC verify (`kexConfirmTagValid`).
* **SFrame replay window** (§6 item 26) — `fresh()` before decrypting,
  `accept()` after authentication (2.14.0).


## 8. Changes after §7 (2.16.0 – 2.20.0, 2026-11-23 – 2026-11-25)

Wire and behaviour that a second implementation, or a reader checking the code,
needs. Tests are named beside each.

* **Receipts kept for an absent person — `eph: 2`.** A sealed receipt
  (`inner: 'receipt'`) carries `eph: 2` and `notify: false`. The relay keeps it
  in the recipient's mailbox for 48 hours (`RECEIPT_KEEP_MS`) and no more than 300
  per mailbox, the oldest going first (`receiptSweep`, `scripts/server/14-guest-mail.js`);
  it wakes nobody. The item is marked `receipt: 1` on every path that files it,
  including the one taken for a connected socket that is not reading (2.20.0).
  `eph: 1` (typing) is still dropped. The client sends receipts `persist: true`
  with a tag, so the transit outbox sends them again. Tests: `receiptkeep`, `chatticks`.
* **Mail for a stranger — `route-query` (`chaseStrangerMail`).** Mail written
  here for somebody who does not live here is chased: this relay asks the family
  "do you hold their identity?", and only an answer of exactly one *home* is
  followed; the chase is budgeted per sweep and the table capped. Test: `strangermail`.
* **An acknowledgement is a promise that the message is kept (2.16.8).** The
  client sends `relay-ack` only when nothing it holds is unsaved
  (`mailIsDurable`, `js/chat/29-file-transfer.js`); a store written while the
  screen is locked is written through (`vaultCanWrite`, 17-file-manager.js). An
  acknowledgement waits otherwise and is released on unlock. Test: `offlinerecv`.
* **What a notification says — `notice-key` and `envelope.hint` (2.17.x, 2.20.0).**
  Two switches (`notifyShowSender`, `notifyShowPreview`), off by default.
  - A device with a switch on makes a 32-byte AES-GCM key per switch **per
    contact** and gives it to that contact in a `notice-key` message
    `{ v: 3, d: deviceId, s: b64|'', p: b64|'' }` (empty = withdrawn). It travels
    only inside the live session's payload (`kind: 'notice-key'`) or inside an
    envelope's sealed body (`requireSealed`); the receiver believes it only so
    (`session.viaSealedBody`). A contact keeps up to 4 devices' keys. A withdrawal
    that cannot be delivered is kept (`noticeGivenTo[fp] = 'REVOKE'`) and sent later.
  - A sender with keys adds `hint: { n, p }` to a waking envelope: `n` the sender's
    name `{ n, at }` padded to 128 bytes, `p` the kind and the first 140
    characters `{ k, t, at }` padded to 256/512/768, each `{ iv, c }` base64 under the
    matching key (one part, or a list of up to 4 for a contact with several
    devices). The relay keeps only a well-formed hint (`sanitizeNoticeHint`,
    `scripts/lib/push-wording.js`) and puts it in the push; it cannot open it.
  - The service worker (`sw.js`, `noticeFromHint`) reads `{ list: [{ s, p, name }],
    show }` from IndexedDB `poorija-notice`, tries each contact's pair, requires both
    halves to open under the same pair and `at` to be within 36 hours, and shows
    the name **this device saved** for that contact. No key, no switch or any
    failure gives the fixed line. A contact in a conversation that has a lock is
    given no key. Tests: `noticehints`, `unifiedpush`, `notificationprivacy`.
* **Keys not rotated, said plainly (§6).** The account's signing key `sk` and
  agreement key `ak` have no rotation policy: they change only by an identity move.
  A relay's identity key (the one that proves it and agrees transit seals) is the
  same until the operator replaces it; key transparency (§7 F2) makes a swap
  visible, it does not prevent one.


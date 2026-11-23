/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text.
 */

/* What is written to somebody who is away is not readable when the curve falls.
 *
 * A message for an offline device is sealed to that device's prekey, and the
 * prekey was a P-256 key. The relay keeps the sealed message until it is
 * collected — so of everything this app sends, this is what sits on somebody
 * else's disk, ready to be kept for the day P-256 can be broken. A live
 * session got a second, post-quantum secret first (tests/e2e/hybrid.mjs);
 * this is the same for the message that waits.
 *
 * A prekey now has an ML-KEM-768 half, signed with the rest, and a message is
 * sealed under a key derived from both. The checks are the same four that
 * matter for any hybrid, in this setting:
 *
 *   IT IS REALLY IN THE KEY   holding the prekey's P-256 private half alone
 *                             must not open what was sealed.
 *   IT CANNOT BE TAKEN OUT    a relay repeating the prekey without its
 *                             ML-KEM half must not make the sender forget it.
 *   IT CANNOT BE SWAPPED      a relay's own ML-KEM key in its place, with the
 *                             real signature or with one of its own, is not
 *                             taken up, and the relay cannot open the seal.
 *   OLD CONTACTS STILL WORK   one who publishes no ML-KEM half is sealed to
 *                             the way they always were.
 *
 *   node tests/e2e/prekeyhybrid.mjs      (brings up its own relay)
 */
import { openApp, identity, importIdentity, browser, waitFor } from './_chat-harness.mjs';
import { startTwoStacks } from './_two-stacks.mjs';

const results = [];
const check = (n, ok, d = '') => {
  results.push({ n, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + String(d).slice(0, 260) : ''}`);
};
const section = (title) => console.log(`\n===== ${title} =====`);
const decode = (card) => JSON.parse(Buffer.from(card.replace('poorija-chat-v1:', ''), 'base64').toString('utf8'));
const size = (b64) => (b64 ? Buffer.from(String(b64), 'base64').length : 0);

const held = (page, fp) => page.evaluate((key) => {
  const r = findPeerByAnyKey(key);
  return r ? { id: r.prekeyId || '', pub: r.prekeyPublic || '', pq: r.prekeyPq || '', pqSig: r.prekeyPqSig || '', sig: r.prekeySig || '' } : null;
}, fp);
/* SARA seals a fresh key for the contact, and says what she sealed it with. */
const seal = (page, fp) => page.evaluate(async (key) => {
  const record = findPeerByAnyKey(key);
  const secret = crypto.getRandomValues(new Uint8Array(32));
  const kex = await sealWithPrekey(record, secret.buffer);
  return { kex, secret: Array.from(secret) };
}, fp);

const stacks = await startTwoStacks();
try {
  const SARA = await openApp('SARA', { origin: stacks.a.url, relay: stacks.a.url });
  const OMID = await openApp('OMID', { origin: stacks.a.url, relay: stacks.a.url });
  const cards = { SARA: await identity(SARA), OMID: await identity(OMID) };
  const fp = { SARA: decode(cards.SARA).fingerprint, OMID: decode(cards.OMID).fingerprint };
  await importIdentity(SARA, cards.OMID);
  await importIdentity(OMID, cards.SARA);

  section('a prekey with two halves');
  const arrived = await waitFor(SARA, (key) => Boolean(findPeerByAnyKey(key)?.prekeyPq), { timeoutMs: 45000, arg: fp.OMID });
  const real = await held(SARA, fp.OMID);
  const own = await OMID.evaluate(() => {
    const p = (chatState.prekeys || []).slice(-1)[0] || {};
    const stored = (loadPrekeys().slice(-1)[0]) || {};
    return { id: p.id || '', pq: p.pqPublic || '', hasSecret: Boolean(stored.pqSecret), secretBytes: stored.pqSecret ? PoorijaApp.base64ToArrayBuffer(stored.pqSecret).byteLength : 0 };
  });
  console.log('  ' + JSON.stringify({ id: real?.id, pq: size(real?.pq), pqSig: size(real?.pqSig), secret: own.secretBytes }));
  check('OMID\'s prekey reaches SARA with an ML-KEM-768 half', Boolean(arrived) && size(real?.pq) === 1184 && real.pq === own.pq, `${size(real?.pq)} bytes`);
  /* 64 bytes for an Ed25519 signature (identity v4), 384 for RSA-3072. */
  check('signed, with the rest of the prekey, by OMID', size(real?.pqSig) >= 64, `${size(real?.pqSig)} bytes`);
  check('and OMID keeps its secret half, in the vault with the prekey', own.hasSecret && own.secretBytes === 2400, `${own.secretBytes} bytes`);

  section('sealed under both');
  const first = await seal(SARA, fp.OMID);
  check('SARA seals with both halves', first.kex?.v === 3 && first.kex.prekeyId === own.id && size(first.kex.pqct) === 1088,
    first.kex ? `v${first.kex.v}, ${size(first.kex.pqct)}-byte ciphertext` : 'nothing sealed');
  const opened = first.kex ? await OMID.evaluate(async ({ kex, secret }) => {
    const key = await openPrekeySeal(kex).catch(() => null);
    if (!key) return false;
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', key));
    return raw.length === secret.length && raw.every((b, i) => b === secret[i]);
  }, first) : false;
  check('and OMID opens it', opened === true);

  section('the second half is really in the key');
  /* Somebody who has, some day, the prekey's P-256 private half — the half a
     quantum computer gives them — and tries the seal with it alone, by the
     derivation the classical seal used and by this one without its second
     secret. */
  const curveOnly = first.kex ? await OMID.evaluate(async ({ kex }) => {
    const mine = findPrekey(kex.prekeyId);
    const privateKey = await importEcdhPrivate(mine.privateKeyData);
    const theirs = await importEcdhPublic(kex.kex);
    const tryWith = async (wrapKey) => {
      try { await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(kex.iv) }, wrapKey, PoorijaApp.base64ToArrayBuffer(kex.key)); return true; } catch (e) { return false; }
    };
    const classical = await deriveSharedAesKey(privateKey, theirs, 'poorija-offline-v2');
    const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: theirs }, privateKey, 256);
    const material = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
    const guesses = [];
    for (const info of ['poorija-offline-v3', `poorija-offline-v3|${kex.prekeyId}`]) {
      guesses.push(await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: new TextEncoder().encode(info) },
        material, { name: 'AES-GCM', length: 256 }, false, ['decrypt']));
    }
    return { classical: await tryWith(classical), guesses: await Promise.all(guesses.map(tryWith)) };
  }, first) : { classical: true, guesses: [true] };
  check('the P-256 private half alone does not open it', curveOnly.classical === false && curveOnly.guesses.every((g) => g === false), JSON.stringify(curveOnly));

  section('the relay repeats the prekey without its second half');
  await SARA.evaluate(async (key) => {
    const r = findPeerByAnyKey(key);
    mergePeerRecord({ peerId: r.peerId, clientId: r.clientId, username: r.username, publicKeyData: r.publicKeyData, fingerprint: r.fingerprint, status: 'online',
      prekeyId: r.prekeyId, prekeyPublic: r.prekeyPublic, prekeyExpiresAt: r.prekeyExpiresAt, prekeySig: r.prekeySig }, { online: true });
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }, fp.OMID);
  const afterStrip = await held(SARA, fp.OMID);
  const stripped = await seal(SARA, fp.OMID);
  check('SARA still holds it', afterStrip?.pq === real.pq && afterStrip.pqSig === real.pqSig);
  check('and still seals with both', stripped.kex?.v === 3, stripped.kex ? `v${stripped.kex.v}` : 'nothing sealed');

  section('the relay puts its own ML-KEM key in its place');
  for (const [how, what] of [['kept', 'under the real signature'], ['own', 'signed by a key that is not OMID\'s']]) {
    const relay = await SARA.evaluate(async ({ key, mode }) => {
      const r = findPeerByAnyKey(key);
      const theirs = PoorijaMlKem.keygen();
      const pq = PoorijaApp.arrayBufferToBase64(theirs.publicKey.buffer.slice(theirs.publicKey.byteOffset, theirs.publicKey.byteOffset + 1184));
      let pqSig = r.prekeyPqSig;
      if (mode === 'own') {
        const mine = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
        const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pq)))).map((b) => b.toString(16).padStart(2, '0')).join('');
        const bytes = new TextEncoder().encode(['prekey/2', r.fingerprint, r.prekeyId, r.prekeyPublic, r.prekeyExpiresAt, digest].join('\n'));
        pqSig = PoorijaApp.arrayBufferToBase64(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', mine.privateKey, bytes));
      }
      mergePeerRecord({ peerId: r.peerId, clientId: r.clientId, username: r.username, publicKeyData: r.publicKeyData, fingerprint: r.fingerprint, status: 'online',
        prekeyId: r.prekeyId, prekeyPublic: r.prekeyPublic, prekeyExpiresAt: r.prekeyExpiresAt, prekeySig: r.prekeySig, prekeyPq: pq, prekeyPqSig: pqSig }, { online: true });
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return { pq };
    }, { key: fp.OMID, mode: how });
    const now = await held(SARA, fp.OMID);
    const sealed = await seal(SARA, fp.OMID);
    check(`${what}: SARA does not take it up`, now?.pq === real.pq, now?.pq === relay.pq ? 'holds the relay\'s key' : 'holds OMID\'s');
    const stillOpens = sealed.kex ? await OMID.evaluate(async ({ kex, secret }) => {
      const key = await openPrekeySeal(kex).catch(() => null);
      if (!key) return false;
      const raw = new Uint8Array(await crypto.subtle.exportKey('raw', key));
      return raw.every((b, i) => b === secret[i]);
    }, sealed) : false;
    check(`${what}: what SARA seals is still sealed to OMID's`, sealed.kex?.v === 3 && stillOpens === true);
  }

  section('a contact with no second half');
  /* A build that publishes a P-256 prekey only, and has never been seen with
     more: sealed to as it always was, so the two still talk. */
  const classical = await SARA.evaluate(async (key) => {
    const r = findPeerByAnyKey(key);
    const kept = { prekeyPq: r.prekeyPq, prekeyPqSig: r.prekeyPqSig };
    r.prekeyPq = ''; r.prekeyPqSig = '';
    const kex = await sealWithPrekey(r, crypto.getRandomValues(new Uint8Array(32)).buffer);
    Object.assign(r, kept);
    return kex ? { v: kex.v, pqct: Boolean(kex.pqct) } : null;
  }, fp.OMID);
  check('is sealed to with the curve alone, as before', classical?.v === 2 && classical.pqct === false, JSON.stringify(classical));

  section('kept across a restart');
  const stored = await SARA.evaluate((key) => {
    saveContacts();
    const record = loadEncrypted(CHAT_CONTACTS_STORAGE_KEY, []).map((peer) => normalizePeerRecord(peer)).find((peer) => peer.fingerprint === key);
    return { pq: record?.prekeyPq || '', pqSig: record?.prekeyPqSig || '' };
  }, fp.OMID);
  check('SARA reads the second half back from storage', stored.pq === real.pq && stored.pqSig === real.pqSig);

  section('nothing threw');
  const errors = [...SARA.__errors, ...OMID.__errors];
  check('no script error on either side', errors.length === 0, errors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
  await stacks.stop();
}
const bad = results.filter((r) => !r.ok);
console.log(`\n===== ${bad.length} failed of ${results.length} =====`);
process.exit(bad.length ? 1 : 0);

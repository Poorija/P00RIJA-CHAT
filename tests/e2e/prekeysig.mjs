/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text.
 */

/* The relay cannot read what is written to somebody who is away.
 *
 * A message for a device that is offline is sealed to that device's prekey,
 * and the prekey reaches the sender by the relay. It used to travel bare, so
 * the relay could hand out one of its own: the sender sealed to it, the relay
 * opened the message, sealed it again to the real prekey and passed it on,
 * and neither end saw anything different. End-to-end encryption exists to
 * keep the relay out, and this let it in through the front door.
 *
 * A prekey is now signed by its owner's identity key, and a sender seals to
 * one only if that signature checks against the identity key it has pinned
 * for the contact. This suite plays the relay: it hands the sender prekeys
 * that are not the contact's, in each of the ways a relay could, and then
 * asks the one question that matters — when the sender seals, can whoever
 * supplied that prekey open the result?
 *
 *   node tests/e2e/prekeysig.mjs      (brings up its own relay)
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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* What the sender holds for a contact, as far as a prekey goes. */
const held = (page, fp) => page.evaluate((key) => {
  const record = findPeerByAnyKey(key);
  return record ? { id: record.prekeyId || '', pub: record.prekeyPublic || '', exp: record.prekeyExpiresAt || '', sig: record.prekeySig || '' } : null;
}, fp);

/* The relay's move: a presence record for the contact carrying a prekey the
   relay made, delivered the way presence is. `sign` says what, if anything,
   the relay puts where the signature goes. Returns the private half, which is
   what the relay would keep. */
const substitute = (page, fp, { sign = 'none', label = 'evil' } = {}) => page.evaluate(async ({ key, how, name }) => {
  const record = findPeerByAnyKey(key);
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const publicKey = PoorijaApp.arrayBufferToBase64(await crypto.subtle.exportKey('spki', pair.publicKey));
  const privateKey = PoorijaApp.arrayBufferToBase64(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  const forged = {
    peerId: record.peerId, clientId: record.clientId, username: record.username,
    publicKeyData: record.publicKeyData, fingerprint: record.fingerprint, status: 'online',
    prekeyId: `pk-${name}`,
    prekeyPublic: publicKey,
    /* Later than the real one's, which was made moments ago and so ends
       fifteen days from now: between two prekeys the later window wins, and
       a relay that wants its own to win only has to say so. */
    prekeyExpiresAt: new Date(Date.now() + 15.5 * 24 * 60 * 60 * 1000).toISOString(),
  };
  if (how === 'copied') forged.prekeySig = record.prekeySig || '';            /* the real prekey's signature, moved */
  if (how === 'own') {
    /* Properly signed — by a key the relay made, not by the contact's. */
    const mine = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
    const bytes = new TextEncoder().encode(['prekey/1', record.fingerprint, forged.prekeyId, forged.prekeyPublic, forged.prekeyExpiresAt].join('\n'));
    forged.prekeySig = PoorijaApp.arrayBufferToBase64(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', mine.privateKey, bytes));
  }
  mergePeerRecord(forged, { online: true });
  await new Promise((resolve) => setTimeout(resolve, 1500));
  return { id: forged.prekeyId, privateKey };
}, { key: fp, how: sign, name: label });

/* The sender seals a key for the contact; then the relay tries to open it with
   the private half of the prekey it supplied. */
const sealAndPry = (page, fp, relayPrivate) => page.evaluate(async ({ key, pry }) => {
  const record = findPeerByAnyKey(key);
  const secret = crypto.getRandomValues(new Uint8Array(32));
  const kex = await sealWithPrekey(record, secret.buffer);
  if (!kex) return { sealedTo: '', opened: false };
  let opened = false;
  try {
    const privateKey = await crypto.subtle.importKey('pkcs8', PoorijaApp.base64ToArrayBuffer(pry), { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    const ephemeral = await crypto.subtle.importKey('spki', PoorijaApp.base64ToArrayBuffer(kex.kex), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: ephemeral }, privateKey, 256);
    const material = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
    const wrapKey = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: new TextEncoder().encode('poorija-offline-v2') },
      material, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    const raw = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(kex.iv) }, wrapKey, PoorijaApp.base64ToArrayBuffer(kex.key)));
    opened = raw.length === secret.length && raw.every((byte, index) => byte === secret[index]);
  } catch (error) { opened = false; }
  return { sealedTo: kex.prekeyId, opened };
}, { key: fp, pry: relayPrivate });

const stacks = await startTwoStacks();
try {
  const SARA = await openApp('SARA', { origin: stacks.a.url, relay: stacks.a.url });
  const OMID = await openApp('OMID', { origin: stacks.a.url, relay: stacks.a.url });
  const cards = { SARA: await identity(SARA), OMID: await identity(OMID) };
  const fp = { SARA: decode(cards.SARA).fingerprint, OMID: decode(cards.OMID).fingerprint };
  await importIdentity(SARA, cards.OMID);
  await importIdentity(OMID, cards.SARA);
  /* A live session between them, for the last section. */
  await SARA.evaluate(async (key) => {
    const peer = findPeerByAnyKey(key);
    chatState.activeConversationId = getConversationKey(peer);
    chatState.activePeerClientId = peer.clientId || '';
    renderPeers(); renderActivePeer(); renderMessages();
    await new Promise((r) => setTimeout(r, 400));
    const box = document.getElementById('chatComposer');
    box.value = `hello-${Date.now()}`;
    box.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('chatSendMessageBtn').click();
  }, fp.OMID);
  await waitFor(OMID, (key) => {
    const peer = findPeerByAnyKey(key);
    const session = peer && chatState.sessions.get(peer.peerId);
    return Boolean(session?.cryptoKey && session.connection?.open);
  }, { timeoutMs: 60000, arg: fp.SARA });

  section('an honest relay');
  const arrived = await waitFor(SARA, (key) => Boolean(findPeerByAnyKey(key)?.prekeyPublic), { timeoutMs: 45000, arg: fp.OMID });
  const real = await held(SARA, fp.OMID);
  const omidsOwn = await OMID.evaluate(() => { const p = (chatState.prekeys || []).slice(-1)[0] || {}; return { id: p.id || '', pub: p.publicKeyData || '' }; });
  console.log('  ' + JSON.stringify({ id: real?.id, signed: Boolean(real?.sig), own: omidsOwn.id }));
  check('OMID\'s prekey reaches SARA', Boolean(arrived) && real?.id === omidsOwn.id && real.pub === omidsOwn.pub, `${real?.id} / ${omidsOwn.id}`);
  check('with OMID\'s signature on it, carried by the relay', Boolean(real?.sig) && real.sig.length >= 86, `${(real?.sig || '').length} characters`);
  const honest = await SARA.evaluate(async (key) => {
    const record = findPeerByAnyKey(key);
    const secret = crypto.getRandomValues(new Uint8Array(32));
    const kex = await sealWithPrekey(record, secret.buffer);
    return { kex, secret: Array.from(secret) };
  }, fp.OMID);
  const openedByOmid = honest.kex ? await OMID.evaluate(async ({ kex, secret }) => {
    const key = await openPrekeySeal(kex);
    if (!key) return false;
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', key));
    return raw.every((byte, index) => byte === secret[index]);
  }, honest) : false;
  check('SARA seals to it, and OMID opens what she sealed', Boolean(honest.kex) && honest.kex.prekeyId === omidsOwn.id && openedByOmid === true, honest.kex ? honest.kex.prekeyId : 'not sealed');

  section('the relay hands out a prekey of its own');
  for (const [how, what] of [
    ['none', 'with no signature'],
    ['copied', 'with the signature lifted off the real one'],
    ['own', 'properly signed, by a key that is not OMID\'s'],
  ]) {
    const relay = await substitute(SARA, fp.OMID, { sign: how, label: how });
    const now = await held(SARA, fp.OMID);
    const outcome = await sealAndPry(SARA, fp.OMID, relay.privateKey);
    check(`${what}: SARA does not take it up`, now?.id === real.id && now.pub === real.pub, `holds ${now?.id}`);
    check(`${what}: what SARA seals, the relay cannot open`, outcome.opened === false && outcome.sealedTo !== relay.id, `sealed to ${outcome.sealedTo || '(the identity key instead)'}`);
  }

  section('a contact with no signed prekey at all');
  /* A build that does not sign its prekey, or a relay that strips the
     signature: there is nothing to check, so there is nothing to seal to. */
  const bare = await SARA.evaluate(async (key) => {
    const record = findPeerByAnyKey(key);
    const kept = { id: record.prekeyId, pub: record.prekeyPublic, exp: record.prekeyExpiresAt, sig: record.prekeySig };
    record.prekeySig = '';
    const kex = await sealWithPrekey(record, crypto.getRandomValues(new Uint8Array(32)).buffer);
    Object.assign(record, { prekeyId: kept.id, prekeyPublic: kept.pub, prekeyExpiresAt: kept.exp, prekeySig: kept.sig });
    return Boolean(kex);
  }, fp.OMID);
  check('nothing is sealed to an unsigned prekey (the identity-key seal is used instead)', bare === false);

  section('a relay that does not carry signatures');
  /* An older relay drops the field. A live session says the prekey again,
     signed, to the person themselves. */
  await SARA.evaluate((key) => {
    const record = findPeerByAnyKey(key);
    Object.assign(record, { prekeyId: '', prekeyPublic: '', prekeyExpiresAt: '', prekeySig: '' });
  }, fp.OMID);
  const said = await OMID.evaluate((key) => {
    const peer = findPeerByAnyKey(key);
    const session = peer && chatState.sessions.get(peer.peerId);
    if (!session?.connection?.open || typeof announcePrekey !== 'function') return false;
    announcePrekey(session);
    return true;
  }, fp.SARA);
  const relearned = said ? await waitFor(SARA, (key) => Boolean(findPeerByAnyKey(key)?.prekeySig), { timeoutMs: 20000, arg: fp.OMID }) : false;
  const again = await held(SARA, fp.OMID);
  check('OMID says it down the live session, and SARA has it again', Boolean(said) && Boolean(relearned) && again?.id === omidsOwn.id && again.pub === omidsOwn.pub, said ? `${again?.id}` : 'no live session');

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

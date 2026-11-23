/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text. Section 13 matters here: run a modified
 * version as a network service and its users are entitled to your source.
 */

/* The door between js/crypto/sender-keys.js and the chat's classic scripts
 * (roadmap 3.1, release 2.12).
 *
 *   PoorijaSenderKeys.sealForGroup(groupId, senderFp, memberFps, plainBytes)
 *     -> { wire, distribution, rotated }
 *   PoorijaSenderKeys.openFromGroup(groupId, senderFp, wire, distribution)
 *     -> plainBytes
 *
 * This device's own chain for a group is renewed whenever somebody it was
 * handed to is no longer a member: from then on nothing sent opens with what
 * they hold. The distribution (the chain where it stands, and the public
 * signing key) rides with every group message inside the pairwise ratchet, so
 * a member who missed one still has it with the next; a receiver takes a
 * distribution only for a chain it does not know yet, so a later copy never
 * winds back a chain or drops the keys it kept for messages still in flight.
 * The sender's fingerprint is the one the pairwise session authenticated, not
 * anything the payload says. */

import * as sk from './sender-keys.js';

const STORE_KEY = 'poorija_chat_sender_keys';
const KEEP_OLD_CHAINS = 3;
const subtle = () => globalThis.crypto.subtle;
const random = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));

let store = null;
let saveTimer = null;
function all() {
  if (store) return store;
  const loaded = typeof globalThis.loadEncrypted === 'function' ? globalThis.loadEncrypted(STORE_KEY, null) : null;
  const unlocked = typeof globalThis.isUnlocked !== 'function' || globalThis.isUnlocked();
  const value = loaded && typeof loaded === 'object' ? loaded : {};
  value.own = value.own && typeof value.own === 'object' ? value.own : {};
  value.recv = value.recv && typeof value.recv === 'object' ? value.recv : {};
  if (unlocked) store = value;
  return value;
}
function flush() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  if (typeof globalThis.saveEncrypted === 'function') globalThis.saveEncrypted(STORE_KEY, all());
}
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(flush, 200);
}
globalThis.addEventListener?.('poorija:lock', () => { if (saveTimer && store) flush(); store = null; });
globalThis.addEventListener?.('poorija:unlock', () => { store = null; });

/* This device's chain for the group, renewed when the membership it was
   handed to has lost anyone. `members` are the other members' fingerprints. */
async function ownChain(groupId, senderFp, members) {
  const now = new Set(members.filter(Boolean));
  let chain = all().own[groupId];
  let rotated = false;
  const lostSomeone = chain && (chain.members || []).some((fp) => !now.has(fp));
  if (!chain || chain.senderFp !== senderFp || lostSomeone) {
    chain = await sk.createSendingChain(subtle(), random, { groupId, senderFp });
    rotated = Boolean(all().own[groupId]);
    chain.members = [];
  }
  chain.members = Array.from(new Set([...(chain.members || []), ...now]));
  all().own[groupId] = chain;
  return { chain, rotated };
}

async function sealForGroup(groupId, senderFp, members, plainBytes, { kind = 'space-message' } = {}) {
  const { chain, rotated } = await ownChain(groupId, senderFp, members);
  const distribution = sk.distribution(chain);
  const wire = await sk.seal(subtle(), random, chain, plainBytes, { kind });
  save();
  return { wire, distribution, rotated, keyId: chain.keyId };
}

const recvKey = (groupId, senderFp) => `${groupId}|${senderFp}`;
async function openFromGroup(groupId, senderFp, wire, distribution, { kind = 'space-message' } = {}) {
  const slot = all().recv[recvKey(groupId, senderFp)] || { chains: {}, order: [] };
  if (distribution && distribution.keyId && !slot.chains[distribution.keyId]) {
    const chain = await sk.acceptDistribution(subtle(), distribution, { groupId, senderFp });
    slot.chains[chain.keyId] = chain;
    slot.order = [...(slot.order || []).filter((id) => id !== chain.keyId), chain.keyId];
    while (slot.order.length > KEEP_OLD_CHAINS) delete slot.chains[slot.order.shift()];
  }
  const chain = slot.chains[wire?.g];
  if (!chain) throw new sk.SenderKeyError('unknown-chain', String(wire?.g || ''));
  const { plain, chain: next } = await sk.open(subtle(), chain, wire, { kind });
  slot.chains[wire.g] = next;
  all().recv[recvKey(groupId, senderFp)] = slot;
  save();
  return plain;
}

/* Leaving a group, or the group gone: nothing of it is kept. */
function forgetGroup(groupId) {
  delete all().own[groupId];
  for (const key of Object.keys(all().recv)) if (key.startsWith(`${groupId}|`)) delete all().recv[key];
  save();
}

globalThis.PoorijaSenderKeys = Object.freeze({
  sealForGroup,
  openFromGroup,
  forgetGroup,
  flush,
  ownKeyId: (groupId) => all().own[groupId]?.keyId || '',
  SenderKeyError: sk.SenderKeyError,
});

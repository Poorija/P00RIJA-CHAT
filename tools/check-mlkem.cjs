#!/usr/bin/env node
/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text.
 */

/* Is vendor/mlkem/mlkem.bundle.min.js really ML-KEM-768?
 *
 * The page cannot use the platform's ML-KEM yet, so it carries one in a
 * script. A key-encapsulation that is subtly not the standard would still
 * agree with itself — two copies of the same wrong code derive the same wrong
 * secret — so testing it against itself proves nothing.
 *
 * Node has its own, from OpenSSL, written by other people in another
 * language. This checks the bundle against that one, in the three ways two
 * implementations of FIPS 203 must agree:
 *
 *   1. the same seed gives the same public key (key generation is
 *      deterministic in the standard, so this is a known-answer test with
 *      OpenSSL supplying the answers);
 *   2. what the bundle encapsulates, OpenSSL decapsulates to the same secret;
 *   3. what OpenSSL encapsulates, the bundle decapsulates to the same secret.
 *
 * And two things about the bundle alone: the sizes are the standard's, and a
 * ciphertext that has been tampered with gives a secret that matches nothing
 * (implicit rejection) instead of the right one or an error.
 *
 *   node tools/check-mlkem.cjs
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROUNDS = 40;
const bundle = path.resolve(__dirname, '..', 'vendor', 'mlkem', 'mlkem.bundle.min.js');
vm.runInThisContext(fs.readFileSync(bundle, 'utf8'), { filename: bundle });
const kem = globalThis.PoorijaMlKem;

const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures.push(name);
};
const same = (a, b) => a.length === b.length && Buffer.from(a).equals(Buffer.from(b));

if (!kem) { console.error('The bundle did not publish PoorijaMlKem.'); process.exit(1); }
if (typeof crypto.encapsulate !== 'function') {
  console.error(`This Node (${process.version}) has no ML-KEM to check against; nothing was verified.`);
  process.exit(2);
}

/* OpenSSL's own keys, to learn the wrappers it puts a raw key in. */
const reference = crypto.generateKeyPairSync('ml-kem-768');
const spki = reference.publicKey.export({ format: 'der', type: 'spki' });
const spkiHeader = spki.subarray(0, spki.length - 1184);
const toNodePublic = (raw) => crypto.createPublicKey({ key: Buffer.concat([spkiHeader, Buffer.from(raw)]), format: 'der', type: 'spki' });
const rawOf = (publicKey) => { const der = publicKey.export({ format: 'der', type: 'spki' }); return der.subarray(der.length - 1184); };
/* A private key as its 64-byte seed (RFC 9935's seed-only form). */
const seedHeader = Buffer.from('3054020100300b0609608648016503040402044280' + '40', 'hex');
const fromSeed = (seed) => crypto.createPrivateKey({ key: Buffer.concat([seedHeader, Buffer.from(seed)]), format: 'der', type: 'pkcs8' });

console.log(`\n  ML-KEM-768 in the bundle against OpenSSL ${process.versions.openssl} (Node ${process.version}), ${ROUNDS} rounds each\n`);

const first = kem.keygen();
const firstSealed = kem.encapsulate(first.publicKey);
check('the sizes are the standard\'s',
  first.publicKey.length === 1184 && first.secretKey.length === 2400 && firstSealed.cipherText.length === 1088 && firstSealed.sharedSecret.length === 32,
  `${first.publicKey.length} / ${first.secretKey.length} / ${firstSealed.cipherText.length} / ${firstSealed.sharedSecret.length}`);

let seedsAgree = 0; let seedsTried = 0; let seedError = '';
for (let i = 0; i < ROUNDS; i += 1) {
  const seed = crypto.randomBytes(64);
  try {
    const theirs = rawOf(crypto.createPublicKey(fromSeed(seed)));
    seedsTried += 1;
    if (same(kem.keygen(seed).publicKey, theirs)) seedsAgree += 1;
  } catch (error) { seedError = String(error.message || error).slice(0, 90); break; }
}
check('the same seed gives the same public key as OpenSSL', seedsTried === ROUNDS && seedsAgree === ROUNDS,
  seedError ? `OpenSSL would not take a seed here: ${seedError}` : `${seedsAgree} of ${seedsTried}`);

let ours = 0;
for (let i = 0; i < ROUNDS; i += 1) {
  const pair = kem.keygen();
  const { sharedKey, ciphertext } = crypto.encapsulate(toNodePublic(pair.publicKey));
  if (same(kem.decapsulate(new Uint8Array(ciphertext), pair.secretKey), sharedKey)) ours += 1;
}
check('what OpenSSL encapsulates, the bundle opens to the same secret', ours === ROUNDS, `${ours} of ${ROUNDS}`);

let theirs = 0;
for (let i = 0; i < ROUNDS; i += 1) {
  const pair = crypto.generateKeyPairSync('ml-kem-768');
  const sealed = kem.encapsulate(new Uint8Array(rawOf(pair.publicKey)));
  const secret = crypto.decapsulate(pair.privateKey, Buffer.from(sealed.cipherText));
  if (same(secret, sealed.sharedSecret)) theirs += 1;
}
check('what the bundle encapsulates, OpenSSL opens to the same secret', theirs === ROUNDS, `${theirs} of ${ROUNDS}`);

let rejected = 0;
for (let i = 0; i < ROUNDS; i += 1) {
  const pair = kem.keygen();
  const sealed = kem.encapsulate(pair.publicKey);
  const bent = Uint8Array.from(sealed.cipherText);
  bent[crypto.randomInt(bent.length)] ^= 1 << crypto.randomInt(8);
  let secret = null;
  try { secret = kem.decapsulate(bent, pair.secretKey); } catch (error) { secret = null; }
  if (secret && secret.length === 32 && !same(secret, sealed.sharedSecret)) rejected += 1;
}
check('a ciphertext with one bit changed opens to a secret that matches nothing', rejected === ROUNDS, `${rejected} of ${ROUNDS}`);

console.log(`\n  ${failures.length} failed\n`);
process.exit(failures.length ? 1 : 0);

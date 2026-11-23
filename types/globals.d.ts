/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text.
 */

/* What the ES modules in js/crypto/ reach on globalThis: the chat's encrypted
   store (js/chat/17-file-manager.js), its lock state, and the vendored
   ML-KEM-768 (vendor/mlkem). Declared for the type check (roadmap 2.2); the
   modules check that each is there before they use it. */
export {};

interface PoorijaMlKemApi {
  keygen(): { publicKey: Uint8Array; secretKey: Uint8Array };
  encapsulate(publicKey: Uint8Array): { cipherText: Uint8Array; sharedSecret: Uint8Array };
  decapsulate(cipherText: Uint8Array, secretKey: Uint8Array): Uint8Array;
}

declare global {
  var loadEncrypted: ((key: string, fallback: unknown) => any) | undefined;
  var saveEncrypted: ((key: string, value: unknown) => void) | undefined;
  var isUnlocked: (() => boolean) | undefined;
  var PoorijaMlKem: PoorijaMlKemApi | undefined;
  var PoorijaSessionAad: unknown;
  var PoorijaIdentity: unknown;
  var PoorijaRatchet: unknown;
  var PoorijaKeyLog: unknown;
  var PoorijaSenderKeys: unknown;
  var PoorijaSFrame: unknown;
}

/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text. Section 13 matters here: run a modified
 * version as a network service and its users are entitled to your source.
 */

/* The door between js/crypto/sframe.js (RFC 9605) and the group-call SFU
   client, js/chat/68-sfu-call.js (roadmap 3.2). */
import * as sf from './sframe.js';

const subtle = () => globalThis.crypto.subtle;
globalThis.PoorijaSFrame = Object.freeze({
  deriveKeys: (baseKey, kid) => sf.deriveKeys(subtle(), baseKey, kid),
  encryptFrame: (keys, ctr, frame, metadata) => sf.encryptFrame(subtle(), keys, ctr, frame, metadata),
  decryptFrame: (keysFor, bytes, metadata) => sf.decryptFrame(subtle(), keysFor, bytes, metadata),
  decodeHeader: sf.decodeHeader,
  encodeHeader: sf.encodeHeader,
  createReplayWindow: sf.createReplayWindow,
});

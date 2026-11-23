/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text. Section 13 matters here: run a modified
 * version as a network service and its users are entitled to your source.
 */

/* The relay's source as one text (roadmap 2.3): since 2.11 it is in parts
   under scripts/server/, joined in the order scripts/server/ORDER gives, which
   is exactly what scripts/server-main.js compiles. Suites that read the
   relay's source to check something is (or is not) in it read this. */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
export function relaySource() {
  return require('../../scripts/server-main.js').joinParts().code;
}

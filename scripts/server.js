/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text. Section 13 matters here: run a modified
 * version as a network service and its users are entitled to your source.
 */

'use strict';

/* The relay. Since 2.11 it lives in parts under scripts/server/ (in the order
   scripts/server/ORDER gives), joined and run as this one module by
   scripts/server-main.js; see that file for why it is one scope. Everything
   that started `node scripts/server.js` still does. */
require('./server-main.js').run(__filename);

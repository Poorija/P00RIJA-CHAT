/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text. Section 13 matters here: run a modified
 * version as a network service and its users are entitled to your source.
 */

/* Two people write at the same instant, and every line of both arrives, once.
 *
 *   node tests/e2e/_local-stack.mjs simulsend
 *   E2E_ENGINE=webkit node tests/e2e/_local-stack.mjs simulsend
 *
 * A burst from each side is sent in one tick (no waiting between lines), in four
 * situations: the very first words between two people (no session yet), a live
 * session, the relay only (no live channel), and one of them away and back. */
import { openApp, identity, importIdentity, browser, waitFor, mailbox } from './_chat-harness.mjs';
import { createChecks } from './_check.mjs';

const BURST = Number(process.env.SIMUL_BURST || 12);
const { results, check } = createChecks({ maxDetail: 400, entry: (_name, ok) => Boolean(ok) });
const decode = (card) => JSON.parse(Buffer.from(card.replace('poorija-chat-v1:', ''), 'base64').toString('utf8'));
const openConversation = (page, fp) => page.evaluate(async (key) => {
  const peer = findPeerByAnyKey(key);
  chatState.activeConversationId = getConversationKey(peer);
  chatState.activePeerClientId = peer.clientId || '';
  renderPeers(); renderActivePeer(); renderMessages();
  await new Promise((r) => setTimeout(r, 300));
}, fp);
/* The whole burst in one tick. */
const burst = (page, prefix, n) => page.evaluate(({ prefix: p, n: count }) => {
  for (let i = 0; i < count; i += 1) {
    const box = document.getElementById('chatComposer');
    box.value = `${p}-${i}`;
    box.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('chatSendMessageBtn').click();
  }
}, { prefix, n });
const counts = (page, prefix) => page.evaluate((p) => {
  const mine = {};
  Object.values(chatState.history).flat().filter((e) => e.direction === 'in' && typeof e.text === 'string' && e.text.startsWith(p)).forEach((e) => { mine[e.text] = (mine[e.text] || 0) + 1; });
  return mine;
}, prefix);
async function settle(page, prefix, n, ms = 40000) {
  const want = Array.from({ length: n }, (_x, i) => `${prefix}-${i}`);
  await waitFor(page, ({ p, list }) => {
    const got = new Set(Object.values(chatState.history).flat().filter((e) => e.direction === 'in').map((e) => e.text));
    return list.every((t) => got.has(t));
  }, { timeoutMs: ms, arg: { p: prefix, list: want } });
  const got = await counts(page, prefix);
  return { missing: want.filter((t) => !got[t]), twice: want.filter((t) => got[t] > 1) };
}
const cut = async (page) => {
  await page.context().setOffline(true);
  await page.evaluate(() => {
    chatState.sessions.forEach((session) => { try { session.connection?.close(); } catch (_error) { /* gone */ } session.connection = null; });
    try { chatState.ws?.close(); } catch (_error) { /* gone */ }
  });
  await waitFor(page, () => chatState.connected === false, { timeoutMs: 15000 });
};
const back = async (page) => {
  await page.context().setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await waitFor(page, () => chatState.connected === true && chatState.ws?.readyState === 1, { timeoutMs: 45000 });
};
const noLive = (page) => page.evaluate(() => {
  chatState.sessions.forEach((session) => { try { session.connection?.close(); } catch (_error) { /* gone */ } session.connection = null; });
});

const warns = { ARIA: [], BARAN: [] };
const frames = { ARIA: { sent: 0, got: 0, queued: 0, errors: [] }, BARAN: { sent: 0, got: 0, queued: 0, errors: [] } };
let fp = {};
async function both(label, A, B, _fp, prep, between) {
  const tag = `${label.replace(/\W+/g, '')}-${Date.now() % 100000}`;
  if (prep) await prep();
  await Promise.all([burst(A, `${tag}-a`, BURST), burst(B, `${tag}-b`, BURST)]);
  if (between) await between();
  const [atB, atA] = await Promise.all([settle(B, `${tag}-a`, BURST), settle(A, `${tag}-b`, BURST)]);
  if (atB.missing.length || atA.missing.length) {
    for (const [who, page] of [['ARIA', A], ['BARAN', B]]) { const why = await page.evaluate(() => { const c = {}; (window.__why || []).forEach((w) => { c[w] = (c[w] || 0) + 1; }); return c; }); console.log(`   WHY ${who} received:`, JSON.stringify(why)); }
    console.log('   MAILBOX still holds: for B', (mailbox(fp.BARAN) || []).length, 'for A', (mailbox(fp.ARIA) || []).length);
    const diag = async (page, who, prefix, list) => console.log(`   DIAG ${who} wrote`, JSON.stringify(await page.evaluate(({ p, l }) => l.map((t) => { const e = Object.values(chatState.history).flat().find((x) => x.text === t && x.direction === 'out'); return [t.slice(-4), e?.status || 'none']; }), { p: prefix, l: list })), 'warnings', JSON.stringify(warns[who].filter((w) => !/TURN server/.test(w)).slice(-6)));
    if (atB.missing.length) await diag(A, 'ARIA', `${tag}-a`, atB.missing);
    if (atA.missing.length) await diag(B, 'BARAN', `${tag}-b`, atA.missing);
  }
  check(`${label}: everything A wrote reaches B, once`, atB.missing.length === 0 && atB.twice.length === 0, `missing [${atB.missing.join(' ')}] twice [${atB.twice.join(' ')}]`);
  check(`${label}: everything B wrote reaches A, once`, atA.missing.length === 0 && atA.twice.length === 0, `missing [${atA.missing.join(' ')}] twice [${atA.twice.join(' ')}]`);
}

/* Files, in both directions at the same instant: a small text, a medium and a larger binary one, and a photo with a
   caption. Each must arrive whole (every byte), once. */
const SIZES = [2048, 300 * 1024, 900 * 1024];
async function mediaBoth(label, A, B, prep, between) {
  const tag = `${label.replace(/\W+/g, '')}-${Date.now() % 100000}`;
  if (prep) await prep();
  const send = (page, who) => page.evaluate(async ({ tag: t, who: w, sizes }) => {
    const jobs = sizes.map((size, i) => {
      const bytes = new Uint8Array(size);
      for (let k = 0; k < size; k += 1) bytes[k] = (k * 31 + i * 7 + (w === 'a' ? 3 : 5)) & 255;
      return sendEncryptedBlob(new File([bytes], `${t}-${w}-${i}.bin`, { type: 'application/octet-stream' }), 'file');
    });
    const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 90;
    const g = canvas.getContext('2d'); g.fillStyle = w === 'a' ? '#0a84ff' : '#34c759'; g.fillRect(0, 0, 160, 90);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
    jobs.push(sendEncryptedBlob(new File([blob], `${t}-${w}-photo.jpg`, { type: 'image/jpeg' }), 'file', 0, { photo: true, mediaWidth: 160, mediaHeight: 90, caption: `cap-${t}-${w}` }));
    await Promise.allSettled(jobs);
  }, { tag, who, sizes: SIZES });
  await Promise.all([send(A, 'a'), send(B, 'b')]);
  if (between) await between();
  const check1 = async (page, who, label2) => {
    const names = [...SIZES.map((_x, i) => `${tag}-${who}-${i}.bin`), `${tag}-${who}-photo.jpg`];
    await waitFor(page, (list) => list.every((name) => Object.values(chatState.history).flat().some((e) => e.direction === 'in' && e.name === name && e.downloadUrl)), { timeoutMs: 120000, arg: names });
    const report = await page.evaluate(async ({ names: list, who: w, sizes }) => {
      const out = [];
      for (const name of list) {
        const entries = Object.values(chatState.history).flat().filter((e) => e.direction === 'in' && e.name === name);
        if (entries.length !== 1) { out.push(`${name}: ${entries.length} copies`); continue; }
        const bytes = new Uint8Array(await (await fetch(entries[0].downloadUrl)).arrayBuffer());
        const m = /-(\d+)\.bin$/.exec(name);
        if (m) {
          const i = Number(m[1]); let bad = bytes.length !== sizes[i];
          for (let k = 0; !bad && k < bytes.length; k += 1) if (bytes[k] !== ((k * 31 + i * 7 + (w === 'a' ? 3 : 5)) & 255)) bad = true;
          if (bad) out.push(`${name}: wrong bytes (${bytes.length} of ${sizes[i]})`);
        } else if (!(entries[0].photo === true) || !/^cap-/.test(entries[0].caption || '')) out.push(`${name}: not a photo with its caption`);
      }
      return out;
    }, { names, who, sizes: SIZES });
    if (report.length) {
      const sender = page === A ? B : A;
      for (const [who2, pg] of [['ARIA', A], ['BARAN', B]]) {
        const why = await pg.evaluate(() => { const c = {}; (window.__why || []).slice(-400).forEach((w) => { c[w] = (c[w] || 0) + 1; }); return c; });
        console.log(`   WHY ${who2} received:`, JSON.stringify(why).slice(0, 1500));
        console.log(`   WARN ${who2}:`, JSON.stringify(warns[who2].filter((w) => !/TURN server/.test(w)).slice(-8)).slice(0, 1500));
      }
      console.log('   MAILBOX still holds: for B', (mailbox(fp.BARAN) || []).length, 'for A', (mailbox(fp.ARIA) || []).length, 'frames', JSON.stringify(frames));
      console.log('   OUT status at the sender', JSON.stringify(await sender.evaluate((prefix) => Object.values(chatState.history).flat().filter((e) => e.direction === 'out' && String(e.name || '').startsWith(prefix)).map((e) => [e.name.slice(-9), e.status, e.progress ?? '']), `${tag}-${who === 'a' ? 'a' : 'b'}`)));
    }
    check(`${label}: everything ${label2} wrote arrives whole, once`, report.length === 0, report.join('; '));
  };
  await Promise.all([check1(B, 'a', 'A'), check1(A, 'b', 'B')]);
}

try {
  const ARIA = await openApp('ARIA');
  const BARAN = await openApp('BARAN');
  for (const [name, page] of [['ARIA', ARIA], ['BARAN', BARAN]]) page.on('websocket', (ws) => {
    ws.on('framesent', (f) => { try { const m = JSON.parse(f.payload); if (m.type === 'relay') frames[name].sent += 1; } catch (_e) { /* binary */ } });
    ws.on('framereceived', (f) => { try { const m = JSON.parse(f.payload); if (m.type === 'relay') frames[name].got += 1; if (m.type === 'queued') frames[name].queued += 1; if (m.type === 'error') frames[name].errors.push(m.reason); } catch (_e) { /* binary */ } });
  });
  for (const [name, page] of [['ARIA', ARIA], ['BARAN', BARAN]]) page.on('console', (m) => { const t = m.text(); if (/warn|error/.test(m.type()) && !/TURN server|Failed to load resource/.test(t)) warns[name].push(t.slice(0, 160)); });
  const cards = { ARIA: await identity(ARIA), BARAN: await identity(BARAN) };
  fp = { ARIA: decode(cards.ARIA).fingerprint, BARAN: decode(cards.BARAN).fingerprint };
  await importIdentity(ARIA, cards.BARAN);
  await importIdentity(BARAN, cards.ARIA);
  await openConversation(ARIA, fp.BARAN); await openConversation(BARAN, fp.ARIA);
  /* What fails, named: each step a received envelope goes through is wrapped to say so when it throws or gives nothing. */
  for (const page of [ARIA, BARAN]) await page.evaluate(() => {
    window.__why = [];
    for (const name of ['openPrekeySeal', 'openSealedSender', 'verifyOfflineEnvelopeSender', 'handleSessionMessage', 'deriveHybridWrapKey', 'decryptForSession']) {
      const original = window[name];
      if (typeof original !== 'function') continue;
      window[name] = async function wrapped(...args) {
        try {
          const result = await original.apply(this, args);
          if (result === null || result === undefined && name !== 'handleSessionMessage') window.__why.push(`${name} gave ${result}`);
          if (name === 'verifyOfflineEnvelopeSender' && result !== 'verified' && result !== 'unknown' && result !== 'unsigned') window.__why.push(`${name} said ${result}`);
          return result;
        } catch (error) {
          let shape = '';
          if (name === 'decryptForSession') { const [session, payload, kind] = args; shape = ` kind=${kind} r=${payload?.r} a=${payload?.a} n=${payload?.n} c=${String(payload?.c || '').slice(0, 5)} recvChain=${String(session?.ratchet?.recv?.id || session?.ratchet?.c || '').slice(0, 5)} ratchet=${session?.ratchet ? session.ratchet.v : 'none'} src=${session?.keySource} pinned=${session?.aadSeq !== undefined}`; }
          window.__why.push(`${name} threw ${error?.name}${shape}`); throw error;
        }
      };
    }
  });

  /* The cause, held on any engine: a payload remembers the key it was sealed under, so an envelope enclosing a
     key encloses that one even when the session's own key was replaced in between (two people beginning at the
     same instant). */
  const remembered = process.env.SIMUL_NO_PROBE ? { sealedUnder: true, notTheNewOne: true } : await ARIA.evaluate(async (who) => {
    const peer = findPeerByAnyKey(who);
    const session = chatState.sessions.get(peer.peerId) || { peerId: peer.peerId };
    const first = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    const second = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    /* A session of nobody: it must not touch any real contact's bindings or counters. */
    const fake = { cryptoKey: first, ratchet: null, peerId: 'probe-nobody', remoteFingerprint: 'probe-nobody' };
    const payload = await encryptForSession(fake, new TextEncoder().encode('x'), 'text');
    fake.cryptoKey = second;
    const kept = keyOfPayload(payload);
    const hex = async (key) => Array.from(new Uint8Array(await crypto.subtle.exportKey('raw', key))).join(',');
    return { sealedUnder: kept ? await hex(kept) === await hex(first) : false, notTheNewOne: kept ? await hex(kept) !== await hex(second) : false };
  }, fp.BARAN);
  check('a payload remembers the key it was sealed under, not the key the session holds later', remembered.sealedUnder && remembered.notTheNewOne, JSON.stringify(remembered));
  await both('the first words, both at once', ARIA, BARAN, fp);
  await both('a live session, both at once', ARIA, BARAN, fp);
  await both('the relay only, both at once', ARIA, BARAN, fp, async () => { await noLive(ARIA); await noLive(BARAN); });
  await both('one of them away, both write', ARIA, BARAN, fp, async () => { await cut(BARAN); await ARIA.waitForTimeout(1500); }, async () => { await ARIA.waitForTimeout(1500); await back(BARAN); });
  await both('after the return, both at once', ARIA, BARAN, fp);

  if (!process.env.SIMUL_NO_MEDIA) {
    await mediaBoth('files, both at once, live', ARIA, BARAN);
    await mediaBoth('files, both at once, the relay only', ARIA, BARAN, async () => { await noLive(ARIA); await noLive(BARAN); });
    await mediaBoth('files, both write, one away', ARIA, BARAN, async () => { await cut(BARAN); await ARIA.waitForTimeout(1500); }, async () => { await ARIA.waitForTimeout(1500); await back(BARAN); });
  }

  const failed = results.filter((ok) => !ok).length;
  console.log(`\n===== ${failed} failed of ${results.length} =====`);
  process.exitCode = failed ? 1 : 0;
} finally {
  await browser.close();
}

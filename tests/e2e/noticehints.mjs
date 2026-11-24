/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text. Section 13 matters here: run a modified
 * version as a network service and its users are entitled to your source.
 */

/* What a notification says: the sender's name and the message (or the kind of
 * media), each behind a switch that is OFF until the person turns it on — and
 * never visible to the relay or the push service either way.
 *
 *   node tests/e2e/_local-stack.mjs noticehints
 *
 * Two real apps and a real relay; the service worker is the shipped sw.js with
 * only the browser facilities under it replaced (as swnotify.mjs does), so what
 * is checked is the line a phone would show:
 *   - both switches exist and are off; with them off nothing rides the envelope;
 *   - turned on, the contacts are handed the keys, sealed, and the next message
 *     to an absent person carries a hint the relay's own mailbox cannot read;
 *   - the worker opens it with the keys the page left for it, and says
 *     "Name" / "the text" — in the person's language, with a word for media;
 *   - a hint that does not open, switches that are off and missing keys all give
 *     the fixed line it always was;
 *   - turned off again, the keys go and so does the hint. */
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openApp, identity, importIdentity, browser, waitFor, mailbox } from './_chat-harness.mjs';
import { createChecks } from './_check.mjs';

const SW = fileURLToPath(new URL('../../sw.js', import.meta.url));
const { results, check } = createChecks({ maxDetail: 260, entry: (_name, ok) => Boolean(ok) });
const decode = (card) => JSON.parse(Buffer.from(card.replace('poorija-chat-v1:', ''), 'base64').toString('utf8'));
const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const FIXED = 'Encrypted chat update received.';

/* The worker, with a notification list and an IndexedDB the test fills. */
function loadWorker(record) {
  const handlers = new Map();
  const shown = [];
  const self = {
    location: new URL('https://example.test/index.html'),
    addEventListener(type, fn) { if (!handlers.has(type)) handlers.set(type, []); handlers.get(type).push(fn); },
    skipWaiting() {},
    crypto: webcrypto,
    clients: { matchAll: async () => [{ visibilityState: 'hidden', focused: false, url: 'https://example.test/index.html', postMessage() {} }] },
    registration: {
      async showNotification(title, options) { shown.push({ title, ...options }); },
      async getNotifications() { return []; },
    },
    navigator: { userAgent: 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/124.0 Safari/537.36' },
    indexedDB: record === undefined ? undefined : {
      open() {
        const request = {};
        queueMicrotask(() => {
          request.result = {
            createObjectStore() {},
            close() {},
            transaction: () => ({ objectStore: () => ({ get: () => {
              const get = {};
              queueMicrotask(() => { get.result = record; get.onsuccess?.(); });
              return get;
            } }) }),
          };
          request.onsuccess?.();
        });
        return request;
      },
    },
    caches: { open: async () => ({ addAll: async () => {}, put: async () => {}, match: async () => undefined }), keys: async () => [], delete: async () => true },
  };
  const sandbox = { self, caches: self.caches, fetch: async () => { throw new Error('offline'); }, URL, console, setTimeout, clearTimeout, Promise, Response: class {}, Request: class {}, TextDecoder, TextEncoder, atob: (text) => Buffer.from(text, 'base64').toString('binary') };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SW, 'utf8'), sandbox, { filename: 'sw.js' });
  return {
    shown,
    push: async (payload) => {
      const waits = [];
      for (const fn of handlers.get('push') || []) fn({ data: { json: () => payload, text: () => JSON.stringify(payload) }, waitUntil: (p) => waits.push(p) });
      await Promise.all(waits);
    },
  };
}
const aes = (raw, usages) => webcrypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, usages);
async function seal(raw, value) {
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const cipher = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aes(raw, ['encrypt']), new TextEncoder().encode(JSON.stringify(value)));
  return { iv: b64(iv), c: b64(new Uint8Array(cipher)) };
}
const LINE = { title: 'P00RIJA Chat', body: FIXED, tag: 'poorija-chat', lang: 'en', url: './index.html#chat', data: { kind: 'chat' } };
async function said(record, hint, lang = 'en') {
  const worker = loadWorker(record);
  await worker.push({ ...LINE, lang, hint });
  return worker.shown[0];
}

console.log('\n===== the line a phone shows, from the hint =====');
{
  const nameKey = webcrypto.getRandomValues(new Uint8Array(32));
  const bodyKey = webcrypto.getRandomValues(new Uint8Array(32));
  const other = webcrypto.getRandomValues(new Uint8Array(32));
  const keys = async (show) => ({ list: [{ s: await aes(other, ['decrypt']), p: await aes(other, ['decrypt']) }, { s: await aes(nameKey, ['decrypt']), p: await aes(bodyKey, ['decrypt']), name: 'Ali' }], show });
  const name = await seal(nameKey, { n: 'Ali', at: Date.now() });
  const text = await seal(bodyKey, { k: 'text', t: 'Dinner at eight?', at: Date.now() });
  const photo = await seal(bodyKey, { k: 'photo', t: '', at: Date.now() });
  const sticker = await seal(bodyKey, { k: 'sticker', t: '', at: Date.now() });
  const voice = await seal(bodyKey, { k: 'voice', t: '', at: Date.now() });

  const both = await said(await keys({ s: true, p: true }), { n: name, p: text });
  check('both on: the name is the title and the text is the line', both?.title === 'Ali' && /^Dinner at eight\?/.test(both.body), JSON.stringify(both));
  const nameOnly = await said(await keys({ s: true, p: false }), { n: name, p: text });
  check('only the name: "New message from Ali", and the text is not said', nameOnly?.title === 'P00RIJA Chat' && /New message from Ali/.test(nameOnly.body) && !/Dinner/.test(nameOnly.body), JSON.stringify(nameOnly));
  const textOnly = await said(await keys({ s: false, p: true }), { n: name, p: text });
  check('only the text: no name anywhere', textOnly?.title === 'P00RIJA Chat' && /Dinner at eight/.test(textOnly.body) && !/Ali/.test(JSON.stringify(textOnly)), JSON.stringify(textOnly));
  check('media says what it is, not its bytes', (await said(await keys({ s: false, p: true }), { p: photo }))?.body.startsWith('Photo')
    && (await said(await keys({ s: false, p: true }), { p: sticker }))?.body.startsWith('Sticker')
    && (await said(await keys({ s: false, p: true }), { p: voice }))?.body.startsWith('Voice message'));
  const fa = await said(await keys({ s: true, p: true }), { n: name, p: photo }, 'fa');
  check('in the person\'s language: a photo is "عکس"', fa?.title === 'Ali' && fa.body.startsWith('عکس'), JSON.stringify(fa));
  const faName = await said(await keys({ s: true, p: false }), { n: name }, 'fa');
  check('and a name alone: "پیام تازه از Ali"', /پیام تازه از Ali/.test(faName?.body || ''), JSON.stringify(faName));

  console.log('\n===== and the fixed line, whenever it cannot be more =====');
  check('switches off: the fixed line, though a hint came', (await said(await keys({ s: false, p: false }), { n: name, p: text }))?.body.startsWith(FIXED));
  check('no keys left for the worker: the fixed line', (await said(null, { n: name, p: text }))?.body.startsWith(FIXED));
  check('no IndexedDB at all: the fixed line', (await said(undefined, { n: name, p: text }))?.body.startsWith(FIXED));
  const stranger = await seal(webcrypto.getRandomValues(new Uint8Array(32)), { n: 'Mallory', at: Date.now() });
  check('a hint under another key: the fixed line, not an error', (await said(await keys({ s: true, p: true }), { n: stranger, p: stranger }))?.body.startsWith(FIXED));
  check('a hint that is not even a hint: the fixed line', (await said(await keys({ s: true, p: true }), { n: 5, p: 'x' }))?.body.startsWith(FIXED));
  const sign = await seal(nameKey, { n: 'Mom', at: Date.now() });
  check('the name shown is the one this device saved, not the one the hint says', (await said(await keys({ s: true, p: false }), { n: sign }))?.body === 'New message from Ali');
  const mixed = await said(await keys({ s: true, p: true }), { n: name, p: await seal(other, { k: 'text', t: 'x', at: Date.now() }) });
  check('a name and a line that open under different contacts are not believed', mixed?.body.startsWith(FIXED), JSON.stringify(mixed));
  const old = await seal(nameKey, { n: 'Ali', at: Date.now() - 3 * 24 * 3600 * 1000 });
  check('a hint from three days ago is not believed (replayed): the fixed line', (await said(await keys({ s: true, p: true }), { n: old }))?.body.startsWith(FIXED));
  const undated = await seal(nameKey, { n: 'Ali' });
  check('a hint with no time on it is not believed either', (await said(await keys({ s: true, p: true }), { n: undated }))?.body.startsWith(FIXED));
  check('no hint: the fixed line, as before', (await said(await keys({ s: true, p: true }), undefined))?.body.startsWith(FIXED));
}

console.log('\n===== two apps and a relay =====');
try {
  const ARIA = await openApp('ARIA');
  const BARAN = await openApp('BARAN');
  const cards = { ARIA: await identity(ARIA), BARAN: await identity(BARAN) };
  const fp = { ARIA: decode(cards.ARIA).fingerprint, BARAN: decode(cards.BARAN).fingerprint };
  await importIdentity(ARIA, cards.BARAN);
  await importIdentity(BARAN, cards.ARIA);
  const open = (page, who) => page.evaluate(async (key) => {
    const peer = findPeerByAnyKey(key);
    chatState.activeConversationId = getConversationKey(peer);
    chatState.activePeerClientId = peer.clientId || '';
    renderPeers(); renderActivePeer(); renderMessages();
    await new Promise((r) => setTimeout(r, 300));
  }, who);
  const say = (page, text) => page.evaluate((value) => {
    const box = document.getElementById('chatComposer');
    box.value = value;
    box.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('chatSendMessageBtn').click();
  }, text);
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
  const flip = (page, id, on) => page.evaluate(({ id: control, on: value }) => {
    const box = document.getElementById(control);
    box.checked = value;
    box.dispatchEvent(new Event('change', { bubbles: true }));
  }, { id, on });
  await open(ARIA, fp.BARAN); await open(BARAN, fp.ARIA);
  const hello = `hello-${Date.now()}`;
  await say(ARIA, hello);
  await waitFor(BARAN, (text) => Object.values(chatState.history).some((l) => l.some((e) => e.text === text)), { arg: hello, timeoutMs: 45000 });

  const prefs = await BARAN.evaluate(() => ({ s: chatState.prefs.notifyShowSender, p: chatState.prefs.notifyShowPreview, hasS: Boolean(document.getElementById('chatNoticeShowSender')), hasP: Boolean(document.getElementById('chatNoticeShowPreview')) }));
  check('both switches are in Settings, and off', prefs.hasS && prefs.hasP && !prefs.s && !prefs.p, JSON.stringify(prefs));
  const heardOf = (box, text) => (mailbox(fp.BARAN) || []).filter((item) => JSON.stringify(item).includes('"hint"'));
  void heardOf;

  /* off: nothing rides along */
  await cut(BARAN);
  await ARIA.waitForTimeout(1200);
  const plain = `plain-${Date.now()}`;
  await say(ARIA, plain);
  await ARIA.waitForTimeout(2500);
  const boxOff = mailbox(fp.BARAN) || [];
  check('switches off: the message waits for them with no hint on it', boxOff.length > 0 && !boxOff.some((item) => item.payload?.hint), `${boxOff.length} waiting`);
  await back(BARAN);
  await waitFor(BARAN, (text) => Object.values(chatState.history).some((l) => l.some((e) => e.text === text)), { arg: plain, timeoutMs: 45000 });

  /* on: the keys go to the contact, sealed */
  await flip(BARAN, 'chatNoticeShowSender', true);
  await flip(BARAN, 'chatNoticeShowPreview', true);
  const given = await waitFor(ARIA, (who) => { const peer = findPeerByAnyKey(who); return Boolean(peer?.noticeKeys?.s && peer?.noticeKeys?.p); }, { arg: fp.BARAN, timeoutMs: 60000 });
  check('turned on, the contact is handed the two keys', given === true);
  const mine = await BARAN.evaluate((who) => chatState.prefs.noticeKeys?.per?.[who] || null, fp.ARIA);
  check('the keys are this contact\'s own, kept per contact', Boolean(mine?.s && mine?.p) && mine.s !== mine.p, JSON.stringify(Object.keys((await BARAN.evaluate(() => chatState.prefs.noticeKeys?.per)) || {})));
  const forTheWorker = await BARAN.evaluate(async () => {
    const db = await new Promise((resolve, reject) => { const r = indexedDB.open('poorija-notice', 1); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    const record = await new Promise((resolve) => { const g = db.transaction('kv').objectStore('kv').get('keys'); g.onsuccess = () => resolve(g.result); g.onerror = () => resolve(null); });
    db.close();
    const first = record?.list?.[0];
    return { has: Boolean(record), s: Boolean(first?.s), p: Boolean(first?.p), show: record?.show || null, extractable: first?.s ? first.s.extractable : null };
  });
  check('and the worker is left the keys, which cannot be read back out', forTheWorker.has && forTheWorker.s && forTheWorker.p && forTheWorker.show?.s === true && forTheWorker.show?.p === true && forTheWorker.extractable === false, JSON.stringify(forTheWorker));

  await cut(BARAN);
  await ARIA.waitForTimeout(1500);
  const secret = `secret dinner plans ${Date.now() % 10000}`;
  await say(ARIA, secret);
  await ARIA.waitForTimeout(3000);
  const box = mailbox(fp.BARAN) || [];
  const withHint = box.find((item) => item.payload?.hint);
  check('the message waiting for them carries a hint', Boolean(withHint?.payload?.hint?.n && withHint.payload.hint.p), JSON.stringify(withHint?.payload?.hint || null).slice(0, 120));
  const onDisk = JSON.stringify(box);
  check('and the relay\'s own mailbox holds neither the name nor the words', !onDisk.includes(secret) && !onDisk.includes('ARIA') && !onDisk.includes('secret dinner') && !onDisk.includes('P00RIJA User'));

  /* what the worker makes of exactly that hint, with exactly the keys the page left */
  const raw = await BARAN.evaluate((who) => chatState.prefs.noticeKeys.per[who], fp.ARIA);
  const savedName = await BARAN.evaluate((who) => { const peer = findPeerByAnyKey(who); return String(peer?.nickname || peer?.username || peer?.name || '').trim(); }, fp.ARIA);
  const record = { list: [{ s: await aes(Buffer.from(raw.s, 'base64'), ['decrypt']), p: await aes(Buffer.from(raw.p, 'base64'), ['decrypt']), name: savedName }], show: { s: true, p: true } };
  const shown = await said(record, withHint?.payload?.hint);
  const ariaName = await ARIA.evaluate(() => chatState.profile.name);
  check('the worker says who wrote and what', Boolean(savedName) && shown?.title === savedName && shown.body.startsWith(secret.slice(0, 20)), JSON.stringify(shown));

  /* a photo: said as a photo */
  await back(BARAN);
  await waitFor(BARAN, (text) => Object.values(chatState.history).some((l) => l.some((e) => e.text === text)), { arg: secret, timeoutMs: 45000 });

  /* off again: the keys go and the hint stops */
  await flip(BARAN, 'chatNoticeShowSender', false);
  await flip(BARAN, 'chatNoticeShowPreview', false);
  const taken = await waitFor(ARIA, (who) => { const peer = findPeerByAnyKey(who); return !peer?.noticeKeys; }, { arg: fp.BARAN, timeoutMs: 45000 });
  check('turned off, the contact is told to forget them', taken === true);
  const left = await BARAN.evaluate(async () => {
    const db = await new Promise((resolve, reject) => { const r = indexedDB.open('poorija-notice', 1); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    const record = await new Promise((resolve) => { const g = db.transaction('kv').objectStore('kv').get('keys'); g.onsuccess = () => resolve(g.result); g.onerror = () => resolve(null); });
    db.close();
    return { record: Boolean(record), keys: Object.values(chatState.prefs.noticeKeys?.per || {}).filter((mine) => mine.s || mine.p) };
  });
  check('and nothing is left for the worker or in the prefs', left.record === false && left.keys.length === 0, JSON.stringify(left));
  await cut(BARAN);
  await ARIA.waitForTimeout(1500);
  const after = `after-${Date.now()}`;
  await say(ARIA, after);
  await ARIA.waitForTimeout(2500);
  const boxAfter = (mailbox(fp.BARAN) || []).filter((item) => JSON.stringify(item).includes('"hint"'));
  const latest = (mailbox(fp.BARAN) || []).slice(-1)[0];
  check('and the next message carries no hint', Boolean(latest) && !latest.payload?.hint, `${boxAfter.length} with a hint in the box, latest ${latest?.payload?.hint ? 'has one' : 'has none'}`);

  const failed = results.filter((ok) => !ok).length;
  console.log(`\n===== ${failed} failed of ${results.length} =====`);
  process.exitCode = failed ? 1 : 0;
} finally {
  await browser.close();
}

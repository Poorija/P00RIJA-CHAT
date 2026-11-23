/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text. Section 13 matters here: run a modified
 * version as a network service and its users are entitled to your source.
 */

/* Large group calls through the SFU, encrypted end to end (roadmap 3.2).
 *
 * Three apps on one relay with a real SFU process beside it (scripts/sfu.js),
 * a video group call put on the SFU (the threshold lowered to three for the
 * test), and an eavesdropper that holds the room's capability — what the SFU,
 * or anyone it leaks to, would hold. What has to hold:
 *
 *   - every member hears and sees every other: audio and video frames are
 *     decoded from each of the others;
 *   - each device sends once, and the SFU fans out (its counters);
 *   - what the SFU carries is SFrame: a header and ciphertext, and with the
 *     capability but no key nothing opens;
 *   - a member who leaves: the others make new keys, and the keys the one who
 *     left kept open nothing sent after;
 *   - a socket without the capability is refused.
 *
 *   node tests/e2e/sfucall.mjs      (brings up its own relay and SFU)
 */
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { openApp, identity, importIdentity, browser, waitFor } from './_chat-harness.mjs';
import { startTwoStacks } from './_two-stacks.mjs';
import { createChecks } from './_check.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const { results, check } = createChecks({ entry: (name, ok, detail) => ({ name, ok, detail }) });
const section = (title) => console.log(`\n===== ${title} =====`);
const decode = (card) => JSON.parse(Buffer.from(card.replace('poorija-chat-v1:', ''), 'base64').toString('utf8'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

const sfuPort = await freePort();
const SFU_URL = `ws://localhost:${sfuPort}/sfu`;
const stacks = await startTwoStacks({ envA: { CHAT_SFU_PORT: String(sfuPort), CHAT_SFU_PUBLIC: SFU_URL, CHAT_SFU_CHECK_MS: '1000' } });
let sfuOut = '';
const sfu = spawn(process.execPath, ['scripts/sfu.js'], {
  cwd: root,
  /* Two addresses, as on a server (loopback for the relay's check, the
     bridge for nginx): both must answer. */
  env: { ...process.env, CHAT_SFU_PORT: String(sfuPort), CHAT_SFU_LISTEN_HOSTS: '127.0.0.1,::1', CHAT_SFU_SECRET_PATH: path.join(stacks.a.dir, 'sfu-secret') },
  stdio: ['ignore', 'pipe', 'pipe'],
});
sfu.stdout.on('data', (c) => { sfuOut += c; });
sfu.stderr.on('data', (c) => { sfuOut += c; });
const sfuHealth = () => fetch(`http://127.0.0.1:${sfuPort}/sfu/health`).then((r) => r.json()).catch(() => null);

try {
  for (let i = 0; i < 50 && !(await sfuHealth())?.ok; i += 1) await sleep(200);
  check('the SFU is up beside the relay', (await sfuHealth())?.ok === true, sfuOut.slice(-200));
  const onSecond = await fetch(`http://[::1]:${sfuPort}/sfu/health`).then((r) => r.json()).catch(() => null);
  check('and answers on every address it was given, not only the last', onSecond?.ok === true && /listening on 127\.0\.0\.1/.test(sfuOut) && /listening on ::1/.test(sfuOut), sfuOut.slice(-200));
  let says = false;
  for (let i = 0; i < 20 && !says; i += 1) { says = (await (await fetch(`${stacks.a.url}/chat-health`)).json()).sfu === true; if (!says) await sleep(500); }
  check('and the relay says so in /chat-health', says);

  const names = ['ARIA', 'BARAN', 'CYRUS'];
  const pages = {};
  for (const name of names) { pages[name] = await openApp(name, { origin: stacks.a.url, relay: stacks.a.url, init: () => { window.__POORIJA_SFU_MIN_PEOPLE__ = 3; } }); if (process.env.SFU_DEBUG) pages[name].on('console', (m) => { if (/SFU|sfu|Group/i.test(m.text())) console.log(name, m.type(), m.text().slice(0, 200)); }); }
  for (const page of Object.values(pages)) await waitFor(page, () => chatState.identity?.v === 4, { timeoutMs: 30000 }).catch(() => null);
  const cards = {};
  for (const name of names) cards[name] = await identity(pages[name]);
  const fp = Object.fromEntries(names.map((name) => [name, decode(cards[name]).fingerprint]));
  for (const name of names) for (const other of names) if (other !== name) await importIdentity(pages[name], cards[other]);
  await sleep(3000);
  check('every app can take part (sfu1)', (await Promise.all(names.map((n) => pages[n].evaluate(() => LOCAL_CAPS.includes('sfu1'))))).every(Boolean));
  await waitFor(pages.ARIA, (fps) => fps.every((f) => peerSupports(findPeerByAnyKey(f), 'sfu1')), { timeoutMs: 30000, arg: [fp.BARAN, fp.CYRUS] }).catch(() => null);

  section('a video call on the SFU');
  const groupId = await pages.ARIA.evaluate((members) => {
    const space = { type: 'group', name: 'SFU test', conversationId: `group-${Date.now()}-sfu`, members, createdAt: new Date().toISOString(),
      ownerPeerId: chatState.peerId || '', ownerClientId: chatState.clientId || '', ownerFingerprint: chatState.identity.fingerprint, permissions: {} };
    const made = upsertSharedSpace(space);
    if (made) { made.accepted = true; saveSpaces(); }
    broadcastSpaceRecord(space);
    return space.conversationId;
  }, [fp.BARAN, fp.CYRUS]);
  for (const name of ['BARAN', 'CYRUS']) {
    await waitFor(pages[name], (id) => (chatState.spaces?.groups || []).some((g) => g.conversationId === id), { timeoutMs: 30000, arg: groupId }).catch(() => null);
    await pages[name].evaluate((id) => { const g = (chatState.spaces?.groups || []).find((x) => x.conversationId === id); if (g) { g.accepted = true; saveSpaces(); } }, groupId);
  }
  await pages.ARIA.evaluate(async (id) => {
    chatState.activeConversationId = id;
    renderPeers(); renderActivePeer();
    await startGroupCall('video');
  }, groupId);
  const room = await pages.ARIA.evaluate(() => chatState.groupCall?.sfu || null);
  if (process.env.SFU_DEBUG) {
    await sleep(3000);
    console.log('DEBUG', JSON.stringify(await pages.ARIA.evaluate(() => ({ media: Boolean(chatState.groupCall?.sfuMedia), ws: chatState.groupCall?.sfuMedia?.ws?.readyState, url: chatState.groupCall?.sfuMedia?.ws?.url, slot: chatState.groupCall?.sfuMedia?.slot, logs: (window.__consoleLog || []).slice(-10) }))));
  }
  check('the caller put the call on the SFU', Boolean(room?.room && room?.cap), JSON.stringify(room || {}).slice(0, 80));
  const callId = await pages.ARIA.evaluate(() => chatState.groupCall.callId);
  for (const name of ['BARAN', 'CYRUS']) {
    await waitFor(pages[name], (id) => Boolean(chatState.sfuInvites?.[id]), { timeoutMs: 30000, arg: callId }).catch(() => null);
    await pages[name].evaluate(async ({ id, space, roster }) => joinGroupCall(id, space, 'video', roster), { id: callId, space: groupId, roster: [fp.ARIA, fp.BARAN, fp.CYRUS] });
  }

  /* An eavesdropper with the room's capability: what the SFU itself holds. */
  const heard = [];
  const eve = new WebSocket(SFU_URL);
  eve.on('message', (data, isBinary) => { if (isBinary) heard.push(Buffer.from(data)); });
  await new Promise((resolve) => eve.on('open', resolve));
  eve.send(JSON.stringify({ type: 'hello', room: room.room, exp: room.exp, cap: room.cap }));

  const receivedFromBoth = async (name) => {
    const others = names.filter((n) => n !== name).map((n) => fp[n]);
    return waitFor(pages[name], (want) => {
      const s = PoorijaSfuCall.stats();
      return Boolean(s) && want.every((f) => (s.from[f]?.audio || 0) > 25 && (s.from[f]?.video || 0) > 5);
    }, { timeoutMs: 45000, arg: others }).catch(() => false);
  };
  for (const name of names) {
    const ok = await receivedFromBoth(name);
    const stats = await pages[name].evaluate(() => PoorijaSfuCall.stats());
    check(`${name} hears and sees both others, decoded from the SFU`, ok === true, JSON.stringify(stats?.from || {}));
  }
  const health = await sfuHealth();
  check('the SFU fans each frame out: more frames out than in, and three people in the room', health.participants >= 3 && health.framesOut > health.framesIn, JSON.stringify(health));

  section('what the SFU carries');
  await sleep(1500);
  check('the eavesdropper with the capability receives frames', heard.length > 20, String(heard.length));
  const sample = heard.slice(-40).map((b) => b.toString('base64'));
  const verdict = await pages.ARIA.evaluate(async (frames) => {
    const bytes = frames.map((s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)));
    let headers = 0; let opened = 0;
    const wrong = await PoorijaSFrame.deriveKeys(crypto.getRandomValues(new Uint8Array(16)), 1);
    for (const b of bytes) {
      const sealed = b.subarray(4);
      try { const h = PoorijaSFrame.decodeHeader(sealed); if (h.kid > 0) headers += 1; } catch (_e) { /* not a header */ }
      try { await PoorijaSFrame.decryptFrame(async () => wrong, sealed, Uint8Array.of(b[2])); opened += 1; } catch (_e) { /* refused */ }
    }
    return { headers, opened, total: bytes.length };
  }, sample);
  check('every frame is an SFrame header and ciphertext', verdict.headers === verdict.total, JSON.stringify(verdict));
  check('and nothing opens without a member\'s key', verdict.opened === 0, JSON.stringify(verdict));

  section('a forged frame from the SFU cannot silence a member');
  /* What a hostile SFU can do: take a real frame of ARIA's and send it on
     to BARAN with its counter set far ahead and its ciphertext junk. It does
     not open, and it must not move BARAN's replay window: if it did, every
     genuine frame of ARIA's after it would be "too old" and dropped. */
  const forged = await pages.BARAN.evaluate(async ({ frames, aria }) => {
    const media = chatState.groupCall.sfuMedia;
    const real = frames.map((s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)))
      .find((b) => { try { const h = PoorijaSFrame.decodeHeader(b.subarray(4)); return media.keysByKid.get(h.kid)?.fp === aria; } catch (_e) { return false; } });
    if (!real) return { made: false };
    const h = PoorijaSFrame.decodeHeader(real.subarray(4));
    const header = PoorijaSFrame.encodeHeader(h.kid, 2 ** 40);
    const junk = crypto.getRandomValues(new Uint8Array(64));
    const fake = new Uint8Array(4 + header.length + junk.length);
    fake.set(real.subarray(0, 4)); fake.set(header, 4); fake.set(junk, 4 + header.length);
    const before = PoorijaSfuCall.stats().from[aria]?.audio || 0;
    await receiveSfuFrame(media, fake.buffer);
    await new Promise((r) => setTimeout(r, 3000));
    return { made: true, before, after: PoorijaSfuCall.stats().from[aria]?.audio || 0 };
  }, { frames: sample, aria: fp.ARIA });
  check('after a forged frame with a counter far ahead, BARAN still decodes ARIA', forged.made && forged.after > forged.before + 25, JSON.stringify(forged));

  section('the relay cannot rewrite what travels beside a frame');
  check('everyone has sfu2, so the call binds each frame\'s flags and slot', await pages.BARAN.evaluate(() => chatState.groupCall.sfuMedia.room.aad === 2));
  /* A real frame of ARIA's, delivered to BARAN with its key-frame flag
     flipped, then under another member's slot: neither opens now. */
  /* Opened by BARAN's own receive path, with a fresh replay window so the
     real frame (already seen) is judged on its binding alone. */
  const rewritten = await pages.BARAN.evaluate(async ({ frames, aria, cyrus }) => {
    const media = chatState.groupCall.sfuMedia;
    const ariaSlot = [...media.slotToFp].find(([, f]) => f === aria)?.[0];
    const cyrusSlot = [...media.slotToFp].find(([, f]) => f === cyrus)?.[0];
    const real = frames.map((s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)))
      .find((b) => ((b[0] << 8) | b[1]) === ariaSlot && b[2] === 1);
    if (!real) return { made: false };
    const opens = async (bytes, remap) => {
      const saved = media.replay;
      media.replay = PoorijaSFrame.createReplayWindow(4096);
      const before = PoorijaSfuCall.stats().from[aria]?.frames || 0;
      if (remap) media.slotToFp.set(cyrusSlot, aria);
      try { await receiveSfuFrame(media, bytes.buffer); } finally { if (remap) media.slotToFp.set(cyrusSlot, cyrus); media.replay = saved; }
      return (PoorijaSfuCall.stats().from[aria]?.frames || 0) > before;
    };
    const asSent = await opens(real.slice());
    const flagged = real.slice(); flagged[3] = flagged[3] ? 0 : 1;
    const moved = real.slice(); moved[0] = (cyrusSlot >> 8) & 0xff; moved[1] = cyrusSlot & 0xff;
    return { made: true, asSent, flagOpened: await opens(flagged), slotOpened: await opens(moved, true) };
  }, { frames: sample, aria: fp.ARIA, cyrus: fp.CYRUS });
  check('the frame as sent opens', rewritten.made && rewritten.asSent, JSON.stringify(rewritten));
  check('a frame with its key-frame flag flipped by the relay does not open', rewritten.made && rewritten.asSent && !rewritten.flagOpened, JSON.stringify(rewritten));
  check('nor one the relay moved to another member\'s slot', rewritten.made && rewritten.asSent && !rewritten.slotOpened, JSON.stringify(rewritten));
  const clash = await pages.BARAN.evaluate(async ({ cyrus }) => {
    const media = chatState.groupCall.sfuMedia;
    const taken = [...media.keysByKid].find(([, e]) => e.fp !== cyrus)?.[0];
    const before = media.keysByKid.get(taken)?.fp;
    await handleSfuKey({ callId: chatState.groupCall.callId, slot: 99, kid: taken, key: btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16)))) }, cyrus);
    return { kept: media.keysByKid.get(taken)?.fp === before && Boolean(before) };
  }, { cyrus: fp.CYRUS });
  check('a key whose KID another member already holds is refused, not put over theirs', clash.kept, JSON.stringify(clash));

  section('CYRUS leaves: the keys he kept open nothing after');
  const before = await pages.ARIA.evaluate(() => PoorijaSfuCall.stats().kid);
  /* What CYRUS holds of the others' keys, kept as he goes. */
  await pages.CYRUS.evaluate(() => { window.__keptKeys = new Map(chatState.groupCall.sfuMedia.keysByKid); });
  await pages.CYRUS.evaluate(() => leaveGroupCall());
  const rotated = await waitFor(pages.ARIA, (old) => PoorijaSfuCall.stats()?.kid && PoorijaSfuCall.stats().kid !== old, { timeoutMs: 20000, arg: before }).catch(() => false);
  check('ARIA made a new key when CYRUS left', rotated === true);
  heard.length = 0;
  await sleep(3000);
  const afterFrames = heard.slice(-20).map((b) => b.toString('base64'));
  const cyrusTries = await pages.CYRUS.evaluate(async (frames) => {
    let opened = 0;
    for (const s of frames) {
      const b = Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
      try { await PoorijaSFrame.decryptFrame(async (kid) => window.__keptKeys.get(kid)?.keys || null, b.subarray(4), Uint8Array.of(b[2])); opened += 1; } catch (_e) { /* refused */ }
    }
    return { opened, total: frames.length };
  }, afterFrames);
  check('nothing sent after he left opens with what he kept', cyrusTries.total > 5 && cyrusTries.opened === 0, JSON.stringify(cyrusTries));
  const stillHear = await waitFor(pages.BARAN, (f) => {
    const s = PoorijaSfuCall.stats();
    window.__lastAudio = window.__lastAudio ?? (s.from[f]?.audio || 0);
    return (s.from[f]?.audio || 0) > window.__lastAudio + 25;
  }, { timeoutMs: 20000, arg: fp.ARIA }).catch(() => false);
  check('and BARAN still hears ARIA on her new key', stillHear === true);

  section('no capability, no room');
  const stranger = new WebSocket(SFU_URL);
  const closed = await new Promise((resolve) => {
    stranger.on('open', () => stranger.send(JSON.stringify({ type: 'hello', room: room.room, exp: room.exp, cap: 'x'.repeat(43) })));
    stranger.on('close', (code) => resolve(code));
    setTimeout(() => resolve(0), 5000);
  });
  check('a socket with a made-up capability is shut out', closed === 4003, String(closed));
  eve.close();

  section('a member on another relay of the family');
  /* DARA lives on relay B. The call is ARIA's, on relay A's SFU; DARA's page
     (another origin) opens it at its full address. */
  await pages.ARIA.evaluate(() => leaveGroupCall());
  await pages.BARAN.evaluate(() => leaveGroupCall());
  pages.DARA = await openApp('DARA', { origin: stacks.b.url, relay: stacks.b.url, init: () => { window.__POORIJA_SFU_MIN_PEOPLE__ = 3; } });
  await waitFor(pages.DARA, () => chatState.identity?.v === 4, { timeoutMs: 30000 }).catch(() => null);
  const cardD = await identity(pages.DARA);
  fp.DARA = decode(cardD).fingerprint;
  for (const name of ['ARIA', 'BARAN']) { await importIdentity(pages[name], cardD); await importIdentity(pages.DARA, cards[name]); }
  /* A contact on another relay is not in this relay's presence: what their
     app can do is learnt from inside the first sealed thing they send. */
  for (const name of ['ARIA', 'BARAN']) {
    await pages.DARA.evaluate(async (key) => {
      const peer = findPeerByAnyKey(key);
      const conversationId = getConversationKey(peer);
      const entry = { id: `hi-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, text: `hello from relay B`, createdAt: new Date().toISOString(), direction: 'out', type: 'text' };
      (chatState.history[conversationId] ||= []).push(entry);
      await deliverTextEntry(peer, entry, { interactive: false });
    }, fp[name]);
  }
  const learnt = await waitFor(pages.ARIA, (f) => peerSupports(findPeerByAnyKey(f), 'sfu1') && callNeedsRelay(findPeerByAnyKey(f)), { timeoutMs: 60000, arg: fp.DARA }).catch(() => false);
  check('ARIA learns from DARA\'s first message that her app takes SFU calls', learnt === true);
  const group2 = await pages.ARIA.evaluate((members) => {
    const space = { type: 'group', name: 'SFU across relays', conversationId: `group-${Date.now()}-sfux`, members, createdAt: new Date().toISOString(),
      ownerPeerId: chatState.peerId || '', ownerClientId: chatState.clientId || '', ownerFingerprint: chatState.identity.fingerprint, permissions: {} };
    const made = upsertSharedSpace(space);
    if (made) { made.accepted = true; saveSpaces(); }
    broadcastSpaceRecord(space);
    return space.conversationId;
  }, [fp.BARAN, fp.DARA]);
  for (const name of ['BARAN', 'DARA']) {
    await waitFor(pages[name], (id) => (chatState.spaces?.groups || []).some((g) => g.conversationId === id), { timeoutMs: 40000, arg: group2 }).catch(() => null);
    await pages[name].evaluate((id) => { const g = (chatState.spaces?.groups || []).find((x) => x.conversationId === id); if (g) { g.accepted = true; saveSpaces(); } }, group2);
  }
  const outside = await pages.ARIA.evaluate(async (members) => Boolean(await chooseSfuForCall(members.map((f) => findPeerByAnyKey(f)))), [fp.BARAN, fp.DARA]);
  check('a member on a relay outside this device\'s family keeps the call on the mesh', outside === false);
  await pages.ARIA.evaluate((b) => { window.__POORIJA_SFU_FAMILY__ = [b]; }, stacks.b.url);
  await pages.ARIA.evaluate(async (id) => { chatState.activeConversationId = id; renderPeers(); renderActivePeer(); await startGroupCall('video'); }, group2);
  const room2 = await pages.ARIA.evaluate(() => chatState.groupCall?.sfu || null);
  check('with that relay in the family, the call goes on the SFU, its address in full', Boolean(room2?.room) && /^wss?:\/\//.test(room2.url || ''), JSON.stringify(room2 || {}).slice(0, 90));
  const call2 = await pages.ARIA.evaluate(() => chatState.groupCall.callId);
  for (const name of ['BARAN', 'DARA']) {
    await waitFor(pages[name], (id) => Boolean(chatState.sfuInvites?.[id]), { timeoutMs: 40000, arg: call2 }).catch(() => null);
    await pages[name].evaluate(async ({ id, space, roster }) => joinGroupCall(id, space, 'video', roster), { id: call2, space: group2, roster: [fp.ARIA, fp.BARAN, fp.DARA] });
  }
  const daraHears = await waitFor(pages.DARA, (want) => {
    const s = PoorijaSfuCall.stats();
    return Boolean(s) && want.every((f) => (s.from[f]?.audio || 0) > 25 && (s.from[f]?.video || 0) > 5);
  }, { timeoutMs: 45000, arg: [fp.ARIA, fp.BARAN] }).catch(() => false);
  check('DARA, on relay B, hears and sees both through relay A\'s SFU', daraHears === true, JSON.stringify(await pages.DARA.evaluate(() => PoorijaSfuCall.stats()?.from || {})));
  const ariaHearsDara = await waitFor(pages.ARIA, (f) => (PoorijaSfuCall.stats()?.from?.[f]?.audio || 0) > 25, { timeoutMs: 30000, arg: fp.DARA }).catch(() => false);
  check('and ARIA hears DARA', ariaHearsDara === true);

  section('nothing threw');
  const errors = Object.values(pages).flatMap((page) => page.__errors || []);
  check('no script error', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (error) {
  check('the suite ran to the end', false, error?.stack || String(error));
} finally {
  await browser.close();
  sfu.kill('SIGTERM');
  await stacks.stop();
}
const failed = results.filter((result) => !result.ok);
console.log(`\n===== ${failed.length} failed of ${results.length} =====`);
failed.forEach((result) => console.log(`  FAIL ${result.name}${result.detail ? ` — ${result.detail}` : ''}`));
process.exit(failed.length ? 1 : 0);

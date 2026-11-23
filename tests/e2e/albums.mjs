/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text. Section 13 matters here: run a modified
 * version as a network service and its users are entitled to your source.
 */

/* Videos and albums, and a reaction on a picture.
 *
 *   - a video chosen in the gallery opens the same sheet as a picture, and is
 *     sent as a video: it plays in the other side's thread, with its length;
 *   - or, the File tab chosen, as a file card, as before;
 *   - pictures and a video chosen together go as one album: the other side
 *     draws them as one grid, with the time once;
 *   - more than 25 chosen: 25 in the album, the rest as files;
 *   - a press held on a photo opens its toolbar, and a reaction on it reaches
 *     the other side.
 *
 *   node tests/e2e/albums.mjs
 */
import { openApp, identity, importIdentity, waitFor } from './_chat-harness.mjs';
import { startTwoStacks } from './_two-stacks.mjs';
import { createChecks } from './_check.mjs';

const { results, check } = createChecks({ maxDetail: 300 });
const decode = (card) => JSON.parse(Buffer.from(card.replace('poorija-chat-v1:', ''), 'base64').toString('utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const openConversation = (page, fp) => page.evaluate(async (key) => {
  const peer = findPeerByAnyKey(key);
  chatState.activeConversationId = getConversationKey(peer);
  chatState.activePeerClientId = peer.clientId || '';
  updateChatShellMode?.(); renderPeers(); renderActivePeer(); renderMessages();
  await new Promise((r) => setTimeout(r, 400));
}, fp);
const files = (page, dir) => page.evaluate((d) => Object.values(chatState.history).flat()
  .filter((e) => e.type === 'file' && e.direction === d)
  .map((e) => ({ id: e.id, name: e.name, photo: Boolean(e.photo), video: Boolean(e.video), album: e.albumId || '', idx: e.albumIndex, n: e.albumCount, dur: e.durationMs || 0, url: Boolean(e.downloadUrl) })), dir);
const jpeg = (page, w, h, hue) => page.evaluate(async ([w, h, hue]) => {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d'); g.fillStyle = `hsl(${hue} 70% 50%)`; g.fillRect(0, 0, w, h);
  const b = new Uint8Array(await (await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9))).arrayBuffer());
  let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}, [w, h, hue]).then((v) => Buffer.from(v, 'base64'));
/* Two seconds of moving colour, recorded in the page as WebM. */
const webm = (page) => page.evaluate(async () => {
  const c = document.createElement('canvas'); c.width = 320; c.height = 240;
  const g = c.getContext('2d');
  const stream = c.captureStream(15);
  const rec = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
  const parts = []; rec.ondataavailable = (e) => parts.push(e.data);
  rec.start(200);
  const t0 = performance.now();
  await new Promise((done) => { const tick = () => { const t = performance.now() - t0; g.fillStyle = `hsl(${(t / 5) % 360} 80% 50%)`; g.fillRect(0, 0, 320, 240); if (t < 2000) requestAnimationFrame(tick); else done(); }; tick(); });
  await new Promise((r) => { rec.onstop = r; rec.stop(); });
  const b = new Uint8Array(await new Blob(parts, { type: 'video/webm' }).arrayBuffer());
  let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}).then((v) => Buffer.from(v, 'base64'));

const stacks = await startTwoStacks();
try {
  const A = await openApp('ARIA', { origin: stacks.a.url, relay: stacks.a.url });
  const B = await openApp('BARAN', { origin: stacks.a.url, relay: stacks.a.url });
  const cards = { A: await identity(A), B: await identity(B) };
  await importIdentity(A, cards.B);
  await importIdentity(B, cards.A);
  await openConversation(A, decode(cards.B).fingerprint);
  await openConversation(B, decode(cards.A).fingerprint);
  await A.evaluate(() => { const b = document.getElementById('chatComposer'); b.value = 'hi'; b.dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('chatSendMessageBtn').click(); });
  await waitFor(B, () => Object.values(chatState.history).flat().some((e) => e.text === 'hi' && e.direction === 'in'), { timeoutMs: 60000 });

  /* A working session is not announced above the messages any more. */
  const banner = await A.evaluate(() => { const b = document.getElementById('chatSessionBanner'); return { hidden: !b || b.classList.contains('hidden') || getComputedStyle(b).display === 'none', text: b?.textContent || '' }; });
  check('a working session puts no note above the messages', banner.hidden && !/session is active|سشن رمزنگاری فعال/.test(banner.text), JSON.stringify(banner));
  const clip = await webm(A);
  check('a video to send was made', clip.length > 2000, `${clip.length} bytes`);

  /* 1. a video, as a video */
  await A.setInputFiles('#chatGalleryInput', { name: 'clip.webm', mimeType: 'video/webm', buffer: clip });
  await A.waitForSelector('.pc.is-open', { timeout: 20000 });
  const sheet = await A.evaluate(() => ({ mode: document.querySelector('.pc-mode .is-on')?.textContent.trim(), title: document.querySelector('[data-pc-title]')?.textContent, edit: !document.querySelector('[data-pc="edit"]')?.hidden, thumb: Boolean(document.querySelector('.pc-img')?.src) }));
  check('a video opens the sheet, as a video (no Edit), and the tab says Media, not Photo', /video/i.test(sheet.title) && !sheet.edit && sheet.thumb && sheet.mode === 'Media', JSON.stringify(sheet));
  /* A video this browser cannot open (no codec, or iOS Safari, which says
     nothing until it plays) still goes as a video, not as a file. */
  const unreadable = await A.evaluate(async () => {
    const r = await probeVideo(new File([new Uint8Array(4096).fill(7)], 'IMG_0001.MOV', { type: 'video/quicktime' }));
    return { poster: Boolean(r?.poster), readable: r?.readable };
  });
  check('a video the browser cannot read still gets a still and goes as a video', unreadable.poster && unreadable.readable === false, JSON.stringify(unreadable));
  await A.click('[data-pc="send"]');
  await waitFor(B, () => Object.values(chatState.history).flat().some((e) => e.direction === 'in' && e.video && e.downloadUrl), { timeoutMs: 60000 });
  const v = (await files(B, 'in')).find((e) => e.video);
  check('it arrives as a video, with its length', Boolean(v) && v.dur > 1000 && v.dur < 4000, JSON.stringify(v));
  await B.waitForSelector('.chat-video video', { timeout: 15000 });
  const player = await B.evaluate(async () => {
    const video = document.querySelector('.chat-video video');
    await new Promise((r) => { if (video.readyState >= 1) r(); else { video.onloadedmetadata = r; setTimeout(r, 5000); } });
    const bubble = video.closest('.chat-message-bubble');
    return { ready: video.readyState, w: video.videoWidth, play: Boolean(bubble.querySelector('.chat-video-play')), card: Boolean(bubble.querySelector('[data-chat-download-message]')), length: bubble.querySelector('.chat-video-length')?.textContent || '' };
  });
  check('in the thread it is a still with a play button and its length, not a card to download', player.ready >= 1 && player.w === 320 && player.play && !player.card && /^0:0[1-3]$/.test(player.length), JSON.stringify(player));
  await B.click('.chat-video');
  await B.waitForSelector('.pv.pv-video.is-open', { timeout: 10000 });
  const viewer = await B.evaluate(async () => {
    const v = document.querySelector('.pv-video .pv-video-el');
    await new Promise((r) => { if (v.readyState >= 2) r(); else { v.onloadeddata = r; setTimeout(r, 5000); } });
    const box = v.getBoundingClientRect();
    return { full: box.width >= innerWidth - 2 && box.height > innerHeight * 0.5, controls: v.controls, noFullscreen: /nofullscreen/.test(v.getAttribute('controlslist') || ''), save: Boolean(document.querySelector('.pv-video [data-pvv="save"]')), ready: v.readyState, browserFullscreen: Boolean(document.fullscreenElement) };
  });
  check('a tap opens it full screen in the app\'s own player, with Save (never the browser\'s full screen)', viewer.full && viewer.controls && viewer.noFullscreen && viewer.save && viewer.ready >= 2 && !viewer.browserFullscreen, JSON.stringify(viewer));
  const download = B.waitForEvent('download', { timeout: 15000 }).catch(() => null);
  await B.click('.pv-video [data-pvv="save"]');
  const saved = await download;
  check('Save hands the video over', Boolean(saved) && /clip\.webm$/.test(saved.suggestedFilename()), saved?.suggestedFilename());
  await B.keyboard.press('Escape');
  await B.waitForTimeout(400);
  check('and Escape closes the player', await B.evaluate(() => !document.querySelector('.pv-video')));

  /* 2. a video, as a file */
  await A.setInputFiles('#chatGalleryInput', { name: 'asfile.webm', mimeType: 'video/webm', buffer: clip });
  await A.waitForSelector('.pc.is-open', { timeout: 20000 });
  await A.click('[data-pc-mode="file"]');
  await A.click('[data-pc="send"]');
  await waitFor(B, () => Object.values(chatState.history).flat().some((e) => e.direction === 'in' && e.name === 'asfile.webm' && e.downloadUrl), { timeoutMs: 60000 });
  const f = (await files(B, 'in')).find((e) => e.name === 'asfile.webm');
  check('the File tab sends the video as a file', Boolean(f) && !f.video && !f.photo, JSON.stringify(f));

  /* 3. an album: three pictures and a video */
  const pics = [];
  for (let i = 0; i < 3; i++) pics.push({ name: `p${i}.jpg`, mimeType: 'image/jpeg', buffer: await jpeg(A, 800, 600, i * 90) });
  await A.setInputFiles('#chatGalleryInput', [...pics, { name: 'albumclip.webm', mimeType: 'video/webm', buffer: clip }]);
  await A.waitForSelector('.pc.is-open', { timeout: 30000 });
  const albumTitle = await A.evaluate(() => document.querySelector('[data-pc-title]')?.textContent);
  check('four chosen together are an album in the sheet', /4/.test(albumTitle), albumTitle);
  await A.click('[data-pc="send"]');
  await waitFor(B, () => Object.values(chatState.history).flat().filter((e) => e.direction === 'in' && e.albumId && e.downloadUrl).length >= 4, { timeoutMs: 90000 });
  const inAlbum = (await files(B, 'in')).filter((e) => e.album);
  const ids = new Set(inAlbum.map((e) => e.album));
  check('all four arrive with one album id, each its place of 4', inAlbum.length === 4 && ids.size === 1 && inAlbum.every((e) => e.n === 4) && new Set(inAlbum.map((e) => e.idx)).size === 4, JSON.stringify(inAlbum));
  await sleep(1500);
  const grid = await B.evaluate(() => {
    const album = document.querySelector('.chat-album');
    if (!album) return null;
    const metas = [...album.querySelectorAll('.chat-message-meta')].filter((m) => getComputedStyle(m).display !== 'none').length;
    return { items: album.querySelectorAll(':scope > .chat-message-bubble').length, display: getComputedStyle(album).display, metas, video: Boolean(album.querySelector('video')) };
  });
  check('the receiver draws them as one grid, with the time once', grid && grid.items === 4 && grid.display === 'grid' && grid.metas === 1 && grid.video, JSON.stringify(grid));

  /* 4. more than 25 */
  const many = [];
  const small = await jpeg(A, 120, 90, 200);
  for (let i = 0; i < 27; i++) many.push({ name: `m${i}.jpg`, mimeType: 'image/jpeg', buffer: small });
  await A.setInputFiles('#chatGalleryInput', many);
  await A.waitForSelector('.pc.is-open', { timeout: 60000 });
  const capped = await A.evaluate(() => document.querySelectorAll('.pc-thumb').length);
  check('27 chosen: the sheet holds 25', capped === 25, `${capped}`);
  await A.click('[data-pc="cancel"]');
  await sleep(500);

  /* 5. a reaction on a photo */
  await B.evaluate(() => { const p = document.querySelector('.chat-album .chat-photo, .chat-photo[data-chat-photo]'); p?.scrollIntoView({ block: 'center' }); });
  await sleep(400);
  const target = await B.evaluate(() => {
    const photo = document.querySelector('.chat-message-bubble [data-chat-photo]');
    const r = photo.getBoundingClientRect();
    return { id: photo.closest('.chat-message-bubble').dataset.id, x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await B.mouse.click(target.x, target.y, { button: 'right' });
  await sleep(600);
  const toolbar = await B.evaluate((id) => {
    const bubble = document.querySelector(`.chat-message-bubble[data-id="${id}"]`);
    const react = bubble?.querySelector('[data-chat-toggle-reaction]');
    return { selected: bubble?.classList.contains('selected'), react: Boolean(react && react.offsetParent), viewer: Boolean(document.querySelector('#photoViewer.is-open')) };
  }, target.id);
  check('a long press (or right click) on a photo opens its toolbar with React, not the viewer', toolbar.selected && toolbar.react && !toolbar.viewer, JSON.stringify(toolbar));
  await B.locator(`.chat-message-bubble[data-id="${target.id}"] [data-chat-toggle-reaction]`).click();
  await sleep(500);
  const chose = await B.evaluate(() => { const b = document.querySelector('[data-chat-reaction-choice]'); if (!b) return ''; const e = b.dataset.reaction; b.click(); return e; });
  check('a reaction can be chosen for it', Boolean(chose), chose);
  const reached = await waitFor(A, (spec) => Object.values(chatState.history).flat().some((e) => e.id === spec.id && Object.values(normalizeMessageReactions(e)).includes(spec.emoji)), { timeoutMs: 30000, arg: { id: target.id, emoji: chose } }).catch(() => false);
  check('and the sender sees it on the photo', reached);
  await B.mouse.click(target.x, target.y);
  await sleep(800);
  check('a plain tap on the photo still opens the viewer', await B.evaluate(() => Boolean(document.querySelector('#photoViewer.is-open'))));
} finally {
  await stacks.stop();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n===== ${failed.length} failed of ${results.length} =====`);
process.exit(failed.length ? 1 : 0);

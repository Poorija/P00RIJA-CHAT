/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text. Section 13 matters here: run a modified
 * version as a network service and its users are entitled to your source.
 */

/* A picture is a picture.
 *
 * It used to be a file: a shield, a name and a Download button on both ends.
 *
 *   - Photos from the gallery open a sheet (caption, Photo or File, edit) and go
 *     as photos: redrawn at no more than 2560 px, the caption riding with them;
 *   - the receiver sees the picture in the thread, not a file card, and tapping
 *     it opens a viewer with what can be done with it;
 *   - the editor turns, crops and adjusts, and what comes out can be sent on;
 *   - "File" sends the bytes exactly as they were, and they arrive as a file;
 *   - a file that says it is a picture and is not (markup, an SVG) is drawn as
 *     a file, whatever it announced;
 *   - the profile picture is looked at before it is changed;
 *   - every button of the viewer has its picture (Save had none: the arrow it asked
 *     for is not in the Font Awesome that is shipped);
 *   - the corners of the crop frame are L's whose arms run inward, in Persian as in
 *     English (they were laid out with logical sides and drawn mirrored);
 *   - a sticker or a GIF has no bubble around it;
 *   - the editor draws: a pen in a colour, a mosaic brush that hides what is under it,
 *     and undo.
 *
 *   node tests/e2e/photos.mjs
 */
import { openApp, identity, importIdentity, browser, waitFor } from './_chat-harness.mjs';
import { startTwoStacks } from './_two-stacks.mjs';
import { createChecks } from './_check.mjs';

const { results, check } = createChecks({ maxDetail: 260, entry: (_name, ok) => Boolean(ok) });
const section = (title) => console.log(`\n===== ${title} =====`);
const decode = (card) => JSON.parse(Buffer.from(card.replace('poorija-chat-v1:', ''), 'base64').toString('utf8'));
const openConversation = (page, fp) => page.evaluate(async (key) => {
  const peer = findPeerByAnyKey(key);
  chatState.activeConversationId = getConversationKey(peer);
  chatState.activePeerClientId = peer.clientId || '';
  renderPeers(); renderActivePeer(); renderMessages();
  await new Promise((r) => setTimeout(r, 400));
}, fp);
const photoEntries = (page) => page.evaluate(() => Object.values(chatState.history).flat()
  .filter((e) => e.type === 'file').map((e) => ({ id: e.id, dir: e.direction, photo: Boolean(e.photo), caption: e.caption || '', w: e.mediaWidth || 0, h: e.mediaHeight || 0, name: e.name, size: e.size })));
const arrived = (page, want, ms = 60000) => waitFor(page, (spec) => Object.values(chatState.history).flat()
  .some((e) => e.type === 'file' && e.direction === 'in' && e.downloadUrl
    && (spec.photo === undefined || Boolean(e.photo) === spec.photo)
    && (!spec.name || e.name === spec.name)
    && (!spec.square || (e.mediaWidth && e.mediaWidth === e.mediaHeight))), { timeoutMs: ms, arg: want });
const makeJpeg = (page, w, h) => page.evaluate(async ([width, height]) => {
  const c = document.createElement('canvas'); c.width = width; c.height = height;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, width, height);
  grad.addColorStop(0, '#ff3b30'); grad.addColorStop(1, '#0a84ff');
  g.fillStyle = grad; g.fillRect(0, 0, width, height);
  g.fillStyle = '#ffffff'; g.fillRect(width * 0.1, height * 0.1, width * 0.2, height * 0.2);
  const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.95));
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}, [w, h]).then((b64) => Buffer.from(b64, 'base64'));

const stacks = await startTwoStacks();
try {
  const ARIA = await openApp('ARIA', { origin: stacks.a.url, relay: stacks.a.url });
  const BARAN = await openApp('BARAN', { origin: stacks.a.url, relay: stacks.a.url });
  const cards = { ARIA: await identity(ARIA), BARAN: await identity(BARAN) };
  const fp = { ARIA: decode(cards.ARIA).fingerprint, BARAN: decode(cards.BARAN).fingerprint };
  await importIdentity(ARIA, cards.BARAN);
  await importIdentity(BARAN, cards.ARIA);
  await openConversation(ARIA, fp.BARAN);
  await openConversation(BARAN, fp.ARIA);
  await ARIA.evaluate(() => { const b = document.getElementById('chatComposer'); b.value = 'hi'; b.dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('chatSendMessageBtn').click(); });
  await waitFor(BARAN, () => Object.values(chatState.history).flat().some((e) => e.text === 'hi' && e.direction === 'in'), { timeoutMs: 60000 });

  section('the sheet, and a photo sent as a photo');
  const big = await makeJpeg(ARIA, 3000, 2000);
  await ARIA.setInputFiles('#chatGalleryInput', { name: 'IMG_0001.jpg', mimeType: 'image/jpeg', buffer: big });
  await ARIA.waitForSelector('.pc.is-open', { timeout: 15000 });
  const sheet = await ARIA.evaluate(() => ({
    mode: document.querySelector('.pc-mode .is-on')?.textContent.trim(),
    image: Boolean(document.querySelector('.pc-img')?.src),
    caption: Boolean(document.querySelector('.pc-caption') && !document.querySelector('.pc-caption').hidden),
    edit: Boolean(document.querySelector('[data-pc="edit"]') && !document.querySelector('[data-pc="edit"]').hidden),
  }));
  check('the pictures chosen open a sheet: Media is the mode (not Photo: a video goes through it too), with the picture, a caption and Edit', /^Media$/.test(sheet.mode) && sheet.image && sheet.caption && sheet.edit, JSON.stringify(sheet));
  await ARIA.fill('.pc-caption', 'The first caption');
  await ARIA.click('[data-pc="send"]');
  await arrived(BARAN, { photo: true });
  const got = (await photoEntries(BARAN)).find((e) => e.photo);
  check('it arrives as a photo, with its caption', Boolean(got) && got.caption === 'The first caption', JSON.stringify(got));
  check('redrawn: the longest side is 2560, the shape kept', got && Math.max(got.w, got.h) === 2560 && Math.abs(got.w / got.h - 1.5) < 0.01, `${got?.w}x${got?.h}`);
  check('and it is smaller than the original', got && got.size < big.length, `${got?.size} < ${big.length}`);
  await BARAN.waitForSelector('.chat-photo img', { timeout: 15000 });
  const bubble = await BARAN.evaluate(() => {
    const img = document.querySelector('.chat-photo img');
    const bub = img?.closest('.chat-message-bubble');
    return { shown: Boolean(img && img.naturalWidth > 0), card: Boolean(bub?.querySelector('[data-chat-download-message]')), caption: bub?.querySelector('.chat-photo-caption')?.textContent || '' };
  });
  check('the receiver sees the picture in the thread, not a file card to download', bubble.shown && !bubble.card && bubble.caption === 'The first caption', JSON.stringify(bubble));
  await ARIA.waitForSelector('.chat-photo img', { timeout: 15000 });
  check('and the sender sees it too', await ARIA.evaluate(() => Boolean(document.querySelector('.chat-message-bubble.me .chat-photo img'))));

  section('looking at it');
  await BARAN.click('.chat-photo');
  await BARAN.waitForSelector('#photoViewer.is-open', { timeout: 10000 });
  const viewer = await BARAN.evaluate(() => ({
    src: Boolean(document.querySelector('#photoViewer .pv-img')?.src),
    caption: document.querySelector('#photoViewer [data-pv-caption]')?.textContent || '',
    actions: [...document.querySelectorAll('#photoViewer [data-pv]')].map((b) => b.getAttribute('data-pv')),
  }));
  check('a tap opens the viewer, with the caption and what can be done', viewer.src && viewer.caption === 'The first caption' && ['save', 'edit', 'forward', 'close'].every((a) => viewer.actions.includes(a)), JSON.stringify(viewer));
  const icons = await BARAN.evaluate(() => [...document.querySelectorAll('#photoViewer .pv-act')].map((button) => {
    const glyph = getComputedStyle(button.querySelector('i'), '::before').content;
    return { action: button.getAttribute('data-pv'), glyph: glyph && glyph !== 'none' && glyph !== 'normal' && glyph !== '""' };
  }));
  check('every button of the viewer has its icon, Save included', icons.length >= 3 && icons.every((entry) => entry.glyph), JSON.stringify(icons));
  const zoomed = await BARAN.evaluate(async () => {
    const stage = document.querySelector('#photoViewer .pv-stage');
    stage.dispatchEvent(new WheelEvent('wheel', { deltaY: -200, bubbles: true, cancelable: true, clientX: 200, clientY: 200 }));
    await new Promise((r) => setTimeout(r, 80));
    return /scale\(([\d.]+)\)/.exec(document.querySelector('#photoViewer .pv-img').style.transform)?.[1];
  });
  check('it zooms', Number(zoomed) > 1.05, String(zoomed));
  const saved = BARAN.waitForEvent('download', { timeout: 8000 }).catch(() => null);
  await BARAN.click('#photoViewer [data-pv="save"]');
  const download = await saved;
  check('Save hands over the file', Boolean(download) && /\.jpe?g$/i.test(download?.suggestedFilename() || ''), download?.suggestedFilename?.());

  section('the editor, and sending what it made');
  await BARAN.click('#photoViewer [data-pv="edit"]');
  await BARAN.waitForSelector('.pe.is-open', { timeout: 10000 });
  /* The crop frame's corners, in Persian too: each is an L whose corner is the crop's corner. */
  const corners = async () => BARAN.evaluate(() => {
    const crop = document.querySelector('.pe-crop').getBoundingClientRect();
    const out = {};
    for (const name of ['nw', 'ne', 'sw', 'se']) {
      const handle = document.querySelector(`.pe-crop > i[data-h="${name}"]`);
      const box = handle.getBoundingClientRect();
      const after = getComputedStyle(handle, '::after');
      out[name] = {
        left: box.left + box.width / 2 < crop.left + crop.width / 2,
        top: box.top + box.height / 2 < crop.top + crop.height / 2,
        arms: ['Top', 'Right', 'Bottom', 'Left'].filter((side) => parseFloat(after[`border${side}Width`]) > 0).join(''),
      };
    }
    return out;
  });
  const inEnglish = await corners();
  await BARAN.evaluate(() => { document.documentElement.dir = 'rtl'; });
  const inPersian = await corners();
  await BARAN.evaluate(() => { document.documentElement.dir = 'ltr'; });
  const placed = (f) => f.nw.left && f.nw.top && !f.ne.left && f.ne.top && f.sw.left && !f.sw.top && !f.se.left && !f.se.top;
  const sides = (text) => (text.match(/Top|Right|Bottom|Left/g) || []).sort().join('+');
  const armsRight = (f) => sides(f.nw.arms) === 'Left+Top' && sides(f.ne.arms) === 'Right+Top' && sides(f.sw.arms) === 'Bottom+Left' && sides(f.se.arms) === 'Bottom+Right';
  check('the crop corners sit on the right corners, in English and in Persian', placed(inEnglish) && placed(inPersian), JSON.stringify({ inEnglish, inPersian }));
  check('and each is an L whose arms run inward along its two edges, in both', armsRight(inEnglish) && armsRight(inPersian), JSON.stringify({ inEnglish: Object.values(inEnglish).map((v) => v.arms), inPersian: Object.values(inPersian).map((v) => v.arms) }));
  /* Drawing: a red stroke across the middle, then a mosaic over part of it, then undo. */
  await BARAN.click('.pe [data-pe-tab="draw"]');
  const frameBox = await BARAN.evaluate(() => { const r = document.querySelector('.pe-frame').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
  await BARAN.mouse.move(frameBox.x + frameBox.w * 0.2, frameBox.y + frameBox.h * 0.5);
  await BARAN.mouse.down();
  await BARAN.mouse.move(frameBox.x + frameBox.w * 0.5, frameBox.y + frameBox.h * 0.5, { steps: 6 });
  await BARAN.mouse.move(frameBox.x + frameBox.w * 0.8, frameBox.y + frameBox.h * 0.5, { steps: 6 });
  await BARAN.mouse.up();
  const pixel = (fx, fy) => BARAN.evaluate(([x, y]) => {
    const canvas = document.querySelector('.pe-canvas');
    const g = canvas.getContext('2d');
    return [...g.getImageData(Math.round(canvas.width * x), Math.round(canvas.height * y), 1, 1).data].slice(0, 3);
  }, [fx, fy]);
  const onStroke = await pixel(0.5, 0.5);
  check('a stroke in the pen\'s colour is on the picture where it was drawn', onStroke[0] > 220 && onStroke[1] < 90 && onStroke[2] < 90, JSON.stringify(onStroke));
  await BARAN.click('.pe [data-pe-ink="#0a84ff"]');
  await BARAN.mouse.move(frameBox.x + frameBox.w * 0.3, frameBox.y + frameBox.h * 0.3);
  await BARAN.mouse.down();
  await BARAN.mouse.move(frameBox.x + frameBox.w * 0.6, frameBox.y + frameBox.h * 0.3, { steps: 6 });
  await BARAN.mouse.up();
  const blue = await pixel(0.45, 0.3);
  check('another colour draws in that colour', blue[2] > 200 && blue[0] < 80, JSON.stringify(blue));
  await BARAN.click('.pe [data-pe="undo"]');
  const afterUndo = await pixel(0.45, 0.3);
  check('undo takes the last stroke away and leaves the one before it', !(afterUndo[2] > 200 && afterUndo[0] < 80) && (await pixel(0.5, 0.5))[0] > 220, JSON.stringify({ afterUndo }));
  const mosaic = await BARAN.evaluate(() => {
    const a = document.createElement('canvas'); a.width = 200; a.height = 200;
    const g = a.getContext('2d');
    for (let y = 0; y < 200; y += 2) for (let x = 0; x < 200; x += 2) { g.fillStyle = ((x + y) / 2) % 2 ? '#000' : '#fff'; g.fillRect(x, y, 2, 2); }
    const spread = (ctx) => { const d = ctx.getImageData(80, 80, 40, 40).data; let lo = 255; let hi = 0; for (let i = 0; i < d.length; i += 4) { lo = Math.min(lo, d[i]); hi = Math.max(hi, d[i]); } return hi - lo; };
    const before = spread(g);
    paintInk(g, 200, 200, [{ tool: 'blur', colour: '#000', size: 0.5, points: [[0.5, 0.5]] }]);
    return { before, after: spread(g) };
  });
  check('the mosaic brush hides what is under it: the detail is gone', mosaic.before > 200 && mosaic.after < mosaic.before, JSON.stringify(mosaic));
  await BARAN.click('.pe [data-pe-tab="crop"]');
  await BARAN.click('.pe [data-pe="right"]');
  await BARAN.click('.pe [data-pe-shape="1"]');
  const crop = await BARAN.evaluate(() => {
    const frame = document.querySelector('.pe-frame').getBoundingClientRect();
    const box = document.querySelector('.pe-crop').getBoundingClientRect();
    return { square: Math.abs(box.width - box.height) < 2, inside: box.width <= frame.width + 1 && box.height <= frame.height + 1 };
  });
  check('turned, and cropped to a square that stays inside the picture', crop.square && crop.inside, JSON.stringify(crop));
  await BARAN.click('.pe [data-pe-tab="adjust"]');
  await BARAN.click('.pe [data-pe-preset="mono"]');
  await BARAN.click('.pe [data-pe="done"]');
  await BARAN.waitForFunction(() => /Send in this chat/.test(document.body.innerText), null, { timeout: 15000 });
  await BARAN.evaluate(() => { [...document.querySelectorAll('button')].find((b) => /Send in this chat/.test(b.textContent))?.click(); });
  await arrived(ARIA, { photo: true, square: true });
  const square = (await photoEntries(ARIA)).filter((e) => e.dir === 'in' && e.photo).pop();
  check('and what the editor made is sent on, as a square photo', Boolean(square) && square.w === square.h && square.w > 400, JSON.stringify(square));
  const mono = await ARIA.evaluate(async () => {
    const entry = Object.values(chatState.history).flat().filter((e) => e.direction === 'in' && e.photo).pop();
    const img = new Image(); img.src = entry.downloadUrl; await img.decode();
    const c = document.createElement('canvas'); c.width = 8; c.height = 8; const g = c.getContext('2d'); g.drawImage(img, 0, 0, 8, 8);
    const d = g.getImageData(0, 0, 8, 8).data; let spread = 0; for (let i = 0; i < d.length; i += 4) spread = Math.max(spread, Math.abs(d[i] - d[i + 2]));
    return spread;
  });
  check('with the adjustment in the pixels (the Mono preset has no colour left)', mono < 12, `channel spread ${mono}`);

  section('as a file, nothing changed');
  await ARIA.setInputFiles('#chatGalleryInput', { name: 'original.jpg', mimeType: 'image/jpeg', buffer: big });
  await ARIA.waitForSelector('.pc.is-open', { timeout: 15000 });
  await ARIA.click('.pc [data-pc-mode="file"]');
  const fileSheet = await ARIA.evaluate(() => ({ caption: document.querySelector('.pc-caption').hidden, edit: document.querySelector('[data-pc="edit"]').hidden }));
  check('File mode has no caption and no editor', fileSheet.caption && fileSheet.edit, JSON.stringify(fileSheet));
  await ARIA.click('.pc [data-pc="send"]');
  await arrived(BARAN, { name: 'original.jpg' });
  const asFile = (await photoEntries(BARAN)).find((e) => e.name === 'original.jpg');
  const dims = await BARAN.evaluate(async () => {
    const entry = Object.values(chatState.history).flat().find((e) => e.name === 'original.jpg');
    const img = new Image(); img.src = entry.downloadUrl; await img.decode();
    return { w: img.naturalWidth, h: img.naturalHeight };
  });
  check('it arrives as the file it was: not flagged, at its own size and quality (3000x2000, the bytes within the metadata cleaning)',
    asFile && !asFile.photo && dims.w === 3000 && dims.h === 2000 && asFile.size > big.length * 0.97 && asFile.size <= big.length, JSON.stringify({ asFile, dims, original: big.length }));
  check('and it is drawn as a file, with a download', await BARAN.evaluate(() => [...document.querySelectorAll('.chat-message-bubble')].some((b) => /original\.jpg/.test(b.textContent) && b.querySelector('[data-chat-download-message]') && !b.querySelector('.chat-photo'))));

  section('a file that only says it is a picture');
  await ARIA.evaluate(async () => {
    const markup = new File(['<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>'], 'liar.png', { type: 'image/png' });
    await sendEncryptedBlob(markup, 'file', 0, { photo: true, mediaWidth: 100, mediaHeight: 100 });
  });
  await arrived(BARAN, { name: 'liar.png' });
  await BARAN.waitForTimeout(1500);
  const liar = await BARAN.evaluate(() => {
    const bubble = [...document.querySelectorAll('.chat-message-bubble')].find((b) => /liar\.png/.test(b.textContent));
    return { found: Boolean(bubble), photo: Boolean(bubble?.querySelector('.chat-photo img')), card: Boolean(bubble?.querySelector('[data-chat-download-message]')) };
  });
  check('it is not drawn as a picture: the bytes are looked at, not the name', liar.found && !liar.photo && liar.card, JSON.stringify(liar));

  section('the profile picture');
  const own = await ARIA.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 64; c.height = 64; const g = c.getContext('2d'); g.fillStyle = '#34c759'; g.fillRect(0, 0, 64, 64);
    setProfileAvatarData(c.toDataURL('image/jpeg', 0.9));
    document.getElementById('chatProfileAvatarBtn').click();
    await new Promise((r) => setTimeout(r, 400));
    return { viewer: Boolean(document.querySelector('#photoViewer.is-open')), actions: [...document.querySelectorAll('#photoViewer [data-pv]')].map((b) => b.getAttribute('data-pv')) };
  });
  check('tapping your own picture looks at it first, with Save, Edit and Change', own.viewer && ['save', 'edit', 'change', 'remove'].every((a) => own.actions.includes(a)), JSON.stringify(own));

  section('a sticker has no bubble');
  const frame = await BARAN.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 128; canvas.height = 128;
    const g = canvas.getContext('2d'); g.fillStyle = '#ff9500'; g.beginPath(); g.arc(64, 64, 60, 0, 7); g.fill();
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    const url = URL.createObjectURL(blob);
    const key = Object.keys(chatState.history).find((k) => chatState.history[k]?.length) || chatState.activeConversationId;
    for (const direction of ['in', 'out']) {
      appendHistory(key, { id: `sticker-${direction}-${Date.now()}`, direction, type: 'sticker', stickerKind: 'image', name: 'sticker.png', mime: 'image/png', size: blob.size, downloadUrl: url, status: 'delivered', createdAt: new Date().toISOString() });
    }
    chatState.activeConversationId = key;
    renderMessages();
    await new Promise((resolve) => setTimeout(resolve, 600));
    return [...document.querySelectorAll('.chat-sticker-bubble')].map((bubble) => {
      const style = getComputedStyle(bubble);
      const meta = bubble.querySelector('.chat-message-meta');
      return { background: style.backgroundColor, shadow: style.boxShadow, padding: style.padding, metaOnPicture: meta ? getComputedStyle(meta).position === 'absolute' : null };
    });
  });
  check('a sticker is drawn with no background, no shadow and no padding, mine and theirs', frame.length >= 2 && frame.every((b) => b.background === 'rgba(0, 0, 0, 0)' && b.shadow === 'none' && b.padding === '0px'), JSON.stringify(frame));
  check('and its time sits on the picture, not under a frame', frame.every((b) => b.metaOnPicture === true), JSON.stringify(frame));
} catch (error) {
  check('the suite ran to the end', false, error?.stack || String(error));
} finally {
  await stacks.stop?.();
  await browser?.close?.().catch(() => {});
}
const failed = results.filter((ok) => !ok).length;
console.log(`\n===== ${failed} failed of ${results.length} =====`);
process.exit(failed ? 1 : 0);

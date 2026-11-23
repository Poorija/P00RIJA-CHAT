import { openApp, browser } from './_chat-harness.mjs';
import { startTwoStacks } from './_two-stacks.mjs';
import { createChecks } from './_check.mjs';

const { results, check } = createChecks({ entry: (name, ok, detail) => ({ name, ok, detail }) });
const stacks = await startTwoStacks();
try {
  const page = await openApp('ACTIONS', { origin: stacks.a.url, relay: stacks.a.url,
    context: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } });
  const seeded = await page.evaluate(() => {
    const peer = normalizePeerRecord({ peerId: 'actions-peer', username: 'Actions Peer', fingerprint: 'b'.repeat(64), publicKeyData: '', status: 'online', manual: true, accepted: true });
    chatState.peers.push(peer);
    const key = getConversationKey(peer);
    chatState.history[key] = [
      { id: 'incoming-text', direction: 'in', type: 'text', text: 'Incoming', status: 'delivered', createdAt: new Date().toISOString() },
      { id: 'outgoing-text', direction: 'out', type: 'text', text: 'Outgoing', status: 'seen', createdAt: new Date().toISOString() },
      { id: 'photo-message', direction: 'in', type: 'file', name: 'design.png', mime: 'image/png', photo: true, downloadUrl: '', createdAt: new Date().toISOString() },
      { id: 'file-message', direction: 'out', type: 'file', name: 'report.pdf', mime: 'application/pdf', downloadUrl: '', createdAt: new Date().toISOString() },
      { id: 'sticker-message', direction: 'in', type: 'sticker', stickerEmoji: '😀', downloadUrl: '', createdAt: new Date().toISOString() },
    ];
    chatState.activeConversationId = key;
    chatState.activePeerClientId = peer.clientId || '';
    setChatView('chats');
    renderPeers(); renderActivePeer(); renderMessages();
    return key;
  });

  const outgoingButton = await page.evaluate(() => {
    openReactionPopup('outgoing-text');
    const popup = document.getElementById('chatReactionPopup');
    return {
      button: Boolean(document.querySelector('[data-chat-toggle-reaction="outgoing-text"]')),
      visible: Boolean(popup) && !popup.classList.contains('hidden'),
    };
  });
  check('an outgoing message exposes its reaction control and picker', outgoingButton.button && outgoingButton.visible, JSON.stringify(outgoingButton));

  const surface = await page.evaluate(() => {
    const popup = document.getElementById('chatReactionPopup');
    const style = getComputedStyle(popup);
    const match = style.backgroundColor.match(/rgba?\(([^)]+)\)/);
    const parts = match ? match[1].split(',').map((part) => parseFloat(part)) : [];
    return { color: style.backgroundColor, alpha: parts.length === 4 ? parts[3] : 1, opacity: style.opacity, backdrop: style.backdropFilter };
  });
  check('the reaction popup is fully opaque and hides the content behind it', surface.alpha === 1 && surface.opacity === '1' && surface.backdrop === 'none', JSON.stringify(surface));

  const outgoingReaction = await page.evaluate(() => {
    applyReactionFromPicker('outgoing-text', '❤️');
    const entry = chatState.history[getConversationKey(getActiveConversation())].find((item) => item.id === 'outgoing-text');
    return { reactions: normalizeMessageReactions(entry), reactor: currentReactorId() };
  });
  check('a reaction is recorded on an outgoing message', outgoingReaction.reactions[outgoingReaction.reactor] === '❤️', JSON.stringify(outgoingReaction));

  const replies = await page.evaluate(() => {
    const expected = {
      'photo-message': 'design.png',
      'file-message': 'report.pdf',
      'sticker-message': '😀',
    };
    return Object.entries(expected).map(([id, label]) => {
      handleReplyMessage(id);
      const context = document.getElementById('chatComposerContext');
      return { id, replyToId: chatState.replyToId, visible: !context.classList.contains('hidden'), text: document.getElementById('chatContextText').textContent, label };
    });
  });
  check('photo, file and sticker replies target the exact attachment',
    replies.every((reply) => reply.replyToId === reply.id && reply.visible && reply.text.includes(reply.label)), JSON.stringify(replies));

  const spacing = await page.evaluate(() => parseFloat(getComputedStyle(document.getElementById('chatMessages')).rowGap));
  check('message bubbles have readable separation', spacing >= 6, `${spacing}px`);
  check('no script error while exercising message actions', page.__errors.length === 0, page.__errors.slice(0, 3).join(' | '));
  void seeded;
} finally {
  await browser.close();
  await stacks.stop();
}
const failed = results.filter((result) => !result.ok);
console.log(`\n===== ${failed.length} failed of ${results.length} =====`);
failed.forEach((result) => console.log(`  FAIL ${result.name}${result.detail ? ` — ${result.detail}` : ''}`));
process.exit(failed.length ? 1 : 0);

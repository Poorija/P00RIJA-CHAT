import { openApp, browser } from './_chat-harness.mjs';
import { startTwoStacks } from './_two-stacks.mjs';
import { createChecks } from './_check.mjs';

const { results, check } = createChecks({ entry: (name, ok, detail) => ({ name, ok, detail }) });
const stacks = await startTwoStacks();
const presets = ['aegis', 'cipher', 'nebula', 'onyx', 'saffron', 'teal'];
const themes = ['ocean', 'forest', 'aurora', 'sunset', 'nord', 'solarized', 'pastel'];
try {
  const page = await openApp('PERSONALIZE', { origin: stacks.a.url, relay: stacks.a.url,
    context: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } });

  await page.evaluate(() => { PoorijaMessenger.go('settings'); PoorijaSettingsPages.open('appearance'); });
  await page.waitForTimeout(400);
  const size = await page.evaluate(() => {
    const out = document.querySelector('[data-size-out]');
    const rect = out.getBoundingClientRect();
    return { text: out.textContent, width: rect.width, dir: out.dir || getComputedStyle(out).direction };
  });
  check('the text-size percentage is fully visible in RTL', size.text === '100%' && size.width >= 30, JSON.stringify(size));
  const changedSize = await page.evaluate(() => {
    const range = document.querySelector('[data-textsize]');
    range.value = '125';
    range.dispatchEvent(new Event('input', { bubbles: true }));
    const out = document.querySelector('[data-size-out]');
    return { text: out.textContent, width: out.getBoundingClientRect().width };
  });
  check('the percentage follows the slider without clipping', changedSize.text === '125%' && changedSize.width >= 30, JSON.stringify(changedSize));

  const choices = await page.evaluate(() => [...document.querySelectorAll('[data-theme-choice]')].map((node) => node.dataset.themeChoice));
  check('seven additional themes are offered', themes.every((id) => choices.includes(id)) && choices.length >= 7, JSON.stringify(choices));
  const themeResults = [];
  for (const id of themes) {
    const found = await page.evaluate((theme) => {
      const row = document.querySelector(`[data-theme-choice="${theme}"]`);
      if (!row) return null;
      row.click();
      const style = getComputedStyle(document.documentElement);
      return {
        theme,
        className: document.documentElement.className,
        tint: style.getPropertyValue('--tint').trim(),
        bg: style.getPropertyValue('--bg').trim(),
        saved: localStorage.getItem('poorija_theme'),
      };
    }, id);
    themeResults.push(found);
  }
  check('every new theme applies and persists through the existing engine',
    themeResults.every((result) => result && result.className.includes(`theme-${result.theme}`) && result.saved === result.theme), JSON.stringify(themeResults));
  check('the seven palettes are visually distinct', new Set(themeResults.map((result) => result?.bg)).size === 7 && new Set(themeResults.map((result) => result?.tint)).size === 7, JSON.stringify(themeResults));

  await page.evaluate(() => { PoorijaSettingsPages.reset(); PoorijaSettingsPages.open('me'); });
  await page.waitForTimeout(300);
  const liveName = await page.evaluate(() => {
    const input = document.querySelector('[data-profile-name]');
    input.value = 'Asi Live';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return { hero: document.querySelector('.msgr-hero-name').textContent, state: chatState.profile.name };
  });
  check('the profile hero updates during typing before the save', liveName.hero === 'Asi Live' && liveName.state !== 'Asi Live', JSON.stringify(liveName));
  const savedName = await page.evaluate(() => {
    const input = document.querySelector('[data-profile-name]');
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return { hero: document.querySelector('.msgr-hero-name').textContent, state: chatState.profile.name };
  });
  check('the hero and stored name agree after the save', savedName.hero === 'Asi Live' && savedName.state === 'Asi Live', JSON.stringify(savedName));

  for (const preset of presets) {
    const avatar = await page.evaluate(async (name) => {
      await selectPresetAvatar(`assets/profile-avatars/${name}-v2.svg`);
      await savePendingAvatar();
      await new Promise((resolve) => setTimeout(resolve, 80));
      const data = chatState.profile.avatarData || '';
      const heroImage = document.querySelector('.msgr-hero-avatar .msgr-avatar img');
      const loaded = heroImage ? await new Promise((resolve) => {
        if (heroImage.complete) return resolve(heroImage.naturalWidth > 0);
        heroImage.addEventListener('load', () => resolve(true), { once: true });
        heroImage.addEventListener('error', () => resolve(false), { once: true });
      }) : false;
      return { data: data.slice(0, 30), hero: Boolean(heroImage), loaded, same: heroImage?.getAttribute('src') === data };
    }, preset);
    check(`${preset}: the preset converts to JPEG and appears immediately`, avatar.data.startsWith('data:image/jpeg') && avatar.hero && avatar.loaded && avatar.same, JSON.stringify(avatar));
  }
  await page.evaluate(() => { PoorijaSettingsPages.reset(); });
  await page.waitForTimeout(200);
  const synced = await page.evaluate(() => {
    const rootImage = document.querySelector('.msgr-hc-avatar .msgr-avatar img');
    const railImage = document.getElementById('msgrRailProfileImage');
    return {
      rootName: document.querySelector('.msgr-hc-name').textContent,
      root: rootImage?.getAttribute('src') === chatState.profile.avatarData,
      rail: railImage?.getAttribute('src') === chatState.profile.avatarData && !railImage.classList.contains('hidden'),
    };
  });
  check('the root card and desktop rail reflect the saved profile without reopening Settings',
    synced.rootName === 'Asi Live' && synced.root && synced.rail, JSON.stringify(synced));

  const jump = await page.evaluate(async () => {
    const peer = normalizePeerRecord({ peerId: 'demo-long-chat', username: 'Demo Chat', fingerprint: 'f'.repeat(64), publicKeyData: '', manual: true });
    chatState.peers.push(peer);
    const key = getConversationKey(peer);
    chatState.history[key] = Array.from({ length: 40 }, (_, index) => ({
      id: `demo-${index}`, direction: index % 2 ? 'in' : 'out', type: 'text', text: `Demo message ${index}`, status: 'seen', createdAt: new Date(Date.now() - (40 - index) * 1000).toISOString(),
    }));
    chatState.activeConversationId = key;
    chatState.activePeerClientId = peer.clientId || '';
    PoorijaMessenger.go('chats');
    setChatView('chats');
    renderPeers(); renderActivePeer(); renderMessages();
    await new Promise((resolve) => setTimeout(resolve, 400));
    const panel = document.getElementById('chatMessages');
    panel.style.scrollBehavior = 'auto';
    panel.scrollTop = 0;
    panel.style.removeProperty('scroll-behavior');
    panel.dispatchEvent(new Event('scroll', { bubbles: true }));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const button = document.getElementById('chatJumpLatestBtn');
    const shown = Boolean(button) && !button.classList.contains('hidden');
    button?.click();
    for (let attempt = 0; attempt < 60 && panel.scrollHeight - panel.scrollTop - panel.clientHeight > 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const before = { classes: button?.className, top: panel.scrollTop, remaining: panel.scrollHeight - panel.scrollTop - panel.clientHeight };
    return { shown, before, buttonDisplay: button ? getComputedStyle(button).display : 'missing', tab: PoorijaApp.state.activeTab, active: chatState.activeConversationId, bubbles: panel.querySelectorAll('.chat-message-bubble').length, scrollHeight: panel.scrollHeight, clientHeight: panel.clientHeight, scrollTop: panel.scrollTop, remaining: panel.scrollHeight - panel.scrollTop - panel.clientHeight };
  });
  check('jump to latest appears above older messages and returns to the end', jump.shown && jump.remaining <= 2, JSON.stringify(jump));
  check('no script error during personalization', page.__errors.length === 0, page.__errors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
  await stacks.stop();
}
const failed = results.filter((result) => !result.ok);
console.log(`\n===== ${failed.length} failed of ${results.length} =====`);
failed.forEach((result) => console.log(`  FAIL ${result.name}${result.detail ? ` — ${result.detail}` : ''}`));
process.exit(failed.length ? 1 : 0);

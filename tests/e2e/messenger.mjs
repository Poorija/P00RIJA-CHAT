/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text.
 */

/* The messenger's shell (js/messenger.js, css/messenger.css): one bar (at the
   bottom of a phone, down the side of a wide window) in place of a sidebar and a second menu inside the chat.

   The bar is a thin thing over two different kinds of place — three of its
   entries are views of the chat, two are tabs of the app — and what can go
   wrong is that it says one thing while the app is somewhere else. So every
   check here presses something and then asks the APP where it is, not the bar.

     THE BAR      five entries; each takes the app where it says, and is lit
                  when the app is there, however the app got there.
     SETTINGS     every row leads somewhere, Back comes back, and the places
                  reached from a row keep Settings lit.
     THE FRAME    the sidebar, the chat's own menu and the profile card are
                  out of sight, and the profile opens as a screen of its own.
     WIDTHS       the bar is on screen on a wide screen and on a phone, and
                  out of the way on a phone while someone is typing.

   It brings up its own relay:  node tests/e2e/messenger.mjs */
import { openApp, browser } from './_chat-harness.mjs';
import { startTwoStacks } from './_two-stacks.mjs';
import { createChecks } from './_check.mjs';

const { results, check } = createChecks({ entry: (n, ok) => ({ n, ok }) });
const section = (title) => console.log(`\n===== ${title} =====`);

const where = (page) => page.evaluate(() => {
  const shown = (node) => Boolean(node) && getComputedStyle(node).display !== 'none' && node.getBoundingClientRect().height > 0;
  const bar = document.getElementById('mobileTabBar');
  return {
    tab: window.PoorijaApp.state.activeTab,
    view: typeof chatState === 'object' ? chatState.activeView : '',
    lit: Array.from(bar.querySelectorAll('.is-active')).map((b) => b.getAttribute('data-msgr-tab')),
    labels: Array.from(bar.querySelectorAll('[data-msgr-tab]')).map((b) => b.textContent.trim()),
    ids: Array.from(bar.querySelectorAll('[data-msgr-tab]')).map((b) => b.getAttribute('data-msgr-tab')),
    title: (shown(document.getElementById('uiHead')) ? document.getElementById('uiHeadTitle') : document.getElementById('msgrTitle')).textContent.trim(),
    back: shown(document.getElementById('msgrBackBtn')),
    search: shown(document.getElementById('uiHeadSearch')) || shown(document.getElementById('msgrSearchBtn')),
    compose: shown(document.getElementById('uiHeadNew')) || shown(document.getElementById('msgrNewBtn')),
    profileOpen: document.querySelector('.chat-shell').classList.contains('msgr-profile-open'),
    profileCard: shown(document.querySelector('.chat-profile-card')),
    barShown: shown(bar),
    barBox: (() => { const r = bar.getBoundingClientRect(); return { bottom: Math.round(r.bottom), width: Math.round(r.width), height: Math.round(r.height) }; })(),
    viewport: { w: document.documentElement.clientWidth, h: window.innerHeight },
    sidebar: shown(document.getElementById('appSidebar')),
    innerMenu: shown(document.querySelector('#content-chat .chat-nav-bar')),
    oldHeader: shown(document.querySelector('#appHeader > .max-w-full')),
    rows: Array.from(document.querySelectorAll('#msgrSettingsList [data-msgr-row]')).map((b) => b.getAttribute('data-msgr-row')),
    dir: document.documentElement.getAttribute('dir'),
  };
});
const press = async (page, id) => {
  await page.evaluate((tab) => document.querySelector(`#mobileTabBar [data-msgr-tab="${tab}"]`).click(), id);
  await page.waitForTimeout(350);
  return where(page);
};
const row = async (page, id) => {
  await page.evaluate((r) => document.querySelector(`#msgrSettingsList [data-msgr-row="${r}"]`).click(), id);
  await page.waitForTimeout(400);
  return where(page);
};
const back = async (page) => {
  await page.evaluate(() => document.getElementById('msgrBackBtn').click());
  await page.waitForTimeout(350);
  return where(page);
};

const stacks = await startTwoStacks();
try {
  const page = await openApp('DESK', { origin: stacks.a.url, relay: stacks.a.url });
  await page.waitForTimeout(600);

  section('the bar');
  const start = await where(page);
  console.log('  ' + JSON.stringify(start));
  check('four entries, in the order a messenger has them — Local is a row of Settings, not a tab',
    start.ids.join(' ') === 'chats calls groups settings', start.ids.join(' '));
  check('it opens on the chats, and that is the one lit',
    start.tab === 'chat' && start.view === 'chats' && start.lit.join() === 'chats', `${start.tab}/${start.view} lit ${start.lit}`);
  check('the list has search and a new chat in its own head, and no Back',
    start.search && start.compose && !start.back);

  const calls = await press(page, 'calls');
  check('Calls is the chat\'s list of calls', calls.tab === 'chat' && calls.view === 'calls' && calls.lit.join() === 'calls' && calls.title === 'Calls',
    `${calls.tab}/${calls.view} "${calls.title}"`);
  check('and there is no new chat to start from a list of calls', calls.compose === false);
  const groups = await press(page, 'groups');
  check('Groups is the chat\'s list of groups', groups.tab === 'chat' && groups.view === 'groups' && groups.lit.join() === 'groups' && groups.title === 'Groups',
    `${groups.tab}/${groups.view} "${groups.title}"`);
  /* Local: a row of Settings, with Back, and the bar lit on Settings. */
  await press(page, 'settings');
  const local = await row(page, 'local');
  check('Local opens from Settings, as the Local Link tab', local.tab === 'locallink' && local.title === 'Local', `${local.tab} "${local.title}"`);
  check('the bar stays on Settings while it is open, and there is a Back', local.lit.join() === 'settings' && local.back === true, `lit ${local.lit} back ${local.back}`);
  const fromLocal = await back(page);
  check('Back goes to Settings', fromLocal.tab === 'settings' && fromLocal.lit.join() === 'settings');
  /* And in the bar, when the person puts it there (Appearance). */
  await page.evaluate(() => window.PoorijaMessenger.setBarTab('local', true));
  await page.waitForTimeout(300);
  const added = await where(page);
  check('Local can be added to the bar, after Groups', added.ids.join(' ') === 'chats calls groups local settings', added.ids.join(' '));
  const inBar = await press(page, 'local');
  check('then it is a tab of its own, lit', inBar.tab === 'locallink' && inBar.lit.join() === 'local' && inBar.title === 'Local' && inBar.back === false, `${inBar.tab} lit ${inBar.lit} back ${inBar.back}`);
  /* Drawn again from nothing, as a cold start does: the choice is read from storage. */
  const keptBar = await page.evaluate(() => {
    const bar = document.getElementById('mobileTabBar');
    bar.innerHTML = '';
    delete bar.dataset.msgrSignature;
    window.PoorijaMessenger.sync();
    return { saved: localStorage.getItem('poorija_msgr_bar'), ids: Array.from(bar.querySelectorAll('[data-msgr-tab]')).map((b) => b.getAttribute('data-msgr-tab')).join(' ') };
  });
  check('and the choice is kept', keptBar.ids === 'chats calls groups local settings' && /"local":true/.test(keptBar.saved || ''), JSON.stringify(keptBar));
  await page.evaluate(() => window.PoorijaMessenger.setBarTab('local', false));
  await page.waitForTimeout(300);
  const chats = await press(page, 'chats');
  check('Chats comes back from another tab to the list of chats', chats.tab === 'chat' && chats.view === 'chats' && chats.lit.join() === 'chats');

  /* The chat changes its own view from several places that never touch the
     bar: a search result, a group opening. The bar has to follow those too. */
  await page.evaluate(() => setChatView('groups'));
  await page.waitForTimeout(300);
  const followed = await where(page);
  check('the bar follows a view the chat changed by itself', followed.lit.join() === 'groups' && followed.title === 'Groups', `lit ${followed.lit} "${followed.title}"`);
  await press(page, 'chats');

  section('settings');
  const settings = await press(page, 'settings');
  check('Settings is the settings tab', settings.tab === 'settings' && settings.lit.join() === 'settings' && settings.title === 'Settings');
  check('with a row for everything the bar does not carry',
    settings.rows.join(' ') === 'profile devices local notifications privacy data appearance language connection help about lock', settings.rows.join(' '));
  check('Saved messages and Recent calls are not in Settings: they live in Chats and Calls', !settings.rows.includes('saved') && !settings.rows.includes('calls'));
  const hero = await page.evaluate(() => ({
    card: Boolean(document.querySelector('#msgrSettingsList .msgr-hero-card')),
    clocksMoved: Boolean(document.querySelector('#msgrSettingsList .msgr-hc-clocks #chatProfileClocks')),
    pet: Boolean(document.querySelector('#msgrSettingsList .msgr-hc-pet #chatPet')),
    doors: document.querySelectorAll('#msgrSettingsList .msgr-hc-btn').length,
  }));
  check('the card on top is the profile card: avatar, clocks, companion and three doors', hero.card && hero.clocksMoved && hero.pet && hero.doors === 3, JSON.stringify(hero));

  const first = await page.evaluate(() => document.getElementById('msgrSettingsList').previousElementSibling === null);
  check('and the rows are the first thing in Settings', first === true);

  for (const [id, tab] of [['help', 'help'], ['about', 'about']]) {
    await press(page, 'settings');
    const opened = await row(page, id);
    const returned = await back(page);
    check(`the ${id} row opens it, keeps Settings lit, and Back returns`,
      opened.tab === tab && opened.lit.join() === 'settings' && opened.back === true && returned.tab === 'settings' && returned.back === false,
      `${opened.tab} lit ${opened.lit} back ${opened.back} -> ${returned.tab}`);
  }

  await press(page, 'settings');
  const connection = await row(page, 'connection');
  const connectionPage = await page.evaluate(() => ({ page: window.PoorijaSettingsPages.current(), depth: window.PoorijaSettingsPages.depth(), title: document.getElementById('msgrTitle').textContent.trim() }));
  check('the connection row is a page of Settings, with the relay settings on it',
    connection.tab === 'settings' && connectionPage.page === 'connection' && connection.lit.join() === 'settings' && connection.back === true && connectionPage.title === 'Server and connection',
    `${connection.tab} ${JSON.stringify(connectionPage)}`);
  const fromConnection = await back(page);
  check('and Back from it is the list of Settings', fromConnection.tab === 'settings' && fromConnection.back === false);

  section('the frame');
  const frame = await press(page, 'chats');
  check('the sidebar is gone', frame.sidebar === false);
  check('the chat\'s own menu is gone', frame.innerMenu === false);
  check('the old header row is gone', frame.oldHeader === false);
  check('the profile card is not above the list', frame.profileCard === false && frame.profileOpen === false);

  await press(page, 'settings');
  const profile = await row(page, 'profile');
  const profilePage = await page.evaluate(() => ({ page: window.PoorijaSettingsPages.current(), name: Boolean(document.querySelector('[data-profile-name]')), mood: Boolean(document.querySelector('[data-profile-mood]')), qr: [...document.querySelectorAll('#msgrPages .msgr-row')].some((r) => /QR/.test(r.textContent)) }));
  check('the profile row opens the profile as a page of Settings, with the name, the status and the identity on it',
    profile.tab === 'settings' && profilePage.page === 'me' && profilePage.name && profilePage.mood && profilePage.qr && profile.title === 'Profile' && profile.lit.join() === 'settings',
    `${profile.tab} ${JSON.stringify(profilePage)} "${profile.title}"`);
  check('with Back, and without search or a new chat', profile.back === true && profile.search === false && profile.compose === false);
  const leftProfile = await press(page, 'chats');
  check('going to the chats closes it', leftProfile.lit.join() === 'chats');
  const kept = await press(page, 'settings');
  const keptPage = await page.evaluate(() => window.PoorijaSettingsPages.current());
  check('coming back to Settings finds the page it was left on, as a tab does', keptPage === 'me' && kept.back === true, keptPage);
  await press(page, 'settings');
  const reset = await page.evaluate(() => window.PoorijaSettingsPages.current());
  check('and Settings, pressed again while it is up, is its list', reset === 'root', reset);
  await press(page, 'chats');

  section('adaptive desktop chrome');
  const chrome = await page.evaluate(() => ({
    brand: Boolean(document.getElementById('msgrDesktopBrand')),
    theme: Boolean(document.getElementById('msgrThemeBtn')),
    profile: Boolean(document.getElementById('msgrRailProfileBtn')),
    welcome: Boolean(document.getElementById('msgrWelcome')),
    originalThread: Boolean(document.querySelector('.chat-thread-header')) && Boolean(document.getElementById('chatMessages')),
    oldHeaderHidden: getComputedStyle(document.querySelector('.chat-thread-header')).display === 'none',
    oldMessagesHidden: getComputedStyle(document.getElementById('chatMessages')).display === 'none',
  }));
  check('the wide shell has brand, theme and profile controls without replacing the conversation DOM',
    chrome.brand && chrome.theme && chrome.profile && chrome.welcome && chrome.originalThread, JSON.stringify(chrome));
  check('the welcome state is not covered by the legacy empty thread', chrome.oldHeaderHidden && chrome.oldMessagesHidden, JSON.stringify(chrome));

  const welcomeActions = await page.evaluate(() => {
    let fresh = 0;
    let search = 0;
    document.getElementById('chatStartChatBtn').addEventListener('click', () => { fresh += 1; }, { once: true });
    document.getElementById('chatSearchOpenBtn').addEventListener('click', () => { search += 1; }, { once: true });
    document.getElementById('msgrWelcomeNew')?.click();
    document.getElementById('msgrWelcomeSearch')?.click();
    return { fresh, search };
  });
  check('the welcome actions drive the real new-chat and search controls',
    welcomeActions.fresh === 1 && welcomeActions.search === 1, JSON.stringify(welcomeActions));
  await page.evaluate(() => {
    if (typeof closeFullSearch === 'function') closeFullSearch();
    if (typeof closeStartChatModal === 'function') closeStartChatModal();
  });

  const themeChanged = await page.evaluate(() => {
    const before = document.documentElement.classList.contains('dark');
    document.getElementById('msgrThemeBtn')?.click();
    const after = document.documentElement.classList.contains('dark');
    document.getElementById('themeToggleBtn').click();
    return before !== after;
  });
  check('the rail theme action changes the app theme through the existing control', themeChanged);

  await page.evaluate(() => document.getElementById('msgrRailProfileBtn')?.click());
  await page.waitForTimeout(350);
  const railProfile = await page.evaluate(() => ({ tab: window.PoorijaApp.state.activeTab, page: window.PoorijaSettingsPages.current() }));
  check('the rail profile opens the real profile page', railProfile.tab === 'settings' && railProfile.page === 'me', JSON.stringify(railProfile));
  await press(page, 'chats');

  await page.keyboard.press('Control+k');
  await page.waitForTimeout(250);
  const shortcutSearch = await page.evaluate(() => {
    const overlay = document.getElementById('chatSearchOverlay');
    return Boolean(overlay) && !overlay.classList.contains('hidden');
  });
  check('Cmd/Ctrl+K opens global search', shortcutSearch);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  await page.evaluate(() => document.querySelector('[data-msgr-tab="chats"]').focus());
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(250);
  const arrowTab = await where(page);
  check('ArrowRight moves the shell to the next real view', arrowTab.view === 'calls' && arrowTab.lit.join() === 'calls', `${arrowTab.view}/${arrowTab.lit}`);
  await page.keyboard.press('Home');
  await page.waitForTimeout(250);
  const homeTab = await where(page);
  check('Home returns to the first shell view', homeTab.view === 'chats' && homeTab.lit.join() === 'chats');
  await page.keyboard.press('End');
  await page.waitForTimeout(250);
  const endTab = await where(page);
  check('End reaches Settings', endTab.tab === 'settings' && endTab.lit.join() === 'settings');
  await press(page, 'chats');

  await page.evaluate(() => document.getElementById('uiHeadMore').focus());
  await page.keyboard.press('Enter');
  await page.waitForTimeout(150);
  const menuOpened = await page.evaluate(() => ({
    expanded: document.getElementById('uiHeadMore').getAttribute('aria-expanded'),
    focused: document.activeElement?.getAttribute('data-ui-menu'),
  }));
  check('the shell menu exposes its expanded state and focuses its first item', menuOpened.expanded === 'true' && menuOpened.focused === '0', JSON.stringify(menuOpened));
  await page.keyboard.press('ArrowDown');
  const menuSecond = await page.evaluate(() => document.activeElement?.getAttribute('data-ui-menu'));
  check('ArrowDown moves through menu items', menuSecond === '1', String(menuSecond));
  await page.keyboard.press('Escape');
  const menuClosed = await page.evaluate(() => ({
    closed: !document.querySelector('.ui-menu'),
    focus: document.activeElement?.id,
    expanded: document.getElementById('uiHeadMore').getAttribute('aria-expanded'),
  }));
  check('Escape closes the menu, restores its opener focus and resets aria-expanded',
    menuClosed.closed && menuClosed.focus === 'uiHeadMore' && menuClosed.expanded === 'false', JSON.stringify(menuClosed));

  await page.evaluate(() => {
    const row = document.createElement('div');
    row.id = 'testRowMenuFocus';
    row.className = 'chat-peer-card ui-row';
    row.innerHTML = '<div class="chat-pin-actions"><button type="button" title="Pin conversation"><i class="fas fa-thumbtack"></i></button></div>';
    document.getElementById('chatPeerList').appendChild(row);
  });
  await page.dispatchEvent('#testRowMenuFocus', 'contextmenu', { clientX: 120, clientY: 140 });
  await page.waitForTimeout(150);
  await page.keyboard.press('Escape');
  const rowMenuFocus = await page.evaluate(() => ({
    closed: !document.querySelector('.ui-menu'),
    focus: document.activeElement?.id,
  }));
  check('Escape from a conversation-row menu returns focus to that row',
    rowMenuFocus.closed && rowMenuFocus.focus === 'testRowMenuFocus', JSON.stringify(rowMenuFocus));
  await page.evaluate(() => document.getElementById('testRowMenuFocus')?.remove());

  const composerFocus = await page.evaluate(() => {
    const shell = document.querySelector('.chat-shell');
    const thread = document.querySelector('.chat-thread');
    shell.classList.add('chat-has-conversation');
    thread.classList.remove('chat-thread-empty');
    const composer = document.getElementById('chatComposer');
    composer.focus();
    const style = getComputedStyle(composer.closest('.chat-composer-bar'));
    const visible = parseFloat(style.outlineWidth) > 0 && style.outlineStyle !== 'none';
    const active = document.activeElement?.id;
    const within = composer.closest('.chat-composer-bar').matches(':focus-within');
    shell.classList.remove('chat-has-conversation');
    thread.classList.add('chat-thread-empty');
    composer.blur();
    return { visible, active, within, outline: `${style.outlineWidth} ${style.outlineStyle}` };
  });
  check('the wide composer has a visible keyboard-focus indicator', composerFocus.visible, JSON.stringify(composerFocus));

  const tablet = await openApp('TABLET', { origin: stacks.a.url, relay: stacks.a.url,
    context: { viewport: { width: 820, height: 1180 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } });
  await tablet.waitForTimeout(600);
  const tabletLayout = await tablet.evaluate(() => {
    const box = (selector) => {
      const node = document.querySelector(selector);
      const rect = node?.getBoundingClientRect();
      return Boolean(node) && getComputedStyle(node).display !== 'none' && rect.width > 180 && rect.height > 300;
    };
    return { rail: box('.chat-rail'), thread: box('.chat-thread') };
  });
  check('a tablet keeps the conversation list and thread side by side', tabletLayout.rail && tabletLayout.thread, JSON.stringify(tabletLayout));

  const landscape = await openApp('LANDSCAPE', { origin: stacks.a.url, relay: stacks.a.url,
    context: { viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } });
  await landscape.waitForTimeout(600);
  const landscapeRail = await landscape.evaluate(() => {
    document.documentElement.classList.add('native-mobile');
    const bar = document.getElementById('mobileTabBar');
    bar.scrollTop = bar.scrollHeight;
    const profile = document.getElementById('msgrRailProfileBtn');
    const rect = profile.getBoundingClientRect();
    return { viewport: innerHeight, bottom: Math.round(rect.bottom), top: Math.round(rect.top), overflow: getComputedStyle(bar).overflowY };
  });
  check('a short native landscape rail can scroll to its profile action',
    landscapeRail.top >= 0 && landscapeRail.bottom <= landscapeRail.viewport && ['auto', 'scroll'].includes(landscapeRail.overflow), JSON.stringify(landscapeRail));

  section('language');
  await page.evaluate(() => window.switchLanguage());
  await page.waitForTimeout(700);
  const persian = await where(page);
  console.log('  ' + JSON.stringify({ labels: persian.labels, title: persian.title, dir: persian.dir }));
  check('the bar and the title are in Persian',
    persian.labels.join(' ') === 'گفتگوها تماس‌ها گروه‌ها تنظیمات' && persian.title === 'گفتگوها', `${persian.labels.join(' ')} / ${persian.title}`);
  await page.evaluate(() => window.switchLanguage());
  await page.waitForTimeout(700);
  const english = await where(page);
  check('and back in English', english.labels.join(' ') === 'Chats Calls Groups Settings', english.labels.join(' '));

  section('widths');
  check('on a wide screen the bar is a rail down the side, the full height of the window',
    english.barShown && english.barBox.height >= english.viewport.h - 2 && english.barBox.width >= 56 && english.barBox.width <= 110,
    JSON.stringify(english.barBox));

  const phone = await openApp('PHONE', { origin: stacks.a.url, relay: stacks.a.url,
    context: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } });
  await phone.waitForTimeout(600);
  const small = await where(phone);
  check('on a phone the bar floats just above the bottom edge, nearly across it',
    small.barShown && small.viewport.h - small.barBox.bottom >= 4 && small.viewport.h - small.barBox.bottom <= 40 && small.barBox.width >= small.viewport.w - 48 && small.barBox.height >= 44,
    JSON.stringify(small.barBox));
  check('and the frame is gone there too', small.sidebar === false && small.innerMenu === false && small.profileCard === false);
  /* What the chat sets on <html> while the composer has the focus, set here
     by hand: the rule that answers it is css/styles.css's own, and what is
     under test is that the messenger's shell has not broken it. */
  await phone.evaluate(() => document.documentElement.classList.add('chat-composer-focused'));
  const typing = await where(phone);
  check('while typing on a phone the bar is out of the way', typing.barShown === false);
  await phone.evaluate(() => document.documentElement.classList.remove('chat-composer-focused'));
  const doneTyping = await where(phone);
  check('and back when the typing stops', doneTyping.barShown === true);

  section('settings pages that are views of the app\'s own controls');
  const view = async (id) => { await page.evaluate((p) => { window.PoorijaMessenger.go('settings'); window.PoorijaSettingsPages.reset(); window.PoorijaSettingsPages.open(p); }, id); await page.waitForTimeout(500); };
  await view('connection');
  const before = await page.evaluate(() => document.getElementById('chatAutoConnect').checked);
  await page.evaluate(() => document.querySelector('[data-bind="chatAutoConnect"]').click());
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => document.getElementById('chatAutoConnect').checked);
  check('a switch on the connection page is the app\'s own switch: one tap flips the original', before !== after, `${before} -> ${after}`);
  await page.evaluate(() => document.querySelector('[data-bind="chatAutoConnect"]').click());
  const connectionRows = await page.evaluate(() => ({ native: document.querySelectorAll('[data-msgr-page="connection"] .msgr-switch-row').length, oldGrid: [...document.querySelectorAll('[data-msgr-page="connection"] .chat-toggle-grid')].some((n) => n.offsetParent !== null) }));
  check('the connection page is rows, and the old grid of switches is not on show beside them', connectionRows.native >= 6 && connectionRows.oldGrid === false, JSON.stringify(connectionRows));
  await view('privacy');
  const messages = await page.evaluate(() => !!document.querySelector('[data-msgr-page="privacy"] [data-bind="chatSendReceipts"]'));
  check('read receipts are on the privacy page, where a messenger keeps them', messages);
  await view('devices');
  const devices = await page.evaluate(() => document.querySelectorAll('[data-msgr-page="devices"] .chat-device-row').length);
  check('the devices page lists this device (it was an empty box)', devices >= 1, String(devices));
  await view('data');
  const stats = await page.evaluate(() => document.querySelectorAll('[data-msgr-page="data"] .msgr-stat').length);
  check('the data page counts what is stored', stats >= 4, String(stats));

  section('the text size reaches the messages');
  const size = await page.evaluate(async () => {
    const s = document.getElementById('settingFontSize');
    const options = [...s.options].map((o) => o.value);
    const big = options[options.length - 1];
    s.value = big; applyAppearanceSettings();
    await new Promise((r) => setTimeout(r, 300));
    const variable = getComputedStyle(document.documentElement).getPropertyValue('--ui-text').trim();
    s.value = '16px'; applyAppearanceSettings();
    await new Promise((r) => setTimeout(r, 300));
    return { big, variable, back: getComputedStyle(document.documentElement).getPropertyValue('--ui-text').trim() };
  });
  check('the chosen size becomes the one messages and the chat list are drawn in', size.variable === size.big && size.back === '16px', JSON.stringify(size));

  section('nothing threw');
  await page.evaluate(() => { document.getElementById('msgrSearchBtn').click(); });
  await page.waitForTimeout(400);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(700);
  const errors = [...page.__errors, ...phone.__errors];
  check('no script error on either screen', errors.length === 0, errors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
  await stacks.stop();
}
const bad = results.filter((r) => !r.ok);
console.log(`\n===== ${bad.length} failed of ${results.length} =====`);
process.exit(bad.length ? 1 : 0);

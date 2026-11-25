/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text. Section 13 matters here: run a modified
 * version as a network service and its users are entitled to your source.
 */

/* Native shell bootstrap — runs before the first paint so the standalone /
   mobile layout (and therefore the bottom tab bar geometry) is correct on
   frame 1 instead of only after window.load. */
(function () {
    var doc = document.documentElement;
    var ua = navigator.userAgent || '';
    var isIpadOs = (navigator.maxTouchPoints || 0) > 1 && /MacIntel/i.test(navigator.platform || '');
    var isIos = /iPad|iPhone|iPod/i.test(ua) || isIpadOs;
    var isStandalone = window.navigator.standalone === true
        || window.matchMedia('(display-mode: standalone)').matches
        || window.matchMedia('(display-mode: fullscreen)').matches
        || window.matchMedia('(display-mode: minimal-ui)').matches
        /* The native phone shell (Tauri iOS/Android) is an installed app in
           every way the pwa-standalone rules describe: launched from a home
           screen, outside a browser, carrying safe-area insets. Without this
           the phone build ran the browser-tab presentation — square panels,
           and a bottom tab bar only the chat tab could win back. */
        || (window.__POORIJA_NATIVE_SHELL__ === true && (isIos || /Android/i.test(ua)));
    /* `mobile-browser-context` drives ~900 stylesheet rules, and every one of
       them is written for a single-column phone screen. Deciding it from the
       user agent meant an iPad in landscape ran the phone layout at 1366px
       wide, while the stylesheet's own @media queries had already switched to
       the desktop one -- which is how the conversation list ended up hidden
       inside a grid column that was still 360px wide. Decide it from the same
       1024px breakpoint the CSS uses, so the two can never disagree again. */
    var isTouchDevice = isIpadOs || (navigator.maxTouchPoints || 0) > 0
        || /Android|webOS|iPhone|iPad|iPod|Mobile|CriOS/i.test(ua);
    var isMobile = window.innerWidth < 1024;
    doc.classList.toggle('pwa-standalone', isStandalone);
    doc.classList.toggle('mobile-browser-context', isMobile);
    doc.classList.toggle('touch-device', isTouchDevice);
    doc.classList.toggle('ios-device', isIos);
    /* The language screen has no `hidden` class in the markup, so on every
       launch it painted first and was only swapped for the password field once
       app.js reached checkFirstVisit() — the flash of the language chooser on
       the login screen. The choice is a single localStorage read, so make it
       here, before the first paint. */
    try {
        var storedLang = localStorage.getItem('poorija_lang');
        if (storedLang) {
            doc.classList.add('has-language');
            /* And the way the text runs: the markup says Persian, right to left,
               and an English visitor read the install screen backwards (full stops
               first) until the app had started. */
            doc.lang = storedLang;
            doc.dir = storedLang === 'fa' ? 'rtl' : 'ltr';
        }
    } catch (error) { /* storage blocked — app.js still decides after load */ }
    /* Paint the OS chrome (Android status/nav bar, iOS letterbox strip) in the
       saved theme colour immediately, so there is never a mismatched band. */
    try {
        var themeColors = {
            light: '#f8fafc', dark: '#0f172a', pastel: '#fffafa', midnight: '#0a0e27',
            neon: '#050505', dracula: '#282a36', nord: '#2e3440', solarized: '#fdf6e3',
            cyberpunk: '#0d0221', ocean: '#001f3f', forest: '#1e392a', aurora: '#06111f',
            sunset: '#2b0f54', linen: '#faf5ef', obsidian: '#050816'
        };
        var saved = localStorage.getItem('poorija_theme');
        var color = themeColors[saved];
        /* Not painted in the saved theme's colour: whatever the theme, the first
           screen is the language, install or password screen, and those are dark.
           A light theme painted its pale colour here, which was a white flash and
           a white strip above a dark screen. The theme's own colour is put on the
           page when the app opens (applyStatusBarColour); the classes below are
           still set now, so the variables are right when it does. */
        /* And the theme CLASS, before the first paint.
           Painting only the meta tag was half the job: html's own
           background-color is #f9fafb until setTheme() runs from app.js, which
           is after parse. On iOS the band behind the status bar is painted from
           the page background, so every cold start and every reload flashed a
           white strip across the top of a dark app — the "sometimes a white bar
           appears" report. Setting the class here means html is already the
           right colour when the first frame is composited. */
        var darkThemes = ['dark', 'midnight', 'neon', 'dracula', 'nord', 'cyberpunk',
                          'ocean', 'forest', 'aurora', 'sunset', 'obsidian'];
        /* Exactly the classes setTheme() knows how to take off again, so an
           early guess is never left behind when the theme is changed later.
           No inline background here: a style attribute on <html> would outrank
           every theme rule for the rest of the session. */
        var themeClasses = ['pastel', 'midnight', 'neon', 'dracula', 'nord', 'solarized',
                            'custom', 'cyberpunk', 'ocean', 'forest', 'aurora', 'sunset',
                            'linen', 'obsidian'];
        if (saved && color) {
            if (themeClasses.indexOf(saved) !== -1) doc.classList.add('theme-' + saved);
            if (darkThemes.indexOf(saved) !== -1) doc.classList.add('dark');
        }
    } catch (error) { /* storage blocked — the default theme colour stands */ }
})();

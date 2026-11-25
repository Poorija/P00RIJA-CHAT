/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text. Section 13 matters here: run a modified
 * version as a network service and its users are entitled to your source.
 */

    (function() {
        window.loadDeferredFonts = function() {
        const primaryFonts = [
        { family: 'B Yekan', url: 'fonts/BYekan.ttf' },
        { family: 'Roboto', url: 'fonts/Roboto/Roboto-Regular.ttf' },
        { family: 'Open Sans', url: 'fonts/Open_Sans/OpenSans-Regular.ttf' },
        { family: 'Lato', url: 'fonts/Lato/Lato-Regular.ttf' },
        { family: 'Tahoma', url: 'fonts/tahoma.ttf' }
        ];
        const secondaryFonts = [
        { family: 'Baloo Bhaijaan 2', url: 'fonts/Baloo_Bhaijaan_2/BalooBhaijaan2-VariableFont_wght.ttf' },
        { family: 'Beiruti', url: 'fonts/Beiruti/Beiruti-VariableFont_wght.ttf' },
        { family: 'El Messiri', url: 'fonts/El_Messiri/ElMessiri-VariableFont_wght.ttf' },
        { family: 'Handjet', url: 'fonts/Handjet/Handjet-VariableFont_ELGR,ELSH,wght.ttf' },
        { family: 'Harmattan', url: 'fonts/Harmattan/Harmattan-Regular.ttf' },
        { family: 'IBM Plex Sans Arabic', url: 'fonts/IBM_Plex_Sans_Arabic/IBMPlexSansArabic-Regular.ttf' },
        { family: 'Noto Naskh Arabic', url: 'fonts/Noto_Naskh_Arabic/NotoNaskhArabic-VariableFont_wght.ttf' },
        { family: 'Parastoo', url: 'fonts/Parastoo/Parastoo-VariableFont_wght.ttf' },
        { family: 'Playpen Sans Arabic', url: 'fonts/Playpen_Sans_Arabic/PlaypenSansArabic-VariableFont_wght.ttf' },
        { family: 'Rubik', url: 'fonts/Rubik/Rubik-VariableFont_wght.ttf' },
        { family: 'Zain', url: 'fonts/Zain/Zain-Regular.ttf' }
        ];
        const injectFonts = (fontList) => {
            let css = '';
            fontList.forEach(f => {
                css += `@font-face { font-family: '${f.family}'; src: url('${f.url}') format('truetype'); font-display: swap; }\n`;
            });
            const style = document.createElement('style');
            style.textContent = css;
            document.head.appendChild(style);
        };
        // Load primary fonts first
        injectFonts(primaryFonts);
        // Defer secondary fonts even further
        if ('requestIdleCallback' in window) {
            requestIdleCallback(() => injectFonts(secondaryFonts), { timeout: 2000 });
        } else {
            setTimeout(() => injectFonts(secondaryFonts), 1000);
        }
        };
        /* Smart viewport controller — measures REAL env() safe-area insets with a
           hidden probe element (JS cannot read env() directly) and publishes them
           as --pwa-safe-* custom properties. Re-measured on every resize/rotation,
           which also heals the iOS bug where env() resolves to 0 after navigation. */
        /* The CSS viewport units are the only other way to ask the engine how
           tall the viewport is, and they do not always agree with
           window.innerHeight. If any of them resolves LARGER than
           documentElement.clientHeight, that extra height is real, reachable
           viewport that a bottom:0 element is failing to use — which is
           exactly the shape of the band that has survived every fix so far.
           Measured, never assumed. */
        window.measureViewportUnits = function() {
            const doc = document.documentElement;
            let probe = document.getElementById('pwaUnitProbe');
            if (!probe) {
                probe = document.createElement('div');
                probe.id = 'pwaUnitProbe';
                probe.setAttribute('aria-hidden', 'true');
                probe.style.cssText = 'position:fixed;top:0;left:0;width:0;visibility:hidden;'
                    + 'pointer-events:none;z-index:-1;padding:0;margin:0;border:0;';
                (document.body || doc).appendChild(probe);
            }
            const read = (unit) => {
                probe.style.height = '100' + unit;
                const value = probe.getBoundingClientRect().height;
                return Math.round(value) || 0;
            };
            const units = { vh: read('vh'), dvh: read('dvh'), lvh: read('lvh'), svh: read('svh') };
            probe.style.height = '0';
            units.largest = Math.max(units.vh, units.dvh, units.lvh, units.svh, doc.clientHeight || 0);
            return units;
        };

        window.measureSafeInsets = function() {
            const doc = document.documentElement;
            let probe = document.getElementById('pwaSafeProbe');
            if (!probe) {
                probe = document.createElement('div');
                probe.id = 'pwaSafeProbe';
                probe.setAttribute('aria-hidden', 'true');
                /* The probe consumes env() ONLY through dedicated --probe-env-*
                   properties so it can never feed back on the published
                   --pwa-safe-* values it is measuring (rotation-safe). */
                probe.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;visibility:hidden;pointer-events:none;z-index:-1;'
                    + '--probe-env-top: env(safe-area-inset-top, 0px);'
                    + '--probe-env-bottom: env(safe-area-inset-bottom, 0px);'
                    + '--probe-env-left: env(safe-area-inset-left, 0px);'
                    + '--probe-env-right: env(safe-area-inset-right, 0px);'
                    + 'padding-top: var(--probe-env-top);padding-bottom: var(--probe-env-bottom);'
                    + 'padding-left: var(--probe-env-left);padding-right: var(--probe-env-right);';
                doc.appendChild(probe);
            }
            const cs = getComputedStyle(probe);
            const px = (value) => Math.max(0, Math.round(parseFloat(value) || 0));
            const top = px(cs.paddingTop), bottom = px(cs.paddingBottom);
            const left = px(cs.paddingLeft), right = px(cs.paddingRight);
            /* ---------------------------------------------------------------
               Window-mode guard.

               env(safe-area-inset-*) is the spec-correct source and it is
               AUTHORITATIVE whenever it reports anything at all: a non-zero
               inset means the viewport genuinely extends into the unsafe area,
               so the app must pay it. When the OS insets the window itself,
               env() correctly reports 0, because the viewport no longer
               reaches the unsafe area.

               The previous build second-guessed env() by comparing
               screen.height with window.innerHeight. That is not a usable
               signal on iOS: in a cover-fit standalone window WebKit
               under-reports innerHeight by exactly the top inset — a real
               reading from a 15 Pro Max was screen 932 / window 873 / env
               59 / 34, i.e. the window does cover the whole screen and the
               59px "missing height" is a measurement artefact. Reading that
               as a letterbox is what zeroed the notch clearance and dropped
               the header under the clock.

               The gap is therefore consulted ONLY when env() reports nothing,
               which is the one case where it still carries information:
                 • window shorter than the screen — the OS keeps the bands
                   outside the window, so the app owes nothing on either edge;
                 • window as tall as the screen — legacy black-translucent:
                   content renders under the status bar but no inset is
                   exposed, so the clearance has to be invented.
               --------------------------------------------------------------- */
            const units = window.measureViewportUnits();
            const ua = navigator.userAgent || '';
            const isIos = /iPad|iPhone|iPod/i.test(ua)
                || ((navigator.maxTouchPoints || 0) > 1 && /MacIntel/i.test(navigator.platform || ''));
            const isStandalone = window.navigator.standalone === true
                || window.matchMedia('(display-mode: standalone)').matches
                || window.matchMedia('(display-mode: fullscreen)').matches;
            const scr = window.screen || {};
            const portrait = window.innerHeight >= window.innerWidth;
            const physicalHeight = portrait
                ? Math.max(scr.width || 0, scr.height || 0)
                : Math.min(scr.width || 0, scr.height || 0);
            const longEdge = Math.max(scr.width || 0, scr.height || 0);
            const windowGap = physicalHeight > 0 ? physicalHeight - window.innerHeight : 0;
            const keyboardUp = doc.classList.contains('keyboard-open');
            const envReportsInsets = top > 0 || bottom > 0 || left > 0 || right > 0;

            /* Status-bar heights iOS uses in standalone, by device class. Only
               ever applied in the legacy mode below, where env() gives us
               nothing to work with but the clock really is painted over the
               app's own header. */
            const iosStatusBar = longEdge >= 852 ? 54 : longEdge >= 812 ? 47 : 20;

            let mode, usedTop = top, usedBottom = bottom;
            if (!isStandalone) {
                mode = 'browser';
            } else if (envReportsInsets) {
                mode = 'cover-fit';
            } else if (!keyboardUp && windowGap > 20) {
                mode = 'os-inset';
                usedTop = 0;
                usedBottom = 0;
            } else {
                mode = 'legacy-through';
                usedTop = isIos ? iosStatusBar : 0;
                usedBottom = 0;
            }
            const osInset = mode === 'os-inset';
            const insets = { top: usedTop, bottom: usedBottom, left, right };

            /* A measured 0 is never published as an inline value unless we are
               deliberately pinning it: iOS reports env() as 0 for a few frames
               after a navigation, and freezing 0px inline would permanently
               shadow the pure-CSS env() fallback declared on :root. */
            const publish = (name, value) => {
                if (value > 0) doc.style.setProperty(name, `${value}px`);
                else if (osInset) doc.style.setProperty(name, '0px');
                else doc.style.removeProperty(name);
            };
            publish('--pwa-safe-top', insets.top);
            publish('--pwa-safe-bottom', insets.bottom);
            publish('--pwa-safe-left', insets.left);
            publish('--pwa-safe-right', insets.right);
            doc.classList.toggle('safe-notched', insets.top > 24);
            doc.classList.toggle('safe-home-bar', insets.bottom > 12);
            doc.classList.toggle('ios-window-inset', osInset);
            /* Screen the web view was never given. <body> covers the view edge
               to edge, so <html>'s background only ever shows in exactly that
               band — painting it the tab bar's colour makes the bar read as if
               it continued to the physical bottom edge. */
            const visibleViewport = Math.max(
                Math.round(window.visualViewport?.height || 0), doc.clientHeight || 0);
            const withheldBand = physicalHeight > 0
                ? Math.round(physicalHeight - visibleViewport) : 0;
            doc.classList.toggle('os-band', withheldBand > 8);
            /* Kept for the on-device diagnostic in Settings. */
            window.__nativeShellMetrics = {
                standalone: isStandalone,
                mode,
                units,
                /* Everything the engine will admit to about the drawing area. */
                screenW: scr.width || 0,
                windowW: window.innerWidth,
                dpr: window.devicePixelRatio || 1,
                /* Screen minus LAYOUT viewport. Anything above zero is screen
                   the web view was never given, so no CSS can reach it. */
                outsideGap: physicalHeight > 0 ? Math.round(physicalHeight - doc.clientHeight) : 0,
                screen: physicalHeight,
                window: window.innerHeight,
                gap: windowGap,
                envTop: top, envBottom: bottom,
                usedTop: insets.top, usedBottom: insets.bottom
            };
            return insets;
        };
        window.updateViewportHeight = function() {
            const vv = window.visualViewport;
            const doc = document.documentElement;
            const isStandalone = window.navigator.standalone || window.matchMedia('(display-mode: standalone)').matches || window.matchMedia('(display-mode: fullscreen)').matches;
            const isIpadOs = (navigator.maxTouchPoints || 0) > 1 && /MacIntel/i.test(navigator.platform || '');
            /* Two different questions, and they used to share one answer:
               the soft keyboard is a property of the device, the single-column
               layout is a property of the viewport width. */
            const isMobileDevice = /Android|webOS|iPhone|iPad|iPod|Mobile|CriOS/i.test(navigator.userAgent || '') || isIpadOs;
            const isMobile = window.innerWidth < 1024;
            window.measureSafeInsets();
            const layoutHeight = Math.round(window.innerHeight || doc.clientHeight || 0);
            const visualHeight = Math.round(vv?.height || layoutHeight);
            const offsetTop = Math.max(0, Math.round(vv?.offsetTop || 0));
            const keyboardInset = Math.max(0, layoutHeight - visualHeight - offsetTop);
            const isKeyboardOpen = keyboardInset > 110;
            const vh = visualHeight * 0.01;
            doc.style.setProperty('--vh', `${vh}px`);
            /* While the keyboard is closed the pure-CSS 100dvh rules own the layout:
               stale JS pixel values are removed so they can never letterbox the app. */
            if (isKeyboardOpen) {
                doc.style.setProperty('--app-height', `${Math.max(320, layoutHeight)}px`);
                doc.style.setProperty('--app-window-height', `${Math.max(320, layoutHeight)}px`);
                doc.style.setProperty('--app-viewport-height', `${Math.max(320, visualHeight)}px`);
                doc.style.setProperty('--app-visual-height', `${Math.max(320, visualHeight)}px`);
            } else {
                ['--app-height', '--app-window-height', '--app-viewport-height', '--app-visual-height']
                    .forEach((prop) => doc.style.removeProperty(prop));
            }
            /* Always, keyboard or not, and under a name nothing else touches.
               --app-visual-height above is deliberately forced to 100dvh by the
               full-bleed rules whenever no keyboard is up, so a layer that has
               to end exactly where the keyboard begins cannot read it: with the
               keys up it is right, and the rest of the time it is the window.
               This one is only ever the measured visible height.
               (js/app.js carries the same logic; both copies have to agree, or
               whichever runs last undoes the other.) */
            doc.style.setProperty('--app-live-height', `${Math.max(320, visualHeight)}px`);
            /* iOS reports 100dvh SHORTER than the real standalone window: this
               project's own diagnostic came back vh=932 dvh=873 on an iPhone.
               Anything sized with dvh therefore stops ~60px above the bottom
               edge and leaves an empty band. Publish the measured window
               height so the shell can be anchored to the real thing. */
            doc.style.setProperty('--app-shell-height', `${Math.max(320, layoutHeight)}px`);
            doc.style.setProperty('--app-visual-offset-top', `${offsetTop}px`);
            doc.style.setProperty('--app-keyboard-inset', `${keyboardInset}px`);
            doc.style.setProperty('--mobile-keyboard-bottom', `${isMobileDevice && isKeyboardOpen ? keyboardInset : 0}px`);
            doc.style.setProperty('--keyboard-height', `${keyboardInset}px`);
            doc.style.setProperty('--keyboard-offset', isKeyboardOpen ? `${keyboardInset}px` : '0px');
            const wasKeyboardOpen = doc.classList.contains('keyboard-open');
            doc.classList.toggle('keyboard-open', isKeyboardOpen);
            doc.classList.toggle('pwa-standalone', isStandalone);
            doc.classList.toggle('mobile-browser-context', isMobile);
            doc.classList.toggle('touch-device', isMobileDevice || (navigator.maxTouchPoints || 0) > 0);
            if (isKeyboardOpen && !wasKeyboardOpen && document.activeElement) {
                if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA' || document.activeElement.id === 'chatComposer') {
                    setTimeout(() => {
                        const messages = document.getElementById('chatMessages');
                        if (messages) messages.scrollTop = messages.scrollHeight;
                        window.scrollTo(0, 0);
                    }, 100);
                }
            }
        };
        if (window.visualViewport) {
            window.visualViewport.addEventListener('resize', window.updateViewportHeight);
            window.visualViewport.addEventListener('scroll', window.updateViewportHeight);
        }
        window.addEventListener('resize', window.updateViewportHeight);
        window.addEventListener('orientationchange', () => setTimeout(window.updateViewportHeight, 200));
        window.addEventListener('load', window.updateViewportHeight);
        /* First measurement as early as the DOM allows, then two re-measurements:
           iOS frequently reports env() as 0 on the first frames of a standalone
           launch and only settles once the window has been handed to the app. */
        document.addEventListener('DOMContentLoaded', window.updateViewportHeight);
        window.addEventListener('pageshow', window.updateViewportHeight);
        window.addEventListener('load', () => {
            setTimeout(window.updateViewportHeight, 120);
            setTimeout(window.updateViewportHeight, 600);
            setTimeout(window.tryFullHeightViewport, 400);
            setTimeout(window.reassertViewportFit, 900);
            setTimeout(window.reassertViewportFit, 1800);
        });
        /* Some WebKit builds latch viewport-fit at the very first parse of the
           meta tag and keep the window short for the whole session. Replacing
           the tag with a brand-new element forces a fresh viewport evaluation,
           and the replacement is deliberately minimal — no extra viewport keys
           that an older WebKit might choke on before it reaches viewport-fit.
           Only ever runs when the window is measurably shorter than the screen,
           so a healthy full-screen launch is never disturbed. */
        window.tryFullHeightViewport = function() {
            const vv = window.visualViewport;
            const meta = document.querySelector('meta[name="viewport"]');
            if (!vv || !meta || meta.dataset.fullHeightTried) return;
            const scr = window.screen || {};
            const portrait = window.innerHeight >= window.innerWidth;
            const physical = portrait
                ? Math.max(scr.width || 0, scr.height || 0)
                : Math.min(scr.width || 0, scr.height || 0);
            if (!physical || physical - vv.height <= 20) return;
            meta.dataset.fullHeightTried = '1';
            const original = meta.getAttribute('content') || '';
            const before = Math.round(vv.height);
            meta.setAttribute('content', original + ', height=device-height');
            setTimeout(() => {
                const after = Math.round(vv.height);
                if (after <= before + 4) {
                    /* No gain: put the viewport back exactly as it was rather
                       than leave a non-standard key in place. */
                    meta.setAttribute('content', original);
                }
                window.__fullHeightResult = { before, after, kept: after > before + 4 };
                window.updateViewportHeight();
                window.syncTabBarAnchor();
            }, 240);
        };
        let viewportFitAttempts = 0;
        window.reassertViewportFit = function() {
            const doc = document.documentElement;
            if (viewportFitAttempts >= 2) return;
            const withheld = (window.__nativeShellMetrics || {}).outsideGap || 0;
            if (!doc.classList.contains('ios-window-inset') && withheld <= 20) return;
            const meta = document.querySelector('meta[name="viewport"]');
            if (!meta) return;
            viewportFitAttempts += 1;
            const fresh = document.createElement('meta');
            fresh.setAttribute('name', 'viewport');
            fresh.setAttribute('content',
                'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover');
            meta.parentNode.replaceChild(fresh, meta);
            /* Re-measure repeatedly: iOS resizes the window asynchronously and
               the class must clear itself once the window becomes full height. */
            [80, 300, 900, 2000].forEach((delay) => setTimeout(window.updateViewportHeight, delay));
        };
        document.addEventListener('focusin', (event) => {
            const target = event.target;
            if (!target || !target.matches?.('input, textarea, select, [contenteditable="true"]')) return;
            const syncFocusedField = () => {
                window.updateViewportHeight();
                if (target.id === 'chatComposer') {
                    const messages = document.getElementById('chatMessages');
                    if (messages) messages.scrollTop = messages.scrollHeight;
                    return;
                }
                if (document.documentElement.classList.contains('mobile-browser-context')) {
                    target.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
                }
            };
            setTimeout(syncFocusedField, 80);
            setTimeout(syncFocusedField, 260);
        });
        document.addEventListener('focusout', () => setTimeout(window.updateViewportHeight, 100));

        /* ---------------------------------------------------------------
           Tab-bar anchor — measure, do not assume.

           `position: fixed; bottom: 0` is supposed to land on the bottom edge
           of the layout viewport, but on this app it demonstrably does not on
           every iOS build: with the bar's own padding proven to be 0 there was
           still a band underneath it. Rather than keep guessing which ancestor
           or which viewport unit is short, the bar's real painted position is
           measured against documentElement.clientHeight and the difference is
           fed back as a negative bottom offset. The bar grows by the same
           amount at the TOP, so the labels stay on the bottom edge and the
           extra height simply bridges whatever the gap was.

           If the gap is instead OUTSIDE the layout viewport (the OS keeping a
           band for itself), this measures 0 and the diagnostic in Settings
           shows it under "outside viewport" — nothing in a web page can paint
           there.
           --------------------------------------------------------------- */
        window.syncTabBarAnchor = function() {
            const doc = document.documentElement;
            const bar = document.getElementById('mobileTabBar');
            if (!bar) return;
            if (getComputedStyle(bar).display === 'none') return;
            const current = parseFloat(doc.style.getPropertyValue('--tabbar-bottom-shift')) || 0;
            const rect = bar.getBoundingClientRect();
            if (!rect.height) return;
            /* The layout viewport, and nothing else. This used to take the
               LARGER of clientHeight and visualViewport.height, on the theory
               that the biggest number was the real drawing area. On a phone the
               visual viewport grows every time the browser's toolbars collapse
               during a scroll, so the bar was pushed down to chase them — and
               the shift accumulates, so it ratcheted until the bar sat below
               the screen and never came back. Secure Chat was the one place it
               survived, because that screen scrolls its own panes and never
               collapses the toolbars. position:fixed resolves against the
               layout viewport, so that is what the gap must be measured to. */
            const target = doc.clientHeight || 0;
            const gap = target - rect.bottom;
            window.__tabBarAnchor = {
                barBottom: Math.round(rect.bottom),
                layoutViewport: doc.clientHeight,
                target,
                insideGap: Math.round(gap),
                shift: current
            };
            if (Math.abs(gap) < 1) return;
            /* The ceiling used to be 96px, which is taller than the bar itself
               (62-70px). A shift that large could park the whole row below the
               screen, and on iOS it did. No real letterbox or home-indicator
               band is deeper than 48px, so past that the number is a runaway
               rather than a measurement. */
            const next = Math.min(48, Math.max(0, Math.round(current + gap)));
            if (Math.abs(next - current) < 1) return;
            if (next > 0) doc.style.setProperty('--tabbar-bottom-shift', next + 'px');
            else doc.style.removeProperty('--tabbar-bottom-shift');
            window.__tabBarAnchor.shift = next;
            /* Belt and braces: whatever the arithmetic just produced, the row
               of buttons has to stay reachable. The bar's own top edge never
               moves once the height grows with the shift, so the box is the
               wrong thing to test -- measure a button, which is what a finger
               actually aims at. If the row has been carried past the bottom of
               the drawable area there is no navigation left, so drop the shift
               entirely: a bar sitting slightly high is a cosmetic complaint, a
               bar nobody can reach is a broken app. */
            const probe = bar.querySelector('.mobile-tab-btn') || bar;
            const after = probe.getBoundingClientRect();
            if (after.bottom > (doc.clientHeight || 0) + 2 || after.top >= (doc.clientHeight || 0) - 8) {
                doc.style.removeProperty('--tabbar-bottom-shift');
                window.__tabBarAnchor.shift = 0;
                window.__tabBarAnchor.rescued = true;
            }
        };
        const scheduleAnchorSync = (fromResize) => {
            /* A resize means the old measurement is stale — the shift is
               cleared first so the loop re-converges from zero instead of
               adding to a number taken against a different viewport. */
            if (fromResize) document.documentElement.style.removeProperty('--tabbar-bottom-shift');
            requestAnimationFrame(() => window.syncTabBarAnchor());
            [120, 400, 1200].forEach((delay) => setTimeout(() => window.syncTabBarAnchor(), delay));
        };
        window.addEventListener('load', scheduleAnchorSync);
        window.addEventListener('resize', () => scheduleAnchorSync(true));
        window.addEventListener('orientationchange', () => setTimeout(() => scheduleAnchorSync(true), 250));
        document.addEventListener('DOMContentLoaded', scheduleAnchorSync);

        /* On-device display report. Lives in Settings next to the tab-bar
           customiser and is only offered on phones, where it is the fastest way
           to tell a full-screen launch apart from a letterboxed one without a
           desktop debugger attached. */
        /* ---------------------------------------------------------------
           Edge mode.

           On this device the platform contradicts itself: visualViewport and
           clientHeight both say the web view is 873px tall, while env() reports
           both a 59px top inset AND a 34px bottom inset — which only adds up if
           the view really does cover all 932px. One of the two is lying and
           nothing measurable from here can say which. Edge mode applies the
           difference as a downward offset and lifts the viewport's overflow
           clip so the bar can paint there; the user can see in one tap which
           reading was the true one. Off by default, remembered per device. */
        /* On a viewport wide enough for the sidebar (>=1024px, the same
           breakpoint the header's menu button uses) the bottom bar is
           redundant: every one of its tabs is already one click away in the
           sidebar. Default it off there and let the user opt back in. */
        const TABBAR_WIDE_KEY = 'poorija_tabbar_wide';
        window.applyTabBarWideMode = function() {
            const doc = document.documentElement;
            let on = false;
            try { on = localStorage.getItem(TABBAR_WIDE_KEY) === '1'; } catch (error) { /* blocked */ }
            /* The bar is phone-only now; the class is cleared rather than
               applied so a previously stored opt-in cannot resurrect it on a
               screen that already has the sidebar. */
            /* The sidebar is gone here: the bar is the only navigation, at
               every width, so the class stays on (js/messenger.js sets it). */
            doc.classList.add('tabbar-wide-on');
            void on;
            const box = document.getElementById('tabbarWideToggle');
            if (box) box.checked = on;
            const row = document.getElementById('tabbarWideRow');
            if (row) row.hidden = !window.matchMedia('(min-width: 1024px)').matches;
        };
        window.setTabBarWideMode = function(on) {
            try { localStorage.setItem(TABBAR_WIDE_KEY, on ? '1' : '0'); } catch (error) { /* blocked */ }
            window.applyTabBarWideMode();
            window.updateViewportHeight();
            window.syncTabBarAnchor();
        };
        document.addEventListener('DOMContentLoaded', () => window.applyTabBarWideMode());
        window.addEventListener('resize', () => window.applyTabBarWideMode());

        const TABBAR_EDGE_KEY = 'poorija_tabbar_edge';
        window.applyTabBarEdgeMode = function() {
            const doc = document.documentElement;
            const scr = window.screen || {};
            const portrait = window.innerHeight >= window.innerWidth;
            const physical = portrait
                ? Math.max(scr.width || 0, scr.height || 0)
                : Math.min(scr.width || 0, scr.height || 0);
            const visible = Math.max(
                Math.round(window.visualViewport?.height || 0), doc.clientHeight || 0);
            const shortfall = physical > 0 ? Math.round(physical - visible) : 0;
            /* Auto-engage ONLY in an installed standalone window. In a browser
               tab the viewport is legitimately short because Safari's own
               toolbars are sitting there, and pushing the bar into them would
               hide it behind browser chrome. The shortfall is also capped: a
               real OS band is a status bar or a home indicator, never 150px. */
            const isStandaloneWindow = window.navigator.standalone === true
                || window.matchMedia('(display-mode: standalone)').matches
                || window.matchMedia('(display-mode: fullscreen)').matches;
            const envTopNow = Math.round(parseFloat(
                getComputedStyle(doc).getPropertyValue('--pwa-safe-top')) || 0);
            /* Which end is the missing band at? An iPhone in a standalone
               window that does NOT cover the status bar is short by exactly
               the top inset -- 932 - 873 = 59, and env(safe-area-inset-top) is
               59 -- and that band is ABOVE the web view, where pushing the bar
               down reaches nothing. The web view's bottom edge is already the
               screen's bottom edge, so the shift has nothing to bridge and
               only carries the buttons out of sight. When the shortfall is
               accounted for by the top inset, that is the reading, and edge
               mode must not engage by itself. */
            const explainedByTop = envTopNow > 0 && Math.abs(shortfall - envTopNow) <= 2;
            const autoEligible = isStandaloneWindow
                && !doc.classList.contains('keyboard-open')
                && envTopNow > 0
                && !explainedByTop
                && shortfall > 8 && shortfall <= 70;
            let stored = null;
            try { stored = localStorage.getItem(TABBAR_EDGE_KEY); } catch (error) { /* blocked */ }
            const on = stored === '1' ? true : stored === '0' ? false : autoEligible;
            doc.classList.toggle('tabbar-edge', on);
            let edge = on ? Math.max(0, Math.min(70, shortfall)) : 0;
            if (edge > 0) doc.style.setProperty('--tabbar-edge-shift', edge + 'px');
            else doc.style.removeProperty('--tabbar-edge-shift');
            /* Whatever the reading -- auto, or a switch the user flipped once on
               a device that has since changed -- the row of buttons has to stay
               inside the visible viewport. Measure it after the shift is on;
               if it has left the screen, that answers the question the comment
               above could not, and the shift goes. */
            window.__tabBarEdge = { shortfall, envTop: envTopNow, explainedByTop, on, edge, rescued: false };
            if (edge > 0) {
                const probe = document.querySelector('#mobileTabBar .mobile-tab-btn');
                const seen = probe ? probe.getBoundingClientRect() : null;
                if (seen && seen.height && seen.bottom > (doc.clientHeight || 0) + 2) {
                    doc.classList.remove('tabbar-edge');
                    doc.style.removeProperty('--tabbar-edge-shift');
                    edge = 0;
                    window.__tabBarEdge.edge = 0;
                    window.__tabBarEdge.rescued = true;
                }
            }
            const box = document.getElementById('tabbarEdgeToggle');
            if (box) box.checked = doc.classList.contains('tabbar-edge');
            return edge;
        };
        window.setTabBarEdgeMode = function(on) {
            try { localStorage.setItem(TABBAR_EDGE_KEY, on ? '1' : '0'); } catch (error) { /* blocked */ }
            window.applyTabBarEdgeMode();
            window.updateViewportHeight();
            window.syncTabBarAnchor();
        };
        document.addEventListener('DOMContentLoaded', () => {
            window.applyTabBarEdgeMode();
            const row = document.getElementById('tabbarEdgeRow');
            const rootEl = document.documentElement;
            if (row && (rootEl.classList.contains('touch-device')
                || rootEl.classList.contains('mobile-browser-context')
                || rootEl.classList.contains('pwa-standalone'))) {
                row.hidden = false;
            }
        });
        window.addEventListener('resize', () => window.applyTabBarEdgeMode());

        window.toggleNativeShellDiag = function() {
            const body = document.getElementById('nativeShellDiagBody');
            if (!body) return;
            if (!body.hidden) { body.hidden = true; return; }
            window.updateViewportHeight();
            const m = window.__nativeShellMetrics || {};
            const doc = document.documentElement;
            const cs = getComputedStyle(doc);
            if (window.syncTabBarAnchor) window.syncTabBarAnchor();
            const anchor = window.__tabBarAnchor;
            const barEl = document.getElementById('mobileTabBar');
            const bar = barEl && barEl.offsetParent !== null ? barEl.getBoundingClientRect()
                : (barEl && getComputedStyle(barEl).display !== 'none' ? barEl.getBoundingClientRect() : null);
            const yes = (value) => value ? '✓' : '✗';
            body.textContent = [
                `standalone (PWA)   : ${yes(m.standalone)}`,
                `window mode        : ${m.mode}`,
                `screen height      : ${m.screen}px`,
                `window height      : ${m.window}px`,
                `window/screen gap  : ${m.gap}px  ${m.mode === 'os-inset' ? '← the OS keeps this band' : '(reporting artefact — ignored)'}`,
                `layout viewport    : ${doc.clientHeight}px`,
                `visual viewport    : ${Math.round(window.visualViewport?.height || 0)}px`,
                `viewport units     : vh=${m.units?.vh} dvh=${m.units?.dvh} lvh=${m.units?.lvh} svh=${m.units?.svh}`,
                `screen w x h       : ${m.screenW} x ${m.screen}   window w: ${m.windowW}   DPR: ${m.dpr}`,
                `env() top / bottom : ${m.envTop}px / ${m.envBottom}px`,
                `insets in use      : ${m.usedTop}px / ${m.usedBottom}px`,
                `bar box            : ${bar ? Math.round(bar.top) + '..' + Math.round(bar.bottom) : 'hidden'}`,
                `anchor target      : ${anchor ? anchor.target : '-'}px`,
                `gap inside viewport: ${anchor ? anchor.insideGap : '-'}px  (corrected by shift ${anchor ? anchor.shift : 0}px)`,
                `screen not visible : ${m.outsideGap}px  ${m.outsideGap > 0 ? '← outside the visible web view' : '(none — app fills the screen)'}`,
                `height=device-height: ${window.__fullHeightResult ? (window.__fullHeightResult.kept ? 'WORKED ' + window.__fullHeightResult.before + '->' + window.__fullHeightResult.after : 'no effect, reverted') : 'not needed'}`,
                `tab bar height     : ${cs.getPropertyValue('--tabbar-h').trim()} = ${bar ? Math.round(bar.height) : '-'}px`,
                `edge mode          : ${doc.classList.contains('tabbar-edge') ? 'ON, shift ' + (cs.getPropertyValue('--tabbar-edge-shift').trim() || '0px') : 'off'}${(() => {
                    const e = window.__tabBarEdge;
                    if (!e) return '';
                    if (e.rescued) return '  ← dropped: the buttons had left the screen';
                    if (e.explainedByTop) return `  (shortfall ${e.shortfall}px = top inset ${e.envTop}px — the band is above the view, nothing to bridge)`;
                    return '';
                })()}`,
                `tab row on screen  : ${(() => {
                    const btn = document.querySelector('#mobileTabBar .mobile-tab-btn');
                    if (!btn) return 'no bar';
                    const b = btn.getBoundingClientRect();
                    const inside = Math.round(Math.min(b.bottom, doc.clientHeight) - Math.max(b.top, 0));
                    return `${Math.round(b.top)}..${Math.round(b.bottom)} of ${doc.clientHeight} — ${inside}px of ${Math.round(b.height)} visible`;
                })()}`,
                `display-mode       : ${['fullscreen','standalone','minimal-ui','browser'].find((mode) => matchMedia(`(display-mode: ${mode})`).matches) || 'unknown'}`,
                `html classes       : ${doc.className}`,
            ].join('\n');
            body.hidden = false;
        };
        document.addEventListener('DOMContentLoaded', () => {
            const diag = document.getElementById('nativeShellDiag');
            /* Window geometry is a device question, so this must stay reachable
               on a wide tablet too -- that is precisely where it is needed. */
            const doc = document.documentElement;
            if (diag && (doc.classList.contains('touch-device')
                || doc.classList.contains('mobile-browser-context')
                || doc.classList.contains('pwa-standalone'))) {
                diag.hidden = false;
            }
        });
    })();

# The interface

P00RIJA Chat is laid out the way people already expect a messenger to be: a
list of conversations, a conversation with bubbles and a composer, a tab for
calls, a tab for groups, and Settings as rows with a tile for each icon. The
look follows Apple's iOS 26/27 system design (Liquid Glass for the bars, grouped
lists, springs for motion); the arrangement follows Telegram and WhatsApp.

Nothing about how the app works changed with the interface: the same scripts
send, receive, encrypt and call. Only what is drawn, and where, is new.

## What follows what

| Part | Takes from | Where |
|---|---|---|
| Bottom tab bar: Chats, Calls, Groups, Local, Settings | WhatsApp (five tabs) and Telegram (floating bar) | `js/messenger.js` |
| Large title, search field, filter chips above the list | WhatsApp (chat filters: All, Unread, Favourites, Groups) | `uiHead` in `js/messenger.js`, `css/ui/20-list.css` |
| A row: avatar, name, last message, time, unread count, pin | Telegram and WhatsApp | `js/chat/24-settings-panels.js`, `css/ui/20-list.css` |
| Long press or right click on a row for pin, mute, archive, lock, block | Both | `openRowMenu` in `js/messenger.js` |
| Bubbles with the time and ticks inside them, a wallpaper behind | WhatsApp | `css/ui/30-thread.css` |
| One tick sent, two delivered, two blue read; a clock while waiting | WhatsApp (their help page describes exactly this) | `css/ui/30-thread.css` |
| Composer: a plus for attachments, the field, then a microphone that becomes send once there is text | Both | `wireComposer` in `js/messenger.js` |
| Calls: history and contacts switch, filter chips, group call buttons | WhatsApp | `css/ui/40-calls.css` |
| Settings: the profile card first (P00RIJA Cryptography's own), then Devices; Notifications, Privacy and Security, Data and Storage, Appearance, Language, Server; Help, About; each row a page with a way back | Telegram's Settings | `js/messenger-settings.js`, `css/ui/50-settings.css`, `css/ui/55-pages.css` |
| Your profile on one page: picture, name, status, your identity, nothing that opens another page to edit | Telegram's profile | the `me` page in `js/messenger-settings.js` |
| Passcode, auto-lock, biometrics, two-step verification, the password and the emergency erase on one page; the old "shared lock" card is gone | Telegram's Privacy and Security | the `privacy` page |
| The bar's selection is a glass lens that slides, stretches and settles with a spring, and can be dragged | iOS 26/27 tab bar | `renderBar`, `placeLens`, `wireLens` in `js/messenger.js`, `css/ui/15-glass.css` |
| Text size and font reach the messages, the composer and the list | Telegram's Appearance (text size) | `followTextSize` in `js/messenger.js` (the `--ui-text` variable) |
| From 768px: tabs as a branded rail, the list and the conversation side by side | WhatsApp Desktop, Telegram Desktop | `css/ui/10-shell.css`, `css/ui/59-desktop.css` |
| From 1200px: an inset workspace, a bounded message column and a compact composer | Modern desktop productivity apps | `css/ui/59-desktop.css` |
| An empty conversation offers New chat and Search through the original controls | A useful empty state rather than a blank panel | `buildWelcome` in `js/messenger.js` |
| Cmd/Ctrl+K opens global search; shell tabs and menus support arrow keys, Home and End | Desktop keyboard navigation and accessible menus | `wireShellKeyboard`, `openMenu` in `js/messenger.js` |

Outgoing bubbles are on the right and incoming on the left in both writing
directions, as in both apps; everything else mirrors with the language.

## The adaptive workspace

Below 768px the app keeps the phone's single-pane navigation and floating glass
bar. From 768px the rail and both conversation columns stay visible; the list
width clamps so a tablet keeps a usable thread. From 1200px the workspace gets
an inset, a 24px corner and a soft shadow. The wide rail carries the existing
brand asset, a theme button wired to the original theme control, and a profile
button that opens the existing profile page. These controls own no state.

The desktop welcome state is additive DOM. It does not remove the original
header, messages or composer, and its two actions press the original new-chat
and search buttons. Popup menus expose `aria-expanded`, support arrow keys and
Home/End, and restore focus to their opener on Escape.

## Settings are views, not a second copy

`js/messenger-settings.js` draws the list and the pages, and owns no setting.
A switch, a choice or a field on a page is a view of the control the app already
had (its id, its listeners, the code that reads it): it shows the value and,
when changed, sets the original and fires its own change event. A button presses
the original. What is too large to rebuild (the relay's address and fingerprint,
the storage card, the list of devices) is moved into its page, node and listener
together. The settings of the encryption suite this app was cut from (algorithms,
the order of tabs, the desktop shell) are not on any page; the controls stay in
the document, out of sight, because code that reads the settings still names
them.

## The screens before the app

The language, install and first-password screens sit on a dark gradient in both
themes, so the card on them is dark glass in both (`css/ui/80-gate.css`); in the
light theme it used to turn white under white text.

## The design system

`css/ui/00-tokens.css` holds every colour, size and curve as a named token, in a
light and a dark set (`html.msgr` and `html.msgr.dark`). Components use the
names, never a colour. `css/ui/65-themes.css` maps the same semantic tokens for
seven additional selectable palettes: Ocean, Forest, Aurora, Sunset, Nord,
Solarized and Pastel. The rows in Appearance call the app's existing `setTheme()`
and persist through its own storage. A few that matter:

- `--tint` is the one colour the app uses for what you can press.
- `--bubble-out` and `--bubble-in` are the two sides of the conversation.
- `--glass-bg`, `--glass-edge`, `--glass-blur` make the glass of the bars. The
  glass is only ever the navigation layer (tab bar, bars, menus); the content is
  never glass. If the system asks for less transparency, or the browser has no
  blur, the bars become plain surfaces and stay readable.
- Light and dark follow the app's own theme switch; both are checked in the
  tests' screenshots.

## Why the stylesheet is built

The chat came out of an application with `css/styles.css`: 28,000 lines, more
than six thousand of them `!important`. A redesign cannot be written against
that by being a little more specific each time. Instead the sources in
`css/ui/` are plain CSS, and `tools/build-ui-css.cjs` turns them into
`css/chat-ui.css`: one CSS cascade layer in which every declaration is
`!important`. Among important declarations those in a layer beat those outside
one, whatever the specificity, so the new rules win once and for all.

```bash
node tools/build-ui-css.cjs           # writes css/chat-ui.css
node tools/build-ui-css.cjs --check   # fails if the built file is out of date
```

A property that a script sets inline (a drag, a slide) is written with `!normal`
in the sources so that the build leaves it alone; an inline style loses to an
`!important` rule and the motion would freeze.

## Directions and languages

Persian (right to left) and English (left to right) are both first-class. The
page's `dir` decides the layout; `css/ui/10-shell.css` removes the
`direction: rtl` that the old frame pinned on the chat whatever the language.
What is inside a bubble or in the composer follows its own text. Every rule in
`css/ui/` uses logical properties (`inset-inline`, `padding-inline`,
`margin-inline`) except where the layout is deliberately the same in both
directions (the side a bubble sits on).

## Looking at it

```bash
node tests/e2e/_shots-chat.mjs <dir> <tag>        # English, phone and desktop, light and dark
LANG_FA=1 node tests/e2e/_shots-chat.mjs <dir> fa # the same in Persian
node tests/e2e/_inspect.mjs 390 '<selector>'      # computed style of an element
SCHEME=light LANG_FA=1 node tests/e2e/_shots-states.mjs <dir> <tag>   # menus, sheets, every Settings page
node tests/e2e/_shots-gate.mjs <dir> <tag>        # the screens before the app
SCHEME=light node tests/e2e/_audit-contrast.mjs   # text under 3:1 on the screens and sheets
node tests/e2e/_check-font.mjs                    # does the font choice reach what is drawn
node tests/e2e/_dump-page.mjs data                # the element tree of one Settings page
```

`tests/e2e/messenger.mjs` checks the shell (the bar, the head of the lists, the
rows of Settings, the pages that are views of the app's own controls, the text
size, the widths) and fails on any script error.


## One set of controls

`css/ui/57-controls.css` is the single description of the buttons, switches,
checkboxes, colour wells and sliders. It names the old structures as well as the
new ones, so a control looks the same wherever it sits. A slider fills with the
tint as far as its knob: CSS cannot know the value, so `followRanges` in
`js/messenger.js` writes `--fill-pct` (declared `!normal`, or the layer's
`!important` would out-rank the inline value).

## Back and forward

The app moves between screens by showing and hiding, so the browser knew of one
page and the system's back (Android's gesture and button, a browser's arrow, iOS's
edge swipe) left the app. `js/nav-history.js` makes every screen change a history
entry and restores a screen on back and forward.

- A **screen** is: the app tab; in the chat, which list and, on a phone, which
  conversation; in Settings, the stack of pages (`PoorijaSettingsPages.stack()`).
  The shell calls `PoorijaNav.note()` at the end of `PoorijaMessenger.sync()`; it
  waits 80 ms for a gesture to settle and pushes one entry if the screen changed.
- What sits **on** a screen (a sheet, a photo or video viewer, a dialog, a menu, the
  start-chat modal, selection mode) is not a screen: a back with one open closes it and
  steps the browser forward again so nothing is added or lost (`closeTopOverlay`).
  A call in full screen goes to its small window; a back never ends a call.
- At the first screen there is no entry before it, so the same gesture leaves the app.
- The Android shell needs nothing of its own: wry's `WryActivity` registers an
  `OnBackPressedCallback` that calls `WebView.goBack()` while `canGoBack()`.
- iOS in a home-screen app or in the native shell has no edge swipe to history, so
  `wireEdgeSwipe` provides one (left edge to the right is back, right edge to the
  left is forward). It is on only there; elsewhere the system sends one and a second
  recogniser would run the move twice. Android's system gesture is back from either
  edge, so it has no forward.
- `app.js`'s `switchTab` leaves the address alone once this is running; it used to
  rewrite the entry the person was leaving.
- To add a screen: put what identifies it into `snapshot()` and what restores it into
  `applyScreen()`. To add an overlay: one line in `closeTopOverlay()`.
- Test: `tests/e2e/navfixes.mjs`.

## Seeing it on the platform

The layer is written for Safari first. Two diagnostics are not in the repository
because they need Xcode: a one-file WKWebView shell (scene lifecycle, the page
told it is standalone through `navigator.standalone`, a file the shell polls for
scripts to run) and a script that takes `simctl io screenshot`. A rule that
works in Chromium and loses in WebKit has happened (specificity of the time in a
bubble); look at WebKit before shipping a layout rule.

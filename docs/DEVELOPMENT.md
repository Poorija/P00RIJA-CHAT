# Working on it

## The shape of the code

| Where | What |
|---|---|
| `index.html`, `sw.js`, `manifest.webmanifest` | The page, the service worker (offline shell, push), the install manifest |
| `js/chat/NN-*.js` | The messenger, in **ordered** classic scripts that share one global scope: messages, groups, calls, files, stickers, devices. A top-level `function` is a property of `window` and can be wrapped; a top-level `const` (such as `chatState`) is in scope for the later scripts but is not on `window`. |
| `js/messenger.js` | The shell: the tab bar, the head of the lists, the menus, the microphone-or-send button. Loaded **last**. |
| `js/app.js`, `js/vault-profiles.js`, `js/crypto-core.js` | The vault, the lock, settings, languages |
| `js/local-link.js`, `js/local-mesh.js`, `js/local-room.js` | Chat and calls on the same Wi-Fi with no server |
| `css/styles.css` | The old frame's stylesheet, 28,000 lines; read-only in practice |
| `css/ui/*.css` → `css/chat-ui.css` | The interface ([docs/DESIGN.md](DESIGN.md)) |
| `scripts/server.js`, `scripts/lib/` | The relay and the monitor |
| `config/`, `docker/`, `standalone-relay/` | nginx, the compose stacks, the stand-alone relay |
| `tests/e2e/` | Playwright suites that drive real browsers against a real relay |
| `tools/` | Guards (`check-*.cjs`), the CSS build, the ML-KEM bundle, the panel |

## Running it

```bash
npm install
PORT=8123 npm run dev            # the static app on http://localhost:8123
MONITOR_PASSWORD='at-least-twelve-characters' npm run relay
```

The page talks to the relay at its own origin in production (nginx proxies
`/chat-signal` and the rest). Locally the relay listens on its own ports
(`11220`, `11221`) and the harness points the page at it.

## Checking it

```bash
npm run test:all     # the guards and the core suites
```

That runs `check:versions`, `check:assets`, `check:collisions`, `check:mlkem`, and
the suites for the shell, the key exchange, the prekeys, the downgrade, the
oracle and the hold policy. Every other suite in `tests/e2e/` is run on its own:

```bash
node tests/e2e/<name>.mjs
```

Three kinds, by what they need:

1. **Bring up their own relay** (those that import `_two-stacks.mjs`): nothing to
   start. `messenger`, `chatonly`, `hybrid`, `holdhybrid`, `delivery`, `siblingsync`,
   `receipts`, `sealedsender`, `interop` and most of the newer ones.
2. **Want the page and the relay on one origin** (older ones: `groups`,
   `grouplife`, `groupparity`): run them through the stack that serves both:
   `E2E_PORT=8261 node tests/e2e/_local-stack.mjs groups grouplife groupparity`.
   Run with a separate static server and relay they all fail at the first thing
   that needs the network; that is the setup, not a regression.
3. **Want a private relay with its data in a directory** (`forwardsecrecy`,
   `offline`): start `scripts/server.js` with `CHAT_DATA_DIR`,
   `CHAT_OFFLINE_STORE_PATH` and `MONITOR_PASSWORD` set, a static server for the
   tree, and give the suite `PKG_URL`, `PKG_RELAY`, `RELAY_URL` and the same two
   paths.

Do not edit a served file while a suite runs; the suites load the working tree.

A failing suite is the evidence: the security suites each play the attacker and
failed before the fix they cover. Write the failing test first.

## The stylesheet

```bash
node tools/build-ui-css.cjs           # css/ui/*.css  →  css/chat-ui.css
node tools/build-ui-css.cjs --check   # CI: is the built file current?
```

## Versions

One number, in many places, and a guard that checks they agree
(`npm run check:versions`): `package.json`, `standalone-relay/package.json`,
`sw.js`, `index.html` (every `?v=` query), `js/app.js`, `scripts/server.js`,
`config/relay-overrides.json`, `README.md`, and the head of `RELEASE-NOTES.md`.
The build tag (`chat-vN`) goes up with every release so that browsers and the
service worker fetch the new files. A release is a commit of the change and then
a commit that only moves the version.

## Looking at the interface

`tests/e2e/_shots-chat.mjs` and `_inspect.mjs` ([docs/DESIGN.md](DESIGN.md)).

## Deploying

[INSTALL-LINUX-SERVER.md](../INSTALL-LINUX-SERVER.md): `bash scripts/deploy.sh`,
then `bash scripts/deploy.sh --check`. The exit code of a deploy is not a
verdict: read the check.

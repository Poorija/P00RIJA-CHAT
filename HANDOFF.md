# Handoff

For the next person, or the next AI agent, to pick this up without asking.

Package version: **2.17.1** (build chat-v35).

## What this is

An end-to-end encrypted messenger: one-to-one chat, groups, voice and video
calls (one-to-one and group), files, and chat on the same Wi-Fi with no server.
A web app that installs as an app, and a relay you run yourself. It was cut out
of P00RIJA Cryptography and is independent of it: its own repository, port
(1122), containers, settings directory (`~/.config/p00rija-chat/`) and releases.
The two apps still talk to each other through one relay (`tests/e2e/interop.mjs`);
between them the key exchange is the classical one, because P00RIJA Cryptography
has no post-quantum half.

Read, in this order: [README.md](README.md), [docs/PROTOCOL.md](docs/PROTOCOL.md),
[docs/DESIGN.md](docs/DESIGN.md), [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Things that cost a day each

- **The scripts share one scope.** `js/chat/NN-*.js` are classic scripts loaded in
  order. Top-level `const`/`let` is visible to later scripts and is *not* on
  `window`; function declarations are on `window` and can be wrapped
  (`window.name = function …`), which is how `js/messenger.js` follows the chat's
  own functions. `js/messenger.js` must be the **last** script tag.
- **The old stylesheet wins every ordinary argument.** Do not edit
  `css/styles.css` to change how something looks; add to `css/ui/` and rebuild
  (`node tools/build-ui-css.cjs`). The built file is one cascade layer of
  `!important` rules, which beats the old ones regardless of specificity. A
  property a script sets inline needs `!normal` in the source.
- **The old frame pinned `direction: rtl`**, so an English chat was laid out right
  to left. `css/ui/10-shell.css` undoes it. Use logical properties.
- **A hidden element must stay in the page.** The chat holds many controls by id
  (the buttons on a row, the old toolbar, the settings panes). Hide them with CSS;
  do not delete the markup until the code that wires them is gone too. The row
  menu, the head of the list and the microphone button press the originals.
- **A suite that fails in bulk at its first network step is the setup**
  ([docs/DEVELOPMENT.md](docs/DEVELOPMENT.md): three kinds of suite). Compare with
  `git stash` before calling anything a regression.
- **Never edit a served file while a suite runs**, and never run two suites on
  one port.
- **A deploy's exit code is not a verdict.** Run `bash scripts/deploy.sh --check`.
- **Compose project names.** `name: p00rija-chat` is set in the compose files and
  the scripts pass `-p p00rija-chat`. A project named after its folder (`config`)
  would be taken by compose for any other stack in a folder of that name on the
  same host and recreated under this one's settings. Keep the name fixed.

## Rules of the house

- Commits are authored and committed as `p00rija <p00rija@tutamail.com>`, with no
  trailer and no mention of a tool. A release is the change, then a commit that
  only moves the version (`release: X.Y.Z — …`).
- A security fix is a test that fails first (the attacker played in a browser),
  then the fix. The existing ones are the pattern: `downgrade`, `prekeysig`,
  `oracle`, `holdhybrid`.
- Both languages for every string that a person reads: `t('persian', 'english')`.
- A message sealed to a contact who can do better is held, not sent weaker
  (`prekeyHybridOwed`); do not add a path that seals around it.

## Where it stands

Done: the interface, the key exchange with ML-KEM-768, hybrid prekeys for offline
messages, signed prekeys, no downgrade, the hold policy, the monitor, the
installer, deployment on its own ports. Not done, and written down so nobody
assumes otherwise:

- The code of the tools that were cut out (secret sharing, Argon2, file encryption,
  the password manager) is still in `js/app.js` and `js/advanced-crypto.js`, only
  reached from controls that are gone. `tools/audit-dom.removed.txt` lists the ids it
  still names; the DOM audit reports them as leftovers and fails on any new one.
  Cutting the code and the list down together is a job of its own.
- A key per message (double ratchet). One key per connection today.
- MLS for large groups; a group message is sent to each member separately.
- Native shells (Tauri for desktop, Android, iOS). They need their own bundle
  identifier, icons and signing, or an install would replace the other app's.
- An independent security audit.
- A first prekey from a relay that leaves out the second half is accepted until
  the contact has been seen with both ([docs/PROTOCOL.md](docs/PROTOCOL.md)).

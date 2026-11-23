# The monitor

Every relay serves a dashboard for the person who runs it. It shows who is
connected, what is waiting in the mailboxes, how the machine is doing, and lets
the operator act: suspend a device, flush a mailbox, link to another relay, take
a backup, update the stack. It reads the same relay the app talks to; nothing in
it can see a message, because the relay holds none in the clear.

## Reaching it

```
https://YOUR-SERVER:1122/Monitor_Server
```

- User name: `admin`, or what `MONITOR_USER` is set to in `.env`.
- Password: `MONITOR_PASSWORD` from `.env`, at least twelve characters. The relay
  **refuses to start** without one; there is no built-in default and no recovery.
  Change it from the dashboard (System) or in `.env` and restart the relay.
- Three wrong guesses lock the login for ten minutes. A session lasts while it is
  used.

The relay's own plain-HTTP ports (`11220`, `11221`, `11222`) answer only the
machine they run on and the proxy in front of them; they are not for the
internet.

## What is on it

| Surface | What it is for |
|---|---|
| **Overview** | Connected devices, CPU, memory (of the container, against its limit), disk, queue, transit; live charts for devices, CPU, memory, messages per second, network and disk; why anything was dropped. |
| **Queues** | The offline mailboxes: one line per recipient (how many, how big, oldest, newest). Open one to see metadata only, delete one item or the whole mailbox, or deliver at once to whoever is connected. The expiry ledger says what was removed, when and why. |
| **Users** | Connected devices with search by name, id or address; suspend or kick for a time or for good; an allowlist; a broadcast to everyone (online, offline and by push). |
| **Relays** | Links to other relays: status, role, traffic per link; add or remove one without a restart (kept across restarts in `data/transit-peers.json`). |
| **Traffic** | Totals, the busiest devices, traffic per relay link. |
| **Machine** | Backups (create, list, download, restore with an automatic safety backup, delete); memory and CPU limits per container, applied live; disk use and cleaning of old images; Docker image updates; a check for a new release and applying it with a safety backup and a one-click rollback. |
| **Reports** | Live calls (one-to-one and group, with start times); activity across relays; hourly traffic for 48 hours; an event stream; CSV and JSON export. |
| **Bootstrap** | The installer another machine can fetch (below). |
| **System** | Node, host, load; whether TURN is on and its addresses; the relay's identity with a copy button; free memory; change the password; the live log. |

It speaks Persian and English, in four themes (dark, light, ocean, midnight), with
refresh from one second to manual. Keys 1 to 8 switch surface and R refreshes.

## Putting the stack on another machine

The relay can serve an installer for itself, on its own port (`11222`, or `0` in
`CHAT_BOOTSTRAP_PORT` to switch it off):

```bash
curl -sSL http://YOUR-SERVER:11222/install | bash -s -- http://YOUR-SERVER:11222 <token> ~/p00rija-chat
```

The token is made on the Bootstrap surface and is single-purpose. What is
fetched is the application and the stack, with **no data, no identity and no
secret** from the server it came from: the new machine makes its own.

## Several servers

`tools/relay-directory.mjs` and the panel in `tools/panel/` keep the list of
servers you run and the links between them. See [RELAY-NETWORK.md](RELAY-NETWORK.md).
`bash scripts/deploy.sh --check` asks each server what build it is serving and
whether it is healthy, without changing anything.

## Health for other tools

| Path | Answers |
|---|---|
| `/chat-health` | `{"ok":true,"version":…,"buildTag":…}` and the state of transit links |
| `/ready`, `/live` | readiness and liveness for a container manager |
| `/relay-identity` | the relay's public key and its name (the hash of that key) |

All three are served on the app's own port and need no login.

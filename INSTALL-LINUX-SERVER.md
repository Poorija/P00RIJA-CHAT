<img src="assets/pwa-icons/icon-192.png" alt="P00RIJA Chat" width="72" align="right">

# Running the server

This is the server package of P00RIJA Chat v2.16.6, and a P00RIJA Chat server is four containers: the **app** (nginx, serving the web
app over HTTPS), the **relay** (messages waiting for people who are away, call
signalling, push, the monitor), **coturn** (the TURN server that carries a call
when two devices cannot reach each other), and a **certificate renewer**. It is
independent of any other stack on the machine: its own project name
(`p00rija-chat`), container names (`P00RIJA-Chat_*`), network and ports.

> More than one server, or calls that should take a short path through a TURN
> server near your users: [docs/RELAY-NETWORK.md](docs/RELAY-NETWORK.md).

## Ports

Chosen so that it can sit beside another stack on the same machine.

| Port | Protocol | What | Open to the internet |
|---|---|---|---|
| **1122** | TCP | The app, the relay behind it, the monitor (`/Monitor_Server`) | yes |
| 1123 | TCP | A second relay's front door, only if this server keeps one | no, loopback |
| 11478 | TCP and UDP | TURN | yes, for calls |
| 11349 | TCP | TURN over TLS | yes, for calls |
| 40000 to 40500 | UDP | TURN relay range | yes, for calls |
| 11220, 11221, 11222 | TCP | The relay's own ports: signalling, presence, the installer | **no**: this machine and the proxy only |
| 80 | TCP | Let's Encrypt, only while a certificate is being issued | during issuing |

If the machine has a firewall, open the rows marked yes. Without the TURN rows
calls still connect directly whenever the two devices can reach each other.

## One line

On a bare Linux server, as root or with sudo — Git, Docker, the certificate and the
containers are all done for you:

```bash
curl -fsSL https://raw.githubusercontent.com/Poorija/P00RIJA-CHAT/main/install.sh | sudo bash
```

It offers an **easy install** (where people reach the server: a domain, the public
IP or this network only; an e-mail for Let's Encrypt; the port) or the **custom
install** (the full wizard), in Persian or English, and looks for a certificate for
your domain that another program already keeps (3X-UI, certbot, acme.sh) before it
issues one. Options such as `--domain`, `--ip`, `--local`, `--port`, `--letsencrypt`,
`--self-signed`, `--cert-dir`, `--version`, and the `update`, `status` and
`uninstall` commands are listed at the top of [install.sh](install.sh) and in the
[README](README.md#install-the-server). The rest of this page is the same thing by
hand.

## A new server

You need Docker with the compose plugin, a name that points at the machine (or
just its address, with a self-signed certificate), and about 1.5 GB of free disk
for the images.

```bash
cp .env.example .env
nano .env                       # DOMAIN, MONITOR_PASSWORD, TURN_USER, TURN_PASSWORD, EXTERNAL_IP
npm run setup:server:linux
```

or the interactive wizard, which asks for each of those and starts everything:

```bash
npm run setup
```

What `.env` needs, at least:

| Variable | What |
|---|---|
| `DOMAIN` | The name clients type, which the certificate must match. |
| `MONITOR_PASSWORD` | The monitor's password, twelve characters or more. The relay will not start without it. |
| `TURN_USER`, `TURN_PASSWORD` | For coturn. With `TURN_SECRET` (64 hex characters, `openssl rand -hex 32`) the relay hands out credentials that expire instead. |
| `EXTERNAL_IP` | The public address coturn advertises. `127.0.0.1` only for a trial on one machine. |
| `CERTS_DIR` or `SSL_CERT_PATH` and `SSL_KEY_PATH` | Where the certificate is. A folder that another program already keeps (for example `/root/cert/<domain>/`) is read in place. |

The certificate renewer can ask Let's Encrypt for one or make a self-signed one;
a self-signed certificate works for a LAN or an address, but a browser has to be
told to trust it before it will register the service worker or start a call.

## From the machine you work on

`scripts/deploy.sh` copies this tree to each server you list, rebuilds there and
checks that what is served is what was sent. Nothing about a server is in the
repository: the settings are in `~/.config/p00rija-chat/deploy.conf`, owner-only.

```bash
bash scripts/deploy.sh --help
bash scripts/deploy.sh --server fl     # one server
bash scripts/deploy.sh                 # every server in deploy.conf
bash scripts/deploy.sh --check         # ask each what it serves; change nothing
bash scripts/deploy.sh --dry-run       # what would be copied
```

A server with no `.env` yet is installed first: the domain, the certificate (one
that is already there, a new one from Let's Encrypt, or self-signed) and the
e-mail are asked, or given with `--domain`, `--email`, `--cert` and `--yes`.
A server that cannot reach Docker Hub is built here and sent: `--prebuilt`.

## Updating

Extract the new package over the old folder, or deploy again. Then, on the server:

```bash
bash scripts/setup.sh --update-server
```

An update keeps `.env`, `certs/`, the Docker volumes and everything under
`data/chat-signal/` (the mailboxes, the policy and the relay's identity), and
writes a timestamped backup under `backups/` first.

From 2.10 the relay keeps its state in one SQLite database,
`data/chat-signal/state.db` (WAL mode, Node's own `node:sqlite`): the mailboxes,
the copies held for linked devices, the device beacons and rosters, the push
subscriptions, the policy, the self-destruct records, the expiry log, the
identity moves, the known identities and the key-transparency log. On the first
start of 2.10 each store is imported from its old JSON files in one
transaction, and the files are left in place, renamed `*.imported`; nothing is
deleted. To go back to 2.9, stop the relay, rename the `.imported` files back
(drop the suffix) and start 2.9; or set `CHAT_STATE_DB=off` in `.env` to keep a
2.10 relay on the JSON files. A backup of `data/chat-signal/` taken while the
relay is stopped carries the whole state in `state.db`; taken while it runs,
copy `state.db`, `state.db-wal` and `state.db-shm` together.

## By hand

```bash
docker compose --env-file .env -f config/docker-compose.yaml up -d --build
```

## Where things are

- The app: `https://DOMAIN:1122`
- The monitor: `https://DOMAIN:1122/Monitor_Server` ([docs/MONITOR-SERVER.md](docs/MONITOR-SERVER.md))
- Health: `https://DOMAIN:1122/chat-health`
- TURN settings the app reads: `https://DOMAIN:1122/turn-config`

The server never receives a message in the clear or a key that opens one. It
holds what is waiting for people who are away, sealed; who is connected; and
the control data for messages that destroy themselves (a time, a number of
views). [docs/PROTOCOL.md](docs/PROTOCOL.md) says what that means.

## The Telegram bot (alerts, server status, sticker packs)

One bot does both jobs, and its token belongs in `.env` of **one server outside
the country that blocks Telegram**; every other server hands its alerts to that
one over the relay link and asks it for sticker packs.

```
# on the server that can reach Telegram
TELEGRAM_BOT_TOKEN=<the token BotFather gave>
CHAT_ALERT_TELEGRAM_CHAT_ID=<your chat id, or the id of a group the bot is in>

# on every other server
TELEGRAM_STICKERS_UPSTREAM=https://<the first server>:1122
```

Get the chat id by sending the bot `/start` (or any message) and reading
`getUpdates`; the central panel's Telegram page changes the rest (what is sent,
quiet hours, thresholds) while the relay runs. The token is never put in the
repository, and a token pasted anywhere else should be revoked in BotFather
(`/revoke`) and replaced.

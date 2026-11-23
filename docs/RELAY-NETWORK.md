# More than one server

One relay is enough for a group of friends. More than one is for reach and for
resilience: people on different servers still talk to each other, a server that
is blocked or down does not take the conversation with it, and a TURN server
near the people calling makes the call shorter.

## What links them

Two relays that have been introduced to each other (the **Relays** surface of the
monitor, or `scripts/link-relays.sh`) carry each other's traffic:

- A message for somebody who is on another relay goes across as a **transit
  envelope**, sealed to the other relay's key. The first relay cannot read what
  it forwards; the second cannot read it either, because the message inside is
  sealed to the recipient.
- Each relay has an identity: a key pair, and a name that is the hash of the
  public key (`/relay-identity`). A name cannot be claimed without the key.
  Links are made between relays that have proved who they are, and the
  key exchange between relays has an ML-KEM-768 half as the app's has.
- A device knows its *home* relay. When the person it wants to reach is on
  another, the app finds the route (`40-route-finder.js`), parks the message at
  the relay that has been seen to reach them, and withdraws the copy once it is
  delivered.
- Several addresses can name the same relay (**mirrors**), so that a device can
  open a socket to another when the main name is blocked; the page's
  content-security policy lists them (`CHAT_MIRROR_ORIGINS`).

## Roles

A server is one of two kinds, set per server in `deploy.conf` (`<NAME>_ROLE`):

| Role | What is on it | Trust |
|---|---|---|
| `app` | The whole stack: it serves the web app **and** relays. | It serves the JavaScript that does the encrypting, so people have to trust it as they would the author. |
| `relay` | `standalone-relay/` only: it carries traffic and runs TURN, serves no app. | Carries ciphertext; cannot change the code anyone runs. |

## Clusters

A server can belong to a **cluster** (`<NAME>_CLUSTER`, `<NAME>_REGION`). A
cluster whose members can reach each other directly keeps working when its link
to the rest of the internet is cut: the members find each other by their
**inside** addresses (`<NAME>_INSIDE`) instead of through the outside. A
gateway order (`<NAME>_GATEWAY`) says which member of a cluster speaks for it to
the others.

## Settings in `deploy.conf`

```
SERVERS='fl ir de'              # every server, in the order they are done
FL_ROLE='app'
FL_SSH_HOST='fl.example.com'    # and _SSH_USER, _SSH_PORT, _SSH_KEY
FL_REMOTE_DIR='/home/deploy/work/p00rija-chat'
FL_PUBLIC_URL='https://fl.example.com:1122'
FL_CLUSTER='Outside'            # a name; servers with the same name are one cluster
FL_REGION='outside-iran'
FL_GATEWAY='1'
IR_INSIDE='https://203.0.113.5:1122'   # how the cluster's other members reach it
IR2_JUMP='ir3'                  # reach this server through another one
```

`_JUMP` is for a path from your machine to one server that is slow while the path
between two servers is not: the hop only forwards the connection and holds no key
for the target.

## Where TURN belongs

A call goes through TURN only when the two devices cannot find a direct path.
Put coturn on a server whose address both callers can reach, in the region the
callers are in: a TURN server across a border adds the border to every call.
Each `app` server runs its own and tells its own clients (`/turn-config`); a
`relay` server is for exactly this.

## Watching all of it

- `bash scripts/deploy.sh --check` asks every server what it serves.
- The monitor on each server shows its links and their traffic.
- `tools/panel/` is a central panel for a family of servers: their state, the
  links between them, and the deploy settings. `bash scripts/panel.sh` starts it.

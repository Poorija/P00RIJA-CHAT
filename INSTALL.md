<img src="assets/pwa-icons/icon-192.png" alt="P00RIJA Chat" width="72" align="right">

# Using P00RIJA Chat

P00RIJA Chat is a web app that installs like an app. You need nothing but a
server that runs the relay (yours, or one somebody gave you the address of) and a
modern browser: Safari 16.4 or later, Chrome or Edge 105 or later, Firefox 115 or
later.

Running the server is in [INSTALL-LINUX-SERVER.md](INSTALL-LINUX-SERVER.md).

## Open it

Go to the address of your server, which ends in the port the app runs on:

```
https://your-server.example.com:1122
```

## Put it on the home screen

An installed app opens in its own window, keeps its place when you switch away,
receives notifications, and works from the home screen without the browser's bars.

| Where | How |
|---|---|
| iPhone, iPad (Safari) | Share, then **Add to Home Screen**. Notifications work from iOS 16.4 and only from the home-screen app. |
| Android (Chrome) | The menu, then **Install app** (or **Add to Home screen**). |
| Windows, macOS, Linux (Chrome, Edge) | The install icon at the end of the address bar, or the menu, then **Install P00RIJA Chat**. |

## The first time

1. **Choose a language.** Persian and English are both complete; you can switch in
   Settings at any time.
2. **Make a master password.** It encrypts everything stored on this device. There
   is no way to recover it: forget it and the stored conversations are gone. A
   second, different password opens a decoy profile, for the day you are made to
   unlock the phone.
3. **Your identity is made for you.** It is a key pair; the part you share with
   others is a short card or a QR code, in **Settings, then your name at the top**.

## Adding someone

Both of you do one of these (it takes one side only to start a conversation, but
each side needs the other's card to be sure who it is):

- **Scan** each other's QR code, in person. This is the safest way: you know it is
  them.
- **Send a card** through anything (another messenger, e-mail) and open it. Then
  compare the *safety number* (the emoji key in the conversation's menu) over a
  call, to be sure the card was not changed on the way.
- **A link** with the card inside, from the same menu.

## Writing

- The pencil at the top of **Chats** starts a conversation; the people icon on
  **Groups** makes a group.
- The **+** beside the field attaches: stickers, GIFs, a poll, a location (once
  or live), a contact card, a file, a photo or video, a scheduled message, a
  hidden message, a message that destroys itself after a time you choose.
- The **microphone** at the end of the field records a voice message; it becomes
  **send** as soon as you type.
- A long press (or a right click) on a conversation in the list: pin, mute,
  archive, mark unread, lock with a PIN, block, export.
- One grey tick: sent. Two grey: delivered. Two blue: read. A clock: waiting to go.

## Calling

Open a conversation and press the **phone** or the **camera** at the top. A call
goes directly between the two devices when it can and through the server's TURN
relay when it cannot; either way it is encrypted between you. On a group, the
same buttons start a group call. While you talk the emoji key on both screens
should show the same pictures.

The **Calls** tab keeps the history, with the missed ones first if you filter for
them, and lets you call back from there.

## Without a server

**Local** (the tab beside Settings) chats and calls with people on the same Wi-Fi
with no server at all: one device shows a code, the other scans it.

## Notifications

On **Settings, then Connection and chat settings**, allow notifications. Where the
browser supports it you are notified of a message while the app is closed; the
notification says only that something arrived, not from whom or what. On Android
without Google services, UnifiedPush works with a distributor such as ntfy.

## Locking

**Settings, Lock the app** locks everything at once. Each conversation can have a
PIN of its own as well (long press it in the list). The app locks by itself after
the time you set.

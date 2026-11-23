# P00RIJA Chat

End-to-end encrypted chat, voice and video calls, and groups: the app, a relay
with post-quantum relay links, calls through TURN, and a monitoring dashboard.
Free software (AGPL-3.0).

Source code, documentation and releases: https://github.com/Poorija/P00RIJA-CHAT

## Images

- `poorija/p00rija-chat-app`: the app over HTTPS.
- `poorija/p00rija-chat-relay`: the relay (messages, calls, dashboard).
- `poorija/p00rija-chat-cert-renewer`: the TLS certificate (Let's Encrypt or self-signed).
- `poorija/p00rija-chat-panel`: the central panel for all your servers.

Tags: the version (for example `2.98.84`) and `latest`, for linux/amd64 and
linux/arm64.

## A server in one line

```bash
curl -fsSL https://raw.githubusercontent.com/Poorija/P00RIJA-CHAT/main/scripts/docker-install.sh | bash
```

The installer asks for a domain (or uses the server's IP), then starts
everything.

- Default ports: 1122 (app and dashboard), 11478 udp/tcp and 11349 (TURN),
  40000–40500/udp (TURN relay), and 80 (Let's Encrypt only).
- Dashboard: `https://<domain>:1122/Monitor_Server`.
- User: `admin`. The password is random, made on the first start, and shown by
  the installer and in `docker logs P00RIJA-Chat_ChatSignal`. Change it
  in the dashboard.

## The central panel

```bash
curl -fsSLO https://raw.githubusercontent.com/Poorija/P00RIJA-CHAT/main/scripts/panel.sh && bash panel.sh
```

It asks:
- the port;
- the address (this computer only, or the LAN);
- whether it should start whenever Docker starts.

The login (password and TOTP code) is yours to make.

Full guide: https://github.com/Poorija/P00RIJA-CHAT#readme

---

## فارسی

مجموعهٔ رمزنگاری آفلاین‌محور و پیام‌رسان رمزنگاری‌شدهٔ سرتاسری. شامل برنامه،
رله با لینک‌های پساکوانتومی، تماس از راه TURN و داشبورد مانیتورینگ. نرم‌افزار
آزاد (AGPL-3.0).

**یک سرور با یک خط:**

```bash
curl -fsSL https://raw.githubusercontent.com/Poorija/P00RIJA-CHAT/main/scripts/docker-install.sh | bash
```

- نصب‌کننده دامنه را می‌پرسد، یا از IP سرور استفاده می‌کند.
- پورت‌های پیش‌فرض: ۸۵۸۵، ۳۴۷۸، ۵۳۴۹ و ۴۹۱۵۲ تا ۵۰۱۵۲/udp.
- نام کاربری داشبورد `admin` است. رمز تصادفی است و در اولین اجرا ساخته می‌شود.
  نصب‌کننده نشانش می‌دهد و در `docker logs` هم هست. از داشبورد عوضش کنید.

**پنل مرکزی:**

```bash
curl -fsSLO https://raw.githubusercontent.com/Poorija/P00RIJA-CHAT/main/scripts/panel.sh && bash panel.sh
```

راهنمای کامل: https://github.com/Poorija/P00RIJA-CHAT#readme

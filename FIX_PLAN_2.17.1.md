# برنامه اصلاح مو‌به‌مو — P00RIJA Chat (`v2.17.2`)

## فاز ۱ — فیکس‌های فوری بیلد بومی، شبکه iOS/رله و گاردهای CI

### گام ۱.۱: تعمیر `Cargo.lock` و افزودن قفل بررسی به ابزار نسخه‌ها
* **مشکل:** در [src-tauri/Cargo.lock](src-tauri/Cargo.lock#L3957-L3959) هنگام ارتقای نسخه از `2.17.0` به `2.17.1`، به‌جز بسته `p00rija-chat` (خط `3058–3060`) نسخه crate خارجی `security-framework-sys` نیز به `"2.17.1"` تغییر یافته است که در crates.io وجود ندارد و `(cd src-tauri && cargo test --no-run)` و تمام بیلدهای Tauri را می‌شکند. هم‌زمان [tools/check-versions.cjs](tools/check-versions.cjs#L39) فقط نام `p00rija-chat` را می‌خواند و خرابی lockfile را تشخیص نمی‌دهد.
* **کارهایی که باید انجام شود:**
  1. در [src-tauri/Cargo.lock](src-tauri/Cargo.lock#L3957-L3959) مقدار `version` زیر `name = "security-framework-sys"` را به `"2.17.0"` برگردانید.
  2. با دستور زیر قفل و گراف پکیج‌ها را بازتایید کنید:
     ```bash
     cargo update -p p00rija-chat --manifest-path src-tauri/Cargo.toml
     ```
  3. در [tools/check-versions.cjs](tools/check-versions.cjs) یا [tests/regression.mjs](tests/regression.mjs) هنگام موجود بودن `cargo` چک زیر را اضافه کنید تا دست‌کاری اشتباه `Cargo.lock` فوراً متوقف شود:
     ```bash
     cargo metadata --manifest-path src-tauri/Cargo.toml --locked --format-version 1 > /dev/null
     ```
  4. در هر ابزار یا اسکریپت bump نسخه، جایگزینی داخل `Cargo.lock` را فقط محدود به بلاک `name = "p00rija-chat"` کنید.
* **تأییدیه:** `(cd src-tauri && cargo test --no-run) && npm run check:versions`

---

### گام ۱.۲: خارج کردن تایمر ۹ ثانیه‌ای بازیابی تماس WebRTC از کد مرده
* **مشکل:** در [js/chat/31-file-transfer-3.js](js/chat/31-file-transfer-3.js#L1500-L1515) داخل `bindCallIceRecovery(pc, call)`، تایمر `window.setTimeout(..., 9000)` برای `attemptCallRecovery(pc, 'stalled')` به‌اشتباه بعد از دستور `return;` (خط `1506`) و داخل شاخه `if (['connected', 'completed'].includes(state))` قرار گرفته است و عملاً هیچ‌وقت اجرا نمی‌شود.
* **کارهایی که باید انجام شود:**
  1. بلوک `window.setTimeout(..., 9000)` (خطوط `1507–1514`) را از داخل listener بیرون آورده و به انتهای بدنه `bindCallIceRecovery(pc, call)` (پس از خط `1538`) منتقل کنید.
  2. شناسه تایمر را در `chatState.iceStallTimer` ذخیره کنید و درون `clearIceRecoveryTimer()` و شاخه‌های `connected` / `completed` / `closed` با `clearTimeout` لغو کنید تا پس از اتصال یا قطع تماس اجرا نشود:
     ```js
     clearTimeout(chatState.iceStallTimer);
     chatState.iceStallTimer = window.setTimeout(() => {
       chatState.iceStallTimer = null;
       if (!chatState.currentCall || chatState.currentCall.peerConnection !== pc) return;
       if (['new', 'checking'].includes(pc.iceConnectionState)) attemptCallRecovery(pc, 'stalled');
     }, 9000);
     ```
  3. یک تست برای شبیه‌سازی وضعیت `'checking'` بیش از ۹ ثانیه و لغو تایمر در `'connected'` اضافه کنید.

---

### گام ۱.۳: افزودن فلگ `{ receipt: 1 }` به صف سوکت متصل در رله
* **مشکل:** در [scripts/server/20-accounts-that-moved-to.js](scripts/server/20-accounts-that-moved-to.js#L239-L248)، هنگام صف کردن پاکت‌های `persist` برای کلاینت متصلِ معلق (مثلاً موبایل در پس‌زمینه)، برخلاف خط [158](scripts/server/20-accounts-that-moved-to.js#L158) فیلد `...(isReceiptEnvelope ? { receipt: 1 } : {})` گذاشته نشده است؛ در نتیجه رسیدهای `eph: 2` در این مسیر مشمول پاکسازی ۴۸ ساعته و سقف ۳۰۰ عددی `receiptSweep()` ([scripts/server/14-guest-mail.js](scripts/server/14-guest-mail.js#L163-L175)) نمی‌شوند.
* **کارهایی که باید انجام شود:**
  1. درون `queuedItem` در [scripts/server/20-accounts-that-moved-to.js](scripts/server/20-accounts-that-moved-to.js#L239-L248) خط زیر را اضافه کنید:
     ```js
     ...(isReceiptEnvelope ? { receipt: 1 } : {}),
     ```
  2. در `tests/e2e/receiptkeep.mjs` کیس تستی اضافه کنید که برای سوکت بازِ بدون `relay-ack` نیز محدودیت `receiptSweep()` اعمال شود.
* **تأییدیه:** `node tests/e2e/_local-stack.mjs receiptkeep && npm run check:relay-parity`

---

### گام ۱.۴: اصلاح دستور ناموجود در CI و خطای لینک `ton://` در `sourceaudit.mjs`
* **مشکل:**
  1. فایل [.github/workflows/ci.yml](.github/workflows/ci.yml#L186) اسکریپت `test:native` را اجرا می‌کند که در [package.json](package.json) تعریف نشده است (و خط `116` به‌علت باگ ۱ شکست می‌خورد).
  2. چک [tests/e2e/sourceaudit.mjs](tests/e2e/sourceaudit.mjs#L116) با وضعیت `1 failed of 12` شکست می‌خورد چون فقط پیشوندهای `(https?:|mailto:|#|data:|tel:)` را مستثنی کرده و لینک `ton://transfer/...` در [README.md](README.md#L458) و `GitHub/README.md` را لینک شکسته فایل محلی می‌پندارد.
* **کارهایی که باید انجام شود:**
  1. در [package.json](package.json) کلید `"test:native"` را به یک دستور تست واقعی متصل کنید (یا خط `186` فایل [.github/workflows/ci.yml](.github/workflows/ci.yml#L186) را با تست واقعی جایگزین کنید).
  2. در [tests/e2e/sourceaudit.mjs](tests/e2e/sourceaudit.mjs#L116) شرط مستثنی‌سازی پروتکل را به‌صورت زیر اصلاح کنید:
     ```js
     if (/^(https?:|mailto:|#|data:|tel:|ton:)/.test(target)) continue;
     ```
* **تأییدیه:** `node tests/e2e/sourceaudit.mjs`

---

## فاز ۲ — بستن شکاف‌های امنیتی، احراز هویت و چنددستگاهی `notice-hints`

### گام ۲.۱: رمزنگاری و احراز هویت اجباری `notice-key` در ارسال و دریافت
* **مشکل:**
  1. در مسیر زنده PeerJS، `giveNoticeKeysToContacts` ([js/chat/69-notice-hints.js](js/chat/69-notice-hints.js#L221)) از طریق [relaySessionEvent](js/chat/29-file-transfer.js#L1895-L1900) کلیدهای متقارن خام `s` و `p` را با `safeConnectionSend` بدون `encryptForSession` می‌فرستد.
  2. در مسیر آفلاین ([js/chat/29-file-transfer.js](js/chat/29-file-transfer.js#L1906)) فقط truthy بودن `peerRecord.prekeyPublic` چک می‌شود؛ اگر `prekeyExpiresAt` منقضی شده باشد ([sealWithPrekey](js/chat/28-offline-envelopes.js#L77) -> `null`) و مخاطب در وضعیت `F3` باشد ([sealSessionKeyFor](js/chat/28-offline-envelopes.js#L162-L164) -> `''`) یا سشن بدون `cryptoKey` باشد، `body` در [sendSealedRelay](js/chat/29-file-transfer.js#L1014-L1051) برابر `null` می‌ماند و [offlineEnvelope](js/chat/28-offline-envelopes.js#L286-L287) کل پیام `{ type: 'notice-key', s, p }` را به‌صورت **plaintext روی `envelope.message`** می‌گذارد (سقوط به خط `1913` نیز همین کار را می‌کند).
  3. در دریافت ([handleSessionMessage](js/chat/29-file-transfer.js#L2646-L2649)) هیچ الزامی بر رمزنگاری سشن یا آمدن از درون `payload.body` مهردار آفلاین وجود ندارد و کلیدهای جعلی پیش‌از-KEX یا تزریق‌شده پذیرفته می‌شوند.
* **کارهایی که باید انجام شود:**
  1. در [js/chat/69-notice-hints.js](js/chat/69-notice-hints.js#L214-L245) به‌جای فراخوانی مستقیم `relaySessionEvent` تابع `async function sendNoticeKeyToPeer(peer, mine)` ایجاد کنید:
     * **حالت آنلاین:** تنها وقتی `session?.connection?.open && session?.cryptoKey && session?.keyReady` برقرار است، `{ v: 2, s, p, deviceId, createdAt }` را با `await encryptForSession(session, bytes, 'notice-key')` رمزنگاری و داخل `{ type: 'notice-key', v: 2, payload, createdAt }` ارسال کنید. در غیر این صورت سراغ مسیر آفلاین بروید یا تا دور بعدی صبر کنید.
     * **حالت آفلاین:** با آپشن جدید `requireSealed: true` به `sendSealedRelay` بفرستید و در `reachable(peer)` (خط `218`) تاریخ انقضای prekey (`!peer.prekeyExpiresAt || Date.parse(peer.prekeyExpiresAt) > Date.now()`) و آماده بودن سشن آنلاین را بررسی کنید.
  2. در `sendSealedRelay` ([js/chat/29-file-transfer.js](js/chat/29-file-transfer.js#L931-L1060)) گزینه `requireSealed = false` را اضافه کرده و قبل از ساخت `offlineEnvelope` قرار دهید:
     ```js
     if (requireSealed && !body) return false;
     ```
  3. در `openOfflineEnvelope` ([js/chat/29-file-transfer.js](js/chat/29-file-transfer.js#L2269-L2285)) فلگ `session.viaSealedBody = Boolean(payload.body && innerMessage && senderVerdict !== 'unsigned-pinned')` را فقط هنگام گشایش موفق `payload.body` معتبر ست و در `finally` پاک کنید.
  4. در `handleSessionMessage` ([js/chat/29-file-transfer.js](js/chat/29-file-transfer.js#L2646-L2649)) هر `notice-key` فاقد `message.payload` معتبرِ `decryptForSession(session, message.payload, 'notice-key')` و فاقد `session?.viaSealedBody` را رد کنید:
     ```js
     if (message.type === 'notice-key') {
       let noticeMsg = null;
       if (message.payload && session?.cryptoKey) {
         const plain = await decryptForSession(session, message.payload, 'notice-key');
         noticeMsg = JSON.parse(new TextDecoder().decode(plain));
       } else if (session?.viaSealedBody) {
         noticeMsg = message;
       } else {
         return;
       }
       if (typeof handleNoticeKeyMessage === 'function') await handleNoticeKeyMessage(session, noticeMsg);
       return;
     }
     ```

---

### گام ۲.۲: حل تداخل چنددستگاهی، صف ابطال آفلاین و کامیت اصلاح قفل
* **مشکل:**
  1. در [handleNoticeKeyMessage](js/chat/69-notice-hints.js#L257-L260) فقط یک جفت کلید واحد (`peer.noticeKeys = { s, p, at }`) ذخیره می‌شود و `noticeKeys` بین دستگاه‌های هم‌حساب همگام نمی‌شود؛ روشن کردن سوییچ در دستگاه دوم کلید دستگاه اول را روی فرستنده بازنویسی و پوش دستگاه اول را خراب می‌کند.
  2. تگ `v2.17.1` از `conversationLocked` استفاده کرده بود که در بازه بازبودن موقت قفل کلید پوش را صادر می‌کرد (این تغییر با `conversationHasLock` در [js/chat/69-notice-hints.js](js/chat/69-notice-hints.js#L207) به‌صورت محلی اصلاح شده ولی کامیت نشده است).
  3. در [js/chat/69-notice-hints.js](js/chat/69-notice-hints.js#L236-L241) اگر هنگام ابطال کلید، مخاطب `!reachable(peer)` باشد، `else delete given[id];` اجرا شده و ارسال پیام ابطال `{ s: '', p: '' }` در اتصال‌های بعدی برای همیشه فراموش می‌شود.
* **کارهایی که باید انجام شود:**
  1. کلیدهای `chatState.prefs.noticeKeys` را از طریق کانال رمزنگاری‌شده همگام‌سازی دستگاه‌های یک اکانت ([js/chat/44-device-beacon.js](js/chat/44-device-beacon.js) / [js/chat/59-device-link.js](js/chat/59-device-link.js)) همگام نگه دارید تا همه دستگاه‌های یک کاربر کلید یکسانی بدون تغییر سایز `hint` منتشر کنند (یا در مدل مستقل، کلیدها را در `peer.noticeKeysByDevice[deviceId]` با TTL و حذف دستگاه‌های لغوشده نگهداری کنید).
  2. در خطوط `236–241`، برای مخاطبِ غیربلاک‌شده‌ای که موقتاً `reachable` نیست، مقدار `given[id] = 'REVOKE'` را ذخیره کنید (`saveChatPrefs()`) و فقط پس از بازگشت `true` از `sendNoticeKeyToPeer` پاکش کنید؛ در هر اجرای `giveNoticeKeysToContacts` ورودی‌های `'REVOKE'` که `reachable(peer)` شده‌اند مجدد ارسال شوند.
  3. تغییر `conversationHasLock` در [js/chat/69-notice-hints.js](js/chat/69-notice-hints.js#L207) را پس از تکمیل به گیت کامیت کنید.
  4. به `tests/e2e/noticehints.mjs` سه تست اضافه کنید: عدم ارسال plaintext هنگام انقضای prekey روی مخاطب PQ/Ratchet، رد `notice-key` رمزنگاری‌نشده در `handleSessionMessage`، و ارسال ابطال معوق بعد از آنلاین‌شدن مجدد مخاطب.
* **تأییدیه:** `node tests/e2e/_local-stack.mjs noticehints && node tests/e2e/_local-stack.mjs notificationprivacy`

---

## فاز ۳ — اصلاح نمایشگر امنیتی UI، به‌روزرسانی اسناد و پاکسازی تست‌ها

### گام ۳.۱: اصلاح `sessionSecurityText(session)`
* **مشکل:** در [js/chat/20-call-rows.js](js/chat/20-call-rows.js#L684-L689) و [js/chat/27-message-render.js](js/chat/27-message-render.js#L1673)، فیلد `#chatSecurityKeyMode` ([index.html](index.html#L2160)) برای همه سشن‌های فعال به اشتباه رشته `'RSA-OAEP-3072 + AES-256-GCM'` و در حالت انتظار `'منتظر تبادل کلید RSA -> AES-GCM'` را نمایش می‌دهد.
* **کارهایی که باید انجام شود:**
  1. تابع `sessionSecurityText(session)` را بر اساس نوع واقعی سشن بازنویسی کنید:
     * بدون کلید -> `'منتظر تبادل کلید امن'` / `'Waiting for secure key exchange'`
     * `session.ratchet` -> `'Double Ratchet + ML-KEM-768 + AES-256-GCM'`
     * `session.keyHybrid` -> `'ML-KEM-768 + ECDH P-256 + AES-256-GCM'`
     * `session.keySource === 'negotiated'` -> `'ECDH P-256 + AES-256-GCM'`
     * فقط برای سشن legacy -> `'RSA-OAEP-3072 + AES-256-GCM'`
  2. در صورت وجود assertion روی متن قبلی در `tests/` آن را هماهنگ کنید.

---

### گام ۳.۲: به‌روزرسانی `docs/SPEC.md`، `docs/PROTOCOL.md` و آمار `config/nginx.conf`
* **مشکل:**
  1. [docs/SPEC.md](docs/SPEC.md#L1218-L1252) در نسخه `2.15.0` متوقف شده و تغییرات وایر `2.16–2.17` را ندارد؛ موارد باز `§6` (عدم rotation کلیدهای `sk`/`ak` و کارکرد کلید هویت رله در مسیر غیر KT) نیز نیاز به شفاف‌سازی وضعیت دارند.
  2. [docs/PROTOCOL.md](docs/PROTOCOL.md#L11-L30) هنوز کلید هویت فعلی را `RSA-3072` و تبادل کلید را `kex-offer/3` معرفی می‌کند.
  3. کامنت [config/nginx.conf](config/nginx.conf#L7-L16) آمار منسوخ `159 innerHTML` و `276 inline handlers` را ذکر کرده در حالی که مقادیر واقعی `250` و `139` است.
* **کارهایی که باید انجام شود:**
  1. در [docs/SPEC.md](docs/SPEC.md) بخش `§8` را با مستندات `route-query` (`chaseStrangerMail`), رسید `eph: 2` / `receiptSweep`, `notice-key v2` و `envelope.hint` (اندازه کلید، باکت‌های پدینگ، پنجره تازگی ۳۶ ساعت) اضافه کنید و وضعیت کلیدهای غیر KT رله و policy چرخش `sk`/`ak` را ثبت کنید.
  2. [docs/PROTOCOL.md](docs/PROTOCOL.md#L11-L30) را به `Identity v4 (Ed25519 + X25519)` (با پنجره انتقال ۹۰ روزه RSA)، `kex-offer/4` و `Double Ratchet` اصلاح کنید.
  3. اعداد کامنت بالای [config/nginx.conf](config/nginx.conf#L7-L16) را اصلاح کنید.

---

### گام ۳.۳: اصلاح `NOT_RUNNABLE` / `QUARANTINE` و پاکسازی مخزن
* **مشکل:**
  1. در [tests/regression.mjs](tests/regression.mjs#L68-L69) برای `native-shell` و `nativeui` دلیل قدیمی نبود `src-tauri/tauri.conf.json` ثبت شده است و ۷ سوئیت قرنطینه (`callreal`, `chataudit`, `controls`, `formatbar`, `release37`, `sileotoasts`, `uxfixes` در خطوط `86–94`) روی پوسته جدید بازنویسی یا بازنشسته نشده‌اند.
  2. دایرکتوری موقت `.superpowers/` به‌صورت untracked در ریشه مخزن مانده است.
* **کارهایی که باید انجام شود:**
  1. دلیل `NOT_RUNNABLE` برای `native-shell`/`nativeui` را اصلاح کرده و سوئیت‌های قرنطینه‌شده را یا به سلکتورهای جدید `chat-ui` به‌روزرسانی کنید یا موارد منسوخ مربوط به پوسته قبل از `2.3` را رسماً بازنشسته کنید.
  2. `.superpowers/` را پاک یا به `.gitignore` اضافه کنید تا وضعیت `git status` تمیز بماند.

---

## فاز ۴ — سخت‌کردن دفاع در عمق کلاینت (CSP / XSS / قفل حافظه)

### گام ۴.۱: حذف `'unsafe-inline'` از `script-src` و انتقال ۲ اسکریپت + ۱۳۹ هندلر inline
* **مشکل:** [config/nginx.conf](config/nginx.conf#L37) همچنان `'unsafe-inline'` را در `script-src` فعال دارد زیرا [index.html](index.html) دارای `139` صفت رویداد inline (`onclick=...`, ...) و `2` بلوک `<script>` داخلی است (`tools/audit-handlers.cjs`).
* **کارهایی که باید انجام شود:**
  1. هر `2` بلوک `<script>` داخلی را به فایل JS خارجی منتقل کرده و در [sw.js](sw.js) و [tools/check-assets.cjs](tools/check-assets.cjs) ثبت کنید.
  2. هر `139` هندلر inline در [index.html](index.html) را به `data-action="..."` + event delegation در یک فایل راه‌انداز تبدیل کنید تا `inline handler attributes` در `node tools/audit-handlers.cjs` به `0` برسد.
  3. `'unsafe-inline'` را از `script-src` در [config/nginx.conf](config/nginx.conf#L37)، [scripts/dev-static.js](scripts/dev-static.js) و `src-tauri/tauri*.conf.json` حذف کنید.

---

### گام ۴.۲: جایگزینی ۲۵۰ محل `.innerHTML =` در `js/`
* **مشکل:** در دایرکتوری `js/` دقیقاً `250` محل انتساب `.innerHTML =` وجود دارد که کنار `'unsafe-inline'` سطح حمله XSS مستقیم روی صندوقچه ایجاد می‌کند.
* **کارهایی که باید انجام شود:**
  1. با `rg -n "\.innerHTML\s*=" js/` تمام ۲۵۰ محل را دسته‌بندی کنید.
  2. تمام بخش‌هایی که متن، نام تماس، نام گروه یا محتوای همتا می‌نویسند را به `.textContent` یا ساخت گره با `document.createElement` + `.replaceChildren(...)` تغییر دهید.
  3. در [tests/e2e/sourceaudit.mjs](tests/e2e/sourceaudit.mjs) چک ایستایی اضافه کنید که استفاده جدید از template literalهای حاوی `${...}` در `.innerHTML =` را خطا بدهد.

---

### گام ۴.۳: جداسازی کلید خواندن در `lockApp` و تصفیه ۱۰ کلید `audit:prelock`
* **مشکل:**
  1. تابع `lockApp()` در [js/app.js](js/app.js#L6918-L6938) آگاهانه `activeProfile.dkey` را در RAM نگه می‌دارد تا پیام‌های ورودی iOS ذخیره شوند؛ بنابراین قفل فعلی جلوی خواندن تاریخچه پیشین توسط اسکریپت یا دسترسی به حافظه در حالت قفل را نمی‌گیرد.
  2. اسکریپت [tools/prelock-audit.cjs](tools/prelock-audit.cjs) برای `10` کلید (`<key>`, `poorija_2fa`, `poorija_desktop_vault_bytes`, `poorija_desktop_vault_saved_at`, `poorija_failed_logins`, `poorija_lang`, `poorija_lock_until`, `poorija_settings`, `poorija_sq`, `poorija_sq_failed`) دسترسی دوطرفه (پیش و پس از آنلاک) را نشان می‌دهد.
* **کارهایی که باید انجام شود:**
  1. یک جفت‌کلید محدودِ نوشتنِ ورودی (`sealed-inbox`) معرفی کنید: هنگام `lockApp()` کلید `activeProfile.dkey` را از حافظه صفر/پاک کرده و پیام‌های ورودی در حالت قفل را فقط تحت کلید عمومی `sealed-inbox` به‌صورت append-only روی دیسک مهر کنید تا در `unlockApp` بعدی باز و ادغام شوند.
  2. `10` کلید گزارش‌شده در `npm run audit:prelock` را بررسی و صراحتاً بین کلیدهای سراسری پیش‌از-ورود و کلیدهای درون-پروفایل تفکیک کنید.

---

## فاز ۵ — تکمیل خط تولید وب، سبک‌سازی CSS و ماژولارکردن هسته

### گام ۵.۱: فشرده‌سازی کامل خروجی `build-web.mjs` و سرو `dist/web/` در Docker
* **مشکل:** [tools/build-web.mjs](tools/build-web.mjs#L101-L111) فقط ماژول‌های `js/crypto/*-bridge.js` را minify می‌کند و اسکریپت‌های کلاسیک (`boot-*.js` و `app-*.js`) را بدون minify به هم می‌چسباند؛ و [config/Dockerfile](config/Dockerfile#L21-L28) اصلاً `dist/web/` را نمی‌سازد و همان `index.html` خام با ۱۰۷ تگ `<script>` را سرو می‌کند.
* **کارهایی که باید انجام شود:**
  1. در [tools/build-web.mjs](tools/build-web.mjs#L101-L111) گروه‌های `boot-*` و `app-*` را نیز از minifier (`esbuild` موجود کنار Vite) عبور دهید.
  2. [config/Dockerfile](config/Dockerfile) را به دو مرحله (`builder` با Node برای اجرای `npm run build:web` و ایمیج نهایی `nginx` برای سرو `dist/web/`) تبدیل کنید.
* **تأییدیه:** `npm run build:web && npm run check:web-build`

---

### گام ۵.۲: شکافتن فایل‌های غول‌پیکر، حذف CSS قدیمی و تکمیل مهاجرت ESM
* **مشکل:** هنوز ۵ فایل بسیار بزرگ (`js/app.js` `10,127` خط، `js/chat/29-file-transfer.js` `3,980` خط، `js/chat/30-file-transfer-2.js` `3,791` خط، `js/chat/17-file-manager.js` `3,339` خط، `js/chat/31-file-transfer-3.js` `3,002` خط) با `2,986` متغیر روی `globalThis` وجود دارند، و [css/chat-ui.css](css/chat-ui.css) (`8,155` خط) با `@layer !important` روی [css/styles.css](css/styles.css) (`27,749` خط) سوار شده است.
* **کارهایی که باید انجام شود:**
  1. مسئولیت‌های مجزای داخل `29-file-transfer.js` / `30-file-transfer-2.js` / `31-file-transfer-3.js` (ارسال/دریافت پاکت، سشن P2P، ریکاوری WebRTC) را به ماژول‌های کوچک‌تر زیر ۹۰۰ خط تفکیک کنید.
  2. با کمک `tools/prune-css.cjs` قواعد منسوخ و پوشانده‌شده داخل [css/styles.css](css/styles.css) را حذف کرده و وابستگی [css/chat-ui.css](css/chat-ui.css) به `@layer !important` را برطرف کنید.
  3. ماژول‌های `js/chat/` را به‌تدریج به ساختار ES Modules واقعی (مانند ۶ پل فعلی `js/crypto/`) منتقل کنید تا ۲۹۸۶ وابستگی `globalThis` حذف شوند.

---

## چک‌لیست اجرا پس از اتمام فاز ۱ تا ۳

```bash
(cd src-tauri && cargo test --no-run) && \
npm run check:versions && \
npm run check:types && \
npm run check:ui && \
npm run check:assets && \
npm run check:collisions && \
npm run check:server-parts && \
npm run check:mlkem && \
npm run check:relay-parity && \
npm run check:relay-pins && \
npm run check:nginx && \
npm run check:web-build && \
npm run test:unit && \
node tests/e2e/i18nparity.mjs && \
node tests/e2e/sourceaudit.mjs && \
node tests/regression.mjs --static && \
node tests/regression.mjs --only noticehints,notificationprivacy,receiptkeep,strangermail,offlinerecv,kexbinding,replayaad,ratchetfs,ratchetpcs,sfucall,navfixes,updatepick,keytransparency,senderkeys --workers 2
```

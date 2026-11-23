/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text. Section 13 matters here: run a modified
 * version as a network service and its users are entitled to your source.
 */

'use strict';

/* The monitor's two server-drawn pages, moved out of scripts/server.js
   (roadmap 2.3) word for word: the sign-in page, and the classic single-scroll
   dashboard still reachable at /Monitor_Server?classic=1. The new dashboard is
   scripts/lib/monitor-dashboard.js. */

function monitorLoginHtml() {
  return `
<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>P00RIJA Monitor - Login</title>
    <script src="/vendor/tailwind/tailwindcdn.js"></script>
    <link href="/vendor/fontawesome/css/all.min.css" rel="stylesheet">
    <style>
        body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #020617; color: white; }
        .glow { position: absolute; width: 600px; height: 600px; background: radial-gradient(circle, rgba(14, 165, 233, 0.1) 0%, transparent 70%); border-radius: 50%; z-index: -1; }
        .glass { background: rgba(15, 23, 42, 0.6); backdrop-filter: blur(20px); border: 1px solid rgba(255,255,255,0.1); border-radius: 32px; }
        .btn-sky { background: linear-gradient(135deg, #0ea5e9 0%, #0284c7 100%); transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1); }
        .btn-sky:hover { transform: translateY(-2px); box-shadow: 0 15px 30px -5px rgba(14, 165, 233, 0.4); }
        .ltr { direction: ltr; }
        .monitor-lang-toggle { position: fixed; top: 16px; inset-inline-end: 16px; z-index: 20; display: flex; gap: 6px; padding: 6px; border-radius: 999px; background: rgba(15,23,42,.72); border: 1px solid rgba(255,255,255,.1); backdrop-filter: blur(16px); }
        .monitor-lang-toggle button { min-width: 42px; padding: 6px 10px; border-radius: 999px; color: #94a3b8; font-weight: 900; font-size: 12px; }
        .monitor-lang-toggle button.active { background: #0ea5e9; color: white; }
        @keyframes float { 0%, 100% { transform: translateY(0) scale(1); } 50% { transform: translateY(-10px) scale(1.02); } }
        .animate-float { animation: float 5s ease-in-out infinite; }
    </style>
</head>
<body class="flex items-center justify-center min-h-screen p-4">
    <div class="monitor-lang-toggle" aria-label="Language">
        <button type="button" id="monitorLoginLangFa" onclick="setMonitorLoginLanguage('fa')">FA</button>
        <button type="button" id="monitorLoginLangEn" onclick="setMonitorLoginLanguage('en')">EN</button>
    </div>
    <div class="glow top-[-15%] left-[-15%]"></div>
    <div class="glow bottom-[-15%] right-[-15%]"></div>
    
    <div class="glass p-10 w-full max-w-md mx-4 shadow-2xl animate-float border-sky-500/20">
        <div class="text-center mb-10">
            <div class="inline-flex items-center justify-center w-24 h-24 bg-sky-500/10 rounded-3xl mb-6 border border-sky-500/30 shadow-[0_0_50px_rgba(14,165,233,0.2)]">
                <i class="fas fa-server text-5xl text-sky-400"></i>
            </div>
            <h1 class="text-3xl font-black tracking-tight text-white mb-2" data-login-i18n="title">داشبورد مدیریت</h1>
            <p class="text-slate-400 font-bold opacity-80">P00RIJA Chat Relay Server</p>
        </div>

        <div class="space-y-6">
            <div>
                <label class="block text-xs font-black text-slate-400 mb-3 mr-1 uppercase tracking-widest" data-login-i18n="username">نام کاربری</label>
                <div class="relative">
                    <span class="absolute inset-y-0 right-0 flex items-center pr-5 text-slate-500">
                        <i class="fas fa-user-shield"></i>
                    </span>
                    <input type="text" id="userInput" value="admin" autocomplete="username" class="w-full bg-slate-900/80 border border-slate-700/50 rounded-2xl py-4 pr-12 pl-12 focus:ring-2 focus:ring-sky-500 focus:border-transparent outline-none transition-all placeholder-slate-600 text-center ltr font-black text-lg" placeholder="admin">
                </div>
            </div>
            <div>
                <label class="block text-xs font-black text-slate-400 mb-3 mr-1 uppercase tracking-widest" data-login-i18n="password">گذرواژه مدیریت</label>
                <div class="relative">
                    <span class="absolute inset-y-0 right-0 flex items-center pr-5 text-slate-500">
                        <i class="fas fa-lock"></i>
                    </span>
                    <input type="password" id="passInput" class="w-full bg-slate-900/80 border border-slate-700/50 rounded-2xl py-4 pr-12 pl-12 focus:ring-2 focus:ring-sky-500 focus:border-transparent outline-none transition-all placeholder-slate-600 text-center ltr font-black text-lg" placeholder="••••••••">
                    <button onclick="toggleLoginPass()" class="absolute inset-y-0 left-0 flex items-center pl-5 text-slate-500 hover:text-sky-400 transition-colors">
                        <i id="loginPassIcon" class="fas fa-eye"></i>
                    </button>
                </div>
            </div>

            <button onclick="doLogin()" class="w-full btn-sky text-white font-black py-4 rounded-2xl shadow-lg flex items-center justify-center gap-3 text-lg">
                <span data-login-i18n="login">ورود ایمن به سامانه</span>
                <i class="fas fa-arrow-left"></i>
            </button>
            
            <div id="error" class="hidden text-rose-400 text-center text-sm font-bold bg-rose-500/10 py-3 rounded-xl border border-rose-500/20">
                <span data-login-i18n="wrong">گذرواژه اشتباه است. مجدداً تلاش کنید.</span>
            </div>
            <div id="lockNotice" class="hidden text-amber-300 text-center text-sm font-bold bg-amber-500/10 py-3 rounded-xl border border-amber-500/20"></div>
        </div>

        <div class="mt-10 pt-8 border-t border-slate-700/50 text-center">
            <span class="text-[10px] text-slate-500 uppercase tracking-[0.3em] font-black">Protected by P00RIJA Suite</span>
        </div>
    </div>

    <script>
        const monitorLoginTranslations = {
            fa: {
                title: 'داشبورد مدیریت',
                password: 'گذرواژه مدیریت',
                login: 'ورود ایمن به سامانه',
                wrong: 'گذرواژه اشتباه است. مجدداً تلاش کنید.',
                wrongWithRemaining: 'گذرواژه اشتباه است. تعداد تلاش باقی‌مانده: ',
                locked: 'به علت ۳ تلاش ناموفق، ورود تا ',
                lockedSuffix: ' قفل شد.',
            },
            en: {
                title: 'Management Dashboard',
                password: 'Admin Password',
                login: 'Secure Login',
                wrong: 'The password is incorrect. Please try again.',
                wrongWithRemaining: 'The password is incorrect. Attempts remaining: ',
                locked: 'Login is locked for ',
                lockedSuffix: ' after 3 failed attempts.',
            }
        };
        function monitorLoginLanguage() {
            return localStorage.getItem('monitor_language_v1') || 'fa';
        }
        function loginT(key) {
            const lang = monitorLoginLanguage();
            return monitorLoginTranslations[lang]?.[key] || monitorLoginTranslations.fa[key] || key;
        }
        function setMonitorLoginLanguage(lang) {
            localStorage.setItem('monitor_language_v1', lang === 'en' ? 'en' : 'fa');
            applyMonitorLoginLanguage();
        }
        function applyMonitorLoginLanguage() {
            const lang = monitorLoginLanguage();
            document.documentElement.lang = lang;
            document.documentElement.dir = lang === 'fa' ? 'rtl' : 'ltr';
            document.querySelectorAll('[data-login-i18n]').forEach((el) => {
                el.textContent = loginT(el.dataset.loginI18n);
            });
            document.getElementById('monitorLoginLangFa')?.classList.toggle('active', lang === 'fa');
            document.getElementById('monitorLoginLangEn')?.classList.toggle('active', lang === 'en');
        }
        function toggleLoginPass() {
            const input = document.getElementById('passInput');
            const icon = document.getElementById('loginPassIcon');
            if (input.type === 'password') {
                input.type = 'text';
                icon.classList.replace('fa-eye', 'fa-eye-slash');
            } else {
                input.type = 'password';
                icon.classList.replace('fa-eye-slash', 'fa-eye');
            }
        }
        function clearAuthState() {
            localStorage.removeItem('monitor_token_v2');
            document.cookie = "monitor_token_v2=; path=/; Max-Age=0; SameSite=Strict";
            document.cookie = "monitor_token_v2=; path=/Monitor_Server; Max-Age=0; SameSite=Strict";
        }
        /* Kept only so any old call site is harmless. Page script must not be
           able to mint a session cookie — the server sets an HttpOnly one at
           login, and a script-written cookie of the same name would shadow it
           with a value that is not a session at all. */
        function setAuthCookie() { /* the server owns this cookie now */ }
        function formatLock(ms) {
            const total = Math.max(0, Math.ceil(ms / 1000));
            const min = Math.floor(total / 60);
            const sec = String(total % 60).padStart(2, '0');
            return min + ':' + sec;
        }
        function showLock(ms) {
            const notice = document.getElementById('lockNotice');
            const button = document.querySelector('button[onclick="doLogin()"]');
            notice.classList.remove('hidden');
            button.disabled = true;
            button.classList.add('opacity-60', 'cursor-not-allowed');
            const end = Date.now() + ms;
            const tick = () => {
                const remaining = end - Date.now();
                if (remaining <= 0) {
                    notice.classList.add('hidden');
                    button.disabled = false;
                    button.classList.remove('opacity-60', 'cursor-not-allowed');
                    return;
                }
                notice.textContent = loginT('locked') + formatLock(remaining) + loginT('lockedSuffix');
                setTimeout(tick, 1000);
            };
            tick();
        }
        function doLogin() {
            const pass = document.getElementById('passInput').value;
            const user = document.getElementById('userInput') ? document.getElementById('userInput').value.trim() : '';
            if (!pass) return;
            fetch('/admin/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                cache: 'no-store',
                body: JSON.stringify({ password: pass, username: user })
            }).then(async r => {
                const data = await r.json().catch(() => ({}));
                if (r.ok && data.ok) {
                    /* No token to keep: the session is an HttpOnly cookie the
                       server just set, which the browser attaches by itself and
                       page script cannot read. Copying it into localStorage was
                       exactly what made HttpOnly meaningless. */
                    window.location.replace(data.redirect || '/Monitor_Server');
                } else if (r.status === 423) {
                    clearAuthState();
                    document.getElementById('error').classList.add('hidden');
                    showLock(data.remainingMs || 600000);
                } else {
                    clearAuthState();
                    const remaining = Number(data.attemptsRemaining || 0);
                    const error = document.getElementById('error');
                    error.textContent = remaining > 0
                        ? loginT('wrongWithRemaining') + remaining
                        : loginT('wrong');
                    error.classList.remove('hidden');
                }
            });
        }
        applyMonitorLoginLanguage();
        document.getElementById('passInput').onkeypress = (e) => { if(e.key === 'Enter') doLogin(); };
        /* Ask whether the cookie we may already be holding is still good. */
        fetch('/healthz', { cache: 'no-store', credentials: 'same-origin' }).then(r => {
            if (r.ok) window.location.replace('/Monitor_Server');
        }).catch(() => { /* not signed in; the form stands */ });
    </script>
</body>
</html>
    `;
}

function monitorClassicHtml({ PORT, PRESENCE_PORT, host }) {
  return `
<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>P00RIJÃ Signal Monitor | داشبورد حرفه‌ای مدیریت</title>
    <script src="/vendor/tailwind/tailwindcdn.js"></script>
    <link rel="stylesheet" href="/vendor/fontawesome/css/all.min.css">
    <script>
      window.Chart = window.Chart || class {
        constructor(ctx, config) {
          this.ctx = ctx;
          this.canvas = ctx.canvas;
          this.type = config && config.type || 'line';
          this.data = config && config.data || { labels: [], datasets: [] };
          this.options = config && config.options || {};
          this.update();
        }
        resize() {
          const parent = this.canvas.parentElement;
          const width = Math.max(320, parent ? parent.clientWidth : this.canvas.clientWidth || 320);
          const height = Math.max(180, parent ? parent.clientHeight : this.canvas.clientHeight || 220);
          const ratio = window.devicePixelRatio || 1;
          if (this.canvas.width !== Math.floor(width * ratio) || this.canvas.height !== Math.floor(height * ratio)) {
            this.canvas.width = Math.floor(width * ratio);
            this.canvas.height = Math.floor(height * ratio);
            this.canvas.style.width = width + 'px';
            this.canvas.style.height = height + 'px';
            this.ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
          }
          return { width, height };
        }
        update() {
          const size = this.resize();
          const ctx = this.ctx;
          const width = size.width;
          const height = size.height;
          const pad = { left: 34, right: 12, top: 14, bottom: 24 };
          const plotW = Math.max(1, width - pad.left - pad.right);
          const plotH = Math.max(1, height - pad.top - pad.bottom);
          const labels = this.data.labels || [];
          const datasets = this.data.datasets || [];
          const allValues = datasets.flatMap(function (set) { return (set.data || []).map(Number).filter(Number.isFinite); });
          const suggestedMax = this.options && this.options.scales && this.options.scales.y && this.options.scales.y.suggestedMax || 100;
          const maxValue = Math.max(suggestedMax, 1, allValues.length ? Math.max.apply(null, allValues) : 0);
          ctx.clearRect(0, 0, width, height);
          ctx.fillStyle = 'rgba(15,23,42,0.08)';
          ctx.fillRect(0, 0, width, height);
          ctx.strokeStyle = 'rgba(148,163,184,0.12)';
          ctx.lineWidth = 1;
          ctx.font = '10px system-ui, sans-serif';
          ctx.fillStyle = '#64748b';
          for (let i = 0; i <= 4; i++) {
            const y = pad.top + (plotH * i / 4);
            ctx.beginPath();
            ctx.moveTo(pad.left, y);
            ctx.lineTo(width - pad.right, y);
            ctx.stroke();
            const value = Math.round(maxValue - (maxValue * i / 4));
            ctx.fillText(String(value), 4, y + 3);
          }
          datasets.forEach(function (set) {
            const values = (set.data || []).map(Number);
            const color = set.borderColor || '#38bdf8';
            if (values.length < 2) return;
            ctx.beginPath();
            values.forEach(function (value, index) {
              const x = pad.left + (values.length === 1 ? 0 : plotW * index / (values.length - 1));
              const y = pad.top + plotH - ((Number.isFinite(value) ? value : 0) / maxValue) * plotH;
              if (index === 0) ctx.moveTo(x, y);
              else ctx.lineTo(x, y);
            });
            ctx.strokeStyle = color;
            ctx.lineWidth = set.borderWidth || 2;
            ctx.stroke();
            const gradient = ctx.createLinearGradient(0, pad.top, 0, height - pad.bottom);
            gradient.addColorStop(0, color + '33');
            gradient.addColorStop(1, color + '00');
            ctx.lineTo(width - pad.right, height - pad.bottom);
            ctx.lineTo(pad.left, height - pad.bottom);
            ctx.closePath();
            ctx.fillStyle = gradient;
            ctx.fill();
          });
          if (labels.length) {
            ctx.fillStyle = '#64748b';
            ctx.fillText(String(labels[0]), pad.left, height - 6);
            ctx.textAlign = 'right';
            ctx.fillText(String(labels[labels.length - 1]), width - pad.right, height - 6);
            ctx.textAlign = 'left';
          }
        }
        destroy() {}
      };
    </script>
    <style>
        html { font-size: var(--monitor-font-size, 16px); }
        body { 
            background: var(--monitor-bg, #020617); 
            color: var(--monitor-text, #f8fafc); 
            font-family: var(--monitor-font, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
            font-size: 1rem;
            min-height: 100vh;
            background-image: 
                radial-gradient(at 0% 0%, var(--monitor-glow-a, rgba(14, 165, 233, 0.15)) 0px, transparent 50%),
                radial-gradient(at 100% 100%, var(--monitor-glow-b, rgba(99, 102, 241, 0.15)) 0px, transparent 50%);
            overflow-x: hidden;
        }
        .glass { 
            background: var(--monitor-card, rgba(15, 23, 42, 0.6)); 
            backdrop-filter: blur(20px);
            border: 1px solid var(--monitor-border, rgba(255, 255, 255, 0.08));
            border-radius: 24px;
        }
        @font-face { font-family: Vazirmatn; src: url('/fonts/Vazirmatn/Vazirmatn-VariableFont_wght.ttf'); font-display: swap; }
        @font-face { font-family: BYekan; src: url('/fonts/BYekan.ttf'); font-display: swap; }
        @font-face { font-family: Parastoo; src: url('/fonts/Parastoo/Parastoo-VariableFont_wght.ttf'); font-display: swap; }
        @font-face { font-family: Rubik; src: url('/fonts/Rubik/Rubik-VariableFont_wght.ttf'); font-display: swap; }
        @font-face { font-family: Inter; src: url('/fonts/Inter-Regular.ttf'); font-display: swap; }
        @font-face { font-family: Roboto; src: url('/fonts/Roboto/Roboto-Regular.ttf'); font-display: swap; }
        @font-face { font-family: CascadiaCode; src: url('/fonts/Cascadia_Code/CascadiaCode-VariableFont_wght.ttf'); font-display: swap; }
        body.monitor-theme-dark { --monitor-bg: #020617; --monitor-text: #f8fafc; --monitor-card: rgba(15,23,42,.62); --monitor-border: rgba(255,255,255,.08); --monitor-accent: #38bdf8; --monitor-glow-a: rgba(14,165,233,.15); --monitor-glow-b: rgba(99,102,241,.15); }
        body.monitor-theme-midnight { --monitor-bg: #080b1a; --monitor-text: #eef2ff; --monitor-card: rgba(17,24,39,.72); --monitor-border: rgba(129,140,248,.18); --monitor-accent: #818cf8; --monitor-glow-a: rgba(79,70,229,.18); --monitor-glow-b: rgba(14,165,233,.12); }
        body.monitor-theme-nord { --monitor-bg: #2e3440; --monitor-text: #eceff4; --monitor-card: rgba(59,66,82,.7); --monitor-border: rgba(136,192,208,.22); --monitor-accent: #88c0d0; --monitor-glow-a: rgba(136,192,208,.12); --monitor-glow-b: rgba(129,161,193,.12); }
        body.monitor-theme-dracula { --monitor-bg: #282a36; --monitor-text: #f8f8f2; --monitor-card: rgba(68,71,90,.72); --monitor-border: rgba(255,121,198,.18); --monitor-accent: #ff79c6; --monitor-glow-a: rgba(189,147,249,.12); --monitor-glow-b: rgba(255,121,198,.12); }
        body.monitor-theme-linen { --monitor-bg: #f5efe6; --monitor-text: #1f2937; --monitor-card: rgba(255,251,245,.78); --monitor-border: rgba(120,113,108,.22); --monitor-accent: #0f766e; --monitor-glow-a: rgba(15,118,110,.1); --monitor-glow-b: rgba(180,83,9,.08); }
        body.monitor-theme-linen .text-white { color: #1f2937 !important; }
        body.monitor-theme-linen .text-slate-400, body.monitor-theme-linen .text-slate-500 { color: #64748b !important; }
        .monitor-control {
            background: rgba(15, 23, 42, 0.65);
            border: 1px solid var(--monitor-border, rgba(255,255,255,.08));
            color: var(--monitor-accent, #38bdf8);
            border-radius: 12px;
            padding: 8px 10px;
            outline: none;
            font-weight: 800;
            min-width: 118px;
        }
        body.monitor-theme-linen .monitor-control { background: rgba(255,255,255,.72); color: #0f766e; }
        .stat-card {
            transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
        }
        .stat-card:hover {
            transform: translateY(-5px);
            background: rgba(30, 41, 59, 0.7);
            border-color: rgba(56, 189, 248, 0.4);
            box-shadow: 0 20px 40px -15px rgba(0, 0, 0, 0.5);
        }
        .stat-value { 
            font-size: 2.5rem; 
            font-weight: 900; 
            background: linear-gradient(135deg, #fff 30%, #38bdf8 100%); 
            -webkit-background-clip: text; 
            -webkit-text-fill-color: transparent; 
            letter-spacing: -1px;
        }
        .port-tag {
            background: linear-gradient(90deg, #334155, #1e293b);
            padding: 2px 10px;
            border-radius: 8px;
            font-family: monospace;
            font-size: 11px;
            color: #38bdf8;
            border: 1px solid rgba(56, 189, 248, 0.2);
        }
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #1e293b; border-radius: 10px; }
        ::-webkit-scrollbar-thumb:hover { background: #334155; }
        
        .log-entry { border-left: 3px solid transparent; transition: all 0.2s; }
        .log-info { border-left-color: #38bdf8; background: rgba(56, 189, 248, 0.03); }
        .log-warn { border-left-color: #fbbf24; background: rgba(251, 191, 36, 0.03); }
        .log-error { border-left-color: #ef4444; background: rgba(239, 68, 68, 0.03); }

        .peer-row:hover { background: rgba(255,255,255,0.03); }
        .monitor-chart-card {
            height: 314px;
            min-height: 314px;
            max-height: 314px;
            overflow: hidden;
        }
        .monitor-chart-frame {
            height: 250px;
            min-height: 250px;
            max-height: 250px;
            overflow: hidden;
            contain: size layout paint;
        }
        .monitor-chart-frame canvas {
            width: 100% !important;
            height: 100% !important;
            display: block;
        }
        .monitor-select,
        .monitor-select option {
            background-color: #0f172a;
            color: #f8fafc;
        }
        .monitor-select:focus {
            background-color: #111827;
        }
        body.monitor-theme-linen .monitor-select,
        body.monitor-theme-linen .monitor-select option {
            background-color: #fff7ed;
            color: #1f2937;
        }
    </style>
</head>
<body class="p-4 md:p-8">
    <div class="max-w-[1600px] mx-auto">
        <!-- Header -->
        <header class="flex flex-col xl:flex-row justify-between items-center mb-10 gap-8">
            <div class="flex items-center gap-6">
                <div class="w-16 h-16 glass flex items-center justify-center text-sky-400 text-3xl shadow-2xl border-sky-500/30 relative">
                    <i class="fas fa-shield-halved"></i>
                    <span class="absolute -top-1 -right-1 flex h-4 w-4">
                        <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-sky-400 opacity-75"></span>
                        <span class="relative inline-flex rounded-full h-4 w-4 bg-sky-500"></span>
                    </span>
                </div>
                <div>
                    <h1 class="text-4xl font-black text-white tracking-tight">P00RIJÃ <span class="text-sky-400">Signal Monitor</span></h1>
                    <p class="text-slate-400 text-sm font-bold opacity-80 mt-1">سامانه متمرکز پایش و کنترل زیرساخت‌های رمزنگاری</p>
                </div>
            </div>
            
            <div class="flex flex-wrap items-center justify-center gap-4">
                <div class="flex flex-wrap items-center gap-2 glass px-4 py-3 text-xs font-black">
                    <select id="monitorLanguageSelect" class="monitor-control" title="زبان / Language" onchange="setMonitorLanguage(this.value)">
                        <option value="fa">فارسی</option>
                        <option value="en">English</option>
                    </select>
                    <select id="monitorFontSelect" class="monitor-control" title="فونت" onchange="applyMonitorAppearance()">
                        <option value="Vazirmatn">Vazirmatn</option>
                        <option value="BYekan">B Yekan</option>
                        <option value="Parastoo">Parastoo</option>
                        <option value="Rubik">Rubik</option>
                        <option value="Inter">Inter</option>
                        <option value="Roboto">Roboto</option>
                        <option value="CascadiaCode">Cascadia Code</option>
                    </select>
                    <select id="monitorFontSizeSelect" class="monitor-control" title="اندازه نوشتار" onchange="applyMonitorAppearance()">
                        <option value="14px">کوچک</option>
                        <option value="16px">متوسط</option>
                        <option value="18px">بزرگ</option>
                    </select>
                    <select id="monitorThemeSelect" class="monitor-control" title="تم" onchange="applyMonitorAppearance()">
                        <option value="dark">Dark</option>
                        <option value="midnight">Midnight</option>
                        <option value="nord">Nord</option>
                        <option value="dracula">Dracula</option>
                        <option value="linen">Linen</option>
                    </select>
                </div>
                <div class="flex items-center gap-3 glass px-5 py-3 text-sm font-black">
                    <span class="text-slate-500">به‌روزرسانی:</span>
                    <select id="refreshInterval" class="bg-transparent border-none outline-none text-sky-400 cursor-pointer font-bold">
                        <option value="1000">۱ ثانیه</option>
                        <option value="2000" selected>۲ ثانیه</option>
                        <option value="5000">۵ ثانیه</option>
                        <option value="10000">۱۰ ثانیه</option>
                    </select>
                </div>
                <div class="flex gap-2">
                    <button onclick="togglePasswordModal()" class="glass px-5 py-3 hover:bg-sky-500/10 transition-all font-black text-sm border-sky-500/20 group">
                        <i class="fas fa-lock ml-2 text-sky-400 group-hover:rotate-12 transition-transform"></i>امنیت
                    </button>
                    <button onclick="optimizeRAM()" class="glass px-5 py-3 hover:bg-emerald-500/10 transition-all font-black text-sm border-emerald-500/20 text-emerald-400 group">
                        <i class="fas fa-microchip ml-2 group-hover:scale-125 transition-transform"></i>بهینه‌ساز RAM
                    </button>
                    <button onclick="clearMemory()" class="glass px-5 py-3 hover:bg-amber-500/10 transition-all font-black text-sm border-amber-500/20 text-amber-400 group">
                        <i class="fas fa-bolt ml-2 group-hover:scale-125 transition-transform"></i>پاکسازی اتصالات
                    </button>
                    <button onclick="logout()" class="glass px-5 py-3 hover:bg-rose-500/10 transition-all font-black text-sm border-rose-500/20 text-rose-400 group">
                        <i class="fas fa-power-off ml-2 group-hover:text-rose-500 transition-colors"></i>خروج
                    </button>
                </div>
                <div id="statusIndicator" class="flex items-center gap-3 text-sm font-black glass px-6 py-3 border-green-500/30">
                   <span class="w-3 h-3 bg-green-500 rounded-full animate-pulse shadow-[0_0_15px_rgba(34,197,94,0.8)]"></span> عملیاتی
                </div>
            </div>
        </header>

        <!-- Main Stats Grid -->
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-6 mb-8">
            <div class="glass p-6 stat-card relative overflow-hidden">
                <div class="absolute -right-4 -top-4 text-sky-500/5 text-6xl rotate-12"><i class="fas fa-users"></i></div>
                <p class="text-slate-500 text-[10px] font-black uppercase tracking-[0.2em] mb-3">کاربران متصل</p>
                <div id="statPeers" class="text-4xl font-black text-white">--</div>
                <div class="flex items-center gap-2 mt-4">
                    <div class="port-tag">PORT: ${PRESENCE_PORT}</div>
                </div>
            </div>
            <div class="glass p-6 stat-card relative overflow-hidden">
                <div class="absolute -right-4 -top-4 text-indigo-500/5 text-6xl rotate-12"><i class="fas fa-microchip"></i></div>
                <p class="text-slate-500 text-[10px] font-black uppercase tracking-[0.2em] mb-3">بار سیستم (CPU)</p>
                <div id="statCpu" class="text-4xl font-black text-white">--</div>
                <div class="w-full bg-slate-800/50 h-1.5 rounded-full mt-4 overflow-hidden">
                    <div id="cpuBar" class="bg-gradient-to-r from-sky-500 to-indigo-400 h-full transition-all duration-700" style="width: 0%"></div>
                </div>
            </div>
            <div class="glass p-6 stat-card relative overflow-hidden">
                <div class="absolute -right-4 -top-4 text-indigo-500/5 text-6xl rotate-12"><i class="fas fa-memory"></i></div>
                <p class="text-slate-500 text-[10px] font-black uppercase tracking-[0.2em] mb-3">حافظه (RAM)</p>
                <div id="statMemory" class="text-4xl font-black text-white">--</div>
                <div class="w-full bg-slate-800/50 h-1.5 rounded-full mt-4 overflow-hidden">
                    <div id="memoryBar" class="bg-gradient-to-r from-indigo-500 to-sky-400 h-full transition-all duration-700" style="width: 0%"></div>
                </div>
            </div>
            <div class="glass p-6 stat-card relative overflow-hidden">
                <div class="absolute -right-4 -top-4 text-emerald-500/5 text-6xl rotate-12"><i class="fas fa-database"></i></div>
                <p class="text-slate-500 text-[10px] font-black uppercase tracking-[0.2em] mb-3">ذخیره‌سازی (Disk)</p>
                <div id="statStorage" class="text-4xl font-black text-white">--</div>
                <div class="w-full bg-slate-800/50 h-1.5 rounded-full mt-4 overflow-hidden">
                    <div id="storageBar" class="bg-gradient-to-r from-emerald-500 to-sky-400 h-full transition-all duration-700" style="width: 0%"></div>
                </div>
            </div>
            <div class="glass p-6 stat-card relative overflow-hidden border-sky-500/10">
                <div class="absolute -right-4 -top-4 text-sky-500/5 text-6xl rotate-12"><i class="fas fa-signal"></i></div>
                <p class="text-slate-500 text-[10px] font-black uppercase tracking-[0.2em] mb-3">تأخیر شبکه (Ping)</p>
                <div id="statPing" class="text-4xl font-black text-sky-400 mt-2 tracking-tighter">-- <span class="text-sm">ms</span></div>
                <p class="text-[9px] text-slate-500 mt-5 font-bold">پایداری اتصال مدیریت</p>
            </div>
        </div>

        <!-- Charts Section -->
        <div class="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8">
            <div class="glass p-8 lg:col-span-1 monitor-chart-card">
                <div class="flex justify-between items-center mb-6">
                    <h3 class="text-lg font-black text-white">کاربران در حالت تعلیق</h3>
                    <span class="text-[10px] text-amber-400 font-black px-2 py-1 bg-amber-500/10 rounded-lg">LIVE</span>
                </div>
                <div class="monitor-chart-frame">
                    <canvas id="suspendedChart"></canvas>
                </div>
            </div>
            <div class="glass p-8 lg:col-span-1 monitor-chart-card">
                <div class="flex justify-between items-center mb-6">
                    <h3 class="text-lg font-black text-white">بار پردازشی (CPU)</h3>
                    <span class="text-[10px] text-indigo-400 font-black px-2 py-1 bg-indigo-500/10 rounded-lg">LIVE</span>
                </div>
                <div class="monitor-chart-frame">
                    <canvas id="cpuChart"></canvas>
                </div>
            </div>
            <div class="glass p-8 lg:col-span-1 monitor-chart-card">
                <div class="flex justify-between items-center mb-6">
                    <h3 class="text-lg font-black text-white">تحلیل حافظه (RAM)</h3>
                    <span class="text-[10px] text-sky-400 font-black px-2 py-1 bg-sky-500/10 rounded-lg">LIVE</span>
                </div>
                <div class="monitor-chart-frame">
                    <canvas id="memoryChart"></canvas>
                </div>
            </div>
        </div>

        <!-- New Row of Charts -->
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
            <div class="glass p-8 monitor-chart-card">
                <div class="flex justify-between items-center mb-6">
                    <h3 class="text-lg font-black text-white">پردازش پیام‌ها</h3>
                    <span class="text-[10px] text-amber-400 font-black px-2 py-1 bg-amber-500/10 rounded-lg">LIVE</span>
                </div>
                <div class="monitor-chart-frame">
                    <canvas id="throughputChart"></canvas>
                </div>
            </div>
            <div class="glass p-8 monitor-chart-card">
                <div class="flex justify-between items-center mb-6">
                    <h3 class="text-lg font-black text-white">ترافیک شبکه (I/O)</h3>
                    <span class="text-[10px] text-sky-400 font-black px-2 py-1 bg-sky-500/10 rounded-lg">LIVE</span>
                </div>
                <div class="monitor-chart-frame">
                    <canvas id="networkChart"></canvas>
                </div>
            </div>
        </div>

        <!-- System Health and Queue Charts -->
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
            <div class="glass p-8 monitor-chart-card">
                <div class="flex justify-between items-center mb-6">
                    <h3 class="text-lg font-black text-white">صف پیام‌های آنلاین</h3>
                    <span class="text-[10px] text-rose-400 font-black px-2 py-1 bg-rose-500/10 rounded-lg">LIVE</span>
                </div>
                <div class="monitor-chart-frame">
                    <canvas id="queueChart"></canvas>
                </div>
            </div>
            <div class="glass p-8 monitor-chart-card">
                <div class="flex justify-between items-center mb-6">
                    <h3 class="text-lg font-black text-white">مصرف فضای ذخیره‌سازی</h3>
                    <span class="text-[10px] text-emerald-400 font-black px-2 py-1 bg-emerald-500/10 rounded-lg">LIVE</span>
                </div>
                <div class="monitor-chart-frame">
                    <canvas id="storageChart"></canvas>
                </div>
            </div>
        </div>

        <!-- Relay Health: capacity against its ceiling, and what was discarded -->
        <div class="glass p-8 mb-8">
            <div class="flex justify-between items-center mb-6">
                <h3 class="text-xl font-black text-white flex items-center gap-3">
                    <i class="fas fa-heart-pulse text-rose-500"></i>
                    سلامت رله
                </h3>
                <span id="relayInstance" class="text-[10px] text-slate-500 font-mono"></span>
            </div>
            <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
                <div>
                    <p class="text-slate-500 text-[10px] font-black uppercase tracking-[0.2em] mb-3">ظرفیت</p>
                    <ul id="relayLimits" class="space-y-1 text-xs"></ul>
                </div>
                <div>
                    <p class="text-slate-500 text-[10px] font-black uppercase tracking-[0.2em] mb-3">صندوق‌های پرتر</p>
                    <ul id="relayMailboxes" class="space-y-1 text-xs"></ul>
                </div>
                <div>
                    <p class="text-slate-500 text-[10px] font-black uppercase tracking-[0.2em] mb-3">محدودشده‌ها</p>
                    <ul id="relayThrottle" class="space-y-1 text-xs"></ul>
                </div>
            </div>
            <div class="mt-8 pt-6 border-t border-slate-800">
                <div class="flex justify-between items-center mb-4">
                    <h4 class="text-sm font-black text-white flex items-center gap-2">
                        <i class="fas fa-trash-can text-amber-500"></i>
                        آنچه رله دور ریخت
                    </h4>
                    <span id="relayDiscardSummary" class="text-[10px] text-slate-400 font-bold"></span>
                </div>
                <div class="overflow-x-auto max-h-64 custom-scrollbar">
                    <table class="w-full text-right">
                        <thead class="text-[9px] text-slate-500 uppercase tracking-widest">
                            <tr>
                                <th class="pb-2">برای</th><th class="pb-2">از</th><th class="pb-2">نوع</th>
                                <th class="pb-2">دلیل</th><th class="pb-2">در صف از</th><th class="pb-2">حذف در</th>
                            </tr>
                        </thead>
                        <tbody id="relayDiscardBody" class="text-[10px] font-mono"></tbody>
                    </table>
                </div>
            </div>
        </div>

        <!-- Middle Section: Peers and Logs -->
        <div class="grid grid-cols-1 xl:grid-cols-4 gap-6 mb-8">
            <!-- Peers Table -->
            <div class="glass p-8 xl:col-span-2 overflow-hidden flex flex-col">
                <div class="flex justify-between items-center mb-6">
                    <h3 class="text-xl font-black text-white flex items-center gap-3">
                        <i class="fas fa-network-wired text-sky-500"></i>
                        کاربران متصل
                    </h3>
                </div>
                <div class="overflow-x-auto flex-grow custom-scrollbar">
                    <table class="w-full text-right">
                        <thead>
                            <tr class="text-slate-500 text-[10px] font-black uppercase tracking-wider border-b border-white/5">
                                <th class="pb-4 pr-4">نام کاربری</th>
                                <th class="pb-4">آدرس IP</th>
                                <th class="pb-4">مدت</th>
                                <th class="pb-4 text-left pl-4">عملیات</th>
                            </tr>
                        </thead>
                        <tbody id="peerTableBody" class="text-xs">
                            <!-- Peers injected here -->
                        </tbody>
                    </table>
                </div>
            </div>

            <!-- Broadcast and Logs -->
            <div class="xl:col-span-2 grid grid-cols-1 gap-6">
                <div class="glass p-8">
                    <h3 class="text-xl font-black text-white mb-6 flex items-center gap-3">
                        <i class="fas fa-bullhorn text-sky-500"></i>
                        ارسال اعلان سیستمی (Broadcast)
                    </h3>
                    <div class="space-y-4">
                        <select id="broadcastTarget" class="monitor-select w-full bg-slate-800/50 border border-white/10 rounded-xl px-4 py-3 outline-none focus:border-sky-500 transition-all font-bold text-white text-sm">
                            <option value="">همه کاربران متصل</option>
                        </select>
                        <div class="flex gap-4">
                            <input type="text" id="broadcastMsg" class="flex-grow bg-slate-800/50 border border-white/10 rounded-xl px-4 py-3 outline-none focus:border-sky-500 transition-all font-bold text-white text-sm" placeholder="متن پیام برای تمام کاربران...">
                            <button onclick="sendBroadcast()" class="bg-sky-500 hover:bg-sky-600 text-white font-black px-6 py-3 rounded-xl transition-all shadow-lg shadow-sky-500/20">ارسال</button>
                        </div>
                        <div class="flex items-center gap-4">
                            <div class="flex-grow flex items-center gap-2 bg-slate-800/50 border border-white/10 rounded-xl px-4 py-2">
                                <i class="fas fa-paperclip text-slate-500"></i>
                                <input type="file" id="broadcastFile" class="hidden" onchange="updateFileLabel()">
                                <label for="broadcastFile" id="fileLabel" class="text-xs text-slate-400 cursor-pointer hover:text-sky-400 truncate">انتخاب فایل یا صدا...</label>
                            </div>
                            <button onclick="clearFile()" class="text-slate-500 hover:text-rose-500 transition-colors"><i class="fas fa-times"></i></button>
                        </div>
                    </div>
                </div>
                <div class="glass p-8 flex flex-col h-[300px]">
                    <div class="flex justify-between items-center mb-6">
                        <h3 class="text-xl font-black text-white flex items-center gap-3">
                            <i class="fas fa-terminal text-sky-500"></i>
                            گزارشات زنده
                        </h3>
                        <div class="flex items-center gap-4">
                             <div class="flex items-center gap-2 bg-white/5 px-2 py-1 rounded-lg border border-white/5">
                                 <button onclick="prevLogPage()" id="prevLogBtn" class="text-slate-400 hover:text-sky-400 transition-colors disabled:opacity-30 disabled:cursor-not-allowed">
                                     <i class="fas fa-chevron-right text-[10px]"></i>
                                 </button>
                                 <span id="logPageIndicator" class="text-[10px] font-black text-white min-w-[60px] text-center">صفحه ۱</span>
                                 <button onclick="nextLogPage()" id="nextLogBtn" class="text-slate-400 hover:text-sky-400 transition-colors disabled:opacity-30 disabled:cursor-not-allowed">
                                     <i class="fas fa-chevron-left text-[10px]"></i>
                                 </button>
                             </div>
                             <div class="flex gap-2">
                                 <button onclick="downloadLogs()" class="text-[10px] font-black text-sky-400 hover:text-sky-300 transition-colors">
                                     <i class="fas fa-download ml-1"></i>دریافت فایل
                                 </button>
                                 <button onclick="clearLogs()" class="text-[10px] font-black text-rose-500 hover:text-rose-400 transition-colors">
                                     <i class="fas fa-trash ml-1"></i>پاکسازی
                                 </button>
                             </div>
                        </div>
                    </div>
                    <div id="logContainer" class="flex-grow overflow-y-auto space-y-2 pr-2 text-[10px] font-mono custom-scrollbar">
                        <!-- Logs injected here -->
                    </div>
                </div>
            </div>
        </div>

        <div class="glass p-8 mb-8">
            <div class="flex justify-between items-center mb-6">
                <h3 class="text-xl font-black text-white flex items-center gap-3">
                    <i class="fas fa-user-clock text-amber-500"></i>
                    کاربران در حالت تعلیق
                </h3>
                <span id="suspendedCount" class="text-[10px] text-amber-300 font-black px-3 py-1 bg-amber-500/10 rounded-lg">۰ کاربر</span>
            </div>
            <div class="overflow-x-auto custom-scrollbar">
                <table class="w-full text-right">
                    <thead>
                        <tr class="text-slate-500 text-[10px] font-black uppercase tracking-wider border-b border-white/5">
                            <th class="pb-4 pr-4">کاربر</th>
                            <th class="pb-4">اثر انگشت / IP</th>
                            <th class="pb-4">زمان تعلیق</th>
                            <th class="pb-4 text-left pl-4">عملیات</th>
                        </tr>
                    </thead>
                    <tbody id="suspendedTableBody" class="text-xs"></tbody>
                </table>
            </div>
        </div>

        <div class="glass p-8 mb-8">
            <div class="flex justify-between items-center mb-6">
                <h3 class="text-xl font-black text-white flex items-center gap-3">
                    <i class="fas fa-user-slash text-rose-500"></i>
                    کاربران اخراج شده
                </h3>
                <span id="kickedCount" class="text-[10px] text-rose-300 font-black px-3 py-1 bg-rose-500/10 rounded-lg">۰ کاربر</span>
            </div>
            <div class="overflow-x-auto custom-scrollbar">
                <table class="w-full text-right">
                    <thead>
                        <tr class="text-slate-500 text-[10px] font-black uppercase tracking-wider border-b border-white/5">
                            <th class="pb-4 pr-4">کاربر</th>
                            <th class="pb-4">اثر انگشت / IP</th>
                            <th class="pb-4">مدت اخراج</th>
                            <th class="pb-4 text-left pl-4">عملیات</th>
                        </tr>
                    </thead>
                    <tbody id="kickedTableBody" class="text-xs"></tbody>
                </table>
            </div>
        </div>

        <!-- System Details Footer -->
        <div class="glass p-8 relative border-white/5 overflow-hidden">
             <div class="absolute -left-20 -bottom-20 w-64 h-64 bg-sky-500/5 rounded-full blur-3xl"></div>
             <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-8 relative z-10">
                <div class="space-y-4">
                    <div class="flex flex-col">
                        <span class="text-slate-500 text-[10px] font-black mb-1 uppercase tracking-widest">سیستم عامل میزبان</span>
                        <span id="sysPlatform" class="font-black text-white text-sm">--</span>
                    </div>
                    <div class="flex flex-col">
                        <span class="text-slate-500 text-[10px] font-black mb-1 uppercase tracking-widest">محیط Node.js</span>
                        <span id="sysNode" class="font-black text-sky-400 font-mono text-base">--</span>
                    </div>
                    <div class="flex flex-col">
                        <span class="text-slate-500 text-[10px] font-black mb-1 uppercase tracking-widest">مدت زمان فعالیت (Uptime)</span>
                        <span id="sysUptimeDisplay" class="font-black text-white text-sm">--</span>
                    </div>
                </div>
                <div class="space-y-4">
                    <div class="flex flex-col">
                        <span class="text-slate-500 text-[10px] font-black mb-1 uppercase tracking-widest">پورت‌های عملیاتی</span>
                        <div class="flex gap-2 mt-1">
                            <span class="port-tag">API: ${PORT}</span>
                            <span class="port-tag">WS: ${PRESENCE_PORT}</span>
                        </div>
                    </div>
                    <div class="flex flex-col">
                        <span class="text-slate-500 text-[10px] font-black mb-1 uppercase tracking-widest">وضعیت TURN Relay</span>
                        <span id="sysTurn" class="font-black text-sm">--</span>
                    </div>
                </div>
                <div class="space-y-4">
                    <div class="flex flex-col">
                        <span class="text-slate-500 text-[10px] font-black mb-1 uppercase tracking-widest">دامنه متصل</span>
                        <span class="font-black text-indigo-400 text-sm truncate">${host}</span>
                    </div>
                    <div class="flex flex-col">
                        <span class="text-slate-500 text-[10px] font-black mb-1 uppercase tracking-widest">حافظه کل سیستم</span>
                        <span id="sysTotalMem" class="font-black text-white text-sm">--</span>
                    </div>
                </div>
                <div class="flex flex-col items-center justify-center border-r border-white/5 pr-6">
                    <p class="text-[10px] text-slate-500 mb-2 font-black">آخرین واکشی اطلاعات</p>
                    <div id="lastUpdated" class="text-2xl font-black font-mono text-white tracking-tighter">--</div>
                    <div class="text-[9px] text-sky-500 mt-2 font-bold bg-sky-500/10 px-4 py-1.5 rounded-full border border-sky-500/20">SYNCHRONIZED</div>
                </div>
             </div>
        </div>

        <footer class="mt-12 text-center pb-10">
            <div class="w-16 h-1 bg-gradient-to-r from-transparent via-sky-500 to-transparent mx-auto mb-6"></div>
            <p class="text-slate-500 text-[10px] font-black uppercase tracking-[0.4em]">P00RIJA Chat Signaling Infrastructure</p>
            <p class="text-slate-700 text-[9px] mt-2 font-bold">STABLE RELEASE 3.0 | PROFESSIONAL DASHBOARD</p>
        </footer>
    </div>

    <!-- Password Modal -->
    <div id="passwordModal" class="fixed inset-0 bg-[#020617]/90 backdrop-blur-2xl z-50 hidden flex items-center justify-center p-4">
        <div class="glass max-w-md w-full p-10 shadow-[0_0_100px_rgba(14,165,233,0.1)] scale-95 transition-all duration-300 border-sky-500/20" id="modalContent">
            <div class="w-16 h-16 bg-sky-500/10 rounded-full flex items-center justify-center mx-auto mb-6 border border-sky-500/20">
                <i class="fas fa-lock text-sky-400 text-2xl"></i>
            </div>
            <h2 class="text-2xl font-black mb-2 text-white text-center">تنظیمات امنیتی</h2>
            <p class="text-slate-500 text-center text-sm mb-8 font-bold">تغییر رمز عبور مدیریت سامانه</p>
            <div class="space-y-5">
                <div class="relative">
                    <label class="block text-[11px] font-black text-slate-400 mb-2 mr-1 uppercase">رمز عبور فعلی</label>
                    <div class="relative">
                        <input type="password" id="oldPassword" class="w-full bg-slate-800/50 border border-white/10 rounded-2xl px-6 py-4 outline-none focus:border-sky-500 transition-all font-bold text-white shadow-inner ltr" placeholder="••••••••">
                        <button onclick="togglePass('oldPassword')" class="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500 hover:text-sky-400"><i id="eye-oldPassword" class="fas fa-eye"></i></button>
                    </div>
                </div>
                <div class="relative">
                    <label class="block text-[11px] font-black text-slate-400 mb-2 mr-1 uppercase">رمز عبور جدید</label>
                    <div class="relative">
                        <input type="password" id="newPassword" class="w-full bg-slate-800/50 border border-white/10 rounded-2xl px-6 py-4 outline-none focus:border-sky-500 transition-all font-bold text-white shadow-inner ltr" placeholder="حداقل ۶ کاراکتر">
                        <button onclick="togglePass('newPassword')" class="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500 hover:text-sky-400"><i id="eye-newPassword" class="fas fa-eye"></i></button>
                    </div>
                </div>
                <div class="relative">
                    <label class="block text-[11px] font-black text-slate-400 mb-2 mr-1 uppercase">تکرار رمز عبور جدید</label>
                    <div class="relative">
                        <input type="password" id="confirmPassword" class="w-full bg-slate-800/50 border border-white/10 rounded-2xl px-6 py-4 outline-none focus:border-sky-500 transition-all font-bold text-white shadow-inner ltr" placeholder="••••••••">
                        <button onclick="togglePass('confirmPassword')" class="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500 hover:text-sky-400"><i id="eye-confirmPassword" class="fas fa-eye"></i></button>
                    </div>
                </div>
                <div class="flex flex-col gap-3 pt-4">
                    <button onclick="changePassword()" class="w-full bg-sky-500 hover:bg-sky-600 text-white font-black py-4 rounded-2xl transition-all shadow-xl shadow-sky-500/20 text-lg">بروزرسانی گذرواژه</button>
                    <button onclick="togglePasswordModal()" class="w-full glass hover:bg-white/5 text-white font-black py-4 rounded-2xl transition-all">انصراف</button>
                </div>
            </div>
        </div>
    </div>

    <!-- Policy Modal -->
    <div id="policyModal" class="fixed inset-0 bg-[#020617]/90 backdrop-blur-2xl z-50 hidden flex items-center justify-center p-4">
        <div class="glass max-w-md w-full p-8 shadow-[0_0_100px_rgba(14,165,233,0.1)] scale-95 transition-all duration-300 border-sky-500/20">
            <h2 id="policyModalTitle" class="text-2xl font-black mb-6 text-white text-center">تنظیم زمان</h2>
            <div class="grid grid-cols-4 gap-2 mb-6" dir="ltr">
                <div class="text-center">
                    <input type="number" id="policyDays" min="0" value="0" class="w-full bg-slate-800/50 border border-white/10 rounded-xl px-2 py-3 outline-none focus:border-sky-500 transition-all font-bold text-white shadow-inner text-center text-lg">
                    <label class="block text-[10px] text-slate-400 mt-2 font-black">روز</label>
                </div>
                <div class="text-center">
                    <input type="number" id="policyHours" min="0" value="0" class="w-full bg-slate-800/50 border border-white/10 rounded-xl px-2 py-3 outline-none focus:border-sky-500 transition-all font-bold text-white shadow-inner text-center text-lg">
                    <label class="block text-[10px] text-slate-400 mt-2 font-black">ساعت</label>
                </div>
                <div class="text-center">
                    <input type="number" id="policyMinutes" min="0" value="30" class="w-full bg-slate-800/50 border border-white/10 rounded-xl px-2 py-3 outline-none focus:border-sky-500 transition-all font-bold text-white shadow-inner text-center text-lg">
                    <label class="block text-[10px] text-slate-400 mt-2 font-black">دقیقه</label>
                </div>
                <div class="text-center">
                    <input type="number" id="policySeconds" min="0" value="0" class="w-full bg-slate-800/50 border border-white/10 rounded-xl px-2 py-3 outline-none focus:border-sky-500 transition-all font-bold text-white shadow-inner text-center text-lg">
                    <label class="block text-[10px] text-slate-400 mt-2 font-black">ثانیه</label>
                </div>
            </div>
            
            <div id="policyPermanentWrapper" class="hidden mb-6 flex items-center gap-3 bg-rose-500/10 p-4 rounded-xl border border-rose-500/20">
                <input type="checkbox" id="policyPermanent" class="w-5 h-5 accent-rose-500 bg-slate-800 border-white/10 rounded">
                <label for="policyPermanent" class="text-sm text-rose-400 font-bold select-none cursor-pointer">کاربر به صورت نامحدود از چت‌ها اخراج شود</label>
            </div>

            <div class="flex flex-col gap-3 pt-4">
                <button id="policyModalSubmit" class="w-full bg-sky-500 hover:bg-sky-600 text-white font-black py-4 rounded-2xl transition-all shadow-xl shadow-sky-500/20 text-lg">اعمال تغییرات</button>
                <button onclick="closePolicyModal()" class="w-full glass hover:bg-white/5 text-white font-black py-4 rounded-2xl transition-all">انصراف</button>
            </div>
        </div>
    </div>

    <script>
        let memoryChart, cpuChart, relayChart, networkChart, throughputChart, storageChart, queueChart;
        let refreshTimer = null;
        let logPage = 1;
        const logsPerPage = 15;
        const maxDataPoints = 60;
        const history = { 
            memory: [], cpu: [], relay: [], labels: [],
            bytesIn: [], bytesOut: [], msgsIn: [], msgsOut: [],
            storage: [], queue: []
        };
        let lastRelayCount = 0;
        const monitorTextFa = {
            dashboardSubtitle: 'سامانه متمرکز پایش و کنترل زیرساخت‌های رمزنگاری',
            documentTitle: 'P00RIJÃ Signal Monitor | داشبورد حرفه‌ای مدیریت',
            persian: 'فارسی',
            english: 'English',
            fontTitle: 'فونت',
            fontSizeTitle: 'اندازه نوشتار',
            themeTitle: 'تم',
            small: 'کوچک',
            medium: 'متوسط',
            large: 'بزرگ',
            refresh: 'به‌روزرسانی:',
            oneSecond: '۱ ثانیه',
            twoSeconds: '۲ ثانیه',
            fiveSeconds: '۵ ثانیه',
            security: 'امنیت',
            optimizeRam: 'بهینه‌ساز RAM',
            clearConnections: 'پاکسازی اتصالات',
            logout: 'خروج',
            operational: 'عملیاتی',
            disconnected: 'قطع اتصال',
            connectedUsers: 'کاربران متصل',
            cpuLoad: 'بار سیستم (CPU)',
            memoryRam: 'حافظه (RAM)',
            storageDisk: 'ذخیره‌سازی (Disk)',
            networkPing: 'تأخیر شبکه (Ping)',
            managementConnectionStability: 'پایداری اتصال مدیریت',
            memoryAnalysis: 'تحلیل حافظه (RAM)',
            cpuProcessingLoad: 'بار پردازشی (CPU)',
            suspendedUsers: 'کاربران در حالت تعلیق',
            networkTraffic: 'ترافیک شبکه (I/O)',
            messageThroughput: 'پردازش پیام‌ها',
            storageUsage: 'مصرف فضای ذخیره‌سازی',
            offlineQueue: 'صف پیام‌های آفلاین',
            clearAllQueue: 'پاکسازی کل صف',
            clearErrorQueue: 'پاکسازی پیام‌های خطادار',
            username: 'نام کاربری',
            details: 'مشخصات',
            ipAddress: 'آدرس IP',
            duration: 'مدت',
            actions: 'عملیات',
            broadcastTitle: 'ارسال اعلان سیستمی (Broadcast)',
            allConnectedUsers: 'همه کاربران متصل',
            broadcastPlaceholder: 'متن پیام برای تمام کاربران...',
            send: 'ارسال',
            chooseFile: 'انتخاب فایل یا صدا...',
            liveLogs: 'گزارشات زنده',
            page: 'صفحه',
            pageOf: 'از',
            downloadFile: 'دریافت فایل',
            clear: 'پاکسازی',
            user: 'کاربر',
            fingerprintIp: 'اثر انگشت / IP',
            suspensionTime: 'زمان تعلیق',
            kickedUsers: 'کاربران اخراج شده',
            kickDuration: 'مدت اخراج',
            hostOs: 'سیستم عامل میزبان',
            nodeEnvironment: 'محیط Node.js',
            uptime: 'مدت زمان فعالیت (Uptime)',
            operationalPorts: 'پورت‌های عملیاتی',
            turnStatus: 'وضعیت TURN Relay',
            connectedDomain: 'دامنه متصل',
            totalMemory: 'حافظه کل سیستم',
            lastFetch: 'آخرین واکشی اطلاعات',
            synchronized: 'SYNCHRONIZED',
            securitySettings: 'تنظیمات امنیتی',
            changeAdminPassword: 'تغییر رمز عبور مدیریت سامانه',
            currentPassword: 'رمز عبور فعلی',
            newPassword: 'رمز عبور جدید',
            confirmNewPassword: 'تکرار رمز عبور جدید',
            minSixChars: 'حداقل ۶ کاراکتر',
            updatePassword: 'بروزرسانی گذرواژه',
            cancel: 'انصراف',
            setTime: 'تنظیم زمان',
            day: 'روز',
            hour: 'ساعت',
            minute: 'دقیقه',
            second: 'ثانیه',
            permanentKick: 'کاربر به صورت نامحدود از چت‌ها اخراج شود',
            applyChanges: 'اعمال تغییرات',
            noFingerprint: 'بدون اثر انگشت',
            from: 'از',
            suspend: 'تعلیق',
            kick: 'اخراج',
            usersUnit: 'کاربر',
            unknownUser: 'کاربر ناشناس',
            unknownIp: 'IP نامشخص',
            until: 'تا ',
            noEndTime: 'بدون زمان پایان',
            resume: 'رفع تعلیق',
            unkick: 'رفع اخراج',
            noSuspendedUsers: 'هیچ کاربری در حالت تعلیق نیست.',
            noKickedUsers: 'هیچ کاربری در لیست اخراجی نیست.',
            unlimited: 'بدون محدودیت',
            active: 'عملیاتی ✅',
            inactive: 'غیرفعال ❌',
            confirmClearOffline: 'آیا مایل به پاکسازی کل صف پیام‌های آفلاین هستید؟',
            offlineCleared: 'صف پیام‌های آفلاین با موفقیت پاکسازی شد.',
            confirmClearErrors: 'آیا مایل به پاکسازی پیام‌های دلیور نشده و یا خطادار هستید؟',
            errorsCleared: 'پیام‌های خطادار با موفقیت پاکسازی شدند.',
            serverError: 'خطا در ارتباط با سرور',
            confirmOptimizeRam: 'آیا مایل به آزادسازی حافظه RAM سیستم هستید؟',
            optimizedPrefix: 'بهینه‌سازی انجام شد. حدود ',
            optimizedSuffix: ' مگابایت حافظه آزاد شد.',
            sentPrefix: 'اعلان برای ',
            sentSuffix: ' کاربر ارسال شد',
            errorPrefix: 'خطا: ',
            sendFailed: 'ارسال ناموفق بود',
            sendError: 'خطا در ارسال اعلان',
            minTime: 'حداقل زمان باید بیشتر از صفر باشد.',
            suspendUser: 'تعلیق کاربر',
            confirmPermanentKick: 'این کاربر به صورت نامحدود از چت خارج و به لیست اخراجی‌ها اضافه شود؟',
            confirmKickPrefix: 'این کاربر برای ',
            confirmKickSuffix: ' از چت خارج و تا پایان این زمان امکان اتصال نداشته باشد؟',
            kickFailed: 'اخراج ناموفق بود',
            kickError: 'خطا در اخراج کاربر',
            confirmSuspendPrefix: 'این کاربر برای ',
            confirmSuspendSuffix: ' به حالت تعلیق برود و هیچ فعالیتی در سرور نداشته باشد؟',
            suspendFailed: 'تعلیق ناموفق بود',
            suspendError: 'خطا در تعلیق کاربر',
            confirmResume: 'این کاربر از حالت تعلیق خارج شود؟',
            resumeError: 'خطا در رفع تعلیق',
            confirmUnkick: 'این کاربر از لیست اخراجی خارج شود؟',
            unkickError: 'خطا در رفع اخراج',
            confirmLogout: 'آیا قصد خروج از داشبورد را دارید؟',
            confirmClearMemory: 'آیا مایل به بهینه‌سازی حافظه و پاکسازی اتصالات منقضی شده هستید؟',
            clearedConnectionsPrefix: 'بهینه‌سازی انجام شد: ',
            clearedConnectionsSuffix: ' اتصال منقضی حذف شد.',
            enterCurrentPassword: 'رمز عبور فعلی را وارد کنید',
            newPasswordShort: 'رمز عبور جدید باید حداقل ۶ کاراکتر باشد',
            passwordMismatch: 'رمز عبور جدید و تاییدیه آن مطابقت ندارند',
            passwordChanged: 'رمز عبور با موفقیت تغییر کرد. لطفاً مجدداً وارد شوید.',
            passwordChangeFailed: 'تغییر رمز عبور با خطا مواجه شد',
            serverErrorShort: 'خطا در سرور',
            daysUnit: ' روز',
            hoursUnit: ' ساعت',
            minutesUnit: ' دقیقه',
            secondsUnit: ' ثانیه',
            and: ' و ',
        };
        const monitorTextEn = {
            dashboardSubtitle: 'Central monitoring and control for cryptography infrastructure',
            documentTitle: 'P00RIJÃ Signal Monitor | Professional Management Dashboard',
            persian: 'Persian',
            english: 'English',
            fontTitle: 'Font',
            fontSizeTitle: 'Text size',
            themeTitle: 'Theme',
            small: 'Small',
            medium: 'Medium',
            large: 'Large',
            refresh: 'Refresh:',
            oneSecond: '1 second',
            twoSeconds: '2 seconds',
            fiveSeconds: '5 seconds',
            security: 'Security',
            optimizeRam: 'Optimize RAM',
            clearConnections: 'Clear Connections',
            logout: 'Logout',
            operational: 'Operational',
            disconnected: 'Disconnected',
            connectedUsers: 'Connected Users',
            cpuLoad: 'System Load (CPU)',
            memoryRam: 'Memory (RAM)',
            storageDisk: 'Storage (Disk)',
            networkPing: 'Network Latency (Ping)',
            managementConnectionStability: 'Management connection stability',
            memoryAnalysis: 'Memory Analysis (RAM)',
            cpuProcessingLoad: 'Processing Load (CPU)',
            suspendedUsers: 'Suspended Users',
            networkTraffic: 'Network Traffic (I/O)',
            messageThroughput: 'Message Throughput',
            storageUsage: 'Storage Usage',
            offlineQueue: 'Offline Message Queue',
            clearAllQueue: 'Clear Full Queue',
            clearErrorQueue: 'Clear Error Messages',
            username: 'Username',
            details: 'Details',
            ipAddress: 'IP Address',
            duration: 'Duration',
            actions: 'Actions',
            broadcastTitle: 'System Broadcast',
            allConnectedUsers: 'All connected users',
            broadcastPlaceholder: 'Message text for all users...',
            send: 'Send',
            chooseFile: 'Choose file or audio...',
            liveLogs: 'Live Logs',
            page: 'Page',
            pageOf: 'of',
            downloadFile: 'Download File',
            clear: 'Clear',
            user: 'User',
            fingerprintIp: 'Fingerprint / IP',
            suspensionTime: 'Suspension Time',
            kickedUsers: 'Kicked Users',
            kickDuration: 'Kick Duration',
            hostOs: 'Host Operating System',
            nodeEnvironment: 'Node.js Environment',
            uptime: 'Uptime',
            operationalPorts: 'Operational Ports',
            turnStatus: 'TURN Relay Status',
            connectedDomain: 'Connected Domain',
            totalMemory: 'Total System Memory',
            lastFetch: 'Last Data Fetch',
            synchronized: 'SYNCHRONIZED',
            securitySettings: 'Security Settings',
            changeAdminPassword: 'Change dashboard admin password',
            currentPassword: 'Current Password',
            newPassword: 'New Password',
            confirmNewPassword: 'Confirm New Password',
            minSixChars: 'At least 6 characters',
            updatePassword: 'Update Password',
            cancel: 'Cancel',
            setTime: 'Set Time',
            day: 'Day',
            hour: 'Hour',
            minute: 'Minute',
            second: 'Second',
            permanentKick: 'Kick this user from chats permanently',
            applyChanges: 'Apply Changes',
            noFingerprint: 'No fingerprint',
            from: 'From ',
            suspend: 'Suspend',
            kick: 'Kick',
            usersUnit: 'users',
            unknownUser: 'Unknown user',
            unknownIp: 'Unknown IP',
            until: 'Until ',
            noEndTime: 'No end time',
            resume: 'Resume',
            unkick: 'Remove Kick',
            noSuspendedUsers: 'No users are currently suspended.',
            noKickedUsers: 'No users are currently kicked.',
            unlimited: 'Unlimited',
            active: 'Operational ✅',
            inactive: 'Inactive ❌',
            confirmClearOffline: 'Clear the full offline message queue?',
            offlineCleared: 'The offline message queue was cleared successfully.',
            confirmClearErrors: 'Clear undelivered or errored messages?',
            errorsCleared: 'Errored messages were cleared successfully.',
            serverError: 'Server connection error',
            confirmOptimizeRam: 'Free system RAM now?',
            optimizedPrefix: 'Optimization completed. About ',
            optimizedSuffix: ' MB of memory was freed.',
            sentPrefix: 'Broadcast sent to ',
            sentSuffix: ' users',
            errorPrefix: 'Error: ',
            sendFailed: 'Sending failed',
            sendError: 'Broadcast send error',
            minTime: 'Duration must be greater than zero.',
            suspendUser: 'Suspend User',
            confirmPermanentKick: 'Kick this user from chat permanently and add them to the kicked list?',
            confirmKickPrefix: 'Kick this user for ',
            confirmKickSuffix: ' and block reconnection until that time expires?',
            kickFailed: 'Kick failed',
            kickError: 'Could not kick user',
            confirmSuspendPrefix: 'Suspend this user for ',
            confirmSuspendSuffix: ' and block all server activity?',
            suspendFailed: 'Suspension failed',
            suspendError: 'Could not suspend user',
            confirmResume: 'Resume this suspended user?',
            resumeError: 'Could not resume user',
            confirmUnkick: 'Remove this user from the kicked list?',
            unkickError: 'Could not remove kick',
            confirmLogout: 'Logout from the dashboard?',
            confirmClearMemory: 'Optimize memory and clear expired connections?',
            clearedConnectionsPrefix: 'Optimization completed: ',
            clearedConnectionsSuffix: ' expired connections were removed.',
            enterCurrentPassword: 'Enter the current password',
            newPasswordShort: 'The new password must be at least 6 characters',
            passwordMismatch: 'The new password and confirmation do not match',
            passwordChanged: 'Password changed successfully. Please log in again.',
            passwordChangeFailed: 'Password change failed',
            serverErrorShort: 'Server error',
            daysUnit: ' day',
            hoursUnit: ' hour',
            minutesUnit: ' minute',
            secondsUnit: ' second',
            and: ' and ',
        };
        const monitorTextKeyByFa = Object.fromEntries(Object.entries(monitorTextFa).map(([key, value]) => [value, key]));
        const monitorTextKeyByEn = Object.fromEntries(Object.entries(monitorTextEn).map(([key, value]) => [value, key]));
        function monitorLanguage() {
            return localStorage.getItem('monitor_language_v1') || 'fa';
        }
        function mt(key) {
            const lang = monitorLanguage();
            return (lang === 'en' ? monitorTextEn : monitorTextFa)[key] || monitorTextFa[key] || key;
        }
        /* Everything a peer chose for itself — a username above all — reaches
           this page as markup. The dashboard runs with the admin session, so
           markup is not typography, it is every admin action the page can
           take. Names are displayed, never executed. */
        function esc(value) {
            return String(value ?? '').replace(/[&<>"']/g, (char) => ({
                '&': '&amp;',
                '<': '&lt;',
                '>': '&gt;',
                '"': '&quot;',
                "'": '&#39;'
            }[char]));
        }
        function setMonitorLanguage(lang) {
            localStorage.setItem('monitor_language_v1', lang === 'en' ? 'en' : 'fa');
            applyMonitorLanguage();
            updateStats();
        }
        function translateMonitorTextNode(node) {
            const raw = node.nodeValue || '';
            const trimmed = raw.trim();
            if (!trimmed) return;
            const key = monitorTextKeyByFa[trimmed] || monitorTextKeyByEn[trimmed];
            if (!key) return;
            node.nodeValue = raw.replace(trimmed, mt(key));
        }
        function translateMonitorStaticText(root = document.body) {
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
                acceptNode(node) {
                    const parent = node.parentElement;
                    if (!parent || ['SCRIPT', 'STYLE', 'TEXTAREA'].includes(parent.tagName)) return NodeFilter.FILTER_REJECT;
                    return NodeFilter.FILTER_ACCEPT;
                }
            });
            const nodes = [];
            while (walker.nextNode()) nodes.push(walker.currentNode);
            nodes.forEach(translateMonitorTextNode);
            document.querySelectorAll('[placeholder]').forEach((el) => {
                const key = monitorTextKeyByFa[el.getAttribute('placeholder')] || monitorTextKeyByEn[el.getAttribute('placeholder')];
                if (key) el.setAttribute('placeholder', mt(key));
            });
            document.querySelectorAll('[title]').forEach((el) => {
                const key = monitorTextKeyByFa[el.getAttribute('title')] || monitorTextKeyByEn[el.getAttribute('title')];
                if (key) el.setAttribute('title', mt(key));
            });
        }
        function applyMonitorLanguage() {
            const lang = monitorLanguage();
            document.documentElement.lang = lang;
            document.documentElement.dir = lang === 'fa' ? 'rtl' : 'ltr';
            document.body.dir = lang === 'fa' ? 'rtl' : 'ltr';
            document.title = mt('documentTitle');
            const select = document.getElementById('monitorLanguageSelect');
            if (select) select.value = lang;
            translateMonitorStaticText();
            updateFileLabel();
        }

        /* The session cookie travels on its own for same-origin requests, so
           there is no Authorization header to build any more — and nothing in
           page storage for a cross-site script to steal. */
        function monitorAuthHeaders(includeJson = false) {
            return includeJson ? { 'Content-Type': 'application/json' } : {};
        }

        function applyMonitorAppearance() {
            const font = document.getElementById('monitorFontSelect')?.value || 'Vazirmatn';
            const size = document.getElementById('monitorFontSizeSelect')?.value || '16px';
            const theme = document.getElementById('monitorThemeSelect')?.value || 'dark';
            const zoom = size === '14px' ? '0.92' : (size === '18px' ? '1.08' : '1');
            document.body.classList.remove('monitor-theme-dark', 'monitor-theme-midnight', 'monitor-theme-nord', 'monitor-theme-dracula', 'monitor-theme-linen');
            document.body.classList.add('monitor-theme-' + theme);
            document.documentElement.style.setProperty('--monitor-font', font + ', system-ui, sans-serif');
            document.documentElement.style.setProperty('--monitor-font-size', size);
            document.body.style.zoom = zoom;
            localStorage.setItem('monitor_appearance_v1', JSON.stringify({ font, size, theme }));
        }

        function loadMonitorAppearance() {
            let saved = {};
            try { saved = JSON.parse(localStorage.getItem('monitor_appearance_v1') || '{}'); } catch (_error) {}
            const font = document.getElementById('monitorFontSelect');
            const size = document.getElementById('monitorFontSizeSelect');
            const theme = document.getElementById('monitorThemeSelect');
            if (font && saved.font) font.value = saved.font;
            if (size && saved.size) size.value = saved.size;
            if (theme && saved.theme) theme.value = saved.theme;
            applyMonitorAppearance();
        }

        function formatUptime(seconds) {
            const d = Math.floor(seconds / (3600*24));
            const h = Math.floor(seconds % (3600*24) / 3600);
            const m = Math.floor(seconds % 3600 / 60);
            const s = Math.floor(seconds % 60);
            return \`\${d > 0 ? d + 'd ' : ''}\${h.toString().padStart(2, '0')}:\${m.toString().padStart(2, '0')}:\${s.toString().padStart(2, '0')}\`;
        }

        /* throttle.client is derived from req.ip, which behind a proxy comes from
           a header a client can set. Everything rendered below therefore goes
           through here, even though most of it is the relay's own vocabulary. */
        function escHtml(value) {
            return String(value === undefined || value === null ? '' : value)
                .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        }

        function relayTime(value) {
            const at = Date.parse(value || '');
            if (!Number.isFinite(at)) return '-';
            const locale = monitorLanguage() === 'fa' ? 'fa-IR' : 'en-US';
            return new Date(at).toLocaleString(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        }

        /* The relay throws messages away on purpose: media ages out after a
           week, a mailbox over quota loses its oldest, a text tail past the
           limit is trimmed. None of that used to reach a screen, so a message
           that never arrived was indistinguishable from one never sent. */
        function renderRelayHealth(relay, cert) {
            const instance = document.getElementById('relayInstance');
            const limitsEl = document.getElementById('relayLimits');
            const boxesEl = document.getElementById('relayMailboxes');
            const throttleEl = document.getElementById('relayThrottle');
            const summaryEl = document.getElementById('relayDiscardSummary');
            const bodyEl = document.getElementById('relayDiscardBody');
            if (!limitsEl) return;

            if (!relay) {
                instance.textContent = 'این نسخهٔ سرور این گزارش را نمی‌دهد';
                limitsEl.innerHTML = boxesEl.innerHTML = throttleEl.innerHTML = '';
                summaryEl.textContent = '-';
                bodyEl.innerHTML = '';
                return;
            }

            const limits = relay.limits || {};
            const boxes = relay.mailboxes || {};
            const discarded = relay.discarded || {};
            const throttle = relay.throttle || {};
            const sockets = relay.sockets || {};
            const row = (label, value, warn) => '<li class="flex justify-between gap-3 border-b border-slate-800/60 py-1">'
                + '<span class="text-slate-500">' + escHtml(label) + '</span>'
                + '<strong class="' + (warn ? 'text-amber-400' : 'text-white') + ' tabular-nums whitespace-nowrap">'
                + escHtml(value) + '</strong></li>';

            instance.textContent = relay.instanceId || '';

            /* Every reading is printed against its ceiling. A count on its own
               is not information: 412 peers is calm on one machine and the
               edge of capacity on another. */
            limitsEl.innerHTML = [
                row('رده', (limits.tier || '-') + ' · ' + (limits.cpuCount || 0) + ' هسته · ' + (limits.totalMemMb || 0) + ' MB'),
                row('سوکت‌ها', (sockets.total || 0) + ' از ' + (limits.wsMaxTotal || 0),
                    (sockets.total || 0) > (limits.wsMaxTotal || Infinity) * 0.8),
                row('سقف هر آی‌پی', String(limits.wsMaxPerIp || 0)),
                row('اتصال‌های ردشده', (sockets.refused && sockets.refused.total || 0) + ' ('
                    + (sockets.refused && sockets.refused.perIp || 0) + ' سقف آی‌پی، '
                    + (sockets.refused && sockets.refused.capacity || 0) + ' ظرفیت)',
                    (sockets.refused && sockets.refused.total || 0) > 0),
                row('صف متن', (boxes.textEnvelopes || 0) + ' از ' + (limits.textMailboxLimit || 0),
                    (boxes.textEnvelopes || 0) > (limits.textMailboxLimit || Infinity) * 0.8),
                row('سهمیهٔ رسانه', formatBytes(boxes.mediaBytes || 0) + ' از ' + formatBytes(limits.mediaQuotaBytes || 0)
                    + ' (' + (boxes.quotaPercent || 0) + '%)', (boxes.quotaPercent || 0) >= 80),
                row('نگهداری رسانه', Math.round((limits.mediaRetentionMs || 0) / 86400000) + ' روز'),
                row('اشتراک اعلان', (relay.push && relay.push.endpoints || 0) + ' روی ' + (relay.push && relay.push.subscribers || 0) + ' کاربر'),
                row('گواهی TLS', cert && Number.isFinite(cert.daysLeft) ? cert.daysLeft + ' روز مانده' : 'نامعلوم',
                    Boolean(cert && Number.isFinite(cert.daysLeft) && cert.daysLeft < 21)),
            ].join('');

            const fullest = Array.isArray(boxes.fullest) ? boxes.fullest : [];
            boxesEl.innerHTML = fullest.length
                ? fullest.map(box => row(box.fingerprint + '… (' + box.envelopes + ')',
                    formatBytes(box.mediaBytes || 0) + ' · ' + (box.quotaPercent || 0) + '%',
                    (box.quotaPercent || 0) >= 80)).join('')
                : row('هیچ صندوقی در صف نیست', '-');

            /* Addresses that were turned away belong next to the ones being
               throttled: both are people who could not do what they tried. */
            const turnedAway = (sockets.refused && sockets.refused.addresses) || [];
            const near = Array.isArray(throttle.nearOrOverLimit) ? throttle.nearOrOverLimit : [];
            throttleEl.innerHTML = turnedAway.map(item =>
                row('ردشده · ' + item.address, item.count + ' بار', true)).join('') + (near.length
                ? near.map(item => row(item.bucket + ' · ' + item.client,
                    item.count + '/' + item.ceiling + (item.over ? ' ⛔' : ''), true)).join('')
                : (turnedAway.length ? '' : row('هیچ‌کس نزدیک سقف نیست', (throttle.activeBuckets || 0) + ' فعال')));

            const reasons = Object.keys(discarded.byReason || {})
                .map(name => name + ': ' + discarded.byReason[name]).join(' · ');
            summaryEl.textContent = discarded.total
                ? (discarded.last24h || 0) + ' در ۲۴ ساعت، ' + discarded.total + ' روی هم' + (reasons ? ' — ' + reasons : '')
                : 'هیچ پیامی دور ریخته نشده';

            const recent = Array.isArray(discarded.recent) ? discarded.recent : [];
            bodyEl.innerHTML = recent.length
                ? recent.map(item => '<tr class="border-t border-slate-800/60">'
                    + '<td class="py-1 text-slate-300">' + escHtml(item.to) + '…</td>'
                    + '<td class="py-1 text-slate-500">' + escHtml(item.from) + '…</td>'
                    + '<td class="py-1">' + escHtml(item.class) + '</td>'
                    + '<td class="py-1 text-amber-400">' + escHtml(item.reason) + '</td>'
                    + '<td class="py-1 text-slate-500">' + escHtml(relayTime(item.queuedAt)) + '</td>'
                    + '<td class="py-1 text-slate-500">' + escHtml(relayTime(item.expiredAt)) + '</td>'
                    + '</tr>').join('')
                : '<tr><td colspan="6" class="py-3 text-slate-600">چیزی دور ریخته نشده است.</td></tr>';
        }

        function formatBytes(bytes) {
            if (bytes === 0) return '0 B';
            const k = 1024;
            const sizes = ['B', 'KB', 'MB', 'GB'];
            const i = Math.floor(Math.log(bytes) / Math.log(k));
            return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
        }

        function togglePass(id) {
            const input = document.getElementById(id);
            const icon = document.getElementById('eye-' + id);
            if (input.type === 'password') {
                input.type = 'text';
                icon.classList.replace('fa-eye', 'fa-eye-slash');
            } else {
                input.type = 'password';
                icon.classList.replace('fa-eye-slash', 'fa-eye');
            }
        }

        function updateFileLabel() {
            const file = document.getElementById('broadcastFile').files[0];
            document.getElementById('fileLabel').textContent = file ? file.name : mt('chooseFile');
        }

        function clearFile() {
            document.getElementById('broadcastFile').value = '';
            updateFileLabel();
        }

        async function clearOfflineQueue() {
            if (!confirm(mt('confirmClearOffline'))) return;
            try {
                const res = await fetch('/admin/clear-offline', {
                    method: 'POST',
                    headers: monitorAuthHeaders()
                });
                if (res.ok) {
                    alert(mt('offlineCleared'));
                    updateStats();
                }
            } catch (err) { alert(mt('serverError')); }
        }

        async function clearErrorQueue() {
            if (!confirm(mt('confirmClearErrors'))) return;
            try {
                const res = await fetch('/admin/clear-offline', {
                    method: 'POST',
                    headers: monitorAuthHeaders()
                });
                if (res.ok) {
                    alert(mt('errorsCleared'));
                    updateStats();
                }
            } catch (err) { alert(mt('serverError')); }
        }

        async function optimizeRAM() {
            if (!confirm(mt('confirmOptimizeRam'))) return;
            try {
                const res = await fetch('/admin/optimize-ram', {
                    method: 'POST',
                    headers: monitorAuthHeaders()
                });
                const data = await res.json();
                if (data.ok) {
                    alert(mt('optimizedPrefix') + data.saved + mt('optimizedSuffix'));
                }
                updateStats();
            } catch (err) { alert(mt('serverError')); }
        }

        async function sendBroadcast() {
            const msg = document.getElementById('broadcastMsg').value;
            const fileInput = document.getElementById('broadcastFile');
            const file = fileInput.files[0];
            const targetValue = document.getElementById('broadcastTarget').value;
            const target = targetValue ? JSON.parse(decodeURIComponent(targetValue)) : {};
            
            if (!msg && !file) return;

            let fileData = null;
            let fileName = null;
            let kind = 'text';

            if (file) {
                kind = file.type.startsWith('audio/') ? 'voice' : 'file';
                fileName = file.name;
                fileData = await new Promise(resolve => {
                    const reader = new FileReader();
                    reader.onload = () => resolve(reader.result);
                    reader.readAsDataURL(file);
                });
            }

            try {
                const res = await fetch('/admin/broadcast', {
                    method: 'POST',
                    headers: monitorAuthHeaders(true),
                    body: JSON.stringify({
                        message: msg,
                        fileData,
                        fileName,
                        kind,
                        targetClientId: target.clientId || '',
                        targetFingerprint: target.fingerprint || ''
                    })
                });
                const data = await res.json();
                if (data.ok) {
                    alert(mt('sentPrefix') + data.sentTo + mt('sentSuffix'));
                    document.getElementById('broadcastMsg').value = '';
                    clearFile();
                } else {
                    alert(mt('errorPrefix') + (data.reason || mt('sendFailed')));
                }
            } catch (err) { alert(mt('sendError')); }
        }

        let activePolicyResolve = null;
        function closePolicyModal(result = null) {
            document.getElementById('policyModal').classList.add('hidden');
            const resolve = activePolicyResolve;
            activePolicyResolve = null;
            if (resolve) resolve(result);
        }

        function askPolicyDurationModal(actionLabel, allowPermanent) {
            return new Promise((resolve) => {
                if (activePolicyResolve) activePolicyResolve(null);
                activePolicyResolve = resolve;
                const modal = document.getElementById('policyModal');
                const submitBtn = document.getElementById('policyModalSubmit');

                document.getElementById('policyModalTitle').textContent = actionLabel;

                const permWrapper = document.getElementById('policyPermanentWrapper');
                const permCheck = document.getElementById('policyPermanent');

                const updateInputs = () => {
                    const disabled = allowPermanent && permCheck.checked;
                    document.getElementById('policyDays').disabled = disabled;
                    document.getElementById('policyHours').disabled = disabled;
                    document.getElementById('policyMinutes').disabled = disabled;
                    document.getElementById('policySeconds').disabled = disabled;
                };

                if (allowPermanent) {
                    permWrapper.classList.remove('hidden');
                    permCheck.checked = false;
                    permCheck.onchange = updateInputs;
                } else {
                    permWrapper.classList.add('hidden');
                    permCheck.checked = false;
                }
                updateInputs();

                document.getElementById('policyDays').value = 0;
                document.getElementById('policyHours').value = 0;
                document.getElementById('policyMinutes').value = 30;
                document.getElementById('policySeconds').value = 0;

                modal.classList.remove('hidden');

                submitBtn.onclick = () => {
                    if (allowPermanent && permCheck.checked) {
                        closePolicyModal({ permanent: true, minutes: 0, ms: 0 });
                        return;
                    }

                    const d = parseInt(document.getElementById('policyDays').value || 0, 10);
                    const h = parseInt(document.getElementById('policyHours').value || 0, 10);
                    const m = parseInt(document.getElementById('policyMinutes').value || 0, 10);
                    const s = parseInt(document.getElementById('policySeconds').value || 0, 10);

                    const totalMs = (((d * 24 + h) * 60 + m) * 60 + s) * 1000;

                    if (totalMs <= 0) {
                        alert(mt('minTime'));
                        return;
                    }
                    closePolicyModal({ permanent: false, minutes: Math.max(1, Math.ceil(totalMs / 60000)), ms: totalMs });
                };
            });
        }
        function formatPolicyDuration(ms) {
            const totalSeconds = Math.max(1, Math.round(Number(ms || 0) / 1000));
            const d = Math.floor(totalSeconds / 86400);
            const h = Math.floor((totalSeconds % 86400) / 3600);
            const m = Math.floor((totalSeconds % 3600) / 60);
            const s = totalSeconds % 60;
            const parts = [];
            if (d) parts.push(d + mt('daysUnit'));
            if (h) parts.push(h + mt('hoursUnit'));
            if (m) parts.push(m + mt('minutesUnit'));
            if (s) parts.push(s + mt('secondsUnit'));
            return parts.join(mt('and')) || ('1' + mt('secondsUnit'));
        }

        async function kickPeer(clientId) {
            const duration = await askPolicyDurationModal(mt('kick'), true);
            if (!duration) return;
            if (duration.permanent) {
                if (!confirm(mt('confirmPermanentKick'))) return;
            } else {
                const durationLabel = formatPolicyDuration(duration.ms);
                if (!confirm(mt('confirmKickPrefix') + durationLabel + mt('confirmKickSuffix'))) return;
            }
            try {
                const res = await fetch('/admin/kick-peer', {
                    method: 'POST',
                    headers: monitorAuthHeaders(true),
                    body: JSON.stringify({
                        clientId,
                        permanent: Boolean(duration.permanent),
                        durationMinutes: duration.minutes,
                        durationMs: duration.ms
                    })
                });
                const data = await res.json().catch(() => ({}));
                if (res.ok) {
                    updateStats();
                    setTimeout(updateStats, 1200);
                } else {
                    alert(mt('errorPrefix') + (data.reason || mt('kickFailed')));
                }
            } catch (err) { alert(mt('kickError')); }
        }

        async function suspendPeer(clientId) {
            const duration = await askPolicyDurationModal(mt('suspendUser'), false);
            if (!duration) return;
            const durationLabel = formatPolicyDuration(duration.ms);
            if (!confirm(mt('confirmSuspendPrefix') + durationLabel + mt('confirmSuspendSuffix'))) return;
            try {
                const res = await fetch('/admin/suspend-peer', {
                    method: 'POST',
                    headers: monitorAuthHeaders(true),
                    body: JSON.stringify({ clientId, durationMinutes: duration.minutes, durationMs: duration.ms })
                });
                const data = await res.json().catch(() => ({}));
                if (res.ok) {
                    updateStats();
                    setTimeout(updateStats, 1200);
                }
                else alert(mt('errorPrefix') + (data.reason || mt('suspendFailed')));
            } catch (err) { alert(mt('suspendError')); }
        }

        async function resumePeer(key) {
            if (!confirm(mt('confirmResume'))) return;
            try {
                const res = await fetch('/admin/resume-peer', {
                    method: 'POST',
                    headers: monitorAuthHeaders(true),
                    body: JSON.stringify({ key })
                });
                if (res.ok) updateStats();
            } catch (err) { alert(mt('resumeError')); }
        }

        async function unkickPeer(key) {
            if (!confirm(mt('confirmUnkick'))) return;
            try {
                const res = await fetch('/admin/unkick-peer', {
                    method: 'POST',
                    headers: monitorAuthHeaders(true),
                    body: JSON.stringify({ key })
                });
                if (res.ok) updateStats();
            } catch (err) { alert(mt('unkickError')); }
        }

        function logout() {
            if(!confirm(mt('confirmLogout'))) return;
            fetch('/admin/logout', {
                method: 'POST',
                headers: monitorAuthHeaders(),
                cache: 'no-store'
            }).finally(() => {
                localStorage.removeItem('monitor_token_v2');
                document.cookie = "monitor_token_v2=; path=/; Max-Age=0; SameSite=Strict";
                document.cookie = "monitor_token_v2=; path=/Monitor_Server; Max-Age=0; SameSite=Strict";
                window.location.replace('/Monitor_Server?logged_out=' + Date.now());
            });
        }

        function initCharts() {
            const chartConfig = (id, label, color, type = 'line', suggestedMax = 100) => {
                const ctx = document.getElementById(id).getContext('2d');
                const gradient = ctx.createLinearGradient(0, 0, 0, 250);
                gradient.addColorStop(0, color + '55');
                gradient.addColorStop(1, color + '00');

                return new Chart(ctx, {
                    type: 'line',
                    data: {
                        labels: [],
                        datasets: [{
                            label: label,
                            data: [],
                            borderColor: color,
                            backgroundColor: gradient,
                            fill: true,
                            tension: 0.4,
                            borderWidth: 2,
                            pointRadius: 0
                        }]
                    },
                    options: {
                        responsive: true,
                        maintainAspectRatio: false,
                        interaction: { intersect: false, mode: 'index' },
                        scales: {
                            y: { 
                                grid: { color: 'rgba(255,255,255,0.03)' }, 
                                border: { display: false },
                                ticks: { color: '#475569', font: { size: 9, weight: 'bold' } },
                                min: 0,
                                suggestedMax: suggestedMax
                            },
                            x: { 
                                grid: { display: false }, 
                                border: { display: false },
                                ticks: { color: '#475569', font: { size: 9, weight: 'bold' }, maxRotation: 0 } 
                            }
                        },
                        plugins: { legend: { display: false } },
                        animation: { duration: 0 }
                    }
                });
            };

            memoryChart = chartConfig('memoryChart', 'RAM (MB)', '#0ea5e9', 'line', 512);
            cpuChart = chartConfig('cpuChart', 'CPU (%)', '#6366f1', 'line', 100);
            suspendedChart = chartConfig('suspendedChart', 'Suspended Users', '#fbbf24', 'line', 10);
            storageChart = chartConfig('storageChart', 'Storage (%)', '#10b981', 'line', 100);
            queueChart = chartConfig('queueChart', 'Queue', '#f43f5e', 'line', 50);

            const multiChartConfig = (id, datasets) => {
                const ctx = document.getElementById(id).getContext('2d');
                return new Chart(ctx, {
                    type: 'line',
                    data: {
                        labels: [],
                        datasets: datasets.map(ds => ({
                            label: ds.label,
                            data: [],
                            borderColor: ds.color,
                            backgroundColor: ds.color + '22',
                            fill: true,
                            tension: 0.4,
                            borderWidth: 2,
                            pointRadius: 0
                        }))
                    },
                    options: {
                        responsive: true,
                        maintainAspectRatio: false,
                        scales: {
                            y: { grid: { color: 'rgba(255,255,255,0.03)' }, ticks: { color: '#475569', font: { size: 9 } } },
                            x: { grid: { display: false }, ticks: { color: '#475569', font: { size: 9 }, maxRotation: 0 } }
                        },
                        plugins: { legend: { display: true, labels: { color: '#94a3b8', font: { size: 10, weight: 'bold' }, boxWidth: 10 } } },
                        animation: { duration: 0 }
                    }
                });
            };

            networkChart = multiChartConfig('networkChart', [
                { label: 'Bytes In', color: '#38bdf8' },
                { label: 'Bytes Out', color: '#818cf8' }
            ]);

            throughputChart = multiChartConfig('throughputChart', [
                { label: 'Msgs In', color: '#34d399' },
                { label: 'Msgs Out', color: '#fbbf24' }
            ]);
        }

        async function updateStats() {
            const startTime = Date.now();
            try {
                const res = await fetch('/healthz?_t=' + Date.now(), {
                    headers: monitorAuthHeaders()
                });
                const ping = Date.now() - startTime;
                if (res.status === 401) { window.location.reload(); return; }
                const data = await res.json();
                
                // Update Numeric Stats
                document.getElementById('statPeers').textContent = data.peers;
                document.getElementById('statMemory').textContent = data.memory.heapUsed + ' MB';
                document.getElementById('statCpu').textContent = data.cpuLoad + ' %';
                document.getElementById('statPing').innerHTML = ping + ' <span class="text-sm">ms</span>';
                const locale = monitorLanguage() === 'fa' ? 'fa-IR' : 'en-US';
                document.getElementById('lastUpdated').textContent = new Date().toLocaleTimeString(locale);
                
                if (data.storage) {
                    const usedPerc = Math.round(((data.storage.total - data.storage.free) / data.storage.total) * 100);
                    document.getElementById('statStorage').textContent = usedPerc + ' %';
                    document.getElementById('storageBar').style.width = usedPerc + '%';
                } else {
                    document.getElementById('statStorage').textContent = '---';
                }

                // Progress Bars
                const memPerc = Math.min(100, Math.round((data.memory.heapUsed / data.memory.heapTotal) * 100));
                document.getElementById('memoryBar').style.width = memPerc + '%';
                document.getElementById('cpuBar').style.width = data.cpuLoad + '%';
                
                // System Info
                document.getElementById('sysPlatform').textContent = data.platform;
                document.getElementById('sysNode').textContent = data.nodeVersion;
                document.getElementById('sysUptimeDisplay').innerHTML = \`
                    <div class="flex flex-col gap-1">
                        <div class="flex items-center gap-2"><span class="text-[9px] text-slate-500 w-10">OS:</span><span class="text-white">\${formatUptime(data.sysUptime)}</span></div>
                        <div class="flex items-center gap-2"><span class="text-[9px] text-sky-500 w-10">APP:</span><span class="text-sky-400">\${formatUptime(data.uptime)}</span></div>
                    </div>
                \`;
                document.getElementById('sysTotalMem').textContent = data.totalMem + ' MB';
                document.getElementById('sysTurn').textContent = data.turnEnabled ? mt('active') : mt('inactive');
                renderRelayHealth(data.relay, data.cert);
                document.getElementById('sysTurn').className = data.turnEnabled ? 'font-black text-emerald-400' : 'font-black text-rose-400';

                // Peer List Table
                const tableBody = document.getElementById('peerTableBody');
                const targetSelect = document.getElementById('broadcastTarget');
                const previousTarget = targetSelect.value;
                targetSelect.innerHTML = '<option value="">' + mt('allConnectedUsers') + '</option>' + data.peersList.map(peer => {
                    const value = encodeURIComponent(JSON.stringify({ clientId: peer.clientId, fingerprint: peer.fingerprint || '' }));
                    return \`<option value="\${value}">\${esc(peer.username)} - \${esc(peer.ip.replace('::ffff:', ''))}</option>\`;
                }).join('');
                if ([...targetSelect.options].some(option => option.value === previousTarget)) {
                    targetSelect.value = previousTarget;
                }

                tableBody.innerHTML = data.peersList.map(peer => {
                    const identityPayload = encodeURIComponent(JSON.stringify({
                        username: peer.username || '',
                        clientId: peer.clientId || '',
                        peerId: peer.peerId || '',
                        fingerprint: peer.fingerprint || '',
                        ip: peer.ip || ''
                    })).replace(/'/g, '%27');
                    return \`
                    <tr class="peer-row border-b border-white/5 transition-colors">
                        <td class="py-4 pr-4">
                            <div class="font-black text-white">\${esc(peer.username)}</div>
                            <button onclick="showPeerIdentity('\${identityPayload}')" class="mt-2 text-[10px] text-sky-400 hover:text-sky-300 font-black px-3 py-1.5 rounded-lg bg-sky-500/10 border border-sky-500/10 transition-all">\${mt('details')}</button>
                        </td>
                        <td class="py-4 font-mono text-xs text-slate-400">\${esc(peer.ip.replace('::ffff:', ''))}</td>
                        <td class="py-4 text-slate-400">
                             <div class="text-xs font-bold">\${formatUptime(Math.floor((Date.now() - peer.connectedAt)/1000))}</div>
                             <div class="text-[9px] text-slate-600">\${mt('from')}\${new Date(peer.connectedAt).toLocaleTimeString(locale)}</div>
                        </td>
                        <td class="py-4 text-left pl-4">
                            <div class="flex justify-end gap-3">
                                <button onclick="suspendPeer('\${esc(peer.clientId)}')" class="text-amber-400 hover:text-amber-300 font-bold transition-colors">\${mt('suspend')}</button>
                                <button onclick="kickPeer('\${esc(peer.clientId)}')" class="text-rose-500 hover:text-rose-400 font-bold transition-colors">\${mt('kick')}</button>
                            </div>
                        </td>
                    </tr>
                \`;
                }).join('');

                const suspended = data.suspendedUsers || [];
                document.getElementById('suspendedCount').textContent = suspended.length + ' ' + mt('usersUnit');
                document.getElementById('suspendedTableBody').innerHTML = suspended.length ? suspended.map(user => \`
                    <tr class="border-b border-white/5">
                        <td class="py-4 pr-4">
                            <div class="font-black text-white">\${esc(user.username) || mt('unknownUser')}</div>
                            <div class="text-[9px] text-slate-500 font-mono truncate max-w-[180px]">\${esc(user.peerId || user.clientId || user.key)}</div>
                        </td>
                        <td class="py-4 text-slate-400">
                            <div class="font-mono text-[10px] truncate max-w-[220px]">\${esc(user.fingerprint) || mt('noFingerprint')}</div>
                            <div class="text-[9px] text-slate-600">\${esc(user.ip) || mt('unknownIp')}</div>
                        </td>
                        <td class="py-4 text-slate-400">
                            <div>\${user.createdAt ? new Date(user.createdAt).toLocaleString(locale) : '--'}</div>
                            <div class="text-[9px] text-amber-300 mt-1">\${user.expiresAt ? mt('until') + new Date(user.expiresAt).toLocaleString(locale) : mt('noEndTime')}</div>
                        </td>
                        <td class="py-4 text-left pl-4">
                            <button onclick="resumePeer('\${esc(user.key)}')" class="text-emerald-400 hover:text-emerald-300 font-bold transition-colors">\${mt('resume')}</button>
                        </td>
                    </tr>
                \`).join('') : '<tr><td colspan="4" class="py-8 text-center text-slate-500 font-bold">' + mt('noSuspendedUsers') + '</td></tr>';

                const kicked = data.kickedUsers || [];
                document.getElementById('kickedCount').textContent = kicked.length + ' ' + mt('usersUnit');
                document.getElementById('kickedTableBody').innerHTML = kicked.length ? kicked.map(user => \`
                    <tr class="border-b border-white/5">
                        <td class="py-4 pr-4">
                            <div class="font-black text-white">\${esc(user.username) || mt('unknownUser')}</div>
                            <div class="text-[9px] text-slate-500 font-mono truncate max-w-[180px]">\${esc(user.peerId || user.clientId || user.key)}</div>
                        </td>
                        <td class="py-4 text-slate-400">
                            <div class="font-mono text-[10px] truncate max-w-[220px]">\${esc(user.fingerprint) || mt('noFingerprint')}</div>
                            <div class="text-[9px] text-slate-600">\${esc(user.ip) || mt('unknownIp')}</div>
                        </td>
                        <td class="py-4 text-slate-400">
                            <div>\${user.createdAt ? new Date(user.createdAt).toLocaleString(locale) : '--'}</div>
                            <div class="text-[9px] text-rose-300 mt-1">\${user.permanent ? mt('unlimited') : (user.expiresAt ? mt('until') + new Date(user.expiresAt).toLocaleString(locale) : '--')}</div>
                        </td>
                        <td class="py-4 text-left pl-4">
                            <button onclick="unkickPeer('\${esc(user.key)}')" class="text-emerald-400 hover:text-emerald-300 font-bold transition-colors">\${mt('unkick')}</button>
                        </td>
                    </tr>
                \`).join('') : '<tr><td colspan="4" class="py-8 text-center text-slate-500 font-bold">' + mt('noKickedUsers') + '</td></tr>';

                // Logs
                const logContainer = document.getElementById('logContainer');
                const totalLogs = data.logs.length;
                const totalPages = Math.ceil(totalLogs / logsPerPage) || 1;
                if (logPage > totalPages) logPage = totalPages;
                
                document.getElementById('logPageIndicator').textContent = mt('page') + ' ' + logPage + ' ' + mt('pageOf') + ' ' + totalPages;
                document.getElementById('prevLogBtn').disabled = logPage <= 1;
                document.getElementById('nextLogBtn').disabled = logPage >= totalPages;

                const start = (logPage - 1) * logsPerPage;
                const end = start + logsPerPage;
                const paginatedLogs = data.logs.slice(start, end);

                const atBottom = logContainer.scrollHeight - logContainer.scrollTop <= logContainer.clientHeight + 50;
                logContainer.innerHTML = paginatedLogs.map(log => \`
                    <div class="log-entry log-\${log.type} p-2 rounded-r flex gap-3">
                        <span class="text-slate-600 font-bold">\${new Date(log.ts).toLocaleTimeString(locale)}</span>
                        <span class="text-slate-300">\${log.msg}</span>
                    </div>
                \`).join('');
                if(atBottom && logPage === totalPages) logContainer.scrollTop = logContainer.scrollHeight;

                // Update Charts
                const time = new Date().toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                
                let currentRelay = 0;
                if (lastRelayCount > 0) {
                    currentRelay = Math.max(0, data.traffic.relays - lastRelayCount);
                }
                lastRelayCount = data.traffic.relays;

                let currentBytesIn = 0;
                let currentBytesOut = 0;
                if (window.lastBytesIn > 0) currentBytesIn = Math.max(0, data.traffic.bytesIn - window.lastBytesIn);
                if (window.lastBytesOut > 0) currentBytesOut = Math.max(0, data.traffic.bytesOut - window.lastBytesOut);
                window.lastBytesIn = data.traffic.bytesIn;
                window.lastBytesOut = data.traffic.bytesOut;

                let currentMsgsIn = 0;
                let currentMsgsOut = 0;
                if (window.lastMsgsIn > 0) currentMsgsIn = Math.max(0, data.traffic.msgsIn - window.lastMsgsIn);
                if (window.lastMsgsOut > 0) currentMsgsOut = Math.max(0, data.traffic.msgsOut - window.lastMsgsOut);
                window.lastMsgsIn = data.traffic.msgsIn;
                window.lastMsgsOut = data.traffic.msgsOut;

                history.labels.push(time);
                history.memory.push(data.memory.heapUsed);
                history.cpu.push(data.cpuLoad);
                history.relay.push(data.suspendedUsers?.length || 0);
                history.bytesIn.push(currentBytesIn);
                history.bytesOut.push(currentBytesOut);
                history.msgsIn.push(currentMsgsIn);
                history.msgsOut.push(currentMsgsOut);

                const storagePerc = data.storage ? Math.round(((data.storage.total - data.storage.free) / data.storage.total) * 100) : 0;
                history.storage.push(storagePerc);
                history.queue.push(data.queuedMessages || 0);

                if (history.labels.length > maxDataPoints) {
                    history.labels.shift();
                    history.memory.shift();
                    history.cpu.shift();
                    history.relay.shift();
                    history.bytesIn.shift();
                    history.bytesOut.shift();
                    history.msgsIn.shift();
                    history.msgsOut.shift();
                    history.storage.shift();
                    history.queue.shift();
                }

                memoryChart.data.labels = history.labels;
                memoryChart.data.datasets[0].data = history.memory;
                memoryChart.update('none');

                cpuChart.data.labels = history.labels;
                cpuChart.data.datasets[0].data = history.cpu;
                cpuChart.update('none');

                suspendedChart.data.labels = history.labels;
                suspendedChart.data.datasets[0].data = history.relay;
                suspendedChart.update('none');
                networkChart.data.labels = history.labels;
                networkChart.data.datasets[0].data = history.bytesIn;
                networkChart.data.datasets[1].data = history.bytesOut;
                networkChart.update('none');

                throughputChart.data.labels = history.labels;
                throughputChart.data.datasets[0].data = history.msgsIn;
                throughputChart.data.datasets[1].data = history.msgsOut;
                throughputChart.update('none');

                storageChart.data.labels = history.labels;
                storageChart.data.datasets[0].data = history.storage;
                storageChart.update('none');

                queueChart.data.labels = history.labels;
                queueChart.data.datasets[0].data = history.queue;
                queueChart.update('none');
                
                document.getElementById('statusIndicator').innerHTML = '<span class="w-3 h-3 bg-green-500 rounded-full animate-pulse shadow-[0_0_15px_rgba(34,197,94,0.8)]"></span> ' + mt('operational');
            } catch (err) {
                console.error(err);
                document.getElementById('statusIndicator').innerHTML = '<span class="w-3 h-3 bg-red-500 rounded-full"></span> ' + mt('disconnected');
            }
        }

        function setupAutoRefresh() {
            if (refreshTimer) clearInterval(refreshTimer);
            const interval = parseInt(document.getElementById('refreshInterval').value);
            refreshTimer = setInterval(updateStats, interval);
        }

        function showPeerIdentity(encoded) {
            try {
                const peer = JSON.parse(decodeURIComponent(encoded));
                alert([
                    mt('username') + ': ' + (peer.username || '--'),
                    'Client ID: ' + (peer.clientId || '--'),
                    'Peer ID: ' + (peer.peerId || '--'),
                    'Fingerprint: ' + (peer.fingerprint || mt('noFingerprint')),
                    'IP: ' + String(peer.ip || '--').replace('::ffff:', '')
                ].join('\\n\\n'));
            } catch (_error) {
                alert(mt('noFingerprint'));
            }
        }

        async function clearMemory() {
            if (!confirm(mt('confirmClearMemory'))) return;
            try {
                const res = await fetch('/admin/clear-memory', {
                    method: 'POST',
                    headers: monitorAuthHeaders()
                });
                const data = await res.json();
                if (data.ok) {
                    alert(mt('clearedConnectionsPrefix') + data.clearedPresence + mt('clearedConnectionsSuffix'));
                }
                updateStats();
            } catch (err) { alert(mt('serverError')); }
        }

        function downloadLogs() {
            const logs = document.getElementById('logContainer').innerText;
            const blob = new Blob([logs], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = \`signal-server-logs-\${new Date().toISOString()}.txt\`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }

        function prevLogPage() {
            if (logPage > 1) {
                logPage--;
                updateStats();
            }
        }

        function nextLogPage() {
            logPage++;
            updateStats();
        }

        function clearLogs() {
            document.getElementById('logContainer').innerHTML = '';
            logPage = 1;
        }

        async function changePassword() {
            const oldPass = document.getElementById('oldPassword').value;
            const newPass = document.getElementById('newPassword').value;
            const confirmPass = document.getElementById('confirmPassword').value;
            
            if (!oldPass) { alert(mt('enterCurrentPassword')); return; }
            if (newPass.length < 6) { alert(mt('newPasswordShort')); return; }
            if (newPass !== confirmPass) { alert(mt('passwordMismatch')); return; }

            try {
                const res = await fetch('/admin/change-password', {
                    method: 'POST',
                    headers: monitorAuthHeaders(true),
                    body: JSON.stringify({ oldPassword: oldPass, newPassword: newPass })
                });
                if (res.ok) {
                    alert(mt('passwordChanged'));
                    localStorage.removeItem('monitor_token_v2');
                    window.location.reload();
                } else {
                    const data = await res.json();
                    alert(mt('errorPrefix') + (data.reason || mt('passwordChangeFailed')));
                }
            } catch (err) { alert(mt('serverErrorShort')); }
        }

        function togglePasswordModal() {
            const modal = document.getElementById('passwordModal');
            const content = document.getElementById('modalContent');
            if (modal.classList.contains('hidden')) {
                modal.classList.remove('hidden');
                setTimeout(() => content.classList.remove('scale-95'), 10);
            } else {
                content.classList.add('scale-95');
                setTimeout(() => modal.classList.add('hidden'), 300);
            }
        }

        document.getElementById('refreshInterval').addEventListener('change', setupAutoRefresh);

        loadMonitorAppearance();
        applyMonitorLanguage();
        initCharts();
        updateStats();
        setupAutoRefresh();
    </script>
</body>
</html>
  `;
}

module.exports = { monitorLoginHtml, monitorClassicHtml };

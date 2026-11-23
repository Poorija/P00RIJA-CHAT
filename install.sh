#!/usr/bin/env bash
# P00RIJA Chat — end-to-end encrypted messenger.
# Copyright (C) 2026 Poorija <p00rija@tutamail.com>
#
# Licensed under the GNU Affero General Public License, version 3 only.
# See LICENSE for the full text. Section 13 matters here: run a modified
# version as a network service and its users are entitled to your source.

# ---------------------------------------------------------------------------
# P00RIJA Chat — the installer.   نصب‌کنندهٔ P00RIJA Chat
#
#   One line, on a bare server (as root, or with sudo):
#
#     curl -fsSL https://raw.githubusercontent.com/Poorija/P00RIJA-CHAT/main/install.sh | sudo bash
#
#   Easy install — asks three questions at most (where people will reach the
#   server, an e-mail for the certificate, the port) and does everything else:
#
#     ... | sudo bash                       # asks, in Persian or English
#     ... | sudo bash -s -- --easy --domain chat.example.com --email you@example.com
#     ... | sudo bash -s -- --easy --ip 203.0.113.7
#     ... | sudo bash -s -- --easy --local               # this machine / this LAN only
#
#   Custom install — the full wizard (whiptail): every choice, one at a time.
#
#     ... | sudo bash -s -- --custom
#
#   Certificates (the stack reads one folder and the renewer container keeps it):
#     --letsencrypt            issue from Let's Encrypt, renewed 10 days early
#                              (a public name, or a public IP: 6-day certificates)
#     --self-signed            made here, made again before it runs out
#     --cert-dir DIR           a folder that already holds this server's
#                              certificate (3X-UI's /root/cert/<domain>/, certbot's
#                              live/<domain>/, acme.sh's, ...): served in place, so
#                              the program that renews it keeps renewing it for
#                              both. With --letsencrypt this stack renews it there.
#     (with a domain and no flag, the usual folders are looked in first, and what
#      is found is offered before anything is issued)
#
#   Other options:
#     --domain NAME | --ip ADDRESS | --local     where people reach it
#     --port N              the public port (default 1122)
#     --email ADDRESS       for Let's Encrypt expiry notices
#     --password TEXT       the monitor dashboard's password (12+ characters;
#                           generated and kept in .env when not given)
#     --peers LIST          relays this one carries for: "<id>@<origin>,..."
#     --dir DIR             where it is installed (/opt/p00rija-chat as root)
#     --version TAG         a release (v2.16.0) instead of the main branch
#     --branch NAME         a branch
#     --lang fa|en          the language of this installer
#     --no-start            configure, do not start the containers
#     --yes                 never ask: take the defaults
#
#   Other things this script does:
#     update      pull the latest code and rebuild, keeping .env, certificates,
#                 data and the Docker volumes     ... | sudo bash -s -- update
#     status      is it running, what version, which address
#     uninstall   stop and remove the containers (data kept; add --purge to also
#                 delete the install folder and the Docker volumes)
#
# Piping a script from the internet into a shell deserves the caution it gets:
# read this file first (it is plain bash), or clone the repository and run it.
# ---------------------------------------------------------------------------
set -euo pipefail

REPO="${POORIJA_REPO:-https://github.com/Poorija/P00RIJA-CHAT.git}"
BRANCH="${POORIJA_BRANCH:-main}"
TAG=""
TARGET="${POORIJA_DIR:-}"

ACTION="install"
MODE=""               # easy | custom
LANG_UI="${POORIJA_LANG:-}"
ASSUME_YES=false
PURGE=false
NO_START=false
A_DOMAIN="" ; A_IP="" ; A_LOCAL=false ; A_PORT="" ; A_EMAIL="" ; A_PASS="" ; A_PEERS=""
A_CERT="" ; A_CERT_DIR=""

INFO='\033[1;34m'; OK='\033[1;32m'; WARN='\033[1;33m'; ERR='\033[1;31m'; DIM='\033[2m'; NC='\033[0m'
has() { command -v "$1" >/dev/null 2>&1; }

# ---- language ---------------------------------------------------------------
# m "<persian>" "<english>": the one in the language chosen.
m() { if [ "$LANG_UI" = "fa" ]; then printf '%s' "$1"; else printf '%s' "$2"; fi; }
step() { printf "${INFO}▶ %s${NC}\n" "$(m "$1" "$2")"; }
ok()   { printf "${OK}✓ %s${NC}\n" "$(m "$1" "$2")"; }
warn() { printf "${WARN}⚠ %s${NC}\n" "$(m "$1" "$2")"; }
dim()  { printf "${DIM}  %s${NC}\n" "$(m "$1" "$2")"; }
die()  { printf "${ERR}✗ %s${NC}\n" "$(m "$1" "$2")" >&2; exit 1; }

# ---- arguments ----------------------------------------------------------------
usage() {
    if [ -f "$0" ]; then sed -n '12,62p' "$0" | sed 's/^# \{0,1\}//'
    else printf '%s\n' "Options are listed in the README: https://github.com/Poorija/P00RIJA-CHAT#install-the-server"; fi
}
[ $# -gt 0 ] && case "$1" in install|update|status|uninstall) ACTION="$1"; shift ;; esac
while [ $# -gt 0 ]; do
    case "$1" in
        --easy) MODE=easy; shift ;;
        --custom|--wizard) MODE=custom; shift ;;
        --domain) A_DOMAIN="${2:-}"; shift 2 ;;
        --ip) A_IP="${2:-}"; shift 2 ;;
        --local) A_LOCAL=true; shift ;;
        --port) A_PORT="${2:-}"; shift 2 ;;
        --email) A_EMAIL="${2:-}"; shift 2 ;;
        --password) A_PASS="${2:-}"; shift 2 ;;
        --peers) A_PEERS="${2:-}"; shift 2 ;;
        --letsencrypt) A_CERT=letsencrypt; shift ;;
        --self-signed) A_CERT=self-signed; shift ;;
        --cert-dir) A_CERT_DIR="${2:-}"; shift 2 ;;
        --dir) TARGET="${2:-}"; shift 2 ;;
        --version) TAG="${2:-}"; shift 2 ;;
        --branch) BRANCH="${2:-}"; shift 2 ;;
        --lang) LANG_UI="${2:-}"; shift 2 ;;
        --no-start) NO_START=true; shift ;;
        --yes|-y) ASSUME_YES=true; shift ;;
        --purge) PURGE=true; shift ;;
        -h|--help) usage; exit 0 ;;
        *) printf '%s\n' "Unknown option: $1 (try --help)" >&2; exit 2 ;;
    esac
done

# ---- a terminal to ask on, even under `curl | bash` ---------------------------------
# stdin is the script itself then; the person is at /dev/tty.
TTY=""
if [ -t 0 ]; then TTY=/dev/stdin; elif [ -r /dev/tty ] && ( : </dev/tty ) 2>/dev/null; then TTY=/dev/tty; fi
interactive() { [ -n "$TTY" ] && [ "$ASSUME_YES" = false ]; }
# ask "<fa>" "<en>" default → the answer on stdout; the default when not interactive.
ask() {
    local answer=""
    if interactive; then
        printf "${INFO}? %s${NC} " "$(m "$1" "$2")" >&2
        [ -n "${3:-}" ] && printf "${DIM}[%s]${NC} " "$3" >&2
        IFS= read -r answer <"$TTY" || answer=""
    fi
    printf '%s' "${answer:-${3:-}}"
}

if [ -z "$LANG_UI" ]; then
    case "${LC_ALL:-${LANG:-}}" in fa*|FA*) LANG_UI=fa ;; *) LANG_UI=en ;; esac
    if interactive; then
        printf '\n  1) English\n  2) فارسی\n' >&2
        printf "${INFO}? Language / زبان${NC} ${DIM}[1]${NC} " >&2
        IFS= read -r pick <"$TTY" || pick=""
        case "$pick" in 2|fa|FA) LANG_UI=fa ;; 1|en|EN) LANG_UI=en ;; esac
    fi
fi
case "$LANG_UI" in fa|en) ;; *) LANG_UI=en ;; esac

# ---- where, and as whom -------------------------------------------------------------
if [ "$(id -u)" -eq 0 ]; then SUDO=""; else SUDO="sudo"; fi
[ -n "$TARGET" ] || { [ "$(id -u)" -eq 0 ] && TARGET=/opt/p00rija-chat || TARGET="$HOME/p00rija-chat"; }

case "$(uname -s)" in
    Linux) ;;
    Darwin) warn "macOS میزبان خوبی برای آزمایش است، ولی سرور واقعی باید Linux باشد." "macOS hosts a server fine for a trial, but a real server should be Linux." ;;
    *) die "این سیستم پشتیبانی نمی‌شود: $(uname -s)" "Unsupported system: $(uname -s). Use Linux, or the desktop app." ;;
esac

# ---- packages -----------------------------------------------------------------------
pkg_manager() {
    for pm in apt-get dnf yum pacman zypper apk; do has "$pm" && { echo "$pm"; return; }; done
    echo ""
}
pkg_install() {
    local pm; pm="$(pkg_manager)"
    case "$pm" in
        apt-get) $SUDO apt-get update -qq && $SUDO apt-get install -y "$@" ;;
        dnf)     $SUDO dnf install -y "$@" ;;
        yum)     $SUDO yum install -y "$@" ;;
        pacman)  $SUDO pacman -Sy --noconfirm "$@" ;;
        zypper)  $SUDO zypper --non-interactive install "$@" ;;
        apk)     $SUDO apk add --no-cache "$@" ;;
        *) return 1 ;;
    esac
}

ensure_prereqs() {
    step "بررسی پیش‌نیازها" "Checking prerequisites"
    if [ "$(id -u)" -ne 0 ] && ! has sudo; then
        die "با root یا sudo اجرا کنید: curl ... | sudo bash" "Run as root or with sudo: curl ... | sudo bash"
    fi
    local need=()
    for tool in git curl openssl; do has "$tool" || need+=("$tool"); done
    if [ ${#need[@]} -gt 0 ]; then
        warn "نصب می‌شود: ${need[*]}" "Installing: ${need[*]}"
        pkg_install "${need[@]}" ca-certificates || die "نصب خودکار ممکن نشد؛ خودتان نصب کنید: ${need[*]}" "Could not install them for you; install: ${need[*]}"
    fi
    if [ "$MODE" = custom ] && ! has whiptail; then
        case "$(pkg_manager)" in dnf|yum) pkg_install newt || true ;; *) pkg_install whiptail || true ;; esac
    fi
    if ! has docker; then
        step "نصب Docker Engine" "Installing Docker Engine"
        # Docker's own script: the distro packages are usually too old for the
        # compose plugin this project needs.
        curl -fsSL https://get.docker.com | $SUDO sh || die "Docker نصب نشد." "Docker did not install."
        $SUDO systemctl enable --now docker >/dev/null 2>&1 || true
        [ "$(id -u)" -ne 0 ] && $SUDO usermod -aG docker "$USER" 2>/dev/null || true
    fi
    docker compose version >/dev/null 2>&1 || docker-compose version >/dev/null 2>&1 \
        || die "افزونهٔ Docker Compose در دسترس نیست." "Docker Compose is not available. Install the compose plugin."
    docker info >/dev/null 2>&1 || {
        $SUDO docker info >/dev/null 2>&1 \
            && die "Docker در دسترس این کاربر نیست؛ با sudo اجرا کنید." "Docker needs root here: run this with sudo." \
            || die "Docker نصب است ولی کار نمی‌کند: sudo systemctl start docker" "Docker is installed but not running: sudo systemctl start docker"
    }
    ok "پیش‌نیازها آماده است" "Prerequisites are in place"
}

# ---- the source ---------------------------------------------------------------------
fetch_source() {
    local ref_args=(--branch "$BRANCH")
    [ -n "$TAG" ] && ref_args=(--branch "$TAG")
    if [ -d "$TARGET/.git" ]; then
        step "به‌روزرسانی کدِ $TARGET" "Updating the code in $TARGET"
        git -C "$TARGET" fetch --depth 1 origin "${TAG:-$BRANCH}" 2>/dev/null \
            || git -C "$TARGET" fetch --depth 1 origin "refs/tags/${TAG:-$BRANCH}:refs/tags/${TAG:-$BRANCH}"
        # .env, certs/ and data/ are untracked or ignored: a hard reset leaves them.
        git -C "$TARGET" reset --hard FETCH_HEAD
    else
        [ -e "$TARGET" ] && [ -n "$(ls -A "$TARGET" 2>/dev/null)" ] \
            && die "$TARGET وجود دارد و مخزن git نیست؛ --dir دیگری بدهید." "$TARGET exists and is not a checkout; give another --dir."
        step "دریافت از GitHub در $TARGET" "Cloning from GitHub into $TARGET"
        # Only asks for sudo when the place cannot be made without it.
        mkdir -p "$(dirname "$TARGET")" 2>/dev/null || $SUDO mkdir -p "$(dirname "$TARGET")"
        if [ ! -w "$(dirname "$TARGET")" ] && [ -n "$SUDO" ]; then
            $SUDO mkdir -p "$TARGET" && $SUDO chown "$(id -u):$(id -g)" "$TARGET"
        fi
        git clone --depth 1 "${ref_args[@]}" "$REPO" "$TARGET"
    fi
    chmod +x "$TARGET"/scripts/*.sh 2>/dev/null || true
    ok "کد آماده است" "Source ready"
}

# ---- where people will reach it ---------------------------------------------------
public_ip() {
    local ip=""
    for url in https://api.ipify.org https://ifconfig.me https://icanhazip.com; do
        ip="$(curl -fsS --max-time 6 "$url" 2>/dev/null | tr -d '[:space:]')" && [[ "$ip" =~ ^[0-9]+(\.[0-9]+){3}$ ]] && { echo "$ip"; return; }
    done
    echo ""
}

# dir_trusted DIR: owned by root and not writable by group or others.
dir_trusted() {
    local d="$1" uid mode
    [ -d "$d" ] || return 1
    if stat -c '%u %a' "$d" >/dev/null 2>&1; then read -r uid mode < <(stat -c '%u %a' "$d")
    else read -r uid mode < <(stat -f '%u %Lp' "$d"); fi
    [ "$uid" = 0 ] && [ $(( 8#$mode & 8#022 )) -eq 0 ]
}

# Existing certificates for DOMAIN in the places other programs keep them. The
# folder is served where it is, so whoever renews it keeps renewing it for both.
find_existing_cert() {
    local domain="$1" dir found=()
    # shellcheck disable=SC1091
    . "$TARGET/scripts/lib/cert-folder.sh"
    local candidates=(
        "/root/cert/$domain"                          # 3X-UI
        "/etc/letsencrypt/live/$domain"               # certbot
        "/root/.acme.sh/${domain}_ecc" "/root/.acme.sh/$domain"   # acme.sh
        "/etc/ssl/$domain" "/etc/ssl/private/$domain" "/etc/nginx/ssl/$domain" "/etc/nginx/certs/$domain"
        "/etc/caddy/certs/$domain" "/var/lib/marzban/certs" "/var/lib/marzban/certs/$domain"
    )
    # More places, colon-separated, for a layout this list does not know.
    local extra
    IFS=: read -ra extra <<<"${POORIJA_CERT_DIRS:-}"
    for dir in "${extra[@]:-}"; do [ -n "$dir" ] && candidates+=("$dir"); done
    for d in "${candidates[@]}"; do
            [ -n "$d" ] || continue
            # A root-run installer must not serve a key from a folder somebody
            # else could have written to: root-owned, not writable by group or
            # others, and the same of its parent.
            dir_trusted "$d" && dir_trusted "$(dirname "$d")" || continue
            if cert_find_pair "$d" "$domain" 2>/dev/null && [ "${CERT_PAIR_COVERS:-}" != "no" ]; then
                found+=("$d|${CERT_PAIR_END:-?}")
            fi
    done
    printf '%s\n' "${found[@]:-}"
}

easy_questions() {
    local kind
    if [ -n "$A_DOMAIN" ]; then kind=1
    elif [ -n "$A_IP" ]; then kind=2
    elif [ "$A_LOCAL" = true ]; then kind=3
    else
        printf '\n' >&2
        printf '  1) %s\n  2) %s\n  3) %s\n' \
            "$(m 'یک نام دامنه (مثلاً chat.example.com)' 'A domain name (chat.example.com)')" \
            "$(m 'آدرس IP عمومی این سرور' "This server's public IP address")" \
            "$(m 'فقط همین دستگاه / شبکهٔ محلی' 'This machine and this LAN only')" >&2
        kind="$(ask 'مردم از کجا به سرور وصل می‌شوند؟' 'How will people reach the server?' 1)"
    fi
    case "$kind" in
        1) [ -n "$A_DOMAIN" ] || A_DOMAIN="$(ask 'نام دامنه:' 'Domain name:' '')"
           [ -n "$A_DOMAIN" ] || die "نام دامنه لازم است." "A domain name is needed." ;;
        2) if [ -z "$A_IP" ]; then
               local detected; detected="$(public_ip)"
               A_IP="$(ask 'آدرس IP عمومی:' 'Public IP address:' "$detected")"
           fi
           [ -n "$A_IP" ] || die "آدرس IP لازم است." "An IP address is needed." ;;
        *) A_LOCAL=true ;;
    esac
    [ -n "$A_PORT" ] || A_PORT="$(ask 'پورت (پیش‌فرض ۱۱۲۲):' 'Port:' 1122)"

    local host="${A_DOMAIN:-$A_IP}"
    # Found folders are only ever OFFERED, to a person at a terminal; an
    # unattended run takes a certificate folder only from --cert-dir.
    if interactive && [ -n "$host" ] && [ -z "$A_CERT_DIR" ] && [ -z "$A_CERT" ]; then
        local found; found="$(find_existing_cert "$host" | sed '/^$/d')"
        if [ -n "$found" ]; then
            printf '\n' >&2
            warn "گواهی SSL از قبل روی این سرور هست:" "An SSL certificate for $host is already on this server:"
            local i=0 line
            while IFS= read -r line; do i=$((i+1)); printf '  %d) %s   (%s %s)\n' "$i" "${line%%|*}" "$(m 'انقضا' 'expires')" "${line##*|}" >&2; done <<<"$found"
            printf '  %d) %s\n' "$((i+1))" "$(m 'گواهی تازه بگیر / بساز' 'Get a new one')" >&2
            local pick; pick="$(ask 'کدام را استفاده کنم؟' 'Which one?' 1)"
            if [[ "$pick" =~ ^[0-9]+$ ]] && [ "$pick" -ge 1 ] && [ "$pick" -le "$i" ]; then
                A_CERT_DIR="$(sed -n "${pick}p" <<<"$found")"; A_CERT_DIR="${A_CERT_DIR%%|*}"
                ok "از همان پوشه استفاده می‌شود؛ تمدید با برنامه‌ای است که آن را می‌سازد" "Served from there; whoever renews it keeps renewing it"
            fi
        fi
    fi
    if [ -n "$A_DOMAIN$A_IP" ] && [ -z "$A_CERT_DIR" ] && [ "$A_CERT" != self-signed ] && [ -z "$A_EMAIL" ]; then
        A_EMAIL="$(ask 'ایمیل برای Let'\''s Encrypt (اختیاری):' 'E-mail for Let'\''s Encrypt (optional):' '')"
    fi
}

quick_args() {
    QARGS=()
    [ -n "$A_DOMAIN" ] && QARGS+=(--domain "$A_DOMAIN")
    [ -n "$A_IP" ] && QARGS+=(--ip "$A_IP")
    [ "$A_LOCAL" = true ] && QARGS+=(--local)
    [ -n "$A_PORT" ] && QARGS+=(--port "$A_PORT")
    [ -n "$A_EMAIL" ] && QARGS+=(--email "$A_EMAIL")
    [ -n "$A_PASS" ] && QARGS+=(--password "$A_PASS")
    [ -n "$A_PEERS" ] && QARGS+=(--peers "$A_PEERS")
    [ "$A_CERT" = letsencrypt ] && QARGS+=(--letsencrypt)
    [ "$A_CERT" = self-signed ] && QARGS+=(--self-signed)
    [ -n "$A_CERT_DIR" ] && QARGS+=(--cert-dir "$A_CERT_DIR")
    [ "$NO_START" = true ] && QARGS+=(--no-start)
    return 0
}

env_value() { awk -F= -v k="$1" '$1==k{print substr($0, length(k)+2); exit}' "$TARGET/.env" 2>/dev/null || true; }

report() {
    local host port
    host="$(env_value DOMAIN)"; [ -n "$host" ] && [ "$host" != localhost ] || host="$(env_value EXTERNAL_IP)"
    port="$(env_value APP_PORT)"; port="${port:-1122}"
    printf '\n'
    ok "نصب تمام شد." "Installed."
    printf '  %s  https://%s:%s\n' "$(m 'برنامه:        ' 'Application:    ')" "$host" "$port"
    printf '  %s  https://%s:%s/Monitor_Server\n' "$(m 'داشبورد:       ' 'Monitor:        ')" "$host" "$port"
    printf '  %s  grep MONITOR_PASSWORD %s/.env\n' "$(m 'رمز داشبورد:   ' 'Monitor password:')" "$TARGET"
    printf '\n'
    dim "پورت‌هایی که باید باز باشند: ${port}/tcp (برنامه)، 80/tcp (فقط هنگام صدور گواهی)، 11478 و 11349 و 40000-40500 (تماس‌ها، TURN)." \
        "Ports to open: ${port}/tcp (the app), 80/tcp (only while a certificate is issued), 11478, 11349 and 40000-40500 (calls, TURN)."
    dim "به‌روزرسانی بعدی:  curl -fsSL https://raw.githubusercontent.com/Poorija/P00RIJA-CHAT/main/install.sh | sudo bash -s -- update" \
        "Update later:  curl -fsSL https://raw.githubusercontent.com/Poorija/P00RIJA-CHAT/main/install.sh | sudo bash -s -- update"
}

# ---- the actions --------------------------------------------------------------------
do_install() {
    ensure_prereqs
    fetch_source
    cd "$TARGET"
    if [ -z "$MODE" ]; then
        if [ -n "$A_DOMAIN$A_IP" ] || [ "$A_LOCAL" = true ]; then MODE=easy
        elif interactive; then
            printf '\n  1) %s\n  2) %s\n' "$(m 'نصب آسان (پیشنهادی): چند سؤال کوتاه، بقیه خودکار' 'Easy install (recommended): a few questions, the rest is automatic')" \
                "$(m 'نصب سفارشی: ویزارد کامل با همهٔ گزینه‌ها' 'Custom install: the full wizard, every option')" >&2
            [ "$(ask 'کدام؟' 'Which?' 1)" = 2 ] && MODE=custom || MODE=easy
        else MODE=easy; A_LOCAL=true
        fi
    fi
    if [ "$MODE" = custom ]; then
        interactive || die "نصب سفارشی به ترمینال نیاز دارد." "The custom install needs a terminal."
        has whiptail || ensure_prereqs
        step "ویزارد نصب" "Starting the setup wizard"
        exec bash scripts/setup.sh <"$TTY"
    fi
    easy_questions
    quick_args
    step "نصب" "Installing"
    bash scripts/setup.sh --quick "${QARGS[@]}"
    [ "$NO_START" = true ] || report
}

do_update() {
    [ -d "$TARGET/.git" ] || die "نصبی در $TARGET پیدا نشد." "No install found in $TARGET (use --dir)."
    ensure_prereqs
    fetch_source
    cd "$TARGET"
    step "بازسازی کانتینرها (داده‌ها، .env و گواهی‌ها حفظ می‌شود)" "Rebuilding the containers (data, .env and certificates are kept)"
    bash scripts/setup.sh --update-server-local
}

do_status() {
    [ -d "$TARGET" ] || die "نصبی در $TARGET پیدا نشد." "No install found in $TARGET (use --dir)."
    cd "$TARGET"
    printf '%s %s\n' "$(m 'نسخه:' 'Version:')" "$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' package.json | head -1)"
    docker compose --env-file .env -f config/docker-compose.yaml ps 2>/dev/null || true
    local port host
    port="$(env_value APP_PORT)"; port="${port:-1122}"
    host="$(env_value DOMAIN)"; [ -n "$host" ] || host=localhost
    if curl -ksS --max-time 6 "https://$host:$port/chat-health" 2>/dev/null; then printf '\n'; else warn "پاسخی از /chat-health نیامد." "No answer from /chat-health."; fi
}

do_uninstall() {
    [ -d "$TARGET" ] || die "نصبی در $TARGET پیدا نشد." "No install found in $TARGET (use --dir)."
    cd "$TARGET"
    if [ "$PURGE" = true ]; then
        if interactive; then
            [ "$(ask "همهٔ داده‌ها پاک می‌شود و برگشت ندارد. تایپ کنید DELETE:" "This deletes ALL data and cannot be undone. Type DELETE:" '')" = DELETE ] || die "لغو شد." "Cancelled."
        fi
        docker compose --env-file .env -f config/docker-compose.yaml down -v --remove-orphans || true
        cd /; $SUDO rm -rf -- "$TARGET"
        ok "همه چیز پاک شد." "Everything was removed."
    else
        docker compose --env-file .env -f config/docker-compose.yaml down --remove-orphans || true
        ok "کانتینرها متوقف و حذف شدند؛ داده‌ها و گواهی‌ها در $TARGET ماندند. (--purge برای پاک‌کردن کامل)" "Containers stopped and removed; data and certificates stay in $TARGET. (--purge deletes it all)"
    fi
}

# Sourced by a test, the functions are wanted and nothing else.
[ "${POORIJA_INSTALL_SOURCED:-}" = 1 ] && return 0 2>/dev/null

case "$ACTION" in
    install) do_install ;;
    update) do_update ;;
    status) do_status ;;
    uninstall) do_uninstall ;;
esac

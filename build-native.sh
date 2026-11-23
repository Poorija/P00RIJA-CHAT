#!/usr/bin/env bash
# P00RIJA Chat — end-to-end encrypted messenger.
# Copyright (C) 2026 Poorija <p00rija@tutamail.com>
#
# Licensed under the GNU Affero General Public License, version 3 only.
# See LICENSE for the full text. Section 13 matters here: run a modified
# version as a network service and its users are entitled to your source.

# ---------------------------------------------------------------------------
# Builds the native apps (Tauri 2) — one door for every platform.
#
#   bash build-native.sh                       # a menu
#   bash build-native.sh mac [arm64|x86_64|universal]
#   bash build-native.sh windows [x86_64|arm64]     # from macOS / Linux, in Docker
#   bash build-native.sh linux [x86_64|arm64]       # .deb .rpm .AppImage, in Docker
#   bash build-native.sh android [release|debug]    # APK + AAB
#   bash build-native.sh all                        # every platform this host can
#   bash build-native.sh check                      # what this machine is missing
#
# What it uses, so there is nothing new to learn or to break:
#   macOS    scripts/build-macos.sh      needs a Mac, Xcode command line tools, Rust
#   Windows  scripts/build-windows-docker.sh   NSIS installer, from any host with Docker
#   Linux    scripts/build-native-docker.sh    .deb / .rpm / .AppImage, from any host with Docker
#   Android  scripts/build-android.sh    needs the Android SDK + NDK; signed with your own key
#   all      scripts/release-all.sh      sequential, logged, verified (45-90 minutes)
#
# Everything lands in Export/ (scripts/export-artifacts.sh), with SHA256SUMS.txt,
# and Export/GitHub/ holds exactly the files to attach to a GitHub release
# (scripts/github-release-files.sh).
#
# Native builds are not the same as the web app: the web app needs none of this,
# it installs from the server's address (see INSTALL.md).
# ---------------------------------------------------------------------------
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

INFO='\033[1;34m'; OK='\033[1;32m'; WARN='\033[1;33m'; ERR='\033[1;31m'; DIM='\033[2m'; NC='\033[0m'
log()  { printf "${INFO}▶ %s${NC}\n" "$1"; }
ok()   { printf "${OK}✓ %s${NC}\n" "$1"; }
warn() { printf "${WARN}! %s${NC}\n" "$1"; }
fail() { printf "${ERR}✖ %s${NC}\n" "$1" >&2; }
has()  { command -v "$1" >/dev/null 2>&1; }

VERSION="$(node -p "require('./src-tauri/tauri.conf.json').version" 2>/dev/null || sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' package.json | head -1)"

check() {
    local bad=0
    log "P00RIJA Chat ${VERSION} — build prerequisites on $(uname -s) $(uname -m)"
    for tool in node npm; do has "$tool" && ok "$tool $($tool --version)" || { fail "$tool is missing"; bad=1; }; done
    has cargo && ok "$(cargo --version)" || { warn "Rust is missing: curl https://sh.rustup.rs -sSf | sh"; bad=1; }
    [ -d node_modules ] && ok "node_modules present" || { warn "run: npm ci"; bad=1; }
    if has docker && docker info >/dev/null 2>&1; then ok "Docker is running (Windows and Linux builds)"; else warn "Docker is not running: the Windows and Linux builds need it"; fi
    if [ "$(uname -s)" = Darwin ]; then
        xcode-select -p >/dev/null 2>&1 && ok "Xcode command line tools" || { warn "xcode-select --install"; bad=1; }
    else
        warn "macOS builds need a Mac"
    fi
    if [ -n "${ANDROID_HOME:-}" ] && [ -d "${ANDROID_HOME:-/nonexistent}" ]; then ok "Android SDK at $ANDROID_HOME"; else warn "no Android SDK (ANDROID_HOME): the Android build needs it"; fi
    return $bad
}

need_deps() {
    [ -d node_modules ] || { log "Installing Node dependencies"; npm ci || return 1; }
}

run() { log "$*"; "$@"; local code=$?; [ $code -eq 0 ] && ok "done" || fail "failed ($code)"; return $code; }

build() {
    local target="${1:-}" arg="${2:-}"
    need_deps || exit 1
    case "$target" in
        mac|macos)
            [ "$(uname -s)" = Darwin ] || { fail "macOS apps are built on a Mac."; exit 1; }
            run bash scripts/build-macos.sh "${arg:-universal}" ;;
        windows|win)
            has docker || { fail "Docker is needed for the Windows build."; exit 1; }
            run bash scripts/build-windows-docker.sh "${arg:-x86_64}" ;;
        linux)
            has docker || { fail "Docker is needed for the Linux build."; exit 1; }
            case "${arg:-x86_64}" in
                arm64|aarch64) run bash scripts/build-native-docker.sh 'npm run native:build:linux:arm64' ;;
                *) run bash scripts/build-native-docker.sh ;;
            esac ;;
        android)
            run bash scripts/build-android.sh "${arg:-release}" ;;
        all)
            run bash scripts/release-all.sh "${@:2}" ;;
        *) usage; exit 2 ;;
    esac
    local code=$?
    if [ $code -eq 0 ] && [ "$target" != all ]; then
        log "Collecting into Export/"
        bash scripts/export-artifacts.sh || true
        ok "Export/ holds the packages; Export/GitHub/ after: bash scripts/github-release-files.sh"
    fi
    return $code
}

usage() { sed -n '12,29p' "$0" | sed 's/^# \{0,1\}//'; }

menu() {
    printf '\n  1) macOS          (.app, .dmg)\n  2) Windows        (NSIS installer, via Docker)\n  3) Linux          (.deb .rpm .AppImage, via Docker)\n  4) Android        (APK + AAB)\n  5) Everything this machine can\n  6) Check what is missing\n  q) Quit\n\n'
    printf "${INFO}? Which?${NC} "
    read -r pick
    case "$pick" in
        1) build mac ;; 2) build windows ;; 3) build linux ;; 4) build android ;;
        5) build all ;; 6) check ;; *) exit 0 ;;
    esac
}

case "${1:-}" in
    "") menu ;;
    check) check ;;
    -h|--help|help) usage ;;
    *) build "$@" ;;
esac

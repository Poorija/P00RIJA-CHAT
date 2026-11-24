#!/usr/bin/env bash
# P00RIJA Chat — end-to-end encrypted messenger.
# Copyright (C) 2026 Poorija <p00rija@tutamail.com>
#
# Licensed under the GNU Affero General Public License, version 3 only.
# See LICENSE for the full text. Section 13 matters here: run a modified
# version as a network service and its users are entitled to your source.

# The iOS project, ready for somebody to sign — not a build.
#
#   bash scripts/package-ios-project.sh
#
# iOS installs only what is signed by an Apple developer identity, and that
# identity is the person's own, so nothing is built or signed here. This
# generates the Xcode project (tauri ios init, on a Mac with Xcode), adds the
# web payload the app embeds, and writes
#
#   Export/iOS/P00RIJA-Chat-<version>-iOS-project.zip
#
# with a README-SIGNING.txt in it: open the project, choose your team, build.
# Nothing in it names a server, a key or an account.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
INFO='\033[1;34m'; OK='\033[1;32m'; WARN='\033[1;33m'; ERR='\033[1;31m'; NC='\033[0m'
VERSION="$(node -p "require('./src-tauri/tauri.conf.json').version")"
if [ "$(uname -s)" != "Darwin" ]; then
    printf "${WARN}The iOS project is generated on a Mac (Xcode). Skipped on %s.${NC}\n" "$(uname -s)"
    exit 3
fi
command -v xcodebuild >/dev/null 2>&1 || { printf "${ERR}Xcode is needed to generate the iOS project.${NC}\n" >&2; exit 1; }
# A project made by an earlier release keeps its version: say this one's.
for f in src-tauri/gen/apple/project.yml src-tauri/gen/apple/*_iOS/Info.plist; do
    [ -f "$f" ] && sed -i.bak -E "s/(CFBundle(Short)?Version(String)?:? *\"?)[0-9][0-9A-Za-z.-]*/\1${VERSION}/; s#(<key>CFBundle(Short)?Version(String)?</key>[[:space:]]*<string>)[^<]*#\1${VERSION}#" "$f" && rm -f "$f.bak"
done
node scripts/prepare-tauri-web.js >/dev/null 2>&1 || { printf "${ERR}could not prepare dist/tauri${NC}\n" >&2; exit 1; }
if [ ! -d src-tauri/gen/apple ]; then
    printf "${INFO}▶ Generating the iOS project${NC}\n"
    npx tauri ios init || { printf "${ERR}tauri ios init failed${NC}\n" >&2; exit 1; }
fi
OUT="Export/iOS"
STAGE="$(mktemp -d)"
NAME="P00RIJA-Chat-${VERSION}-iOS-project"
mkdir -p "$STAGE/$NAME" "$OUT"
rsync -a --exclude build --exclude DerivedData --exclude Pods --exclude '*.xcuserstate' --exclude xcuserdata src-tauri/gen/apple/ "$STAGE/$NAME/apple/"
rsync -a --exclude target --exclude gen src-tauri/ "$STAGE/$NAME/src-tauri/"
cp -R dist/tauri "$STAGE/$NAME/web"
cat > "$STAGE/$NAME/README-SIGNING.txt" <<TXT
P00RIJA Chat ${VERSION} — the iOS project, to sign and build yourself
=====================================================================

iOS runs only apps signed by an Apple developer identity, which has to be yours.

You need: a Mac with Xcode, Node 20+, Rust (rustup) with the iOS targets
(rustup target add aarch64-apple-ios aarch64-apple-ios-sim), and the Tauri CLI
(npm i -g @tauri-apps/cli, or npx).

1. Put this folder's contents in the source tree of the release (source archive on
   the release page, p00rija-chat-${VERSION}-source.tar.gz): the apple/ folder goes
   to src-tauri/gen/apple/.
2. In src-tauri/tauri.conf.json set "identifier" to one you own
   (com.yourname.chat) and, in apple/, your development team id.
3. npm ci && npx tauri ios build            # or open src-tauri/gen/apple/*.xcodeproj
   in Xcode, choose your Team under Signing & Capabilities, and Run on your device.

The web payload the app embeds is in web/ for reference; tauri ios build makes it
again from the source. Compare the files against SHA256SUMS.txt of the release.
TXT
( cd "$STAGE" && zip -qry "$ROOT/$OUT/$NAME.zip" "$NAME" )
rm -rf "$STAGE"
printf "${OK}✓ %s/%s.zip${NC}\n" "$OUT" "$NAME"

#!/usr/bin/env bash
# P00RIJA Chat — end-to-end encrypted messenger.
# Copyright (C) 2026 Poorija <p00rija@tutamail.com>
#
# Licensed under the GNU Affero General Public License, version 3 only.
# See LICENSE for the full text. Section 13 matters here: run a modified
# version as a network service and its users are entitled to your source.

# The same commit gives the same images (roadmap 5.2).
#
#   bash tools/verify-build.sh [ref|--worktree] [--platform linux/amd64] [--only app|relay|sfu]
#
# Builds each server image of `ref` (default HEAD) twice, from a clean export
# of that commit (not the working directory), with every file timestamp set to
# the commit's time (SOURCE_DATE_EPOCH, BuildKit's rewrite-timestamp) and no
# cache shared between the two builds, and compares the two OCI archives byte
# for byte. Prints each image's digest, which is what goes into the release's
# provenance and what anybody can rebuild and compare against.
#
# What makes it possible: base images pinned by digest, the relay's packages
# installed with `npm ci` from config/relay-lock.json, npm's cache and logs
# removed in the layer that made them. What it cannot pin: the Alpine package
# index (no image here runs apk at build time) and the npm registry's
# availability (the lock names exact tarballs with their integrity hashes).
set -euo pipefail

REF=HEAD
PLATFORM=linux/amd64
ONLY=''
while [ $# -gt 0 ]; do
  case "$1" in
    --platform) PLATFORM="$2"; shift 2 ;;
    --only) ONLY="$2"; shift 2 ;;
    -h|--help) sed -n '9,24p' "$0"; exit 0 ;;
    --worktree) REF=--worktree; shift ;;
    *) REF="$1"; shift ;;
  esac
done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
COMMIT="$(git rev-parse "$([ "$REF" = --worktree ] && echo HEAD || echo "$REF")^{commit}")"
SOURCE_DATE_EPOCH="$(git show -s --format=%ct "$COMMIT")"
export SOURCE_DATE_EPOCH
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/src"
if [ "$REF" = "--worktree" ]; then
  # The files as they are now, tracked or new (not ignored): for checking a
  # change before it is committed. The time is still the last commit's.
  git ls-files -z -c -o --exclude-standard | xargs -0 tar -cf - | tar -x -C "$WORK/src"
else
  git archive "$COMMIT" | tar -x -C "$WORK/src"
fi

# The OCI exporter needs a BuildKit container builder (the default docker
# driver cannot write one); a builder of its own, so nothing else changes.
BUILDER=p00rija-chat-verify
docker buildx inspect "$BUILDER" > /dev/null 2>&1 || docker buildx create --name "$BUILDER" --driver docker-container > /dev/null

images=("app:config/Dockerfile" "relay:config/Dockerfile.chat-signal" "sfu:config/Dockerfile.sfu")
fail=0
echo "commit ${COMMIT:0:12}  SOURCE_DATE_EPOCH=$SOURCE_DATE_EPOCH  platform $PLATFORM"
for entry in "${images[@]}"; do
  name="${entry%%:*}"; file="${entry#*:}"
  [ -n "$ONLY" ] && [ "$ONLY" != "$name" ] && continue
  digests=()
  for round in 1 2; do
    out="$WORK/$name-$round.tar"
    docker buildx build --builder "$BUILDER" --quiet --no-cache \
      --platform "$PLATFORM" \
      --build-arg SOURCE_DATE_EPOCH="$SOURCE_DATE_EPOCH" \
      --output "type=oci,dest=$out,rewrite-timestamp=true" \
      -f "$WORK/src/$file" "$WORK/src" > /dev/null
    digests+=("$(shasum -a 256 "$out" | cut -d' ' -f1)")
  done
  manifest="$(tar -xOf "$WORK/$name-1.tar" index.json | python3 -c 'import json,sys; print(json.load(sys.stdin)["manifests"][0]["digest"])')"
  if [ "${digests[0]}" = "${digests[1]}" ]; then
    echo "  ok    $name  image $manifest"
  else
    echo "  DIFF  $name  two builds of one commit differ (${digests[0]:0:12} / ${digests[1]:0:12})"
    fail=1
  fi
done
exit "$fail"

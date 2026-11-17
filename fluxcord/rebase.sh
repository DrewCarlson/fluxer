#!/usr/bin/env bash
# Moves the Fluxcord patch onto a newer upstream fluxer-api release.
#   fluxcord/rebase.sh 2026.1120.123456
# Then check, commit and push the fluxcord branch; CI builds the image.
set -euo pipefail
new="${1:?usage: fluxcord/rebase.sh <fluxer-api version, as in the fluxer-api@<version> tag>}"
old="$(cat fluxcord/base-version)"
git fetch --no-tags --filter=blob:none https://github.com/fluxerapp/fluxer.git \
  "refs/tags/fluxer-api@${old}:refs/tags/fluxer-api@${old}" \
  "refs/tags/fluxer-api@${new}:refs/tags/fluxer-api@${new}"
git rebase --onto "fluxer-api@${new}" "fluxer-api@${old}" fluxcord
echo "${new}" > fluxcord/base-version
git commit -m "fluxcord: base on fluxer-api@${new}" fluxcord/base-version
echo "Rebased onto fluxer-api@${new}. Check with: pnpm --filter fluxer_api run typecheck"

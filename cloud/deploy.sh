#!/usr/bin/env bash
# Deploys the Worker with the /edit/ page (nix build .#edit-page, as
# cloud/.edit) built on this machine's plugins: the installed bridge's
# CORKBOARD_PLUGINS (nixosconfig's stylix theme), or else this shell's.
# Arguments go to wrangler deploy.
set -euo pipefail
cd "$(dirname "$0")"
installed=$(systemctl --user show corkboard.service -p Environment --value 2>/dev/null | tr ' ' '\n' | sed -n 's/^CORKBOARD_PLUGINS=//p' || true)
CORKBOARD_PLUGINS=${installed:-${CORKBOARD_PLUGINS:-}} nix build --impure "path:$(cd .. && pwd)#edit-page" -o .edit
exec bun x wrangler deploy "$@"

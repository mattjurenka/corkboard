#!/bin/bash
# electron-builder's, for an erase only: rpm runs this on an upgrade too (with
# 1), after the new version's post-install, and there it would take
# /usr/bin/corkboard away from the version that's just been installed.
[ "$1" = 0 ] || exit 0

if type update-alternatives >/dev/null 2>&1; then
    update-alternatives --remove 'corkboard' '/opt/corkboard/corkboard'
else
    rm -f '/usr/bin/corkboard'
fi

if [ -f /etc/apparmor.d/corkboard ]; then
    hash apparmor_parser 2>/dev/null && apparmor_parser --remove /etc/apparmor.d/corkboard || true
    rm -f /etc/apparmor.d/corkboard
fi

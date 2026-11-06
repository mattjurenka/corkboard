# Handoff: step 4 rollout (2026-11-06, after the corkboard-dev restart)

Goal (the user's): finish ciphertext-relay.md step 4's rollout, then 5 → 6 → the sessions cutover → 7.
Also still to tell the user: rebuild nixosconfig (`nixos-rebuild switch`) and test the bar dropdown's
"Plan with Claude" (dayplan.nix/today.luau, built earlier). Rebuilding also fixes the laptop's own
corkboard-fleetd, which crash-loops on "Cannot find module '../../bridge/hub'". The flake.nix fix is in
96f8009, so nixosconfig's corkboard input needs bumping to fb0a161 or later.

## Done and verified
- Commits in ~/corkboard (open-core, not pushed):
  - 29abb95: pairing from the editor.
  - 96f8009: step 4, the fleet sealed on the node, plus `e2ee move-holds` (bridge/node/move.ts moveHolds).
  - fb0a161: the pair_* ops moved into boards.ts, because the wasm page bundles cloud-session.ts.
- Commits in ~/corkboard-cloud:
  - Worker step 4: sealed spawns and envs; `GET /api/holds?move` and `DELETE /api/holds {names}` (records and secrets only, brains keep the names).
  - 6b56134: the submodule at fb0a161.
- Tests: 273/273 Worker, 72/72 node, 4/4 fleetd queue.
- Still uncommitted, from other sessions: Android, portal, and the Worker's api/board/calendar/mcp/user/sessions changes. Those Worker changes were already live in the 09:00 deploy.
- The Worker is deployed (version 133e72d3).
- fleetd on the droplet runs /nix/store/7vg7qrqac5bs18nlcj506jg1sv8fbn7n-corkboard-fleet-0.1.0.
  - Rollback: `nix-env -p /nix/var/nix/profiles/corkboard-fleet --set /nix/store/9k538l5gg544wp0d5dyymfbcxfl1chx3-corkboard-fleet-0.1.0`, then restart.
- fleetd's relay-only device is /var/lib/corkboard/fleet-device.json on the droplet (id 4PFZAsA30RHGr7moNPEhvmyqu5b5aKTWywzAw1lYkkM, owner corkboard, cert stored).
  - The manifest does NOT have node.device yet, so the env is not sealed.
- The Worker has no hold records: corkboard, github, google and graph are held by brains but none is recorded or has a secret. So move-holds moves nothing, but run it anyway for the record.

## Next
1. The bridge holds the node lock, so moveOff refuses while corkboard-dev serves. Either:
   - have moveOff use a running node (a nice fix), or
   - skip it, since nothing is there.
   - Check the node has the fleet object now (FleetRecords.has()), e.g. via the fleet view or /api/node/fleet/environments on loopback.
2. On the droplet:
   - `cp /etc/corkboard/fleet.json /etc/corkboard/fleet.json.bak-seal-2026-11-06`
   - `jq '.node.device="/var/lib/corkboard/fleet-device.json"'` into fleet.json (it's hand-edited, "flake": "").
   - `systemctl restart corkboard-fleetd`, then watch the journal for the channel to the node, the manifest PUT, and `sealed` in the Worker's status.
   - Before this, the journal showed "pepper-vm: the node's day events: HTTP 504" every 2 min over the tunnel. It should go away on the channel.
3. Verify a spawn end to end: the node's spawn_agent (coding, a tiny task). Check that the Worker's status shows task "", and that the result lands in the node's fleet object.
4. Remaining step-4 code:
   - Sealed envs' running changes don't trigger the Worker's "fleet" broadcast, so the nvim fleet view reloads only on spawn events. Have the node emit an event on fleet-object env changes.
   - A node test for app.ts fleet()/holds.
   - Android: NewSession, Holds and Fleet go through the node channel or the fleet replica (Wire.kt KINDS has "fleet").
   - The portal's holds go with step 6.
5. Then steps 5, 6, the cutover, 7.

## Facts
- Hunk staging helper: `bun /tmp/claude-1002/-home-matthew-corkboard/48b87e38-36db-4bbe-9bf0-0e246f130bcc/scratchpad/hunks.ts <file> <regex> [--not]`. It uses -U1, so check neighbours; for a single line use -U0 with `git apply --cached --unidiff-zero`.
- `bun bridge/e2ee.ts <cmd>` runs the e2ee CLI. bridge/server.ts tries to bind 7777.
- The Worker deploy is `cd ~/corkboard-cloud/cloud && ./deploy.sh`. It builds edit-page from the corkboard-cloud/corkboard clone, so update the clone with `git fetch ~/corkboard open-core && git checkout FETCH_HEAD`.
- Droplet fleetd runs as user corkboard with CORKBOARD_CLOUD=https://portal.corkboard.fyi and XDG_STATE_HOME=/var/lib/corkboard/state.

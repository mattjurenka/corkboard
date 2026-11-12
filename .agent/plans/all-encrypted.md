# Every account encrypted: the plaintext side goes

**Written:** 2026-11-11 · **Decided (Matt):** everything is encrypted. Nobody but Matt uses
corkboard yet, so plaintext accounts aren't migrated for others or kept working: Matt's own data
moves once, then the Worker's plaintext features, Google sign-in as an account and the bridge's
`signedIn()` paths come out. This finishes e2ee.md step 4 and ciphertext-relay.md step 7 by
deletion, not by a migration everyone runs.

---

## Where it is

- **Sign-up** makes a plaintext account: Google OAuth → `registry.signIn` → `welcome()`
  (corkboard-cloud `cloud/src/auth.ts:162-190`, `registry.ts:178-197`). An encrypted one comes only
  from `corkboard-bridge e2ee init`, or the desktop bridge's local key when signed out
  (`bridge/node/app.ts:109-113`), unpublished until `e2ee publish`.
- **Moves exist, run by hand:** `e2ee move-memory|move-boards|move-plans|move-holds`
  (`bridge/e2ee.ts:48-58`), each freezing, copying and purging the Worker's copy
  (`user.ts:348-389`). Memory moved 2026-11-04; boards, plans and holds not yet run for real.
- **No encrypted path yet:** brains' records (the Worker's `/brains`, which `bridge/node/fleet.ts`
  still reads), meeting transcripts (`bridge/record.ts:299`, a plaintext PUT), the User DO's
  sessions (`/api/sessions`), holds in an environment that isn't sealed (`HOLDS_KEY`).
- **Plaintext by default:** claude.ai's `/mcp` on the Worker, the portal's API, the phone's
  sessions.

## Steps

1. **Matt's data, once.** `move-boards`, `move-plans`, `move-holds` with `--dry-run` first, then
   for real; each fleet environment sealed. Checked: every board, plan and hold on the node,
   the Worker's routes for them answering 410.
2. **The gaps.**
   - Brains' records into the account's objects: the node's replicas already keep
     `BRAIN_RECORD`; `fleet.ts`'s `brains()`/`moveOnBrains()` read and write them there, and a
     move copies the Worker's once.
   - Meeting transcripts to the node over the channel, as a note of the brain's.
   - Sessions: the phone and fleet views from the node's hub only; `/api/sessions` 410.
   - claude.ai: the node's `/mcp` only (the `/n/<handle>` tunnel stays, a trust-us opt-in as
     web-is-trust-us says); the Worker's `/mcp` goes.
   - The portal pairs as a device (ciphertext-relay.md step 6) and talks to the node on a
     channel.
3. **Sign-up is a key.** The app's first run makes the account (the local key it already makes
   signed out), publishes it to the relay and shows the recovery phrase; every other device or
   page joins by pairing. Google is no longer an account: at most the calendar's own OAuth on
   the node (`serve calendar-login`).
4. **The plaintext side out.**
   - corkboard-cloud: the User DO's plaintext storage and routes (boards, memory, plans, holds,
     brains, sessions, notes), `HOLDS_KEY`, the plaintext `mcp.ts`, Google sign-in
     (`auth.ts`, `registry.signIn`, `welcome()`), the `*Move` gates and `/done` purges (nothing
     left to move), the portal's plaintext API calls.
   - corkboard: `bridge/cloud.ts`'s signed-in session and every `signedIn()` branch, the
     bridge's and Neovim's Worker fallbacks (`cards/cloud.lua`'s plaintext calls, brains via the
     Worker), the `e2ee move-*` commands once step 1 is done, the Worker-side `/privacy` lines
     that no longer apply.
   - Android: the User DO session path.
5. **Later:** a hosted node, an opt-in that trusts us (e2ee.md step 6), for someone with no
   machine of their own. Until then an account needs a node on a machine its owner runs.

## Decide

- The calendar's Google refresh token: on the node (its own Google client, `serve
  calendar-login`), which step 3 implies, or kept on the Worker as local-plans.md chose.
- Whether the relay still knows an account by anything but its signing key (an email for
  recovery or billing), now that Google isn't the account.

## Progress (2026-11-11)

- Step 1 was done already (the moves answered "moved already"; no holds on the Worker).
- Decided (Matt): the fleet queue, the sessions list, the calendar's Google refresh token and
  workspace tickets stay on the Worker, keyed by the encrypted account (User DO
  `e2ee:<account>`), authenticated by the relay's device token; the queue starts empty.
- corkboard-cloud (uncommitted, not deployed): `deviceApi` in `cloud/src/api.ts` for `cbe_`/`cbo_`
  device tokens (spawns, fleet, live, sessions, workspace, calendar token and
  `POST /api/calendar/connect`); everything else answers 404 to a device.
- corkboard (uncommitted): `bridge/cloud.ts` is the device token and the server only; no
  `login`, `signedIn`, auth.json or machine tokens. Boards and the day are always the node's
  (`boards.ts`); the bridge's `/auth` and the page's sign-in are gone; media from the node only;
  `e2ee move-*`, `--admin` and push-board from the Worker are gone (`node/move.ts` deleted,
  `import.ts` trimmed to `card-files.ts`'s `cardsOf`). fleetd and `corkboard-fleet` take the
  Worker's tokens as fleetd's relay-only device (`fleet/fleetd/node.ts`'s `useDevice`), and a
  spawn's MCP is only ever the node's. Connect calendar (the palette) opens Google's consent for
  the account.
- Not yet: `cloud-session.ts`'s `Link.token` for the wasm page (web/src/cloud.ts, the portal's
  OAuth); the relay's admin-bearer account creation (`/api/e2ee/accounts`); then steps 3–4.

# Handoff (2026-11-05, part 2): e2ee's smaller gaps. Items 1-3 done, 4 half done, 5-6 left

The user's words: "we should share the google connection so that we dont have to keep asking for consent. and fix all of those smaller gaps"

Nothing is committed in ~/corkboard or ~/corkboard-cloud. corkboard also has unrelated web/nvim changes, so ask before committing. There's no python on this machine, so script edits with bun.

## Done and verified
1. **The Google connection is shared.** Worker (corkboard-cloud/cloud): calendar.ts has `grantFor(env, c)` → `{token, expires_at}` (accessToken wraps it), and `CalendarError` is exported. user.ts no longer deletes `calendar` on "moved", and `connectCalendar` works after a move. api.ts has `POST /api/calendar/token` (owner and machine tokens) → `{access_token, expires_at, calendar, timezone}`; it answers 404 when nothing is connected or there's no calendar, and 502 with Google's message. planMoveRoutes' `calendar` is always shown. test/planmove.test.ts passes 3/3.
   Node: in calendar.ts, `CalendarConfig` is `{calendar, timezone} & ({client_id, client_secret, refresh} | {token})`. `lentCalendar(ask)` caches a lent token until a minute before it expires, and remembers a 404 for a minute. `startCalendar`'s config can be async, and leads() is checked first. serve.ts's `calendar = loadCalendar(path) ?? lent()` is used by startCalendar, by served and by the returned node. server.ts's status awaits it. The calendar-login hint in e2ee.ts and move.ts's `PlansTarget.calendar` are removed.
2. **Day events go over SSE.** server.ts has an `sse(follow)` helper, which /app/events now uses too. `GET /api/node/day/events` sends `{"kind":"day"}` on each change to the day object. replicas.ts's `onChange` returns an unsubscribe. In fleet/fleetd/assistant.ts, `followNode()` reads the stream and ticks. The 10 s poll of the node chat runs only while that stream is down.
3. **The brain token is minted on the node.** `POST /api/node/grants {scope: brain}` and `DELETE grants {token}` already existed. In assistant.ts, `nodeApi()` is split out of chatApi, and `renewNode()` mints a token each day into the new `Assistant.memoryTokenFile` (fleet.ts) and revokes the old one. pepper.nix's resident sets `memoryTokenFile = "/var/lib/pepper/memory-token"`. **Someone has to add that field by hand to the droplet's hand-written /etc/corkboard/fleet.json.**
4. (half done) **The relay serves shared blobs.** In relay/src/routes.ts, `GET /e2ee/blob/:id?owner=&object=` checks the grant and is read only (PUT and DELETE with an owner give 403). lib/e2ee/relay.ts has `getBlob(id, shared?: {owner, object})`. Relay tests pass 26/26 (`cd relay && bun run test`). `bun run test:e2ee` passes 103/103, `bunx tsc --noEmit -p .` is clean, and `bun test fleet/fleetd` passes 22/22.

## Left
4. Android (~/corkboard-cloud/android/.../corkboard): Relay.kt's `getBlob(id, owner, obj)` adds `?owner=&object=`. Encrypted.kt's `download()` passes `ref.owner, ref.obj`. `boardInfos` and `listedBoard` add `shared(m).first.filter { it.kind == "board" }.map(::ref)`. Sync relay/ and lib/e2ee/relay.ts into the corkboard-cloud/corkboard clone before deploying.
5. `Encrypted.boardInfos`: pull the replicas concurrently (coroutineScope + async).
6. When the plans have moved and the phone isn't paired (`Days.NotPaired`), give the Plan screen a way to the pairing screen (EncryptedScreens.kt). No explainer captions.
Android tests: `cd ~/corkboard-cloud && nix develop .#android --command gradle -p android testDebugUnitTest assembleDebug -q`.
Then record each piece in local-plans.md (step 5's text, and the Decide entry: decided, the Worker keeps the connection and lends tokens) and in local-boards.md (shared boards' files), and report to the user.

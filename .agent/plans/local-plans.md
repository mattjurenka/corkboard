# Local-first, encrypted day plans and chat: the Worker keeps no plan

**Written:** 2026-11-05 · **Proposed:** plans and the phone's chat go the way memory and boards
went (local-memory.md, local-boards.md): an encrypted replica on the user's devices, served by
the node, with the Worker keeping only ciphertext. Open decisions are under **Decide**.

Today both are plaintext in the Worker's User DO:
- `plans (date, doc)` holds lib/model/plans.ts's `Plan`. `changePlan()` checks the version, so a
  stale write gets a 409. Its routes are `/api/plans/:date` with say, accept, discard and day.
  The MCP has `plan_read` and `plan_propose`.
- `chat (id, at, who, text, by_user, delivered)` has the routes `/api/chat`, PATCH and DELETE
  `/api/chat/:id` (only while not delivered), and `.../delivered`. The MCP has `chat_read` and
  `chat_send` (the `chat` ability).
- The `calendar` row holds the Google refresh token. After an accept, api.ts's `toCalendar()`
  writes the day with calendar.ts.
- `/api/live` pushes `plan`, `chat` and `chat-gone` events.

Clients:
- **The phone:** Cloud.kt, App.kt, and the Plan and Chat screens in Screens.kt. Store.kt caches
  the plan for the Gate.
- **Neovim:** plan.lua's `plan_*` calls, proxied by cloud-session.ts.
- **pepperd** (fleet/fleetd/assistant.ts) polls `/api/chat`, marks messages delivered, pastes
  them into Pepper's tmux, and follows `/api/live`. Pepper answers with `chat_send`.

The node already has some of this. calendar.ts is a port of the Worker's write, with its config
in `<state>/node/calendar.json` and `serve calendar-login`. It also has an owner-only `POST
/api/node/calendar` that nothing calls. Pepper's corkboard-memory server is already the node's
whole `/mcp`. The node has no plan or chat records.

---

## The shape

- **One `day` object per account** (a new kind in lib/e2ee/keys.ts's `KINDS` and objects.ts's
  `NodeObject.kind`), named `day`, in the index like any other. It holds these records:
  - `plan:<date>` has a field per part of the plan: `day` (blocks, ranked, later, inputs),
    `proposal`, `asked`, `accepted`, `calendar` and `projects`. A proposal and an edit to the
    day from two devices then don't overwrite each other.
  - `chat:<id>` has `at`, `who`, `text`, `by_user` and `delivered`. The id is a time-sortable
    random id, so two devices can't collide offline; order is by `at`, then id.
- **Versions become stamps.** The Worker's 409 on a stale plan becomes "accept names the
  proposal it accepts": `accepted` is `{proposal: <its stamp or hash>, blocks, at}`. When a newer
  proposal has come in since, the accept shows as stale, and the phone and Neovim ask again.
  This is the same idea as the Conflict screen the phone has now.
- **The leader writes the calendar.** The node that leads (as with leases) sees a new `accepted`
  on today's or the next seven days' plans. It writes the day with calendar.ts and sets the
  plan's `calendar` field to the result. The write is safe to repeat: calendar.ts clears the
  day first, and the `calendar` field records which accept it wrote, so a node that restarts
  doesn't write it twice.
- **Chat goes through the node.** The node's MCP gets `plan_read`, `plan_propose`, `chat_read`
  and `chat_send`, with the same ability checks the Worker uses. pepperd follows the node's
  events through the tunnel (`/n/<handle>`) instead of `/api/live`, and marks messages
  delivered with a node call. "Not yet delivered" is still the only time a message can be edited.
  Two devices could still race that edit, but no worse than today.
- **The phone is a replica of `day`.** Encrypted.kt reads plans and chat and writes ops, as it
  does for boards. The phone gets live updates from the relay's sync; nothing goes through
  `/api/live` any more. Store.kt's cache for the Gate stays as it is.
- **Neovim's plan window goes to the node.** app.ts gets the `plan_*` operations and events,
  the way boards.ts sends a board's ops (cloud-session.ts stops fetching `/api/plans`).
- **Nothing on the Worker reads a plan.** What the Worker keeps of its own: the relay, the
  tunnel, accounts, and the fleet's queue (ids only).

## Build order

1. **The `day` object.** The kind, the records above, and Data's `plan(date)`, `changePlan`
   (proposal, say, accept, discard, day) and `chat(after)`, `post`, `edit`, `unsay` and
   `deliver`. Tests cover concurrent proposal and day edits, a stale accept, and chat order
   across two devices.
   **Built 2026-11-05.** lib/e2ee's `KINDS` has `day`; objects.ts's `dayObject` (accountObject
   with a kind) is opened by serve.ts beside `oauth`. bridge/node/day.ts: `plan:<date>` with
   `day`, `proposal` (now with an `id`, lib/model's `Proposal.id`, optional), `projects`,
   `accepted` `{at, proposal}`, `discarded` and `calendar`; a proposal is open while neither
   `accepted` nor `discarded` names it, so an accept and a newer proposal at once leave the newer
   one open. What's asked is the record's log (one entry a say, so two at once both stay), and
   `answered` the ones a proposal has answered. `version` is the record's latest clock, and a
   given version is still checked on the node (`Conflict`, the Worker's 409, with the plan);
   accept and discard can name the proposal too. `chat:<id>` messages, ids time-and-random
   strings (lib/model's `ChatMessage.id` is a number; the node's `Message` takes a string),
   ordered by id, taken back as `deleted`. data.ts: `plan`, `planDates`, `propose`, `say`,
   `accept`, `discard`, `setDay`, `calendarWritten`, `chat`, `message`, `post`, `edit`,
   `unsay`, `deliver`. Test: "day plans and chat, on the node" (92/92 in test:e2ee).
2. **The node's MCP and API.** The four MCP tools. app.ts's `plan_*` and chat operations, and
   their events. `/api/node/plans/:date` and `/api/node/chat` for pepperd. The leader's calendar
   write on accept, replacing the unused `POST /api/node/calendar`.
   *Started 2026-11-05:* mcp.ts's `DAY_TOOLS` (the Worker's four, same descriptions): not to a
   board-bound grant, nor with no day object; `chat_*` only to a brain grant whose settings'
   `abilities` has `chat`, read each call; `Conflict` answers as a tool error. Test: "day plans
   and chat over the node's MCP". server.ts's `GET /api/node/plans/:date`, `POST
   .../say|accept|discard|day` (owner only; `Conflict` is a 409 with the plan), `GET/POST
   /api/node/chat` (an owner's post is the user's, a brain's is the brain's), `PATCH`/`DELETE
   chat/:id` and `POST chat/:id/delivered` (owner). Test: "day plans and chat, the phone's API"
   (94/94).
   **Finished 2026-11-05.** calendar.ts's `writeAccepted` (each accepted plan from today
   through 7 days ahead, in the calendar's own zone, not yet written for that accept and that
   day: `calendar.day` is `dayDigest(blocks)`, so an edit to an accepted day is written again,
   as the Worker did; Google refusing is kept as the plan's error and not retried until the
   next accept or edit; a network failure throws and is tried again) and `startCalendar`
   (on each change to the day object and each minute, while `leads()` and calendar.json
   exist), started in serve.ts beside the leases. `POST /api/node/calendar` and server.ts's
   `fetch` option are gone. app.ts: `plans()` (plan_get, say, accept, discard, day, with
   cloud-session.ts's `{ plan }`/`{ conflict }` shapes) and `dayEvents()` (`plan`, `chat`,
   `chat-gone`, each change once); AppNode's `plans`/`onDay`; `/app` takes `plan_*`, and
   `/app/events` sends day events as `{ key: null, event }` (runningNode splits them).
   boards.ts sends plan.lua's `plan_*` to the node signed out, or once the Worker's
   `GET /api/plans/<today>` answers 410 (asked every 5 minutes until it does; step 5 makes
   it), `plan_subscribe` following `onDay` as `USER` events and `plan_boards` the merged board
   list. Tests: "the calendar, written by the leader", "Neovim's day plan, on the node"
   (97/97). Not yet: run in Neovim for real; chat ops on /app (nothing in Neovim chats).
3. **Neovim and pepperd.** plan.lua through the bridge to the node. assistant.ts on the node's
   chat and events, with the node url and token from fleetd's manifest (as step 5 of
   local-boards.md did for spawns).
   **Built 2026-11-05.** Neovim's half came with step 2 (boards.ts). assistant.ts: `assist`
   takes the manifest's `node`; `chatApi` asks the Worker's `/api/chat…` and, on a 410 (step
   5's), the node's `/api/node/chat…` with the manifest's token file. The first time it reads
   the node's, the state's `last` becomes the newest message the move says was delivered
   (`from: "node"`; node ids are strings), so nothing is passed on twice and nothing sent
   since is missed. The node's chat has no socket, so it's asked every 10 s (the Worker's
   every 30 s, as before, besides /api/live). Typechecked and fleetd's tests pass (22/22); the
   node path has no test of its own and hasn't run. Not yet: an SSE route for the node's day
   events over the tunnel, so pepperd needn't poll; the brain's daily token is still minted
   on the Worker (`/api/brains/:brain/tokens`).
4. **The phone.** The Plan and Chat screens on the `day` replica, with accept and stale accepts.
   Encrypted.kt's records.
   **Built 2026-11-05.** android's Day.kt: `Days` asks the Worker until it answers 410 (kept as
   Store's `dayMoved`), then the day replica (`Encrypted.day`, the index's entry else derived;
   Wire.kt's `KINDS` has `account` and `day`), syncing it on each read so an accept made offline
   goes up later. `DayRecords` is day.ts on the phone: `plan()` (planOf and versionOf), `accept()`
   (Data.accept's change, naming the proposal), `messages()`, `posted()` and `newId()` (the
   node's timeId); an accept whose proposal isn't the open one any more is a `Cloud.Conflict`
   with the plan as it is, which the Plan screen already shows. Edit and take back check the
   message is still undelivered (else a 409, as the Worker's). Repo follows the replica's own
   socket (`Days.follow`) beside `/api/live`. `ChatMessage.id` is a string now (`AnyId` reads
   the Worker's numbers; `ORDER` sorts both). Tests: DayRecordsTest.kt (5/5; all of
   testDebugUnitTest passes). With the plans moved and the phone not paired, the Plan screen has
   a "not paired / pair ›" row to the encrypted screen's pairing (Repo.notPaired, set when
   refresh meets Days.NotPaired). Not yet: run on a phone against a moved account.
5. **Moving off the Worker**, as move.ts does: `GET/POST/DELETE /api/plans/move`, paged plans
   and chat, then `.../done`. That deletes the rows and drops the Worker's calendar write; the
   Google connection stays on the Worker, which lends the node access tokens (see **Decide**).
   The command is `e2ee move-plans [--dry-run]`.
   **Built 2026-11-05.** The Worker (corkboard-cloud/cloud): user.ts's `plan_move` row,
   `planMove`/`setPlanMove` ("moved" deletes the plans and chat rows) and
   `planPage(after)`; `chat(after, limit, fromFirst)`.
   api.ts's `planMoveRoutes` (`GET`/`POST`/`DELETE /api/plans/move`, which gives `calendar:
   { connected, id, timezone }` but never the token; `GET .../plans?after=<date>`,
   `.../chat?after=<id>`, 100 a page; `POST .../done`), refused to a machine token; while a
   move exists all of `/api/plans/*` and `/api/chat*` are 410, and mcp.ts's `DAY_TOOLS` throw.
   The node: data.ts's `importPlan` (the open proposal gets the id `worker-<version>`, what's
   asked becomes log entries at `<date>T00:00:00.<i>Z`, only fields that differ are written)
   and `importChat` (day.ts's `importedMessageId`: the time in base 36, then `w` and the
   Worker's id padded to 9, so order holds and a second run adds nothing); move.ts's
   `movePlans`; serve.ts's node has `calendar()`; e2ee.ts's `move-plans`. Tests:
   the Worker's planmove.test.ts (2/2; boardmove.test.ts's last check now reads `/api/me`'s
   `sub`, not a missing `id`), node.test.ts's "day plans and chat moved off the Worker"
   (test:e2ee 100/100). The Worker is deployed (2026-11-05, with `/api/calendar/token`). Not
   yet: run a move against the live Worker; the Worker's `toCalendar` stays for accounts that
   haven't moved.
   **The lent calendar (2026-11-05).** The Worker's calendar.ts `grantFor` and `POST
   /api/calendar/token` (owner and machine tokens → `{access_token, expires_at, calendar,
   timezone}`; 404 when nothing is connected, 502 with Google's message); "moved" keeps the
   `calendar` row and `connectCalendar` still works. The node's calendar.ts takes `{token}` in
   place of a client and refresh (`lentCalendar`: cached until a minute before it expires, a
   404 remembered a minute); serve.ts uses calendar.json if there is one, else the lent one.
   Also: `GET /api/node/day/events` (SSE, `{"kind":"day"}` on each change) that pepperd
   follows, polling the chat only while it's down; pepperd mints its brain token on the node
   each day (`Assistant.memoryTokenFile`) and revokes the last. Tests: planmove.test.ts 3/3,
   test:e2ee 103/103, fleet/fleetd 22/22.

## Decide

- **Where the records live** (decided 2026-11-05): a `day` object of its own, not the pepper
  brain's replica. A user without Pepper still has plans, a pepper grant doesn't see them, and
  the object can be shared on its own later.
- **The calendar's refresh token** (decided 2026-11-05): the Worker keeps the connection and
  lends the node access tokens (`POST /api/calendar/token`), so there's no new consent. The
  token is bound to the Worker's Google client, whose secret can't go to users' machines. A
  node with its own `serve calendar-login` (calendar.json) uses that instead.
- **Old plans** (decided 2026-11-05): the move copies every date.

## Open

- With no node up, Pepper's chat can't take messages from the phone. The phone still writes
  into its replica, and pepperd gets them when the node is back. A plan accepted on the phone
  isn't written to the calendar until a node leads.
- plan-my-day (~/nixosconfig/modules/features/dayplan) writes the calendar itself with the
  `dayplan` CLI. Once the node writes on accept, that skill could propose with `plan_propose`
  instead.

# Open core: what anyone can self-host is open, the hosted corkboard.fyi is closed

**Written:** 2026-11-02 · **Decided:** corkboard splits in two. This repo is open (AGPL-3.0, `lib/`
MIT) and holds everything a user can run themselves. The hosted business lives in a private repo,
`corkboard-cloud` on Forgejo (no GitHub mirror), with this repo as its submodule at `corkboard/`.
No CLA: outside contributions aren't taken for now.

```
corkboard (open, AGPL)                  corkboard-cloud (closed)
  app/ bridge/ web/ nvim/ mcp/            cloud/    the plaintext Worker, api.corkboard.fyi
  fleet/ wasm/ packaging/                 portal/   the Next.js portal
  bridge/node/   the node                 site/     corkboard.fyi
  relay/         the e2ee relay Worker    android/  the Kotlin app
  lib/ (MIT)     e2ee, the card model     test/     checks against the live Worker
                                          corkboard/  ← this repo, a submodule
```

## What moved

- `lib/model/`: the card, plan and date model, out of `cloud/src/`, so the node needs nothing of
  the Worker's.
- `relay/`: the e2ee routes, logs, mailboxes and accounts (`RelayAccounts`, abstract over
  `admit(invite)`), as a Worker anyone can run with a `RELAY_INVITE` secret. The hosted registry
  extends `RelayAccounts` and admits by its invites; its storage tables didn't change.
- `cloud/`, `portal/`, `site/`, `android/`, `test/cloud-boards.ts`, `test/day-plan.ts` and the
  Android dev shells: to `corkboard-cloud`, history kept (git-filter-repo). The Worker imports
  `corkboard/lib` and `corkboard/relay`; its deploy builds `corkboard#edit-page`.

## What a self-hoster has, and doesn't

The app, the bridge, the node and a relay of their own (`relay/README.md`), with the bridge
pointed at it by `corkboard-bridge server <url>` (`server.json` in the state directory;
`CORKBOARD_CLOUD` wins). The whole plaintext Worker is closed, so spawns, Claude Code's cloud MCP
and Pepper aren't theirs until the node takes them over (`e2ee.md`).

## Open

- The desktop app has no place to set the server yet; it's the bridge's command only.
- `cloud/`, `portal/` and `android/` stay readable in this repo's history (and GitHub's mirror)
  unless it's rewritten.
- Forgejo has Actions on but no runner, so `corkboard-cloud`'s `.forgejo/workflows/ci.yml` waits
  on one (`self-hosted-git.md`, step 4).

# Deploying the multi-user Worker

What changed for operating the Worker when it went from one Google account
to invited users (2026-11-02). Nothing here needs a data migration: the
account that was there keeps working as it is.

## Before `./deploy.sh`

1. **`HOLDS_KEY`, a new secret.** Holds' secrets (src/holds.ts) are encrypted
   with keys derived from it. Make it once and keep a copy somewhere safe
   (the password manager): if it's lost or changed, every encrypted secret is
   lost with it.

   ```sh
   openssl rand -base64 32 | bunx wrangler secret put HOLDS_KEY
   ```

   Without it, reading the old plain-text secrets still works, but setting a
   secret answers 503.

2. **`ADMIN_EMAILS` replaces `ALLOWED_EMAIL`** (wrangler.jsonc `vars`, a comma
   list). The first address is the account the Worker was made for: its
   settings start from `TIMEZONE` and `CALENDAR_ID`, and `FORGEJO_TOKEN` is
   its. If `ALLOWED_EMAIL` was ever set in the dashboard, delete it there.

3. **Update pepperd on the droplet first** (fleet/pepper/pepperd.ts). The user's
   chat messages used to be signed `"matt"`; now they're signed with the
   user's name and carry `by_user: true`. The new pepperd reads either; the
   old one only `"matt"`, so with the new Worker and the old pepperd, Pepper
   stops hearing the phone. The phone app reads either too.

4. **Neovim's Pepper window** has no built-in host any more: set
   `CORKBOARD_PEPPER=pepper@valheim.jurenka.software` in corkboard's
   environment (or `vim.g.corkboard_pepper_ssh`).

## What the deploy does

- **Durable Object migration `v4`** adds the `Registry` class (one object, who's
  let in and the invites). `wrangler deploy` applies it.
- The first time the existing account's token is used, the registry records
  it as an admin and its settings are made from `TIMEZONE` and `CALENDAR_ID`.
  Its machine tokens join the token list the next time each is used.
- The chat table gains `by_user`; the old `"matt"` rows are marked as the
  user's.
- Plain-text holds' secrets are encrypted the next time each is read or set.

Then deploy the portal (`cd ../portal && bun run deploy`) for the account and
admin views. The old portal works against the new Worker meanwhile.

## Google

- **Publish the OAuth consent screen** (Google Cloud console, the
  `dayplan-512206` project, "Audience" → "Publish app"). While it's in
  testing, only the test users listed there can sign in, and refresh tokens
  for the calendar expire after 7 days.
- Signing in asks for `openid email profile` (non-sensitive). Connecting the
  calendar (`/calendar/connect`) adds `calendar.events` and
  `calendar.app.created` incrementally. Both are sensitive scopes: users see
  the "Google hasn't verified this app" screen until the app passes Google's
  verification for them, and an unverified app is capped at 100 users. List
  both scopes on the consent screen's "Data access" page before applying.
- `calendar.app.created` is what lets the Worker make a "Claude" calendar for
  a user who has none. The first admin's existing calendar (`CALENDAR_ID`) was
  made elsewhere, so it needs `calendar.events`; a Worker with no such calendar
  could ask for `calendar.app.created` alone.
- The redirect URI (`https://portal.corkboard.fyi/callback`) is unchanged.

## Letting people in

- Admins: `ADMIN_EMAILS`, always. An admin can make other users admins in
  the portal's admin view, but not demote anyone in `ADMIN_EMAILS`.
- Everyone else: an invite from the admin view (single- or multi-use, maybe
  expiring), sent as `https://portal.corkboard.fyi/?invite=<code>`. Without
  one, signing in records them on the waitlist, where an admin can let them
  in; they sign in again after.
- Disabling an account stops every token of it within 30 seconds (each
  isolate keeps who's let in that long).
- Forgejo (`/api/git`, the portal's files) is the admins' only: it's read
  with the one `FORGEJO_TOKEN`.

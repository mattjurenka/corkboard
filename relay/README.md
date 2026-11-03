# corkboard relay

A relay of your own for corkboard's encrypted accounts: a Cloudflare Worker
that stores and forwards ciphertext (boards' and brains' logs, pairing
mailboxes, attachments) and holds no key to any of it. Your devices, and your
node (`corkboard-bridge serve`), do the decrypting.

## Run one

With a Cloudflare account and [bun](https://bun.sh) 1.4, from this directory:

```sh
bun install
bunx wrangler r2 bucket create corkboard-relay
bunx wrangler secret put RELAY_INVITE        # the code an account is made with
```

Set `ORIGIN` in `wrangler.jsonc` to where the relay will be served (its
`workers.dev` address or your own domain, no trailing slash), then
`bunx wrangler deploy`. `/health` answers once it's up.

## Use it

On each machine, point the bridge at it, then make the account on the first
and pair the rest:

```sh
corkboard-bridge server https://relay.example.org
corkboard-bridge e2ee init --invite <RELAY_INVITE>   # prints the recovery phrase, once
corkboard-bridge e2ee pair                           # on another machine
```

`corkboard-bridge server default` goes back to corkboard.fyi;
`CORKBOARD_CLOUD`, when it's set, wins over both.

## Develop

`bun run typecheck` and `bun run test`. The tests drive the relay with
`lib/e2ee`, so `bun install` in the repo root first.

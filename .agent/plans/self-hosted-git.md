# Self-hosted git: Forgejo at git.corkboard.fyi

**Written:** 2026-10-29 · **Decided:** Forgejo on the droplet is the source of truth for every
project; each repo push-mirrors to GitHub; private, sign-up off; Forgejo Actions with our own
runners; Stable (`stable-monorepo`, `stable-accounts`) and Baum (`baum-monorepo`) move onto it later.

```
laptop / workspace / fleet VMs ──push──▶ git.corkboard.fyi (Forgejo, droplet)
                                              │ push mirror, on every push
                                              ▼
                                         github.com (backup + public face)
                                              
Forgejo Actions ──jobs──▶ forgejo-runner ──▶ fleet VM per job (droplet / laptop)
```

---

## Steps

1. **Forgejo on the droplet.** Like the other services there: a Nix profile
   (`/nix/var/nix/profiles/forgejo`, from nixpkgs `forgejo`), a hand-written
   `forgejo.service` as user `git` (home `/var/lib/forgejo`), SQLite, listening on
   127.0.0.1:3000. `DISABLE_REGISTRATION`, `REQUIRE_SIGNIN_VIEW`. ~200 MB of RAM.
   - SSH through the host's sshd (Forgejo manages `~git/.ssh/authorized_keys` with
     `command=` lines), so clone URLs are `git@git.corkboard.fyi:matt/corkboard.git` with no port.
   - Caddy site `git.corkboard.fyi` → 127.0.0.1:3000.
   - DNS: `git.corkboard.fyi` A → 134.122.14.159, **DNS only** (Cloudflare's proxy carries
     neither SSH nor pushes over 100 MB).
2. **Backups, to Walrus on Sui** (decided 2026-10-29). The GitHub mirror only carries git data.
   Nightly `forgejo dump` (repos, issues, PRs, settings, Actions secrets), encrypted, uploaded as a
   Walrus blob, renewed before it expires; older blobs left to expire. ~/git-walrus already has a
   publisher daemon holding a Sui wallet and a renewal loop to borrow from. The droplet's disk is
   75% full: dump to a temp file and delete it after upload.
3. **Personal repos.** Migrate from GitHub through Forgejo's migrator, add a push mirror
   (fine-grained GitHub token, "sync on commit"), switch the local `origin`. corkboard first, then
   nixosconfig, verse, the rest. Flake inputs on `github:` keep working off the mirror.
4. **Runners.** `forgejo-runner` registered against the instance; each job runs in a fresh
   fleet VM (a `ci` template), not on the host, so a workflow can't reach Forgejo's data or the
   other services. Start with one runner on the droplet; the laptop can register a second.
   Memory is the limit: the droplet has ~2.2 GB free with Pepper, cloud-0 and the workspace up.
5. **corkboard integration.** A new board can create its Forgejo repo and GitHub mirror; boards'
   remotes point at Forgejo, so the workspace's `/open` clones from it.
6. **Stable and Baum.** A `stable-finance` org on Forgejo; teammates' accounts; port
   `deploy.yml`, `sweep-deposits.yml`, `anthropic-key-expiry.yml` and their secrets to Forgejo
   Actions (mostly GitHub-compatible; `runs-on` labels change). Probably needs a bigger droplet,
   and the team's agreement since GitHub stops being where their code lives.

## Open

- Runner isolation: per-job fleet VM (above) vs a long-lived runner VM to start.
- Walrus: which wallet pays, how many epochs each dump is kept, where the encryption key lives.
- Whether the droplet gets resized before Stable moves.

## Status

- 2026-10-29: step 1 done but for DNS. Forgejo 16.0.6 at /nix/var/nix/profiles/forgejo (static
  files: profiles/forgejo-data), `forgejo.service`, config /var/lib/forgejo/custom/conf/app.ini,
  admin `mattjurenka`. Caddy site `git.corkboard.fyi` added (cert issues once the A record exists).
  corkboard migrated with a push mirror to GitHub (SSH deploy key "git.corkboard.fyi push
  mirror", sync on commit), tested. Laptop clone: `origin` = Forgejo, `github` = GitHub, `main`
  tracking github/main until DNS resolves.
- 2026-10-30: DNS up (DNS only), cert issued, laptop `main` tracks origin/main. Security pass on
  the droplet: firewall down to 22/80/443, sshd hardened, fail2ban, Caddy admin API moved to a
  root/caddy-only socket, security headers on both sites, /var/lib/cloud-0 closed. The workspace
  is logged out of GitHub and clones from Forgejo with its own key (`workspace@droplet`).
- 2026-10-30: droplet rebooted onto the new kernel. Machine tokens (`/api/tokens/machine`,
  `bun bridge/cloud.ts machine <env>`) replace the droplet's owner logins, which were revoked;
  checked from the droplet that typing into, reading or spawning on the laptop is refused.

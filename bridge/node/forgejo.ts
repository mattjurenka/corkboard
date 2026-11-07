// The account's Forgejo as the node's child (.agent/plans/forge-on-leader.md,
// piece 1): started while this node is the account's leader, stopped when it
// hands off, its state under <state>/node/forge/ (custom/conf/app.ini,
// data/ with the SQLite database, repos/), listening only on a unix socket
// the node's forge handler (forge.ts) reaches. It trusts the user header
// the handler sends; nothing else can reach the socket.
//
// app.ini is Forgejo's own, and kept: what the node needs of it (paths, the
// socket, the header, this user) is set on every start, and the repos'
// hooks made again; the rest, with its secrets, is what the first start
// made or what was moved in. There is no SSH: git reaches the forge on
// the account's channels (the bridge's loopback /forge/, fleetd's slot
// proxy).
//
//   CORKBOARD_FORGEJO          the forgejo binary; without it, the node runs none
//   CORKBOARD_FORGEJO_STATIC   its static files (nixpkgs' forgejo.data), for a
//                              build without them embedded

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";

export type ForgejoConfig = {
  bin: string;
  static?: string;
  dir: string;
  unix: string;
  userHeader: string;
  // How long a crashed Forgejo waits to start again.
  restartMs?: number;
};

type Ini = Record<string, Record<string, string>>;

// Sets each [section] key, keeping the rest of the file as it is ("" is the
// part before the first section).
export function setIni(text: string, set: Ini): string {
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  for (const [section, keys] of Object.entries(set)) {
    let start = 0;
    if (section) {
      start = lines.findIndex((l) => l.trim() === `[${section}]`);
      if (start < 0) {
        if (lines.length && lines[lines.length - 1].trim()) lines.push("");
        lines.push(`[${section}]`);
        start = lines.length - 1;
      }
      start++;
    }
    let end = lines.findIndex((l, i) => i >= start && /^\s*\[/.test(l));
    if (end < 0) end = lines.length;
    for (const [key, value] of Object.entries(keys)) {
      const at = lines.findIndex((l, i) => i >= start && i < end && new RegExp(`^\\s*${key}\\s*=`).test(l));
      if (at >= 0) lines[at] = `${key} = ${value}`;
      else {
        let last = end;
        while (last > start && !lines[last - 1].trim()) last--;
        lines.splice(last, 0, `${key} = ${value}`);
        end++;
      }
    }
  }
  return lines.join("\n") + "\n";
}

// What the node's Forgejo is, on every start.
export function managed(o: ForgejoConfig, user = userInfo().username): Ini {
  return {
    "": { RUN_USER: user, WORK_PATH: o.dir },
    server: {
      PROTOCOL: "http+unix",
      HTTP_ADDR: o.unix,
      APP_DATA_PATH: join(o.dir, "data"),
      ...(o.static && { STATIC_ROOT_PATH: o.static }),
      DISABLE_SSH: "true",
      START_SSH_SERVER: "false",
      SSH_CREATE_AUTHORIZED_KEYS_FILE: "false",
    },
    database: { DB_TYPE: "sqlite3", PATH: join(o.dir, "data", "forgejo.db") },
    repository: { ROOT: join(o.dir, "repos") },
    security: { REVERSE_PROXY_AUTHENTICATION_USER: o.userHeader },
    service: { ENABLE_REVERSE_PROXY_AUTHENTICATION: "true", ENABLE_REVERSE_PROXY_AUTHENTICATION_API: "true" },
    log: { MODE: "console" },
  };
}

// A new forge's, before managed(): private, nobody signs up, and Forgejo's
// own login only for the browser.
async function fresh(bin: string): Promise<string> {
  const secret = async (name: string) => {
    const p = Bun.spawn([bin, "generate", "secret", name], { stdout: "pipe", stderr: "inherit" });
    const out = (await new Response(p.stdout).text()).trim();
    if ((await p.exited) !== 0 || !out) throw new Error(`forgejo generate secret ${name} failed`);
    return out;
  };
  return setIni("", {
    "": { APP_NAME: "forge", RUN_MODE: "prod" },
    server: { UNIX_SOCKET_PERMISSION: "600", LFS_START_SERVER: "true", LFS_JWT_SECRET: await secret("LFS_JWT_SECRET"), OFFLINE_MODE: "true" },
    database: { SQLITE_JOURNAL_MODE: "WAL" },
    repository: { DEFAULT_PRIVATE: "private", DEFAULT_BRANCH: "main" },
    security: { INSTALL_LOCK: "true", SECRET_KEY: await secret("SECRET_KEY"), INTERNAL_TOKEN: await secret("INTERNAL_TOKEN"), REVERSE_PROXY_TRUSTED_PROXIES: "127.0.0.1/8,::1/128" },
    oauth2: { JWT_SECRET: await secret("JWT_SECRET") },
    service: { DISABLE_REGISTRATION: "true", REQUIRE_SIGNIN_VIEW: "true", DEFAULT_KEEP_EMAIL_PRIVATE: "true", DEFAULT_ALLOW_CREATE_ORGANIZATION: "false" },
    openid: { ENABLE_OPENID_SIGNIN: "false", ENABLE_OPENID_SIGNUP: "false" },
    actions: { ENABLED: "true", DEFAULT_ACTIONS_URL: "https://code.forgejo.org" },
    "cron.update_checker": { ENABLED: "false" },
  });
}

export class Forgejo {
  private proc: ReturnType<typeof Bun.spawn> | undefined;
  private want = false;
  private starting: Promise<void> | undefined;
  private again: ReturnType<typeof setTimeout> | undefined;

  constructor(private o: ForgejoConfig) {}

  get ini() {
    return join(this.o.dir, "custom", "conf", "app.ini");
  }

  get running() {
    return !!this.proc;
  }

  start(): Promise<void> {
    this.want = true;
    if (this.proc) return Promise.resolve();
    return (this.starting ??= this.launch().finally(() => (this.starting = undefined)));
  }

  private async launch() {
    const { dir, unix, bin } = this.o;
    for (const d of [dirname(this.ini), join(dir, "data"), join(dir, "repos"), dirname(unix)]) mkdirSync(d, { recursive: true, mode: 0o700 });
    const was = existsSync(this.ini) ? readFileSync(this.ini, "utf8") : await fresh(bin);
    writeFileSync(this.ini, setIni(was, managed(this.o)), { mode: 0o600 });
    const env = { ...process.env, HOME: dir, GITEA_WORK_DIR: dir, USER: userInfo().username };
    // The repos' hooks name the binary and app.ini, which a move or an
    // upgrade changes (as nixpkgs' module does on each start).
    if (readdirSync(join(dir, "repos")).length) {
      const hooks = Bun.spawn([bin, "admin", "regenerate", "hooks", "--config", this.ini, "--work-path", dir], { cwd: dir, env, stdout: "ignore", stderr: "inherit" });
      if ((await hooks.exited) !== 0) console.error("node: forgejo: regenerating the repos' hooks failed");
    }
    if (!this.want) return;
    rmSync(unix, { force: true });
    const p = Bun.spawn([bin, "web", "--config", this.ini, "--work-path", dir], { cwd: dir, env, stdin: "ignore", stdout: "inherit", stderr: "inherit" });
    this.proc = p;
    console.log(`node: forgejo started (pid ${p.pid})`);
    void p.exited.then((code) => {
      if (this.proc !== p) return;
      this.proc = undefined;
      if (!this.want) return;
      console.error(`node: forgejo exited (${code}); starting it again`);
      this.again = setTimeout(() => this.want && void this.start().catch((e) => console.error(`node: forgejo: ${(e as Error).message}`)), this.o.restartMs ?? 10_000);
    });
  }

  // The forge's admins' logins, from its CLI (the forge's database, so it
  // needn't be running).
  async admins(): Promise<string[]> {
    const p = Bun.spawn([this.o.bin, "admin", "user", "list", "--admin", "--config", this.ini, "--work-path", this.o.dir], { env: { ...process.env, HOME: this.o.dir }, stdout: "pipe", stderr: "pipe" });
    const out = await new Response(p.stdout).text();
    if ((await p.exited) !== 0) throw new Error(`forgejo admin user list: ${(await new Response(p.stderr).text()).trim().split("\n").pop()}`);
    return out.split("\n").slice(1).map((l) => l.trim().split(/\s+/)[1]).filter((u): u is string => !!u);
  }

  async stop(ms = 20_000) {
    this.want = false;
    clearTimeout(this.again);
    await this.starting?.catch(() => {});
    const p = this.proc;
    if (!p) return;
    this.proc = undefined;
    p.kill("SIGTERM");
    const killed = setTimeout(() => p.kill("SIGKILL"), ms);
    await p.exited;
    clearTimeout(killed);
    console.log("node: forgejo stopped");
  }
}

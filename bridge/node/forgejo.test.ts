import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Forgejo, getIni, managed, setIni } from "./forgejo";

describe("setIni", () => {
  it("sets keys where they are, adds the missing ones to their section, and keeps the rest", () => {
    const was = "APP_NAME = git\nRUN_USER = git\n\n[server]\n; the socket\nHTTP_ADDR = /run/forgejo/forgejo.sock\nDOMAIN = git.example\n\n[security]\nSECRET_KEY = s\n";
    const out = setIni(was, { "": { RUN_USER: "node", WORK_PATH: "/w" }, server: { HTTP_ADDR: "/n/f.sock", DISABLE_SSH: "true" }, log: { MODE: "console" } });
    expect(out).toBe(
      "APP_NAME = git\nRUN_USER = node\nWORK_PATH = /w\n\n[server]\n; the socket\nHTTP_ADDR = /n/f.sock\nDOMAIN = git.example\nDISABLE_SSH = true\n\n[security]\nSECRET_KEY = s\n\n[log]\nMODE = console\n",
    );
  });

  it("doesn't take a key from another section, or one that only starts the same", () => {
    const out = setIni("[oauth2]\nJWT_SECRET = a\n\n[server]\nLFS_JWT_SECRET = b\n", { server: { JWT_SECRET: "c" } });
    expect(out).toBe("[oauth2]\nJWT_SECRET = a\n\n[server]\nLFS_JWT_SECRET = b\nJWT_SECRET = c\n");
  });

  it("is the same set twice", () => {
    const o = { bin: "forgejo", dir: "/s/forge", unix: "/s/forge/forgejo.sock", userHeader: "X-U" };
    const once = setIni("[server]\nDOMAIN = d\n", managed(o, "node"));
    expect(setIni(once, managed(o, "node"))).toBe(once);
  });

  it("gives ROOT_URL the tunnel's only where there is none, and the one named always", () => {
    const o = { bin: "forgejo", dir: "/s/forge", unix: "/s/forge/forgejo.sock", userHeader: "X-U", defaultUrl: "https://relay/n/h/forge/" };
    const was = "[server]\nROOT_URL = https://git.example/\n";
    expect(getIni(setIni(was, managed(o, "node", was)), "server", "ROOT_URL")).toBe("https://git.example/");
    expect(getIni(setIni("", managed(o, "node", "")), "server", "ROOT_URL")).toBe("https://relay/n/h/forge/");
    expect(getIni(setIni(was, managed({ ...o, url: "https://mine/" }, "node", was)), "server", "ROOT_URL")).toBe("https://mine/");
    expect(getIni("[session]\nROOT_URL = x\n", "server", "ROOT_URL")).toBeUndefined();
  });
});

// Against a real Forgejo, when CORKBOARD_FORGEJO names one.
const bin = process.env.CORKBOARD_FORGEJO;
describe.skipIf(!bin)("the node's Forgejo", () => {
  it("starts a new forge on its socket, lets the user header in, and stops", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fj-"));
    const unix = join(dir, "f.sock");
    const f = new Forgejo({ bin: bin!, static: process.env.CORKBOARD_FORGEJO_STATIC, dir, unix, userHeader: "X-Test-User" });
    try {
      await f.start();
      // Up once it answers (its database made).
      let up: Response | undefined;
      for (let i = 0; i < 120 && !up; i++) up = await fetch("http://forgejo/api/v1/version", { unix } as RequestInit).catch(() => Bun.sleep(250).then(() => undefined));
      expect(up).toBeDefined();
      const ini = join(dir, "custom", "conf", "app.ini");
      const admin = Bun.spawnSync([bin!, "admin", "user", "create", "--config", ini, "--work-path", dir, "--username", "matt", "--email", "matt@example.invalid", "--random-password", "--admin"], { env: { ...process.env, HOME: dir } });
      expect(admin.exitCode).toBe(0);
      expect(await f.admins()).toEqual(["matt"]);
      const res = await fetch("http://forgejo/api/v1/user", { unix, headers: { "X-Test-User": "matt" } } as RequestInit);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { login: string }).login).toBe("matt");
      const anon = await fetch("http://forgejo/api/v1/user", { unix } as RequestInit);
      expect(anon.status).not.toBe(200);
      await f.stop();
      expect(f.running).toBe(false);
      await expect(fetch("http://forgejo/api/v1/version", { unix } as RequestInit)).rejects.toThrow();
    } finally {
      await f.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("keeps a moved forge's secrets and settings, and makes it the node's", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fj-"));
    try {
      mkdirSync(join(dir, "custom", "conf"), { recursive: true });
      const ini = join(dir, "custom", "conf", "app.ini");
      writeFileSync(ini, "RUN_USER = git\nWORK_PATH = /var/lib/forgejo\n\n[server]\nHTTP_ADDR = /run/forgejo/forgejo.sock\nROOT_URL = https://git.example/\nSTART_SSH_SERVER = false\n\n[security]\nINSTALL_LOCK = true\nSECRET_KEY = kept\nREVERSE_PROXY_AUTHENTICATION_USER = X-Old\n");
      const f = new Forgejo({ bin: bin!, dir, unix: join(dir, "f.sock"), userHeader: "X-New" });
      await f.start();
      await f.stop();
      const text = readFileSync(ini, "utf8");
      expect(text).toContain("SECRET_KEY = kept");
      expect(text).toContain("ROOT_URL = https://git.example/");
      expect(text).toContain(`HTTP_ADDR = ${join(dir, "f.sock")}`);
      expect(text).toContain("REVERSE_PROXY_AUTHENTICATION_USER = X-New");
      expect(text).toContain(`WORK_PATH = ${dir}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

// A forge's git over HTTP for the tests (nvim/testing.ts's forge): git
// http-backend behind /forge/, serving the bare repositories under argv[2]
// as <owner>/<repo>.git. Its own process, since the tests block on Neovim
// while Neovim fetches from it. Writes its port to argv[3].
import "../lib/harden";
import { renameSync } from "node:fs";

const root = process.argv[2];

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/forge/")) return new Response("not found", { status: 404 });
    const p = Bun.spawn(["git", "http-backend"], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: "1",
        // Pushes too, with no one to log in.
        REMOTE_USER: "test",
        PATH_INFO: url.pathname.slice("/forge".length),
        QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: req.method,
        CONTENT_TYPE: req.headers.get("content-type") ?? "",
        GIT_CONFIG_NOSYSTEM: "1",
      },
      stdin: req.body ? new Uint8Array(await req.arrayBuffer()) : "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    const out = new Uint8Array(await new Response(p.stdout).arrayBuffer());
    // CGI: headers, a blank line, the body.
    let end = 0;
    while (end + 3 < out.length && !(out[end] === 13 && out[end + 1] === 10 && out[end + 2] === 13 && out[end + 3] === 10)) end++;
    const headers = new Headers();
    let status = 200;
    for (const line of new TextDecoder().decode(out.subarray(0, end)).split("\r\n")) {
      const at = line.indexOf(":");
      if (at < 0) continue;
      const k = line.slice(0, at).trim();
      const v = line.slice(at + 1).trim();
      if (k.toLowerCase() === "status") status = Number.parseInt(v);
      else headers.append(k, v);
    }
    return new Response(out.subarray(end + 4), { status, headers });
  },
});

await Bun.write(process.argv[3] + ".tmp", String(server.port));
renameSync(process.argv[3] + ".tmp", process.argv[3]);

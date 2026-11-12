// This machine's node, from another process of the bridge's (the recorder,
// memory-sync): its /api/node/ at the address its session-mcp.json gives,
// read each call as it may have restarted on another port, with the owner's
// token (app.ts writes both).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR } from "../dirs";

export function where(): { url: string; owner: string } {
  try {
    const url = JSON.parse(readFileSync(join(STATE_DIR, "node", "session-mcp.json"), "utf8")).mcpServers["corkboard-memory"].url as string;
    return { url: new URL(url).origin, owner: readFileSync(join(STATE_DIR, "node", "owner-token"), "utf8").trim() };
  } catch {
    throw new Error("this machine's node hasn't run: start corkboard (its bridge runs the node)");
  }
}

// A call to path under /api/node/, its JSON back, or the node's error thrown.
export async function nodeApi<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const { url, owner } = where();
  const res = await fetch(`${url}/api/node${path}`, {
    method,
    headers: { Authorization: `Bearer ${owner}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) throw new Error(json?.error ?? `the node answered ${res.status}`);
  return json as T;
}

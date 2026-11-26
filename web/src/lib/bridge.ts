// The page's own calls to the bridge, beside Neovim's socket: /account
// (bridge/onboarding.ts) and /agents (bridge/agents.ts). A path with a body
// is a POST; the bridge's token goes with each (main.tsx sets it).

let token: string | null = null;
export const setBridgeToken = (t: string | null) => void (token = t);

export async function bridge<T = any>(path: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Promise<T> {
  const res = await fetch(new URL(path.slice(1), location.href), {
    method,
    headers: { ...(token && { "x-corkboard-token": token }), ...(body !== undefined && { "content-type": "application/json" }) },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  if (!res.headers.get("content-type")?.includes("json")) throw new Error(`${res.status} ${(await res.text()).trim()}`);
  return res.json();
}

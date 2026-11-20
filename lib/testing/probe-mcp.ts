// A stdio MCP server with one tool, ping, which answers pong
// (lib/testing/scripted.ts's PROBE_MCP).

export {};

const out = (m: object) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
let buf = "";
for await (const c of Bun.stdin.stream()) {
  buf += new TextDecoder().decode(c);
  let n;
  while ((n = buf.indexOf("\n")) >= 0) {
    const m = JSON.parse(buf.slice(0, n));
    buf = buf.slice(n + 1);
    if (m.method === "initialize") out({ id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "probe", version: "1" } } });
    else if (m.method === "tools/list") out({ id: m.id, result: { tools: [{ name: "ping", description: "Ping.", inputSchema: { type: "object", properties: {} } }] } });
    else if (m.method === "tools/call") out({ id: m.id, result: { content: [{ type: "text", text: "pong" }] } });
    else if (m.id !== undefined) out({ id: m.id, result: {} });
  }
}

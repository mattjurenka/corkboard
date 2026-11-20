// Scripted model endpoints for running a real agent CLI without a real
// model (lib/acp/live.ts): OpenAI's Responses API, which Codex speaks, and
// Chat Completions, which opencode's OpenAI-compatible provider does. Each
// answers what `answer` says for the request and keeps what came in.
//
// Also probe-mcp.ts's path: a stdio MCP server with one tool, ping.

import { join } from "node:path";

export const PROBE_MCP = join(import.meta.dir, "probe-mcp.ts");

// What the model does for a request.
export type Answer =
  | { text: string }
  | { call: string; args: object }
  | { status: number; error: object }
  // A stream that fails part way (Responses only).
  | { failed: string };

// What a request had: its path, its model, its tools' names and the body.
export type Got = { path: string; model?: string; tools: string[]; body: any };

export type Scripted = { base: string; got: Got[]; stop: () => void };

const sse = (events: string[]) => new Response(events.join(""), { headers: { "content-type": "text/event-stream" } });

function serve(model: (req: Got, n: number) => Response, endpoint: string): Scripted {
  const got: Got[] = [];
  let n = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      const body = req.method === "POST" ? await req.json().catch(() => null) : null;
      const g: Got = { path, model: body?.model, tools: (body?.tools ?? []).map((t: any) => t.name ?? t.function?.name ?? t.type), body };
      got.push(g);
      if (path.endsWith("/models")) return Response.json({ object: "list", data: [], models: [] });
      if (!path.endsWith(endpoint)) return new Response("no", { status: 404 });
      return model(g, n++);
    },
  });
  return { base: `http://127.0.0.1:${server.port}/v1`, got, stop: () => server.stop(true) };
}

// The Responses API, answer(request, how many before it).
export function responses(answer: (req: Got, n: number) => Answer): Scripted {
  return serve((req, n) => {
    const a = answer(req, n);
    if ("status" in a) return Response.json({ error: a.error }, { status: a.status });
    const ev = (e: { type: string }) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;
    const id = `resp_${n}`;
    const created = ev({ type: "response.created", response: { id } } as any);
    if ("failed" in a) return sse([created, ev({ type: "response.failed", response: { id, status: "failed", error: { code: "server_error", message: a.failed } } } as any)]);
    const completed = ev({ type: "response.completed", response: { id, usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } } as any);
    if ("call" in a) {
      const item = { type: "function_call", id: "fc_1", call_id: "call_1", name: a.call, arguments: JSON.stringify(a.args), status: "completed" };
      return sse([created, ev({ type: "response.output_item.added", output_index: 0, item } as any), ev({ type: "response.output_item.done", output_index: 0, item } as any), completed]);
    }
    const item = { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: a.text, annotations: [] }] };
    return sse([
      created,
      ev({ type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } } as any),
      ev({ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: a.text } as any),
      ev({ type: "response.output_item.done", output_index: 0, item } as any),
      completed,
    ]);
  }, "/responses");
}

// Chat Completions, streamed.
export function chat(answer: (req: Got, n: number) => Answer): Scripted {
  return serve((req, n) => {
    const a = answer(req, n);
    if ("status" in a) return Response.json({ error: a.error }, { status: a.status });
    if ("failed" in a) throw new Error("chat() has no failed stream");
    const chunk = (delta: object, finish: string | null = null) =>
      `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: req.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    if ("call" in a) {
      const call = { index: 0, id: "call_1", type: "function", function: { name: a.call, arguments: JSON.stringify(a.args) } };
      return sse([chunk({ role: "assistant", tool_calls: [call] }), chunk({}, "tool_calls"), "data: [DONE]\n\n"]);
    }
    return sse([chunk({ role: "assistant", content: a.text }), chunk({}, "stop"), "data: [DONE]\n\n"]);
  }, "/chat/completions");
}

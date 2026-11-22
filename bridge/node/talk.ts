// The account's live sessions, for the user's own clients over /mcp
// (claude.ai's connector, say): every machine's, as each one's hub serves
// them (bridge/hub.ts), this one's directly and the rest on sealed
// channels (serve.ts's reach). A session is read as the phone reads it,
// its conversation's last turns from …/attach and its state from the list,
// and is sent what the phone sends: a message, an interrupt, answers to
// its question, or a permission prompt's choice.
//
// A session's id is <device>/<bridge>/<key>, its machine's and its hub's.

import type { Reach } from "../peers";
import { lines } from "../hub";
import { answers as checkAnswers } from "../sessions";
import { asked, type Item } from "../transcript";
import { dict } from "../../lib/dict";

export type TalkCall = { reach: Reach };
export type TalkTool = { description: string; properties?: Record<string, object>; required?: string[]; run: (a: any, c: TalkCall) => Promise<unknown> };

export class TalkError extends Error {}

const str = (description: string) => ({ type: "string", description });
const session = str("The session's id, from list_sessions");

const DEVICE = /^[\w-]{1,128}$/;
const BRIDGE = /^[\w-]{1,64}$/;
const KEY = /^[\w.-]{1,64}$/;
// How long a machine has to answer, and how long a conversation's first
// batches have to stop coming (they're sent at once; what's new after,
// every half second).
const ASK = 10_000;
const SETTLED = 300;
const TURNS = 20;

type Listed = { id: string; machine: string; bridge: string; key: string; s: Record<string, unknown> };

function parse(id: unknown) {
  const [device, bridge, key, ...rest] = String(id ?? "").split("/");
  if (rest.length || !DEVICE.test(device ?? "") || !BRIDGE.test(bridge ?? "") || !KEY.test(key ?? "")) throw new TalkError("that isn't a session's id; list_sessions lists them");
  return { device, bridge, key, path: `/api/sessions/${bridge}/${encodeURIComponent(key)}` };
}

async function json(res: Response) {
  const v = await res.json().catch(() => null);
  if (!res.ok) throw new TalkError(typeof v?.error === "string" ? v.error : `its machine answered ${res.status}`);
  return v;
}

// Each machine's sessions, and the machines that didn't answer.
async function listed(c: TalkCall): Promise<{ sessions: Listed[]; unreachable: string[] }> {
  const { devices } = await c.reach.devices();
  const sessions: Listed[] = [];
  const unreachable: string[] = [];
  await Promise.all(
    devices.map(async (device) => {
      try {
        const bridges = await json(await c.reach.fetch(device, "/api/sessions", { signal: AbortSignal.timeout(ASK) }));
        for (const b of Array.isArray(bridges) ? bridges : [])
          for (const s of Array.isArray(b?.sessions) ? b.sessions : [])
            if (typeof b.id === "string" && typeof s?.key === "string" && s.key)
              sessions.push({ id: `${device}/${b.id}/${s.key}`, machine: String(b.machine ?? ""), bridge: b.id, key: s.key, s });
      } catch {
        unreachable.push(device);
      }
    }),
  );
  return { sessions, unreachable };
}

async function find(c: TalkCall, id: unknown) {
  const p = parse(id);
  const { devices } = await c.reach.devices();
  if (!devices.includes(p.device)) throw new TalkError(`machine ${p.device} isn't connected`);
  const bridges = await json(await c.reach.fetch(p.device, "/api/sessions", { signal: AbortSignal.timeout(ASK) }));
  const s = (Array.isArray(bridges) ? bridges : []).find((b) => b?.id === p.bridge)?.sessions?.find((x: { key?: unknown }) => x?.key === p.key);
  if (!s) throw new TalkError("that session has ended, or isn't one; list_sessions lists them");
  return { ...p, s: s as Record<string, unknown> };
}

const about = (s: Record<string, unknown>) => ({
  name: s.name,
  state: s.state,
  ...(typeof s.since === "number" && { since: new Date(s.since).toISOString() }),
  ...(typeof s.project === "string" && s.project && { project: s.project }),
  ...(typeof s.card === "string" && { card: s.card }),
  ...(typeof s.detail === "string" && s.detail && { detail: s.detail }),
});

// Its conversation as the phone is first sent it: the batches up to the
// first pause. Or why there's none: a session with only a screen.
async function conversation(c: TalkCall, device: string, path: string): Promise<{ items: Item[]; why?: string }> {
  const stop = new AbortController();
  const res = await c.reach.fetch(device, `${path}/attach`, { signal: stop.signal });
  if (!res.ok) await json(res);
  if (!res.body) throw new TalkError("its machine sent no conversation");
  let items: Item[] = [];
  let why: string | undefined;
  await new Promise<void>((done) => {
    let settle: ReturnType<typeof setTimeout> | undefined;
    const cap = setTimeout(finish, ASK);
    function finish() {
      clearTimeout(settle);
      clearTimeout(cap);
      stop.abort();
      done();
    }
    lines(
      res.body!,
      (m) => {
        if (m?.type === "end") {
          why = typeof m.why === "string" ? m.why : "it ended";
          return finish();
        }
        if (m?.type !== "out" || typeof m.data !== "string") return;
        const batch = JSON.parse(m.data);
        if (batch?.reset) items = [];
        if (Array.isArray(batch?.items)) items.push(...batch.items);
        clearTimeout(settle);
        settle = setTimeout(finish, SETTLED);
      },
      stop.signal,
    ).then(finish, finish);
  });
  return { items, why };
}

// Turns as Claude reads them: a tool's result under its call.
function turns(items: Item[], n: number) {
  const results = new Map<string, Item & { kind: "result" }>();
  for (const it of items) if (it.kind === "result") results.set(it.call, it);
  return items
    .filter((it) => it.kind !== "result")
    .slice(-n)
    .map((it) => {
      if (it.kind !== "tool") return { at: it.at, [it.kind]: it.text };
      const r = results.get(it.call);
      return { at: it.at, tool: it.tool, ...(it.detail && { detail: it.detail }), ...(r && { [r.error ? "error" : "result"]: r.text }) };
    });
}

async function say(c: TalkCall, device: string, path: string, body: object) {
  const v = await json(await c.reach.fetch(device, `${path}/say`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(ASK) }));
  if (typeof v?.error === "string") throw new TalkError(v.error);
}

export const TALK_TOOLS = dict<TalkTool>({
  list_sessions: {
    description:
      "The user's live Claude Code sessions, on every machine of theirs that's connected, and in their fleet's VMs: each one's id (for read_session, send_session and answer_session), name, project, state (working, idle, asking: a question waits, permission: a permission prompt waits) and since when.",
    run: async (_a, c) => {
      const { sessions, unreachable } = await listed(c);
      return { sessions: sessions.map((x) => ({ id: x.id, machine: x.machine, ...about(x.s) })), ...(unreachable.length && { unreachable }) };
    },
  },
  read_session: {
    description:
      "Read a session: its state, its conversation's last turns (what the user said, what Claude said, each tool it used with how that went), and the question it's waiting on, with each option's number, for answer_session. A permission prompt waiting is its state, permission, with what it asks to do in detail.",
    properties: { session, turns: { type: "integer", description: `At most this many turns, the newest (default ${TURNS}, at most 200)` } },
    required: ["session"],
    run: async (a, c) => {
      const s = await find(c, a.session);
      const n = Math.min(Math.max(Number(a.turns) || TURNS, 1), 200);
      const { items, why } = await conversation(c, s.device, s.path);
      const q = asked(items);
      const screen = !items.length && why ? await (async () => json(await c.reach.fetch(s.device, s.path, { signal: AbortSignal.timeout(ASK) })))().catch(() => undefined) : undefined;
      return {
        ...about(s.s),
        turns: turns(items, n),
        ...(q && { question: q.questions!.map((x) => ({ header: x.header, question: x.question, multiSelect: x.multiSelect, options: x.options.map((o, i) => ({ n: i, ...o })) })) }),
        ...(screen && { screen }),
      };
    },
  },
  send_session: {
    description:
      "Send a session a message, as the user typing it and pressing enter; with interrupt, stop what it's doing first (esc). Say only what the user asked you to send, or what they'd want sent on their behalf.",
    properties: { session, text: str("The message"), interrupt: { type: "boolean", description: "Stop its turn first, as esc does" } },
    required: ["session"],
    run: async (a, c) => {
      const s = await find(c, a.session);
      const text = typeof a.text === "string" ? a.text.trim() : "";
      if (!text && a.interrupt !== true) throw new TalkError("say something, or interrupt it");
      if (text.length > 20_000) throw new TalkError("keep a message under 20000 characters");
      if (a.interrupt === true) await say(c, s.device, s.path, { text: "", keys: ["esc"] });
      if (text) await say(c, s.device, s.path, { text, keys: ["enter"] });
      return { sent: true };
    },
  },
  answer_session: {
    description:
      "Answer what a session waits on. Its question (read_session shows it): answers, one for each of its questions in order, each the numbers of the options picked (from 0; one only, unless it's multiSelect) and other for words of the user's own. Or a permission prompt (state permission): choice, the number of the prompt's option as its screen shows it, usually 1 yes, 2 yes and don't ask again, 3 no. Only what the user chose.",
    properties: {
      session,
      answers: {
        type: "array",
        description: "One for each question",
        items: { type: "object", properties: { picks: { type: "array", items: { type: "integer" } }, other: { type: "string" } }, required: ["picks"] },
      },
      choice: { type: "integer", description: "A permission prompt's option, from 1" },
    },
    required: ["session"],
    run: async (a, c) => {
      const s = await find(c, a.session);
      if (a.choice !== undefined) {
        if (s.s.state !== "permission") throw new TalkError("it isn't waiting on a permission prompt");
        if (!Number.isInteger(a.choice) || a.choice < 1 || a.choice > 9) throw new TalkError("choice is the option's number, from 1");
        await say(c, s.device, s.path, { text: String(a.choice), keys: [] });
        return { answered: true };
      }
      const checked = checkAnswers(a.answers);
      if (typeof checked === "string") throw new TalkError(checked);
      await say(c, s.device, s.path, { answers: checked });
      return { answered: true };
    },
  },
});

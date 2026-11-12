// The ACP sessions a Neovim runs (lib/acp/, .agent/plans/agents.md stage
// 5): the agent's process is the bridge's, and its session is a buffer of
// that Neovim's (corkboard/acp.lua). cards/cloud.lua's requests drive it:
//
//   acp_start(buf, o)        start the kind's agent and open a session; o:
//                            { kind, cwd, prompt?, mcp?: --mcp-config values,
//                            servers?: ACP-shaped (agent.ui_server), brain?,
//                            resume?, task? }; gives { session, transcript }
//   acp_prompt(buf, text)    a turn; its end comes as the settled event
//   acp_cancel(buf)          the turn stopped
//   acp_answer(buf, id, opt) a permission's answer: an optionId, or null to refuse
//   acp_stop(buf)            the agent ended
//
// What the session does goes back as Lua: its events to
// corkboard.agents.hook, as hooks/session.lua's do; its conversation, as
// the transcript's items (bridge/transcript.ts, the phone's) and the words
// it hasn't written yet, and each permission request, turn's end and its
// ending to corkboard.acp.

import { join } from "node:path";
import { AcpSession, type Permission } from "../lib/acp/client";
import { KINDS, NO_RESUME } from "../lib/acp/kinds";
import type { Model } from "../lib/think";
import { STATE_DIR } from "./dirs";
import { Follower } from "./transcript";
import type { AppNode } from "./node/app";

export type Lua = (code: string, ...args: unknown[]) => void;

const DIR = join(STATE_DIR, "acp");

// Each start's, for its prompt's file.
let starts = 0;

type Open = {
  buf: number;
  session: AcpSession;
  asked: Map<string, (option: string | null) => void>;
  asks: number;
  // Its transcript, read as it's written, once the session is open.
  follower?: Follower;
  drawing?: ReturnType<typeof setTimeout>;
  // The words last drawn as it said them.
  said?: string;
};

// Updates come a word at a time: the view's drawn this long after the first.
const DRAW = 40;


export class Acp {
  private open = new Map<number, Open>();

  constructor(
    private lua: Lua,
    private node: () => AppNode | undefined,
  ) {}

  private get(buf: number): Open {
    const o = this.open.get(buf);
    if (!o || o.session.closed) throw new Error("that session has ended");
    return o;
  }

  // The brain's model and key, from the node; none without one.
  private async model(brain: string | null | undefined): Promise<{ model?: Model; key?: string }> {
    const node = this.node();
    if (!node) return {};
    return ((await node.brains("brains_model", [brain ?? null])) as { model?: Model; key?: string }) ?? {};
  }

  async call(op: string, args: any[]): Promise<unknown> {
    const buf = Number(args[0]);
    if (!Number.isInteger(buf)) throw new Error("corkboard acp: which buffer?");
    switch (op) {
      case "acp_start": {
        const o = args[1] ?? {};
        const kind = KINDS[o.kind];
        if (!kind) throw new Error(`corkboard acp: no agent called ${o.kind}`);
        if (typeof o.cwd !== "string") throw new Error("corkboard acp: where?");
        this.stop(buf);
        const spec = kind({ dir: join(DIR, "prompts"), name: `${process.pid}-${buf}-${++starts}`, prompt: o.prompt, mcp: o.mcp, servers: o.servers, ...(await this.model(o.brain)) });
        const asked = new Map<string, (option: string | null) => void>();
        const open: Open = { buf, session: undefined as unknown as AcpSession, asked, asks: 0 };
        const session = new AcpSession({
          spec,
          cwd: o.cwd,
          dir: DIR,
          event: (e) => this.lua("require('corkboard.agents').hook(...)", { buf, ...e }),
          update: () => this.draw(open),
          permission: (p: Permission) =>
            new Promise((resolve) => {
              const id = String(++open.asks);
              asked.set(id, resolve);
              this.lua("require('corkboard.acp').permission(...)", buf, id, p);
            }),
          exit: (code) => {
            this.drawNow(open);
            for (const answer of asked.values()) answer(null);
            asked.clear();
            if (this.open.get(buf) === open) this.open.delete(buf);
            this.lua("require('corkboard.acp').exited(...)", buf, code);
          },
        });
        open.session = session;
        this.open.set(buf, open);
        try {
          // One that can't go on with a session starts a new one.
          const id = await session.start(typeof o.resume === "string" && !NO_RESUME.has(o.kind) ? o.resume : undefined);
          // A resumed one's history with it.
          if (session.transcriptPath) open.follower = new Follower(session.transcriptPath);
          this.draw(open);
          if (typeof o.task === "string" && o.task) this.turn(buf, o.task);
          return { session: id, transcript: session.transcriptPath, capabilities: session.capabilities };
        } catch (err) {
          this.stop(buf);
          throw err;
        }
      }
      case "acp_prompt":
        this.get(buf);
        this.turn(buf, String(args[1] ?? ""));
        return null;
      case "acp_cancel": {
        // What it still asks is refused, as ACP has it after a cancel.
        const o = this.get(buf);
        o.session.cancel();
        for (const answer of o.asked.values()) answer(null);
        o.asked.clear();
        return null;
      }
      case "acp_answer": {
        const o = this.get(buf);
        const answer = o.asked.get(String(args[1]));
        o.asked.delete(String(args[1]));
        answer?.(typeof args[2] === "string" ? args[2] : null);
        return null;
      }
      case "acp_stop":
        this.stop(buf);
        return null;
    }
    throw new Error(`corkboard acp: no ${op}`);
  }

  // A prompt, not waited on: how it ends comes as events, and its
  // stopReason to corkboard.acp.
  private turn(buf: number, text: string) {
    const o = this.get(buf);
    // The turn's last words drawn before how it ended.
    o.session
      .prompt(text)
      .then((stop) => (this.drawNow(o), this.lua("require('corkboard.acp').settled(...)", buf, stop)))
      .catch((err) => (this.drawNow(o), this.lua("require('corkboard.acp').failed(...)", buf, (err as Error).message)));
    this.draw(o);
  }

  // What's new in its conversation, soon.
  private draw(o: Open) {
    o.drawing ??= setTimeout(() => this.drawNow(o), DRAW);
  }

  private drawNow(o: Open) {
    clearTimeout(o.drawing);
    o.drawing = undefined;
    if (!o.follower) return;
    // Its thinking comes as updates too, with nothing new to draw.
    const items = o.follower.read();
    const saying = o.session.saying;
    if (items.length === 0 && saying === o.said) return;
    o.said = saying;
    this.lua("require('corkboard.acp').view(...)", o.buf, items, saying);
  }

  stop(buf: number) {
    const o = this.open.get(buf);
    this.open.delete(buf);
    o?.session.close();
  }

  close() {
    for (const buf of [...this.open.keys()]) this.stop(buf);
  }
}

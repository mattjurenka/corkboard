// The bridge's sessions, for the phone and the fleet view (sessions.ts): the
// Claude Code sessions of every page it has open (away.ts's list), each by
// its page's id and its buffer ("3-12"). Their screen and what's typed into
// them go to the page's Neovim (corkboard/away.lua), and so does a mirror of
// their terminal (corkboard/mirror.lua); their conversation is
// read from their log. A page on another machine has its logs there, so
// its sessions have no conversation here.
//
// CORKBOARD_REMOTE_SESSIONS=0 turns it off.

import { hostname } from "node:os";
import * as away from "./away";
import { bridgeId, serve, type Hosted } from "./sessions";

// This machine's, as fleetd names it (fleet/fleetd/queue.ts).
const ENVIRONMENT = process.env.CORKBOARD_FLEET_ENVIRONMENT ?? hostname();

const at = (key: string) => key.split("-").map(Number) as [number, number];

function list(): Hosted[] {
  // The fleet view's own isn't wanted: there's no page it's mine to.
  return away.list().map(({ mine: _, page, buf, transcript, ...s }) => ({
    ...s,
    key: `${page}-${buf}`,
    ...(transcript && !s.host && { transcript }),
  }));
}

let id: string | undefined;
// This bridge's id at the Worker, once it's serving.
export const self = () => id;

export function start(port: number) {
  if (process.env.CORKBOARD_REMOTE_SESSIONS === "0") return;
  id = bridgeId(`${hostname()}-${port}`);
  serve(id, ENVIRONMENT, {
    list,
    watch: away.watch,
    screen: (key) => away.ask(at(key)[0], "screen", at(key)[1]),
    say: (key, text, keys) => away.ask(at(key)[0], "say", at(key)[1], text, keys),
    terminals: (to) => {
      // Each stream's page, which its Neovim is in.
      const pages = new Map<string, number>();
      away.onMirror((stream, data, why) => (data === null ? to.end(stream, why ?? "ended") : to.out(stream, data)));
      const tell = (stream: string, fn: "input" | "size" | "close", ...args: unknown[]) => {
        const page = pages.get(stream);
        if (page !== undefined && !away.mirror(page, fn, stream, ...args)) to.end(stream, "that session's page is closed");
      };
      return {
        open: (stream, key) => {
          const [page, buf] = at(key);
          pages.set(stream, page);
          if (!away.mirror(page, "open", stream, buf)) to.end(stream, "that session's page is closed");
        },
        input: (stream, data) => tell(stream, "input", data),
        size: (stream, rows, cols, focus) => tell(stream, "size", rows, cols, focus),
        close: (stream) => {
          tell(stream, "close");
          pages.delete(stream);
        },
      };
    },
  });
}

// What the agents are doing, across every card: the board's newest log
// entries (corkboard.board's activity), folded to one line until opened,
// like Notifications. An entry names its card; clicking it opens the card.

import { useState } from "react";
import { useNvim } from "@/nvim/context";
import { useStore } from "@/store";
import { cn } from "@/lib/utils";

type Entry = { time: string; agent: string; id: string; title: string; text: string };

// Today's entries by time of day, older ones by date.
function when(iso: string) {
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", hour12: true })
    : d.toLocaleDateString([], { month: "short", day: "numeric" });
}

export function Activity() {
  const nvim = useNvim();
  const entries: Entry[] = useStore((s) => s.views.board?.activity) ?? [];
  const [open, setOpen] = useState(false);
  const show = (id: string) => nvim.lua("local b = require('corkboard.board'); b.show(); b.select(...); b.open_card(...)", id);

  return (
    <section className={cn("flex min-h-0 flex-col border-t", open && "flex-1 basis-0")}>
      <header className="flex items-center pr-ch pl-ch text-muted-foreground">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          title={open ? "Hide activity" : "Show activity"}
          className="flex min-w-0 cursor-pointer items-center gap-ch lowercase"
        >
          <span className="w-ch flex-none">{open ? "▾" : "▸"}</span>
          Activity
          {!open && entries[0] && (
            <span className="truncate normal-case">
              {entries[0].agent} · {entries[0].text.split("\n")[0]}
            </span>
          )}
        </button>
      </header>
      {open && (
        <ol className="flex-1 overflow-y-auto pb-row">
          {entries.length === 0 && <li className="pl-2ch text-muted-foreground">nothing logged yet</li>}
          {entries.map((e, i) => (
            <li
              key={`${e.id}:${e.time}:${i}`}
              onClick={() => show(e.id)}
              title={`${e.id} ${e.title}\n${e.text}`}
              className="flex cursor-pointer flex-col pr-ch pl-2ch hover:bg-accent"
            >
              <span className="flex min-w-0 gap-ch">
                <span className="flex-none text-muted-foreground">{when(e.time)}</span>
                <span className="flex-none text-primary">{e.agent}</span>
                <span className="truncate text-muted-foreground">
                  {e.id.replace(/^TASK-/, "#")} {e.title}
                </span>
              </span>
              <span className="line-clamp-2 break-words whitespace-pre-line">{e.text}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

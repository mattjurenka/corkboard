// The sidebar's foot: this page's notifications (attention.ts), folded to
// one line with a count of the unread until it is opened. Opened, it takes
// a share of the sidebar like Tabs and Files, newest first. A notification
// that raised nothing on the desktop says why under it.

import { useEffect, useState } from "react";
import { clearNotifications, type Note } from "@/attention";
import { cn } from "@/lib/utils";
import { store, useStore } from "@/store";
import { HeaderButton } from "./Sidebar";

const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export function Notifications() {
  const notes = useStore((s) => s.notifications);
  const unread = useStore((s) => s.unread);
  const [open, setOpen] = useState(false);
  // What arrives while the list is open is read as it comes.
  useEffect(() => {
    if (open && unread) store.set({ unread: 0 });
  }, [open, unread]);

  const header = (
    <button type="button" onClick={() => setOpen(!open)} title={open ? "Hide notifications" : "Show notifications"} className="flex cursor-pointer items-center gap-ch lowercase">
      <span className="w-ch">{open ? "▾" : "▸"}</span>
      Notifications
      {!open && unread > 0 && <span className="text-primary">● {unread}</span>}
    </button>
  );
  const clear = notes.length > 0 && (
    <HeaderButton title="Clear notifications" onClick={clearNotifications}>
      clear
    </HeaderButton>
  );

  return (
    <section className={cn("flex min-h-0 flex-col border-t", open && "flex-1 basis-0")}>
      <header className="flex items-center justify-between pr-ch pl-ch text-muted-foreground">
        {header}
        {open && clear}
      </header>
      {open && (
        <ol className="flex-1 overflow-y-auto pb-row">
          {notes.length === 0 && <li className="pl-2ch text-muted-foreground">none yet</li>}
          {notes.map((n) => (
            <Entry key={n.id} note={n} />
          ))}
        </ol>
      )}
    </section>
  );
}

function Entry({ note }: { note: Note }) {
  return (
    <li
      onClick={note.open}
      title={note.body}
      className={cn("flex flex-col pr-ch pl-2ch", note.open && "cursor-pointer hover:bg-accent")}
    >
      <span className="flex min-w-0 gap-ch">
        <span className="flex-none text-muted-foreground">{clock(note.time)}</span>
        <span className="truncate text-primary">{note.title}</span>
      </span>
      <span className="line-clamp-3 break-words whitespace-pre-line">{note.body}</span>
      {!note.shown && <span className="truncate text-muted-foreground">not shown: {note.reason}</span>}
    </li>
  );
}

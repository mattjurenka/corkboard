// The project, then tabs over files, each half the remaining height, and
// the notifications folded at the foot (a third each when opened).
//
// Tabs are drawn from ext_tabline: Neovim stops drawing its own tabline and
// sends tabline_update instead; gt/gT and :tab* still drive it. Tabs 1 and 2
// are always the board and token usage (corkboard.board and corkboard.usage
// keep them there), so they are labelled Board and Usage whatever window is
// focused in them, and have no close button or number. The tabs after them
// are numbered from 1, under a gap.

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { keepFocus, useNvim } from "@/nvim/context";
import { useStore } from "@/store";
import { Activity } from "./Activity";
import { Files } from "./Files";
import { Notifications } from "./Notifications";

const PINNED = ["Board", "Usage"];

const home = (p: string) => p.replace(/^\/home\/[^/]+(?=\/|$)/, "~");

export function Sidebar() {
  const nvim = useNvim();
  const context = useStore((s) => s.context);
  const host = useStore((s) => s.host);
  return (
    <nav
      aria-label="Project"
      onMouseDown={keepFocus}
      className="absolute inset-y-0 left-0 flex w-(--sidebar-width) flex-col overflow-hidden border-r bg-background select-none"
    >
      <div className="flex min-w-0 flex-col px-2ch py-row">
        <span className="truncate font-bold">{context ? context.cwd.split("/").at(-1) || "/" : ""}</span>
        <span className="truncate text-muted-foreground">{context ? (host ? `${host}:` : "") + home(context.cwd) : ""}</span>
      </div>
      <Section
        title="Tabs"
        action={
          // The tool picker, as Ctrl+Space opens it: a bare tabnew is an empty
          // buffer, and the picker is where the things worth a tab (Claude
          // Code, a terminal, a file) are opened from.
          <HeaderButton title="Open… (Ctrl+Space)" onClick={() => nvim.lua("require('corkboard.picker').tools()")}>
            +
          </HeaderButton>
        }
      >
        <Tabs />
      </Section>
      <Files />
      <Activity />
      <Notifications />
    </nav>
  );
}

function Tabs() {
  const nvim = useNvim();
  const tabs = useStore((s) => s.tabs);
  if (!tabs) return <ol className="flex-1" />;
  return (
    <ol className="flex-1 overflow-y-auto pb-row">
      {tabs.tabs.map(({ tab, name }, i) => {
        const pinned = PINNED[i];
        const current = tab.id === tabs.current.id;
        return (
          <li
            key={tab.id}
            title={pinned || name || "[No Name]"}
            onClick={() => nvim.notify("nvim_set_current_tabpage", tab)}
            className={cn(
              "group flex min-w-0 cursor-pointer items-center gap-ch pr-ch pl-2ch hover:bg-accent",
              current && "bg-selection hover:bg-selection",
              i === PINNED.length - 1 && "mb-row",
            )}
          >
            <span className={cn("w-ch flex-none text-right text-muted-foreground", current && "text-primary")}>
              {pinned ? "" : i + 1 - PINNED.length}
            </span>
            {pinned ? <span className="min-w-0 flex-1 truncate text-primary">{pinned}</span> : <TabLabel name={name} />}
            {!pinned && (
              <Button
                variant="ghost"
                size="cell"
                title="Close tab"
                className="invisible flex-none text-muted-foreground group-hover:visible"
                onClick={(e) => {
                  e.stopPropagation();
                  nvim.notify("nvim_command", `${i + 1}tabclose`);
                }}
              >
                ×
              </Button>
            )}
          </li>
        );
      })}
    </ol>
  );
}

// File name bright, directory dimmed under it. A terminal
// (term://<cwd>//<pid>:<cmd>) shows its program over the directory it runs in.
function TabLabel({ name }: { name: string }) {
  if (!name) return <span className="min-w-0 flex-1 truncate text-muted-foreground">[No Name]</span>;
  const term = /^term:\/\/(.*?)\/\/\d+:(.*)$/.exec(name);
  let file: string, dir: string | null;
  if (term) {
    file = term[2].split(" ")[0].split("/").at(-1)!;
    dir = term[1];
  } else {
    const slash = name.lastIndexOf("/");
    file = name.slice(slash + 1);
    dir = slash > 0 ? name.slice(0, slash) : null;
  }
  return (
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="truncate">{file}</span>
      {dir && <span className="truncate text-muted-foreground">{dir}</span>}
    </span>
  );
}

export function Section({ title, action, children, className }: { title: string; action?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn("flex min-h-0 flex-1 basis-0 flex-col", className)}>
      <SectionHeader title={title} action={action} />
      {children}
    </section>
  );
}

export function SectionHeader({ title, action }: { title: string; action?: React.ReactNode }) {
  return (
    <header className="flex items-center justify-between pr-ch pl-2ch text-muted-foreground lowercase">
      {title}
      {action}
    </header>
  );
}

export function HeaderButton(props: React.ComponentProps<typeof Button>) {
  return <Button variant="ghost" size="cell" className="text-muted-foreground" {...props} />;
}

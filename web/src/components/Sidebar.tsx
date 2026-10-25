// The project, then tabs over files, each half the remaining height, and
// the notifications folded at the foot (a third each when opened).
//
// Tabs are drawn from ext_tabline: Neovim stops drawing its own tabline and
// sends tabline_update instead; gt/gT and :tab* still drive it. Tabs 1 and 2
// are always the board and token usage (corkboard.board and corkboard.usage
// keep them there), so they are labelled Board and Usage whatever window is
// focused in them, and have no close button. The tabs after them come under
// a gap. All are numbered as Neovim does, for Ctrl+Shift+<n>. The day plan
// has a window of its own, opened from the project's header (planWindow.ts).

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { keepFocus, useNvim } from "@/nvim/context";
import { toNvimKey } from "@/nvim/input.js";
import { useStore } from "@/store";
import { useState } from "react";
import { Activity } from "./Activity";
import { Files } from "./Files";
import { Notifications } from "./Notifications";
import { openPlan } from "@/planWindow";

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
        <div className="flex min-w-0 items-center justify-between gap-ch">
          <span className="truncate font-bold">{context ? context.cwd.split("/").at(-1) || "/" : ""}</span>
          <HeaderButton title="Day plan, in its own window (<leader>p)" onClick={() => openPlan()}>
            plan ↗
          </HeaderButton>
        </div>
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
  // Until Neovim has put the editor back, the tabs the page last saw
  // (skeleton.ts), there to look at but not yet to click.
  const restored = useStore((s) => !!s.layout && s.layout.restored !== false);
  const skeleton = useStore((s) => s.skeleton);
  const live = useStore((s) => s.tabs);
  const tabs = !restored && skeleton ? skeleton.tabs : live;
  const previewTab = useStore((s) => s.previewTab);
  const [focused, setFocused] = useState(false);
  if (!tabs) return <ol id="tabs" tabIndex={-1} className="flex-1" />;

  // With focus here (Ctrl+h from Neovim's leftmost window), Ctrl+j/k, j/k or
  // the arrows change tab, stopping at the ends; Ctrl+l, Enter or Esc go
  // back to Neovim. Any other key goes back too, and on to Neovim.
  const onKeyDown = (e: React.KeyboardEvent) => {
    const at = tabs.tabs.findIndex(({ tab }) => tab.id === tabs.current.id);
    const plain = !e.altKey && !e.metaKey;
    const step =
      plain && (e.key === "ArrowDown" || e.key.toLowerCase() === "j") ? 1
      : plain && (e.key === "ArrowUp" || e.key.toLowerCase() === "k") ? -1
      : 0;
    if (step) {
      e.preventDefault();
      const next = tabs.tabs[at + step];
      if (next) nvim.notify("nvim_set_current_tabpage", next.tab);
      return;
    }
    // Null for a lone modifier, as the Ctrl of Ctrl+j goes down.
    const key = toNvimKey(e.nativeEvent);
    if (!key) return;
    e.preventDefault();
    nvim.refocus();
    if ((e.ctrlKey && e.key.toLowerCase() === "l") || e.key === "Enter" || e.key === "Escape") return;
    nvim.notify("nvim_input", key);
  };

  return (
    <ol
      id="tabs"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      className={cn("flex-1 overflow-y-auto pb-row outline-none", !restored && skeleton && "pointer-events-none")}
    >
      {tabs.tabs.map(({ tab, name }, i) => {
        const pinned = PINNED[i];
        const current = tab.id === tabs.current.id;
        return (
          <li
            key={tab.id}
            title={pinned || name || "[No Name]"}
            onClick={() => nvim.notify("nvim_set_current_tabpage", tab)}
            className={cn(
              "group flex min-w-0 cursor-pointer items-center gap-ch py-half pr-ch pl-2ch hover:bg-accent",
              current && "bg-selection hover:bg-selection",
              current && focused && "outline outline-focus -outline-offset-1",
              i === PINNED.length - 1 && "mb-row",
            )}
          >
            <span className={cn("w-ch flex-none text-right text-muted-foreground", current && "text-focus")}>
              {i + 1}
            </span>
            {pinned ? (
              <span className="min-w-0 flex-1 truncate text-focus">{pinned}</span>
            ) : (
              <TabLabel name={name} preview={tab.id === previewTab} />
            )}
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
// corkboard's own views by what they are rather than their agent:// names.
const VIEW_TABS: Record<string, [string, string | null]> = {
  "agent://plan": ["Day plan", null],
  "agent://plan/proposal": ["Re-plan", "day plan"],
};

// preview: the file explorer's preview (untouched, replaced by the next file
// it opens), in italics as VS Code shows it.
function TabLabel({ name, preview }: { name: string; preview?: boolean }) {
  if (!name) return <span className="min-w-0 flex-1 truncate text-muted-foreground">[No Name]</span>;
  const term = /^term:\/\/(.*?)\/\/\d+:(.*)$/.exec(name);
  let file: string, dir: string | null;
  if (VIEW_TABS[name]) {
    [file, dir] = VIEW_TABS[name];
  } else if (term) {
    file = term[2].split(" ")[0].split("/").at(-1)!;
    dir = term[1];
  } else {
    const slash = name.lastIndexOf("/");
    file = name.slice(slash + 1);
    dir = slash > 0 ? name.slice(0, slash) : null;
  }
  return (
    <span className="flex min-w-0 flex-1 flex-col">
      <span className={cn("truncate", preview && "italic")}>{file}</span>
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

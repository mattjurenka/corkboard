// The project, then tabs over files, each half the remaining height, and
// the notifications folded at the foot (a third each when opened).
//
// Tabs are drawn from ext_tabline: Neovim stops drawing its own tabline and
// sends tabline_update instead; gt/gT and :tab* still drive it. Tabs 1 to 3
// are always the board, token usage and the fleet (corkboard.board, .usage and
// .fleet keep them there), so they are labelled Board, Usage and Fleet
// whatever window is focused in them, and have no close button. The tabs
// after them come under a gap. All are numbered as Neovim does, for Alt+<n>.
// The day plan has a window of its own, opened from the project's header
// (planWindow.ts).

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { keepFocus, type Nvim, useNvim } from "@/nvim/context";
import { toNvimKey } from "@/nvim/input.js";
import { store, type Tab, useStore } from "@/store";
import { useEffect, useState } from "react";
import { Activity } from "./Activity";
import { Files } from "./Files";
import { Notifications } from "./Notifications";
import { Spinner } from "./Spinner";
import { openPlan } from "@/planWindow";

const PINNED = ["Board", "Usage", "Fleet"];

// Each tab's ribbon down its left edge, by position, whatever the colorscheme;
// neighbors far apart in hue.
const RIBBON = ["#ff2a2a", "#00e5ff", "#ffe600", "#8a3dff", "#2ee84a", "#ff3fd2", "#ff8a00", "#2f5bff"];

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
        className="border-t pt-row"
        // Each tab is focused as a window is, outlined on its own; the list
        // itself is never what's selected.
        boxed={false}
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
  // The tab asked for, until its layout comes (store's switching): a spinner
  // on it meanwhile. Given up after a few seconds, as when Neovim was busy
  // and the tab went away.
  const pending = useStore((s) => s.switching);
  const go = (tab: Tab["tab"]) => goTab(tab, nvim);
  if (!tabs) return <ol id="tabs" tabIndex={-1} className="flex-1" />;

  // With focus here (Alt+h from Neovim's leftmost window), j/k or the
  // arrows change tab, round from one end to the other. Alt+j/k change tab
  // too, but past the last or first go on to the files. Alt+l goes on to
  // the leftmost window and Alt+h round to the rightmost; Enter or Esc go
  // back to Neovim. Any other key goes back too, and on to Neovim.
  const onKeyDown = (e: React.KeyboardEvent) => {
    // From the tab on its way, so pressing j twice goes two tabs down.
    const at = tabs.tabs.findIndex(({ tab }) => tab.id === (pending ?? tabs.current.id));
    const plain = !e.ctrlKey && !e.metaKey;
    if (e.altKey && plain && ["j", "k"].includes(e.key.toLowerCase())) {
      e.preventDefault();
      const next = tabs.tabs[at + (e.key.toLowerCase() === "j" ? 1 : -1)];
      if (next) go(next.tab);
      else document.querySelector<HTMLElement>("#files")?.focus();
      return;
    }
    if (e.altKey && plain && edgeWindow(e.key, nvim)) {
      e.preventDefault();
      return;
    }
    const step =
      plain && (e.key === "ArrowDown" || e.key.toLowerCase() === "j") ? 1
      : plain && (e.key === "ArrowUp" || e.key.toLowerCase() === "k") ? -1
      : 0;
    if (step) {
      e.preventDefault();
      const n = tabs.tabs.length;
      go(tabs.tabs[(at + step + n) % n].tab);
      return;
    }
    // Null for a lone modifier, as the Alt of Alt+j goes down.
    const key = toNvimKey(e.nativeEvent);
    if (!key) return;
    e.preventDefault();
    nvim.refocus();
    if (e.key === "Enter" || e.key === "Escape") return;
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
      {tabs.tabs.map(({ tab, name, label }, i) => {
        const pinned = PINNED[i];
        // The tab asked for, at once, as the outline is: not left behind
        // waiting on Neovim when the keys go quickly.
        const current = tab.id === (pending ?? tabs.current.id);
        return (
          <li
            key={tab.id}
            title={pinned || label?.title || name || "[No Name]"}
            onClick={() => go(tab)}
            style={{ "--ribbon": RIBBON[i % RIBBON.length] } as React.CSSProperties}
            className={cn(
              // Two lines tall each, whether or not it has a directory under its name.
              "group relative flex h-[calc(3*var(--cell-h))] min-w-0 cursor-pointer items-center gap-ch py-half pr-ch pl-2ch hover:bg-accent",
              "before:absolute before:inset-y-0 before:left-0 before:w-ch before:bg-(--ribbon)",
              current && "bg-selection hover:bg-selection",
              // Outlined as a focused window is.
              focused && current && "outline outline-focus -outline-offset-1",
              i === PINNED.length - 1 && "mb-row",
            )}
          >
            {pending === tab.id ? (
              <Spinner className="w-ch flex-none text-focus" />
            ) : (
              <span className={cn("w-ch flex-none text-right text-muted-foreground", current && "text-focus")}>
                {i + 1}
              </span>
            )}
            {pinned ? (
              <span className="min-w-0 flex-1 truncate text-focus">{pinned}</span>
            ) : (
              <TabLabel name={name} label={label} preview={tab.id === previewTab} />
            )}
            {!pinned && <TabMark name={name} label={label} />}
            {!pinned && (
              <Button
                variant="ghost"
                size="cell"
                title="Close tab"
                className="hidden w-2ch flex-none px-0 text-muted-foreground group-hover:inline-flex"
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

function goTab(tab: Tab["tab"], nvim: Nvim) {
  const currentId = store.get().tabs?.current.id;
  store.set({ switching: tab.id === currentId ? null : tab.id });
  if (tab.id !== currentId) setTimeout(() => store.get().switching === tab.id && store.set({ switching: null }), 3000);
  // Drawn now, as a key would be: from a terminal Neovim leaves an API
  // call's change undrawn until something else wakes it.
  nvim.notify("nvim_exec_lua", "vim.api.nvim_set_current_tabpage(...) vim.cmd.redraw()", [tab]);
}

// From the files: focus to the tabs, on the first (Alt+j, round) or the
// last (Alt+k, up).
export function focusTab(end: "first" | "last", nvim: Nvim) {
  const tabs = store.get().tabs?.tabs;
  if (!tabs?.length) return;
  document.querySelector<HTMLElement>("#tabs")?.focus();
  goTab(tabs[end === "first" ? 0 : tabs.length - 1].tab, nvim);
}

// File name bright, directory dimmed under it. A terminal
// (term://<cwd>//<pid>:<cmd>) shows its program over the directory it runs in,
// or Neovim's label for it (a Claude Code session's name) when it sent one.
// corkboard's own views by what they are rather than their agent:// names.
const VIEW_TABS: Record<string, [string, string | null]> = {
  "agent://plan": ["Day plan", null],
  "agent://plan/proposal": ["Re-plan", "day plan"],
};

// A cell at the row's end for what the tab is: Claude Code, a shell, one of
// corkboard's views, or a file. The close button takes its place on hover.
// Alt+l or Alt+h from the sidebar: back to Neovim, at the leftmost window
// or round to the rightmost. False for any other key.
export function edgeWindow(key: string, nvim: Nvim): boolean {
  const dir = { l: "h", h: "l" }[key.toLowerCase()];
  if (!dir) return false;
  nvim.refocus();
  nvim.notify("nvim_exec_lua", "pcall(vim.cmd, ...)", [`999wincmd ${dir}`]);
  return true;
}

function TabMark({ name, label }: { name: string; label?: Tab["label"] }) {
  if (label?.state === "working") return <Thinking />;
  const glyph =
    label ? "✻"
    : name.startsWith("term://") ? "$"
    : VIEW_TABS[name] ? "◷"
    : "·";
  return <span className="w-2ch flex-none text-center text-muted-foreground group-hover:hidden">{glyph}</span>;
}

// Claude Code's own spinner while it thinks: the star swelling and shrinking.
const THINKING = ["·", "✢", "✳", "✶", "✻", "✽"];
const THINKING_FRAMES = [...THINKING, ...THINKING.slice(1, -1).reverse()];

function Thinking() {
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI((n) => (n + 1) % THINKING_FRAMES.length), 120);
    return () => clearInterval(t);
  }, []);
  return <span className="w-2ch flex-none text-center text-focus group-hover:hidden">{THINKING_FRAMES[i]}</span>;
}

// preview: the file explorer's preview (untouched, replaced by the next file
// it opens), in italics as VS Code shows it.
function TabLabel({ name, label, preview }: { name: string; label?: Tab["label"]; preview?: boolean }) {
  if (!name) return <span className="min-w-0 flex-1 truncate text-muted-foreground">[No Name]</span>;
  const term = /^term:\/\/(.*?)\/\/\d+:(.*)$/.exec(name);
  let file: string, dir: string | null;
  if (VIEW_TABS[name]) {
    [file, dir] = VIEW_TABS[name];
  } else if (term) {
    file = label?.title ?? term[2].split(" ")[0].split("/").at(-1)!;
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

export function Section({ title, action, children, className, boxed = true }: { title: string; action?: React.ReactNode; children: React.ReactNode; className?: string; boxed?: boolean }) {
  return (
    <section
      className={cn(
        "relative flex min-h-0 flex-1 basis-0 flex-col",
        // A box in the focus color while the keys are in it (the files),
        // over the rows rather than under them.
        boxed && "focus-within:after:pointer-events-none focus-within:after:absolute focus-within:after:inset-0 focus-within:after:z-10 focus-within:after:border focus-within:after:border-focus",
        className,
      )}
    >
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

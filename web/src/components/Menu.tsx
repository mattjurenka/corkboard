// The menu bar over the editor: File, Edit and View, as an editor that isn't
// Vim has them, each item what a key or command already does, with the key
// beside it. In the installed app it is the title bar, which the window is
// dragged by between and beside its menus.
//
// The keys stay with Neovim while a menu is open (every press keeps the
// focus where it was), but for Esc, which shuts it.

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { keepFocus, type Nvim, useNvim } from "@/nvim/context";
import { MAC } from "@/nvim/input.js";
import { openPlan } from "@/planWindow";
import { store, useStore } from "@/store";

type Item = { label: string; keys?: string; checked?: boolean; run: (nvim: Nvim) => void } | "-";

// A chord as this machine writes it: ⌘ on a Mac, Ctrl elsewhere.
const chord = (mac: string, other: string) => (MAC ? mac : other);
const lua = (code: string) => (nvim: Nvim) => void nvim.lua(code);
const cmd = (c: string) => (nvim: Nvim) => void nvim.lua("pcall(vim.cmd, ...) vim.cmd.redraw()", c);
// Typed, from whatever mode Neovim is in, as if by hand.
const typed = (keys: string) => (nvim: Nvim) => nvim.notify("nvim_input", `<C-\\><C-n>${keys}`);
const tab = (n: number) => cmd(`silent! ${n}tabnext`);

function menus(leader: string, files: boolean): [string, Item[]][] {
  return [
    [
      "File",
      [
        { label: "New…", keys: chord("⌘⇧P", "Ctrl+Space"), run: lua("require('corkboard.picker').tools()") },
        { label: "New terminal", run: lua("require('corkboard.terminal').tab()") },
        { label: "New Claude Code session", keys: "Ctrl+.", run: lua("require('corkboard.claude').open()") },
        "-",
        { label: "Open file…", keys: chord("⌘P", "Ctrl+F"), run: lua("require('corkboard.picker').files()") },
        { label: "Open project…", run: lua("require('corkboard.picker').projects()") },
        "-",
        { label: "Save", keys: chord("⌘S", "Ctrl+S"), run: cmd("update") },
        { label: "Save all", run: cmd("wall") },
        "-",
        { label: "Settings", keys: chord("⌘,", "Ctrl+,"), run: lua("require('corkboard.settings').open()") },
        "-",
        { label: "Close tab", keys: chord("⌘W", "Alt+Q"), run: lua("require('corkboard').close()") },
        { label: "Reload window", keys: "F5", run: lua("require('corkboard.restore').reload()") },
      ],
    ],
    [
      "Edit",
      [
        { label: "Undo", keys: "u", run: cmd("undo") },
        { label: "Redo", keys: "Ctrl+R", run: cmd("redo") },
        "-",
        { label: "Find", keys: "/", run: typed("/") },
        { label: "Replace", keys: ":%s/", run: typed(":%s/") },
        { label: "Find in files", keys: `${leader} g`, run: lua("Snacks.picker.grep()") },
        "-",
        {
          label: "Card from this line",
          keys: `${leader} c`,
          run: lua("local l = vim.api.nvim_win_get_cursor(0)[1] require('corkboard.board').card_from_code(l, l)"),
        },
      ],
    ],
    [
      "View",
      [
        { label: "Board", keys: chord("⌘1", "Alt+1"), run: tab(1) },
        { label: "Usage", keys: chord("⌘2", "Alt+2"), run: tab(2) },
        { label: "Fleet", keys: chord("⌘3", "Alt+3"), run: tab(3) },
        { label: "Brains", keys: chord("⌘4", "Alt+4"), run: tab(4) },
        { label: "Day plan", keys: `${leader} p`, run: () => openPlan() },
        { label: "Meetings", run: lua("require('corkboard.meetings').open()") },
        "-",
        { label: "Files", checked: files, run: () => store.set({ filesOpen: !files }) },
        { label: "Terminal", keys: "Ctrl+`", run: lua("require('corkboard.terminal').toggle()") },
        { label: "Focus mode", keys: `${leader} z`, run: lua("require('corkboard.focus').toggle()") },
        { label: "Avatar", run: lua("require('corkboard.avatar').toggle()") },
        "-",
        { label: "Next tab", keys: chord("⌘⇧]", "Ctrl+Tab"), run: cmd("tabnext") },
        { label: "Previous tab", keys: chord("⌘⇧[", "Ctrl+Shift+Tab"), run: cmd("tabprevious") },
      ],
    ],
  ];
}

export function Menu() {
  const nvim = useNvim();
  const files = useStore((s) => s.filesOpen);
  const [open, setOpen] = useState<string | null>(null);
  const [leader, setLeader] = useState("\\");
  useEffect(() => {
    nvim.rpc
      .request("nvim_exec_lua", "return vim.g.mapleader or '\\\\'", [])
      .then((l: string) => setLeader(l === " " ? "Space" : l), () => {});
  }, [nvim]);
  useEffect(() => {
    if (!open) return;
    const shut = (e: MouseEvent) => !(e.target as Element).closest?.("[data-menu]") && setOpen(null);
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(null);
    };
    addEventListener("mousedown", shut, true);
    addEventListener("keydown", esc, true);
    return () => {
      removeEventListener("mousedown", shut, true);
      removeEventListener("keydown", esc, true);
    };
  }, [open]);

  return (
    <div
      role="menubar"
      onMouseDown={keepFocus}
      className="absolute inset-x-0 top-0 z-5 box-content flex pl-[env(titlebar-area-x,0px)] h-[max(env(titlebar-area-height,0px),var(--cell-h))] items-stretch border-b bg-background select-none [-webkit-app-region:drag] [app-region:drag]"
    >
      {menus(leader, files).map(([name, items]) => (
        <div key={name} data-menu className="relative [-webkit-app-region:no-drag] [app-region:no-drag]">
          <button
            type="button"
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={open === name}
            onClick={() => setOpen(open === name ? null : name)}
            // Once one is open, the others open by passing over them.
            onMouseEnter={() => open && open !== name && setOpen(name)}
            className={cn("h-full cursor-pointer px-ch text-muted-foreground hover:text-foreground", open === name && "bg-selection text-foreground")}
          >
            {name}
          </button>
          {open === name && (
            <ul role="menu" className="absolute top-full left-0 min-w-[calc(var(--cell-w)*34)] border bg-background py-half">
              {items.map((item, i) =>
                item === "-" ? (
                  <li key={i} role="separator" className="flex h-half items-center"><span className="flex-1 border-t" /></li>
                ) : (
                  <li
                    key={item.label}
                    role={item.checked === undefined ? "menuitem" : "menuitemcheckbox"}
                    aria-checked={item.checked}
                    onClick={() => {
                      setOpen(null);
                      item.run(nvim);
                      nvim.refocus();
                    }}
                    className="flex h-row cursor-pointer items-center gap-2ch pr-2ch whitespace-nowrap hover:bg-selection"
                  >
                    <span className="w-2ch flex-none text-center text-focus">{item.checked ? "✓" : ""}</span>
                    <span className="flex-1">{item.label}</span>
                    {item.keys && <span className="text-muted-foreground">{item.keys}</span>}
                  </li>
                ),
              )}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}

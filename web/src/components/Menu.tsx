// The menu bar over the editor: File, Edit and View, as an editor that isn't
// Vim has them, each item what a key or command already does, with the key
// beside it (bind: the shortcut's name in settings.lua's Keybindings, whose
// key is shown as it's bound now). In the installed app it is the title bar, which the window is
// dragged by between and beside its menus.
//
// The keys stay with Neovim while a menu is open (every press keeps the
// focus where it was), but for Esc, which shuts it.

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { keepFocus, type Nvim, useNvim } from "@/nvim/context";
import { MAC } from "@/nvim/input.js";
import { keysFor, prettyKeys } from "@/lib/keys";
import { openPlan } from "@/planWindow";
import { type State, store, useStore } from "@/store";

type Features = State["features"];
// project: needs one open, so greyed out while there's none.
type Item = { label: string; keys?: string; bind?: string; checked?: boolean; project?: boolean; run: (nvim: Nvim) => void } | "-";

const lua = (code: string) => (nvim: Nvim) => void nvim.lua(code);
const cmd = (c: string) => (nvim: Nvim) => void nvim.lua("pcall(vim.cmd, ...) vim.cmd.redraw()", c);
// Typed, from whatever mode Neovim is in, as if by hand.
const typed = (keys: string) => (nvim: Nvim) => nvim.notify("nvim_input", `<C-\\><C-n>${keys}`);
const tab = (n: number) => cmd(`silent! ${n}tabnext`);

function menus(leader: string, files: boolean, { fleet, assistant }: Features, vim: boolean): [string, Item[]][] {
  // Brains is fourth among the tabs without the fleet (corkboard.features).
  const brains = fleet ? 5 : 4;
  // An editor's keys, without Vim's (corkboard.vimkeys).
  const own = (mac: string, other?: string) => (MAC ? prettyKeys(mac) : other && prettyKeys(other));
  return [
    [
      "File",
      [
        { label: "New…", bind: "tools", run: lua("require('corkboard.picker').tools()") },
        { label: "New terminal", project: true, run: lua("require('corkboard.terminal').tab()") },
        { label: "New Claude Code session", bind: "claude code", project: true, run: lua("require('corkboard.claude').open()") },
        "-",
        { label: "Open file…", bind: "find file", run: lua("require('corkboard.picker').files()") },
        { label: "Open project…", run: lua("require('corkboard.picker').projects()") },
        "-",
        { label: "Save", bind: "write", run: cmd("update") },
        { label: "Save all", run: cmd("wall") },
        "-",
        { label: "Settings", bind: "settings", run: lua("require('corkboard.settings').open()") },
        "-",
        { label: "Close tab", bind: "close window or tab", run: lua("require('corkboard').close()") },
        { label: "Reload window", keys: "F5", run: lua("require('corkboard.restore').reload()") },
      ],
    ],
    [
      "Edit",
      [
        { label: "Undo", keys: vim ? "u" : own("<D-z>", "<C-z>"), run: cmd("undo") },
        { label: "Redo", keys: vim ? "Ctrl+R" : own("<D-S-z>", "<C-y>"), run: cmd("redo") },
        "-",
        { label: "Find", keys: vim ? "/" : own("<D-f>"), run: typed("/") },
        { label: "Replace", keys: ":%s/", run: typed(":%s/") },
        { label: "Find in files", keys: `${leader} g`, run: lua("Snacks.picker.grep()") },
        "-",
        {
          label: "Card from this line",
          bind: "card from this line",
          project: true,
          run: lua("local l = vim.api.nvim_win_get_cursor(0)[1] require('corkboard.board').card_from_code(l, l)"),
        },
      ],
    ],
    [
      "View",
      [
        { label: "Projects", bind: "tab 1", run: tab(1) },
        { label: "Board", bind: "tab 2", project: true, run: tab(2) },
        { label: "Usage", bind: "tab 3", run: tab(3) },
        ...(fleet ? [{ label: "Fleet", bind: "tab 4", run: tab(4) }] : []),
        { label: "Brains", bind: `tab ${brains}`, run: tab(brains) },
        ...(assistant
          ? [
              { label: "Day plan", bind: "day plan", run: () => openPlan() },
              { label: "Meetings", run: lua("require('corkboard.meetings').open()") },
            ]
          : []),
        "-",
        { label: "Files", checked: files, run: () => store.set({ filesOpen: !files }) },
        { label: "Terminal", bind: "terminal", project: true, run: lua("require('corkboard.terminal').toggle()") },
        { label: "Focus mode", bind: "focus mode", run: lua("require('corkboard.focus').toggle()") },
        { label: "Avatar", run: lua("require('corkboard.avatar').toggle()") },
        "-",
        { label: "Next tab", bind: "next tab", run: cmd("tabnext") },
        { label: "Previous tab", bind: "previous tab", run: cmd("tabprevious") },
      ],
    ],
  ];
}

export function Menu() {
  const nvim = useNvim();
  const files = useStore((s) => s.filesOpen);
  const features = useStore((s) => s.features);
  const bound = useStore((s) => s.keys);
  const vim = useStore((s) => s.vim);
  const none = useStore((s) => !!s.context?.none);
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
      {menus(leader, files, features, vim).map(([name, items]) => (
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
                    aria-disabled={none && item.project}
                    onClick={() => {
                      if (none && item.project) return;
                      setOpen(null);
                      item.run(nvim);
                      nvim.refocus();
                    }}
                    className={cn("flex h-row cursor-pointer items-center gap-2ch pr-2ch whitespace-nowrap hover:bg-selection", none && item.project && "cursor-default opacity-50 hover:bg-transparent")}
                  >
                    <span className="w-2ch flex-none text-center text-focus">{item.checked ? "✓" : ""}</span>
                    <span className="flex-1">{item.label}</span>
                    {(() => {
                      const lhs = item.bind ? keysFor(bound[item.bind]) : undefined;
                      const keys = lhs ? prettyKeys(lhs, leader) : item.keys;
                      return keys && <span className="text-muted-foreground">{keys}</span>;
                    })()}
                  </li>
                ),
              )}
            </ul>
          )}
        </div>
      ))}
      <button
        type="button"
        role="menuitemcheckbox"
        aria-checked={vim}
        onClick={() => {
          void nvim.lua("require('corkboard.settings').set('vim', ...)", !vim);
          nvim.refocus();
        }}
        // Clear of the window's own buttons, where the title bar has them.
        style={{ marginRight: "calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw))" }}
        className="ml-auto h-full cursor-pointer px-ch whitespace-pre text-muted-foreground hover:text-foreground [-webkit-app-region:no-drag] [app-region:no-drag]"
      >
        [<span className="text-focus">{vim ? "✓" : " "}</span>] vim
      </button>
    </div>
  );
}

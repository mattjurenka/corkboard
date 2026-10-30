// The file browser in the sidebar's lower half: the project's folders,
// read from Neovim one directory at a time as they are opened
// (corkboard.list_dir). A click on a file opens it in a Neovim tab of its
// own (corkboard.open_file); keyboard focus stays with the canvas. Alt+j
// from the sidebar's tabs brings the keys here to walk the tree.

import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { useNvim } from "@/nvim/context";
import { toNvimKey } from "@/nvim/input.js";
import { useStore } from "@/store";
import { edgeWindow, focusTab, HeaderButton, Section } from "./Sidebar";

type Entry = { name: string; dir?: boolean; ignored?: boolean; git?: "modified" | "added" };

export function Files() {
  const nvim = useNvim();
  const root = useStore((s) => s.context?.cwd ?? null);
  const current = useStore((s) => s.context?.file ?? null);
  const version = useStore((s) => s.filesVersion);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // dir -> its entries; what was read stays cached, so reopening is instant.
  const [children, setChildren] = useState<Map<string, Entry[]>>(new Map());
  const tree = useRef<HTMLDivElement>(null);

  const load = useCallback(
    async (dirs: string[]) => {
      const read = await Promise.all(
        dirs.map((dir) =>
          nvim.rpc
            .request("nvim_exec_lua", "return require('corkboard').list_dir(...)", [dir])
            .then((entries: Entry[]) => [dir, entries] as const, () => [dir, null] as const),
        ),
      );
      setChildren((prev) => {
        const next = new Map(prev);
        for (const [dir, entries] of read) entries ? next.set(dir, entries) : next.delete(dir);
        return next;
      });
      // Gone since it was opened.
      const gone = read.filter(([, e]) => !e).map(([dir]) => dir);
      if (gone.length) setExpanded((prev) => new Set([...prev].filter((d) => !gone.includes(d))));
    },
    [nvim],
  );

  useEffect(() => {
    if (!root) return;
    setExpanded(new Set([root]));
    setChildren(new Map());
    load([root]);
  }, [root, load]);

  // Re-read every open folder; files may have come or gone.
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  useEffect(() => {
    if (root && version) load([...expandedRef.current]);
  }, [version, root, load]);

  const toggle = (dir: string) => {
    const next = new Set(expanded);
    if (next.has(dir)) next.delete(dir);
    else {
      next.add(dir);
      if (!children.has(dir)) load([dir]);
    }
    setExpanded(next);
  };

  // Every folder shut, back to the root's own entries.
  const collapseAll = () => {
    if (!root) return;
    setExpanded(new Set([root]));
    if (tree.current) tree.current.scrollTop = 0;
  };

  // The row the keys are on while the tree has focus (Alt+j from the tabs).
  const [focused, setFocused] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);

  const rows: React.ReactNode[] = [];
  // Every row shown, top to bottom, with its folder, for the keys.
  const shown: { path: string; dir: string; entry: Entry }[] = [];
  const walk = (dir: string, depth: number) => {
    for (const entry of children.get(dir) ?? []) {
      const path = `${dir}/${entry.name}`;
      const open = entry.dir && expanded.has(path);
      shown.push({ path, dir, entry });
      rows.push(
        <div
          key={path}
          title={path}
          data-path={path}
          style={{ paddingLeft: `${1 + depth * 2}ch` }}
          onClick={() => (entry.dir ? toggle(path) : nvim.openFile(path, true))}
          className={cn(
            "flex cursor-pointer items-center gap-ch pr-ch whitespace-nowrap hover:bg-accent",
            path === current && "bg-selection hover:bg-selection",
            focused && path === cursor && "outline outline-focus -outline-offset-1",
            entry.ignored && "opacity-50",
          )}
        >
          <span className="w-ch flex-none text-center text-muted-foreground">{entry.dir ? (open ? "▾" : "▸") : ""}</span>
          <FileIcon entry={entry} open={!!open} />
          <span className={cn("truncate", entry.git === "modified" && "text-review", entry.git === "added" && "text-working")}>
            {entry.name}
          </span>
        </div>,
      );
      if (open) walk(path, depth + 1);
    }
  };
  if (root) walk(root, 0);

  // Focus starts on the current file if it is shown, else the first row.
  const at = shown.findIndex((r) => r.path === cursor);
  const onFocus = () => {
    setFocused(true);
    if (at < 0) setCursor(shown.find((r) => r.path === current)?.path ?? shown[0]?.path ?? null);
  };
  useEffect(() => {
    if (focused && cursor) tree.current?.querySelector(`[data-path="${CSS.escape(cursor)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [focused, cursor]);

  // With focus here, j/k or the arrows move down and up, showing each file
  // they land on in the preview tab (as a click does), as j/k in the tabs
  // change tab; l, → or Enter open a folder, or go to the file. h or ← shut
  // the folder or go up to the one it is in. Alt+k goes back up to the last tab, and Alt+j round to the first;
  // Alt+l to the leftmost window, Alt+h round to the rightmost; Esc to Neovim. Any other key goes back too, and on to Neovim.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey) return;
    const key = e.key.toLowerCase();
    const row = shown[at];
    const move = (to: number) => {
      if (!shown[to]) return;
      setCursor(shown[to].path);
      if (!shown[to].entry.dir) nvim.openFile(shown[to].path, true);
    };
    e.preventDefault();
    if (e.altKey) {
      if (key === "k" || key === "j") focusTab(key === "j" ? "first" : "last", nvim);
      else edgeWindow(key, nvim);
      return;
    }
    if (key === "j" || e.key === "ArrowDown") move(at + 1);
    else if (key === "k" || e.key === "ArrowUp") move(at - 1);
    else if (key === "l" || e.key === "ArrowRight" || e.key === "Enter") {
      if (!row) return;
      if (!row.entry.dir) {
        nvim.openFile(row.path, true);
        nvim.refocus();
      } else if (!expanded.has(row.path)) toggle(row.path);
      else move(at + 1);
    } else if (key === "h" || e.key === "ArrowLeft") {
      if (!row) return;
      if (row.entry.dir && expanded.has(row.path)) toggle(row.path);
      else if (row.dir !== root) setCursor(row.dir);
    } else if (e.key === "Escape") nvim.refocus();
    else {
      const k = toNvimKey(e.nativeEvent);
      if (!k) return;
      nvim.refocus();
      nvim.notify("nvim_input", k);
    }
  };

  return (
    <Section
      title="Files"
      className="border-t pt-row"
      action={<HeaderButton title="Collapse all folders" onClick={collapseAll}>⊟</HeaderButton>}
    >
      <div
        ref={tree}
        id="files"
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onFocus={onFocus}
        onBlur={() => setFocused(false)}
        className="flex-1 overflow-auto pb-row outline-none"
      >
        {rows}
      </div>
    </Section>
  );
}

// A Nerd Font glyph by file type, in the theme's colors rather than each
// language's own, so the tree stays in the colorscheme.
type Icon = [glyph: string, color: string];
const BLUE = "text-primary";
const YELLOW = "text-review";
const GREEN = "text-working";
const RED = "text-blocked";
const PURPLE = "text-special";
const GREY = "text-muted-foreground";

const FILE: Icon = ["", GREY]; // nf-fa-file
const FOLDER: Icon = ["", BLUE]; // nf-fa-folder
const FOLDER_OPEN: Icon = ["", BLUE]; // nf-fa-folder_open

const BY_NAME: Record<string, Icon> = {
  ".gitignore": ["", RED], // nf-dev-git
  ".gitattributes": ["", RED],
  ".env": ["", YELLOW], // nf-oct-key
  "package.json": ["", RED], // nf-dev-npm
  "flake.nix": ["", BLUE], // nf-linux-nixos
  "flake.lock": ["", GREY],
  "bun.lock": ["", GREY], // nf-fa-lock
  Dockerfile: ["", BLUE], // nf-linux-docker
  Makefile: ["", GREY], // nf-dev-gnu
  LICENSE: ["", YELLOW], // nf-oct-law
};

const BY_EXT: Record<string, Icon> = {
  ts: ["", BLUE], // nf-seti-typescript
  mts: ["", BLUE],
  tsx: ["", BLUE], // nf-dev-react
  jsx: ["", YELLOW],
  js: ["", YELLOW], // nf-dev-javascript
  mjs: ["", YELLOW],
  cjs: ["", YELLOW],
  json: ["", YELLOW], // nf-seti-json
  lua: ["", BLUE], // nf-seti-lua
  vim: ["", GREEN], // nf-seti-vim
  md: ["", GREY], // nf-oct-markdown
  nix: ["", BLUE],
  sh: ["", GREEN], // nf-oct-terminal
  bash: ["", GREEN],
  zsh: ["", GREEN],
  py: ["", YELLOW], // nf-seti-python
  rs: ["", RED], // nf-dev-rust
  go: ["", BLUE], // nf-seti-go
  css: ["", BLUE], // nf-dev-css3
  html: ["", RED], // nf-dev-html5
  toml: ["", GREY], // nf-seti-config
  yaml: ["", PURPLE],
  yml: ["", PURPLE],
  sql: ["", YELLOW], // nf-dev-database
  txt: ["", GREY], // nf-fa-file_text
  lock: ["", GREY],
  svg: ["", PURPLE], // nf-fa-file_image
  png: ["", PURPLE],
  jpg: ["", PURPLE],
  jpeg: ["", PURPLE],
  gif: ["", PURPLE],
  webp: ["", PURPLE],
  ico: ["", PURPLE],
  pdf: ["", RED], // nf-fa-file_pdf
  webmanifest: ["", YELLOW],
};

function FileIcon({ entry, open }: { entry: Entry; open: boolean }) {
  const dot = entry.name.lastIndexOf(".");
  const ext = dot > 0 ? entry.name.slice(dot + 1).toLowerCase() : "";
  const [glyph, color] = entry.dir ? (open ? FOLDER_OPEN : FOLDER) : (BY_NAME[entry.name] ?? BY_EXT[ext] ?? FILE);
  return <span className={cn("w-ch flex-none text-center", color)}>{glyph}</span>;
}

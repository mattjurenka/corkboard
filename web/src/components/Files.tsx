// The file browser in the sidebar's lower half: the project's folders,
// read from Neovim one directory at a time as they are opened
// (corkboard.list_dir). A click on a file opens it in a Neovim tab of its
// own (corkboard.open_file); keyboard focus stays with the canvas.

import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { useNvim } from "@/nvim/context";
import { useStore } from "@/store";
import { HeaderButton, Section } from "./Sidebar";

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

  const rows: React.ReactNode[] = [];
  const walk = (dir: string, depth: number) => {
    for (const entry of children.get(dir) ?? []) {
      const path = `${dir}/${entry.name}`;
      const open = entry.dir && expanded.has(path);
      rows.push(
        <div
          key={path}
          title={path}
          style={{ paddingLeft: `${1 + depth * 2}ch` }}
          onClick={() => (entry.dir ? toggle(path) : nvim.openFile(path, true))}
          className={cn(
            "flex cursor-pointer items-center gap-ch pr-ch whitespace-nowrap hover:bg-accent",
            path === current && "bg-selection hover:bg-selection",
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

  return (
    <Section
      title="Files"
      className="border-t pt-row"
      action={<HeaderButton title="Collapse all folders" onClick={collapseAll}>⊟</HeaderButton>}
    >
      <div ref={tree} className="flex-1 overflow-auto pb-row">
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

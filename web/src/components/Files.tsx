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
      className="pt-row"
      action={<HeaderButton title="Collapse all folders" onClick={collapseAll}>⊟</HeaderButton>}
    >
      <div ref={tree} className="flex-1 overflow-auto pb-row">
        {rows}
      </div>
    </Section>
  );
}

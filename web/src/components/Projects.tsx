// Open project (from the tool picker, corkboard.picker), as a window of the
// page's like the tools: the account's projects, and under them a new one,
// named in the search field. Neovim does the opening (picker.lua's
// open_project and new_project): a clone first for a project not on this
// machine; a folder and a repository first for a new one. With a project
// open already it answers with the path, for a window of its own, opened
// here before Neovim is asked so the popup blocker lets it through. A
// project with a window already goes to that one (corkboard.window).

import { useEffect, useRef, useState } from "react";
import { useNvim } from "@/nvim/context";
import { store, useStore } from "@/store";
import { Palette, Row, Search, matches, step } from "./Palette";
import { Spinner } from "./Spinner";

type Project = { key: string; name: string; root: string; path?: string; where?: string; remote?: string };
type Listed = { projects?: Project[]; dir: string; error?: string };
type Opened = { opened?: boolean; path?: string; error?: string } | undefined;

// "git@github.com:me/x.git" or "https://github.com/me/x" to github.com/me/x.
const short = (remote: string) =>
  remote
    .replace(/^\w+:\/\//, "")
    .replace(/^[^@/]+@/, "")
    .replace(":", "/")
    .replace(/\.git$/, "");

export function Projects() {
  const open = useStore((s) => s.projects);
  const windows = useStore((s) => s.windows);
  const nvim = useNvim();
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState(0);
  const [listed, setListed] = useState<Listed | null>(null);
  const [naming, setNaming] = useState(false);
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setPicked(0);
    setListed(null);
    setNaming(false);
    setBusy(null);
    setError(null);
    input.current?.focus();
    let current = true;
    nvim.lua("return require('corkboard.picker').account_projects()").then((l: Listed | undefined) => {
      if (current) setListed(l ?? { dir: "~", error: "Neovim didn't answer" });
    });
    return () => {
      current = false;
    };
  }, [open]);

  if (!open) return null;
  const projects = naming ? [] : (listed?.projects ?? []).filter((p) => matches(`${p.name} ${p.where ?? ""} ${p.remote ? short(p.remote) : ""}`, query));
  const named = query.trim();
  const newPath = /^[/~]/.test(named) ? named : `${(listed?.dir ?? "~").replace(/\/$/, "")}/${named}`;
  const count = projects.length + 1;
  const at = Math.min(picked, count - 1);

  const close = () => {
    store.set({ projects: null });
    nvim.refocus();
  };

  const run = async (n: number, code: string, arg: unknown) => {
    const win = open.here ? window.open("about:blank", "_blank", "popup") : null;
    if (open.here && !win) return setError("The browser blocked the new window");
    setBusy(n);
    setError(null);
    const r: Opened = await nvim.lua(code, arg);
    if (!r || r.error) {
      win?.close();
      setBusy(null);
      setError(r?.error ?? "Neovim didn't answer");
      return;
    }
    if (win && r.path) {
      const url = new URL(location.href);
      url.searchParams.set("cwd", r.path);
      win.location.href = url.toString();
    } else win?.close();
    close();
  };

  const choose = (n: number) => {
    if (busy !== null) return;
    // One with a window already: that window, brought forward.
    const path = projects[n]?.path;
    if (path && windows.includes(path)) {
      nvim.notify("corkboard.window", path);
      return close();
    }
    if (n < projects.length) return run(n, "return require('corkboard.picker').open_project(...)", projects[n]);
    if (!named) {
      setNaming(true);
      setPicked(0);
      return input.current?.focus();
    }
    run(n, "return require('corkboard.picker').new_project(...)", named);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const moved = step(e, at, count);
    if (moved !== null) setPicked(moved);
    else if (e.key === "Enter") {
      e.preventDefault();
      choose(at);
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (busy !== null) return;
      if (naming) {
        setNaming(false);
        setQuery("");
        setPicked(0);
      } else close();
    }
  };

  const right = (n: number, text?: string) =>
    busy === n ? <Spinner className="w-[1ch] shrink-0" /> : text && <span className="truncate text-muted-foreground">{text}</span>;

  return (
    <Palette title="Open project" onClose={() => busy === null && close()}>
      <Search
        ref={input}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setPicked(0);
        }}
        onKeyDown={onKeyDown}
        placeholder={naming ? "Name or path" : "Search projects"}
        disabled={busy !== null}
      />
      {error && <div className="px-[16px] pb-[6px] text-destructive">{error}</div>}
      <ul className="max-h-[50vh] overflow-y-auto px-[6px] pb-[6px]">
        {!naming && (
          <>
            {projects.map((p, n) => (
              <Row key={p.key} picked={n === at} onMouseMove={() => n !== at && setPicked(n)} onClick={() => choose(n)}>
                <span className="shrink-0 truncate">{p.name}</span>
                {right(n, p.where ?? (p.remote && short(p.remote)))}
              </Row>
            ))}
            {!listed && (
              <li className="flex h-[32px] items-center px-[10px]">
                <Spinner className="w-[1ch]" />
              </li>
            )}
            {listed?.error && <li className="px-[10px] py-[7px] text-destructive">{listed.error}</li>}
            {listed && !listed.error && !projects.length && (
              <li className="px-[10px] py-[7px] text-muted-foreground">{query ? "No projects match" : "No projects yet"}</li>
            )}
          </>
        )}
        <Row
          picked={at === count - 1}
          onMouseMove={() => at !== count - 1 && setPicked(count - 1)}
          onClick={() => choose(count - 1)}
        >
          <span className="shrink-0 truncate">{named ? `New project ${named.split("/").pop()}` : "New project"}</span>
          {right(count - 1, named ? newPath : undefined)}
        </Row>
      </ul>
    </Palette>
  );
}

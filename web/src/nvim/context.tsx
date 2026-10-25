// What the components call Neovim with, from one connection made in
// main.tsx.

import { createContext, useContext } from "react";
import type { Rpc } from "./rpc.js";

export type Nvim = {
  rpc: Rpc;
  lua: (code: string, ...args: unknown[]) => Promise<any>;
  notify: (method: string, ...params: unknown[]) => void;
  blob: (path: string, version?: unknown) => Promise<string>;
  openFile: (path: string, tab?: boolean) => void;
  // Keyboard focus back to the canvas, and so to Neovim.
  refocus: () => void;
};

export function makeNvim(rpc: Rpc): Nvim {
  const lua = (code: string, ...args: unknown[]) =>
    rpc.request("nvim_exec_lua", code, args).catch((err: unknown) => console.error("lua:", err));

  // A file's bytes from Neovim (corkboard.viewer.read) as a blob URL, which
  // works the same when Neovim is on another machine. One version per path
  // is kept; a newer one (the file changed) replaces it.
  const blobs = new Map<string, { version: unknown; url: Promise<string> }>();
  const blob = (path: string, version?: unknown) => {
    const cached = blobs.get(path);
    if (cached && cached.version === version) return cached.url;
    cached?.url.then((url) => URL.revokeObjectURL(url), () => {});
    const url: Promise<string> = rpc
      .request("nvim_exec_lua", "return require('corkboard.viewer').read(...)", [path])
      .then(async ({ data, mime }: { data: string; mime?: string }) => {
        const res = await fetch(`data:${mime ?? "application/octet-stream"};base64,${data}`);
        return URL.createObjectURL(await res.blob());
      });
    url.catch(() => blobs.get(path)?.url === url && blobs.delete(path));
    blobs.set(path, { version, url });
    return url;
  };

  return {
    rpc,
    lua,
    notify: (method, ...params) => rpc.notify(method, ...params),
    blob,
    openFile: (path, tab = false) => void lua("require('corkboard').open_file(...)", path, tab),
    refocus: () => document.querySelector<HTMLCanvasElement>("#editor canvas")?.focus(),
  };
}

export const NvimContext = createContext<Nvim | null>(null);

export function useNvim(): Nvim {
  const nvim = useContext(NvimContext);
  if (!nvim) throw new Error("useNvim outside NvimContext");
  return nvim;
}

// Clicks act, but keyboard focus stays with the canvas (and Neovim).
export const keepFocus = (e: React.MouseEvent) => e.preventDefault();

// The files agents attached to this session's cards, and the ones it showed
// (corkboard.claude.cards' media panel), under its cards: the list, newest first, and the selected
// file below it. Images, video, audio, PDFs and text show here; anything
// else is a download. Each comes from the bridge's /media once, as a blob.
// Below them, the files on no card, kept on the leader (the bridge's
// /files): the page's own to list, pick, send (+, or dropped here) and delete.

import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import type { Nvim } from "@/nvim/context";
import type { ViewProps } from "./index";

// A card's file has the bridge's url; one the session showed from Neovim's
// machine, its path there.
type MediaFile = {
  key: string;
  url?: string;
  path?: string;
  mtime?: number;
  card?: string;
  name: string;
  type: string;
  size: number;
  at: string;
  who: string;
};
type MediaState = { files?: MediaFile[]; selected?: string };
type Kept = { id: string; name: string; type: string; size: number; at: string; who: string };

const kept = (f: Kept): MediaFile => ({ ...f, key: `kept:${f.id}`, url: `files/${f.id}` });

// The leader's files, looked at again every half minute while the panel's open.
function useKept(nvim: Nvim) {
  const [files, setFiles] = useState<MediaFile[]>([]);
  const [error, setError] = useState<string>();
  const look = useCallback(async () => {
    try {
      const res = await nvim.bridge("files");
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `${res.status}`);
      setFiles(((await res.json()) as Kept[]).map(kept));
      setError(undefined);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [nvim]);
  useEffect(() => {
    void look();
    const t = setInterval(look, 30_000);
    return () => clearInterval(t);
  }, [look]);
  const send = async (list: Iterable<File>) => {
    for (const f of list) {
      const q = new URLSearchParams({ name: f.name, ...(f.type && { type: f.type }) });
      const res = await nvim.bridge(`files?${q}`, { method: "PUT", body: f });
      if (!res.ok) setError(`${f.name}: ${(await res.json().catch(() => ({}))).error ?? res.status}`);
    }
    await look();
  };
  const drop = async (f: MediaFile) => {
    await nvim.bridge(f.url!, { method: "DELETE" });
    await look();
  };
  return { files, error, send, drop };
}

export function Media({ state, win, focused, nvim }: ViewProps<MediaState>) {
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const leader = useKept(nvim);
  const [mine, setMine] = useState<string>();
  const [over, setOver] = useState(false);
  const files = [...(state.files ?? []), ...leader.files];
  const file = files.find((f) => f.key === (mine ?? state.selected)) ?? files[0];
  const pick = (key: string) => {
    if (key.startsWith("kept:")) return setMine(key);
    setMine(undefined);
    nvim.lua("require('corkboard.claude.cards').pick(...)", win, key);
  };

  useEffect(() => {
    list.current?.querySelector("[data-selected]")?.scrollIntoView({ block: "nearest" });
  }, [state.selected, mine]);
  useEffect(() => setMine(undefined), [state.selected]);

  return (
    <div
      className={cn("flex h-full flex-col", over && "bg-accent")}
      onDragOver={(e) => e.dataTransfer.types.includes("Files") && (e.preventDefault(), setOver(true))}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        setOver(false);
        void leader.send([...e.dataTransfer.files]);
      }}
    >
      <h2 className="flex flex-none gap-ch px-2ch pt-row">
        <span>
          files <span className="text-muted-foreground">{files.length}</span>
        </span>
        <span className="flex-1" />
        <button type="button" onClick={() => input.current?.click()} className="cursor-pointer text-muted-foreground hover:text-foreground">
          +
        </button>
        <input ref={input} type="file" multiple hidden onChange={(e) => (void leader.send([...(e.target.files ?? [])]), (e.target.value = ""))} />
      </h2>
      {leader.error && <div className="flex-none truncate px-2ch text-muted-foreground">{leader.error}</div>}
      <div ref={list} className="max-h-[calc(var(--cell-h)*4)] flex-none overflow-y-auto px-2ch pt-half pb-half">
        {files.map((f) => (
          <div
            key={f.key}
            data-selected={f.key === file?.key || undefined}
            onClick={() => pick(f.key)}
            className={cn(
              "flex cursor-pointer gap-ch px-ch hover:bg-accent",
              f.key === file?.key && "bg-selection hover:bg-selection",
              f.key === file?.key && focused && "font-bold",
            )}
          >
            <span className="min-w-0 flex-1 truncate">{f.name}</span>
            <span className="flex-none text-muted-foreground tabular-nums">{size(f.size)}</span>
          </div>
        ))}
        {!files.length && <div className="px-ch text-border">—</div>}
      </div>
      {file && <Shown key={file.key} file={file} nvim={nvim} drop={file.key.startsWith("kept:") ? () => void leader.drop(file) : undefined} />}
    </div>
  );
}

function Shown({ file, nvim, drop }: { file: MediaFile; nvim: Nvim; drop?: () => void }) {
  const [blob, setBlob] = useState<{ url?: string; text?: string; error?: string }>({});
  useEffect(() => {
    let live = true;
    (file.path ? nvim.blob(file.path, file.mtime) : nvim.media(file.url ?? "")).then(
      async (url) => {
        const text = textual(file.type) ? await (await fetch(url)).text() : undefined;
        if (live) setBlob({ url, text });
      },
      // Neovim's errors arrive as [type, message].
      (err) => live && setBlob({ error: `could not read: ${err?.[1] ?? err?.message ?? err}` }),
    );
    return () => void (live = false);
  }, [file.key]);

  // Video, audio and PDFs take keyboard focus when clicked; it goes back to
  // Neovim when the pointer leaves.
  const refocus = () => ["VIDEO", "AUDIO", "IFRAME"].includes(document.activeElement?.tagName ?? "") && nvim.refocus();
  const kind = file.type.split("/")[0];
  let body: React.ReactNode;
  if (blob.error) body = <div className="p-ch text-muted-foreground">{blob.error}</div>;
  else if (!blob.url) body = <div className="p-ch text-muted-foreground">{file.name}…</div>;
  else if (kind === "image")
    body = (
      <div className="checkerboard grid size-full cursor-zoom-in place-items-center overflow-hidden" onClick={() => window.open(blob.url, "_blank", "noopener")}>
        <img src={blob.url} alt={file.name} draggable={false} className="max-h-full max-w-full object-contain" />
      </div>
    );
  else if (kind === "video") body = <video src={blob.url} controls autoPlay muted playsInline className="size-full bg-black object-contain" />;
  else if (kind === "audio")
    body = (
      <div className="grid size-full place-items-center px-2ch">
        <audio src={blob.url} controls className="w-full" />
      </div>
    );
  else if (file.type === "application/pdf") body = <iframe title={file.name} src={blob.url} className="block size-full border-0 bg-background" />;
  else if (blob.text !== undefined) body = <pre className="size-full overflow-auto px-2ch whitespace-pre-wrap">{blob.text}</pre>;
  else
    body = (
      <div className="grid size-full place-items-center">
        <a href={blob.url} download={file.name} className="hover:underline">
          ↓ {file.name}
        </a>
      </div>
    );

  return (
    <>
      <div className="min-h-0 flex-1 border-t" onMouseLeave={refocus}>
        {body}
      </div>
      <div className="flex flex-none gap-ch border-t px-ch text-muted-foreground">
        <span className="min-w-0 flex-1 truncate">{[file.card, file.who, when(file.at)].filter(Boolean).join(" · ")}</span>
        {drop && (
          <button type="button" onClick={drop} className="flex-none cursor-pointer hover:text-foreground">
            ×
          </button>
        )}
      </div>
    </>
  );
}

const textual = (type: string) => type.startsWith("text/") || type === "application/json";

function when(at: string) {
  const d = new Date(at);
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function size(bytes: number) {
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) (bytes /= 1024), i++;
  return i ? `${bytes.toFixed(1)} ${units[i]}` : `${bytes} B`;
}

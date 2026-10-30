// The files agents attached to this session's cards (corkboard.claude.cards'
// media panel), under its cards: the list, newest first, and the selected
// file below it. Images, video, audio, PDFs and text show here; anything
// else is a download. Each comes from the bridge's /media once, as a blob.

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import type { Nvim } from "@/nvim/context";
import type { ViewProps } from "./index";

type MediaFile = { key: string; url: string; card: string; name: string; type: string; size: number; at: string; who: string };
type MediaState = { files?: MediaFile[]; selected?: string };

export function Media({ state, win, focused, nvim }: ViewProps<MediaState>) {
  const list = useRef<HTMLDivElement>(null);
  const files = state.files ?? [];
  const file = files.find((f) => f.key === state.selected) ?? files[0];
  const pick = (key: string) => nvim.lua("require('corkboard.claude.cards').pick(...)", win, key);

  useEffect(() => {
    list.current?.querySelector("[data-selected]")?.scrollIntoView({ block: "nearest" });
  }, [state.selected]);

  return (
    <div className="flex h-full flex-col">
      <h2 className="flex-none px-2ch pt-row">
        files <span className="text-muted-foreground">{files.length}</span>
      </h2>
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
      {file && <Shown key={file.key} file={file} nvim={nvim} />}
    </div>
  );
}

function Shown({ file, nvim }: { file: MediaFile; nvim: Nvim }) {
  const [blob, setBlob] = useState<{ url?: string; text?: string; error?: string }>({});
  useEffect(() => {
    let live = true;
    nvim.media(file.url).then(
      async (url) => {
        const text = textual(file.type) ? await (await fetch(url)).text() : undefined;
        if (live) setBlob({ url, text });
      },
      (err) => live && setBlob({ error: `could not read: ${err?.message ?? err}` }),
    );
    return () => void (live = false);
  }, [file.url]);

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
      <div className="flex-none truncate border-t px-ch text-muted-foreground">
        {file.card} · {file.who} · {when(file.at)}
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

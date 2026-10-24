// Panels for files Neovim shows as views (corkboard.viewer): an image, a
// PDF, and the rendered side of a markdown file.
//
// A panel renders again on every layout and state change, so each viewer
// fetches and rebuilds only when its file changes: reloading a PDF or
// rebuilding a long document on every cursor move would flicker and lose
// its scroll.

import DOMPurify from "dompurify";
import { marked } from "marked";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import type { Nvim } from "@/nvim/context";
import type { ViewProps } from "./index";

type FileState = { path: string; name: string; mtime?: number; size?: number; error?: string };

// A file's blob URL, or the error reading it; fetched again only when the
// path or mtime changes.
function useBlob(nvim: Nvim, state: FileState) {
  const [result, setResult] = useState<{ key: string; url?: string; error?: string } | null>(null);
  const key = `${state.path}@${state.mtime}`;
  useEffect(() => {
    if (state.error) return;
    let live = true;
    nvim.blob(state.path, state.mtime).then(
      (url) => live && setResult({ key, url }),
      // Neovim's errors arrive as [type, message].
      (err) => live && setResult({ key, error: `could not read: ${err?.[1] ?? err?.message ?? err}` }),
    );
    return () => void (live = false);
  }, [key]);
  return result?.key === key ? result : null;
}

function Message({ children }: { children: React.ReactNode }) {
  return <div className="p-4 text-muted-foreground">{children}</div>;
}

// Images ------------------------------------------------------------------------

// Fitted to the panel; a click toggles actual size, scrolling if it is larger.
export function ImageView({ state, nvim }: ViewProps<FileState>) {
  const blob = useBlob(nvim, state);
  const [actual, setActual] = useState(false);
  const [natural, setNatural] = useState<[number, number] | null>(null);
  if (state.error) return <Message>{state.name}: {state.error}</Message>;
  if (blob?.error) return <Message>{blob.error}</Message>;
  return (
    <div className="flex h-full flex-col">
      <div
        onClick={() => setActual(!actual)}
        className={cn(
          "checkerboard grid min-h-0 flex-1",
          actual ? "cursor-zoom-out place-items-start overflow-auto" : "cursor-zoom-in place-items-center overflow-hidden",
        )}
      >
        {blob?.url && (
          <img
            src={blob.url}
            alt={state.name}
            draggable={false}
            onLoad={(e) => setNatural([e.currentTarget.naturalWidth, e.currentTarget.naturalHeight])}
            className={actual ? "max-w-none" : "max-h-full max-w-full object-contain"}
          />
        )}
      </div>
      <div className="flex-none truncate border-t px-ch text-muted-foreground">
        {natural ? `${state.name} · ${natural[0]}×${natural[1]} · ${size(state.size)}` : state.name}
      </div>
    </div>
  );
}

// PDFs --------------------------------------------------------------------------

// The browser's own PDF viewer, in a frame. It takes keyboard focus when
// clicked, so focus goes back to Neovim when the pointer leaves the panel.
export function PdfView({ state, nvim }: ViewProps<FileState>) {
  const blob = useBlob(nvim, state);
  if (state.error) return <Message>{state.name}: {state.error}</Message>;
  if (blob?.error) return <Message>{blob.error}</Message>;
  if (!blob?.url) return <Message>Loading {state.name}…</Message>;
  return (
    <iframe
      title={state.name}
      src={blob.url}
      className="block size-full border-0 bg-background"
      onMouseLeave={() => document.activeElement?.tagName === "IFRAME" && nvim.refocus()}
    />
  );
}

// Markdown ----------------------------------------------------------------------

// Relative image paths are resolved against the markdown file and fetched
// from Neovim, so the page never asks the bridge for them (it would serve
// its own files, or nothing). Done while sanitizing, before any <img>
// exists in this document to start loading.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "IMG" && node.hasAttribute("src") && !isUrl(node.getAttribute("src")!)) {
    node.setAttribute("data-src", node.getAttribute("src")!);
    node.removeAttribute("src");
  }
});

type MarkdownState = { path: string; text?: string; topline?: number };

// Each top-level block is wrapped with the source line it starts on, which
// is what scrolling follows: Neovim sends the source window's top line, and
// the preview puts that line's block (or the right part of it) at the top.
export function MarkdownView({ state, nvim }: ViewProps<MarkdownState>) {
  const scroller = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLElement>(null);
  const topline = useRef(state.topline);
  topline.current = state.topline;
  const html = useMemo(() => (state.text == null ? null : DOMPurify.sanitize(blocks(state.text))), [state.text]);

  // New text: its images are fetched, each scrolling again as it arrives
  // since its height moves everything below.
  useLayoutEffect(() => {
    const md = body.current;
    if (!md || html == null) return;
    const dir = dirname(state.path);
    for (const img of md.querySelectorAll<HTMLImageElement>("img[data-src]")) {
      const src = decodeURI(img.dataset.src!.split(/[?#]/)[0]);
      nvim.blob(join(dir, src)).then(
        (url) => {
          img.src = url;
          img.addEventListener("load", () => scrollTo(scroller.current!, md, topline.current), { once: true });
        },
        () => {
          const missing = document.createElement("span");
          missing.className = "missing";
          missing.textContent = `[${img.alt || src}]`;
          img.replaceWith(missing);
        },
      );
    }
  }, [html]);

  useLayoutEffect(() => {
    if (scroller.current && body.current) scrollTo(scroller.current, body.current, state.topline);
  }, [html, state.topline]);

  // A link in the preview never navigates the page: a web link opens in a
  // new tab, #anchor scrolls the preview, and a path opens that file in
  // Neovim.
  const follow = (e: React.MouseEvent) => {
    const a = (e.target as Element).closest("a[href]");
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute("href")!;
    if (href.startsWith("#")) {
      body.current?.querySelector(`[id="${CSS.escape(decodeURIComponent(href.slice(1)))}"]`)?.scrollIntoView();
    } else if (isUrl(href)) {
      if (/^(https?|mailto):/i.test(href)) window.open(href, "_blank", "noopener");
    } else {
      nvim.openFile(join(dirname(state.path), decodeURI(href.split(/[?#]/)[0])));
    }
  };

  return (
    <div ref={scroller} className="relative h-full overflow-y-auto px-6">
      {/* Kept across renders without text (a scroll), which keep the last. */}
      <article ref={body} onClick={follow} className="markdown-body" dangerouslySetInnerHTML={html == null ? undefined : { __html: html }} />
    </div>
  );
}

function blocks(text: string) {
  const tokens = marked.lexer(text, { gfm: true });
  const html: string[] = [];
  let line = 0;
  for (const token of tokens) {
    const lines = (token.raw.match(/\n/g) ?? []).length;
    if (token.type !== "space" && token.type !== "def") {
      const rendered = marked.parser(Object.assign([token], { links: tokens.links }), { gfm: true });
      html.push(`<div data-line="${line}" data-lines="${Math.max(1, lines)}">${rendered}</div>`);
    }
    line += lines;
  }
  return html.join("");
}

function scrollTo(scroller: HTMLElement, body: HTMLElement, topline?: number) {
  const target = (topline ?? 1) - 1;
  let block: HTMLElement | null = null;
  for (const child of body.children as HTMLCollectionOf<HTMLElement>) {
    if (Number(child.dataset.line) > target) break;
    block = child;
  }
  if (!block || target <= 0) return void (scroller.scrollTop = 0);
  const within = Math.min(1, (target - Number(block.dataset.line)) / Number(block.dataset.lines));
  scroller.scrollTop = block.offsetTop + within * block.offsetHeight;
}

// Helpers -------------------------------------------------------------------------

const isUrl = (s: string) => /^[a-z][a-z0-9+.-]*:/i.test(s);

const dirname = (path: string) => path.slice(0, path.lastIndexOf("/")) || "/";

function join(dir: string, rel: string) {
  const parts = rel.startsWith("/") ? [] : dir.split("/");
  for (const part of rel.split("/")) {
    if (part === "..") parts.pop();
    else if (part && part !== ".") parts.push(part);
  }
  return "/" + parts.filter(Boolean).join("/");
}

function size(bytes?: number) {
  if (bytes == null) return "?";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) (bytes /= 1024), i++;
  return i ? `${bytes.toFixed(1)} ${units[i]}` : `${bytes} B`;
}

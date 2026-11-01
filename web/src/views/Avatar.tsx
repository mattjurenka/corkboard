// A face for a Claude Code session (corkboard.avatar's panel): a VRM model
// that says each new thing Claude writes, out loud, with its words typed out
// under it as they're said, in Kokoro's voice, pitched up. What
// was said before the panel opened isn't said again. A .vrm file dropped
// on it is the model from then on, in this browser; until then it's
// avatar.vrm (ryo73's "haruto 5" from VRoid Hub: anyone may use, change and
// share it, credit unnecessary). three.js comes with the first panel, not
// the page.

import { useEffect, useRef, useState } from "react";
import { Spinner } from "@/components/Spinner";
import { cn } from "@/lib/utils";
import type { Mood, Stage } from "@/avatar/stage";
import { line as quip, type Poked } from "@/avatar/tsundere";
import { Voice } from "@/avatar/voice";
import { useNvim } from "@/nvim/context";
import type { ViewProps } from "./index";

type Said = { id: string; text: string };
type AvatarState = { said?: Said[]; state?: string; muted?: boolean; skip?: number };

const SAMPLE = new URL("avatar.vrm", location.href).href;

const mood = (state?: string): Mood =>
  state === "working" || state === "starting" || state === "background" ? "thinking" : state === "asking" || state === "permission" ? "asking" : "idle";

export function Avatar({ state }: ViewProps<AvatarState>) {
  const nvim = useNvim();
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const stage = useRef<Stage>(null);
  const voice = useRef<Voice>(null);
  const seen = useRef<Set<string>>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [line, setLine] = useState({ text: "", at: 0, speaking: false });
  const clicks = useRef<number[]>([]);

  voice.current ??= new Voice(nvim.bridge);

  // The stage, and the model on it.
  useEffect(() => {
    let live = true;
    const sizes = new ResizeObserver(() => box.current && stage.current?.resize(box.current.clientWidth, box.current.clientHeight));
    const v = voice.current!;
    v.voice = "anime";
    // The last line stays as it fades.
    v.onChange = () => setLine((l) => (v.speaking ? { text: v.text, at: v.at(), speaking: true } : { ...l, at: l.text.length, speaking: false }));
    import("@/avatar/stage").then(async ({ Stage }) => {
      if (!live || !canvas.current) return;
      const s = new Stage(canvas.current, v);
      stage.current = s;
      const fit = () => box.current && s.resize(box.current.clientWidth, box.current.clientHeight);
      sizes.observe(box.current!);
      fit();
      try {
        await s.load((await saved()) ?? SAMPLE);
      } catch (e) {
        if (live) setError(String((e as Error).message ?? e));
      }
      if (live) setLoading(false);
    });
    return () => {
      live = false;
      sizes.disconnect();
      v.onChange = undefined;
      v.stop();
      stage.current?.dispose();
    };
  }, []);

  // Each new thing said, said.
  useEffect(() => {
    const said = Array.isArray(state.said) ? state.said : [];
    if (!seen.current) {
      seen.current = new Set(said.map((s) => s.id));
      return;
    }
    for (const s of said) {
      if (seen.current.has(s.id)) continue;
      seen.current.add(s.id);
      voice.current!.say(s.text, s.id);
    }
  }, [state.said]);

  useEffect(() => {
    if (stage.current) stage.current.mood = mood(state.state);
  });
  useEffect(() => {
    voice.current!.muted = !!state.muted;
  }, [state.muted]);
  useEffect(() => {
    if (state.skip) voice.current!.stop();
  }, [state.skip]);

  // The words typed out as they're said, a frame at a time.
  useEffect(() => {
    if (!line.speaking) return;
    let frame = 0;
    const tick = () => {
      frame = requestAnimationFrame(tick);
      const at = voice.current!.at();
      setLine((l) => (Math.floor(at) === Math.floor(l.at) ? l : { ...l, at }));
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, [line.speaking, line.text]);

  const drop = async (e: React.DragEvent) => {
    const file = [...e.dataTransfer.files].find((f) => /\.vrm$/i.test(f.name));
    if (!file) return;
    e.preventDefault();
    const data = await file.arrayBuffer();
    setLoading(true);
    setError("");
    try {
      await stage.current?.load(data.slice(0));
      await save(data);
    } catch (err) {
      setError(String((err as Error).message ?? err));
    }
    setLoading(false);
  };

  // The pointer, in the camera's terms.
  const at = (e: React.PointerEvent | React.MouseEvent) => {
    const r = canvas.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * 2 - 1, y: -((e.clientY - r.top) / r.height) * 2 + 1 };
  };
  // Clicked: she reacts, and unless she's busy saying something, says so.
  const poke = (e: React.MouseEvent) => {
    const s = stage.current;
    if (!s) return;
    const now = performance.now();
    clicks.current = [...clicks.current.filter((c) => now - c < 6000), now];
    const hit = s.hit(at(e));
    const poked: Poked = clicks.current.length >= 4 ? "again" : (hit ?? "miss");
    if (poked === "head") s.play("pat", "snub");
    else if (poked === "miss") s.play("snub");
    else s.play("flinch", "huff");
    if (poked === "again") clicks.current = [];
    const v = voice.current!;
    if (!v.speaking) v.say(quip(poked), `poke:${now}`);
  };

  const voiceError = voice.current.error;
  const shown = line.text.slice(0, Math.ceil(line.at));
  return (
    <div
      ref={box}
      className="relative h-full"
      onDragOver={(e) => e.preventDefault()}
      onDrop={drop}
      onPointerMove={(e) => stage.current?.point(at(e))}
      onPointerLeave={() => stage.current?.point(null)}
      onClick={poke}
    >
      <canvas ref={canvas} className="absolute inset-0 size-full" />
      {loading && <Spinner className="absolute inset-0" />}
      {(error || voiceError) && <div className="absolute inset-x-0 top-0 px-2ch pt-row text-blocked">{error || voiceError}</div>}
      {state.muted && <div className="absolute top-0 right-0 px-2ch pt-row text-muted-foreground">muted</div>}
      <div
        className={cn(
          "absolute inset-x-0 bottom-0 min-h-[calc(var(--cell-h)*3)] border-t bg-background/85 px-2ch py-half transition-opacity duration-700",
          line.speaking ? "opacity-100" : "opacity-0",
        )}
      >
        {shown}
        <span className="text-muted-foreground">{line.text.slice(shown.length)}</span>
      </div>
    </div>
  );
}

// The model dropped on a panel, kept in this browser.
const DB = "corkboard-avatar";
function db(): Promise<IDBDatabase> {
  return new Promise((ok, fail) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore("model");
    r.onsuccess = () => ok(r.result);
    r.onerror = () => fail(r.error);
  });
}
async function saved(): Promise<ArrayBuffer | undefined> {
  try {
    const d = await db();
    return await new Promise((ok) => {
      const r = d.transaction("model").objectStore("model").get("vrm");
      r.onsuccess = () => ok(r.result);
      r.onerror = () => ok(undefined);
    });
  } catch {
    return undefined;
  }
}
async function save(data: ArrayBuffer) {
  try {
    const d = await db();
    d.transaction("model", "readwrite").objectStore("model").put(data, "vrm");
  } catch {}
}

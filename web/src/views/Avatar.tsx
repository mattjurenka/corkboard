// A face for a Claude Code session (corkboard.avatar's panel): a VRM model
// that says each new thing Claude says (with the mod's say tool), out loud,
// with its words typed out under it as they're said, in Kokoro's voice,
// pitched up. What
// was said before the panel opened isn't said again. It's the session's
// brain's persona (avatar/personas.ts): its model, voice and lines. A .vrm
// file dropped on it is that persona's model from then on, in this
// browser. The models: tsundere.vrm (a blonde in a school uniform, made in
// VRoid Studio for corkboard), bikini.vrm, businesswoman.vrm (the same
// girl with a suit painted on her), nerd.vrm, businessman.vrm and
// shirtless.vrm. three.js comes with the first panel, not the page.

import { useEffect, useRef, useState } from "react";
import { Spinner } from "@/components/Spinner";
import { cn } from "@/lib/utils";
import { persona as personaOf, line as quip, type Poked } from "@/avatar/personas";
import type { Mood, Stage } from "@/avatar/stage";
import { isMood, Voice } from "@/avatar/voice";
import { useNvim } from "@/nvim/context";
import type { ViewProps } from "./index";

type Said = { id: string; text: string; mood?: string };
type AvatarState = { said?: Said[]; state?: string; muted?: boolean; skip?: number; persona?: string };

const mood = (state?: string): Mood =>
  state === "working" || state === "starting" || state === "background" ? "thinking" : state === "asking" || state === "permission" ? "asking" : "idle";

export function Avatar({ state }: ViewProps<AvatarState>) {
  const nvim = useNvim();
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const marks = useRef<HTMLCanvasElement>(null);
  const stage = useRef<Stage>(null);
  const voice = useRef<Voice>(null);
  const seen = useRef<Set<string>>(null);
  const [loading, setLoading] = useState(true);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [line, setLine] = useState({ text: "", at: 0, speaking: false });
  const clicks = useRef<number[]>([]);
  // The left button held down: where it is, whether it went down on her
  // head, how far it has moved since, and whether that's been a pat.
  const press = useRef<{ x: number; y: number; head: boolean; moved: number; patted: boolean }>(null);
  // Models load one after another, so the last persona asked for is the one on stage.
  const loads = useRef<Promise<void>>(Promise.resolve());
  const persona = personaOf(state.persona);

  voice.current ??= new Voice(nvim.bridge);

  // The stage.
  useEffect(() => {
    let live = true;
    const sizes = new ResizeObserver(() => box.current && stage.current?.resize(box.current.clientWidth, box.current.clientHeight));
    const v = voice.current!;
    // The last line stays as it fades.
    v.onChange = () => setLine((l) => (v.speaking ? { text: v.text, at: v.at(), speaking: true } : { ...l, at: l.text.length, speaking: false }));
    import("@/avatar/stage").then(async ({ Stage }) => {
      if (!live || !canvas.current) return;
      const s = new Stage(canvas.current, v, marks.current ?? undefined);
      stage.current = s;
      const fit = () => box.current && s.resize(box.current.clientWidth, box.current.clientHeight);
      sizes.observe(box.current!);
      fit();
      setReady(true);
    });
    return () => {
      live = false;
      sizes.disconnect();
      v.onChange = undefined;
      v.stop();
      stage.current?.dispose();
    };
  }, []);

  // The persona on it: her model (or the one dropped for her), voice and ways.
  useEffect(() => {
    const s = stage.current;
    if (!ready || !s) return;
    const key = `vrm:${persona.title}`;
    voice.current!.voice = persona.voice;
    s.idle = persona.idle;
    setLoading(true);
    setError("");
    loads.current = loads.current.then(async () => {
      try {
        const own = await saved(key);
        await (own ? s.load(own) : s.load(new URL(persona.model, location.href).href, persona.recolor));
      } catch (e) {
        setError(String((e as Error).message ?? e));
      }
      setLoading(false);
    });
  }, [ready, persona]);

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
      voice.current!.say(s.text, s.id, isMood(s.mood) ? s.mood : undefined);
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
      await save(`vrm:${persona.title}`, data);
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
  // Unless she's busy saying something, she says so.
  const say = (poked: Poked, now: number) => {
    const v = voice.current!;
    if (!v.speaking) v.say(quip(persona, poked), `poke:${now}`, persona.poked[poked].tone);
  };
  const down = (e: React.PointerEvent) => {
    if (e.button !== 0 || !stage.current) return;
    press.current = { x: e.clientX, y: e.clientY, head: stage.current.hit(at(e)) === "head", moved: 0, patted: false };
  };
  // Held down on her head and rubbed a little: a pat.
  const move = (e: React.PointerEvent) => {
    const s = stage.current;
    s?.point(at(e));
    const p = press.current;
    if (!s || !p || !(e.buttons & 1)) return;
    p.moved += Math.hypot(e.clientX - p.x, e.clientY - p.y);
    p.x = e.clientX;
    p.y = e.clientY;
    if (!p.head || p.patted || p.moved < 16) return;
    p.patted = true;
    s.touch("pat", at(e));
    s.play(...persona.poked.pat.acts);
    say("pat", performance.now());
  };
  // Clicked: she reacts.
  const poke = (e: React.MouseEvent) => {
    const s = stage.current;
    const p = press.current;
    press.current = null;
    if (!s || p?.patted) return;
    const now = performance.now();
    clicks.current = [...clicks.current.filter((c) => now - c < 6000), now];
    const where = at(e);
    const poked: Poked = clicks.current.length >= 4 ? "again" : (s.hit(where) ?? "miss");
    s.touch("poke", where);
    s.play(...persona.poked[poked].acts);
    if (poked === "again") clicks.current = [];
    say(poked, now);
  };

  const voiceError = voice.current.error;
  const shown = line.text.slice(0, Math.ceil(line.at));
  return (
    <div
      ref={box}
      className="relative h-full"
      onDragOver={(e) => e.preventDefault()}
      onDrop={drop}
      onPointerDown={down}
      onPointerMove={move}
      onPointerLeave={() => stage.current?.point(null)}
      onClick={poke}
    >
      <canvas ref={canvas} className="absolute inset-0 size-full" />
      <canvas ref={marks} className="pointer-events-none absolute inset-0 size-full" />
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

// The model dropped on a panel for a persona, kept in this browser.
const DB = "corkboard-avatar";
function db(): Promise<IDBDatabase> {
  return new Promise((ok, fail) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore("model");
    r.onsuccess = () => ok(r.result);
    r.onerror = () => fail(r.error);
  });
}
async function saved(key: string): Promise<ArrayBuffer | undefined> {
  try {
    const d = await db();
    return await new Promise((ok) => {
      const r = d.transaction("model").objectStore("model").get(key);
      r.onsuccess = () => ok(r.result);
      r.onerror = () => ok(undefined);
    });
  } catch {
    return undefined;
  }
}
async function save(key: string, data: ArrayBuffer) {
  try {
    const d = await db();
    d.transaction("model", "readwrite").objectStore("model").put(data, key);
  } catch {}
}

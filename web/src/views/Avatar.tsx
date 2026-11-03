// A face for a Claude Code session (corkboard.avatar's panel): a VRM model
// that says each new thing Claude says (with the mod's say tool), out loud,
// with its words typed out under it as they're said, in Kokoro's voice,
// pitched up. What
// was said before the panel opened isn't said again. It's the session's
// brain's persona (avatar/personas.ts): its model, voice and lines. A .vrm
// file dropped on it is that persona's model from then on, in this
// browser. A treat from the menu at its top left, dragged to her mouth, is
// eaten. Asked to show off (:Avatar demo, or d in it), each persona asked
// for in turn says its intro, has its head patted, is poked twice and is
// fed. The models: tsundere.vrm (a blonde in a frilly black dress, made in
// VRoid Studio for corkboard), bikini.vrm, businesswoman.vrm (in a
// suit, also made in VRoid Studio), nerd.vrm, businessman.vrm,
// shirtless.vrm, alien-2.vrm, diva-3.vrm and valkyrie.vrm (Terry borrows
// the nerd's for now); all but the
// businesswoman and businessman are fetched from corkboard.fyi the first
// time they're on (modelAt). three.js comes with the first panel, not the page.

import { useEffect, useRef, useState } from "react";
import { Spinner } from "@/components/Spinner";
import { cn } from "@/lib/utils";
import { modelAt, persona as personaOf, POKED, line as quip, upcoming, type Poked } from "@/avatar/personas";
import { ACTS, type ActName } from "@/avatar/acts";
import type { Mood, Stage } from "@/avatar/stage";
import { type Bridge, isMood, Voice } from "@/avatar/voice";
import { useNvim } from "@/nvim/context";
import type { ViewProps } from "./index";

// A thing said, or (emote) done.
type Said = { id: string; text?: string; mood?: string; emote?: string };
type Treat = "cheesecake" | "cookie" | "muffin";
const TREATS: Treat[] = ["cheesecake", "cookie", "muffin"];

// A demo asked for: its count, and the personas to show, else its own.
type Demo = { n: number; of?: string[] | null };
type AvatarState = { said?: Said[]; state?: string; muted?: boolean; skip?: number; persona?: string; skin?: string | null; demo?: Demo | null };

const mood = (state?: string): Mood =>
  state === "working" || state === "starting" || state === "background" ? "thinking" : state === "asking" || state === "permission" ? "asking" : "idle";

// A panel's stage, its canvases and its voice, by its buffer, kept from
// when its tab is left until it's back: making them again and loading the
// model onto them is a second or more of spinner. Its loop is paused
// meanwhile. Past KEPT out of sight, the one unseen longest goes, each
// being one of the browser's few WebGL contexts.
type Kept = {
  canvas: HTMLCanvasElement;
  marks: HTMLCanvasElement;
  voice: Voice;
  stage?: Stage;
  // What's on the stage (`${key}:${skin}`), and the loads to it, one after another.
  model?: string;
  loads: Promise<void>;
  shown: boolean;
  // The last demo run, by its count.
  demo?: number;
};
const kept = new Map<number, Kept>();
const KEPT = 4;

function keep(buf: number, bridge: Bridge): Kept {
  let k = kept.get(buf);
  if (!k) {
    const canvas = document.createElement("canvas");
    canvas.className = "absolute inset-0 size-full";
    const marks = document.createElement("canvas");
    marks.className = "pointer-events-none absolute inset-0 size-full";
    k = { canvas, marks, voice: new Voice(bridge), loads: Promise.resolve(), shown: false };
  }
  // Last in the map is the last seen.
  kept.delete(buf);
  kept.set(buf, k);
  return k;
}

function forget() {
  const hidden = [...kept].filter(([, k]) => !k.shown);
  for (const [buf, k] of hidden.slice(0, Math.max(0, hidden.length - KEPT))) {
    k.stage?.dispose();
    kept.delete(buf);
  }
}

export function Avatar({ state, buf }: ViewProps<AvatarState>) {
  const nvim = useNvim();
  const [k] = useState(() => keep(buf, nvim.bridge));
  const box = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(k.canvas);
  const stage = useRef<Stage>(k.stage ?? null);
  const voice = useRef<Voice>(k.voice);
  const seen = useRef<Set<string>>(null);
  const [loading, setLoading] = useState(!k.model);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [line, setLine] = useState({ text: "", at: 0, speaking: false });
  const clicks = useRef<number[]>([]);
  // The left button held down: where it is, whether it went down on her
  // head, how far it has moved since, and whether that's been a pat.
  const press = useRef<{ x: number; y: number; head: boolean; moved: number; patted: boolean }>(null);
  // The treats out, and the one being carried to her, where it is in the panel.
  const [treats, setTreats] = useState(false);
  const [held, setHeld] = useState<{ treat: Treat; x: number; y: number } | null>(null);
  // The persona being shown off by a demo, if not its own; and the demo
  // going on, by when it started (a new one, or s, ends it).
  const [showing, setShowing] = useState<string | null>(null);
  const run = useRef(0);
  const persona = personaOf(showing ?? state.persona);

  // The stage, kept or made.
  useEffect(() => {
    let live = true;
    k.shown = true;
    host.current!.append(k.canvas, k.marks);
    const sizes = new ResizeObserver(() => box.current && stage.current?.resize(box.current.clientWidth, box.current.clientHeight));
    const v = voice.current;
    // The last line stays as it fades.
    v.onChange = () => setLine((l) => (v.speaking ? { text: v.text, at: v.at(), speaking: true } : { ...l, at: l.text.length, speaking: false }));
    import("@/avatar/stage").then(async ({ Stage }) => {
      if (!live) return;
      const s = (k.stage ??= new Stage(k.canvas, v, k.marks));
      stage.current = s;
      s.resume();
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
      run.current++;
      k.stage?.pause();
      k.shown = false;
      forget();
    };
  }, []);

  // The persona on it: her model (or the one dropped for her), voice and ways.
  useEffect(() => {
    const s = stage.current;
    if (!ready || !s) return;
    const key = `vrm:${persona.title}`;
    voice.current.voice = persona.voice;
    voice.current.effect = persona.effect;
    s.idle = persona.idle;
    for (const p of POKED) voice.current.warm(upcoming(persona, p), persona.poked[p].tone);
    for (const l of persona.intro) voice.current.warm(l.text, l.tone);
    const skin = persona.ownSkin || (showing && showing !== state.persona) ? undefined : (state.skin ?? undefined);
    // Already on it, or on its way: a tab come back to.
    const model = `${key}:${skin ?? ""}`;
    if (k.model === model) {
      k.loads.then(() => setLoading(false));
      return;
    }
    k.model = model;
    setLoading(true);
    setError("");
    k.loads = k.loads.then(async () => {
      try {
        const own = await saved(key);
        const url = new URL(modelAt(persona), location.href).href;
        await (own ? s.load(own, false, skin) : s.load(persona.hosted ? await fetched(url) : url, persona.recolor, skin));
      } catch (e) {
        setError(String((e as Error).message ?? e));
      }
      setLoading(false);
    });
  }, [ready, persona, state.skin]);

  // Each new thing said, said.
  useEffect(() => {
    const said = Array.isArray(state.said) ? state.said : [];
    if (!seen.current) {
      seen.current = new Set(said.map((s) => s.id));
      return;
    }
    const acts: ActName[] = [];
    for (const s of said) {
      if (seen.current.has(s.id)) continue;
      seen.current.add(s.id);
      if (s.emote) {
        if (s.emote in ACTS) acts.push(s.emote as ActName);
      } else if (s.text) voice.current!.say(s.text, s.id, isMood(s.mood) ? s.mood : undefined);
    }
    // Several at once, one after another.
    if (acts.length) stage.current?.play(...acts);
  }, [state.said]);

  useEffect(() => {
    if (stage.current) stage.current.mood = mood(state.state);
  });
  useEffect(() => {
    voice.current!.muted = !!state.muted;
  }, [state.muted]);
  useEffect(() => {
    if (!state.skip) return;
    voice.current!.stop();
    run.current++;
    setShowing(null);
  }, [state.skip]);

  // A demo asked for: each persona's model on in turn, if it's not its own.
  useEffect(() => {
    const d = state.demo;
    if (!ready || !d || d.n === k.demo) return;
    k.demo = d.n;
    demo(Array.isArray(d.of) && d.of.length ? d.of : [state.persona ?? ""]);
  }, [ready, state.demo]);

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
  // Unless she's busy saying something, she says so, as she starts to
  // react; the next line for it is made ready.
  const say = (poked: Poked, now: number) => {
    const v = voice.current!;
    if (v.speaking) return;
    v.say(quip(persona, poked), `poke:${now}`, persona.poked[poked].tone);
    v.warm(upcoming(persona, poked), persona.poked[poked].tone);
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

  // A treat picked up, carried (her eyes on it, her mouth open when it's
  // there) and let go: eaten if it was at her mouth.
  const carry = (e: React.PointerEvent, treat?: Treat) => {
    e.stopPropagation();
    const r = box.current!.getBoundingClientRect();
    const s = stage.current;
    if (treat) {
      if (e.button !== 0) return;
      e.currentTarget.setPointerCapture(e.pointerId);
    } else if (!held) return;
    setHeld({ treat: treat ?? held!.treat, x: e.clientX - r.left, y: e.clientY - r.top });
    s?.point(at(e));
    if (s) s.hungry = s.mouthAt(at(e));
  };
  const letGo = (e: React.PointerEvent) => {
    e.stopPropagation();
    const s = stage.current;
    if (!held || !s) return setHeld(null);
    s.hungry = false;
    setHeld(null);
    setTreats(false);
    if (!s.mouthAt(at(e))) return;
    s.play(...persona.poked.fed.acts);
    say("fed", performance.now());
  };

  // Showing off: for each persona, its intro said, its head patted, a poke
  // to the chest and one to the head, and a treat carried from the menu to
  // its mouth; each after the last line is done. Over when it's done,
  // another starts, s is pressed or the panel goes.
  const demo = async (ids: string[]) => {
    const me = ++run.current;
    const v = voice.current;
    const live = () => run.current === me;
    const pause = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
    const quiet = async () => {
      await pause(300);
      while (live() && v.speaking) await pause(100);
      await pause(600);
    };
    const px = (at: { x: number; y: number }) => ({ x: ((at.x + 1) / 2) * box.current!.clientWidth, y: ((1 - at.y) / 2) * box.current!.clientHeight });
    v.stop();
    for (const id of ids) {
      const p = personaOf(id);
      setShowing(id === state.persona ? null : id);
      // Its model asked for (the persona effect), then on.
      while (live() && !k.model?.startsWith(`vrm:${p.title}:`)) await pause(50);
      await k.loads;
      await pause(800);
      const s = stage.current;
      if (!live() || !s) break;
      for (const [i, l] of p.intro.entries()) {
        if (!live()) break;
        v.say(l.text, `demo:${me}:${id}:${i}`, l.tone);
        await quiet();
      }
      const touched = async (kind: "pat" | "poke", poked: Poked, where: "head" | "body") => {
        const at = s.spot(where);
        if (!live() || !at) return;
        s.point(at);
        s.touch(kind, at);
        s.play(...p.poked[poked].acts);
        v.say(quip(p, poked), `demo:${me}:${id}:${poked}`, p.poked[poked].tone);
        await quiet();
      };
      await touched("pat", "pat", "head");
      await touched("poke", "body", "body");
      await touched("poke", "head", "head");
      // A treat carried to its mouth, its eyes on it and its mouth opening.
      const mouth = s.spot("mouth");
      if (!live() || !mouth) break;
      const treat = TREATS[Math.floor(Math.random() * TREATS.length)];
      const from = { x: 16, y: 16 };
      const to = px(mouth);
      const t0 = performance.now();
      for (let t = 0; t < 1 && live(); t = (performance.now() - t0) / 1400) {
        const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
        const x = from.x + (to.x - from.x) * e;
        const y = from.y + (to.y - from.y) * e;
        setHeld({ treat, x, y });
        const at = { x: (x / box.current!.clientWidth) * 2 - 1, y: 1 - (y / box.current!.clientHeight) * 2 };
        s.point(at);
        s.hungry = s.mouthAt(at);
        await new Promise(requestAnimationFrame);
      }
      await pause(400);
      s.hungry = false;
      setHeld(null);
      if (!live()) break;
      s.play(...p.poked.fed.acts);
      v.say(quip(p, "fed"), `demo:${me}:${id}:fed`, p.poked.fed.tone);
      await quiet();
    }
    stage.current?.point(null);
    if (live()) setShowing(null);
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
      {/* Its canvases, kept (Kept). */}
      <div ref={host} className="absolute inset-0" />
      {loading && <Spinner className="absolute inset-0" />}
      {(error || voiceError) && <div className="absolute inset-x-0 top-0 px-2ch pt-row text-blocked">{error || voiceError}</div>}
      {state.muted && <div className="absolute top-0 right-0 px-2ch pt-row text-muted-foreground">muted</div>}
      <div
        className={cn("absolute top-0 left-0 flex flex-col border-r border-b bg-background/85", !treats && !held && "border-transparent bg-transparent")}
        onPointerEnter={() => setTreats(true)}
        onPointerLeave={() => setTreats(false)}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        {TREATS.map((t, i) => (
          <div
            key={t}
            className={cn(
              "cursor-grab px-ch py-half touch-none",
              i > 0 && !treats && !held && "pointer-events-none opacity-0",
              held?.treat === t && "opacity-30",
            )}
            onPointerDown={(e) => carry(e, t)}
            onPointerMove={(e) => carry(e)}
            onPointerUp={letGo}
            onPointerCancel={() => setHeld(null)}
          >
            <TreatIcon treat={t} />
          </div>
        ))}
      </div>
      {held && (
        <div className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2" style={{ left: held.x, top: held.y }}>
          <TreatIcon treat={held.treat} />
        </div>
      )}
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

function TreatIcon({ treat }: { treat: Treat }) {
  return (
    <svg viewBox="0 0 20 20" className="size-[calc(var(--cell-h)*1.5)]">
      {treat === "cheesecake" && (
        <>
          <path d="M2 9 L18 5 L18 16 L2 16 Z" fill="#f4e4b5" />
          <path d="M2 9 L18 5 L18 7.5 L2 11 Z" fill="#c8323f" />
          <rect x="2" y="15.5" width="16" height="2.5" fill="#a9682f" />
          <circle cx="13" cy="4.6" r="2" fill="#e0384a" />
          <path d="M12.4 2.8 L13 1.8 L13.6 2.8" stroke="#3f8f3a" strokeWidth="0.9" fill="none" />
        </>
      )}
      {treat === "cookie" && (
        <>
          <circle cx="10" cy="10" r="8" fill="#d39a52" />
          <circle cx="10" cy="10" r="8" fill="none" stroke="#a96c2e" strokeWidth="0.8" />
          {[[7, 6.5], [12.5, 7], [6, 11.5], [10.5, 11], [13.5, 13.5], [8.5, 15]].map(([x, y]) => (
            <circle key={`${x},${y}`} cx={x} cy={y} r="1.1" fill="#4a2a17" />
          ))}
        </>
      )}
      {treat === "muffin" && (
        <>
          <path d="M4.5 11 L15.5 11 L14 18.5 L6 18.5 Z" fill="#e7d3b0" />
          {[7.5, 10, 12.5].map((x) => (
            <path key={x} d={`M${x} 11 L${x + (x - 10) * 0.15} 18.5`} stroke="#c5aa7c" strokeWidth="0.7" />
          ))}
          <path d="M2.5 11.5 Q2 3 10 3 Q18 3 17.5 11.5 Z" fill="#9a6232" />
          {[[7, 6.5], [11.5, 5.5], [13.5, 9], [8.5, 9.5]].map(([x, y]) => (
            <circle key={`${x},${y}`} cx={x} cy={y} r="1" fill="#3d3f86" />
          ))}
        </>
      )}
    </svg>
  );
}

// The model dropped on a panel for a persona, and the hosted ones fetched
// (by their URL), kept in this browser.
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

async function fetched(url: string): Promise<ArrayBuffer> {
  const had = await saved(url);
  if (had) return had;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  const data = await r.arrayBuffer();
  await save(url, data.slice(0));
  return data;
}

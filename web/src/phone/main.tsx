// corkboard.fyi/meet/phone.html: a session's face in the phone app, above
// its conversation (corkboard-cloud's android Avatar.kt, a WebView). The
// app gives it the session with avatar.set: its persona and skin, its
// state (her mood, as in views/Avatar.tsx), whether she's muted, and what
// it's said with the say and emote tools. What was said before the first
// set isn't said again. The app answers the voice's "speech" asks with the
// bridge's, through the Worker; this page never makes one itself, so a line
// the bridge can't say is subtitles only. Tapped or patted, she reacts, as
// on meet.

import "./phone.css";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ACTS, type ActName } from "@/avatar/acts";
import { line as quip, modelAt, persona as personaOf, POKED, type Poked, upcoming } from "@/avatar/personas";
import { type Mood, Stage } from "@/avatar/stage";
import { isMood, noVoiceInPage, Voice } from "@/avatar/voice";

type Said = { id: string; text?: string; mood?: string; emote?: string };
type Face = { persona?: string; skin?: string | null; state?: string; muted?: boolean; said?: Said[] };

declare global {
  interface Window {
    avatar: { set(f: Face): void };
  }
}

noVoiceInPage();

const mood = (state?: string): Mood =>
  state === "working" || state === "starting" || state === "background" ? "thinking" : state === "asking" || state === "permission" ? "asking" : "idle";

// Sets before the page is up wait for it.
let given: Face = {};
let onSet: ((f: Face) => void) | undefined;
window.avatar = {
  set(f) {
    given = f;
    onSet?.(f);
  },
};

function Phone() {
  const [face, setFace] = useState<Face>(given);
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const marks = useRef<HTMLCanvasElement>(null);
  const stage = useRef<Stage>(null);
  const [voice] = useState(() => new Voice((_, init) => fetch(`speech?q=${encodeURIComponent(String(init?.body ?? ""))}`)));
  const seen = useRef<Set<string>>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [line, setLine] = useState({ text: "", at: 0, speaking: false });
  const clicks = useRef<number[]>([]);
  const press = useRef<{ x: number; y: number; head: boolean; moved: number; patted: boolean }>(null);
  const loads = useRef(0);
  const persona = personaOf(face.persona);

  useEffect(() => {
    onSet = setFace;
    const s = new Stage(canvas.current!, voice, marks.current!);
    stage.current = s;
    const fit = () => box.current && s.resize(box.current.clientWidth, box.current.clientHeight);
    const sizes = new ResizeObserver(fit);
    sizes.observe(box.current!);
    fit();
    voice.onChange = () => setLine((l) => (voice.speaking ? { text: voice.text, at: voice.at(), speaking: true } : { ...l, at: l.text.length, speaking: false }));
    return () => {
      onSet = undefined;
      sizes.disconnect();
      voice.stop();
      s.dispose();
    };
  }, []);

  // Her model, voice and ways.
  const skin = persona.ownSkin ? undefined : (face.skin ?? undefined);
  useEffect(() => {
    const s = stage.current!;
    const me = ++loads.current;
    voice.voice = persona.voice;
    voice.effect = persona.effect;
    s.idle = persona.idle;
    for (const p of POKED) voice.warm(upcoming(persona, p), persona.poked[p].tone);
    setLoading(true);
    setError("");
    s.load(new URL(modelAt(persona), document.baseURI).href, persona.recolor, skin)
      .catch((e) => me === loads.current && setError(String(e?.message ?? e)))
      .finally(() => me === loads.current && setLoading(false));
  }, [persona, skin]);

  // Each new thing said, said.
  useEffect(() => {
    const said = Array.isArray(face.said) ? face.said : [];
    if (!seen.current) {
      if (face.said) seen.current = new Set(said.map((s) => s.id));
      return;
    }
    const acts: ActName[] = [];
    for (const s of said) {
      if (seen.current.has(s.id)) continue;
      seen.current.add(s.id);
      if (s.emote) {
        if (s.emote in ACTS) acts.push(s.emote as ActName);
      } else if (s.text) voice.say(s.text, s.id, isMood(s.mood) ? s.mood : undefined);
    }
    if (acts.length) stage.current?.play(...acts);
  }, [face.said]);

  useEffect(() => {
    if (stage.current) stage.current.mood = mood(face.state);
  }, [face.state]);
  useEffect(() => {
    voice.muted = !!face.muted;
  }, [face.muted]);

  useEffect(() => {
    if (!line.speaking) return;
    let frame = 0;
    const tick = () => {
      frame = requestAnimationFrame(tick);
      const at = voice.at();
      setLine((l) => (Math.floor(at) === Math.floor(l.at) ? l : { ...l, at }));
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, [line.speaking, line.text]);

  const at = (e: React.PointerEvent | React.MouseEvent) => {
    const r = canvas.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * 2 - 1, y: -((e.clientY - r.top) / r.height) * 2 + 1 };
  };
  const ready = () => (!loading && !error ? stage.current : null);
  const say = (poked: Poked, now: number) => {
    if (voice.speaking) return;
    voice.say(quip(persona, poked), `poke:${now}`, persona.poked[poked].tone);
    voice.warm(upcoming(persona, poked), persona.poked[poked].tone);
  };
  const down = (e: React.PointerEvent) => {
    const s = ready();
    if (e.button !== 0 || !s) return;
    press.current = { x: e.clientX, y: e.clientY, head: s.hit(at(e)) === "head", moved: 0, patted: false };
  };
  const move = (e: React.PointerEvent) => {
    const s = ready();
    const p = press.current;
    if (!s || !p || !(e.buttons & 1)) return;
    s.point(at(e));
    p.moved += Math.hypot(e.clientX - p.x, e.clientY - p.y);
    p.x = e.clientX;
    p.y = e.clientY;
    if (!p.head || p.patted || p.moved < 16) return;
    p.patted = true;
    s.touch("pat", at(e));
    s.play(...persona.poked.pat.acts);
    say("pat", performance.now());
  };
  const poke = (e: React.MouseEvent) => {
    const s = ready();
    const p = press.current;
    press.current = null;
    s?.point(null);
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

  const shown = line.text.slice(0, Math.ceil(line.at));
  return (
    <div ref={box} className="face" onPointerDown={down} onPointerMove={move} onPointerUp={() => stage.current?.point(null)} onClick={poke}>
      <canvas ref={canvas} />
      <canvas ref={marks} className="marks" />
      {loading && <div className="loading">…</div>}
      {error && <div className="error">{error}</div>}
      <div className="line" style={{ opacity: line.speaking ? 1 : 0 }}>
        {shown}
        <span className="ahead">{line.text.slice(shown.length)}</span>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Phone />);

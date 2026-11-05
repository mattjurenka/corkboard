// corkboard.fyi/meet (meet.html): every persona's avatar on one stage, one
// at a time, picked from their portraits. Rub her head to pat her, click
// her, or drag a treat from the top left to her mouth; she says one of her
// lines for it (src/avatar/personas.ts), said ahead of time into
// voices/said (bun run lines), so no bridge is needed. Picked, she says her
// intro. Models are fetched as they're picked, with how much has come.

import "./meet.css";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { line as quip, modelAt, type Persona, PERSONAS, type PersonaId, type Poked, upcoming } from "@/avatar/personas";
import { Stage } from "@/avatar/stage";
import { type Treat, TreatIcon, TREATS } from "@/avatar/treats";
import { Voice } from "@/avatar/voice";

// Terry borrows the nerd's model and is someone real; not shown off.
const CAST = (Object.keys(PERSONAS) as PersonaId[]).filter((id) => id !== "terry");
// meet/shirtless (or meet/#shirtless) opens on the shirtless one; picked,
// she's the path, a page of her own (vite.meet.config.ts).
const START: PersonaId = "tsundere";
const named = (): PersonaId | null => {
  for (const h of [location.hash.slice(1), location.pathname.split("/").filter(Boolean).pop() ?? ""]) {
    const n = decodeURIComponent(h).toLowerCase().replace(/\.html$/, "");
    if ((CAST as string[]).includes(n)) return n as PersonaId;
  }
  return null;
};

// A model, fetched once with how far along it is.
const models = new Map<string, Promise<ArrayBuffer>>();
function model(url: string, progress: (done: number) => void): Promise<ArrayBuffer> {
  let m = models.get(url);
  if (!m) {
    m = (async () => {
      const r = await fetch(url);
      if (!r.ok || !r.body) throw new Error(`${url}: ${r.status}`);
      const total = Number(r.headers.get("content-length")) || 0;
      const parts: Uint8Array[] = [];
      let got = 0;
      for (const reader = r.body.getReader(); ; ) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
        got += value.length;
        if (total) progress(got / total);
      }
      const out = new Uint8Array(got);
      let at = 0;
      for (const p of parts) out.set(p, (at += p.length) - p.length);
      return out.buffer;
    })();
    m.catch(() => models.delete(url));
    models.set(url, m);
  }
  return m;
}

function Meet() {
  const [id, setId] = useState<PersonaId>(() => named() ?? START);
  const persona: Persona = PERSONAS[id];
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const marks = useRef<HTMLCanvasElement>(null);
  const stage = useRef<Stage>(null);
  const [voice] = useState(() => new Voice());
  const [loading, setLoading] = useState<number | null>(0);
  const [error, setError] = useState("");
  const [muted, setMuted] = useState(false);
  const [line, setLine] = useState({ text: "", at: 0, speaking: false });
  const clicks = useRef<number[]>([]);
  const press = useRef<{ x: number; y: number; head: boolean; moved: number; patted: boolean }>(null);
  const [held, setHeld] = useState<{ treat: Treat; x: number; y: number } | null>(null);
  // Picked by a click, not the one shown first: she says hello.
  const greet = useRef(false);
  const loads = useRef(0);

  useEffect(() => {
    const s = new Stage(canvas.current!, voice, marks.current!);
    stage.current = s;
    const fit = () => box.current && s.resize(box.current.clientWidth, box.current.clientHeight);
    const sizes = new ResizeObserver(fit);
    sizes.observe(box.current!);
    fit();
    voice.onChange = () => setLine((l) => (voice.speaking ? { text: voice.text, at: voice.at(), speaking: true } : { ...l, at: l.text.length, speaking: false }));
    return () => {
      sizes.disconnect();
      voice.stop();
      s.dispose();
    };
  }, []);

  useEffect(() => {
    const s = stage.current!;
    const me = ++loads.current;
    voice.stop();
    voice.voice = persona.voice;
    voice.effect = persona.effect;
    s.idle = persona.idle;
    for (const p of Object.keys(persona.poked) as Poked[]) voice.warm(upcoming(persona, p), persona.poked[p].tone);
    for (const l of persona.intro) voice.warm(l.text, l.tone);
    setLoading(0);
    setError("");
    model(new URL(modelAt(persona), document.baseURI).href, (d) => me === loads.current && setLoading(d))
      .then((data) => (me === loads.current ? s.load(data.slice(0), persona.recolor) : undefined))
      .then(() => {
        if (me !== loads.current) return;
        setLoading(null);
        if (greet.current) voice.say(persona.intro[0].text, `intro:${id}`, persona.intro[0].tone);
      })
      .catch((e) => me === loads.current && (setLoading(null), setError(String(e?.message ?? e))));
  }, [id]);

  useEffect(() => {
    const changed = () => {
      const h = named();
      if (h) setId(h);
    };
    addEventListener("hashchange", changed);
    return () => removeEventListener("hashchange", changed);
  }, []);
  useEffect(() => {
    const at = new URL(id, document.baseURI).pathname;
    if (location.pathname !== at || location.hash) history.replaceState(null, "", at);
  }, [id]);

  useEffect(() => {
    voice.muted = muted;
  }, [muted]);

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
  const ready = () => (loading === null && !error ? stage.current : null);
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
  const poke = (e: React.MouseEvent) => {
    const s = ready();
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

  const carry = (e: React.PointerEvent, treat?: Treat) => {
    e.stopPropagation();
    const r = box.current!.getBoundingClientRect();
    const s = ready();
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
    const s = ready();
    setHeld(null);
    if (!s) return;
    s.hungry = false;
    if (!s.mouthAt(at(e))) return;
    s.play(...persona.poked.fed.acts);
    say("fed", performance.now());
  };

  const shown = line.text.slice(0, Math.ceil(line.at));
  return (
    <>
      <header className="wrap">
        <a className="mark" href="/">
          <span className="pin">●</span>corkboard
        </a>
        <a className="back" href="/">
          ← home
        </a>
      </header>
      <main className="wrap">
        <nav className="cast">
          {CAST.map((c) => (
            <button
              key={c}
              type="button"
              aria-pressed={c === id}
              onClick={() => {
                greet.current = true;
                if (c === id) voice.say(persona.intro[0].text, `intro:${id}:${performance.now()}`, persona.intro[0].tone);
                else setId(c);
              }}
            >
              <img src={`personas/${c}.png`} alt="" width={64} height={80} />
              {PERSONAS[c].title}
            </button>
          ))}
        </nav>
        <div ref={box} className="stage" onPointerDown={down} onPointerMove={move} onPointerLeave={() => stage.current?.point(null)} onClick={poke}>
          <canvas ref={canvas} />
          <canvas ref={marks} className="marks" />
          <div className="title">{persona.title}</div>
          {loading !== null && <div className="loading">{loading ? `${Math.round(loading * 100)}%` : "…"}</div>}
          {error && <div className="error">{error}</div>}
          <div className="treats" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
            {TREATS.map((t) => (
              <div
                key={t}
                className={held?.treat === t ? "out" : undefined}
                onPointerDown={(e) => carry(e, t)}
                onPointerMove={(e) => carry(e)}
                onPointerUp={letGo}
                onPointerCancel={() => setHeld(null)}
              >
                <TreatIcon treat={t} className="treat" />
              </div>
            ))}
          </div>
          <button
            type="button"
            className="mute"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              setMuted((m) => !m);
            }}
          >
            {muted ? "unmute" : "mute"}
          </button>
          {held && (
            <div className="held" style={{ left: held.x, top: held.y }}>
              <TreatIcon treat={held.treat} className="treat" />
            </div>
          )}
          <div className="line" style={{ opacity: line.speaking ? 1 : 0 }}>
            {shown}
            <span className="ahead">{line.text.slice(shown.length)}</span>
          </div>
        </div>
      </main>
    </>
  );
}

createRoot(document.getElementById("root")!).render(<Meet />);

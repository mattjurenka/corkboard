// bun run lines: each persona's lines for a click, and for being shown off
// (src/avatar/personas.ts),
// said ahead of time by the bridge's speech (bridge/speech.ts, so Chatterbox
// where there is one) into public/voices/said, a sentence an Ogg Opus file,
// with index.json saying which is which (src/avatar/voice.ts plays them
// rather than waiting for them to be made). Only what isn't there yet is
// made (or what was cloned from a recording that's changed since), and
// what's no longer said goes. Run again when a line or a voice
// changes; with --again, every line is made again.

import { readdirSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { reference, speech } from "../bridge/speech";
import { PERSONAS } from "./src/avatar/personas";
import { askKey, asks, type Ask, type SaidAhead } from "./src/avatar/voice";

const out = `${new URL(".", import.meta.url).pathname}public/voices/said`;
await mkdir(out, { recursive: true });
const indexFile = Bun.file(`${out}/index.json`);
const old: Record<string, SaidAhead> = process.argv.includes("--again") || !(await indexFile.exists()) ? {} : await indexFile.json();

const wanted = new Map<string, Ask>();
for (const p of Object.values(PERSONAS)) {
  for (const { tone, lines } of Object.values(p.poked)) for (const line of lines) for (const a of asks(line, p.voice, tone)) wanted.set(askKey(a), a);
  for (const { tone, text } of p.intro) for (const a of asks(text, p.voice, tone)) wanted.set(askKey(a), a);
}

// Encoded by the Python that has Chatterbox, which has soundfile.
const python = process.env.CORKBOARD_CHATTERBOX || `${process.env.XDG_DATA_HOME || `${process.env.HOME}/.local/share`}/corkboard/chatterbox/bin/python`;
const ENCODE = `import sys, numpy, soundfile
soundfile.write(sys.argv[1], numpy.frombuffer(sys.stdin.buffer.read(), dtype="<f4"), int(sys.argv[2]), format="OGG", subtype="OPUS")`;

// What's still said, kept as it was if it's there.
const index = Object.fromEntries(Object.entries(old).filter(([k]) => wanted.has(k)));
const save = () => Bun.write(indexFile, JSON.stringify(Object.fromEntries(Object.entries(index).sort()), null, 2) + "\n");
let n = 0;
for (const [key, a] of wanted) {
  n++;
  const file = `${createHash("sha256").update(key).digest("hex").slice(0, 16)}.ogg`;
  const from = await reference(a.voice, a.mood);
  const ref = from && createHash("sha256").update(await Bun.file(from).bytes()).digest("hex").slice(0, 16);
  if (index[key]?.file === file && index[key].ref === ref && (await Bun.file(`${out}/${file}`).exists())) continue;
  const res = await speech(
    new Request("http://x/speech", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: a.text, voice: a.voice, speed: a.speed, mood: a.mood }) }),
  );
  if (!res.ok) throw new Error(`${a.voice}: ${a.text}: ${await res.text()}`);
  const rate = Number(res.headers.get("x-sample-rate"));
  const enc = Bun.spawn([python, "-c", ENCODE, `${out}/${file}`, String(rate)], { stdin: new Uint8Array(await res.arrayBuffer()), stderr: "inherit" });
  if ((await enc.exited) !== 0) throw new Error(`couldn't encode ${file}`);
  const phonemes = res.headers.get("x-phonemes");
  const frames = res.headers.get("x-frames");
  index[key] = { file, rate, ...(ref && { ref }), ...(phonemes && frames && { phonemes: decodeURIComponent(phonemes), frames: frames.split(",").map(Number) }) };
  await save();
  console.log(`${n}/${wanted.size} ${a.voice}: ${a.text}`);
}
await save();

const kept = new Set(Object.values(index).map((s) => s.file));
for (const f of readdirSync(out)) if (f.endsWith(".ogg") && !kept.has(f)) rmSync(`${out}/${f}`);
process.exit(0);

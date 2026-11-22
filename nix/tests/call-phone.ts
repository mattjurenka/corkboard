// multi-node.nix's call: the phone, as corkboard-cloud's Call.kt is, over a
// sealed channel to the leader (POST /api/node/call). It sends 100 ms of
// audio every 100 ms, quiet unless there's something to say: <dir>/in/<n>.raw
// (16 kHz 16-bit mono) is said once, in turn, and <dir>/in/<n>.end hangs up.
// What comes back is written to <dir>/out.ndjson, a say's audio as its
// length, and "closed" once the node has ended the call.
// `bun call-phone.ts <share/corkboard> <dir>`

import { appendFileSync, readdirSync, readFileSync, renameSync } from "node:fs";

const [share, dir] = process.argv.slice(2);
const { Relay } = await import(`${share}/lib/e2ee/relay.ts`);
const { Keystore } = await import(`${share}/bridge/keystore.ts`);
const { CLOUD } = await import(`${share}/bridge/cloud.ts`);

const store = new Keystore();
const { device, cert } = store.device()!;
const relay = new Relay({ origin: CLOUD, device, cert, token: store.token(), onToken: (t: unknown) => store.saveToken(t) });
const { leader } = await relay.nodes();
if (!leader) throw new Error("no leader");
const ch = await relay.channel(leader);

const log = (m: object) => appendFileSync(`${dir}/out.ndjson`, JSON.stringify(m) + "\n");
const enc = new TextEncoder();
const CHUNK = 1600;
let saying = new Int16Array(0);
let hangUp = false;

// The next thing to say, once what's being said is done.
const next = () => {
  const [f] = readdirSync(`${dir}/in`).filter((f) => /\.(raw|end)$/.test(f)).sort();
  if (!f) return;
  renameSync(`${dir}/in/${f}`, `${dir}/in/${f}.sent`);
  if (f.endsWith(".end")) return void (hangUp = true);
  const b = readFileSync(`${dir}/in/${f}.sent`);
  saying = new Int16Array(b.buffer, b.byteOffset, b.byteLength >> 1);
  log({ sent: f });
};

const body = new ReadableStream<Uint8Array>({
  async pull(c) {
    await Bun.sleep(100);
    if (!saying.length) next();
    if (hangUp) {
      c.enqueue(enc.encode(JSON.stringify({ type: "end" }) + "\n"));
      return c.close();
    }
    const chunk = new Int16Array(CHUNK);
    chunk.set(saying.subarray(0, CHUNK));
    saying = saying.subarray(CHUNK);
    c.enqueue(enc.encode(JSON.stringify({ type: "audio", data: Buffer.from(chunk.buffer).toString("base64") }) + "\n"));
  },
});

const res = await ch.fetch("/api/node/call?voice=af_heart&speed=1", { method: "POST", body });
log({ status: res.status });
const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
let buf = "";
for (;;) {
  const { value, done } = await reader.read();
  if (done) break;
  buf += value;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const m = JSON.parse(buf.slice(0, nl));
    buf = buf.slice(nl + 1);
    log(m.type === "say" ? { ...m, audio: Buffer.from(m.audio, "base64").length >> 1 } : m);
  }
}
log({ closed: true });
process.exit(0);

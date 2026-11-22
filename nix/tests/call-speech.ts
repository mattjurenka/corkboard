// multi-node.nix's call: what the phone will say, said by the node's own
// Kokoro (bridge/speech.ts) and made 16 kHz 16-bit mono, as the phone sends.
// `bun call-speech.ts <share/corkboard> <out dir> <name>=<text>...`

const [share, dir, ...said] = process.argv.slice(2);
const { say } = await import(`${share}/bridge/speech.ts`);

for (const arg of said) {
  const eq = arg.indexOf("=");
  const { audio, rate } = await say({ text: arg.slice(eq + 1), voice: "af_heart", speed: 1 });
  const n = Math.floor((audio.length * 16_000) / rate);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i * rate) / 16_000, j = Math.floor(x), f = x - j;
    const s = (audio[j] ?? 0) * (1 - f) + (audio[j + 1] ?? 0) * f;
    out[i] = Math.max(-1, Math.min(1, s)) * 0x7fff;
  }
  await Bun.write(`${dir}/${arg.slice(0, eq)}.raw`, out);
  console.log(`${arg.slice(0, eq)}: ${(n / 16_000).toFixed(2)} s`);
}
process.exit(0);

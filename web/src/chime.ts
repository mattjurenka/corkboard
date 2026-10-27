// Away mode's chime (bridge/away.ts picks the page): two soft sine notes,
// made here rather than shipped as a file. The page has had a key by then
// (the one that went away), so the browser lets it play.

let ctx: AudioContext | undefined;

export function chime() {
  ctx ??= new AudioContext();
  ctx.resume();
  const t = ctx.currentTime;
  for (const [freq, delay] of [[660, 0], [880, 0.35]]) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t + delay);
    gain.gain.exponentialRampToValueAtTime(0.2, t + delay + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + delay + 2.5);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t + delay);
    osc.stop(t + delay + 2.6);
  }
}

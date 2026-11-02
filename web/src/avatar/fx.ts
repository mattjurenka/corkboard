// Manga marks drawn over the avatar, on a 2D canvas laid on the stage: a
// throbbing vein when she's annoyed, shock lines and a "!" when surprised,
// hatched blush when shy, gloom lines when sad, a scribble when sulky,
// sparkles when happy, notes when teasing. And a hand where you click: a
// pat on her head, or a poke. They follow her head about, tilting with it.

export type Effect = "vein" | "shock" | "blush" | "gloom" | "scribble" | "sparkle" | "note";
export type Touch = "pat" | "poke";

// Where her face is on the canvas, in CSS pixels: between her eyes, how far
// her head is turned over, and how many pixels a tenth of a metre is there.
// The marks are drawn in those tenths, y down, x to your right.
// And where her cheeks are, in those tenths, if that is known.
export type Head = { x: number; y: number; roll: number; unit: number; cheeks?: [number, number][] };

const LINE = "rgba(30, 20, 35, 0.9)";

// Toward target at rate (per second), whatever the frame time.
const ease = (from: number, to: number, rate: number, dt: number) => from + (to - from) * (1 - Math.exp(-rate * dt));
// 0 to 1 over a span, past 1 and back.
const pop = (u: number) => {
  if (u >= 1) return 1;
  const v = u - 1;
  return 1 + 2.7 * v ** 3 + 1.7 * v ** 2;
};

const FADE: Record<Effect, number> = { vein: 5, shock: 6, blush: 1.2, gloom: 2, scribble: 3, sparkle: 3, note: 3 };
const TOUCH_SPAN: Record<Touch, number> = { pat: 1.6, poke: 0.9 };

export class Fx {
  private g: CanvasRenderingContext2D;
  private w = 0;
  private h = 0;
  private on = new Map<Effect, { weight: number; at: number }>();
  private touch?: { kind: Touch; at: number; x: number; y: number };
  private drawn = false;

  constructor(private canvas: HTMLCanvasElement) {
    this.g = canvas.getContext("2d")!;
  }

  resize(w: number, h: number) {
    const dpr = Math.min(devicePixelRatio, 2);
    this.w = w;
    this.h = h;
    this.canvas.width = w * dpr;
    this.canvas.height = h * dpr;
  }

  // A hand, now, at x, y (CSS pixels); a pat goes to her head wherever it is.
  put(kind: Touch, x: number, y: number, t: number) {
    this.touch = { kind, at: t, x, y };
  }

  draw(want: Effect[], head: Head | undefined, t: number, dt: number) {
    for (const e of want) {
      const o = this.on.get(e);
      if (!o || o.weight < 0.05) this.on.set(e, { weight: o?.weight ?? 0, at: t });
    }
    for (const [e, o] of this.on) {
      o.weight = ease(o.weight, want.includes(e) ? 1 : 0, want.includes(e) ? 10 : FADE[e], dt);
      if (o.weight < 0.01 && !want.includes(e)) this.on.delete(e);
    }
    if (this.touch && t - this.touch.at > TOUCH_SPAN[this.touch.kind]) this.touch = undefined;

    const g = this.g;
    if (!this.on.size && !this.touch && !this.drawn) return;
    const dpr = this.canvas.width / Math.max(1, this.w);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.drawn = false;
    if (!head) return;
    g.lineCap = g.lineJoin = "round";
    for (const [e, o] of this.on) {
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.translate(head.x, head.y);
      g.rotate(head.roll);
      g.scale(head.unit, head.unit);
      g.globalAlpha = Math.min(1, o.weight);
      MARKS[e](g, t - o.at, t, head);
      this.drawn = true;
    }
    g.globalAlpha = 1;
    if (this.touch) {
      const { kind, at, x, y } = this.touch;
      const u = (t - at) / TOUCH_SPAN[kind];
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.globalAlpha = Math.min(1, u * 8, (1 - u) * 5);
      if (kind === "pat") {
        g.translate(head.x, head.y);
        g.rotate(head.roll);
        g.scale(head.unit, head.unit);
        pat(g, u);
      } else {
        g.translate(x, y);
        g.scale(head.unit, head.unit);
        poke(g, u);
      }
      g.globalAlpha = 1;
      this.drawn = true;
    }
  }
}

// A path, outlined dark and then drawn in color over it.
function inked(g: CanvasRenderingContext2D, path: () => void, color: string, width: number, fill = false) {
  g.beginPath();
  path();
  g.strokeStyle = LINE;
  g.lineWidth = width + 0.07;
  g.stroke();
  if (fill) {
    g.fillStyle = color;
    g.fill();
  } else {
    g.strokeStyle = color;
    g.lineWidth = width;
    g.stroke();
  }
}

const turn = (x: number, y: number, a: number): [number, number] => [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)];

// "!": a bar narrowing down, and a dot.
function bang(g: CanvasRenderingContext2D, color: string) {
  inked(
    g,
    () => {
      g.moveTo(-0.11, -0.5);
      g.lineTo(0.11, -0.5);
      g.lineTo(0.05, 0.08);
      g.lineTo(-0.05, 0.08);
      g.closePath();
      g.moveTo(0.08, 0.25);
      g.arc(0, 0.25, 0.08, 0, Math.PI * 2);
    },
    color,
    0.03,
    true,
  );
}

const MARKS: Record<Effect, (g: CanvasRenderingContext2D, since: number, t: number, head: Head) => void> = {
  // The cross-popping vein, throbbing, by her temple.
  vein(g, since, t) {
    const k = pop(since / 0.3) * (1 + 0.14 * Math.max(0, Math.sin(t * 9)));
    g.translate(1.05, -1.15);
    g.scale(k * 1.15, k * 1.15);
    g.rotate(0.25);
    inked(
      g,
      () => {
        for (let q = 0; q < 4; q++) {
          const a = (q * Math.PI) / 2;
          g.moveTo(...turn(0.07, -0.34, a));
          g.quadraticCurveTo(...turn(0.07, -0.07, a), ...turn(0.34, -0.07, a));
        }
      },
      "#e3262f",
      0.1,
    );
  },
  // Lines out from her head, and a "!".
  shock(g, since) {
    const k = pop(since / 0.25);
    const u = Math.min(1, since / 0.15);
    inked(
      g,
      () => {
        for (const side of [-1, 1]) {
          for (const deg of [28, 50, 72]) {
            const a = (deg * Math.PI) / 180;
            const [dx, dy] = [side * Math.sin(a) * 0.9, -Math.cos(a)];
            const r = 1.45 + 0.1 * (1 - k);
            g.moveTo(dx * r, -0.35 + dy * r);
            g.lineTo(dx * (r + 0.45 * u), -0.35 + dy * (r + 0.45 * u));
          }
        }
      },
      "#ffd23a",
      0.08,
    );
    g.translate(1.35, -1.65);
    g.rotate(0.25);
    g.scale(k * 1.4, k * 1.4);
    bang(g, "#ff5a36");
  },
  // Pink on her cheeks, hatched.
  blush(g, since, _t, head) {
    const u = Math.min(1, since / 0.5);
    for (const [i, side] of [-1, 1].entries()) {
      const [cx, cy] = head.cheeks?.[i] ?? [side * 0.42, 0.42];
      const glow = g.createRadialGradient(cx, cy, 0, cx, cy, 0.3);
      glow.addColorStop(0, "rgba(255, 90, 120, 0.5)");
      glow.addColorStop(1, "rgba(255, 90, 120, 0)");
      g.fillStyle = glow;
      g.beginPath();
      g.ellipse(cx, cy, 0.3, 0.17, 0, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = "rgba(225, 50, 85, 0.85)";
      g.lineWidth = 0.035;
      g.beginPath();
      for (let i = 0; i < 4; i++) {
        if (u * 4 < i) break;
        const x = cx + (i - 1.5) * 0.1;
        g.moveTo(x + 0.04, cy - 0.08);
        g.lineTo(x - 0.04, cy + 0.08);
      }
      g.stroke();
    }
  },
  // Blue lines hanging down over her brow.
  gloom(g, since, t) {
    const u = Math.min(1, since / 0.6);
    const lines = [
      [-0.55, 0.6],
      [-0.36, 0.9],
      [-0.18, 0.7],
      [0, 1],
      [0.18, 0.75],
      [0.36, 0.95],
      [0.55, 0.6],
    ];
    g.lineWidth = 0.065;
    for (const [i, [x, len]] of lines.entries()) {
      const top = -1.25;
      const bottom = top + len * u + 0.04 * Math.sin(t * 2 + i);
      const fade = g.createLinearGradient(0, top, 0, bottom);
      fade.addColorStop(0, "rgba(70, 60, 170, 0.8)");
      fade.addColorStop(1, "rgba(70, 60, 170, 0)");
      g.strokeStyle = fade;
      g.beginPath();
      g.moveTo(x, top);
      g.lineTo(x, bottom);
      g.stroke();
    }
  },
  // A tangle over her head, muttering.
  scribble(g, since, t) {
    const k = pop(since / 0.3);
    g.translate(1.15, -1.75);
    g.scale(k, k);
    const jitter = Math.floor(t * 8);
    inked(
      g,
      () => {
        for (let a = 0; a <= Math.PI * 10; a += 0.25) {
          const wob = 0.03 * Math.sin(a * 7.3 + jitter);
          const x = -0.6 + (a / (Math.PI * 10)) * 1.2 + 0.26 * Math.cos(a) + wob;
          const y = 0.24 * Math.sin(a) + wob;
          if (a === 0) g.moveTo(x, y);
          else g.lineTo(x, y);
        }
      },
      "#5a5a70",
      0.055,
    );
  },
  // Stars twinkling about her.
  sparkle(g, since, t) {
    const k = pop(since / 0.35);
    const stars = [
      [-1.15, -1.0, 0.3, 0],
      [1.2, -0.75, 0.24, 1.7],
      [0.75, -1.65, 0.2, 3.1],
      [-0.75, -1.7, 0.16, 4.4],
      [1.35, 0.25, 0.16, 2.3],
      [-1.3, 0.15, 0.2, 5.2],
    ];
    for (const [x, y, size, phase] of stars) {
      const r = size * k * (0.55 + 0.45 * Math.abs(Math.sin(t * 2.6 + phase)));
      g.save();
      g.translate(x, y);
      g.rotate(Math.sin(t + phase) * 0.2);
      inked(
        g,
        () => {
          g.moveTo(0, -r);
          for (let q = 1; q <= 4; q++) g.quadraticCurveTo(...turn(r * 0.12, -r * 0.12, ((q - 0.5) * Math.PI) / 2), ...turn(0, -r, (q * Math.PI) / 2));
        },
        "#fff3a0",
        0.025,
        true,
      );
      g.restore();
    }
  },
  // Notes floating up off her, one after another.
  note(g, _since, t) {
    for (const [i, side] of [[0, 1], [0.5, -1]] as const) {
      const u = (t / 1.8 + i) % 1;
      g.save();
      g.globalAlpha *= Math.min(1, u * 5, (1 - u) * 3);
      g.translate(side * (1.15 + 0.12 * Math.sin(u * 7)), -0.9 - u * 0.9);
      g.rotate(0.15 * Math.sin(u * 6));
      inked(
        g,
        () => {
          g.ellipse(0, 0, 0.13, 0.09, -0.4, 0, Math.PI * 2);
          g.moveTo(0.11, -0.03);
          g.lineTo(0.11, -0.5);
          g.quadraticCurveTo(0.2, -0.32, 0.34, -0.3);
        },
        "#ff6fa8",
        0.06,
      );
      g.beginPath();
      g.ellipse(0, 0, 0.13, 0.09, -0.4, 0, Math.PI * 2);
      g.fillStyle = "#ff6fa8";
      g.fill();
      g.restore();
    }
  },
};

const SKIN = "#ffe0cf";

// A hand, palm down, patting the top of her head three times.
function pat(g: CanvasRenderingContext2D, u: number) {
  const come = Math.min(1, u / 0.2);
  const bob = u < 0.2 ? 0 : Math.abs(Math.sin(((u - 0.2) / 0.8) * Math.PI * 3)) * 0.35;
  g.translate(0.15 + (1 - come) * 1.5, -1.5 - bob - (1 - come) * 1.2);
  g.rotate(-0.15 + bob * 0.3);
  // The sleeve, off up and to the right.
  inked(
    g,
    () => {
      g.moveTo(0.5, -0.35);
      g.lineTo(1.6, -1.2);
      g.lineTo(1.9, -0.8);
      g.lineTo(0.75, 0.05);
      g.closePath();
    },
    "#6c7a96",
    0.03,
    true,
  );
  // The back of the hand, fingers curled down over her hair.
  inked(
    g,
    () => {
      g.moveTo(-0.55, -0.1);
      g.quadraticCurveTo(-0.6, -0.45, -0.2, -0.45);
      g.lineTo(0.55, -0.4);
      g.quadraticCurveTo(0.85, -0.2, 0.7, 0.1);
      g.lineTo(0.55, 0.2);
      for (let f = 0; f < 4; f++) {
        const x = 0.4 - f * 0.26;
        g.quadraticCurveTo(x + 0.02, 0.38, x - 0.12, 0.32);
        g.quadraticCurveTo(x - 0.16, 0.24, x - 0.14, 0.2);
      }
      g.closePath();
    },
    SKIN,
    0.03,
    true,
  );
  // And the thumb, tucked under at the near side.
  inked(
    g,
    () => {
      g.ellipse(-0.6, 0.02, 0.1, 0.2, 0.5, 0, Math.PI * 2);
    },
    SKIN,
    0.03,
    true,
  );
}

// A hand coming in from below and to the right, finger out, jabbing twice
// at where you clicked.
function poke(g: CanvasRenderingContext2D, u: number) {
  const come = Math.min(1, u / 0.15);
  const jab = u < 0.15 ? 0 : Math.max(0, Math.sin(((u - 0.15) / 0.85) * Math.PI * 2)) * 0.25;
  g.rotate(-0.7);
  // The fingertip's at the origin.
  g.translate(0, 0.05 + (1 - come) * 1.6 + 0.25 - jab);
  inked(
    g,
    () => {
      g.moveTo(-0.3, 1.0);
      g.lineTo(-0.35, 2.4);
      g.lineTo(0.45, 2.4);
      g.lineTo(0.4, 1.0);
      g.closePath();
    },
    "#6c7a96",
    0.03,
    true,
  );
  inked(
    g,
    () => {
      // The finger, then the fist it comes out of.
      g.moveTo(-0.08, 0.5);
      g.lineTo(-0.08, 0.05);
      g.arc(0, 0.05, 0.08, Math.PI, 0);
      g.lineTo(0.08, 0.45);
      g.quadraticCurveTo(0.42, 0.42, 0.45, 0.7);
      g.lineTo(0.42, 1.05);
      g.quadraticCurveTo(0.05, 1.15, -0.3, 1.05);
      g.quadraticCurveTo(-0.38, 0.75, -0.25, 0.5);
      g.closePath();
    },
    SKIN,
    0.03,
    true,
  );
  // The curled fingers' creases, and the thumb across them.
  g.strokeStyle = LINE;
  g.lineWidth = 0.035;
  g.beginPath();
  for (const y of [0.62, 0.78, 0.93]) {
    g.moveTo(0.12, y);
    g.lineTo(0.42, y + 0.02);
  }
  g.moveTo(-0.28, 0.6);
  g.quadraticCurveTo(0, 0.55, 0.12, 0.7);
  g.stroke();
  // A little burst at the tip, as it lands.
  if (jab > 0.18) {
    g.strokeStyle = "#ffd23a";
    g.lineWidth = 0.05;
    g.beginPath();
    for (const a of [-1.2, -0.6, 0, 0.6, 1.2]) {
      g.moveTo(Math.sin(a) * 0.18, -Math.cos(a) * 0.18);
      g.lineTo(Math.sin(a) * 0.35, -Math.cos(a) * 0.35);
    }
    g.stroke();
  }
}

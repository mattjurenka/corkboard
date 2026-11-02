// Little things the avatar does, each a pose held for a few seconds that the
// stage eases into and back out of: a huff with her hands on her hips, a
// stretch, a shift of weight, turning her nose up at you; flinching when
// she's poked and melting a little when her head is patted; arms folded
// waiting on you, a hand to her chin thinking, a yawn, a sneaked look, a
// sway with her hands behind her back, and pleased with herself when a job
// is done, and jumping up and down for joy; chewing a treat she's fed. Angles are
// VRM 1's (the stage flips them for a VRM 0 model), left side; side is
// which way she turns, 1 to her left.

import type { VRMHumanBoneName } from "@pixiv/three-vrm";

export type Pose = Partial<Record<VRMHumanBoneName, [number, number, number]>>;
export type Face = Partial<Record<"angry" | "happy" | "sad" | "surprised" | "blink" | "aa", number>>;
// lift raises the whole model, in metres.
export type Frame = { pose: Pose; face?: Face; look?: [number, number]; lift?: number };

export type ActName =
  | "huff"
  | "snub"
  | "stretch"
  | "shift"
  | "flinch"
  | "pat"
  | "fold"
  | "ponder"
  | "yawn"
  | "glance"
  | "sway"
  | "proud"
  | "jump"
  | "eat"
  | "wave"
  | "thumbs"
  | "nod"
  | "bow"
  | "shrug";
type Act = { span: number; at: (u: number, side: number) => Frame };

// An arm's bones, the left's as given and the right's mirrored.
function arms(upper: [number, number, number], lower: [number, number, number], hand: [number, number, number] = [0, 0, 0]): Pose {
  const m = ([x, y, z]: [number, number, number]): [number, number, number] => [x, -y, -z];
  return {
    leftUpperArm: upper,
    leftLowerArm: lower,
    leftHand: hand,
    rightUpperArm: m(upper),
    rightLowerArm: m(lower),
    rightHand: m(hand),
  };
}

// One arm only, the left as given, or the right mirrored.
function arm(side: "left" | "right", upper: [number, number, number], lower: [number, number, number], hand: [number, number, number] = [0, 0, 0]): Pose {
  const m = ([x, y, z]: [number, number, number]): [number, number, number] => (side === "left" ? [x, y, z] : [x, -y, -z]);
  return { [`${side}UpperArm`]: m(upper), [`${side}LowerArm`]: m(lower), [`${side}Hand`]: m(hand) };
}

// Arms folded under her chest.
const folded = (): Pose => ({ ...arm("left", [0.6, -0.35, -1.25], [0, -2.05, 0]), ...arm("right", [0.6, -0.35, -1.2], [0, -1.95, 0]) });

// A hand's fingers, curled as far as curl (1 a fist), and its thumb out
// as far as out.
function hand(side: "left" | "right", curl: number, out = 0): Pose {
  const d = side === "left" ? -1 : 1;
  const pose: Pose = {};
  for (const finger of ["Index", "Middle", "Ring", "Little"] as const) {
    pose[`${side}${finger}Proximal`] = [0, 0, d * 1.4 * curl];
    pose[`${side}${finger}Intermediate`] = [0, 0, d * 1.6 * curl];
    pose[`${side}${finger}Distal`] = [0, 0, d * 1.1 * curl];
  }
  pose[`${side}ThumbMetacarpal`] = [0, d * 0.3 * out, 0];
  pose[`${side}ThumbProximal`] = [0, d * 0.2 * out, 0];
  pose[`${side}ThumbDistal`] = [0, 0, 0];
  return pose;
}

// From 0 to 1 over a quarter second from at, u seconds into an act.
const step = (u: number, at: number) => Math.max(0, Math.min(1, (u - at) / 0.25));

// From 0 to 1, eased in and out.
const smooth = (x: number) => {
  const c = Math.max(0, Math.min(1, x));
  return c * c * (3 - 2 * c);
};

// A hop, over 0 to 1, from a crouch to one: pushing off, in the air,
// landing and crouched; how high (metres), and how far the knees are bent.
function hop(q: number): { up: number; bend: number } {
  if (q < 0.15) return { up: 0, bend: 1 - smooth(q / 0.15) };
  if (q < 0.65) {
    const a = Math.sin(((q - 0.15) / 0.5) * Math.PI);
    return { up: 0.12 * a, bend: 0.25 * a };
  }
  return { up: 0, bend: smooth((q - 0.65) / 0.2) };
}

export const ACTS: Record<ActName, Act> = {
  // Hands on hips, nose in the air, looking away; a glance back to see if
  // you noticed.
  huff: {
    span: 4.2,
    at: (u, side) => ({
      pose: {
        ...arms([1.57, -0.4, -0.72], [0, -1.75, 0]),
        head: [-0.12, 0.35 * side, 0.08 * side],
        neck: [-0.04, 0.12 * side, 0],
      },
      face: { angry: 0.45 },
      look: u > 2.3 && u < 3.1 ? [0.02, 0.05] : [0.45 * side, 0.12],
    }),
  },
  // "Hmph": chin up, eyes shut, turned away.
  snub: {
    span: 2.6,
    at: (_u, side) => ({
      pose: { head: [-0.18, 0.45 * side, 0.1 * side], neck: [-0.05, 0.15 * side, 0] },
      face: { angry: 0.3, blink: 0.9 },
      look: [0.5 * side, 0.2],
    }),
  },
  stretch: {
    span: 3.4,
    at: () => ({
      pose: {
        ...arms([0, 0, 1.25], [0, -0.35, 0]),
        spine: [-0.1, 0, 0],
        chest: [-0.08, 0, 0],
        head: [-0.2, 0, 0],
      },
      face: { blink: 1, happy: 0.3 },
      look: [0, 0.3],
    }),
  },
  // Her weight onto one leg, her head the other way.
  shift: {
    span: 4.5,
    at: (_u, side) => ({
      pose: { hips: [0, 0, 0.06 * side], spine: [0, 0, -0.05 * side], head: [0, 0.05 * side, -0.08 * side] },
    }),
  },
  flinch: {
    span: 0.8,
    at: () => ({
      pose: {
        leftShoulder: [0, 0, 0.22],
        rightShoulder: [0, 0, -0.22],
        spine: [-0.08, 0, 0],
        head: [-0.15, 0, 0],
        ...arms([0, -0.5, -1.25], [0, -2.1, 0]),
      },
      face: { surprised: 1, blink: 0 },
    }),
  },
  // Eyes closed, leaning into it (until she remembers herself: a snub).
  pat: {
    span: 2,
    at: (_u, side) => ({
      pose: { head: [0.18, 0, 0.12 * side], leftShoulder: [0, 0, 0.1], rightShoulder: [0, 0, -0.1] },
      face: { happy: 0.6, blink: 0.75 },
    }),
  },
  // Waiting on you, and making sure you know it.
  fold: {
    span: 4.5,
    at: (u, side) => ({
      pose: { ...folded(), head: [-0.06, 0.12 * side, -0.1 * side], spine: [0, 0, 0.03 * side] },
      face: { angry: 0.35 + 0.15 * Math.max(0, Math.sin(u * 2)) },
    }),
  },
  // A hand to her chin, the other forearm across her waist under its
  // elbow, out in front of her, eyes up.
  ponder: {
    span: 5,
    at: (_u, side) => ({
      pose: {
        ...arm("right", [-0.8, -1.1, -0.7], [0, -2.4, 0]),
        ...arm("left", [0.6, -0.6, -1.15], [0, -1.7, 0]),
        head: [-0.08, 0.1 * side, 0.12],
      },
      look: [0.3 * side, 0.3],
    }),
  },
  // A hand to her mouth, head back, eyes shut.
  yawn: {
    span: 3,
    at: (u) => {
      const open = Math.sin(Math.min(1, u / 2.4) * Math.PI);
      return {
        pose: {
          ...arm("right", [-0.9, -1.15, -0.62], [0, -2.5, 0]),
          head: [-0.25 * open, 0, 0.05],
          chest: [-0.06 * open, 0, 0],
          rightShoulder: [0, 0, -0.12 * open],
          leftShoulder: [0, 0, 0.12 * open],
        },
        face: { blink: 1, aa: open, sad: 0.2 },
      };
    },
  },
  // Away; a look at you; caught, away again, harder.
  glance: {
    span: 3.4,
    at: (u, side) => {
      const back = step(u, 1.1) - step(u, 1.9);
      const away = 0.45 + 0.15 * step(u, 1.9);
      return {
        pose: { head: [-0.05, (away - 0.35 * back) * side, 0.06 * side], neck: [0, 0.12 * side * (1 - back), 0] },
        face: { surprised: 0.5 * back, angry: 0.3 * step(u, 1.9), blink: 0.15 },
        look: [(1 - back) * 0.5 * side, 0.05],
      };
    },
  },
  // Hands behind her back, swaying from side to side, pleased about
  // something.
  sway: {
    span: 5.5,
    at: (u) => {
      const s = Math.sin(u * 2.2);
      return {
        pose: {
          ...arms([1.5, 0.35, -1.2], [0, -1.3, 0]),
          hips: [0, 0, 0.04 * s],
          spine: [0, 0.05 * s, -0.05 * s],
          head: [0.05, 0, 0.12 * s],
        },
        face: { happy: 0.5, blink: 0.3 },
      };
    },
  },
  // Hands on hips, chin up, looking right at you: told you so.
  proud: {
    span: 3.2,
    at: () => ({
      pose: { ...arms([1.57, -0.4, -0.72], [0, -1.75, 0]), head: [-0.15, 0, 0], chest: [-0.06, 0, 0] },
      face: { happy: 0.7, blink: 0.5 },
    }),
  },
  // Three hops on the spot, hands up, for the joy of it.
  jump: {
    span: 3,
    at: (u) => {
      const k = (u - 0.3) / 0.7;
      const { up, bend } = k < 0 ? { up: 0, bend: smooth(u / 0.3) } : k < 3 ? hop(k % 1) : { up: 0, bend: 1 - smooth((k - 3) / 0.5) };
      const high = up / 0.12;
      return {
        pose: {
          ...arms([0, -0.2, -1.1 + 2 * high], [0, -0.6 + 0.3 * high, 0]),
          leftUpperLeg: [-0.5 * bend, 0, 0],
          rightUpperLeg: [-0.5 * bend, 0, 0],
          leftLowerLeg: [0.9 * bend, 0, 0],
          rightLowerLeg: [0.9 * bend, 0, 0],
          leftFoot: [-0.4 * bend, 0, 0],
          rightFoot: [-0.4 * bend, 0, 0],
          spine: [0.12 * bend, 0, 0],
          head: [-0.1 * high, 0, 0],
        },
        face: { happy: 0.9, blink: 0.4 },
        look: [0, 0.1],
        // Crouched, she's lower by as much as her knees are bent.
        lift: up - 0.07 * bend,
      };
    },
  },
  // A treat in a hand to her mouth, a bite, then chewing, eyes shut, happy.
  eat: {
    span: 3.2,
    at: (u) => {
      const bite = step(u, 0) * (1 - step(u, 0.45));
      const chew = u > 0.6 && u < 2.8 ? Math.max(0, Math.sin((u - 0.6) * 11)) : 0;
      return {
        pose: {
          ...arm("right", [-0.9, -1.15, -0.62], [0, -2.5, 0]),
          ...hand("right", 0.6, 0.5),
          head: [0.08 - 0.12 * bite, 0, 0.06],
        },
        face: { happy: 0.8, blink: u > 0.6 ? 0.9 : 0.2, aa: 0.8 * bite + 0.35 * chew },
      };
    },
  },
  // The rest only the session plays, on purpose. A hand up by her head,
  // palm out, waving.
  wave: {
    span: 2.8,
    at: (u) => ({
      pose: {
        ...arm("right", [-1.57, -0.25, -0.2], [0, -1.65 + 0.3 * Math.sin(u * 9), 0]),
        ...hand("right", 0),
        head: [0, 0, 0.08],
      },
      face: { happy: 0.8 },
    }),
  },
  // A fist out in front of her, thumb up.
  thumbs: {
    span: 2.6,
    at: () => ({
      pose: { ...arm("right", [0, -0.45, -1.2], [0, -1.6, 0]), ...hand("right", 1, 1), head: [0, 0, 0.06] },
      face: { happy: 0.7, blink: 0.3 },
    }),
  },
  // Yes, twice.
  nod: {
    span: 1.6,
    at: (u) => {
      const n = Math.max(0, Math.sin(Math.min(1, u / 1.2) * Math.PI * 2));
      return { pose: { head: [0.22 * n, 0, 0], neck: [0.08 * n, 0, 0] }, face: { happy: 0.4 } };
    },
  },
  // From the waist, a hand to her chest.
  bow: {
    span: 2.6,
    at: (u) => {
      const b = smooth(u / 0.6) * (1 - smooth((u - 1.6) / 0.6));
      return {
        pose: {
          ...arm("right", [-0.9, -1.0, -0.9], [0, -2.0, 0]),
          spine: [0.35 * b, 0, 0],
          chest: [0.15 * b, 0, 0],
          head: [0.15 * b, 0, 0],
        },
        face: { blink: 0.8 * b, happy: 0.4 },
        look: [0, -0.2 * b],
      };
    },
  },
  // Shoulders up, palms up, head on one side: who knows?
  shrug: {
    span: 2.2,
    at: (_u, side) => ({
      pose: {
        ...arms([0, -0.25, -1.25], [0, -1.3, 0.2], [-1.4, 0, 0]),
        ...hand("left", 0.15),
        ...hand("right", 0.15),
        leftShoulder: [0, 0, 0.25],
        rightShoulder: [0, 0, -0.25],
        head: [0, 0, 0.18 * side],
      },
      face: { surprised: 0.3, happy: 0.2 },
    }),
  },
};

// How far into an act she is: in over a third of a second, out over half.
export function weight(u: number, span: number) {
  const w = Math.max(0, Math.min(1, u / 0.35, (span - u) / 0.5));
  return w * w * (3 - 2 * w);
}

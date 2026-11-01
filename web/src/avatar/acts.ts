// Little things the avatar does, each a pose held for a few seconds that the
// stage eases into and back out of: a huff with her hands on her hips, a
// stretch, a shift of weight, turning her nose up at you; flinching when
// she's poked and melting a little when her head is patted. Angles are
// VRM 1's (the stage flips them for a VRM 0 model), left side; side is
// which way she turns, 1 to her left.

import type { VRMHumanBoneName } from "@pixiv/three-vrm";

export type Pose = Partial<Record<VRMHumanBoneName, [number, number, number]>>;
export type Face = Partial<Record<"angry" | "happy" | "sad" | "surprised" | "blink", number>>;
export type Frame = { pose: Pose; face?: Face; look?: [number, number] };

export type ActName = "huff" | "snub" | "stretch" | "shift" | "flinch" | "pat";
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
};

// How far into an act she is: in over a third of a second, out over half.
export function weight(u: number, span: number) {
  const w = Math.max(0, Math.min(1, u / 0.35, (span - u) / 0.5));
  return w * w * (3 - 2 * w);
}

// The avatar itself: a VRM model (pixiv's three-vrm) from the chest up,
// facing you, drawn with three.js. Nothing is keyframed: it breathes, sways,
// blinks and looks at you; it moves its mouth to what the voice is saying
// and nods along; working, it looks off and up as if thinking; asking, it
// looks at you with its head on one side. Talking, its face follows the
// line (glad, sorry, asking) and its hands and shoulders move with it.

import { MToonMaterial, type VRM, VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { ACTS, type ActName, type Face, type Frame, type Pose, weight } from "./acts";
import { type Effect, Fx, type Head, type Touch } from "./fx";
import type { Mood as Tone, Viseme, Voice } from "./voice";

export type Mood = "idle" | "thinking" | "asking";

const VISEMES: Viseme[] = ["aa", "ih", "ou", "ee", "oh"];

// The clothes' color, lit and in shade; their painted texture is soft.
const CLOTH = new THREE.Color(0xc8102e);
const CLOTH_SHADE = new THREE.Color(0x6e0718);
// Blonde hair: its darkest strands, its lightest, and in shade.
const HAIR_DARK = new THREE.Color(0xb98a3e);
const HAIR_LIGHT = new THREE.Color(0xfff1c2);
const HAIR_SHADE = new THREE.Color(0xe0b878);
// The body's skin in shade; the model's own is barely darker than lit.
const SKIN_SHADE = new THREE.Color(0xd9a3ad);

type Feeling = "happy" | "sad" | "surprised" | "angry";
const FEELINGS: Feeling[] = ["happy", "sad", "surprised", "angry"];

// What a line sounds like it means, roughly.
function feeling(line: string): Feeling | null {
  if (/\b(sorry|unfortunately|fail(s|ed|ing)?|broken?|can't|cannot|couldn't|won't|wrong|lost)\b/i.test(line)) return "sad";
  if (/!/.test(line)) return "happy";
  if (/\?/.test(line)) return "surprised";
  return null;
}

// What the session said a line's mood is, on the face and in an act.
const MOOD_FEELING: Record<Tone, Feeling> = {
  happy: "happy",
  excited: "happy",
  teasing: "happy",
  shy: "happy",
  annoyed: "angry",
  sulky: "angry",
  sad: "sad",
  surprised: "surprised",
};
const MOOD_ACT: Partial<Record<Tone, ActName>> = {
  excited: "proud",
  teasing: "glance",
  annoyed: "huff",
  sulky: "snub",
  shy: "sway",
  surprised: "flinch",
};
// The marks over her for a line's mood, and for what she's doing.
const MOOD_FX: Record<Tone, Effect[]> = {
  happy: ["sparkle"],
  excited: ["sparkle", "note"],
  teasing: ["note"],
  shy: ["blush"],
  annoyed: ["vein"],
  sulky: ["scribble"],
  sad: ["gloom"],
  surprised: ["shock"],
};
const ACT_FX: Partial<Record<ActName, Effect>> = { huff: "vein", flinch: "shock", pat: "blush", proud: "sparkle" };

// Up and back down over a span of seconds, since a moment.
const swell = (since: number, span: number) => (since > 0 && since < span ? Math.sin((since / span) * Math.PI) : 0);

// A texture's shape only: white wherever it isn't see-through, for a
// cut-out material to be one color.
function silhouette(t: THREE.Texture): THREE.Texture {
  const img = t.image as CanvasImageSource & { width: number; height: number };
  const c = document.createElement("canvas");
  c.width = img.width;
  c.height = img.height;
  const g = c.getContext("2d")!;
  g.drawImage(img, 0, 0);
  g.globalCompositeOperation = "source-in";
  g.fillStyle = "#fff";
  g.fillRect(0, 0, c.width, c.height);
  const out = new THREE.CanvasTexture(c);
  out.flipY = t.flipY;
  out.colorSpace = t.colorSpace;
  out.wrapS = t.wrapS;
  out.wrapT = t.wrapT;
  return out;
}

// A texture with its most common colour turned to the one given, and the
// rest moved by as much, so what's drawn on it keeps its contrast.
function retone(t: THREE.Texture, to: THREE.Color): THREE.Texture {
  const img = t.image as CanvasImageSource & { width: number; height: number };
  const c = document.createElement("canvas");
  c.width = img.width;
  c.height = img.height;
  const g = c.getContext("2d")!;
  g.drawImage(img, 0, 0);
  const data = g.getImageData(0, 0, c.width, c.height);
  const px = data.data;
  const counts = new Map<number, number>();
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] < 8) continue;
    const k = ((px[i] >> 3) << 10) | ((px[i + 1] >> 3) << 5) | (px[i + 2] >> 3);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  let mode = 0;
  let most = 0;
  for (const [k, n] of counts) if (n > most) [mode, most] = [k, n];
  const base = [(mode >> 10) & 31, (mode >> 5) & 31, mode & 31].map((v) => v * 8 + 4);
  const want = to.clone().convertLinearToSRGB();
  const gain = [want.r, want.g, want.b].map((v, i) => (v * 255) / base[i]);
  for (let i = 0; i < px.length; i += 4) {
    px[i] = Math.min(255, px[i] * gain[0]);
    px[i + 1] = Math.min(255, px[i + 1] * gain[1]);
    px[i + 2] = Math.min(255, px[i + 2] * gain[2]);
  }
  g.putImageData(data, 0, 0);
  const out = new THREE.CanvasTexture(c);
  out.flipY = t.flipY;
  out.colorSpace = t.colorSpace;
  out.wrapS = t.wrapS;
  out.wrapT = t.wrapT;
  return out;
}

// A texture recolored from dark to light by its own lightness, the
// darkest of it dark and the lightest light; see-through stays so.
function recolor(t: THREE.Texture, dark: THREE.Color, light: THREE.Color): THREE.Texture {
  const img = t.image as CanvasImageSource & { width: number; height: number };
  const c = document.createElement("canvas");
  c.width = img.width;
  c.height = img.height;
  const g = c.getContext("2d")!;
  g.drawImage(img, 0, 0);
  const data = g.getImageData(0, 0, c.width, c.height);
  const px = data.data;
  let lo = 255;
  let hi = 0;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] < 8) continue;
    const l = 0.3 * px[i] + 0.59 * px[i + 1] + 0.11 * px[i + 2];
    lo = Math.min(lo, l);
    hi = Math.max(hi, l);
  }
  const span = Math.max(1, hi - lo);
  const [d, l] = [dark, light].map((k) => k.clone().convertLinearToSRGB());
  for (let i = 0; i < px.length; i += 4) {
    const u = (0.3 * px[i] + 0.59 * px[i + 1] + 0.11 * px[i + 2] - lo) / span;
    px[i] = (d.r + (l.r - d.r) * u) * 255;
    px[i + 1] = (d.g + (l.g - d.g) * u) * 255;
    px[i + 2] = (d.b + (l.b - d.b) * u) * 255;
  }
  g.putImageData(data, 0, 0);
  const out = new THREE.CanvasTexture(c);
  out.flipY = t.flipY;
  out.colorSpace = t.colorSpace;
  out.wrapS = t.wrapS;
  out.wrapT = t.wrapT;
  return out;
}

// Toward target at rate (per second), whatever the frame time.
const ease = (from: number, to: number, rate: number, dt: number) => from + (to - from) * (1 - Math.exp(-rate * dt));

export class Stage {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(28, 1, 0.1, 20);
  private clock = new THREE.Clock();
  private vrm?: VRM;
  private gaze = new THREE.Object3D();
  private headY = 1.4;
  private frame = 0;
  private t = 0;
  private blinkAt = 2;
  private mouth: Record<Viseme, number> = { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 };
  private nod = 0;
  private lastMark = 0;
  private look = new THREE.Vector2();
  private tilt = 0;
  private smile = 0;
  private line = "";
  private feel: Record<Feeling, number> = { happy: 0, sad: 0, surprised: 0, angry: 0 };
  private felt: Feeling | null = null;
  private beatAt = -10;
  private beatSide = 1;
  private shrugAt = -10;
  private dart = new THREE.Vector2();
  private dartAt = 1;
  // What it's doing now, if anything, and after.
  private acts: ActName[] = [];
  // What she does now and then when left alone: her persona's.
  idle: ActName[] = ["shift", "stretch", "fold", "yawn", "glance", "sway"];
  private actAt = 0;
  private side = 1;
  private act?: Frame;
  private actWeight = 0;
  private idleAt = 6;
  // Where the pointer is over it, in the camera's -1 to 1.
  private pointer?: THREE.Vector2;
  private ray = new THREE.Raycaster();
  private cheeks: THREE.Object3D[] = [];
  private fx?: Fx;
  private size = { w: 0, h: 0 };
  mood: Mood = "idle";
  private was: Mood = "idle";

  constructor(
    private canvas: HTMLCanvasElement,
    private voice: Voice,
    marks?: HTMLCanvasElement,
  ) {
    if (marks) this.fx = new Fx(marks);
    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // A warm key from above one side, a cool fill from the other, and one
    // from behind for an edge on the hair and shoulders.
    const key = new THREE.DirectionalLight(0xfff1e0, Math.PI * 0.55);
    key.position.set(1.6, 1.5, 1.2);
    const fill = new THREE.DirectionalLight(0xd8e4ff, Math.PI * 0.12);
    fill.position.set(-1.5, 0.6, 1.5);
    const back = new THREE.DirectionalLight(0xffffff, Math.PI * 0.3);
    back.position.set(-0.5, 1.5, -2);
    this.scene.add(key, fill, back, new THREE.AmbientLight(0xffffff, 0.22), this.camera, this.gaze);
    const loop = () => {
      this.frame = requestAnimationFrame(loop);
      this.tick(Math.min(this.clock.getDelta(), 0.1));
    };
    loop();
  }

  // The model; the sample's clothes and hair are recolored, anyone else's
  // are as they made them. Its skin is the colour given, if one is.
  async load(source: string | ArrayBuffer, sample = false, skin?: string) {
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));
    const gltf = typeof source === "string" ? await loader.loadAsync(source) : await loader.parseAsync(source, "");
    const vrm = gltf.userData.vrm as VRM | undefined;
    if (!vrm) throw new Error("not a VRM model");
    VRMUtils.removeUnnecessaryVertices(gltf.scene);
    VRMUtils.combineSkeletons(gltf.scene);
    VRMUtils.rotateVRM0(vrm);
    // VRoid's exports ask for no mipmaps, so its 2K textures drawn a few
    // hundred pixels across shimmer and look low-resolution.
    const anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    const tone = skin ? new THREE.Color(skin) : null;
    const toned = new Map<unknown, THREE.Texture>();
    vrm.scene.traverse((o) => {
      o.frustumCulled = false;
      for (const m of [(o as THREE.Mesh).material ?? []].flat()) {
        if (m instanceof MToonMaterial) {
          if (sample && /CLOTH/.test(m.name) && m.map) {
            m.map = m.shadeMultiplyTexture = silhouette(m.map);
            m.color.copy(CLOTH);
            m.shadeColorFactor.copy(CLOTH_SHADE);
          }
          if (sample && /HAIR/.test(m.name) && m.map) {
            m.map = m.shadeMultiplyTexture = recolor(m.map, HAIR_DARK, HAIR_LIGHT);
            m.color.setRGB(1, 1, 1);
            m.shadeColorFactor.copy(HAIR_SHADE);
          }
          // Harder-edged shade, and on the body a deeper one, with its
          // modelled detail (navel, collarbones) brought out.
          m.shadingToonyFactor = 0.95;
          if (/Body.*SKIN/.test(m.name)) {
            // Unless it's clothed, with its own shade painted.
            if (m.shadeMultiplyTexture?.source === m.map?.source) m.shadeColorFactor.copy(SKIN_SHADE);
            m.shadingShiftFactor = -0.2;
            m.normalScale.setScalar(2.5);
          }
          if (tone && /_SKIN/.test(m.name) && m.map) {
            const source = m.map.source;
            if (!toned.has(source)) toned.set(source, retone(m.map, tone));
            if (m.shadeMultiplyTexture?.source === source) m.shadeMultiplyTexture = toned.get(source)!;
            m.map = toned.get(source)!;
          }
          // A soft light at the silhouette's edge.
          m.parametricRimColorFactor.setRGB(0.35, 0.35, 0.4);
          m.parametricRimFresnelPowerFactor = 4;
          m.parametricRimLiftFactor = 0;
          m.rimLightingMixFactor = 1;
        }
        const uniforms = Object.values((m as THREE.ShaderMaterial).uniforms ?? {}).map((u) => u.value);
        for (const t of [...Object.values(m), ...uniforms]) {
          if (!(t instanceof THREE.Texture)) continue;
          t.minFilter = THREE.LinearMipmapLinearFilter;
          t.generateMipmaps = true;
          t.anisotropy = anisotropy;
          t.needsUpdate = true;
        }
      }
    });
    if (this.vrm) {
      this.scene.remove(this.vrm.scene);
      VRMUtils.deepDispose(this.vrm.scene);
    }
    this.vrm = vrm;
    this.scene.add(vrm.scene);
    if (vrm.lookAt) vrm.lookAt.target = this.gaze;
    vrm.update(0);
    const head = vrm.humanoid.getNormalizedBoneNode("head");
    this.headY = head ? head.getWorldPosition(new THREE.Vector3()).y : 1.4;
    this.cheeks = this.findCheeks(vrm);
    this.fit();
  }

  // Points on its cheeks' skin, carried by its head: a little out from and
  // below its eyes, where a ray from in front first meets something that
  // isn't hair.
  private findCheeks(vrm: VRM): THREE.Object3D[] {
    const head = vrm.humanoid.getRawBoneNode("head");
    const left = vrm.humanoid.getRawBoneNode("leftEye");
    const right = vrm.humanoid.getRawBoneNode("rightEye");
    if (!head || !left || !right) return [];
    vrm.scene.updateMatrixWorld(true);
    const [l, r] = [left, right].map((n) => n.getWorldPosition(new THREE.Vector3()));
    const mid = l.clone().add(r).multiplyScalar(0.5);
    const out = r.clone().sub(l).setY(0).normalize();
    return [-1, 1].flatMap((side) => {
      const at = mid.clone().addScaledVector(out, side * 0.042).add(new THREE.Vector3(0, -0.038, 1));
      this.ray.set(at, new THREE.Vector3(0, 0, -1));
      const hit = this.ray
        .intersectObject(vrm.scene, true)
        .find((h) => ![(h.object as THREE.Mesh).material].flat().some((m) => /HAIR/i.test(m.name)));
      if (!hit) return [];
      const cheek = new THREE.Object3D();
      cheek.position.copy(head.worldToLocal(hit.point.clone()));
      head.add(cheek);
      return [cheek];
    });
  }

  resize(w: number, h: number) {
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.size = { w, h };
    this.fx?.resize(w, h);
    this.camera.aspect = w / h;
    this.fit();
  }

  dispose() {
    cancelAnimationFrame(this.frame);
    if (this.vrm) VRMUtils.deepDispose(this.vrm.scene);
    this.renderer.dispose();
  }

  // The head and shoulders, whatever the window's shape.
  private fit() {
    const half = THREE.MathUtils.degToRad(this.camera.fov / 2);
    const tall = 0.72 / 2 / Math.tan(half);
    const wide = 0.62 / 2 / Math.tan(half) / this.camera.aspect;
    const y = this.headY - 0.08;
    this.camera.position.set(0, y + 0.02, Math.max(tall, wide));
    this.camera.lookAt(0, y, 0);
    this.camera.updateProjectionMatrix();
  }

  // Things to do, one after another, now (whatever it was doing).
  play(...acts: ActName[]) {
    this.acts = acts;
    this.actAt = this.t;
    this.side = Math.random() < 0.5 ? 1 : -1;
  }

  // A hand at the pointer: patting her head, or poking.
  touch(kind: Touch, at: { x: number; y: number }) {
    this.fx?.put(kind, ((at.x + 1) / 2) * this.size.w, ((1 - at.y) / 2) * this.size.h, this.t);
  }

  // Its eyes on the pointer, or (null) not.
  point(at: { x: number; y: number } | null) {
    this.pointer = at ? new THREE.Vector2(at.x, at.y) : undefined;
  }

  // What's under the pointer at: its head (or hair), the rest of it, or
  // nothing.
  hit(at: { x: number; y: number }): "head" | "body" | null {
    if (!this.vrm) return null;
    this.ray.setFromCamera(new THREE.Vector2(at.x, at.y), this.camera);
    const [first] = this.ray.intersectObject(this.vrm.scene, true);
    if (!first) return null;
    const neck = this.vrm.humanoid.getNormalizedBoneNode("neck");
    const y = neck ? neck.getWorldPosition(new THREE.Vector3()).y : this.headY - 0.1;
    return first.point.y > y ? "head" : "body";
  }

  private tick(dt: number) {
    this.t += dt;
    const vrm = this.vrm;
    if (vrm) {
      this.pose(vrm, dt);
      this.face(vrm, dt);
      vrm.update(dt);
    }
    this.renderer.render(this.scene, this.camera);
    if (this.fx) {
      const tone = this.voice.speaking ? this.voice.mood : undefined;
      const want = new Set(tone ? MOOD_FX[tone] : []);
      const acting = this.acts.length && this.actWeight > 0.3 && ACT_FX[this.acts[0]];
      if (acting) want.add(acting);
      this.fx.draw([...want], vrm && this.head(vrm), this.t, dt);
    }
  }

  // Where its face is on the screen, for the marks: between its eyes, or a
  // little in front of its head without them.
  private head(vrm: VRM): Head | undefined {
    const { w, h } = this.size;
    const on = (v: THREE.Vector3) => {
      v.project(this.camera);
      return new THREE.Vector2(((v.x + 1) / 2) * w, ((1 - v.y) / 2) * h);
    };
    const left = vrm.humanoid.getRawBoneNode("leftEye");
    const right = vrm.humanoid.getRawBoneNode("rightEye");
    if (left && right) {
      // Hers, so on your right.
      const l = left.getWorldPosition(new THREE.Vector3());
      const r = right.getWorldPosition(new THREE.Vector3());
      const apart = l.distanceTo(r);
      const [a, b] = [on(l), on(r)];
      const mid = a.clone().add(b).multiplyScalar(0.5);
      const roll = Math.atan2(a.y - b.y, a.x - b.x);
      const unit = (a.distanceTo(b) / Math.max(apart, 0.01)) * 0.1;
      // Its cheeks in the marks' tenths of a metre, as they're turned.
      const cheeks = this.cheeks.map((c) => {
        const p = on(c.getWorldPosition(new THREE.Vector3())).sub(mid).rotateAround(new THREE.Vector2(), -roll);
        return [p.x / unit, p.y / unit] as [number, number];
      });
      return { x: mid.x, y: mid.y, roll, unit, cheeks: cheeks.length === 2 ? cheeks : undefined };
    }
    const head = vrm.humanoid.getRawBoneNode("head");
    if (!head) return undefined;
    const p = head.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0, 0.07, 0.05));
    const c = on(p.clone());
    const d = on(p.add(new THREE.Vector3(0.1, 0, 0)));
    return { x: c.x, y: c.y, roll: 0, unit: c.distanceTo(d) };
  }

  private bone(vrm: VRM, name: Parameters<VRM["humanoid"]["getNormalizedBoneNode"]>[0]) {
    return vrm.humanoid.getNormalizedBoneNode(name);
  }

  private pose(vrm: VRM, dt: number) {
    const t = this.t;
    const talking = this.voice.speaking;
    // A nod at each new word, now and then.
    if (talking) {
      const at = Math.floor(this.voice.at());
      if (at !== this.lastMark && /\s/.test(this.voice.text[at] ?? "") && Math.random() < 0.18) this.nod = 1;
      this.lastMark = at;
    }
    this.nod = ease(this.nod, 0, 4, dt);
    // Each new line: now and then a beat of one hand, one side then the
    // other; a shrug on a question; and a feeling for the face.
    if (this.voice.text !== this.line) {
      this.line = this.voice.text;
      const tone = this.voice.mood;
      this.felt = tone ? MOOD_FEELING[tone] : feeling(this.line);
      const act = tone && MOOD_ACT[tone];
      if (this.line && act && !this.acts.length) this.play(act);
      if (this.line && Math.random() < 0.6) {
        this.beatAt = t;
        this.beatSide = -this.beatSide;
      }
      if (/\?\s*$/.test(this.line) && Math.random() < 0.5) this.shrugAt = t;
    }
    const beat = swell(t - this.beatAt, 0.9) * 0.45;
    const shrug = swell(t - this.shrugAt, 1.1) * 0.15;
    // Its eyes flick about a little, as eyes do.
    if (t > this.dartAt) {
      this.dartAt = t + 0.6 + Math.random() * 2.5;
      if (Math.random() < 0.4) this.dart.set(0, 0);
      else this.dart.set((Math.random() - 0.5) * 0.08, (Math.random() - 0.5) * 0.05);
    }

    const thinking = this.mood === "thinking" && !talking;
    const asking = this.mood === "asking" && !talking;
    this.tilt = ease(this.tilt, asking ? 0.12 : thinking ? -0.06 : 0, 3, dt);

    // Done working: pleased with herself.
    if (this.was === "thinking" && this.mood === "idle" && !this.acts.length) this.play("proud");
    this.was = this.mood;
    // Quiet, now and then she does something: left alone, whatever she
    // likes; thinking, a hand to her chin; waiting on you, arms folded.
    if (talking || this.acts.length) this.idleAt = Math.max(this.idleAt, t + 4);
    else if (t > this.idleAt) {
      this.idleAt = t + 9 + Math.random() * 12;
      const pick: ActName[] =
        this.mood === "thinking"
          ? ["ponder"]
          : this.mood === "asking"
            ? ["fold", "glance"]
            : this.idle;
      if (pick.length) this.play(pick[Math.floor(Math.random() * pick.length)]);
    }
    let since = t - this.actAt;
    while (this.acts.length && since > ACTS[this.acts[0]].span) {
      this.actAt += ACTS[this.acts.shift()!].span;
      since = t - this.actAt;
    }
    this.act = this.acts.length ? ACTS[this.acts[0]].at(since, this.side) : undefined;
    this.actWeight = this.acts.length ? weight(since, ACTS[this.acts[0]].span) : 0;
    const w = this.actWeight;

    // Where to look: the pointer if it's over it, else off and up while it
    // thinks, else you; or wherever the act has it looking.
    const away = thinking ? new THREE.Vector2(0.35 + 0.1 * Math.sin(t * 0.4), 0.25) : new THREE.Vector2(0, 0);
    const pointed = this.pointed();
    if (pointed) away.copy(pointed);
    if (this.act?.look) away.lerp(new THREE.Vector2(...this.act.look), w);
    const rate = pointed && !this.act?.look ? 5 : 2;
    this.look.set(ease(this.look.x, away.x, rate, dt), ease(this.look.y, away.y, rate, dt));

    const breath = Math.sin(t * 1.6);
    const pose: Pose = {};
    const set = (name: keyof Pose, x: number, y: number, z: number) => {
      pose[name] = [x, y, z];
    };
    set("spine", breath * 0.015, Math.sin(t * 0.5) * 0.03, Math.sin(t * 0.7) * 0.015);
    set("chest", breath * 0.02, 0, 0);
    set(
      "neck",
      this.nod * 0.08 + (talking ? Math.sin(t * 2.3) * 0.02 : 0),
      Math.sin(t * 0.6) * 0.04 + this.look.x * 0.25,
      this.tilt * 0.5,
    );
    set(
      "head",
      this.nod * 0.12 - this.look.y * 0.25 + (talking ? Math.sin(t * 3.1) * 0.025 : 0),
      Math.sin(t * 0.45) * 0.05 + this.look.x * 0.3,
      this.tilt + Math.sin(t * 0.3) * 0.02,
    );
    // Arms down from the T-pose, a little apart, moving with the breath;
    // talking, a little more.
    const lift = talking ? 0.06 * Math.sin(t * 1.9) : 0;
    set("leftUpperArm", 0, -0.12, -1.32 + breath * 0.02 + lift);
    set("rightUpperArm", 0, 0.12, 1.32 - breath * 0.02 - lift * 0.7);
    set("leftLowerArm", -0.45, -0.4 - (this.beatSide < 0 ? beat : 0), -0.1);
    set("rightLowerArm", -0.45, 0.4 + (this.beatSide > 0 ? beat : 0), 0.1);
    // Hands at rest: the fingers curled a little, more toward the little
    // finger, the thumb in.
    for (const [side, d] of [["left", -1], ["right", 1]] as const) {
      for (const [finger, curl] of [["Index", 0.35], ["Middle", 0.42], ["Ring", 0.5], ["Little", 0.58]] as const) {
        set(`${side}${finger}Proximal`, 0, 0, d * curl);
        set(`${side}${finger}Intermediate`, 0, 0, d * curl * 1.3);
        set(`${side}${finger}Distal`, 0, 0, d * curl * 0.8);
      }
      set(`${side}ThumbMetacarpal`, 0, -d * 0.3, 0);
      set(`${side}ThumbProximal`, 0, -d * 0.25, 0);
      set(`${side}ThumbDistal`, 0, -d * 0.2, 0);
    }
    set("leftShoulder", 0, 0, breath * 0.01 + shrug);
    set("rightShoulder", 0, 0, -breath * 0.01 - shrug);

    // The act's pose over all that, as far into it as it is. A VRM 0
    // model's normalized bones turn the other way about x and z.
    const s = vrm.meta?.metaVersion === "0" ? -1 : 1;
    const names = new Set([...Object.keys(pose), ...Object.keys(this.act?.pose ?? {})] as (keyof Pose)[]);
    for (const name of names) {
      const [x, y, z] = pose[name] ?? [0, 0, 0];
      const to = this.act?.pose[name];
      const [ax, ay, az] = to ? [x + (to[0] - x) * w, y + (to[1] - y) * w, z + (to[2] - z) * w] : [x, y, z];
      // An upper arm turns about itself first, so x is a twist.
      this.bone(vrm, name)?.rotation.set(ax * s, ay, az * s, name.endsWith("UpperArm") ? "YZX" : "XYZ");
    }
    vrm.scene.position.y = (this.act?.lift ?? 0) * w;

    // Its eyes: the camera, or off from it wherever it's looking.
    const eyes = this.look.clone().add(this.dart).multiplyScalar(1.5);
    this.gaze.position.copy(this.camera.position).add(new THREE.Vector3(eyes.x, eyes.y, 0));
  }

  // How far to turn its head (in look's terms) to face the pointer: by how
  // far the pointer is from its face on the screen, so it turns as far as
  // looks right however close the camera is.
  private pointed() {
    if (!this.pointer) return undefined;
    const face = new THREE.Vector3(0, this.headY, 0).project(this.camera);
    return new THREE.Vector2(
      THREE.MathUtils.clamp((this.pointer.x - face.x) * 0.8, -0.8, 0.8),
      THREE.MathUtils.clamp((this.pointer.y - face.y) * 0.8, -0.6, 0.6),
    );
  }

  private face(vrm: VRM, dt: number) {
    const ex = vrm.expressionManager;
    if (!ex) return;
    // A blink every few seconds, now and then two.
    let blink = 0;
    const since = this.t - this.blinkAt;
    if (since > 0) {
      blink = Math.sin(Math.min(since / 0.16, 1) * Math.PI);
      if (since > 0.16) this.blinkAt = this.t + (Math.random() < 0.15 ? 0.2 : 2 + Math.random() * 4);
    }
    // The act's face over its own (and no other feeling).
    const w = this.actWeight;
    const acted = (name: keyof Face, own: number) => {
      const face = this.act?.face;
      const to = face?.[name] ?? (face && name !== "blink" ? 0 : undefined);
      return to === undefined ? own : own + (to - own) * w;
    };
    ex.setValue("blink", acted("blink", blink));

    const [shape, open] = this.voice.mouth();
    for (const v of VISEMES) {
      this.mouth[v] = ease(this.mouth[v], v === shape ? open : 0, 22, dt);
      ex.setValue(v, v === "aa" && this.act?.face?.aa !== undefined ? this.mouth[v] + (this.act.face.aa - this.mouth[v]) * w : this.mouth[v]);
    }
    this.smile = ease(this.smile, this.voice.speaking ? 0.25 : this.mood === "idle" ? 0.15 : 0, 2, dt);
    const felt = this.voice.speaking ? this.felt : null;
    for (const f of FEELINGS) this.feel[f] = ease(this.feel[f], f === felt ? 1 : 0, 3, dt);
    ex.setValue("happy", acted("happy", this.smile + this.feel.happy * 0.6));
    ex.setValue("sad", acted("sad", this.feel.sad * 0.45));
    ex.setValue("angry", acted("angry", this.feel.angry * 0.5));
    // VRoid's surprise is a custom expression, not the preset.
    const surprised = acted("surprised", (this.mood === "asking" && !this.voice.speaking ? 0.2 : 0) + this.feel.surprised * 0.45);
    if (ex.getExpression("Surprised")) ex.setValue("Surprised", surprised);
    else ex.setValue("surprised", surprised);
  }
}

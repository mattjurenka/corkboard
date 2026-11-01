// The avatar itself: a VRM model (pixiv's three-vrm) from the chest up,
// facing you, drawn with three.js. Nothing is keyframed: it breathes, sways,
// blinks and looks at you; it moves its mouth to what the voice is saying
// and nods along; working, it looks off and up as if thinking; asking, it
// looks at you with its head on one side. Talking, its face follows the
// line (glad, sorry, asking) and its hands and shoulders move with it.

import { MToonMaterial, type VRM, VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import type { Viseme, Voice } from "./voice";

export type Mood = "idle" | "thinking" | "asking";

const VISEMES: Viseme[] = ["aa", "ih", "ou", "ee", "oh"];

// The clothes' color, lit and in shade; their painted texture is soft.
const CLOTH = new THREE.Color(0xc8102e);
const CLOTH_SHADE = new THREE.Color(0x6e0718);
// The body's skin in shade; the model's own is barely darker than lit.
const SKIN_SHADE = new THREE.Color(0xd9a3ad);

type Feeling = "happy" | "sad" | "surprised";
const FEELINGS: Feeling[] = ["happy", "sad", "surprised"];

// What a line sounds like it means, roughly.
function feeling(line: string): Feeling | null {
  if (/\b(sorry|unfortunately|fail(s|ed|ing)?|broken?|can't|cannot|couldn't|won't|wrong|lost)\b/i.test(line)) return "sad";
  if (/!/.test(line)) return "happy";
  if (/\?/.test(line)) return "surprised";
  return null;
}

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
  private feel: Record<Feeling, number> = { happy: 0, sad: 0, surprised: 0 };
  private felt: Feeling | null = null;
  private beatAt = -10;
  private beatSide = 1;
  private shrugAt = -10;
  private dart = new THREE.Vector2();
  private dartAt = 1;
  mood: Mood = "idle";

  constructor(
    private canvas: HTMLCanvasElement,
    private voice: Voice,
  ) {
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

  async load(source: string | ArrayBuffer) {
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
    vrm.scene.traverse((o) => {
      o.frustumCulled = false;
      for (const m of [(o as THREE.Mesh).material ?? []].flat()) {
        if (m instanceof MToonMaterial) {
          if (/CLOTH/.test(m.name) && m.map) {
            m.map = m.shadeMultiplyTexture = silhouette(m.map);
            m.color.copy(CLOTH);
            m.shadeColorFactor.copy(CLOTH_SHADE);
          }
          // Harder-edged shade, and on the body a deeper one, with its
          // modelled detail (navel, collarbones) brought out.
          m.shadingToonyFactor = 0.95;
          if (/Body.*SKIN/.test(m.name)) {
            m.shadeColorFactor.copy(SKIN_SHADE);
            m.shadingShiftFactor = -0.2;
            m.normalScale.setScalar(2.5);
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
    this.fit();
  }

  resize(w: number, h: number) {
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
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

  private tick(dt: number) {
    this.t += dt;
    const vrm = this.vrm;
    if (vrm) {
      this.pose(vrm, dt);
      this.face(vrm, dt);
      vrm.update(dt);
    }
    this.renderer.render(this.scene, this.camera);
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
      this.felt = feeling(this.line);
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
    const away = thinking ? new THREE.Vector2(0.35 + 0.1 * Math.sin(t * 0.4), 0.25) : new THREE.Vector2(0, 0);
    this.look.set(ease(this.look.x, away.x, 2, dt), ease(this.look.y, away.y, 2, dt));

    const breath = Math.sin(t * 1.6);
    // A VRM 0 model's normalized bones turn the other way about x and z.
    const s = vrm.meta?.metaVersion === "0" ? -1 : 1;
    const set = (name: Parameters<VRM["humanoid"]["getNormalizedBoneNode"]>[0], x: number, y: number, z: number) => {
      const b = this.bone(vrm, name);
      if (b) b.rotation.set(x * s, y, z * s);
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

    // Its eyes: the camera, or off and up while it thinks.
    const eyes = this.look.clone().add(this.dart).multiplyScalar(1.5);
    this.gaze.position.copy(this.camera.position).add(new THREE.Vector3(eyes.x, eyes.y, 0));
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
    ex.setValue("blink", blink);

    const [shape, open] = this.voice.mouth();
    for (const v of VISEMES) {
      this.mouth[v] = ease(this.mouth[v], v === shape ? open : 0, 22, dt);
      ex.setValue(v, this.mouth[v]);
    }
    this.smile = ease(this.smile, this.voice.speaking ? 0.25 : this.mood === "idle" ? 0.15 : 0, 2, dt);
    const felt = this.voice.speaking ? this.felt : null;
    for (const f of FEELINGS) this.feel[f] = ease(this.feel[f], f === felt ? 1 : 0, 3, dt);
    ex.setValue("happy", this.smile + this.feel.happy * 0.6);
    ex.setValue("sad", this.feel.sad * 0.45);
    // VRoid's surprise is a custom expression, not the preset.
    const surprised = (this.mood === "asking" && !this.voice.speaking ? 0.2 : 0) + this.feel.surprised * 0.45;
    if (ex.getExpression("Surprised")) ex.setValue("Surprised", surprised);
    else ex.setValue("surprised", surprised);
  }
}

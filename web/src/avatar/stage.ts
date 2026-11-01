// The avatar itself: a VRM model (pixiv's three-vrm) from the chest up,
// facing you, drawn with three.js. Nothing is keyframed: it breathes, sways,
// blinks and looks at you; it moves its mouth to what the voice is saying
// and nods along; working, it looks off and up as if thinking; asking, it
// looks at you with its head on one side.

import { type VRM, VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import type { Viseme, Voice } from "./voice";

export type Mood = "idle" | "thinking" | "asking";

const VISEMES: Viseme[] = ["aa", "ih", "ou", "ee", "oh"];

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
  mood: Mood = "idle";

  constructor(
    private canvas: HTMLCanvasElement,
    private voice: Voice,
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    const sun = new THREE.DirectionalLight(0xffffff, Math.PI * 0.9);
    sun.position.set(0.5, 1.5, 2);
    this.scene.add(sun, new THREE.AmbientLight(0xffffff, 0.6), this.camera, this.gaze);
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
    vrm.scene.traverse((o) => (o.frustumCulled = false));
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
    set("leftUpperArm", 0, 0, -1.2 + breath * 0.02 + lift);
    set("rightUpperArm", 0, 0, 1.2 - breath * 0.02 - lift * 0.7);
    set("leftLowerArm", 0, -0.25, -0.1);
    set("rightLowerArm", 0, 0.25, 0.1);
    set("leftShoulder", 0, 0, breath * 0.01);
    set("rightShoulder", 0, 0, -breath * 0.01);

    // Its eyes: the camera, or off and up while it thinks.
    this.gaze.position.copy(this.camera.position).add(new THREE.Vector3(this.look.x * 1.5, this.look.y * 1.5, 0));
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
    ex.setValue("happy", this.smile);
    ex.setValue("surprised", this.mood === "asking" && !this.voice.speaking ? 0.2 : 0);
  }
}

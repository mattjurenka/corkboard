// portrait.html: ?persona=<id>'s model on a stage, at rest, posted back as
// a PNG to portraits.ts once its hair has settled.

import { modelAt, persona } from "./personas";
import { Stage } from "./stage";
import { Voice } from "./voice";

const id = new URLSearchParams(location.search).get("persona")!;
const canvas = document.querySelector("canvas")!;
const stage = new Stage(canvas, new Voice());
stage.idle = [];
stage.resize(480, 600);
const p = persona(id);
await stage.load(new URL(modelAt(p), location.href).href, p.recolor);
await new Promise((r) => setTimeout(r, 2000));
// Drawn and read in one go: the canvas is cleared once it's shown.
const s = stage as unknown as { renderer: { render(a: unknown, b: unknown): void }; scene: unknown; camera: unknown };
s.renderer.render(s.scene, s.camera);
const png = await new Promise<Blob>((r) => canvas.toBlob((b) => r(b!), "image/png"));
await fetch(`/__portrait?persona=${id}`, { method: "POST", body: png });

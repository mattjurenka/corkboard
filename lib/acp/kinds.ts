// The ACP kinds, by agent/<kind>.lua's name: how each is run, for the
// bridge (bridge/acp.ts) and a fleet slot's guest (fleet/guest/acp.ts).

import type { McpServer, Spec } from "./client";
import { opencode, type ClaudeMcp } from "./opencode";
import { gemini } from "./gemini";
import { codex } from "./codex";
import type { Model } from "../think";

export type KindOptions = {
  // corkboard's system prompt, which a kind may write under dir as name.
  prompt?: string;
  dir: string;
  name: string;
  // Claude Code --mcp-config values, and ACP-shaped servers (corkboard-ui).
  mcp?: ClaudeMcp[];
  servers?: McpServer[];
  model?: Model;
  key?: string;
};

export const KINDS: Record<string, (o: KindOptions) => Spec> = {
  opencode,
  gemini,
  codex,
};

// Kinds whose session/load is advertised but doesn't work: gemini 0.47.0
// writes a fresh start over the session before it reads it.
export const NO_RESUME = new Set(["gemini"]);

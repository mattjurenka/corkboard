// Key sequences in Neovim's notation as this machine writes them: ⌘⇧P on a
// Mac, Ctrl+Shift+P elsewhere, <leader> as the leader key.

import { MAC } from "@/nvim/input.js";

const MODS: Record<string, [mac: string, other: string]> = {
  C: ["⌃", "Ctrl+"],
  A: ["⌥", "Alt+"],
  M: ["⌥", "Alt+"],
  D: ["⌘", "Cmd+"],
  S: ["⇧", "Shift+"],
};
const NAMES: Record<string, string> = {
  CR: "Enter", Esc: "Esc", BS: "Backspace", Del: "Delete", Space: "Space", Tab: "Tab",
  lt: "<", Bslash: "\\", Bar: "|", Left: "←", Right: "→", Up: "↑", Down: "↓",
  k0: "Numpad0",
};

function chord(token: string, leader: string): string {
  if (token.toLowerCase() === "<leader>") return leader === " " ? "Space" : leader;
  if (token === " ") return "Space";
  const m = /^<((?:[CAMDS]-)*)(.+)>$/i.exec(token);
  if (!m) return token;
  const mods = m[1].toUpperCase().split("-").filter(Boolean);
  let key = m[2];
  // Neovim writes Shift on a letter as the capital (<D-P>), and a Ctrl
  // chord's letter as a capital whether shifted or not (<C-T>).
  if (/^[A-Z]$/.test(key) && mods.length && !mods.includes("S") && !mods.includes("C")) mods.push("S");
  if (/^[a-z]$/.test(key) && mods.length) key = key.toUpperCase();
  key = NAMES[key] ?? key;
  mods.sort((a, b) => "CAMSD".indexOf(a) - "CAMSD".indexOf(b));
  return mods.map((x) => MODS[x][MAC ? 0 : 1]).join("") + key;
}

export function prettyKeys(lhs: string, leader = "\\"): string {
  return (lhs.match(/<[^<>]+>|./g) ?? []).map((t) => chord(t, leader)).join(" ");
}

// The one of a binding's keys to show for it here: a Cmd chord on a Mac,
// any other elsewhere.
export function keysFor(keys: string[] | undefined): string | undefined {
  if (!keys) return undefined;
  const cmd = (k: string) => /^<(?:[CAMS]-)*D-/i.test(k);
  return keys.find((k) => cmd(k) === MAC) ?? keys.find((k) => !cmd(k));
}

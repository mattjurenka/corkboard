// Browser keyboard and mouse events to Neovim input.

const SPECIAL = {
  Enter: "CR", Escape: "Esc", Backspace: "BS", Tab: "Tab", Delete: "Del",
  Insert: "Insert", Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown",
  ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
};
for (let i = 1; i <= 12; i++) SPECIAL[`F${i}`] = `F${i}`;

// KeyboardEvent to Neovim key notation, or null when the key is not ours
// (a lone modifier, a dead key, composition).
export function toNvimKey(e) {
  if (e.isComposing || e.key === "Dead") return null;
  // Alt+digit, which goes to a tab by number: e.key may be a symbol the
  // layout puts on Alt+digit (macOS "¡" for 1), so read the key.
  const digit = /^Digit(\d)$/.exec(e.code);
  if (digit && e.altKey && !e.ctrlKey && !e.shiftKey && !e.metaKey) return `<A-${digit[1]}>`;
  let key = SPECIAL[e.key];
  const special = key !== undefined;
  if (!special) {
    key = e.key === "Unidentified" ? fromCode(e.code) : e.key;
    if (key === null || [...key].length !== 1) return null;
  }

  const mods = [];
  if (e.ctrlKey) mods.push("C");
  if (e.altKey) mods.push("A");
  if (e.metaKey) mods.push("D");
  // Shift on a printable key is already in e.key ("A", "?"), except with
  // Ctrl on a letter: Neovim reads <C-P> as <C-p>, so send <C-S-p>, which
  // falls back to <C-p> when nothing maps it.
  if (e.shiftKey && (special || (e.ctrlKey && /^[a-z]$/i.test(key)))) {
    mods.push("S");
    if (!special) key = key.toLowerCase();
  }

  if (key === "<") key = "lt";
  else if (key === " " && mods.length) key = "Space";
  else if (key === "\\" && mods.length) key = "Bslash";

  if (!special && mods.length === 0) return key === "lt" ? "<lt>" : key;
  return `<${[...mods, key].join("-")}>`;
}

// Under Wayland, Chromium reports a Ctrl chord whose character xkb maps to a
// control code (Ctrl+Space and Ctrl+` are both NUL) as key "Unidentified";
// the physical key still says what was pressed.
function fromCode(code) {
  if (code === "Space") return " ";
  if (code === "Backquote") return "`";
  const m = /^(?:Key([A-Z])|Digit(\d))$/.exec(code);
  return m ? (m[1]?.toLowerCase() ?? m[2]) : null;
}

// Neovim's mode names (mode_change) where Ctrl+V pastes.
const TYPING = new Set(["insert", "replace", "cmdline_normal", "cmdline_insert", "cmdline_replace", "terminal"]);
// And where there is a selection for Ctrl+C to copy.
const VISUAL = /^(visual|select)/;

export function attachInput(canvas, grid, rpc) {
  canvas.addEventListener("keydown", (e) => {
    // Paste is left to the browser so the paste event below fires with the
    // system clipboard. Ctrl+Shift+V always; Ctrl+V only where text is being
    // typed, since in normal and visual mode it is Vim's visual block.
    if (e.ctrlKey && !e.altKey && e.code === "KeyV" && (e.shiftKey || TYPING.has(grid.modeName))) return;
    // Copy: Ctrl+C (or Ctrl+Shift+C) with a selection yanks it to "+, which
    // corkboard's clipboard provider hands to the page (corkboard.clipboard).
    // Only in visual mode: everywhere else Ctrl+C stays Vim's, and in a
    // terminal it is the interrupt Claude Code and shells need. A drag in a
    // terminal selects in visual mode, so that copies too.
    if (e.ctrlKey && !e.altKey && e.code === "KeyC" && VISUAL.test(grid.modeName ?? "")) {
      e.preventDefault();
      rpc.notify("nvim_input", '"+y');
      return;
    }
    const key = toNvimKey(e);
    if (key === null) return;
    e.preventDefault();
    rpc.notify("nvim_input", key);
  });

  canvas.addEventListener("paste", (e) => {
    e.preventDefault();
    rpc.notify("nvim_paste", e.clipboardData.getData("text"), true, -1);
  });

  const BUTTONS = ["left", "middle", "right"];
  const mods = (e) =>
    (e.ctrlKey ? "C" : "") + (e.altKey ? "A" : "") + (e.shiftKey ? "S" : "");
  const mouse = (button, action, e) => {
    const rect = canvas.getBoundingClientRect();
    const { row, col } = grid.cellAt(e.clientX - rect.left, e.clientY - rect.top);
    rpc.notify("nvim_input_mouse", button, action, mods(e), 0, row, col);
  };

  let held = null;
  canvas.addEventListener("mousedown", (e) => {
    canvas.focus();
    held = BUTTONS[e.button];
    if (held) mouse(held, "press", e);
    e.preventDefault();
  });
  canvas.addEventListener("mousemove", (e) => held && mouse(held, "drag", e));
  window.addEventListener("mouseup", (e) => {
    if (held) mouse(held, "release", e);
    held = null;
  });
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      if (e.deltaY) mouse("wheel", e.deltaY > 0 ? "down" : "up", e);
      if (e.deltaX) mouse("wheel", e.deltaX > 0 ? "right" : "left", e);
    },
    { passive: false },
  );
}

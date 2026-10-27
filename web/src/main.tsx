import "./index.css";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { App } from "./App";
import { Grid } from "./nvim/grid.js";
import { attachInput } from "./nvim/input.js";
import { Rpc } from "./nvim/rpc.js";
import { makeNvim, NvimContext } from "./nvim/context";
import { store } from "./store";
import { askPermissionOnGesture, notifyAttention, notifyBack, notifyClaude } from "./attention";
import { chime } from "./chime";
import { openPlan } from "./planWindow";
import { save as saveSkeleton } from "./skeleton";

// ?cwd=/path/to/project opens Neovim there; ?host=<name> on that machine,
// over ssh (CORKBOARD_REMOTES in bridge/server.ts). ?view=plan is the day
// plan's window instead (planWindow.ts).
const params = new URLSearchParams(location.search);
const view = params.get("view") === "plan" ? "plan" : null;
const host = view ? null : params.get("host");
const wsUrl = new URL("nvim", location.href);
wsUrl.protocol = location.protocol === "https:" ? "wss:" : "ws:";
const query = (cwd: string | null) => {
  const q = new URLSearchParams();
  if (host) q.set("host", host);
  if (cwd != null) q.set("cwd", cwd);
  return q.size ? `?${q}` : "";
};
wsUrl.search = view ? "?view=plan" : query(params.get("cwd"));

// The bridge's token, when it wants one (TOKEN in bridge/server.ts). It comes
// in the fragment, #token=, and is kept so reloads and the windows of other
// projects have it; it leaves the address bar so a bookmark or screenshot
// doesn't carry it.
const fragment = new URLSearchParams(location.hash.slice(1));
let token = fragment.get("token");
try {
  if (token) localStorage.setItem("corkboard.token", token);
  else token = localStorage.getItem("corkboard.token");
} catch {}
if (fragment.has("token")) {
  fragment.delete("token");
  history.replaceState(null, "", `${location.pathname}${location.search}${fragment.size ? `#${fragment}` : ""}`);
}

const rpc = new Rpc(wsUrl, ["corkboard", ...(token ? [`corkboard.token.${token}`] : [])]);
const nvim = makeNvim(rpc);
store.set({ host, view });

// Rendered at once, so the canvas is there for the grid.
const root = createRoot(document.getElementById("root")!);
flushSync(() =>
  root.render(
    <NvimContext.Provider value={nvim}>
      <App />
    </NvimContext.Provider>,
  ),
);
const container = document.getElementById("editor")!;
const canvas = container.querySelector("canvas")!;
const grid = new Grid(canvas);
const cell = () => store.set({ cell: { w: grid.cellW as number, h: grid.cellH as number } });
cell();

rpc.on("corkboard.context", ([context]: any[]) => {
  const name = view ? "Day plan" : context.cwd.split("/").at(-1);
  document.title = `${name}${host ? ` @ ${host}` : ""} — corkboard`;
  store.set({ context });
});
rpc.on("corkboard.preview", ([tab]: any[]) => store.set({ previewTab: tab ?? null }));
// Alt+h from Neovim's leftmost window (corkboard/init.lua): keys go to
// the sidebar's tabs (Tabs in Sidebar.tsx) until they hand them back.
rpc.on("corkboard.focus_tabs", () => document.querySelector<HTMLElement>("#tabs")?.focus());
// A new commit, under `bun run dev` (bridge/server.ts).
rpc.on("corkboard.reload", () => location.reload());
rpc.on("corkboard.focus", ([focus]: any[]) => store.set({ focus: focus ?? null }));
rpc.on("corkboard.files_changed",() => store.set({ filesVersion: store.get().filesVersion + 1 }));

// Neovim sends a layout just before the flush that draws it. Rendering it
// synchronously (flushSync) in the same task as that flush's paint means a
// panel never appears or goes a frame apart from the grid beneath it, which
// would show the view buffer's text (entering a tab) or the previous
// panel's (leaving one). The timeout covers a layout with no redraw after
// it, as at attach. Scrollbars wait for the flush the same way.
let pending: { layout?: any; scroll?: any } = {};
let layoutTimer: ReturnType<typeof setTimeout> | undefined;
const applyLayout = () => {
  clearTimeout(layoutTimer);
  if (pending.layout || pending.scroll) flushSync(() => store.set(pending));
  pending = {};
};
const later = () => {
  clearTimeout(layoutTimer);
  layoutTimer = setTimeout(applyLayout, 50);
};
rpc.on("redraw", (batches: any[]) => {
  grid.redraw(batches);
  for (const [name, ...calls] of batches) {
    if (name === "tabline_update") {
      const [current, tabs] = calls.at(-1);
      store.set({ tabs: { current, tabs } });
    }
  }
  if (batches.some(([name]) => name === "flush")) applyLayout();
});
rpc.on("corkboard.layout", ([layout]: any[]) => {
  pending.layout = layout;
  later();
});
rpc.on("corkboard.scroll", ([scroll]: any[]) => {
  pending.scroll = scroll;
  later();
});
rpc.on("corkboard.board", ([state]: any[]) => {
  store.set({ views: { ...store.get().views, board: state } });
  notifyAttention(state.cards ?? [], (id) =>
    rpc.notify("nvim_exec_lua", "require('corkboard.agents').attend(...)", [id]),
  );
});
rpc.on("corkboard.notification", ([n]: any[]) =>
  notifyClaude(n, (buf) => rpc.notify("nvim_exec_lua", "require('corkboard.picker').focus_terminal(...)", [buf])),
);
// Away mode, from the bridge (bridge/away.ts). away_return: you picked a
// session in this page's Neovim, from this page or another one.
// A bridge older than away mode passes Neovim's own "corkboard.away" (its
// "enter") through to here, which is not a state.
rpc.on("corkboard.away", ([away]: any[]) => store.set({ away: typeof away === "object" ? away : null }));
rpc.on("corkboard.tools", ([tools]: any[]) => store.set({ tools }));
rpc.on("corkboard.chime", () => chime());
rpc.on("corkboard.away_return", ([here]: any[]) => {
  if (!here) notifyBack();
  canvas.focus();
});
rpc.on("corkboard.usage",([state]: any[]) => store.set({ views: { ...store.get().views, usage: state } }));
rpc.on("corkboard.plan", ([state]: any[]) => store.set({ views: { ...store.get().views, plan: state } }));
rpc.on("corkboard.plan_diff", ([state]: any[]) => store.set({ views: { ...store.get().views, "plan-diff": state } }));
// A state without text (a markdown preview's scroll) keeps the last text.
rpc.on("corkboard.view", ([buf, state]: any[]) => {
  const bufs = store.get().bufs;
  store.set({ bufs: { ...bufs, [buf]: { ...bufs[buf], ...state } } });
});
// A copy to "+ or "* (Neovim's clipboard provider is this page; see clip_copy
// in corkboard/init.lua). Loopback is a secure context, so writeText needs
// only that the window has focus, which the key that copied gave it.
rpc.on("corkboard.clipboard", ([text]: any[]) => {
  navigator.clipboard.writeText(text).catch((err) => {
    rpc.notify("nvim_exec_lua", "vim.notify(...)", [`corkboard: copy failed: ${err.message}`, 3]);
  });
});
// Another project, in a window of its own. "popup" keeps it an app window
// rather than a tab in the browser. It arrives within moments of the key
// that chose the project, so the popup blocker still counts that key.
// On the same machine as this one: a project picked on brain-vm is there.
// <leader>p in a project's window. Like corkboard.open below, it comes
// right after the key, so the popup blocker lets it through.
rpc.on("corkboard.open_plan", () => {
  if (!openPlan()) rpc.notify("nvim_exec_lua", "vim.notify(...)", ["corkboard: the browser blocked the day plan's window", 3]);
});
rpc.on("corkboard.open", ([{ cwd }]: any[]) => {
  const url = new URL(location.href);
  url.search = query(cwd);
  if (!window.open(url, "_blank", "popup")) {
    rpc.notify("nvim_exec_lua", "vim.notify(...)", ["corkboard: the browser blocked the new window", 3]);
  }
});
// Colors (and optionally the font) from Neovim's colorscheme; see
// push_theme in corkboard/init.lua. Background and text already come with
// the grid's default colors.
rpc.on("corkboard.theme", async ([theme]: any[]) => {
  const style = document.documentElement.style;
  for (const name of ["focus", "selection", "accent", "working", "blocked", "review", "special"]) {
    if (theme[name]) style.setProperty(`--nv-${name}`, theme[name]);
  }
  const font = theme.font;
  if (!font?.family) return;
  const family = `"${font.family}", monospace`;
  // Sizes come in points, as stylix and terminals give them.
  const px = font.size ? Math.round((font.size * 4) / 3) : grid.fontSize;
  if (family === grid.fontFamily && px === grid.fontSize) return;
  style.setProperty("--font", family);
  style.setProperty("--font-size", `${px}px`);
  await document.fonts.load(`${px}px ${family}`);
  grid.setFont(family, px);
  cell();
  const next = grid.fit(container.clientWidth, container.clientHeight);
  rpc.notify("nvim_ui_try_resize", next.cols, next.rows);
  rpc.notify("nvim_command", "redraw!");
});
// The tabs and windows, for the next load to show while Neovim starts.
addEventListener("pagehide", () => saveSkeleton(store.get()));
rpc.on("close", (e: CloseEvent) => {
  document.title = "corkboard (disconnected)";
  store.set({ status: e.reason || (e.code === 1006 ? "can't reach the bridge — is it running?" : "nvim exited") });
});

await rpc.ready;
await document.fonts.ready;
grid.measure();
cell();

const size = () => grid.fit(container.clientWidth, container.clientHeight);
const { cols, rows } = size();
await rpc.request("nvim_ui_attach", cols, rows, { rgb: true, ext_linegrid: true, ext_tabline: true, ext_hlstate: true });

new ResizeObserver(() => {
  const next = size();
  if (next.cols !== grid.cols || next.rows !== grid.rows) {
    rpc.notify("nvim_ui_try_resize", next.cols, next.rows);
  }
}).observe(container);

attachInput(canvas, grid, rpc);
// Whether this window has focus, which Neovim passes on to terminals that
// ask (Claude Code holds back notifications while it thinks you're looking).
const focus = () => rpc.notify("nvim_ui_set_focus", document.hasFocus());
addEventListener("focus", focus);
addEventListener("blur", focus);
focus();
canvas.focus();
askPermissionOnGesture();

// Neovim pushes view state and window layout to whichever channels attach.
const [chan] = await rpc.request("nvim_get_api_info");
await rpc.request("nvim_exec_lua", "require('corkboard').attach(...)", [chan]);
if (params.has("board")) rpc.notify("nvim_command", "AgentBoard");

import "./index.css";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { App } from "./App";
import { Grid } from "./nvim/grid.js";
import { attachInput } from "./nvim/input.js";
import { Rpc } from "./nvim/rpc.js";
import { EphemeralRpc, WasmRpc } from "./nvim/wasm/rpc";
import { makeNvim, NvimContext } from "./nvim/context";
import { store, type Tab, type Toast } from "./store";
import { askPermissionOnGesture, notifyAttention, notifyBack, notifyClaude, notifyMessage } from "./attention";
import { chime } from "./chime";
import { openPlan } from "./planWindow";
import { remember, save as saveSkeleton } from "./skeleton";
import { nvimFlushed, startLatency } from "./latency";

// ?cwd=/path/to/project opens Neovim there; ?host=<name> on that machine,
// over ssh (CORKBOARD_REMOTES in bridge/server.ts). ?view=plan is the day
// plan's window instead (planWindow.ts). ?wasm runs Neovim in the page
// (nvim/wasm), the bridge only its machine; ?wasm=0 doesn't, where the
// bridge would have it (CORKBOARD_WASM in bridge/server.ts).
// ?board=<key> (or ?wasm=ephemeral&repo=owner/name[&ref=]) has no machine
// at all: Neovim's files are a clone of the board's Forgejo repository, in
// memory (nvim/wasm/machine). The Worker serves the page so, at /edit/.
const params = new URLSearchParams(location.search);
const view = params.get("view") === "plan" ? "plan" : null;
const host = view ? null : params.get("host");
const wasm = params.get("wasm");
const inPage = wasm !== null && wasm !== "0";
const wsUrl = new URL("nvim", location.href);
wsUrl.protocol = location.protocol === "https:" ? "wss:" : "ws:";
const query = (cwd: string | null) => {
  const q = new URLSearchParams();
  if (host) q.set("host", host);
  if (cwd != null) q.set("cwd", cwd);
  if (wasm !== null) q.set("wasm", wasm);
  return q.size ? `?${q}` : "";
};
wsUrl.search = view ? `?view=plan${wasm !== null ? `&wasm=${wasm}` : ""}` : query(params.get("cwd"));

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

const protocols = ["corkboard", ...(token ? [`corkboard.token.${token}`] : [])];
const [owner, name] = (params.get("repo") ?? "").split("/");
const board = params.get("board") ?? undefined;
const rpc =
  board || (wasm === "ephemeral" && owner && name)
    ? new EphemeralRpc({ board, repo: owner && name ? { owner, name, ref: params.get("ref") ?? undefined } : undefined, token })
    : inPage
      ? new WasmRpc(wsUrl, protocols, token)
      : new Rpc(wsUrl, protocols);
const nvim = makeNvim(rpc, token);
// For tests and the console.
(window as any).__nvim = nvim;
store.set({ host, view });
// Key-to-pixels timings (latency.ts), to the bridge's latency.jsonl.
startLatency((samples) =>
  fetch(new URL("latency", location.href), {
    method: "POST",
    body: JSON.stringify({ view, host, cwd: params.get("cwd"), samples }),
    headers: token ? { "x-corkboard-token": token } : {},
    keepalive: true,
  }).catch(() => {}),
);

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
let pending: { layout?: any; scroll?: any; switching?: null } = {};
let layoutTimer: ReturnType<typeof setTimeout> | undefined;
const applyLayout = () => {
  clearTimeout(layoutTimer);
  // The tab the sidebar asked for, drawn, ends its loading in the same
  // render as its layout. Its layout comes before this flush, or not at all
  // when it is laid out as the last tab was.
  const { tabs, switching } = store.get();
  if (pending.layout?.wins && tabs) remember(tabs.current.id, pending.layout.wins);
  if (switching !== null && switching === tabs?.current.id) pending.switching = null;
  if (pending.layout || pending.scroll || pending.switching === null) flushSync(() => store.set(pending));
  pending = {};
};
const later = () => {
  clearTimeout(layoutTimer);
  layoutTimer = setTimeout(applyLayout, 50);
};
// Neovim's names for tabs whose buffer names read badly, by tab handle
// (corkboard.tab_labels), put on the tabs so the skeleton keeps them.
let tabLabels: Record<string, NonNullable<Tab["label"]>> = {};
const labelTabs = (tabs: Tab[]) => tabs.map((t) => ({ ...t, label: tabLabels[t.tab.id] }));
rpc.on("redraw", (batches: any[]) => {
  grid.redraw(batches);
  for (const [name, ...calls] of batches) {
    if (name === "tabline_update") {
      const [current, tabs] = calls.at(-1);
      store.set({ tabs: { current, tabs: labelTabs(tabs) } });
    }
  }
  if (batches.some(([name]) => name === "flush")) {
    applyLayout();
    nvimFlushed();
  }
});
rpc.on("corkboard.layout", ([layout]: any[]) => {
  pending.layout = layout;
  later();
});
rpc.on("corkboard.scroll", ([scroll]: any[]) => {
  pending.scroll = scroll;
  later();
});
rpc.on("corkboard.tab_labels", ([labels]: any[]) => {
  tabLabels = labels ?? {};
  const tabs = store.get().tabs;
  if (tabs) store.set({ tabs: { ...tabs, tabs: labelTabs(tabs.tabs) } });
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
rpc.on("corkboard.projects", ([projects]: any[]) => store.set({ projects }));
rpc.on("corkboard.chime", () => chime());
rpc.on("corkboard.message", ([m]: any[]) => notifyMessage(m));
// A toast replaces the one with its id; one that's ended goes after a while.
rpc.on("corkboard.toast", ([t]: [Toast]) => {
  store.set({ toasts: [...store.get().toasts.filter((o) => o.id !== t.id), t] });
  if (t.kind === "pending") return;
  setTimeout(() => store.set({ toasts: store.get().toasts.filter((o) => o !== t) }), t.kind === "error" ? 8000 : 3000);
});
rpc.on("corkboard.away_return", ([here]: any[]) => {
  if (!here) notifyBack();
  canvas.focus();
});
rpc.on("corkboard.usage",([state]: any[]) => store.set({ views: { ...store.get().views, usage: state } }));
rpc.on("corkboard.fleet", ([state]: any[]) => store.set({ views: { ...store.get().views, fleet: state } }));
// The day and the ranked list are two windows on one state.
rpc.on("corkboard.plan", ([state]: any[]) => store.set({ views: { ...store.get().views, plan: state, "plan-priority": state } }));
rpc.on("corkboard.plan_diff", ([state]: any[]) => store.set({ views: { ...store.get().views, "plan-diff": state } }));
rpc.on("corkboard.plan_goals", ([state]: any[]) => store.set({ views: { ...store.get().views, "plan-goals": state } }));
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
// The project asked for from another window has this one (openWindow in
// bridge/server.ts): it comes forward, which focus() alone can't do on
// Wayland; this navigation within the page tells the desktop app to
// (app/main.js), as for the day plan (planWindow.ts).
rpc.on("corkboard.front", () => {
  location.hash = `front-${Date.now()}`;
  window.focus();
  canvas.focus();
});
// The projects with a window on this machine, for Open project.
rpc.on("corkboard.windows", ([windows]: any[]) => store.set({ windows }));
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
// A bridge that went away (restarted, or the machine slept) is waited for,
// and the page loads again once it answers, with a new Neovim as a reload
// would. A close the bridge chose (Neovim exited, a wrong token, the plan
// opened elsewhere) stays closed.
const reconnect = async () => {
  for (let wait = 500; ; wait = Math.min(wait * 2, 5000)) {
    await new Promise((r) => setTimeout(r, wait));
    try {
      if ((await fetch("manifest.webmanifest", { method: "HEAD", cache: "no-store" })).ok) return location.reload();
    } catch {}
  }
};
rpc.on("close", (e: CloseEvent) => {
  document.title = "corkboard (disconnected)";
  const lost = e.code === 1006 || e.code === 1001;
  store.set({ status: e.reason || (lost ? "can't reach the bridge — reconnecting" : "nvim exited") });
  if (lost) reconnect();
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

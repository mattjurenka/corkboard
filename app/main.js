// corkboard's desktop window: the bridge's page in an Electron window, in
// place of a Chromium app window.
//
// For the keys. Chromium keeps some for itself even in an app window
// (Ctrl+W closes it, and Ctrl+W is half of Vim's window commands); here
// there is no menu and so no accelerators, and every key reaches the page,
// bar the window's own (KEYS): F5 (reload) and F12 (devtools), as in
// Chromium, F11 (full screen) on Linux and Windows, and on macOS what its
// app menu would have.
//
// The page is the bridge's own and gets nothing more than a browser would
// give it: no Node, no preload, sandboxed. Everything else (the bridge, the
// page, Neovim) is as it was; this only draws the window.
//
//   electron app [--name ID] [--title NAME] [--one] URL
//
// ID names the app: its Wayland app_id / WM_CLASS, which launchers and
// window rules go by, and its profile directory, so the installed app and
// the dev one are apps of their own. NAME is what notifications and the
// window list call it. Launching an app that is already running opens URL in
// a new window of the running one; with --one (the day plan's app), it
// brings the running one's window forward instead.
//
// Packaged (electron-builder.yml) and given no URL, it is the whole of
// corkboard: it starts its own bridge (bridge.js), says so if claude or
// git can't be found, and keeps itself up to date from GitHub's releases,
// bar the .deb and the tarball, which their package managers update.

import { app, BrowserWindow, dialog, Menu, net, session, shell } from "electron";
import { join } from "node:path";
import { bundledGit, loginPath, startBridge, which } from "./bridge.js";

function parse(argv) {
  const args = { name: "corkboard", title: undefined, url: undefined, one: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--name") args.name = argv[++i];
    else if (a === "--title") args.title = argv[++i];
    else if (a === "--one") args.one = true;
    else if (/^https?:\/\//.test(a)) args.url = a;
  }
  return args;
}

// Electron's own arguments come first: the binary, and the app's path when
// it isn't packaged.
const args = parse(process.argv.slice(app.isPackaged ? 1 : 2));
// Its own bridge, when it's the packaged app with no URL given.
const OWN = app.isPackaged && !args.url;
// The page every new window opens: the dev bridge's, or, once it's up, the
// app's own bridge's, with its token.
let home = args.url ?? "http://127.0.0.1:7777/";
let ORIGIN = new URL(home).origin;

// Before anything reads them: the profile directory goes by the name, and
// so does the single-instance lock.
app.setName(args.title ?? args.name);
app.setPath("userData", `${app.getPath("appData")}/${args.name}`);
// The desktop entry of the same name, for notifications and the dock.
app.setDesktopName(`${args.name}.desktop`);

if (!app.requestSingleInstanceLock()) app.exit(0);

// Off before the first window, or it gets the default menu's accelerators.
Menu.setApplicationMenu(null);

const sameOrigin = (url) => URL.parse(url)?.origin === ORIGIN;

// The theme-color the page sets (the colorscheme's background, see grid.js),
// for the window buttons' strip.
let themeColor = "#000000";
// White or black, whichever reads on it.
const symbolFor = (hex) => {
  const n = parseInt(hex.slice(1, 7), 16);
  const luma = 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
  return luma > 140 ? "#000000" : "#ffffff";
};

// The page draws where the title bar was, all but the window buttons, as an
// installed PWA with window-controls-overlay does: Electron's overlay sets
// the same env(titlebar-area-*) the page lays itself out by (App.tsx).
// On macOS the traffic lights sit in it instead, inset, centred on its 32px.
const MAC = process.platform === "darwin";
const windowOptions = () => ({
  width: 1400,
  height: 900,
  backgroundColor: themeColor,
  titleBarStyle: MAC ? "hiddenInset" : "hidden",
  ...(MAC ? { trafficLightPosition: { x: 12, y: 9 } } : {}),
  titleBarOverlay: MAC ? { height: 32 } : { color: themeColor, symbolColor: symbolFor(themeColor), height: 32 },
  webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false },
});

function setup(win) {
  const wc = win.webContents;

  wc.on("did-change-theme-color", (_e, color) => {
    if (!color) return;
    themeColor = color;
    win.setBackgroundColor(color);
    if (!MAC) win.setTitleBarOverlay({ color, symbolColor: symbolFor(color) });
  });

  // Other projects and the day plan open in windows of their own (window.open
  // in main.tsx and planWindow.ts), which stay when the window that opened
  // them closes (Electron closes them with it by default); links out of the
  // page go to the browser.
  wc.setWindowOpenHandler(({ url }) => {
    if (url === "about:blank" || sameOrigin(url)) return { action: "allow", outlivesOpener: true, overrideBrowserWindowOptions: windowOptions() };
    if (/^(https?|mailto):/i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  // The day plan asked for when it's open already (planWindow.ts): its
  // window comes forward, which the page's own focus() can't do on Wayland.
  wc.on("did-navigate-in-page", (_e, url, isMainFrame) => {
    if (!isMainFrame || !new URL(url).hash.startsWith("#front-")) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  wc.on("will-navigate", (e, url) => {
    if (sameOrigin(url)) return;
    e.preventDefault();
    if (/^(https?|mailto):/i.test(url)) shell.openExternal(url);
    // The missing-tools page's two links.
    else if (url === "corkboard:again") checked(win);
    else if (url === "corkboard:anyway") win.loadURL(home);
  });

  // The window's keys, as each system has them. With no menu, macOS's do
  // nothing unless here; Cmd+V fires the paste event the page pastes from
  // (input.js), and Cmd+C is the page's, which yanks Neovim's selection.
  const fullScreen = () => win.setFullScreen(!win.isFullScreen());
  const KEYS = {
    F5: () => wc.reload(),
    F12: () => wc.toggleDevTools(),
    ...(MAC
      ? {
          "Cmd+KeyQ": () => app.quit(),
          "Cmd+KeyV": () => wc.paste(),
          "Cmd+KeyH": () => app.hide(),
          "Cmd+KeyM": () => win.minimize(),
          "Cmd+KeyR": () => wc.reload(),
          "Cmd+Ctrl+KeyF": fullScreen,
          "Cmd+Alt+KeyI": () => wc.toggleDevTools(),
        }
      : { F11: fullScreen }),
  };
  wc.on("before-input-event", (e, input) => {
    if (input.type !== "keyDown") return;
    const chord = [input.meta && "Cmd", input.control && "Ctrl", input.alt && "Alt", input.shift && "Shift", input.code].filter(Boolean).join("+");
    if (!KEYS[chord]) return;
    e.preventDefault();
    KEYS[chord]();
  });

  // The bridge may still be coming up (the launchers start its service just
  // before this), or be down, so a page that didn't load says so and is
  // loaded again once the bridge answers.
  let waiting = false;
  wc.on("did-fail-load", async (_e, code, desc, url, isMainFrame) => {
    // -3 is a load cut short by another, which is not a failure.
    if (!isMainFrame || code === -3 || waiting) return;
    waiting = true;
    wc.loadURL(errorPage(desc, url));
    for (let wait = 500; ; wait = Math.min(wait * 2, 5000)) {
      await new Promise((r) => setTimeout(r, wait));
      if (wc.isDestroyed()) return;
      try {
        if ((await net.fetch(url, { method: "HEAD", cache: "no-store" })).ok) break;
      } catch {}
    }
    waiting = false;
    wc.loadURL(url);
  });
}

const escape = (s) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
const errorPage = (desc, url) =>
  "data:text/html;charset=utf-8," +
  encodeURIComponent(`<!doctype html><title>corkboard (disconnected)</title>
<body style="margin:0;height:100vh;display:grid;place-items:center;background:${themeColor};color:${symbolFor(themeColor)};font:14px/1.5 monospace">
<pre style="margin:0;padding:1ch 2ch;border:1px solid currentColor">can't reach the bridge — reconnecting
${escape(desc)}  ${escape(url)}</pre>`);

// Claude Code and git, which corkboard can't do without, and ripgrep, which
// its pickers are slow without: looked for on the PATH the bridge has, which
// has the app's own git in front when the machine has no git (bundledGit).
const TOOLS = [
  { name: "claude", need: true, url: "https://claude.com/claude-code" },
  { name: "git", need: true, url: "https://git-scm.com/downloads" },
  { name: "rg", need: false, url: "https://github.com/BurntSushi/ripgrep#installation" },
];
let path = process.env.PATH ?? "";
let git;
const missing = () => TOOLS.filter((t) => !which(t.name, path));

const toolsPage = (gone) =>
  "data:text/html;charset=utf-8," +
  encodeURIComponent(`<!doctype html><title>corkboard</title>
<style>a{color:inherit}</style>
<body style="margin:0;height:100vh;display:grid;place-items:center;background:${themeColor};color:${symbolFor(themeColor)};font:14px/1.6 monospace">
<pre style="margin:0;padding:1ch 2ch;border:1px solid currentColor">not found
${gone.map((t) => `  ${t.name.padEnd(7)}<a href="${t.url}">${t.url}</a>${t.need ? "" : "  (optional)"}`).join("\n")}

<a href="corkboard:again">[ again ]</a>  <a href="corkboard:anyway">[ open anyway ]</a></pre>`);

// The page, unless claude or git is missing, which it says instead.
function checked(win) {
  const gone = OWN ? missing() : [];
  win.loadURL(gone.some((t) => t.need) ? toolsPage(gone) : home);
}

app.on("browser-window-created", (_e, win) => setup(win));

function open(url) {
  const win = new BrowserWindow(windowOptions());
  if (url) win.loadURL(url);
  else checked(win);
}

app.on("second-instance", (_e, argv) => {
  const [win] = BrowserWindow.getAllWindows();
  if (args.one && win) {
    if (win.isMinimized()) win.restore();
    return win.focus();
  }
  const url = parse(argv.slice(app.isPackaged ? 1 : 2)).url;
  // Only this app's own bridge: another origin's page would get this
  // profile's permissions.
  open(url && sameOrigin(url) ? url : undefined);
});

// What a page may ask for: notifications (attention.ts) and the clipboard
// (Neovim's "+ register, main.tsx), and only the bridge's page.
const PERMITTED = new Set(["notifications", "clipboard-read", "clipboard-sanitized-write", "fullscreen"]);

let bridge;
let quitting = false;

// The app's own bridge, started again if it stops on its own, a few times.
async function own(tries = 3) {
  bridge = await startBridge({
    resources: process.resourcesPath,
    profile: app.getPath("userData"),
    path,
    git,
    onExit: (code) => {
      console.error(`bridge exited (${code})`);
      if (tries > 1 && !quitting) own(tries - 1).catch((err) => console.error(err));
    },
  });
  home = bridge.home;
  ORIGIN = new URL(bridge.url).origin;
}

// AppImage, macOS and Windows; not the .deb, the .rpm or the tarball (AUR),
// which have no APPIMAGE and are their package managers' to update. Once one
// has downloaded, it asks whether to restart into it now; if not, it's
// installed when the app next quits. From the release bucket; the GitHub
// release in app-update.yml is for the versions before this, which still
// read it. R2 takes one range to a request.
async function updates() {
  if (process.platform === "linux" && !process.env.APPIMAGE) return;
  try {
    const { autoUpdater } = (await import("electron-updater")).default;
    autoUpdater.setFeedURL({ provider: "generic", url: "https://dl.corkboard.fyi/", useMultipleRangeRequest: false });
    autoUpdater.on("update-downloaded", async ({ version }) => {
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      const options = {
        type: "info",
        message: `corkboard ${version} is ready`,
        detail: "Restart now to update?",
        buttons: ["Restart", "Later"],
        defaultId: 0,
        cancelId: 1,
      };
      const { response } = await (win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options));
      if (response === 0) autoUpdater.quitAndInstall();
    });
    await autoUpdater.checkForUpdates();
  } catch (err) {
    console.error("update check:", err);
  }
}

app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_wc, permission, done, details) =>
    done(PERMITTED.has(permission) && sameOrigin(details.requestingUrl)),
  );
  session.defaultSession.setPermissionCheckHandler((_wc, permission, origin) => PERMITTED.has(permission) && sameOrigin(origin));
  if (OWN) {
    path = loginPath();
    git = bundledGit(join(process.resourcesPath, "bridge"), path);
    if (git) path = git.PATH;
    try {
      await own();
    } catch (err) {
      const win = new BrowserWindow(windowOptions());
      return win.loadURL(errorPage(err.message, ""));
    }
    updates();
  }
  open(args.url);
});

app.on("window-all-closed", () => app.quit());
app.on("will-quit", () => {
  quitting = true;
  bridge?.stop();
});

// corkboard's desktop window: the bridge's page in an Electron window, in
// place of a Chromium app window.
//
// For the keys. Chromium keeps some for itself even in an app window
// (Ctrl+W closes it, and Ctrl+W is half of Vim's window commands); here
// there is no menu and so no accelerators, and every key reaches the page,
// bar F5 (reload) and F12 (devtools), as in Chromium.
//
// The page is the bridge's own and gets nothing more than a browser would
// give it: no Node, no preload, sandboxed. Everything else (the bridge, the
// page, Neovim) is as it was; this only draws the window.
//
//   electron app [--name ID] [--title NAME] URL
//
// ID names the app: its Wayland app_id / WM_CLASS, which launchers and
// window rules go by, and its profile directory, so the installed app and
// the dev one are apps of their own. NAME is what notifications and the
// window list call it. Launching an app that is already running opens URL in
// a new window of the running one.

import { app, BrowserWindow, Menu, session, shell } from "electron";

function parse(argv) {
  const args = { name: "corkboard", title: undefined, url: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--name") args.name = argv[++i];
    else if (a === "--title") args.title = argv[++i];
    else if (/^https?:\/\//.test(a)) args.url = a;
  }
  return args;
}

// Electron's own arguments come first: the binary, and the app's path when
// it isn't packaged.
const args = parse(process.argv.slice(app.isPackaged ? 1 : 2));
const URL_DEFAULT = "http://127.0.0.1:7777/";
const ORIGIN = new URL(args.url ?? URL_DEFAULT).origin;

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
const windowOptions = () => ({
  width: 1400,
  height: 900,
  backgroundColor: themeColor,
  titleBarStyle: "hidden",
  titleBarOverlay: { color: themeColor, symbolColor: symbolFor(themeColor), height: 32 },
  webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false },
});

function setup(win) {
  const wc = win.webContents;

  wc.on("did-change-theme-color", (_e, color) => {
    if (!color) return;
    themeColor = color;
    win.setBackgroundColor(color);
    win.setTitleBarOverlay({ color, symbolColor: symbolFor(color) });
  });

  // Other projects and the day plan open in windows of their own (window.open
  // in main.tsx and planWindow.ts); links out of the page go to the browser.
  wc.setWindowOpenHandler(({ url }) => {
    if (url === "about:blank" || sameOrigin(url)) return { action: "allow", overrideBrowserWindowOptions: windowOptions() };
    if (/^(https?|mailto):/i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  wc.on("will-navigate", (e, url) => {
    if (sameOrigin(url)) return;
    e.preventDefault();
    if (/^(https?|mailto):/i.test(url)) shell.openExternal(url);
  });

  wc.on("before-input-event", (e, input) => {
    if (input.type !== "keyDown" || input.control || input.alt || input.meta) return;
    if (input.key === "F5") {
      e.preventDefault();
      wc.reload();
    } else if (input.key === "F12") {
      e.preventDefault();
      wc.toggleDevTools();
    }
  });

  // The bridge may still be coming up (the launchers start its service just
  // before this), so a page that didn't load tries again for a while.
  let tries = 0;
  wc.on("did-fail-load", (_e, code, _desc, url, isMainFrame) => {
    // -3 is a load cut short by another, which is not a failure.
    if (!isMainFrame || code === -3 || tries++ >= 60) return;
    setTimeout(() => wc.loadURL(url), 500);
  });
  wc.on("did-finish-load", () => (tries = 0));
}

app.on("browser-window-created", (_e, win) => setup(win));

function open(url) {
  const win = new BrowserWindow(windowOptions());
  win.loadURL(url ?? URL_DEFAULT);
}

app.on("second-instance", (_e, argv) => {
  const url = parse(argv.slice(app.isPackaged ? 1 : 2)).url;
  // Only this app's own bridge: another origin's page would get this
  // profile's permissions.
  open(url && sameOrigin(url) ? url : undefined);
});

// What a page may ask for: notifications (attention.ts) and the clipboard
// (Neovim's "+ register, main.tsx), and only the bridge's page.
const PERMITTED = new Set(["notifications", "clipboard-read", "clipboard-sanitized-write", "fullscreen"]);

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_wc, permission, done, details) =>
    done(PERMITTED.has(permission) && sameOrigin(details.requestingUrl)),
  );
  session.defaultSession.setPermissionCheckHandler((_wc, permission, origin) => PERMITTED.has(permission) && sameOrigin(origin));
  open(args.url);
});

app.on("window-all-closed", () => app.quit());

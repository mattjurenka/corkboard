// The page: the sidebar, and the editor's canvas with the panels and
// scrollbars laid over it. The canvas itself is grid.js's, drawn outside
// React; main.tsx finds it after the first render.
//
// Narrow (a phone, a skinny window), the editor has the page to itself
// under a bar: the sidebar opens over it as a drawer, and the bar has the
// keys an on-screen keyboard lacks, and the keyboard itself.

import { Alert, AlertDescription } from "@/components/ui/alert";
import { BrainForm } from "@/components/BrainForm";
import { Away } from "@/components/Away";
import { Panels } from "@/components/Panels";
import { Projects } from "@/components/Projects";
import { Scrollbars } from "@/components/Scrollbars";
import { Sidebar, tabTitle } from "@/components/Sidebar";
import { Skeleton } from "@/components/Skeleton";
import { Toasts } from "@/components/Toasts";
import { Tools } from "@/components/Tools";
import { Button } from "@/components/ui/button";
import { keepFocus, useNvim } from "@/nvim/context";
import { cn } from "@/lib/utils";
import { store, useStore } from "@/store";
import { useEffect } from "react";

export function App() {
  const status = useStore((s) => s.status);
  // The day plan's window is the plan alone.
  const plan = useStore((s) => s.view === "plan");
  // Focus mode (corkboard/focus.lua) has no sidebar either, and centres the
  // editor at its width; Neovim's grid shrinks to fit, as for any resize.
  // The pixel spare keeps rounding from losing the last column.
  const focus = useStore((s) => s.focus);
  const narrow = useStore((s) => s.narrow);
  const drawer = useStore((s) => s.drawer);
  const bare = plan || !!focus;
  const gutter = focus ? `max(0px, calc((100% - var(--cell-w) * ${focus.width} - 1px) / 2))` : undefined;
  // The drawer closes once it has done its job: another tab, or a picker.
  const tab = useStore((s) => s.tabs?.current.id);
  const picking = useStore((s) => !!s.tools || !!s.projects || !!s.brainForm);
  useEffect(() => {
    if (store.get().drawer) store.set({ drawer: false });
  }, [tab, picking]);
  return (
    // 32 cells, or less in a narrow window: never more than 30% of it, nor
    // under 18 cells. Narrow, as a drawer, up to most of the page.
    <div
      className={cn(
        "relative h-full",
        bare ? "[--sidebar-width:0px]"
        : narrow ? "[--sidebar-width:min(calc(var(--cell-w)*32),85vw)]"
        : "[--sidebar-width:min(calc(var(--cell-w)*32),max(calc(var(--cell-w)*18),30vw))]",
      )}
    >
      {!bare && !narrow && <Sidebar />}
      {/* Installed as an app, the page draws where the title bar was
          (window-controls-overlay in the manifest), all but the window
          buttons. The sidebar runs to the top; over the editor, the bar's
          height is left to drag the window by, with a 1px border below it
          (outside the window buttons' strip, which would cover it). Zero
          in a browser tab. */}
      {!narrow && (
        <div className="absolute top-0 right-0 left-(--sidebar-width) box-content h-[env(titlebar-area-height,0px)] border-b-[length:min(1px,env(titlebar-area-height,0px))] [-webkit-app-region:drag] [app-region:drag]" />
      )}
      {narrow && <Bar menu={!bare} />}
      <div
        id="editor"
        className={cn(
          "absolute right-0 bottom-0",
          narrow ? "top-[calc(2*var(--cell-h))] left-0" : "top-[calc(env(titlebar-area-height,0px)+min(1px,env(titlebar-area-height,0px)))] left-(--sidebar-width)",
        )}
        style={focus ? { left: gutter, right: gutter } : undefined}
      >
        <canvas tabIndex={0} className="block touch-none outline-none" />
        {/* What an on-screen keyboard types into (input.js). */}
        <textarea
          id="keys"
          aria-label="Keyboard"
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          className="pointer-events-none absolute top-0 left-0 size-px resize-none opacity-0"
        />
        <Panels />
        <Scrollbars />
        <Skeleton />
        <Toasts />
      </div>
      {narrow && drawer && !bare && (
        <>
          <div className="absolute inset-0 z-4 bg-background/60" onClick={() => store.set({ drawer: false })} />
          <div className="absolute inset-y-0 left-0 z-4 w-(--sidebar-width)">
            <Sidebar />
          </div>
        </>
      )}
      {status && (
        <Alert
          variant="destructive"
          className="absolute top-2/5 left-1/2 z-2 block w-auto max-w-[calc(100%-32px)] -translate-1/2 border-blocked bg-muted px-2ch py-row text-foreground"
        >
          <AlertDescription className="block text-foreground">{status}</AlertDescription>
        </Alert>
      )}
      <Tools />
      <Projects />
      <BrainForm />
      <Away />
    </div>
  );
}

// The keys a phone's keyboard hasn't got, each sent as Neovim's.
const KEYS: [string, string][] = [
  ["esc", "<Esc>"],
  ["tab", "<Tab>"],
  ["^c", "<C-c>"],
  ["↑", "<Up>"],
  ["↓", "<Down>"],
];

// Narrow, over the editor: the drawer's toggle and the tab's name, then
// those keys and the on-screen keyboard's toggle. Every button keeps the
// focus where it was, so the keyboard stays up.
function Bar({ menu }: { menu: boolean }) {
  const nvim = useNvim();
  const title = useStore((s) => (s.tabs ? tabTitle(s.tabs) : ""));
  const drawer = useStore((s) => s.drawer);
  const keys = () => document.querySelector<HTMLTextAreaElement>("#keys")!;
  const typing = useStore((s) => s.keyboard);
  return (
    <div className="absolute inset-x-0 top-0 flex h-[calc(2*var(--cell-h))] items-stretch border-b bg-background select-none">
      {menu && (
        <BarButton title="Tabs and files" className={cn(drawer && "text-focus")} onClick={() => store.set({ drawer: !drawer })}>
          ≡
        </BarButton>
      )}
      <span className="min-w-0 flex-1 self-center truncate px-ch">{title}</span>
      {KEYS.map(([label, key]) => (
        <BarButton key={key} onClick={() => nvim.notify("nvim_input", key)}>
          {label}
        </BarButton>
      ))}
      <BarButton
        title="Keyboard"
        className={cn(typing && "text-focus")}
        onClick={() => {
          if (typing) {
            store.set({ keyboard: false });
            nvim.refocus();
          } else {
            store.set({ keyboard: true });
            keys().focus();
          }
        }}
      >
        ⌨
      </BarButton>
    </div>
  );
}

function BarButton({ className, ...props }: React.ComponentProps<typeof Button>) {
  return (
    <Button
      variant="ghost"
      onMouseDown={keepFocus}
      className={cn("h-full min-w-[calc(4*var(--cell-w))] rounded-none px-ch font-normal text-muted-foreground", className)}
      {...props}
    />
  );
}

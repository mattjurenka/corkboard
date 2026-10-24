// The page: the sidebar, and the editor's canvas with the panels and
// scrollbars laid over it. The canvas itself is grid.js's, drawn outside
// React; main.tsx finds it after the first render.

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Panels } from "@/components/Panels";
import { Scrollbars } from "@/components/Scrollbars";
import { Sidebar } from "@/components/Sidebar";
import { useStore } from "@/store";

export function App() {
  const status = useStore((s) => s.status);
  return (
    // 32 cells, or less in a narrow window: never more than 30% of it, nor
    // under 18 cells.
    <div className="relative h-full [--sidebar-width:min(calc(var(--cell-w)*32),max(calc(var(--cell-w)*18),30vw))]">
      <Sidebar />
      {/* Installed as an app, the page draws where the title bar was
          (window-controls-overlay in the manifest), all but the window
          buttons. The sidebar runs to the top; over the editor, the bar's
          height is left to drag the window by. Zero in a browser tab. */}
      <div className="absolute top-0 right-0 left-(--sidebar-width) h-[env(titlebar-area-height,0px)] [-webkit-app-region:drag] [app-region:drag]" />
      <div id="editor" className="absolute top-[env(titlebar-area-height,0px)] right-0 bottom-0 left-(--sidebar-width)">
        <canvas tabIndex={0} className="block outline-none" />
        <Panels />
        <Scrollbars />
      </div>
      {status && (
        <Alert
          variant="destructive"
          className="absolute top-2/5 left-1/2 z-2 block w-auto max-w-[calc(100%-32px)] -translate-1/2 border-blocked bg-muted px-2ch py-row text-foreground"
        >
          <AlertDescription className="block text-foreground">{status}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}

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
    <div className="relative h-full [--sidebar-width:calc(var(--cell-w)*32)]">
      <Sidebar />
      <div id="editor" className="absolute inset-y-0 right-0 left-(--sidebar-width)">
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

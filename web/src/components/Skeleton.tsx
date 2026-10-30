// Over the editor until Neovim has put it back as it was: the windows the
// page last saw (skeleton.ts), each loading. The sidebar's tabs do the same
// (Tabs in Sidebar.tsx). Likewise while a tab asked for from the sidebar is
// coming: its windows as last seen, each loading, rather than the tab being
// left. Floats Neovim opens meanwhile (a picker) show through it, and float
// panels sit above it.

import { box, holes } from "@/components/Panels";
import { Spinner } from "@/components/Spinner";
import { windowsOf } from "@/skeleton";
import { type Rect, useStore } from "@/store";

// The floats before there is a layout: one list, since a new one each time
// useStore asks would re-render without end.
const NONE: Rect[] = [];

export function Skeleton() {
  const skeleton = useStore((s) => s.skeleton);
  const restored = useStore((s) => !!s.layout && s.layout.restored !== false);
  const switching = useStore((s) => s.switching);
  const floats = useStore((s) => s.layout?.floats ?? NONE);
  const { w: cellW, h: cellH } = useStore((s) => s.cell);
  const wins = !restored ? skeleton?.wins : switching !== null ? windowsOf(switching) : undefined;
  if (!wins) return null;
  // Enough cells to cover the editor, for cutting the floats out.
  const all = { row: 0, col: 0, width: Math.ceil(innerWidth / cellW), height: Math.ceil(innerHeight / cellH) };
  return (
    <div className="absolute inset-0 z-2 cursor-progress bg-background" style={{ clipPath: holes(all, floats, cellW, cellH) || undefined }}>
      {wins.map((w, i) => (
        // Outlined with the status line below it, where Neovim draws that.
        <Spinner key={i} className="absolute border border-border" style={box({ ...w, height: w.height + 1 }, cellW, cellH)} />
      ))}
    </div>
  );
}

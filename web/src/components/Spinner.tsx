// A braille spinner, centered in whatever it fills: a window, a tab or a
// panel whose content is still coming.

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

const FRAMES = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";

export function Spinner({ className, style }: { className?: string; style?: React.CSSProperties }) {
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI((n) => (n + 1) % FRAMES.length), 80);
    return () => clearInterval(t);
  }, []);
  return (
    <div className={cn("flex items-center justify-center text-muted-foreground", className)} style={style} aria-label="loading" data-ambient>
      {FRAMES[i]}
    </div>
  );
}

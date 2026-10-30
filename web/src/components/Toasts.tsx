// Toasts (corkboard.toast), stacked in the editor's bottom right corner: a
// spinner while pending, then how it ended, each boxed like a card.

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { useStore } from "@/store";

const FRAMES = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";

function Spin() {
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI((n) => (n + 1) % FRAMES.length), 80);
    return () => clearInterval(t);
  }, []);
  return <span className="text-working" data-ambient>{FRAMES[i]}</span>;
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  if (toasts.length === 0) return null;
  return (
    <ol className="pointer-events-none absolute right-2ch bottom-row z-3 flex max-w-[min(60ch,calc(100%-4ch))] flex-col items-end gap-half">
      {toasts.map((t) => (
        <li
          key={t.id}
          className={cn(
            "grid grid-cols-[2ch_1fr] gap-x-ch border bg-background px-ch",
            t.kind === "error" && "border-destructive",
            t.kind === "done" && "border-working",
          )}
        >
          {t.kind === "pending" ? <Spin /> : <span className={t.kind === "error" ? "text-destructive" : "text-working"}>{t.kind === "error" ? "✗" : "✓"}</span>}
          <span className="break-words">{t.text}</span>
        </li>
      ))}
    </ol>
  );
}

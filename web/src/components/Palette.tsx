// The frame the page's palettes share (Tools.tsx, Projects.tsx): a desktop
// dialog over a dimmed page, with a title bar, a search field and a list
// under it. Unlike the rest of the page, though in the editor's face and
// colors.

import { forwardRef } from "react";
import { cn } from "@/lib/utils";

// Every letter of the query in order, as snacks matches.
export const matches = (text: string, query: string) => {
  let at = 0;
  for (const c of query.toLowerCase()) {
    at = text.toLowerCase().indexOf(c, at) + 1;
    if (!at) return false;
  }
  return true;
};

// Up and down as the editor's pickers have them, for a list of n.
export function step(e: React.KeyboardEvent, at: number, n: number): number | null {
  const down = e.key === "ArrowDown" || (e.ctrlKey && (e.key === "n" || e.key === "j"));
  const up = e.key === "ArrowUp" || (e.ctrlKey && (e.key === "p" || e.key === "k"));
  if (!down && !up) return null;
  e.preventDefault();
  return Math.max(0, Math.min(n - 1, at + (down ? 1 : -1)));
}

export function Palette({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-10 bg-black/25" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-label={title}
        onMouseDown={(e) => e.stopPropagation()}
        className="absolute top-[18%] left-1/2 w-[min(440px,calc(100%-32px))] -translate-x-1/2 overflow-hidden rounded-[10px] border bg-popover text-popover-foreground shadow-[0_12px_40px_rgb(0_0_0/0.45),0_2px_8px_rgb(0_0_0/0.25)] select-none"
      >
        <div className="flex h-[34px] items-center justify-between border-b bg-muted pr-[6px] pl-[12px]">
          <span className="font-semibold">{title}</span>
          <button
            type="button"
            title="Close (Esc)"
            onClick={onClose}
            className="grid size-[22px] place-items-center rounded-[5px] text-muted-foreground hover:bg-border hover:text-foreground"
          >
            <svg viewBox="0 0 10 10" className="size-[10px]" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
              <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" />
            </svg>
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export const Search = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(function Search(props, ref) {
  return (
    <div className="p-[10px] pb-[6px]">
      <input
        ref={ref}
        spellCheck={false}
        {...props}
        className="h-[32px] w-full rounded-[6px] border bg-background px-[10px] outline-none placeholder:text-muted-foreground focus:border-primary focus:ring-[3px] focus:ring-primary/25"
      />
    </div>
  );
});

export function Row({ picked, className, ...props }: { picked: boolean } & React.LiHTMLAttributes<HTMLLIElement>) {
  return (
    <li
      {...props}
      className={cn(
        "flex h-[32px] cursor-default items-center justify-between gap-[12px] rounded-[6px] px-[10px]",
        picked && "bg-selection",
        className,
      )}
    />
  );
}

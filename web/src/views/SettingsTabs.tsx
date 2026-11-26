// The strip at the head of the Settings tab's two pages (Settings.tsx and
// Brains.tsx): the one shown underlined, the other a click away.
// corkboard.settings swaps what the tab's window shows, as <Tab> does there.

import { cn } from "@/lib/utils";
import type { Nvim } from "@/nvim/context";

const TABS = [
  ["settings", "Settings"],
  ["brains", "Brains"],
] as const;

export function SettingsTabs({ on, nvim }: { on: (typeof TABS)[number][0]; nvim: Nvim }) {
  return (
    <span role="tablist" className="flex flex-none gap-2ch">
      {TABS.map(([which, label]) => (
        <button
          key={which}
          type="button"
          role="tab"
          aria-selected={which === on}
          title={which === on ? undefined : `${label} (Tab)`}
          onClick={() => which !== on && nvim.lua("require('corkboard.settings').open(...)", which)}
          className={cn("cursor-pointer border-b", which === on ? "border-focus font-bold" : "border-transparent text-muted-foreground hover:text-foreground")}
        >
          {label}
        </button>
      ))}
    </span>
  );
}

import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// The grid units from index.css (h-row, py-half, px-ch, ...), so that a
// px-0 passed to a component replaces its px-ch rather than joining it.
const twMerge = extendTailwindMerge({
  extend: { theme: { spacing: ["row", "half", "ch", "2ch", "3ch"] } },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

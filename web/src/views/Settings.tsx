// The Settings tab: corkboard's settings by section, each with the control its
// type calls for (corkboard.settings declares them). Drawn over
// agent://settings, which owns the cursor and the keys; a click selects, and
// a control changes its setting there and then. A field being typed in has
// the keys until Enter, Esc or a click elsewhere hands them back.

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import type { Nvim } from "@/nvim/context";
import type { ViewProps } from "./index";

type Value = string | number | boolean | string[] | null;
type Option = { value: string | number; label: string };
type Setting = {
  key: string;
  label: string;
  type: "text" | "number" | "bool" | "color" | "enum" | "list";
  value: Value;
  theme?: string;
  default: Value;
  placeholder?: string;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  options?: Option[];
  modified: boolean;
};
type SettingsState = { selected?: string; sections: { title: string; items: Setting[] }[]; palette: (string | undefined)[] };
type Change = (v: Value) => void;

// A field's own press: the panel's (Panels.tsx) would keep the keys in
// Neovim.
const own = (e: React.MouseEvent) => e.stopPropagation();

export function Settings({ state, win, focused, nvim }: ViewProps<SettingsState>) {
  const root = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  useEffect(() => {
    root.current?.querySelector("[data-selected]")?.scrollIntoView({ block: "nearest" });
  }, [state.selected]);
  const pick = (key: string) => nvim.lua("require('corkboard.settings').select(...)", key, win);
  const set = (key: string) => (v: Value) => nvim.lua("require('corkboard.settings').set(...)", key, v);

  const q = query.trim().toLowerCase();
  const sections = state.sections
    .map((s) => ({ ...s, items: q ? s.items.filter((i) => `${s.title} ${i.label} ${i.key}`.toLowerCase().includes(q)) : s.items }))
    .filter((s) => s.items.length);

  return (
    <div ref={root} className="flex h-full flex-col gap-row overflow-y-auto px-2ch pt-row pb-row">
      <header className="flex items-baseline gap-2ch">
        <span className="font-bold">Settings</span>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onMouseDown={own}
          onKeyDown={(e) => {
            if (e.key === "Escape") setQuery("");
            if (e.key === "Escape" || e.key === "Enter") nvim.refocus();
          }}
          placeholder="search"
          className="w-[40ch] min-w-0 border-b bg-transparent px-ch outline-none placeholder:text-muted-foreground focus:border-focus"
        />
      </header>
      {sections.map((s) => (
        <section key={s.title} className="flex flex-col">
          <h2 className="pl-2ch text-muted-foreground">{s.title}</h2>
          {s.items.map((item) => (
            <div
              key={item.key}
              data-selected={item.key === state.selected || undefined}
              onMouseDownCapture={() => item.key !== state.selected && pick(item.key)}
              className={cn(
                "group relative flex min-h-row items-center gap-2ch py-[calc(var(--cell-h)/4)] pr-ch pl-2ch",
                item.key === state.selected ? "bg-selection" : "hover:bg-accent",
                // Changed from its default, as VS Code marks it.
                item.modified && "before:absolute before:inset-y-0 before:left-0 before:w-[0.5ch] before:bg-focus",
              )}
            >
              <span className={cn("w-[38ch] flex-none truncate", item.key === state.selected && focused && "font-bold")}>{item.label}</span>
              <div className="flex min-w-0 flex-1 items-center">
                <Control item={item} set={set(item.key)} palette={state.palette} nvim={nvim} />
              </div>
              {item.modified && (
                <button
                  type="button"
                  title="Reset (x)"
                  onClick={() => set(item.key)(null)}
                  className="flex-none cursor-pointer text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-foreground"
                >
                  ↺
                </button>
              )}
            </div>
          ))}
        </section>
      ))}
      {!sections.length && <p className="pl-2ch text-border">—</p>}
    </div>
  );
}

function Control({ item, set, palette, nvim }: { item: Setting; set: Change; palette: SettingsState["palette"]; nvim: Nvim }) {
  switch (item.type) {
    case "bool":
      return <Check on={!!(item.value ?? item.default)} set={set} />;
    case "number":
      return <NumberField item={item} set={set} nvim={nvim} />;
    case "enum":
      return <Choice item={item} set={set} nvim={nvim} />;
    case "color":
      return <ColorField item={item} set={set} palette={palette} nvim={nvim} />;
    case "list":
      return <List items={(item.value ?? item.default ?? []) as string[]} set={set} nvim={nvim} />;
    default:
      return <TextField value={(item.value as string) ?? ""} placeholder={item.placeholder} set={(v) => set(v || null)} nvim={nvim} />;
  }
}

function Check({ on, set }: { on: boolean; set: Change }) {
  return (
    <button type="button" role="checkbox" aria-checked={on} onClick={() => set(!on)} className="cursor-pointer outline-none hover:text-primary">
      {on ? "[✓]" : "[ ]"}
    </button>
  );
}

// Typed into, then handed to Neovim on Enter or leaving it; Esc puts it back.
// clear: empty again once handed over (a field that adds).
function TextField({
  value,
  placeholder,
  set,
  nvim,
  className,
  clear,
}: { value: string; placeholder?: string; set: (v: string) => void; nvim: Nvim; className?: string; clear?: boolean }) {
  const [draft, setDraft] = useState(value);
  const cancelled = useRef(false);
  useEffect(() => setDraft(value), [value]);
  return (
    <input
      value={draft}
      placeholder={placeholder}
      onMouseDown={own}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (cancelled.current) setDraft(value);
        else if (draft !== value) set(draft);
        if (clear) setDraft("");
        cancelled.current = false;
      }}
      onKeyDown={(e) => {
        cancelled.current = e.key === "Escape";
        if (e.key === "Enter" || e.key === "Escape") {
          e.currentTarget.blur();
          nvim.refocus();
        }
      }}
      className={cn("w-[30ch] min-w-0 border-b bg-transparent px-ch outline-none placeholder:text-muted-foreground focus:border-focus", className)}
    />
  );
}

// − field +, with a bar of cells to drag along where the range has both
// ends. Empty, a setting with no default goes back to none.
function NumberField({ item, set, nvim }: { item: Setting; set: Change; nvim: Nvim }) {
  const value = (item.value ?? item.default) as number | null;
  const step = item.step ?? 1;
  const clamp = (n: number) => Math.min(item.max ?? Infinity, Math.max(item.min ?? -Infinity, n));
  const to = (n: number) => set(clamp(Math.round(n / step) * step));
  const dollars = item.unit === "$";
  return (
    <span className="flex items-center gap-ch">
      <Step onClick={() => to((value ?? item.min ?? 0) - step)}>−</Step>
      {dollars && <span className="text-muted-foreground">$</span>}
      <TextField
        value={value == null ? "" : String(value)}
        placeholder={item.placeholder}
        set={(v) => (v.trim() === "" ? set(null) : Number.isFinite(Number(v)) && to(Number(v)))}
        nvim={nvim}
        className="w-[10ch] text-right tabular-nums"
      />
      {item.unit && !dollars && <span className="text-muted-foreground">{item.unit}</span>}
      <Step onClick={() => to((value ?? item.min ?? 0) + step)}>+</Step>
      {item.min != null && item.max != null && <Slider value={value ?? item.min} min={item.min} max={item.max} to={to} />}
    </span>
  );
}

function Step({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="w-2ch flex-none cursor-pointer text-muted-foreground hover:text-foreground">
      {children}
    </button>
  );
}

const CELLS = 24;

function Slider({ value, min, max, to }: { value: number; min: number; max: number; to: (n: number) => void }) {
  const at = Math.round(((value - min) / (max - min)) * (CELLS - 1));
  const from = (e: React.PointerEvent<HTMLSpanElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    to(min + Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * (max - min));
  };
  return (
    <span
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        from(e);
      }}
      onPointerMove={(e) => e.currentTarget.hasPointerCapture(e.pointerId) && from(e)}
      className="ml-2ch cursor-pointer whitespace-pre select-none"
    >
      <span className="text-focus">{"━".repeat(at)}●</span>
      <span className="text-border">{"─".repeat(CELLS - 1 - at)}</span>
    </span>
  );
}

// A popover under its button, shut by a click outside it or Esc.
function usePopover(nvim: Nvim) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const shut = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    addEventListener("mousedown", shut, true);
    return () => removeEventListener("mousedown", shut, true);
  }, [open]);
  const close = () => {
    setOpen(false);
    nvim.refocus();
  };
  return { open, setOpen, close, ref };
}

const POPOVER = "absolute top-full left-0 z-10 flex flex-col border bg-background";

// A choice from a list, filtered as you type, with ↑/↓ and Enter.
function Choice({ item, set, nvim }: { item: Setting; set: Change; nvim: Nvim }) {
  const { open, setOpen, close, ref } = usePopover(nvim);
  const [filter, setFilter] = useState("");
  const [at, setAt] = useState(0);
  const list = useRef<HTMLUListElement>(null);
  const options = item.options ?? [];
  const value = item.value ?? item.default;
  const current = options.find((o) => o.value === value);
  const shown = options.filter((o) => o.label.toLowerCase().includes(filter.toLowerCase()));
  useEffect(() => {
    if (!open) return;
    setFilter("");
    setAt(Math.max(0, options.findIndex((o) => o.value === value)));
  }, [open]);
  useEffect(() => {
    list.current?.children[at]?.scrollIntoView({ block: "nearest" });
  }, [at, open]);
  const choose = (o?: Option) => {
    if (o) set(o.value);
    close();
  };
  return (
    <span ref={ref} className="relative">
      <button type="button" onClick={() => setOpen(!open)} className="cursor-pointer border-b px-ch hover:border-focus">
        {current?.label ?? (value as string) ?? "—"} <span className="text-muted-foreground">▾</span>
      </button>
      {open && (
        <span className={cn(POPOVER, "w-[30ch]")}>
          {options.length > 8 && (
            <input
              autoFocus
              value={filter}
              onMouseDown={own}
              onChange={(e) => {
                setFilter(e.target.value);
                setAt(0);
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") setAt(Math.min(shown.length - 1, at + 1));
                else if (e.key === "ArrowUp") setAt(Math.max(0, at - 1));
                else if (e.key === "Enter") choose(shown[at]);
                else if (e.key === "Escape") close();
                else return;
                e.preventDefault();
              }}
              className="border-b bg-transparent px-ch outline-none"
            />
          )}
          <ul ref={list} role="listbox" className="max-h-[calc(var(--cell-h)*12)] overflow-y-auto">
            {shown.map((o, i) => (
              <li
                key={String(o.value)}
                role="option"
                aria-selected={o.value === value}
                onMouseEnter={() => setAt(i)}
                onClick={() => choose(o)}
                className={cn("flex cursor-pointer gap-ch px-ch", i === at && "bg-selection")}
              >
                <span className="w-ch flex-none text-focus">{o.value === value ? "●" : ""}</span>
                <span className="truncate">{o.label}</span>
              </li>
            ))}
            {!shown.length && <li className="px-ch text-border">—</li>}
          </ul>
        </span>
      )}
    </span>
  );
}

// A swatch and its hex; open, the colorscheme's own, its terminal colors,
// the system's picker and a field for a hex.
function ColorField({ item, set, palette, nvim }: { item: Setting; set: Change; palette: SettingsState["palette"]; nvim: Nvim }) {
  const { open, setOpen, close, ref } = usePopover(nvim);
  const value = (item.value as string | null) ?? item.theme ?? null;
  const choose = (v: string | null) => {
    set(v);
    close();
  };
  return (
    <span ref={ref} className="relative">
      <button type="button" onClick={() => setOpen(!open)} className="flex cursor-pointer items-center gap-ch">
        <Swatch color={value} />
        <span className={cn("tabular-nums", !item.value && "text-muted-foreground")}>{value ?? "—"}</span>
      </button>
      {open && (
        <span className={cn(POPOVER, "gap-half px-ch py-half")}>
          <button type="button" onClick={() => choose(null)} className="flex cursor-pointer items-center gap-ch hover:text-primary">
            <Swatch color={item.theme ?? null} /> theme
          </button>
          <span className="grid grid-cols-[repeat(8,2ch)]">
            {palette.map((c, i) =>
              c ? (
                <button key={i} type="button" title={c} onClick={() => choose(c)} className="cursor-pointer hover:outline hover:outline-foreground">
                  <Swatch color={c} />
                </button>
              ) : (
                <span key={i} />
              ),
            )}
          </span>
          <span className="flex items-center gap-ch">
            <label className="relative cursor-pointer hover:text-primary">
              pick…
              <input
                type="color"
                value={value ?? "#000000"}
                onMouseDown={own}
                onChange={(e) => set(e.target.value)}
                className="absolute inset-0 cursor-pointer opacity-0"
              />
            </label>
            <TextField
              value={value ?? ""}
              set={(v) => /^#[0-9a-f]{6}$/i.test(v.trim()) && choose(v.trim().toLowerCase())}
              nvim={nvim}
              className="w-[10ch]"
            />
          </span>
        </span>
      )}
    </span>
  );
}

function Swatch({ color }: { color: string | null }) {
  return <span className="inline-block h-[calc(var(--cell-h)-4px)] w-2ch border" style={{ background: color ?? "transparent" }} />;
}

// Each entry, with × to drop it, and a field to add one.
function List({ items, set, nvim }: { items: string[]; set: Change; nvim: Nvim }) {
  return (
    <span className="flex flex-wrap items-center gap-ch">
      {items.map((x, i) => (
        <span key={i} className="flex items-center border px-ch">
          {x}
          <button
            type="button"
            title="Remove"
            onClick={() => set(items.filter((_, j) => j !== i))}
            className="ml-ch cursor-pointer text-muted-foreground hover:text-destructive"
          >
            ×
          </button>
        </span>
      ))}
      <TextField value="" placeholder="+ add" set={(v) => v.trim() && set([...items, v.trim()])} nvim={nvim} className="w-[16ch]" clear />
    </span>
  );
}

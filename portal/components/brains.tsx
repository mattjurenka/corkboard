"use client"

import { useCallback, useEffect, useState } from "react"

import { Status } from "@/components/frame"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { api, type Brain } from "@/lib/api"
import { cn } from "@/lib/utils"

// Who agents work for (cloud/src/brains.ts): a pane per brain, its title in
// the top rule as a TUI draws one, what it's for, its particulars as
// labelled fields, and what you can do with it along its foot. Archived
// ones, when shown, are dim under their own heading, and only they can be
// purged.

type ApiError = Error & { status?: number; body?: { brain?: Brain } }

const ago = (iso: string | null | undefined) => {
  if (!iso) return null
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000)
  if (s < 60) return "now"
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

const count = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))
const plural = (n: number, one: string, many: string) => `${count(n)} ${n === 1 ? one : many}`

export function Brains() {
  const [brains, setBrains] = useState<Brain[] | null>(null)
  const [archived, setArchived] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<Brain | "new" | null>(null)

  const refresh = useCallback(async () => {
    try {
      setBrains(await api<Brain[]>("GET", "/api/brains" + (archived ? "?archived=1" : "")))
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [archived])

  useEffect(() => {
    refresh()
  }, [refresh])

  const live = brains?.filter((b) => !b.archived)
  const gone = brains?.filter((b) => b.archived)
  const grid = (list?: Brain[]) =>
    !!list?.length && (
      <div className="grid grid-cols-1 gap-x-[2ch] gap-y-[22px] pt-[11px] lg:grid-cols-2">
        {list.map((b) => (
          <BrainCard key={b.name} brain={b} onChanged={refresh} onEdit={() => setEditing(b)} />
        ))}
      </div>
    )

  return (
    <>
      {error && <p className="text-blocked">{error}</p>}
      {brains === null && !error && <p className="text-dim">…</p>}
      {live?.length === 0 && <p className="text-dim">No brains.</p>}
      {grid(live)}
      {!!gone?.length && (
        <>
          <h2 className="pt-[22px] text-dim">Archived</h2>
          {grid(gone)}
        </>
      )}
      <Status>
        <span>{live ? `${live.length} ${live.length === 1 ? "brain" : "brains"}` : ""}</span>
        <button className="hover:underline" onClick={() => setArchived(!archived)}>
          <span className="text-ink">{archived ? "■" : "□"}</span> archived
        </button>
        <button className="ml-auto text-link hover:underline" onClick={() => setEditing("new")}>
          + new brain
        </button>
      </Status>
      {editing && <BrainForm brain={editing === "new" ? null : editing} brains={live ?? []} onClose={() => setEditing(null)} onSaved={refresh} />}
    </>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-[1ch]">
      <span className="w-[8ch] flex-none text-dim">{label}</span>
      <span className="flex min-w-0 flex-wrap gap-x-[1ch] break-words">{children}</span>
    </div>
  )
}

function BrainCard({ brain: b, onChanged, onEdit }: { brain: Brain; onChanged: () => void; onEdit: () => void }) {
  const [problem, setProblem] = useState<string | null>(null)
  const [asking, setAsking] = useState<"archive" | "purge" | null>(null)
  const [typed, setTyped] = useState("")
  const [busy, setBusy] = useState(false)

  async function act(method: string, path: string) {
    setBusy(true)
    try {
      await api(method, path)
      setAsking(null)
      setTyped("")
      setProblem(null)
      onChanged()
    } catch (e) {
      setProblem((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const m = b.memory
  const tags = (items: string[]) =>
    items.map((t) => (
      <span key={t} className="bg-raise px-[1ch]">
        {t}
      </span>
    ))

  return (
    <section className={cn("pane", b.archived && "opacity-60")}>
      <div className="pane-title">
        <span>
          <span className="font-bold">{b.title}</span>
          {b.name !== b.title.toLowerCase() && <span className="text-dim"> {b.name}</span>}
        </span>
      </div>
      {b.default && (
        <span className="pane-title-end text-working" title="Your own sessions remember here">
          ● default
        </span>
      )}
      {b.archived && <span className="pane-title-end text-dim">archived {ago(b.archived)}</span>}
      <div className="flex flex-col pt-[2px]">
        {b.description && <p className="whitespace-pre-wrap">{b.description}</p>}
        <div className="flex flex-col pt-[4px]">
          {m && (
            <Field label="memory">
              {m.notes + m.entries + m.episodes === 0 ? (
                <span className="text-dim">empty</span>
              ) : (
                <span>
                  {plural(m.notes, "note", "notes")} · {plural(m.entries, "log entry", "log entries")} · {plural(m.episodes, "session", "sessions")}
                </span>
              )}
            </Field>
          )}
          {m?.lastEpisode && <Field label="active">{ago(m.lastEpisode)}</Field>}
          <Field label="runs as">{b.account ?? <span className="text-dim">the machine's default account</span>}</Field>
          {!!b.credentials.length && (
            <Field label="holds">
              {tags(b.credentials)}
              <span className="text-review">agents need your OK to spawn it</span>
            </Field>
          )}
          {!!b.abilities.length && <Field label="can">{tags(b.abilities)}</Field>}
        </div>
        {problem && <p className="text-blocked">{problem}</p>}
        <div className="mt-[6px] flex flex-wrap items-center gap-x-[2ch] border-t border-rule pt-[4px]">
          {!b.archived && asking === null && (
            <>
              <button className="text-link hover:underline" onClick={onEdit}>
                edit
              </button>
              <button className="text-dim hover:text-ink hover:underline" onClick={() => setAsking("archive")}>
                archive
              </button>
            </>
          )}
          {asking === "archive" && (
            <>
              <span>archive {b.name}?</span>
              <button disabled={busy} className="text-blocked hover:underline" onClick={() => act("DELETE", `/api/brains/${b.name}`)}>
                yes
              </button>
              <button className="text-dim hover:underline" onClick={() => setAsking(null)}>
                no
              </button>
            </>
          )}
          {b.archived && asking === null && (
            <>
              <button disabled={busy} className="text-link hover:underline" onClick={() => act("POST", `/api/brains/${b.name}/restore`)}>
                restore
              </button>
              <button className="text-blocked hover:underline" onClick={() => setAsking("purge")}>
                purge
              </button>
            </>
          )}
          {asking === "purge" && (
            <form
              className="flex items-center gap-[1ch]"
              onSubmit={(e) => {
                e.preventDefault()
                if (typed === b.name) act("DELETE", `/api/brains/${b.name}?purge=${encodeURIComponent(typed)}`)
              }}
            >
              <Input
                autoFocus
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                placeholder={b.name}
                autoComplete="off"
                spellCheck={false}
                className="h-auto w-[20ch] border-rule bg-transparent px-[1ch] py-[2px]"
              />
              <button type="submit" disabled={busy || typed !== b.name} className="text-blocked hover:underline disabled:text-dim disabled:no-underline">
                purge
              </button>
              <button type="button" className="text-dim hover:underline" onClick={() => setAsking(null)}>
                no
              </button>
            </form>
          )}
        </div>
      </div>
    </section>
  )
}

const ABILITIES = ["chat"]
const LABEL = /^[\w.-]{1,64}$/

type Draft = { name: string; title: string; description: string; account: string | null; credentials: string[]; abilities: string[]; default: boolean }

const draftOf = (b: Brain | null): Draft => ({
  name: b?.name ?? "",
  title: b?.title ?? "",
  description: b?.description ?? "",
  account: b?.account ?? null,
  credentials: b?.credentials ?? [],
  abilities: b?.abilities ?? [],
  default: b?.default ?? false,
})

// A title as a name: lowercase, dashes, starting with a letter, at most 32.
const slug = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .slice(0, 32)
    .replace(/-+$/, "")

const uniq = (xs: (string | null | undefined)[]) => [...new Set(xs.filter((x): x is string => !!x))].sort()
const toggle = (xs: string[], x: string) => (xs.includes(x) ? xs.filter((y) => y !== x) : [...xs, x])

// A new brain, or one's fields but its name. The account and what it holds
// are tags from the live brains', or one added; a new brain names itself
// from its title and may start from another, taking its account, what it
// holds and its abilities. A stale edit gets the brain as it is now; saving
// again goes over that.
function BrainForm({ brain, brains, onClose, onSaved }: { brain: Brain | null; brains: Brain[]; onClose: () => void; onSaved: () => void }) {
  const [base, setBase] = useState(brain)
  const [d, setD] = useState<Draft>(draftOf(brain))
  const [from, setFrom] = useState<string | null>(null)
  const [named, setNamed] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const set = (f: Partial<Draft>) => setD((x) => ({ ...x, ...f }))
  const accounts = uniq([...brains.map((b) => b.account), d.account])
  const labels = uniq([...brains.flatMap((b) => b.credentials), ...d.credentials])

  const start = (b: Brain | null) => {
    setFrom(b?.name ?? null)
    set({ account: b?.account ?? null, credentials: b?.credentials ?? [], abilities: b?.abilities ?? [] })
  }

  async function save(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    const { name, ...fields } = d
    try {
      if (base) await api("PATCH", `/api/brains/${base.name}`, { ...fields, updated: base.updated })
      else await api("POST", "/api/brains", { name, ...fields })
      onSaved()
      onClose()
    } catch (err) {
      const e = err as ApiError
      if (e.status === 409 && e.body?.brain) {
        setBase(e.body.brain)
        setD(draftOf(e.body.brain))
        setProblem(`${e.message}; this is it now`)
      } else setProblem(e.message)
    } finally {
      setBusy(false)
    }
  }

  const row = (label: string, el: React.ReactNode, id?: string) => (
    <>
      <label htmlFor={id} className="pt-[2px] text-dim">
        {label}
      </label>
      {el}
    </>
  )
  const starting = !base && brains.length > 0

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="border border-link bg-background p-[2ch] sm:max-w-[84ch]">
        <DialogHeader>
          <DialogTitle className="font-bold">
            {base ? (
              <>
                <span className="text-link">edit</span> {base.title}
              </>
            ) : (
              <span className="text-link">new brain</span>
            )}
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={save} className="flex flex-col gap-[8px]">
          <div className={cn("grid gap-[2ch]", starting && "sm:grid-cols-[22ch_1fr]")}>
            {starting && (
              <fieldset className="flex flex-col border-rule sm:border-r sm:pr-[1ch]">
                <legend className="pb-[4px] text-dim">start from</legend>
                <Start on={from === null} onClick={() => start(null)}>
                  blank
                </Start>
                {brains.map((b) => (
                  <Start key={b.name} on={from === b.name} onClick={() => start(b)}>
                    like {b.title}
                  </Start>
                ))}
              </fieldset>
            )}
            <div className="grid grid-cols-[9ch_1fr] items-start gap-x-[1ch] gap-y-[10px]">
              {row(
                "title",
                <Input
                  id="brain-title"
                  autoFocus
                  value={d.title}
                  onChange={(e) => set(base || named ? { title: e.target.value } : { title: e.target.value, name: slug(e.target.value) })}
                  autoComplete="off"
                  className={input}
                />,
                "brain-title",
              )}
              {!base &&
                row(
                  "name",
                  <Input
                    id="brain-name"
                    value={d.name}
                    onChange={(e) => {
                      setNamed(true)
                      set({ name: e.target.value.toLowerCase() })
                    }}
                    autoComplete="off"
                    spellCheck={false}
                    className={cn(input, "text-dim focus:text-foreground")}
                  />,
                  "brain-name",
                )}
              {row(
                "about",
                <textarea
                  id="brain-about"
                  value={d.description}
                  onChange={(e) => set({ description: e.target.value })}
                  rows={3}
                  className="min-w-0 resize-none border border-rule bg-transparent px-[1ch] py-[2px]"
                />,
                "brain-about",
              )}
              {row(
                "runs as",
                <div className="flex flex-wrap gap-[1ch]">
                  {accounts.map((a) => (
                    <Tag key={a} on={d.account === a} mark={d.account === a ? "●" : "○"} onClick={() => set({ account: a })}>
                      {a}
                    </Tag>
                  ))}
                  <Tag on={d.account === null} mark={d.account === null ? "●" : "○"} onClick={() => set({ account: null })}>
                    machine default
                  </Tag>
                  <Add what="account" onAdd={(a) => set({ account: a })} />
                </div>,
              )}
              {row(
                "holds",
                <div className="flex flex-col gap-[4px]">
                  <div className="flex flex-wrap gap-[1ch]">
                    {labels.map((l) => {
                      const on = d.credentials.includes(l)
                      return (
                        <Tag key={l} on={on} mark={on ? "✓" : "+"} onClick={() => set({ credentials: toggle(d.credentials, l) })}>
                          {l}
                        </Tag>
                      )
                    })}
                    <Add what="label" onAdd={(l) => set({ credentials: d.credentials.includes(l) ? d.credentials : [...d.credentials, l] })} />
                  </div>
                  {d.credentials.length > 0 && <span className="text-review">agents need your OK to spawn it</span>}
                </div>,
              )}
              {row(
                "can",
                <div className="flex flex-wrap gap-x-[2ch]">
                  {ABILITIES.map((a) => (
                    <Check key={a} on={d.abilities.includes(a)} onClick={() => set({ abilities: toggle(d.abilities, a) })}>
                      {a}
                    </Check>
                  ))}
                  <Check on={d.default} onClick={() => set({ default: !d.default })}>
                    default
                  </Check>
                </div>,
              )}
            </div>
          </div>
          {problem && <p className="text-blocked">{problem}</p>}
          <div className="flex justify-end gap-[1ch] border-t border-rule pt-[8px]">
            <Button type="button" variant="ghost" onClick={onClose} className="h-auto px-[1ch] py-[2px]">
              cancel
            </Button>
            <Button type="submit" variant="outline" disabled={busy || !d.title.trim() || (!base && !d.name)} className="h-auto px-[1ch] py-[2px]">
              {busy ? "…" : base ? "save" : "make it"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

const input = "h-auto border-rule bg-transparent px-[1ch] py-[2px]"

// A tag, lit when it's picked.
function Tag({ on, mark, onClick, children }: { on: boolean; mark: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cn("border px-[1ch]", on ? "border-link bg-link/15 text-foreground" : "border-rule text-dim hover:text-foreground")}
    >
      {mark} {children}
    </button>
  )
}

// + what, which turns into a field for one; ⏎ adds it, esc leaves it.
function Add({ what, onAdd }: { what: string; onAdd: (v: string) => void }) {
  const [typing, setTyping] = useState<string | null>(null)
  if (typing === null)
    return (
      <button type="button" onClick={() => setTyping("")} className="border border-dashed border-rule px-[1ch] text-dim hover:text-foreground">
        + {what}
      </button>
    )
  const ok = LABEL.test(typing.trim())
  return (
    <input
      autoFocus
      aria-label={`new ${what}`}
      value={typing}
      onChange={(e) => setTyping(e.target.value)}
      onBlur={() => setTyping(null)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault()
          if (ok) onAdd(typing.trim())
          setTyping(null)
        } else if (e.key === "Escape") {
          e.preventDefault()
          e.stopPropagation()
          setTyping(null)
        }
      }}
      autoComplete="off"
      spellCheck={false}
      className={cn("w-[16ch] border bg-transparent px-[1ch] outline-none", ok || !typing ? "border-link" : "border-blocked")}
    />
  )
}

// [x] or [ ] and what it is.
function Check({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" role="checkbox" aria-checked={on} onClick={onClick} className="hover:text-link">
      {on ? "[x]" : "[ ]"} {children}
    </button>
  )
}

// One brain to start a new one from, ▸ when it's the one.
function Start({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" aria-pressed={on} onClick={onClick} className={cn("px-[1ch] text-left", on ? "bg-link/15 text-foreground" : "text-dim hover:text-foreground")}>
      <span className="text-link">{on ? "▸" : " "}</span> {children}
    </button>
  )
}

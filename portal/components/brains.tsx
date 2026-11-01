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
      {editing && <BrainForm brain={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={refresh} />}
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
              <span className="text-review">its spawns wait for you</span>
            </Field>
          )}
          {!!b.abilities.length && <Field label="can">{tags(b.abilities)}</Field>}
          <Field label="reaches">{b.egress.length ? b.egress.join("  ") : <span className="text-dim">only what its machine allows</span>}</Field>
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

const words = (s: string) => s.split(/[\s,]+/).filter(Boolean)

type Draft = { name: string; title: string; description: string; account: string; credentials: string; egress: string; chat: boolean; default: boolean }

const draftOf = (b: Brain | null): Draft => ({
  name: b?.name ?? "",
  title: b?.title ?? "",
  description: b?.description ?? "",
  account: b?.account ?? "",
  credentials: b?.credentials.join(" ") ?? "",
  egress: b?.egress.join(" ") ?? "",
  chat: b?.abilities.includes("chat") ?? false,
  default: b?.default ?? false,
})

// A new brain, or one's fields but its name. A stale edit gets the brain as
// it is now; saving again goes over that.
function BrainForm({ brain, onClose, onSaved }: { brain: Brain | null; onClose: () => void; onSaved: () => void }) {
  const [base, setBase] = useState(brain)
  const [d, setD] = useState<Draft>(draftOf(brain))
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }))

  async function save(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    const fields = {
      title: d.title,
      description: d.description,
      account: d.account.trim() || null,
      credentials: words(d.credentials),
      egress: words(d.egress),
      abilities: d.chat ? ["chat"] : [],
      default: d.default,
    }
    try {
      if (base) await api("PATCH", `/api/brains/${base.name}`, { ...fields, updated: base.updated })
      else await api("POST", "/api/brains", { name: d.name.trim(), ...fields })
      onSaved()
      onClose()
    } catch (err) {
      const e = err as ApiError
      if (e.status === 409 && e.body?.brain) {
        setBase(e.body.brain)
        setProblem(`${e.message}: ${e.body.brain.title}, ${e.body.brain.account ?? "no account"}, ${e.body.brain.credentials.join(" ") || "holds nothing"}`)
      } else setProblem(e.message)
    } finally {
      setBusy(false)
    }
  }

  const input = "h-auto border-rule bg-transparent px-[1ch] py-[2px]"
  const row = (label: string, el: React.ReactNode) => (
    <label className="flex items-baseline gap-[1ch]">
      <span className="w-[12ch] flex-none text-dim">{label}</span>
      {el}
    </label>
  )

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="border border-rule bg-ground p-[2ch] sm:max-w-[70ch]">
        <DialogHeader>
          <DialogTitle className="font-bold">{base ? base.name : "new brain"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={save} className="flex flex-col gap-[4px]">
          {!base && row("name", <Input value={d.name} onChange={(e) => set("name", e.target.value)} placeholder="lowercase-name" autoComplete="off" spellCheck={false} className={input} />)}
          {row("title", <Input value={d.title} onChange={(e) => set("title", e.target.value)} autoComplete="off" className={input} />)}
          {row(
            "description",
            <textarea
              value={d.description}
              onChange={(e) => set("description", e.target.value)}
              rows={3}
              className="min-w-0 flex-1 border border-rule bg-transparent px-[1ch] py-[2px]"
            />,
          )}
          {row("account", <Input value={d.account} onChange={(e) => set("account", e.target.value)} autoComplete="off" spellCheck={false} className={input} />)}
          {row("holds", <Input value={d.credentials} onChange={(e) => set("credentials", e.target.value)} placeholder="github google" autoComplete="off" spellCheck={false} className={input} />)}
          {row("egress", <Input value={d.egress} onChange={(e) => set("egress", e.target.value)} placeholder="api.github.com" autoComplete="off" spellCheck={false} className={input} />)}
          <div className="flex gap-[2ch] pl-[13ch]">
            <label className="flex cursor-pointer items-center gap-[1ch]">
              <input type="checkbox" checked={d.chat} onChange={(e) => set("chat", e.target.checked)} />
              chat
            </label>
            <label className="flex cursor-pointer items-center gap-[1ch]">
              <input type="checkbox" checked={d.default} onChange={(e) => set("default", e.target.checked)} />
              default
            </label>
          </div>
          {problem && <p className="text-blocked">{problem}</p>}
          <div className="flex justify-end gap-[1ch] pt-[4px]">
            <Button type="button" variant="ghost" onClick={onClose} className="h-auto px-[1ch] py-[2px]">
              cancel
            </Button>
            <Button type="submit" variant="outline" disabled={busy || !d.title.trim() || (!base && !d.name.trim())} className="h-auto px-[1ch] py-[2px]">
              save
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

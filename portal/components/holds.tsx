"use client"

import { useCallback, useEffect, useState } from "react"

import { ago, Field, input } from "@/components/brains"
import { Status } from "@/components/frame"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { api, type Hold, type Spawn } from "@/lib/api"
import { cn } from "@/lib/utils"

// What brains hold (cloud/src/holds.ts): the spawns waiting on you for
// holding them first, then a pane per hold, marked ● when its secret is
// here or said to be elsewhere, ◌ when neither, ○ when nobody holds it,
// with what it's for, its secret and who holds it. One a template holds is
// its host's Nix config's to rename or take out.

type ApiError = Error & { status?: number; body?: { hold?: Hold } }

const LABEL = /^[\w.-]{1,64}$/

const mark = (h: Hold) => (!h.brains.length && !h.templates.length ? "○" : h.secret || h.where ? "●" : "◌")

export function Holds() {
  const [holds, setHolds] = useState<Hold[] | null>(null)
  const [waiting, setWaiting] = useState<Spawn[]>([])
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<Hold | "new" | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [h, w] = await Promise.all([api<Hold[]>("GET", "/api/holds"), api<Spawn[]>("GET", "/api/spawns?state=pending-approval")])
      setHolds(h)
      setWaiting(w)
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  return (
    <>
      {error && <p className="text-blocked">{error}</p>}
      {holds === null && !error && <p className="text-dim">…</p>}
      {!!waiting.length && <Waiting spawns={waiting} holds={holds ?? []} onChanged={refresh} />}
      {holds?.length === 0 && <p className="text-dim">No holds.</p>}
      {!!holds?.length && (
        <div className="grid grid-cols-1 gap-x-[2ch] gap-y-[22px] pt-[11px] lg:grid-cols-2">
          {holds.map((h) => (
            <HoldCard key={h.name} hold={h} onChanged={refresh} onEdit={() => setEditing(h)} />
          ))}
        </div>
      )}
      <Status>
        <span>{holds ? `${holds.length} ${holds.length === 1 ? "hold" : "holds"}` : ""}</span>
        {!!waiting.length && <span className="text-review">{waiting.length} waiting</span>}
        <button className="ml-auto text-link hover:underline" onClick={() => setEditing("new")}>
          + new hold
        </button>
      </Status>
      {editing && <HoldForm hold={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={refresh} />}
    </>
  )
}

// The spawns an agent asked for that wait on you, each with what it holds,
// what it was asked to do, and approve or deny.
function Waiting({ spawns, holds, onChanged }: { spawns: Spawn[]; holds: Hold[]; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  async function act(id: string, what: "approve" | "stop") {
    setBusy(id)
    try {
      await api("POST", `/api/spawns/${id}/${what}`)
      setProblem(null)
      onChanged()
    } catch (e) {
      setProblem((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const held = (s: Spawn) =>
    holds.filter((h) => (s.brain && h.brains.includes(s.brain)) || h.templates.includes(`${s.environment}/${s.template}`)).map((h) => h.name)

  return (
    <section className="pane mt-[11px] border-review">
      <div className="pane-title">
        <span className="font-bold text-review">waiting on you</span>
      </div>
      <div className="flex flex-col gap-[10px] pt-[2px]">
        {spawns.map((s) => (
          <div key={s.id} className="flex flex-col">
            <div className="flex flex-wrap gap-x-[1ch]">
              <span className="font-bold">{s.by}</span>
              <span className="text-dim">wants</span>
              <span>{s.brain ?? s.template}</span>
              <span className="text-dim">
                on {s.environment}/{s.template} · {ago(s.created)}
              </span>
            </div>
            {!!held(s).length && (
              <Field label="holds">
                {held(s).map((n) => (
                  <span key={n} className="bg-raise px-[1ch]">
                    {n}
                  </span>
                ))}
              </Field>
            )}
            <p className="mt-[2px] max-h-[12lh] overflow-y-auto border-l border-rule pl-[1ch] whitespace-pre-wrap">{s.task}</p>
            <div className="flex gap-x-[2ch] pt-[2px]">
              <button disabled={busy === s.id} className="text-working hover:underline" onClick={() => act(s.id, "approve")}>
                approve
              </button>
              <button disabled={busy === s.id} className="text-blocked hover:underline" onClick={() => act(s.id, "stop")}>
                deny
              </button>
            </div>
          </div>
        ))}
        {problem && <p className="text-blocked">{problem}</p>}
      </div>
    </section>
  )
}

function HoldCard({ hold: h, onChanged, onEdit }: { hold: Hold; onChanged: () => void; onEdit: () => void }) {
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  async function remove() {
    setBusy(true)
    try {
      await api("DELETE", `/api/holds/${encodeURIComponent(h.name)}`)
      setAsking(false)
      onChanged()
    } catch (e) {
      setProblem((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const m = mark(h)
  const nobody = !h.brains.length && !h.templates.length

  return (
    <section className={cn("pane", nobody && "opacity-60")}>
      <div className="pane-title">
        <span>
          <span className={cn(m === "●" ? "text-working" : "text-dim")}>{m}</span> <span className="font-bold">{h.name}</span>
        </span>
      </div>
      {h.updated && <span className="pane-title-end text-dim">{ago(h.updated)}</span>}
      <div className="flex flex-col pt-[2px]">
        {h.about && <p className="whitespace-pre-wrap">{h.about}</p>}
        <div className="flex flex-col pt-[4px]">
          <Field label="secret">{h.secret ? <span>set {ago(h.secret)}</span> : <span className="text-dim">none here</span>}</Field>
          {h.where && <Field label="where">{h.where}</Field>}
          <Field label="held by">
            {nobody && <span className="text-dim">nobody</span>}
            {h.brains.map((b) => (
              <span key={b} className="bg-raise px-[1ch]">
                {b}
              </span>
            ))}
            {h.templates.map((t) => (
              <span key={t} className="bg-raise px-[1ch]">
                {t} <span className="text-dim">nix</span>
              </span>
            ))}
          </Field>
        </div>
        {problem && <p className="text-blocked">{problem}</p>}
        <div className="mt-[6px] flex flex-wrap items-center gap-x-[2ch] border-t border-rule pt-[4px]">
          {!asking && (
            <>
              <button className="text-link hover:underline" onClick={onEdit}>
                {h.recorded ? "edit" : "describe"}
              </button>
              {!h.templates.length && (
                <button className="text-dim hover:text-ink hover:underline" onClick={() => setAsking(true)}>
                  delete
                </button>
              )}
            </>
          )}
          {asking && (
            <>
              <span>
                delete {h.name}
                {!!h.brains.length && <span className="text-dim"> and take it off {h.brains.join(", ")}</span>}?
              </span>
              <button disabled={busy} className="text-blocked hover:underline" onClick={remove}>
                yes
              </button>
              <button className="text-dim hover:underline" onClick={() => setAsking(false)}>
                no
              </button>
            </>
          )}
        </div>
      </div>
    </section>
  )
}

type Draft = { name: string; about: string; where: string; secret: string; forget: boolean }

const draftOf = (h: Hold | null): Draft => ({ name: h?.name ?? "", about: h?.about ?? "", where: h?.where ?? "", secret: "", forget: false })

// A new hold, or one's fields. One with no record yet is made under its own
// name first, then renamed if the name changed, so the brains holding it
// move with it. A stale edit gets the hold as it is now.
function HoldForm({ hold, onClose, onSaved }: { hold: Hold | null; onClose: () => void; onSaved: () => void }) {
  const [base, setBase] = useState(hold)
  const [d, setD] = useState<Draft>(draftOf(hold))
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const set = (f: Partial<Draft>) => setD((x) => ({ ...x, ...f }))
  const fixed = !!base?.templates.length

  async function save(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    const fields = {
      about: d.about,
      where: d.where.trim() || null,
      ...(d.secret ? { secret: d.secret } : d.forget && { secret: null }),
    }
    try {
      if (!base) await api("POST", "/api/holds", { name: d.name, ...fields })
      else {
        let updated = base.updated
        if (!base.recorded) {
          const made = await api<Hold>("POST", "/api/holds", { name: base.name, ...fields })
          setBase(made)
          updated = made.updated
        }
        if (base.recorded || d.name !== base.name)
          await api("PATCH", `/api/holds/${encodeURIComponent(base.name)}`, {
            updated,
            ...(d.name !== base.name && { name: d.name }),
            ...(base.recorded && fields),
          })
      }
      onSaved()
      onClose()
    } catch (err) {
      const e = err as ApiError
      if (e.status === 409 && e.body?.hold) {
        const now = { ...base!, ...e.body.hold, recorded: true }
        setBase(now)
        setD(draftOf(now))
        setProblem(`${e.message}; this is it now`)
      } else setProblem(e.message)
      onSaved()
    } finally {
      setBusy(false)
    }
  }

  const row = (label: string, id: string, el: React.ReactNode) => (
    <>
      <label htmlFor={id} className="pt-[2px] text-dim">
        {label}
      </label>
      {el}
    </>
  )
  const named = LABEL.test(d.name)

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="border border-link bg-background p-[2ch] sm:max-w-[72ch]">
        <DialogHeader>
          <DialogTitle className="font-bold">
            {base ? (
              <>
                <span className="text-link">edit</span> {base.name}
              </>
            ) : (
              <span className="text-link">new hold</span>
            )}
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={save} className="flex flex-col gap-[8px]">
          <div className="grid grid-cols-[8ch_1fr] items-start gap-x-[1ch] gap-y-[10px]">
            {row(
              "name",
              "hold-name",
              <Input
                id="hold-name"
                autoFocus={!base}
                readOnly={fixed}
                value={d.name}
                onChange={(e) => set({ name: e.target.value })}
                autoComplete="off"
                spellCheck={false}
                className={cn(input, fixed && "text-dim", d.name && !named && "border-blocked")}
              />,
            )}
            {row(
              "about",
              "hold-about",
              <textarea
                id="hold-about"
                autoFocus={!!base}
                value={d.about}
                onChange={(e) => set({ about: e.target.value })}
                rows={3}
                className="min-w-0 resize-none border border-rule bg-transparent px-[1ch] py-[2px]"
              />,
            )}
            {row(
              "secret",
              "hold-secret",
              <div className="flex items-center gap-[1ch]">
                <Input
                  id="hold-secret"
                  type="password"
                  value={d.secret}
                  onChange={(e) => set({ secret: e.target.value, forget: false })}
                  placeholder={base?.secret && !d.forget ? `set ${ago(base.secret)}` : ""}
                  autoComplete="new-password"
                  className={cn(input, "min-w-0 flex-1")}
                />
                {base?.secret && !d.secret && (
                  <button
                    type="button"
                    aria-pressed={d.forget}
                    onClick={() => set({ forget: !d.forget })}
                    className={cn("flex-none hover:underline", d.forget ? "text-blocked line-through" : "text-dim")}
                  >
                    forget
                  </button>
                )}
              </div>,
            )}
            {row(
              "where",
              "hold-where",
              <Input id="hold-where" value={d.where} onChange={(e) => set({ where: e.target.value })} autoComplete="off" className={input} />,
            )}
          </div>
          {problem && <p className="text-blocked">{problem}</p>}
          <div className="flex justify-end gap-[1ch] border-t border-rule pt-[8px]">
            <Button type="button" variant="ghost" onClick={onClose} className="h-auto px-[1ch] py-[2px]">
              cancel
            </Button>
            <Button type="submit" variant="outline" disabled={busy || !named} className="h-auto px-[1ch] py-[2px]">
              {busy ? "…" : base ? "save" : "make it"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

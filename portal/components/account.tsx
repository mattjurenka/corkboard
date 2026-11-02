"use client"

import { useCallback, useEffect, useMemo, useState } from "react"

import { ago, Field, input } from "@/components/brains"
import { Status, useMe } from "@/components/frame"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { api, type Bridge, type Grant, type MachineToken, type Me } from "@/lib/api"
import { cn } from "@/lib/utils"

// The account (cloud/src/api.ts's /api/me): a pane for who you are and
// where your days are, then one each for what's signed in as you, the
// machines' tokens and the bridges connected now, each with its way out.

export function Account() {
  const { me, setMe } = useMe()
  const [grants, setGrants] = useState<Grant[] | null>(null)
  const [machines, setMachines] = useState<MachineToken[]>([])
  const [bridges, setBridges] = useState<Bridge[]>([])
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [m, g, t, b] = await Promise.all([
        api<Me>("GET", "/api/me"),
        api<Grant[]>("GET", "/api/grants"),
        api<MachineToken[]>("GET", "/api/tokens/machine"),
        api<Bridge[]>("GET", "/api/sessions"),
      ])
      setMe(m)
      setGrants(g)
      setMachines(t)
      setBridges(b)
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [setMe])

  useEffect(() => {
    refresh()
  }, [refresh])

  return (
    <>
      {error && <p className="text-blocked">{error}</p>}
      {!me && !error && <p className="text-dim">…</p>}
      <div className="grid grid-cols-1 gap-x-[2ch] gap-y-[22px] pt-[11px] lg:grid-cols-2">
        {me && <You me={me} onSaved={setMe} />}
        {grants && (
          <List title="signed in" empty={!grants.length}>
            {grants.map((g) => (
              <Row
                key={g.id}
                what={
                  <>
                    <span className="font-bold">{g.client}</span> <span className="text-dim">{g.scope.join(" ")}</span>
                    {g.current && <span className="text-working"> ●</span>}
                  </>
                }
                when={ago(g.created)}
                act="sign out"
                onAct={() => api("DELETE", `/api/grants/${encodeURIComponent(g.id)}`).then(refresh)}
              />
            ))}
          </List>
        )}
        {grants && (
          <List title="machines" empty={!machines.length}>
            {machines.map((t) => (
              <Row
                key={t.id}
                what={
                  <>
                    <span className="font-bold">{t.environment}</span>
                    {t.label && <span className="text-dim"> {t.label}</span>}
                    {t.expires && <span className="text-dim"> · until {t.expires.slice(0, 10)}</span>}
                  </>
                }
                when={t.used ? ago(t.used) : "unused"}
                act="revoke"
                onAct={() => api("DELETE", `/api/tokens/machine/${t.id}`).then(refresh)}
              />
            ))}
          </List>
        )}
        {grants && (
          <List title="bridges" empty={!bridges.length}>
            {bridges.map((b) => (
              <Row
                key={b.id}
                what={
                  <>
                    <span className="font-bold">{b.machine || b.id}</span>
                    {b.environment && <span className="text-dim"> {b.environment}</span>}
                  </>
                }
                when={<span className="text-working">●</span>}
                act="disconnect"
                onAct={() => api("DELETE", `/api/bridges/${encodeURIComponent(b.id)}`).then(refresh)}
              />
            ))}
          </List>
        )}
      </div>
      <Status>
        <span>{me?.email ?? ""}</span>
        {me?.role === "admin" && <span className="text-review">admin</span>}
      </Status>
    </>
  )
}

// The zones this browser knows, for the timezone field's suggestions.
const zones = () => {
  try {
    return (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf("timeZone")
  } catch {
    return []
  }
}

function You({ me, onSaved }: { me: Me; onSaved: (m: Me) => void }) {
  const [name, setName] = useState(me.settings.name ?? me.name ?? "")
  const [zone, setZone] = useState(me.settings.timezone)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const known = useMemo(zones, [])
  const here = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, [])
  const changed = name.trim() !== (me.settings.name ?? me.name ?? "") || zone !== me.settings.timezone

  async function save(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      onSaved(await api<Me>("PATCH", "/api/me", { name: name.trim() || null, timezone: zone }))
      setProblem(null)
    } catch (err) {
      setProblem((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="pane">
      <div className="pane-title">
        <span className="font-bold">{me.settings.name ?? me.name ?? me.email}</span>
      </div>
      <form onSubmit={save} className="flex flex-col gap-[6px] pt-[2px]">
        <Field label="email">{me.email}</Field>
        <div className="flex items-center gap-[1ch]">
          <label htmlFor="me-name" className="w-[8ch] flex-none text-dim">
            name
          </label>
          <Input id="me-name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" className={cn(input, "min-w-0 flex-1")} />
        </div>
        <div className="flex items-center gap-[1ch]">
          <label htmlFor="me-zone" className="w-[8ch] flex-none text-dim">
            zone
          </label>
          <Input id="me-zone" list="me-zones" value={zone} onChange={(e) => setZone(e.target.value)} spellCheck={false} className={cn(input, "min-w-0 flex-1")} />
          <datalist id="me-zones">
            {known.map((z) => (
              <option key={z} value={z} />
            ))}
          </datalist>
          {here && here !== zone && (
            <button type="button" className="flex-none text-link hover:underline" onClick={() => setZone(here)}>
              {here}
            </button>
          )}
        </div>
        <Field label="calendar">
          {me.features.calendar ? (
            <span>
              <span className="text-working">●</span> {me.settings.calendar ?? "connected"}
            </span>
          ) : (
            <a href="/calendar/connect" className="text-link hover:underline">
              connect
            </a>
          )}
        </Field>
        {problem && <p className="text-blocked">{problem}</p>}
        <div className="mt-[6px] flex justify-end border-t border-rule pt-[4px]">
          <Button type="submit" variant="outline" disabled={busy || !changed} className="h-auto px-[1ch] py-[2px]">
            {busy ? "…" : "save"}
          </Button>
        </div>
      </form>
    </section>
  )
}

function List({ title, empty, children }: { title: string; empty: boolean; children: React.ReactNode }) {
  return (
    <section className="pane">
      <div className="pane-title">
        <span className="font-bold">{title}</span>
      </div>
      <div className="flex flex-col pt-[2px]">{empty ? <span className="text-dim">none</span> : children}</div>
    </section>
  )
}

// One thing signed in, with its way out, which asks once before it goes.
function Row({ what, when, act, onAct }: { what: React.ReactNode; when: React.ReactNode; act: string; onAct: () => Promise<unknown> }) {
  const [asking, setAsking] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  return (
    <div className="flex flex-col border-b border-rule/60 py-[3px] last:border-b-0">
      <div className="flex flex-wrap items-baseline gap-x-[2ch]">
        <span className="min-w-0 flex-1 break-words">{what}</span>
        <span className="text-dim">{when}</span>
        {!asking && (
          <button className="text-dim hover:text-ink hover:underline" onClick={() => setAsking(true)}>
            {act}
          </button>
        )}
        {asking && (
          <span className="flex gap-x-[1ch]">
            <button className="text-blocked hover:underline" onClick={() => onAct().catch((e: Error) => setProblem(e.message)).finally(() => setAsking(false))}>
              {act}
            </button>
            <button className="text-dim hover:underline" onClick={() => setAsking(false)}>
              no
            </button>
          </span>
        )}
      </div>
      {problem && <p className="text-blocked">{problem}</p>}
    </div>
  )
}

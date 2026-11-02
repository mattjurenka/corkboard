"use client"

import { useCallback, useEffect, useState } from "react"

import { ago, input } from "@/components/brains"
import { Status, useMe } from "@/components/frame"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { api, type Account, type Invite } from "@/lib/api"
import { cn } from "@/lib/utils"

// Who's let in (cloud/src/registry.ts), for admins: everyone who has signed
// in, the waitlist first, each with what an admin can make of them; and the
// invites, each with its link, the newest first.

const ORDER: Account["status"][] = ["waitlisted", "active", "disabled"]
const MARK = { active: "●", waitlisted: "◌", disabled: "○" } as const
const COLOR = { active: "text-working", waitlisted: "text-review", disabled: "text-dim" } as const

export function Admin() {
  const { me } = useMe()
  const [accounts, setAccounts] = useState<Account[] | null>(null)
  const [invites, setInvites] = useState<Invite[]>([])
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [a, i] = await Promise.all([api<Account[]>("GET", "/api/admin/users"), api<Invite[]>("GET", "/api/admin/invites")])
      setAccounts(a)
      setInvites(i)
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const sorted = accounts?.slice().sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status))
  const waiting = accounts?.filter((a) => a.status === "waitlisted").length ?? 0

  return (
    <>
      {error && <p className="text-blocked">{error}</p>}
      {accounts === null && !error && <p className="text-dim">…</p>}
      <div className="grid grid-cols-1 gap-x-[2ch] gap-y-[22px] pt-[11px] lg:grid-cols-2">
        {sorted && (
          <section className="pane">
            <div className="pane-title">
              <span className="font-bold">users</span>
            </div>
            <div className="flex flex-col pt-[2px]">
              {sorted.map((a) => (
                <User key={a.sub} account={a} self={a.sub === me?.sub} onChanged={refresh} />
              ))}
            </div>
          </section>
        )}
        {accounts && <Invites invites={invites} onChanged={refresh} />}
      </div>
      <Status>
        <span>{accounts ? `${accounts.length} ${accounts.length === 1 ? "user" : "users"}` : ""}</span>
        {!!waiting && <span className="text-review">{waiting} waiting</span>}
      </Status>
    </>
  )
}

function User({ account: a, self, onChanged }: { account: Account; self: boolean; onChanged: () => void }) {
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  async function set(f: Partial<Pick<Account, "status" | "role">>) {
    setBusy(true)
    try {
      await api("PATCH", `/api/admin/users/${encodeURIComponent(a.sub)}`, f)
      setProblem(null)
      onChanged()
    } catch (e) {
      setProblem((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const act = (label: string, f: Partial<Pick<Account, "status" | "role">>, tone = "text-link") => (
    <button disabled={busy} className={cn(tone, "hover:underline")} onClick={() => set(f)}>
      {label}
    </button>
  )

  return (
    <div className="flex flex-col border-b border-rule/60 py-[3px] last:border-b-0">
      <div className="flex flex-wrap items-baseline gap-x-[2ch]">
        <span className="min-w-0 flex-1 break-words">
          <span className={COLOR[a.status]}>{MARK[a.status]}</span> <span className="font-bold">{a.name ?? a.email}</span>
          {a.name && <span className="text-dim"> {a.email}</span>}
          {a.role === "admin" && <span className="text-review"> admin</span>}
        </span>
        <span className="text-dim">{ago(a.seen ?? a.created)}</span>
        {!self && (
          <span className="flex gap-x-[1ch]">
            {a.status !== "active" && act("let in", { status: "active" }, "text-working")}
            {a.status === "active" && act("disable", { status: "disabled" }, "text-blocked")}
            {a.status === "active" && (a.role === "admin" ? act("user", { role: "user" }, "text-dim") : act("admin", { role: "admin" }, "text-dim"))}
          </span>
        )}
      </div>
      {problem && <p className="text-blocked">{problem}</p>}
    </div>
  )
}

const DAY = 86400

function Invites({ invites, onChanged }: { invites: Invite[]; onChanged: () => void }) {
  const [label, setLabel] = useState("")
  const [uses, setUses] = useState("1")
  const [days, setDays] = useState("")
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  const link = (code: string) => `${location.origin}/?invite=${encodeURIComponent(code)}`

  async function make(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      const made = await api<Invite>("POST", "/api/admin/invites", {
        label,
        uses: uses.trim() ? Number(uses) : null,
        expires_in: days.trim() ? Math.round(Number(days) * DAY) : null,
      })
      setLabel("")
      setProblem(null)
      copy(made.code)
      onChanged()
    } catch (err) {
      setProblem((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  function copy(code: string) {
    navigator.clipboard?.writeText(link(code)).then(
      () => setCopied(code),
      () => {},
    )
  }

  const spent = (i: Invite) => !!i.revoked || (i.uses !== null && i.used >= i.uses) || (!!i.expires && Date.parse(i.expires) <= Date.now())

  return (
    <section className="pane">
      <div className="pane-title">
        <span className="font-bold">invites</span>
      </div>
      <div className="flex flex-col pt-[2px]">
        <form onSubmit={make} className="flex flex-wrap items-center gap-x-[1ch] gap-y-[4px] border-b border-rule pb-[6px]">
          <Input aria-label="label" placeholder="for" value={label} onChange={(e) => setLabel(e.target.value)} className={cn(input, "w-[20ch] min-w-0 flex-1")} />
          <Input aria-label="uses" placeholder="∞" inputMode="numeric" value={uses} onChange={(e) => setUses(e.target.value.replace(/\D/g, ""))} className={cn(input, "w-[6ch]")} />
          <span className="text-dim">×</span>
          <Input aria-label="days" placeholder="∞" inputMode="decimal" value={days} onChange={(e) => setDays(e.target.value.replace(/[^\d.]/g, ""))} className={cn(input, "w-[6ch]")} />
          <span className="text-dim">d</span>
          <Button type="submit" variant="outline" disabled={busy} className="h-auto px-[1ch] py-[2px]">
            {busy ? "…" : "+ invite"}
          </Button>
        </form>
        {problem && <p className="text-blocked">{problem}</p>}
        {!invites.length && <span className="text-dim">none</span>}
        {invites.map((i) => (
          <div key={i.code} className={cn("flex flex-wrap items-baseline gap-x-[2ch] border-b border-rule/60 py-[3px] last:border-b-0", spent(i) && "opacity-60")}>
            <span className="min-w-0 flex-1 break-words">
              <span className="font-bold">{i.label || i.code}</span>
              <span className="text-dim">
                {" "}
                {i.used}/{i.uses ?? "∞"}
                {i.expires && ` · until ${i.expires.slice(0, 10)}`}
                {i.revoked && " · withdrawn"}
              </span>
            </span>
            <span className="text-dim">{ago(i.created)}</span>
            {!spent(i) && (
              <span className="flex gap-x-[1ch]">
                <button className="text-link hover:underline" onClick={() => copy(i.code)}>
                  {copied === i.code ? "copied" : "link"}
                </button>
                <button className="text-dim hover:text-blocked hover:underline" onClick={() => api("DELETE", `/api/admin/invites/${encodeURIComponent(i.code)}`).then(onChanged, (e: Error) => setProblem(e.message))}>
                  withdraw
                </button>
              </span>
            )}
          </div>
        ))}
      </div>
    </section>
  )
}

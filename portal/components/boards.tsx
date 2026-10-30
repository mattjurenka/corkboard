"use client"

import Link from "next/link"
import { useCallback, useEffect, useState } from "react"

import { Status } from "@/components/frame"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { api, type Board, type Bridge, type Repo } from "@/lib/api"
import { forgejoRepo, sameRemote } from "@/lib/remotes"
import { cn } from "@/lib/utils"

// The user's boards that have a repository to clone, each with the machines
// whose page can open it (a bridge serving one from anywhere): ● where it's
// cloned already, ○ where opening it clones it first.
export function Boards() {
  const [boards, setBoards] = useState<Board[] | null>(null)
  const [bridges, setBridges] = useState<Bridge[]>([])
  const [git, setGit] = useState<{ origin: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const [b, s, g] = await Promise.all([
        api<Board[]>("GET", "/api/boards"),
        api<Bridge[]>("GET", "/api/sessions"),
        api<{ origin: string }>("GET", "/api/git").catch(() => null),
      ])
      setBoards(b)
      setBridges(s)
      setGit(g)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  async function open(bridge: Bridge, board: Board) {
    try {
      const { url } = await api<{ url: string }>("POST", "/api/workspace/tickets", { bridge: bridge.id, board: board.key })
      location.assign(url)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const listed = boards?.filter((b) => b.remotes?.length) ?? []
  const pages = bridges.filter((b) => b.url)

  return (
    <>
      {error && <p className="text-blocked">{error}</p>}
      {boards === null && !error && <p className="text-dim">…</p>}
      {boards !== null && !listed.length && (
        <p>
          <button className="text-link hover:underline" onClick={() => setAdding(true)}>
            add a project
          </button>
        </p>
      )}
      <ul className="grid grid-cols-1 gap-x-[2ch] sm:grid-cols-[auto_minmax(0,1fr)_auto]">
        {listed.map((board) => {
          const repo = forgejoRepo(board.remotes ?? [], git?.origin)
          return (
            <li key={board.key} className="grid grid-cols-1 border-b border-rule/60 py-[5px] sm:col-span-3 sm:grid-cols-subgrid sm:items-baseline">
              <span className="font-bold break-words">{board.name}</span>
              <span className="truncate text-dim">{board.remotes?.[0]}</span>
              <span className="flex flex-wrap gap-x-[2ch] sm:justify-end">
                {pages.map((bridge) => {
                  const here = !!bridge.environment && !!board.environments?.includes(bridge.environment)
                  return (
                    <button key={bridge.id} className="whitespace-nowrap hover:underline" onClick={() => open(bridge, board)}>
                      <span className={cn(here ? "text-working" : "text-dim")}>{here ? "●" : "○"}</span> {bridge.machine}
                    </button>
                  )
                })}
                {repo && (
                  <Link href={`/files/${repo}`} className="text-link hover:underline">
                    files
                  </Link>
                )}
              </span>
            </li>
          )
        })}
      </ul>
      <Status>
        <span>{boards ? `${listed.length} ${listed.length === 1 ? "board" : "boards"}` : ""}</span>
        <button className="ml-auto text-link hover:underline" onClick={() => setAdding(true)}>
          + project
        </button>
      </Status>
      <AddProject open={adding} onOpenChange={setAdding} boards={boards ?? []} git={git} onAdded={refresh} />
    </>
  )
}

// A project from a repository: one on Forgejo with no board yet, or any
// other remote (owner/repo on GitHub, or a git URL). Its board has that
// remote and no clone; the first machine to open it clones it.
function AddProject({
  open,
  onOpenChange,
  boards,
  git,
  onAdded,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  boards: Board[]
  git: { origin: string } | null
  onAdded: () => void
}) {
  const [repos, setRepos] = useState<Repo[] | null>(null)
  const [other, setOther] = useState("")
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open || !git) return
    setProblem(null)
    api<Repo[]>("GET", "/api/git/repos").then(setRepos, (e: Error) => setProblem(e.message))
  }, [open, git])

  const host = git ? new URL(git.origin).host : null
  const unboarded = (repos ?? []).filter((r) => !boards.some((b) => b.remotes?.some((x) => sameRemote(x, `git@${host}:${r.owner}/${r.name}.git`))))

  async function add(key: string, name: string, remote: string) {
    if (boards.some((b) => b.remotes?.some((x) => sameRemote(x, remote)))) return setProblem("there's a board for it already")
    setBusy(true)
    try {
      await api("PUT", "/api/boards/" + encodeURIComponent(key.slice(0, 128)), { name, remotes: [remote] })
      setOther("")
      onOpenChange(false)
      onAdded()
    } catch (e) {
      setProblem((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  function addOther(e: React.FormEvent) {
    e.preventDefault()
    const text = other.trim()
    const gh = text.match(/^(?:(?:https?:\/\/)?(?:www\.)?github\.com\/|git@github\.com:)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/)
    if (gh) return add(`github-${gh[1]}-${gh[2]}`, gh[2], `git@github.com:${gh[1]}/${gh[2]}.git`)
    const url = text.match(/^(?:https:\/\/|ssh:\/\/|[\w.-]+@)[\w.-]+[:/](?:[\w.-]+\/)*([\w.-]+?)(?:\.git)?\/?$/)
    if (url) return add(`git-${text.replace(/[^\w.-]+/g, "-")}`, url[1], text)
    setProblem("that isn't owner/repo or a git URL")
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border border-rule bg-ground p-[2ch] sm:max-w-[60ch]">
        <DialogHeader>
          <DialogTitle className="font-bold">add a project</DialogTitle>
        </DialogHeader>
        {git && (
          <ul className="max-h-[40vh] overflow-y-auto">
            {repos === null && !problem && <li className="text-dim">…</li>}
            {unboarded.map((r) => (
              <li key={`${r.owner}/${r.name}`}>
                <button
                  disabled={busy}
                  className="w-full py-[2px] text-left hover:bg-raise disabled:text-dim"
                  onClick={() => add(`forgejo-${r.owner}-${r.name}`, r.name, `git@${host}:${r.owner}/${r.name}.git`)}
                >
                  {r.owner}/{r.name}
                </button>
              </li>
            ))}
          </ul>
        )}
        <form onSubmit={addOther} className="flex gap-[1ch]">
          <Input
            value={other}
            onChange={(e) => setOther(e.target.value)}
            placeholder="owner/repo or git URL"
            autoComplete="off"
            spellCheck={false}
            className="h-auto flex-1 border-rule bg-transparent px-[1ch] py-[2px]"
          />
          <Button type="submit" variant="outline" disabled={busy || !other.trim()} className="h-auto px-[1ch] py-[2px]">
            add
          </Button>
        </form>
        {problem && <p className="text-blocked">{problem}</p>}
      </DialogContent>
    </Dialog>
  )
}

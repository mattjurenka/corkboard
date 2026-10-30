"use client"

import Link from "next/link"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { Key, Status } from "@/components/frame"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { api, type Branch, type Dir, type Entry, type File, type Repo, type RepoInfo } from "@/lib/api"
import { entryClass, highlight, type Run } from "@/lib/highlight"
import { cn } from "@/lib/utils"

// /files                           the repositories
// /files/owner/repo[/path][?ref=]  a repository's tree, opened down to path,
//                                  and the file at path beside it
// /files/owner/repo?view=branches  its branches

const decode = (s: string) => {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

export function Files() {
  const pathname = usePathname()
  const params = useSearchParams()
  const ref = params.get("ref")
  const [owner, repo, ...path] = pathname.split("/").slice(2).filter(Boolean).map(decode)
  if (owner && repo && params.get("view") === "branches") return <Branches owner={owner} repo={repo} current={ref} />
  return owner && repo ? <RepoTree key={`${owner}/${repo}`} owner={owner} repo={repo} path={path.join("/")} ref_={ref} /> : <Repos />
}

// The connectors in front of a row: a line down for each ancestor with more
// below it, then a tee, or an elbow for the last, at the row itself.
function Guides({ lasts }: { lasts: boolean[] }) {
  return lasts.map((last, i) => (
    <span
      key={i}
      aria-hidden
      className={cn("w-[3ch] shrink-0", i < lasts.length - 1 ? !last && "tree-pipe" : last ? "tree-elbow" : "tree-tee")}
    />
  ))
}

function Repos() {
  const [repos, setRepos] = useState<Repo[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    api<Repo[]>("GET", "/api/git/repos").then(setRepos, (e: Error) => setError(e.message))
  }, [])
  return (
    <section className="pane min-h-0 flex-1 overflow-auto">
      <h2 className="pane-title font-bold">repositories</h2>
      {error && <p className="text-blocked">{error}</p>}
      {!repos && !error && <p className="text-dim">…</p>}
      <ul className="whitespace-pre">
        {repos?.map((r, i) => (
          <li key={`${r.owner}/${r.name}`} className="flex">
            <Guides lasts={[i === repos.length - 1]} />
            <Link href={`/files/${r.owner}/${r.name}`} className="text-link hover:underline">
              {r.owner}/{r.name}/
            </Link>
          </li>
        ))}
      </ul>
      <Status>
        <span>{repos ? `${repos.length} ${repos.length === 1 ? "repository" : "repositories"}` : ""}</span>
      </Status>
    </section>
  )
}

type Row = { entry: Entry; lasts: boolean[] }
type Loaded = Entry[] | { error: string }

const parent = (p: string) => p.split("/").slice(0, -1).join("/")
const ancestors = (p: string) => p.split("/").slice(0, -1).map((_, i, all) => all.slice(0, i + 1).join("/"))
const size = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`)
const IMAGE: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", ico: "image/x-icon" }

function RepoTree({ owner, repo, path, ref_ }: { owner: string; repo: string; path: string; ref_: string | null }) {
  const router = useRouter()
  const at = `/api/git/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
  const [info, setInfo] = useState<RepoInfo | null>(null)
  const [dirs, setDirs] = useState<Record<string, Loaded>>({})
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [cursor, setCursor] = useState<string | null>(null)
  const [file, setFile] = useState<File | { error: string } | "loading" | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Below lg the tree sits above the file and can fold away to give it the
  // screen; picking a file folds it.
  const [folded, setFolded] = useState(false)
  const asked = useRef(new Map<string, Promise<Dir | File>>())
  const treeEl = useRef<HTMLDivElement>(null)
  const ref = ref_ ?? info?.default_branch ?? null

  const href = useCallback(
    (p: string) => `/files/${owner}/${repo}${p ? "/" + p.split("/").map(encodeURIComponent).join("/") : ""}${ref_ ? `?ref=${encodeURIComponent(ref_)}` : ""}`,
    [owner, repo, ref_],
  )

  // One request a path a ref, however many ask for it.
  const contents = useCallback(
    (p: string) => {
      const key = `${ref_ ?? ""}:${p}`
      if (!asked.current.has(key)) {
        const q = ref_ ? `?ref=${encodeURIComponent(ref_)}` : ""
        const req = api<Dir | File>("GET", `${at}/contents/${p.split("/").filter(Boolean).map(encodeURIComponent).join("/")}${q}`)
        req.catch(() => asked.current.delete(key))
        asked.current.set(key, req)
      }
      return asked.current.get(key)!
    },
    [at, ref_],
  )

  const loadDir = useCallback(
    async (p: string) => {
      try {
        const got = await contents(p)
        if (got.type === "dir") setDirs((d) => ({ ...d, [p]: got.entries }))
        return got
      } catch (e) {
        setDirs((d) => ({ ...d, [p]: { error: (e as Error).message } }))
      }
    },
    [contents],
  )

  useEffect(() => {
    api<RepoInfo>("GET", at).then(setInfo, (e: Error) => setError(e.message))
  }, [at])

  // A new ref is a new tree.
  useEffect(() => {
    setDirs({})
    setOpen(new Set())
    loadDir("")
  }, [ref_, loadDir])

  // The address's path: a file opens beside the tree, a directory opens in
  // it, and either way the tree opens down to it.
  useEffect(() => {
    let gone = false
    for (const a of ancestors(path)) loadDir(a)
    if (!path) {
      setFile(null)
      return
    }
    setFile("loading")
    contents(path).then(
      (got) => {
        if (gone) return
        setOpen((o) => new Set([...o, ...ancestors(path), ...(got.type === "dir" ? [path] : [])]))
        setCursor(path)
        if (got.type === "dir") {
          setDirs((d) => ({ ...d, [path]: got.entries }))
          setFile(null)
        } else setFile(got)
      },
      (e: Error) => !gone && setFile({ error: e.message }),
    )
    return () => {
      gone = true
    }
  }, [path, contents, loadDir])

  const rows = useMemo(() => {
    const out: Row[] = []
    const walk = (p: string, lasts: boolean[]) => {
      const entries = dirs[p]
      if (!Array.isArray(entries)) return
      entries.forEach((entry, i) => {
        const l = [...lasts, i === entries.length - 1]
        out.push({ entry, lasts: l })
        if (entry.type === "dir" && open.has(entry.path)) walk(entry.path, l)
      })
    }
    walk("", [])
    return out
  }, [dirs, open])

  const toggle = useCallback(
    (p: string) => {
      setOpen((o) => {
        const n = new Set(o)
        if (n.has(p)) n.delete(p)
        else {
          n.add(p)
          if (!dirs[p]) loadDir(p)
        }
        return n
      })
    },
    [dirs, loadDir],
  )

  const activate = (entry: Entry) => {
    setCursor(entry.path)
    if (entry.type === "dir") toggle(entry.path)
    else if (entry.type === "file") {
      router.push(href(entry.path))
      if (!matchMedia("(min-width: 64rem)").matches) setFolded(true)
    }
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    const i = rows.findIndex((r) => r.entry.path === cursor)
    const row = rows[i]
    const move = (to: number) => rows[to] && setCursor(rows[to].entry.path)
    switch (e.key) {
      case "j":
      case "ArrowDown":
        move(i < 0 ? 0 : Math.min(i + 1, rows.length - 1))
        break
      case "k":
      case "ArrowUp":
        move(Math.max(i - 1, 0))
        break
      case "Enter":
      case "l":
      case "ArrowRight":
        if (!row) return
        if (row.entry.type === "dir" && open.has(row.entry.path) && e.key !== "Enter") move(i + 1)
        else activate(row.entry)
        break
      case "h":
      case "ArrowLeft":
        if (!row) return
        if (row.entry.type === "dir" && open.has(row.entry.path)) toggle(row.entry.path)
        else if (parent(row.entry.path)) setCursor(parent(row.entry.path))
        break
      default:
        return
    }
    e.preventDefault()
  }

  useEffect(() => {
    if (!cursor) return
    treeEl.current?.querySelector(`[data-path="${CSS.escape(cursor)}"]`)?.scrollIntoView({ block: "nearest" })
  }, [cursor])

  // With nothing open, the directory's README, if it has one.
  const here = path && Array.isArray(dirs[path]) ? path : ""
  const readme = Array.isArray(dirs[here]) ? (dirs[here] as Entry[]).find((e) => e.type === "file" && /^readme(\.(md|txt|markdown))?$/i.test(e.name)) : undefined
  const [readmeFile, setReadmeFile] = useState<File | null>(null)
  useEffect(() => {
    setReadmeFile(null)
    if (file || !readme) return
    contents(readme.path).then((got) => got.type === "file" && setReadmeFile(got), () => {})
  }, [file, readme, contents])

  const shown = file && file !== "loading" && !("error" in file) ? file : !file ? readmeFile : null
  const root = dirs[""]

  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[auto_minmax(0,1fr)] gap-x-[2ch] gap-y-[22px] lg:grid-cols-[minmax(30ch,42ch)_minmax(0,1fr)] lg:grid-rows-1">
      <section className={cn("pane flex max-h-[45vh] min-h-[10rem] flex-col lg:max-h-none", folded && "max-lg:min-h-0")}>
        <h2 className="pane-title">
          <Link href={href("")} className="font-bold hover:text-link">
            {owner}/{repo}
          </Link>
        </h2>
        <button
          aria-expanded={!folded}
          aria-label={folded ? "show files" : "hide files"}
          onClick={() => setFolded(!folded)}
          className="pane-title-end text-dim hover:text-ink lg:hidden"
        >
          {folded ? "▸" : "▾"}
        </button>
        {error && <p className="text-blocked">{error}</p>}
        {root && !Array.isArray(root) && <p className="text-blocked">{root.error}</p>}
        {info?.empty && <p className="text-dim">empty</p>}
        <div
          ref={treeEl}
          role="tree"
          aria-label={`${owner}/${repo}`}
          tabIndex={0}
          autoFocus
          onKeyDown={onKey}
          onFocus={() => !cursor && rows[0] && setCursor(rows[0].entry.path)}
          className={cn("min-h-0 flex-1 overflow-auto whitespace-pre outline-none", folded && "max-lg:hidden")}
        >
          {rows.map(({ entry, lasts }) => {
            const isDir = entry.type === "dir"
            const isOpen = isDir && open.has(entry.path)
            const failed = isOpen && dirs[entry.path] && !Array.isArray(dirs[entry.path])
            return (
              <div
                key={entry.path}
                data-path={entry.path}
                role="treeitem"
                aria-level={lasts.length}
                aria-expanded={isDir ? isOpen : undefined}
                aria-selected={entry.path === path}
                onClick={() => activate(entry)}
                className={cn("flex cursor-pointer pr-[1ch]", entry.path === cursor && "bg-raise")}
              >
                <Guides lasts={lasts} />
                <span className={cn(entryClass(entry.name, entry.type), failed && "text-blocked")}>
                  {entry.name}
                  {isDir && "/"}
                </span>
                {entry.path === path && <span className="text-link"> ◂</span>}
              </div>
            )
          })}
        </div>
      </section>

      <section className="pane flex min-h-[10rem] min-w-0 flex-col">
        <h2 className="pane-title">{shown ? shown.path : path || repo}</h2>
        <div className="min-h-0 flex-1 overflow-auto">
          {file === "loading" && <p className="text-dim">…</p>}
          {file && file !== "loading" && "error" in file && <p className="text-blocked">{file.error}</p>}
          {shown && <FileBody file={shown} />}
          {!file && !readme && Array.isArray(dirs[here]) && <p className="text-dim">no README</p>}
        </div>
      </section>

      <Status>
        {info && info.branches.length > 0 && ref && (
          <Select value={ref} onValueChange={(b) => b && router.push(`/files/${owner}/${repo}${path ? "/" + path.split("/").map(encodeURIComponent).join("/") : ""}?ref=${encodeURIComponent(b as string)}`)}>
            <SelectTrigger size="sm" className="h-auto gap-[1ch] border-0 bg-transparent p-0 text-ink hover:text-link">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="border border-rule bg-ground">
              {[...new Set([ref, ...info.branches])].map((b) => (
                <SelectItem key={b} value={b}>
                  {b}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <Link href={`/files/${owner}/${repo}?view=branches${ref_ ? `&ref=${encodeURIComponent(ref_)}` : ""}`} className="text-link hover:underline">
          branches
        </Link>
        <Key k="j/k" does="move" />
        <Key k="enter" does="open" />
        <Key k="h" does="back" />
        {shown && (
          <span className="ml-auto whitespace-nowrap">
            {shown.content !== null && !shown.binary && `${lineCount(shown.content)} lines  `}
            {size(shown.size)}
          </span>
        )}
      </Status>
    </div>
  )
}

const lineCount = (s: string) => s.split("\n").length - (s.endsWith("\n") ? 1 : 0)

function FileBody({ file }: { file: File }) {
  const ext = file.name.split(".").pop()?.toLowerCase() ?? ""
  if (file.binary && file.content && IMAGE[ext])
    return (
      <div className="p-[1ch]">
        {/* eslint-disable-next-line @next/next/no-img-element -- a data URL from the API, not an optimizable asset */}
        <img src={`data:${IMAGE[ext]};base64,${file.content}`} alt={file.name} className="max-w-full" />
      </div>
    )
  if (file.content === null || file.binary)
    return (
      <p className="text-dim">
        {file.binary ? "binary" : "too large to show"}{" "}
        <a href={file.url} className="text-link hover:underline">
          open on forgejo
        </a>
      </p>
    )
  return <Code name={file.name} text={file.content} />
}

// Text with line numbers, plain at once and in color once its grammar has
// loaded (lib/highlight.ts); a file in no language Shiki has stays plain.
function Code({ name, text }: { name: string; text: string }) {
  const [runs, setRuns] = useState<Run[][] | null>(null)
  useEffect(() => {
    let gone = false
    setRuns(null)
    highlight(name, text).then(
      (r) => !gone && setRuns(r),
      () => {},
    )
    return () => {
      gone = true
    }
  }, [name, text])
  const lines = useMemo(() => {
    const l = text.split("\n")
    if (l.at(-1) === "") l.pop()
    return l
  }, [text])
  const gutter = String(lines.length).length
  return (
    <pre className="text-[13px] leading-[20px]">
      <code className="block min-w-max">
        {lines.map((l, i) => (
          <span key={i} className="block hover:bg-raise">
            <span className="inline-block pr-[2ch] text-right text-dim select-none" style={{ width: `${gutter + 2}ch` }}>
              {i + 1}
            </span>
            {runs?.[i]?.length
              ? runs[i].map(([t, color, italic], j) => (
                  <span key={j} style={{ color, fontStyle: italic ? "italic" : undefined }}>
                    {t}
                  </span>
                ))
              : l || " "}
          </span>
        ))}
      </code>
    </pre>
  )
}

// How long ago, in the fewest characters that say it.
function ago(iso: string | null): string {
  if (!iso) return ""
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000)
  if (s < 60) return "now"
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`
  if (s < 86400 * 365) return `${Math.floor(s / 86400 / 30)}mo ago`
  return `${Math.floor(s / 86400 / 365)}y ago`
}

// A repository's branches, the default first and then the newest: each with
// its last commit and how far it has come from the default. Picking one
// browses its files.
function Branches({ owner, repo, current }: { owner: string; repo: string; current: string | null }) {
  const router = useRouter()
  const [branches, setBranches] = useState<Branch[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [cursor, setCursor] = useState(0)
  const listEl = useRef<HTMLDivElement>(null)

  useEffect(() => {
    api<Branch[]>("GET", `/api/git/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches`).then(setBranches, (e: Error) => setError(e.message))
  }, [owner, repo])

  const browse = (b: Branch) => router.push(`/files/${owner}/${repo}${b.default ? "" : `?ref=${encodeURIComponent(b.name)}`}`)

  function onKey(e: React.KeyboardEvent) {
    if (!branches?.length || e.metaKey || e.ctrlKey || e.altKey) return
    if (e.key === "j" || e.key === "ArrowDown") setCursor((c) => Math.min(c + 1, branches.length - 1))
    else if (e.key === "k" || e.key === "ArrowUp") setCursor((c) => Math.max(c - 1, 0))
    else if (e.key === "Enter" || e.key === "l") browse(branches[cursor])
    else if (e.key === "h") router.push(`/files/${owner}/${repo}${current ? `?ref=${encodeURIComponent(current)}` : ""}`)
    else return
    e.preventDefault()
  }

  useEffect(() => {
    listEl.current?.children[cursor]?.scrollIntoView({ block: "nearest" })
  }, [cursor])

  return (
    <section className="pane flex min-h-0 flex-1 flex-col">
      <h2 className="pane-title">
        <Link href={`/files/${owner}/${repo}`} className="font-bold hover:text-link">
          {owner}/{repo}
        </Link>
        <span>branches</span>
      </h2>
      {error && <p className="text-blocked">{error}</p>}
      {!branches && !error && <p className="text-dim">…</p>}
      <div
        ref={listEl}
        role="listbox"
        aria-label="branches"
        tabIndex={0}
        autoFocus
        onKeyDown={onKey}
        className="grid min-h-0 flex-1 auto-rows-min grid-cols-1 overflow-auto outline-none sm:grid-cols-[auto_auto_auto_minmax(0,1fr)_auto_auto]"
      >
        {branches?.map((b, i) => {
          const here = current ? b.name === current : b.default
          return (
            <div
              key={b.name}
              role="option"
              aria-selected={here}
              onClick={() => browse(b)}
              onMouseEnter={() => setCursor(i)}
              className={cn(
                "grid cursor-pointer grid-cols-[auto_1fr] gap-x-[2ch] py-[2px] sm:col-span-6 sm:grid-cols-subgrid",
                i === cursor && "bg-raise",
              )}
            >
              <span className="whitespace-nowrap">
                <span className={cn(b.default ? "text-working" : "text-dim")}>{b.default ? "●" : "○"}</span>{" "}
                <span className={cn(b.default && "font-bold")}>{b.name}</span>
                {here && <span className="text-link"> ◂</span>}
              </span>
              <span className="whitespace-nowrap text-right sm:text-left">
                {b.ahead ? <span className="text-working">↑{b.ahead}</span> : null}
                {b.ahead && b.behind ? " " : null}
                {b.behind ? <span className="text-review">↓{b.behind}</span> : null}
              </span>
              <span className="hidden text-dim sm:inline">{b.sha?.slice(0, 7)}</span>
              <span className="col-span-2 truncate text-dim sm:col-span-1 sm:text-ink">{b.message}</span>
              <span className="hidden truncate text-dim sm:inline">{b.author}</span>
              <span className="hidden whitespace-nowrap text-right text-dim sm:inline">{ago(b.date)}</span>
            </div>
          )
        })}
      </div>
      <Status>
        <span>{branches ? `${branches.length} ${branches.length === 1 ? "branch" : "branches"}` : ""}</span>
        <Key k="j/k" does="move" />
        <Key k="enter" does="browse" />
        <Key k="h" does="files" />
      </Status>
    </section>
  )
}

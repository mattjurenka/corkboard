// Git remotes, as boards keep them (cloud/src/board.ts) and bridges report
// them (bridge/boards.ts): scp-like, ssh:// or https://.

// host/owner/repo, lower-cased, whichever way the remote is written.
function parts(remote: string): string | null {
  const m = remote.trim().match(/^(?:https?:\/\/|ssh:\/\/(?:[\w.-]+@)?|[\w.-]+@)([\w.-]+)(?::\d+)?[:/](.+?)(?:\.git)?\/?$/)
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null
}

export const sameRemote = (a: string, b: string) => {
  const x = parts(a)
  return x !== null && x === parts(b)
}

// owner/repo when one of the remotes is on Forgejo (origin, as /api/git says).
export function forgejoRepo(remotes: string[], origin: string | undefined): string | null {
  if (!origin) return null
  const host = new URL(origin).host.toLowerCase()
  for (const r of remotes) {
    const p = parts(r)
    if (p?.startsWith(host + "/")) {
      const rest = p.slice(host.length + 1).split("/")
      if (rest.length === 2) return rest.join("/")
    }
  }
  return null
}

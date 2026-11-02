"use client"

import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { createContext, useContext, useEffect, useState } from "react"
import { createPortal } from "react-dom"

import { allowSignIn, answered, api, type Me, signIn, signOut, signedOut } from "@/lib/api"
import { cn } from "@/lib/utils"

// Who's signed in (/api/me), once they are: the views a user may not have
// (files, admin) are left out of the top rule until it says they do.
const MeContext = createContext<{ me: Me | null; setMe: (m: Me) => void }>({ me: null, setMe: () => {} })
export const useMe = () => useContext(MeContext)

type State = "loading" | "in" | "out" | { error: string }

// The whole page is one pane: corkboard and the views in its top rule, sign
// out at its end, the view inside, and a status line along the bottom.
// Children render only once signed in, so their first request has a token,
// and put what they show in the status line there with <Status>.
const StatusLine = createContext<HTMLElement | null>(null)

export function Status({ children }: { children: React.ReactNode }) {
  const at = useContext(StatusLine)
  return at ? createPortal(children, at) : null
}

export function Frame({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<State>("loading")
  const [statusLine, setStatusLine] = useState<HTMLElement | null>(null)
  const [me, setMe] = useState<Me | null>(null)
  const router = useRouter()
  const pathname = usePathname()

  useEffect(() => {
    if (state === "in" && !me) api<Me>("GET", "/api/me").then(setMe, () => {})
  }, [state, me])

  useEffect(() => {
    answered()
      .then((back) => {
        // The editor (/edit/) is the API Worker's own page, not one of ours.
        if (back?.startsWith("/edit/")) return location.replace(back)
        if (back) router.replace(back)
        setState(signedOut() ? "out" : "in")
      })
      .catch((e: Error) => setState({ error: e.message }))
  }, [pathname, router])

  const view = (href: string, label: string, on: boolean) => (
    <Link href={href} className={cn("hover:text-ink", on ? "text-ink" : "text-dim")} aria-current={on ? "page" : undefined}>
      {label}
    </Link>
  )

  return (
    <div className="px-[1ch] pt-[11px] pb-[1ch] sm:px-[2ch] sm:pt-[22px]">
      <div className="pane flex h-[calc(100dvh-34px)] flex-col sm:h-[calc(100dvh-56px)]">
        <div className="pane-title">
          <span className="font-bold">corkboard</span>
          <nav className="flex gap-[2ch]">
            {view("/", "boards", pathname === "/")}
            {me?.features.git && view("/files", "files", pathname.startsWith("/files"))}
            {view("/brains", "brains", pathname.startsWith("/brains"))}
            {view("/holds", "holds", pathname.startsWith("/holds"))}
            {view("/account", "account", pathname.startsWith("/account"))}
            {me?.features.admin && view("/admin", "admin", pathname.startsWith("/admin"))}
          </nav>
        </div>
        {state === "in" && (
          <button
            className="pane-title-end text-dim hover:text-ink"
            onClick={async () => {
              await signOut()
              setMe(null)
              setState("out")
            }}
          >
            sign out
          </button>
        )}
        <main className="flex min-h-0 flex-1 flex-col overflow-y-auto pt-[11px]">
          {state === "loading" && <p className="text-dim">…</p>}
          {typeof state === "object" && <p className="text-blocked">{state.error}</p>}
          {state === "out" && (
            <p>
              <button
                className="text-link hover:underline"
                onClick={() => {
                  allowSignIn()
                  signIn().catch((e: Error) => setState({ error: e.message }))
                }}
              >
                sign in
              </button>
            </p>
          )}
          {state === "in" && (
            <MeContext.Provider value={{ me, setMe }}>
              <StatusLine.Provider value={statusLine}>{children}</StatusLine.Provider>
            </MeContext.Provider>
          )}
        </main>
        {state === "in" && <footer ref={setStatusLine} className="-mx-[1ch] mt-[11px] flex min-h-[21px] flex-wrap items-center gap-x-[3ch] gap-y-1 border-t border-rule px-[1ch] pt-[4px] text-dim" />}
      </div>
    </div>
  )
}

// A key and what it does, in the status line.
export function Key({ k, does }: { k: string; does: string }) {
  return (
    <span className="hidden whitespace-nowrap sm:inline">
      <span className="text-ink">{k}</span> {does}
    </span>
  )
}

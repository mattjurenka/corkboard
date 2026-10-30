// Syntax colors for the file view, by Shiki: VS Code's TextMate grammars,
// each loaded the first time a file needs it, run on the JavaScript regex
// engine (no WASM), with a theme whose colors are CSS variables, so they're
// the portal's own (--syn-* in app/globals.css) in light and dark.

import { createCssVariablesTheme, createHighlighterCore, type HighlighterCore } from "shiki/core"
import { createJavaScriptRegexEngine } from "shiki/engine/javascript"
import { bundledLanguages, bundledLanguagesInfo } from "shiki/langs"

const theme = createCssVariablesTheme({ name: "corkboard", variablePrefix: "--shiki-" })

// Every id and alias Shiki knows a language by, which for most is its
// extension too; and the names and extensions that aren't.
const LANGS = new Map<string, string>()
for (const info of bundledLanguagesInfo) for (const name of [info.id, ...(info.aliases ?? [])]) LANGS.set(name, info.id)
const BY_NAME: Record<string, string> = { dockerfile: "docker", makefile: "make", justfile: "just", "flake.lock": "json", "bun.lock": "jsonc" }
const BY_EXTENSION: Record<string, string> = { mjs: "javascript", cjs: "javascript", mts: "typescript", cts: "typescript", webmanifest: "json", scm: "query" }

export function languageOf(name: string): string | undefined {
  const lower = name.toLowerCase()
  const ext = lower.includes(".") ? lower.split(".").pop()! : ""
  const id = BY_NAME[lower] ?? BY_EXTENSION[ext] ?? LANGS.get(ext)
  return id && id in bundledLanguages ? id : undefined
}

let highlighter: Promise<HighlighterCore> | undefined
const loaded = new Map<string, Promise<void>>()

async function ready(lang: string): Promise<HighlighterCore> {
  highlighter ??= createHighlighterCore({ themes: [theme], langs: [], engine: createJavaScriptRegexEngine() })
  const h = await highlighter
  if (!loaded.has(lang)) {
    const loading = h.loadLanguage(bundledLanguages[lang as keyof typeof bundledLanguages])
    loading.catch(() => loaded.delete(lang))
    loaded.set(lang, loading)
  }
  await loaded.get(lang)
  return h
}

// A line as runs of text, each with its color and whether it's italic.
export type Run = [text: string, color: string | undefined, italic: boolean]

// Past this, a file is shown plain: highlighting it would hold up the page.
const MAX = 512 * 1024

// The file's lines as runs, or null if it's in no language Shiki has.
export async function highlight(name: string, text: string): Promise<Run[][] | null> {
  const lang = languageOf(name)
  if (!lang || text.length > MAX) return null
  const h = await ready(lang)
  const { tokens } = h.codeToTokens(text, { lang, theme: "corkboard" })
  return tokens.map((line) => line.map((t) => [t.content, t.color, ((t.fontStyle ?? 0) & 1) === 1] as Run))
}

// A tree entry's class: what kind of file it is, at a glance.
export function entryClass(name: string, type: string): string | undefined {
  if (type === "dir") return "text-link"
  if (type !== "file") return "text-dim"
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : ""
  if (name.startsWith(".") || /\.lock$|^package-lock\.json$/.test(name)) return "text-dim"
  if (["png", "jpg", "jpeg", "gif", "webp", "ico", "svg"].includes(ext)) return "syn-keyword"
  if (["md", "markdown", "txt"].includes(ext) || /^(readme|license|changelog)/i.test(name)) return "syn-escape"
  if (["json", "jsonc", "toml", "yaml", "yml", "nix", "ini", "conf"].includes(ext)) return "syn-property"
  return undefined
}

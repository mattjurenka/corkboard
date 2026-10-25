// What corkboard knows, for Pepper beside the day plan. Neovim writes it to a
// file (corkboard.live, its path in CORKBOARD_LIVE) and this reads it again
// when it changes: the block Pepper is in goes above the prompt, the plan's
// state in the status line. Pepper doesn't do project work: it hands it off
// (hand_off) to a Claude Code tab in the main corkboard window, and edits
// only its own files. Other sessions have the cards agents are on beside
// them in Neovim (corkboard.claude.cards), not here.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Block, Live } from '../types'

const live = atom({ plugin: 'corkboard-ui', key: 'live' } as const, {})
const minute = atom({ plugin: 'corkboard-ui', key: 'minute' } as const, 0)

// How often the file is looked at.
const POLL = 1500

function clock(m: number) {
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

function minuteOf(ms: number) {
  const d = new Date(ms)
  return d.getHours() * 60 + d.getMinutes()
}

// Neovim writes an empty list as {}.
function list<T>(value: T[] | undefined): T[] {
  return Array.isArray(value) ? value : []
}

function planStatus(plan: Live['plan']) {
  if (!plan || plan.problem) return undefined
  if (plan.proposal) return 'plan · re-plan waiting'
  const blocks = list(plan.blocks)
  return blocks.length === 0 ? 'plan · none yet' : `plan · ${blocks.length} blocks`
}

// What this session is (CORKBOARD_SESSION), and the status line as last set.
let kind = 'project'
let status: string | undefined
// Where Pepper may edit files.
let own = ''

const HAND_OFF = {
  name: 'hand_off',
  description:
    "Start a Claude Code session on a piece of project work, in a tab of Matt's main corkboard window, already " +
    'working on it. Use it for any coding or project work instead of doing it yourself. The session knows nothing ' +
    'of this conversation: the task must say what to do and why, and what Matt said about it. Returns where it ' +
    'started, or why it could not.',
  inputSchema: {
    type: 'object',
    properties: {
      task: { type: 'string', description: 'The task, as the first message to the new session' },
      project: {
        type: 'string',
        description: "The project: its directory, or its folder's name (corkboard). Left out, the window's current project",
      },
      name: { type: 'string', description: 'A short name for the tab' },
    },
    required: ['task'],
  },
  isDeferred: false,
}

// Why Pepper may not edit the file at path, if it may not.
function refuse(path: string) {
  if (kind !== 'pepper' || path.startsWith(own)) return undefined
  return { deny: `Pepper edits only its own files, under ${own}. Hand project work off with hand_off.` }
}

// Read the file if it changed since the last read; tick the minute.
async function poll($: EngineInterface, path: string, seen: { mtime: number }) {
  const now = minuteOf(await $.clock.now())
  if ((await read($, minute)) !== now) await update($, minute, () => now)
  const stat = await $.fs.stat(path).catch(() => undefined)
  const mtime = stat?.mtimeMs ?? 0
  if (mtime === seen.mtime) return
  seen.mtime = mtime
  const text = stat ? await $.fs.read(path).catch(() => undefined) : undefined
  let value: Live = {}
  try {
    value = typeof text === 'string' ? (JSON.parse(text) as Live) : {}
  } catch {
    return
  }
  await update($, live, () => value)
  if (kind === 'pepper') {
    const next = planStatus(value.plan)
    if (next !== status) $.ui.status((status = next))
  }
}

export const work: Register = on => {
  on('session.start', async ($, e, next) => {
    kind = (await $.env.get('CORKBOARD_SESSION')) ?? 'project'
    const path = await $.env.get('CORKBOARD_LIVE')
    if (path) {
      const seen = { mtime: -1 }
      await poll($, path, seen)
      $.clock.every(POLL, () => poll($, path, seen))
    }
    if (kind === 'pepper') {
      own = `${(await $.env.get('HOME')) ?? ''}/pepper/`
      await $.tool.register(HAND_OFF)
    }
    return next(e)
  })

  // hooks/handoff.lua finds the main window's Neovim and asks it. The mod
  // isn't named corkboard: a session with corkboard's MCP server can't have
  // a mod's tools under that name too.
  on('tool.call', { tool: 'mcp__corkboard-ui__hand_off' }, async ($, e) => {
    const script = `${$.plugin.root}/../hooks/handoff.lua`
    const ran = await $.process
      .run(['nvim', '--clean', '--headless', '-l', script], {
        stdin: JSON.stringify({ task: e.task, project: e.project, name: e.name }),
      })
      .catch((err: unknown) => ({ stdout: `could not run nvim: ${String(err)}`, stderr: '' }))
    return { result: (ran.stdout || ran.stderr).trim() || 'could not hand off' }
  })

  // Pepper edits its own files, and hands off the rest.
  on('tool.call', { tool: 'Edit' }, ($, e, next) => refuse(e.file_path) ?? next(e))
  on('tool.call', { tool: 'Write' }, ($, e, next) => refuse(e.file_path) ?? next(e))
  on('tool.call', { tool: 'NotebookEdit' }, ($, e, next) => refuse(e.notebook_path) ?? next(e))

  // Pepper's band: the block now and the one after it.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (kind !== 'pepper' || e.props.hasSurvey) return next(e)
    const plan = (await read($, live)).plan
    if (!plan || plan.problem) return next(e)
    const now = await read($, minute)
    const blocks = list(plan.blocks)
    const current = blocks.find(b => b.start <= now && now < b.stop)
    const after = blocks.find(b => b.start >= (current ? current.stop : now))
    if (!current && !after) return next(e)
    const { Text } = $.ui.resolve(e)
    const span = (b: Block) => `${clock(b.start)}–${clock(b.stop)}`
    return (
      <Text wrap="truncate-end">
        {current ? (
          <Text>
            <Text dimColor>now {span(current)} </Text>
            <Text weight="bold">{current.title}</Text>
          </Text>
        ) : (
          <Text dimColor>nothing now</Text>
        )}
        {after && (
          <Text dimColor>
            {'  ·  next '}
            {clock(after.start)} {after.title}
          </Text>
        )}
      </Text>
    )
  })
}

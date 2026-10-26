// The transcript as a ledger: a gutter on the left holds each row's time and,
// for a tool call, a ● whose color says how it went; text runs in the column
// to its right. ctrl+o still shows every row as the engine draws it.

import { memberOf } from 'claude-code'
import type { EngineInterface, Register, RenderChildren, RenderInput } from 'claude-code'

import { work } from './work.tsx'

const at = { plugin: 'corkboard-ui', key: 'at' } as const
const took = { plugin: 'corkboard-ui', key: 'took' } as const

// The gutter: "2:02pm  │ ", the time in eight columns, the rule in the ninth.
const TIME = 8
const GUTTER = TIME + 2

function clock(ms: number | undefined) {
  if (ms === undefined) return ''
  const d = new Date(ms)
  const h = d.getHours()
  return `${((h + 11) % 12) + 1}:${String(d.getMinutes()).padStart(2, '0')}${h < 12 ? 'am' : 'pm'}`
}

function seconds(ms: number | undefined) {
  if (ms === undefined) return ''
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`
}

// mcp__corkboard__plan_read is plan_read.
function toolName(tool: string) {
  return tool.startsWith('mcp__') ? tool.split('__').slice(2).join('__') : tool
}

// The part of a call's input that says what it did, on one line; a path in
// the session's directory relative to it.
function gist(input: unknown, cwd: string) {
  if (typeof input !== 'object' || input === null) return ''
  const fields = input as Record<string, unknown>
  for (const key of ['file_path', 'notebook_path', 'path']) {
    const value = fields[key]
    if (typeof value === 'string' && value) return value.startsWith(cwd + '/') ? value.slice(cwd.length + 1) : value
  }
  for (const key of ['command', 'pattern', 'url', 'query', 'skill', 'description', 'prompt']) {
    const value = fields[key]
    if (typeof value === 'string' && value) return value.split('\n')[0] ?? ''
  }
  const first = Object.values(fields).find(v => typeof v === 'string' && v)
  return typeof first === 'string' ? first.split('\n')[0] ?? '' : ''
}

// A row of the ledger, a blank line above it: the time (unless it's the rest
// of a row above, which follows it with no gap), the
// rule beside everything the row draws (however many lines that is), and
// the row.
async function row($: EngineInterface, e: RenderInput, body: RenderChildren, timed = true) {
  const { Box, Text } = $.ui.resolve(e)
  const { value } = timed ? await $.state.get(memberOf(at, e)) : { value: undefined }
  return (
    <Box flexDirection="row" marginTop={timed ? 1 : 0}>
      <Box width={TIME} flexShrink={0}>
        <Text dimColor>{clock(value)}</Text>
      </Box>
      <Box width={2} flexShrink={0}>
        <Box position="absolute" top={0} bottom={0} left={0} width={1} overflow="hidden">
          <Text dimColor>{'│\n'.repeat(400)}</Text>
        </Box>
      </Box>
      <Box flexGrow={1} flexShrink={1} flexDirection="column">
        {body}
      </Box>
    </Box>
  )
}

export const register: Register = (on, options) => {
  work(on, options)

  // The calls of the groups this mod unfolded: their rows come marked
  // expanded, as a ctrl+o row does, but draw as the ledger's.
  const unfolded = new Set<string>()

  on('session.append', async ($, e, next) => {
    const stored = await next(e)
    if (stored.uuid) await $.state.set({ ...at, id: stored.uuid }, await $.clock.now())
    return stored
  })

  on('tool.call', async ($, e, next) => {
    const start = await $.clock.now()
    await $.state.set({ ...at, id: e.tool_use_id }, start)
    const result = await next(e)
    await $.state.set({ ...took, id: e.tool_use_id }, (await $.clock.now()) - start)
    return result
  })

  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    if (e.props.isExpanded && e.props.origin.kind !== 'composer') return next(e)
    const { Text } = $.ui.resolve(e)
    if (e.props.origin.kind !== 'composer') return row($, e, await next(e))
    return row(
      $,
      e,
      <Text>
        <Text dimColor>{'> '}</Text>
        {e.props.text}
      </Text>,
    )
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (e.props.isSummary) return row($, e, await next(e))
    const { Markdown } = $.ui.resolve(e)
    return row($, e, <Markdown text={e.props.text} />)
  })

  // One line a call: the time, a ● for how it went, the tool and what it did,
  // how long it took.
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (e.props.isExpanded && !unfolded.has(e.props.tool_use_id)) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const cwd = await $.session.cwd()
    const { value: start } = await $.state.get(memberOf(at, e))
    const { value: ms } = await $.state.get(memberOf(took, e))
    const { isRunning, isErrored, isInterrupted } = e.props
    const pin = isInterrupted ? 'inactive' : isErrored ? 'error' : isRunning ? 'warning' : 'success'
    const status = isInterrupted ? 'interrupted' : isErrored ? 'failed' : isRunning ? '…' : seconds(ms)
    return (
      <Box flexDirection="row" marginTop={1}>
        <Box width={TIME} flexShrink={0}>
          <Text dimColor>{clock(start)}</Text>
        </Box>
        <Box width={2} flexShrink={0}>
          <Text color={pin}>●</Text>
        </Box>
        <Box flexGrow={1} flexShrink={1}>
          <Text wrap="truncate-end">
            <Text weight="bold">{toolName(e.props.tool)}</Text> <Text dimColor>{gist(e.props.input, cwd)}</Text>
          </Text>
        </Box>
        <Box flexShrink={0} marginLeft={1}>
          <Text dimColor={!isErrored} color={isErrored ? 'error' : undefined}>
            {status}
          </Text>
        </Box>
      </Box>
    )
  })

  // A standalone call's result, in the column right of the rule.
  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (e.props.isExpanded) return next(e)
    return row($, e, await next(e), false)
  })

  // Every call its own row, not "Read 3 files". A group the engine draws
  // expanded (ctrl+o) draws its calls as the engine does.
  on('ui.render', { component: 'ToolGroup' }, ($, e, next) => {
    for (const call of e.props.calls) {
      if (!call.tool_use_id) continue
      if (e.props.isExpanded) unfolded.delete(call.tool_use_id)
      else unfolded.add(call.tool_use_id)
    }
    return next({ ...e, props: { ...e.props, isExpanded: true } })
  })

  // The live line, its glyph in the pin's column.
  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    const { Box } = $.ui.resolve(e)
    return (
      <Box flexDirection="row" paddingLeft={TIME}>
        {await next(e)}
      </Box>
    )
  })

  // A turn closes with a rule across the ledger, its length at the end.
  on('ui.render', { component: 'TurnDuration' }, async ($, e, next) => {
    if (e.props.isExpanded || e.props.waitingFor) return next(e)
    const { Text } = $.ui.resolve(e)
    const columns = e.viewport?.columns ?? 80
    const length = ` ${seconds(e.props.durationMs)} `
    const rest = Math.max(0, columns - GUTTER - length.length - 2)
    return <Text dimColor>{'─'.repeat(TIME) + '┴' + '─'.repeat(rest) + length + '─'}</Text>
  })
}

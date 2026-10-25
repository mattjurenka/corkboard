import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

const NOW = new Date(2026, 9, 24, 14, 30).getTime()

const LIVE = {
  plan: {
    date: '2026-10-24',
    proposal: false,
    blocks: [
      { start: 13 * 60, stop: 15 * 60, title: 'Deep work', kind: 'work' },
      { start: 15 * 60 + 30, stop: 16 * 60, title: 'Gym', kind: 'off' },
    ],
  },
}

// The engine beneath the mod: a session of kind `kind`, the live file LIVE.
async function start($: Engine, on: On, kind: string) {
  const env: Record<string, string | undefined> = {
    CORKBOARD_SESSION: kind,
    CORKBOARD_LIVE: '/state/live/1.json',
    HOME: '/home/m',
  }
  const status: (string | undefined)[] = []
  on('env.get', (_, e) => ({ value: env[e.name] }))
  on('clock.now', () => ({ value: NOW }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 1, mtimeMs: 1, isLink: false } }))
  on('fs.read', () => ({ value: JSON.stringify(LIVE) }))
  on('tool.register', () => ({ value: { tool: 'mcp__corkboard-ui__hand_off' } }))
  on('ui.status', (_, e) => {
    status.push(e.text)
    return { value: undefined }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  return status
}

test("Pepper's band has the block now and the next", async ($, on) => {
  const status = await start($, on, 'pepper')
  expect(status).toEqual(['plan · 2 blocks'])
  const ui = await $.ui.mount({
    plugin: 'corkboard-ui',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} },
  })
  const band = await ui.find({ type: 'Text', text: /Deep work/ })
  expect(band?.text).toBe('now 13:00–15:00 Deep work  ·  next 15:30 Gym')
  await ui.unmount()
})

test('hand_off asks Neovim, through hooks/handoff.lua, with the task', async ($, on) => {
  let ran: { argv: readonly string[]; stdin?: string } | undefined
  on('process.run', (_, e) => {
    ran = { argv: e.argv, stdin: e.init?.stdin }
    const stdout = 'started Claude Code in ~/corkboard, tab Fix it'
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  await start($, on, 'pepper')
  const out = await $.tool.call({ tool: 'mcp__corkboard-ui__hand_off', task: 'Fix the login', project: 'corkboard', name: 'Fix it' })
  expect(ran?.argv.slice(0, 4)).toEqual(['nvim', '--clean', '--headless', '-l'])
  expect(ran?.argv[4]).toMatch(/\/\.\.\/hooks\/handoff\.lua$/)
  expect(JSON.parse(ran?.stdin ?? '{}')).toEqual({ task: 'Fix the login', project: 'corkboard', name: 'Fix it' })
  expect(out).toEqual({ result: 'started Claude Code in ~/corkboard, tab Fix it' })
})

test('Pepper edits only under ~/pepper; other sessions anywhere', async ($, on) => {
  on('tool.call', () => ({ result: 'written' }))
  await start($, on, 'pepper')
  const outside = await $.tool.call({ tool: 'Write', file_path: '/home/m/corkboard/x.ts', content: '' })
  expect(outside).toEqual({
    deny: 'Pepper edits only its own files, under /home/m/pepper/. Hand project work off with hand_off.',
  })
  const inside = await $.tool.call({ tool: 'Write', file_path: '/home/m/pepper/notes.md', content: '' })
  expect(inside).toEqual({ result: 'written' })
})

test('a project session edits anywhere', async ($, on) => {
  on('tool.call', () => ({ result: 'written' }))
  await start($, on, 'project')
  const out = await $.tool.call({ tool: 'Edit', file_path: '/home/m/corkboard/x.ts', old_string: 'a', new_string: 'b' })
  expect(out).toEqual({ result: 'written' })
})

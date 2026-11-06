// show: a file on this machine in the media panel beside the session
// (corkboard.claude.cards), where the user sees it without opening it. Only
// a session in corkboard's Neovim ($NVIM, CORKBOARD_BUF) has it; hooks/show.lua
// asks that Neovim. Registered at session.start in work.tsx.

import type { Register } from 'claude-code'

export const SHOW = {
  name: 'show',
  description:
    'Show the user a file in the media panel beside this session: a screenshot, image, plot, video, audio, PDF or ' +
    'text file. Use it whenever you have something for the user to look at, instead of giving its path or describing ' +
    'it. Showing the same path again shows its new contents. Returns whether it is shown.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: "The file's path, absolute or relative to the session's directory" },
      title: { type: 'string', description: "What to call it in the panel's list. Left out, the file's name" },
    },
    required: ['path'],
  },
  isDeferred: false,
}

export const show: Register = on => {
  on('tool.call', { tool: 'mcp__corkboard-ui__show' }, async ($, e) => {
    const server = await $.env.get('NVIM')
    const buf = await $.env.get('CORKBOARD_BUF')
    if (!server || !buf) return { result: 'not in corkboard: nowhere to show it' }
    const path = e.path.startsWith('/') ? e.path : `${await $.session.cwd()}/${e.path}`
    const ran = await $.process
      .run(['nvim', '--clean', '--headless', '-l', `${$.plugin.root}/../hooks/show.lua`], {
        stdin: JSON.stringify({ server, buf, path, title: e.title }),
      })
      .catch((err: unknown) => ({ stdout: `could not run nvim: ${String(err)}`, stderr: '' }))
    return { result: (ran.stdout || ran.stderr).trim() || 'could not show it' }
  })
}

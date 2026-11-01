// say: what the session says out loud, through the avatar panel beside it
// (corkboard.avatar), which picks the calls out of the transcript. Written
// for the ear, so the reply itself can stay written to be read. The
// session is told to use it while the panel is open (hooks/claude-session.lua).

import type { Register } from 'claude-code'

const SAY = {
  name: 'say',
  description:
    'Say something out loud to the user, through the avatar panel beside this session. Use it only while you are ' +
    'told the panel is open. Write for the ear: plain talk in short sentences, no markdown, code, paths, URLs or ' +
    'long identifiers. It does not replace your reply, which stays written to be read.',
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string', description: 'What to say, a few sentences' } },
    required: ['text'],
  },
  isDeferred: false,
}

export const say: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.tool.register(SAY)
    return next(e)
  })

  on('tool.call', { tool: 'mcp__corkboard-ui__say' }, async () => ({ result: 'said' }))
}

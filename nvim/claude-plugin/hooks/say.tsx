// say: what the session says out loud, through the avatar panel beside it
// (corkboard.avatar), which picks the calls out of the transcript. Written
// for the ear, so the reply itself can stay written to be read. The
// session is told to use it while the panel is open (hooks/session.lua).

import type { Register } from 'claude-code'

export const SAY = {
  name: 'say',
  description:
    'Say something out loud to the user, through the avatar panel beside this session. Use it only while you are ' +
    'told the panel is open. Write for the ear: plain talk in short sentences, no markdown, code, paths, URLs or ' +
    'long identifiers. It does not replace your reply, which stays written to be read. A sentence that is only ' +
    'Haha!, Gasp!, What?!, Why? or Hey! plays a real recording.',
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'What to say, a few sentences' },
      mood: {
        type: 'string',
        enum: ['happy', 'excited', 'teasing', 'annoyed', 'sulky', 'shy', 'sad', 'surprised'],
        description: 'How it is said: the voice and the face follow it',
      },
    },
    required: ['text'],
  },
  isDeferred: false,
}

// emote: something the avatar does on purpose, which it never does on its
// own.
export const EMOTE = {
  name: 'emote',
  description:
    'Have the avatar in the panel beside this session do something: wave, give a thumbs up, nod, bow, shrug or jump for joy. ' +
    'Use it only while you are told the panel is open, now and then, when it fits what you are saying.',
  inputSchema: {
    type: 'object',
    properties: {
      emote: { type: 'string', enum: ['wave', 'thumbs', 'nod', 'bow', 'shrug', 'jump'], description: 'thumbs is a thumbs up' },
    },
    required: ['emote'],
  },
  isDeferred: false,
}

// The tools are registered at session.start in work.tsx: an event takes one
// hook without a matcher.
export const say: Register = on => {
  on('tool.call', { tool: 'mcp__corkboard-ui__say' }, async () => ({ result: 'said' }))
  on('tool.call', { tool: 'mcp__corkboard-ui__emote' }, async () => ({ result: 'done' }))
}

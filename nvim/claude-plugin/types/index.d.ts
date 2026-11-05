// Milliseconds: a time since the epoch, or a length of time.
export type Millis = number

// A block of the day plan, its start and stop in minutes since midnight.
export type Block = { start: number; stop: number; title: string; kind: string; card?: string }

// What the Neovim that started this session knows (corkboard.live).
export type Live = {
  plan?: { date: string; problem?: string; proposal: boolean; blocks: Block[] }
}

declare module 'claude-code' {
  // The tools the mod gives: Pepper hand_off (hooks/work.tsx),
  interface McpToolInputs {
    'mcp__corkboard-ui__hand_off': { task: string; project?: string; name?: string }
    // every session say and emote (hooks/say.tsx).
    'mcp__corkboard-ui__say': { text: string }
    'mcp__corkboard-ui__emote': { emote: string }
  }

  interface PluginState {
    'corkboard-ui': {
      // When each transcript row was appended (by its uuid) or each tool call
      // started (by its tool_use_id).
      at: StateFamily<Millis>
      // How long each tool call took, by its tool_use_id.
      took: StateFamily<Millis>
      // Which tool calls' rows are opened to their input and output, by their
      // tool_use_id.
      open: StateFamily<boolean>
      // The live file, as last read.
      live: Live
      // The minute of the day now, for the band.
      minute: number
    }
  }
}

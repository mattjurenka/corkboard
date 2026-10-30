# A brain's memory, as Claude Code hooks: every session starts with the
# brain's context and ends by sending its transcript to corkboard's Worker
# (cloud/src/memory.ts, .agent/plans/memory.md). The same for any agent of
# the brain, wherever it runs.
#
#   SessionStart   GET  /memory/context, printed, which Claude Code adds to
#                  the session's context
#   PreCompact     POST /memory/episodes, the transcript so far
#   SessionEnd     POST /memory/episodes, the whole transcript
#
# The token is the brain's (the Worker reads the brain from it), read from
# `tokenFile` at each hook. No token, no memory: the hooks do nothing, and
# never fail a session.
#
# Gives back `hooks`, for a guest's Claude Code managed settings.
{ pkgs, lib, url ? "https://portal.corkboard.fyi", tokenFile }:
let
  context = pkgs.writeShellApplication {
    name = "corkboard-memory-context";
    runtimeInputs = [ pkgs.curl pkgs.coreutils ];
    text = ''
      cat > /dev/null
      [ -s ${tokenFile} ] || exit 0
      curl -fsS --max-time 15 \
        -H "Authorization: Bearer $(tr -d '\n' < ${tokenFile})" \
        ${url}/memory/context || true
    '';
  };

  episode = pkgs.writeShellApplication {
    name = "corkboard-memory-episode";
    runtimeInputs = [ pkgs.curl pkgs.jq pkgs.coreutils ];
    text = ''
      # The hook's input: session_id, transcript_path, and the event's name.
      input=$(cat)
      [ -s ${tokenFile} ] || exit 0
      transcript=$(jq -r '.transcript_path // empty' <<< "$input")
      if [ -z "$transcript" ] || [ ! -s "$transcript" ]; then exit 0; fi
      trigger=$(jq -r 'if .hook_event_name == "PreCompact" then "compact" else "end" end' <<< "$input")
      jq -n --arg session "$(jq -r '.session_id' <<< "$input")" --arg trigger "$trigger" \
        --rawfile transcript "$transcript" '{ session: $session, trigger: $trigger, transcript: $transcript }' |
        curl -fsS --max-time 60 -o /dev/null \
          -H "Authorization: Bearer $(tr -d '\n' < ${tokenFile})" \
          -H "Content-Type: application/json" \
          --data-binary @- ${url}/memory/episodes || true
    '';
  };

  command = app: [{ hooks = [{ type = "command"; command = lib.getExe app; }]; }];
in
{
  inherit context episode;
  hooks = {
    SessionStart = command context;
    PreCompact = command episode;
    SessionEnd = command episode;
  };
}

# Voice call: away mode by talking to Pepper

**Written:** 2026-11-21 · **Decided:** Pepper itself is the voice, on the same session as its
chat; speech runs on the user's node (Silero VAD, Parakeet, Kokoro), the phone only carries audio,
as the Claude app's voice mode does with Anthropic's servers; Pepper reads sessions freely, and
whatever it would type into one, or spawn, or stop, waits for the user's yes, given on the user's
side (the phone, or their voice heard by the node), never by Pepper.

```
phone: call service ──── mic (VOICE_COMMUNICATION, AEC) ───▶ node: VAD ─▶ Parakeet ─▶ "[call] …" ─▶ Pepper
 (foreground, screen off,  ◀── Kokoro audio ─────────────────     ▲                                   │
  MediaSession, headset)                                          │  "yes" while one waits ─▶ confirm │
                                                                  └── away's wakes: "[call] …asking" │
                            sessions_list · session_screen · session_say/answer · spawn_* ◀──────────┘
                                         (writes held as confirms until the user's yes)
```

---

## 1. Phone: the call

In corkboard-cloud's Android app. A foreground service of type `microphone|mediaPlayback`,
started from a Call button on the Pepper chat, with an ongoing notification (hang up, mute) and a
MediaSession, so it runs with the screen off and a headset's button hangs up. The mic is
`AudioRecord` on `VOICE_COMMUNICATION`, so Android's echo canceller takes Pepper's voice out of what
it hears and the user can talk over it. Audio both ways on a sealed channel to the node (16 kHz
Opus up, the bridge's 16-bit samples down), as the hub's sessions already go. Talking over Pepper
stops its voice at once on the phone and tells the node.

A confirm waiting (step 3) is a notification too, with Yes and No, for when the user would rather
tap.

## 2. Node: the voice loop

The bridge's listen.ts and speech.ts, run for a call: VAD ends an utterance, Parakeet transcribes
it, and fleetd pastes it into Pepper as `[call] …`, as the chat's `[phone]`. Pepper answers with a
new tool, `call_say`, short and spoken (no markdown); the node speaks it with the avatar's voice
and streams it down. While a confirm waits, an utterance that is a yes or a no ("yes", "do it",
"no", "cancel") decides it in the node, before Pepper hears anything.

Away mode's wakes (a session asking, all stopped, one finished a while) during a call go to Pepper
as `[call] …`, so it says them unasked.

## 3. Pepper's tools (this step first: no phone needed)

On the node's /mcp, for the user's own clients and for a resident (fleetd's assistant, Pepper),
over every hub of the account (peers.ts):

- `sessions_list`: every Claude Code session, each with its bridge and key.
- `session_screen`: what one shows.
- `session_say`: type into one (text, and Claude Code's keys).
- `session_answer`: answer the question it asks.
- `spawn_agent`, `start_session`, `spawn_stop`, `spawn_status`: the fleet's, which a brain's
  token didn't have; a resident's now does.

A resident's writes (`session_say`, `session_answer`, `spawn_agent`, `start_session`,
`spawn_stop`) are held as a **confirm**: the node writes what it would do in its own words, from
the arguments, and keeps it ten minutes. The user's own clients see them
(GET /api/node/confirms) and decide (POST /api/node/confirms/:id { ok }); a resident's token can't.
Pepper reads the confirm's words back and waits; `confirm_status` says what came of it.

Why: Pepper reads mail, calendars and the web, so what it reads can tell it what to do. Its VM
keeps it from anything with a shell; a session doesn't. Reading a session is harmless; typing into
one is a shell.

## Order

3 (tools, confirms), then 2 (the voice loop, with the yes heard in the node), then 1 (the phone).
Until 1, confirms are decided only by an owner client's API.

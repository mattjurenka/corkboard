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

## 1. Phone: the call (built: corkboard-cloud's Call.kt, not yet tried on a phone)

In corkboard-cloud's Android app. `call` on the Pepper chat's header starts `CallService`, a
foreground service of type `microphone|mediaPlayback`, with an ongoing notification (mute, hang
up) and a MediaSession, so it runs with the screen off and a headset's button hangs up. The mic is
`AudioRecord` on `VOICE_COMMUNICATION` with the echo canceller, so Pepper's voice is taken out of
what it hears and the user can talk over it; muted, it sends quiet. It goes up as 16 kHz 16-bit
samples a tenth of a second at a time, on the leader's sealed channel (`Hubs.leader`), and
what's said comes down to a streamed AudioTrack, on a headset if there is one, the speaker
otherwise. `stop` drops what's queued at once. Hanging up sends `end`, so what was being said is
still heard. The chat shows the last line heard.

A confirm waiting (step 3) is a notification too, with Yes and No, and a line in the chat with yes
and no, both POSTing confirms/:id on the leader's channel. Opus up is for later.

## 2. Node: the voice loop (done: bridge/node/call.ts)

`POST /api/node/call?voice=&speed=`, the user's own and sealed, ndjson both ways: up, 16 kHz 16-bit
samples (`audio`) and `end`; down, `heard`, `say` (a sentence and its audio), `stop`, `confirm` and
`decided`. Silero cuts what's said into utterances (800 ms of quiet ends one), Parakeet
transcribes each, and it's posted to the chat as the user's, from `call`; fleetd pastes it into
Pepper as `[call] …`, as the chat's `[phone]`. Pepper answers with chat_send, short and spoken (its
instructions say so for `[call]`), and every message of Pepper's during the call is said with
Kokoro (or Chatterbox), a sentence at a time. Speech starting while it's talking sends `stop` and
drops the sentences not yet sent. While a confirm waits, an utterance that's only a yes or a no
("yes", "go ahead", "no", "cancel") decides the newest in the node, before Pepper hears anything,
and Pepper is told `Yes to "…". It's done.`

Away mode's wakes during a call (a session starting to ask, or wanting permission) are posted
from `away`, also pasted as `[call] …`, so Pepper says them unasked. Audio is PCM for now; Opus
later, with the phone.

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
To try it, the leader node has to run step 2.

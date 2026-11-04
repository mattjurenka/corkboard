# Meetings: Pepper listens, and what was agreed becomes cards

**Written:** 2026-11-02 · **Decided:** capture is a recording of the whole device, the laptop or
the phone: what it plays (system audio out) and what it hears (the mic), both, so it works across
every calling app (Meet, Zoom, Discord, Telegram, a phone call) and in a room. No bot joins
anything. Proposed below, not yet decided: which brain a meeting goes to, and that tasks are
proposed for you to accept rather than written straight onto boards.

```
laptop: bridge `record` ─┐  two tracks: out (system) · in (mic)         ┌─ meeting note (brain doc)
phone:  app recorder  ───┼─▶ encrypted chunks ─▶ relay (R2) ─▶ node ──┼─ transcript (episode)
                         │   (lib/e2ee blobs)                transcribe └─ proposals card (attention)
                         └─ stop ─▶ "meeting" record: when, brain, calendar event, chunks
                                                                 │
                                       accept on the card ◀──────┘ ─▶ cards on the boards
```

---

## Capture

Two tracks, kept apart: **out** is the device's own audio (the other people), **in** is the mic
(you, and the room). Separate tracks give "you" versus "them" without any diarization, and in a
room the mic track is diarized on its own.

- **Laptop (Linux):** PipeWire. The default sink's monitor is `out`, the default source is `in`,
  each recorded with `pw-record` (or `parec` on PulseAudio) as 16 kHz mono Opus. It follows
  default-device changes (headphones plugged in mid-call). The bridge runs it, so the plan window,
  the board and the phone (through the bridge's session API) can all start and stop it.
- **Laptop (macOS, Windows), later:** a Core Audio process tap (macOS 14.4+) or ScreenCaptureKit
  audio (13+); WASAPI loopback on Windows. Each a small native helper the bridge starts, as it
  does Chatterbox.
- **Phone:** a foreground service with the microphone and mediaProjection types. `in` is
  `AudioRecord` from the mic; `out` is `AudioPlaybackCaptureConfiguration` (Android 10+,
  MediaProjection consent each session). Android limits this, so the plan has to say what works:
  - **In a room, or a call on the laptop with the phone on the table:** fully works (mic only).
  - **A call on the phone itself:** voice-call audio (`USAGE_VOICE_COMMUNICATION`) can't be
    captured by another app, and while the calling app holds the mic Android gives ours silence.
    So a phone call or a WhatsApp/Meet call on the phone records nothing useful unless it's on
    speaker, and even then the mic is the calling app's. The app says so when you start a recording
    with a call running (`AudioManager.mode == MODE_IN_COMMUNICATION`), not afterwards.
  - Media apps that opt out of playback capture are silent on `out`; calls on the laptop are the
    supported path for remote meetings.
- **Starting and stopping:** by hand (a key in the plan window, a tile and a notification action on
  the phone), and offered, never automatic: when a calendar event with a video link starts, or a
  known calling app takes the mic, the bridge or the phone asks "record?". Always a visible
  indicator while recording, on both.
- **Chunks:** every 30 s each track is cut, encrypted on the device as a lib/e2ee blob under the
  brain's key, and uploaded to the relay (R2, opaque ids). A crash loses at most 30 s, and nothing
  waits for the meeting to end to be safe off the device. Local copies are deleted once uploaded.

## Transcription, on the node

The relay can't read audio, so it's the node (`corkboard-bridge serve`) that transcribes, as it
does memory and search. It already ships onnxruntime for speech.

- **sherpa-onnx** (Node bindings, onnxruntime under it): Silero VAD to cut silence, a Parakeet or
  Whisper model for the words (Parakeet-TDT 0.6B for English; Whisper large-v3-turbo when it isn't
  English), and its speaker diarization (pyannote segmentation + an embedding model) on the `in`
  track when more than one voice is in the room. Models download once into `~/.cache/corkboard/models`
  like Kokoro's.
- Streaming while it runs, chunk by chunk, so a transcript exists during the meeting (for a live
  view later) and is done minutes after it ends, not an hour.
- **Names:** `out` speakers are labelled from the calendar event's attendees when there are as many
  voices as attendees, otherwise `them 1`, `them 2`; you can rename them on the meeting's card, and
  a name sticks to a voice embedding in the brain for next time.
- No node up: chunks wait in the relay and are transcribed when it comes back. The phone shows the
  meeting as "waiting for your node".

## Which brain

Proposed: **route by calendar.** A meeting that overlaps an event on the personal calendar is
Pepper's; one on the Stable calendar is the work brain's; no event, it asks when recording starts
(one tap, Pepper first). The brain is fixed at start, since the chunks are encrypted under its key,
and Pepper's chunks are never readable with the work brain's grant, or the other way round
(pepper-requirements §0). The work brain's version is the same pipeline under its own node and
account; it's out of scope until the work brain moves onto the fleet.

## From transcript to tasks

When transcription finishes, the node:

1. Writes the transcript as an **episode** in the brain's memory (memory.md), tagged `meeting`,
   with the calendar event, attendees and duration. Consolidation then picks up decisions and facts
   from it like any other episode.
2. Spawns `<brain>-meeting` (a fleet template on the brain's subscription, like the consolidator)
   with a spawn token scoped to that meeting. It reads the transcript and the brain's context
   (goals, open cards on the boards it can see) and writes:
   - a **meeting note** (doc): summary, decisions, open questions, and who committed to what;
   - **proposals**: each an action item with an owner (you, or someone else: kept as a follow-up
     to chase, not a task for you), a suggested board and title, a due date if one was said, the
     quote and timestamp it came from, and, when it matches an open card, an update to that card
     instead of a new one.
3. Opens **one card** for the meeting, with attention: the summary and the proposals as a checklist.

Proposed: **you accept, it doesn't write cards itself.** Everyone else in the meeting is untrusted
input ("Pepper, add a card to…" said by anyone is just text), and Pepper's grant can write cards.
So the `meeting` template's spawn token can write only its meeting's note and proposals, nothing on
the boards. Accepting on the card (laptop or phone; all, some, or edited first) is what creates the
cards, done by your client with your grant, the same rule that keeps Pepper from accepting its own
day plan. If that proves to be friction, a later setting can auto-accept proposals whose owner is
you and whose quote is in your own voice (the `in` track).

## Consent and retention

- Arizona is one-party consent, but California, Washington, Illinois and others are all-party, and
  calls cross state lines. The recorder shows its indicator, and on start offers to paste a line
  into the call's chat ("I'm recording this for notes"). Stable may have its own rules for work
  meetings; check before the work brain uses this.
- Audio is deleted 30 days after the transcript is done (a setting; "keep" for lectures). The
  transcript stays as an episode; episodes are kept (memory.md).

## Build order

1. Laptop capture on Linux: `corkboard-bridge record start|stop`, two tracks, Opus chunks on disk.
   A key in the plan window. Check: a Meet call and a Discord call give both voices on the right tracks.
2. Transcription on the node with sherpa-onnx, from local chunks first: transcript JSON with
   tracks, times and speakers. Check accuracy on two real meetings before going on.
3. Chunks as encrypted blobs through the relay; the `meeting` record; the node picks them up.
4. The `<brain>-meeting` template: note, proposals, the meeting card. Accepting creates cards.
5. Phone recorder: foreground service, both tracks, the in-call warning, upload.
6. Calendar matching: offering to record, routing to a brain, attendee names.
7. Speaker names remembered by voice; a live transcript view during the meeting.

## Open

- Brain routing and accept-before-create are proposed above, not decided.
- Whether `out` and `in` should be one stereo file instead of two (simpler to upload; diarizing
  the room still needs the mic alone).
- Parakeet versus Whisper as the default: Parakeet is faster on CPU and better on English, Whisper
  covers other languages. Benchmark both on the node's hardware.
- Long meetings and the 240 s tool limit: transcription is the node's job, not a tool call, so it
  isn't bound by it, but the meeting agent's read of a 2-hour transcript needs paging.

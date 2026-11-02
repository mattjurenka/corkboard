# chatterbox-speech.py: Chatterbox Nano (ResembleAI's 110M Turbo, from its GitHub;
# PyPI's 0.1.7 has no nano) saying a sentence at a time for bridge/speech.ts,
# which starts it once and keeps it. Each voice is cloned from a recording of
# about 10 s, <voice>.wav beside the voices' .bin files, or for a mood
# <voice>-<mood>.wav if there is one; each is made ready the first time it's
# used (the first takes about 30 s, librosa warming up), and kept.
#
# In, a line of JSON a sentence: {"text", "ref"}, ref the recording's path.
# Out, a line of JSON, {"rate", "samples"} or {"error"}, and then that many
# float32 samples (little-endian). On the CPU, a sentence of 3 s takes about
# 3 s: half the speech tokens, half making them sound, about 1 s of it the
# same however short the sentence is. CHATTERBOX_DEVICE is torch's device
# (cuda for ROCm too), cpu if not set; CHATTERBOX_THREADS the CPU's threads.

import json
import os
import sys

os.environ.setdefault("TQDM_DISABLE", "1")

import torch
from chatterbox.tts_turbo import NANO_REPO_ID, ChatterboxTurboTTS
from huggingface_hub import snapshot_download

device = os.environ.get("CHATTERBOX_DEVICE", "cpu")
if threads := os.environ.get("CHATTERBOX_THREADS"):
    torch.set_num_threads(int(threads))
# As it was downloaded, without asking the hub whether it's changed, which
# while the network's busy can take minutes.
try:
    model = ChatterboxTurboTTS.from_local(snapshot_download(NANO_REPO_ID, local_files_only=True), device, nano=True)
except Exception:
    model = ChatterboxTurboTTS.from_pretrained(device=device, nano=True)
out = sys.stdout.buffer
conds = {}


def answer(head, samples=b""):
    out.write(json.dumps(head).encode() + b"\n" + samples)
    out.flush()


answer({"ready": True})
for line in sys.stdin:
    try:
        ask = json.loads(line)
        ref = ask["ref"]
        if ref not in conds:
            model.prepare_conditionals(ref)
            conds[ref] = model.conds
        model.conds = conds[ref]
        with torch.inference_mode():
            wav = model.generate(ask["text"])
        samples = wav.squeeze(0).numpy().astype("<f4").tobytes()
        answer({"rate": model.sr, "samples": len(samples) // 4}, samples)
    except Exception as err:
        answer({"error": f"{type(err).__name__}: {err}"})

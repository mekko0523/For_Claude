"""Make audio clips (AAC in .mp4, an asset type the artifact accepts) for one Chunk Daily day.

Usage:
  python make_audio.py <day.json> <model_dir> <out_dir>

<day.json>  a days/<date> document saved by ArtifactData (out_dir), or the raw document
<model_dir> holds kokoro.onnx and voices.bin (kokoro-onnx v1.0 model files)
<out_dir>   gets one <pattern id>.mp4 per pattern

Setup:
  pip install kokoro-onnx soundfile
  curl -sL -o <model_dir>/kokoro.onnx https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.int8.onnx
  curl -sL -o <model_dir>/voices.bin  https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin
"""
import json
import os
import subprocess
import sys
import tempfile

import soundfile as sf
from kokoro_onnx import Kokoro

VOICE = "af_heart"  # natural American English


def main() -> None:
    day_path, model_dir, out_dir = sys.argv[1:4]
    with open(day_path, encoding="utf-8") as f:
        doc = json.load(f)
    doc = doc.get("data", doc)
    os.makedirs(out_dir, exist_ok=True)
    tts = Kokoro(os.path.join(model_dir, "kokoro.onnx"), os.path.join(model_dir, "voices.bin"))
    for p in doc["patterns"]:
        samples, rate = tts.create(p["en"], voice=VOICE, speed=0.95, lang="en-us")
        with tempfile.NamedTemporaryFile(suffix=".wav") as wav:
            sf.write(wav.name, samples, rate)
            out = os.path.join(out_dir, f"{p['id']}.mp4")
            subprocess.run(
                ["ffmpeg", "-y", "-loglevel", "error", "-i", wav.name, "-ac", "1",
                 "-c:a", "aac", "-b:a", "64k", "-movflags", "+faststart", out],
                check=True,
            )
        print(out)


if __name__ == "__main__":
    main()

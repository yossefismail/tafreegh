"""Dev check: run the bundled llama-server on one window of the sample audio.

    py -3.12 scripts/check-gguf.py --model-dir H:\\jais-gguf

Prints the realtime factor and writes the text to scripts/.gguf-result.json so
you can diff Q4_K_M against Q8_0.
"""

import argparse
import json
import os
import subprocess
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "backend"))

os.environ.setdefault("TAFREEGH_LLAMA_DIR", os.path.join(ROOT, "resources", "llama"))

import soundfile as sf  # noqa: E402

from tafreegh import jais_gguf  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", required=True, help="folder with the .gguf pair")
    parser.add_argument("--wav", default=os.path.join(ROOT, "test-results", "sample.wav"))
    parser.add_argument("--start", type=float, default=5.0)
    parser.add_argument("--seconds", type=float, default=30.0)
    parser.add_argument("--language", default="EG")
    args = parser.parse_args()

    pair = jais_gguf.gguf_files(args.model_dir)
    if not pair:
        print("no model + mmproj pair in", args.model_dir)
        return 2

    print("server:", jais_gguf.server_executable())
    print("backend:", jais_gguf.backend(), "gpu:", jais_gguf.gpu_available())

    data, sr = sf.read(args.wav, dtype="float32")
    start = int(args.start * sr)
    stop = int((args.start + args.seconds) * sr)
    window = os.path.join(tempfile.gettempdir(), "tafreegh-gguf-window.wav")
    jais_gguf.write_window(window, data[start:stop], sr)

    started = time.time()
    server = jais_gguf.LlamaServer(*pair)
    server.start(timeout=420)
    print(f"server ready in {time.time() - started:.1f}s")
    try:
        t0 = time.time()
        text = server.transcribe(window, args.language)
        elapsed = time.time() - t0
        print(f"{args.language or 'auto'}: {elapsed:.1f}s for {args.seconds:.0f}s audio "
              f"({elapsed / args.seconds:.2f}x realtime), {len(text)} chars")
        print(text)
        with open(os.path.join(ROOT, "scripts", ".gguf-result.json"), "w", encoding="utf-8") as fh:
            json.dump(
                {"text": text, "seconds": elapsed, "model_dir": args.model_dir},
                fh,
                ensure_ascii=False,
                indent=2,
            )
    finally:
        server.stop()
        smi = subprocess.run(
            ["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader"],
            capture_output=True,
            text=True,
        )
        print("gpu memory after stop:", smi.stdout.strip() or "n/a")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

"""Tafreegh transcription pipeline.

Adapted from the `arabic-transcribe` skill (MIT). The behaviour is intentionally
identical to `run_pipeline.py`: decode -> spectral enhance -> NVIDIA Nemotron
diarization -> Jais-ASR GGUF (llama.cpp) on speech windows -> synced HTML + TXT
+ JSON. The changes are additive: progress events for the desktop app,
app-managed model paths, a machine-readable transcript, and an offline mock mode
for UI tests.

Enhancement is deliberately torch-free: `noisereduce` (spectral gating) plus
speech-band EQ, compression and AGC. That keeps the runtime ~5 GB smaller than
the old Resemble Enhance path and needs no CUDA wheels in Python.
"""

from __future__ import annotations

import base64
import hashlib
import html as html_lib
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request
import wave
import zipfile

Emitter = None

# Single source of truth for speaker colours. `apply_ui.py` (the shipped page
# theme) keeps the same map; keep them in sync so a re-render and a fresh run
# never disagree about who is which colour.
SPEAKER_COLORS = {
    "A": "#1d4ed8",
    "B": "#0f766e",
    "C": "#7e22ce",
    "D": "#be185d",
    "E": "#a16207",
    "F": "#15803d",
    "G": "#0e7490",
    "H": "#475569",
}

STAGE_RANGES = {
    "copy": (0.0, 2.0),
    "decode": (2.0, 6.0),
    "enhance": (6.0, 18.0),
    "diarize": (18.0, 30.0),
    "load": (30.0, 40.0),
    "transcribe": (40.0, 86.0),
    "audio": (86.0, 94.0),
    "artifacts": (94.0, 100.0),
}


def set_emitter(fn) -> None:
    global Emitter
    Emitter = fn


def emit(event: dict) -> None:
    if Emitter is not None:
        Emitter(event)
    else:
        print(json.dumps(event, ensure_ascii=False), file=sys.stderr, flush=True)


def log(message: str) -> None:
    emit({"type": "log", "message": str(message).rstrip()})


def progress(
    stage: str,
    fraction: float | None = None,
    message: str = "",
    indeterminate: bool = False,
    **extra,
) -> None:
    start, end = STAGE_RANGES.get(stage, (0.0, 100.0))
    frac = 0.0 if fraction is None else max(0.0, min(1.0, fraction))
    overall = start + (end - start) * frac
    emit(
        {
            "type": "progress",
            "stage": stage,
            "overall": round(overall, 2),
            "stageFraction": round(frac, 4),
            "indeterminate": bool(indeterminate),
            "message": message,
            **extra,
        }
    )


def fmt(sec: float) -> str:
    sec = max(0.0, float(sec))
    return f"{int(sec // 60):02d}:{int(sec % 60):02d}"


def esc(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


# ---------------------------------------------------------------- audio decode
def ffmpeg_exe() -> str:
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except ImportError:
        return "ffmpeg"


def decode(path: str, tmpdir: str):
    import numpy as np
    import soundfile as sf

    wav = os.path.join(tmpdir, "audio_16k.wav")
    cmd = [ffmpeg_exe(), "-y", "-i", path, "-vn", "-ac", "1", "-ar", "16000", "-f", "wav", wav]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0 or not os.path.exists(wav):
        raise RuntimeError("ffmpeg decode failed:\n" + (result.stderr or "")[-1500:])
    data, sr = sf.read(wav, dtype="float32")
    if data.ndim > 1:
        data = data.mean(axis=1)
    return data, sr


# ---------------------------------------------------------------- enhancement
def data_root() -> str:
    root = os.environ.get("TAFREEGH_DATA_DIR")
    if root:
        return root
    local = os.environ.get("LOCALAPPDATA")
    if sys.platform == "win32" and local:
        return os.path.join(local, "Tafreegh")
    return os.path.join(os.path.expanduser("~"), ".tafreegh")


# --- NeMo-Speech: runtime and diarizer weights stay inside the app's folder ---
# Upstream caches both in shared user locations (~/.cache/arabic-transcribe and
# %LOCALAPPDATA%\NeMoSpeech\models). That leaves several GB behind after the app
# is uninstalled and makes the app own files another program may reuse, so we
# pin the runtime next to the other app data and point NeMo-Speech's own
# NEMO_SPEECH_MODEL_DIR at <data>/models/nemo-diarization.


def nemo_speech_root() -> str:
    """Where the nemo-speech runtime is unpacked."""
    return os.path.join(data_root(), "bin", "nemo-speech", NEMO_SPEECH_VERSION)


def nemo_model_dir() -> str:
    """Diarizer cache (nvidia/Nemotron-3-Diarization lives under it)."""
    return os.path.join(data_root(), "models", "nemo-diarization")


def _legacy_nemo_root() -> str:
    return os.path.join(
        os.path.expanduser("~"), ".cache", "arabic-transcribe", "nemo-speech", NEMO_SPEECH_VERSION
    )


def _find_nemo_exe(root: str, exe_name: str) -> str | None:
    for base, _dirs, files in os.walk(root):
        if exe_name in files:
            return os.path.join(base, exe_name)
    return None


def _prune_empty_dirs(path: str) -> None:
    """Remove empty folders left behind by a move, stopping below ~/.cache."""
    cache = os.path.abspath(os.path.join(os.path.expanduser("~"), ".cache"))
    current = os.path.abspath(path)
    while current.startswith(cache + os.sep):
        try:
            os.rmdir(current)
        except OSError:
            return
        current = os.path.dirname(current)


def nemo_env() -> dict[str, str]:
    """Environment for every nemo-speech call, with its cache inside the app."""
    env = dict(os.environ)
    env["NEMO_SPEECH_MODEL_DIR"] = nemo_model_dir()
    return env


def resample_16k(x, sr):
    import numpy as np
    import scipy.signal as sps

    if sr == 16000:
        return x.astype(np.float32)
    g = np.gcd(int(sr), 16000)
    return sps.resample_poly(x, 16000 // g, sr // g).astype(np.float32)


def _peaking_biquad(sr, f0, gain_db, q=1.0):
    import numpy as np

    a = 10 ** (gain_db / 40)
    w0 = 2 * np.pi * f0 / sr
    alpha = np.sin(w0) / (2 * q)
    b0, b1, b2 = 1 + alpha * a, -2 * np.cos(w0), 1 - alpha * a
    a0, a1, a2 = 1 + alpha / a, -2 * np.cos(w0), 1 - alpha / a
    return np.array([[b0 / a0, b1 / a0, b2 / a0, 1.0, a1 / a0, a2 / a0]])


def enhance(x, sr):
    import numpy as np
    import scipy.signal as sps

    progress("enhance", 0.1, "تنقية الضوضاء وتصفية الكلام…", True)
    try:
        import noisereduce as nr

        x = nr.reduce_noise(
            y=x, sr=sr, stationary=True, prop_decrease=0.75, n_fft=1024, hop_length=256
        )
        log("noise reduction: spectral gate applied")
    except ImportError:
        log("noise reduction: skipped (noisereduce missing)")

    progress("enhance", 0.55, "ضبط نطاق الصوت البشري…", True)
    sos = sps.butter(4, 90, btype="highpass", fs=sr, output="sos")
    x = sps.sosfiltfilt(sos, x)

    x = sps.sosfilt(_peaking_biquad(sr, 250, -3.0, q=0.8), x)
    x = sps.sosfilt(_peaking_biquad(sr, 2500, 5.0, q=1.0), x)
    x = sps.sosfilt(_peaking_biquad(sr, 5000, 2.0, q=1.2), x)

    progress("enhance", 0.75, "ضغط الصوت ورفع مستوى الكلام…", True)
    frame, hop = int(0.25 * sr), int(0.125 * sr)
    n = (len(x) - frame) // hop + 1
    if n >= 4:
        x = x.astype(np.float32, copy=False)
        rms_db = np.empty(n, dtype=np.float64)
        for i in range(n):
            seg = x[i * hop : i * hop + frame]
            rms_db[i] = 20 * np.log10(np.sqrt(np.mean(seg**2, dtype=np.float64)) + 1e-10)
        over = np.clip(rms_db, -60, 0)
        gain_db = np.minimum(0.0, (-20 + (over - (-20)) / 3) - over)
        gain_db = np.clip(gain_db, -12.0, 10.0)
        gain = 10 ** (gain_db / 20)
        g = np.interp(
            np.arange(len(x), dtype=np.float32), np.arange(n) * hop + frame // 2, gain
        ).astype(np.float32)
        x = np.clip(x * g, -1.0, 1.0)

    active = np.abs(x) > 0.01
    if np.any(active):
        rms = float(np.sqrt(np.mean(x[active] ** 2)) + 1e-10)
        x = x * (10 ** (-14.0 / 20)) / rms
    return np.clip(x, -0.89, 0.89).astype(np.float32), sr


# ---------------------------------------------------------------- diarization
NEMO_SPEECH_VERSION = "0.3.0"
NEMO_SPEECH_RELEASE = (
    "https://github.com/NVIDIA/NeMo-Speech.cpp/releases/download/" f"v{NEMO_SPEECH_VERSION}"
)
NEMO_DIAR_MODEL = "nvidia/Nemotron-3-Diarization"


def _nemo_speech_asset() -> str:
    machine = platform.machine().lower()
    arch = {
        "amd64": "x86_64",
        "x86-64": "x86_64",
        "x86_64": "x86_64",
        "arm64": "aarch64",
        "aarch64": "aarch64",
    }.get(machine, machine)
    if sys.platform == "win32":
        os_name, ext = "windows", "zip"
    elif sys.platform == "darwin":
        os_name, ext = "macos", "tar.gz"
    elif sys.platform.startswith("linux"):
        os_name, ext = "linux", "tar.gz"
    else:
        raise RuntimeError(f"no nemo-speech build for platform {sys.platform}")
    return f"nemo-speech-{NEMO_SPEECH_VERSION}-{os_name}-{arch}-cpu.{ext}"


def _sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _download(url: str, dest: str, what: str) -> None:
    log(f"downloading {what} ...")
    tmp = dest + ".part"
    with urllib.request.urlopen(url, timeout=120) as r, open(tmp, "wb") as f:
        shutil.copyfileobj(r, f)
    os.replace(tmp, dest)


def ensure_nemo_speech() -> str:
    env = os.environ.get("NEMO_SPEECH_BIN")
    if env:
        if os.path.isfile(env):
            return env
        raise RuntimeError(f"NEMO_SPEECH_BIN={env} does not exist")
    found = shutil.which("nemo-speech") or shutil.which("nemo-speech.exe")
    if found:
        return found

    root = nemo_speech_root()
    exe_name = "nemo-speech.exe" if sys.platform == "win32" else "nemo-speech"
    found = _find_nemo_exe(root, exe_name)
    if found:
        return found

    # Older builds unpacked the runtime into a shared ~/.cache folder. Adopt it
    # instead of downloading the same archive again, so upgrades keep the
    # runtime inside the app's own folder without a second download.
    legacy = _legacy_nemo_root()
    found = _find_nemo_exe(legacy, exe_name)
    if found:
        os.makedirs(os.path.dirname(root), exist_ok=True)
        try:
            shutil.move(legacy, root)
        except OSError as exc:
            log(f"could not move the old nemo-speech runtime ({exc}); copying it")
            try:
                shutil.copytree(legacy, root, dirs_exist_ok=True)
            except OSError:
                pass
        found = _find_nemo_exe(root, exe_name)
        if found:
            log(f"nemo-speech: adopted the previous runtime in {root}")
            # Drop the now-empty ~/.cache/arabic-transcribe/nemo-speech folders.
            _prune_empty_dirs(os.path.dirname(legacy))
            return found

    os.makedirs(root, exist_ok=True)
    asset = _nemo_speech_asset()
    url = f"{NEMO_SPEECH_RELEASE}/{asset}"
    archive = os.path.join(root, asset)
    if not os.path.isfile(archive):
        log("downloading nemo-speech runtime ...")
        _download(url, archive, f"nemo-speech {NEMO_SPEECH_VERSION} ({asset})")
        _download(url + ".sha256", archive + ".sha256", "nemo-speech checksum")
        with open(archive + ".sha256", encoding="utf-8") as f:
            expected = f.read().split()[0].strip().lower()
        actual = _sha256_file(archive)
        if actual != expected:
            os.remove(archive)
            raise RuntimeError(
                "nemo-speech failed its SHA-256 check and was deleted "
                f"(expected {expected[:12]}…, got {actual[:12]}…)"
            )

    extract = os.path.join(root, "dist")
    log("unpacking nemo-speech ...")
    if asset.endswith(".zip"):
        with zipfile.ZipFile(archive) as z:
            z.extractall(extract)
    else:
        with tarfile.open(archive, "r:gz") as t:
            try:
                t.extractall(extract, filter="data")
            except TypeError:
                t.extractall(extract)
    for base, _dirs, files in os.walk(extract):
        if exe_name in files:
            path = os.path.join(base, exe_name)
            if sys.platform != "win32":
                os.chmod(path, 0o755)
            return path
    raise RuntimeError(f"nemo-speech archive {asset} did not contain {exe_name}")


def _parse_rttm(path: str):
    turns = []
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            parts = line.split()
            if len(parts) < 8 or parts[0] != "SPEAKER":
                continue
            try:
                start, dur = float(parts[3]), float(parts[4])
            except ValueError:
                continue
            turns.append(
                {"start": round(start, 3), "end": round(start + dur, 3), "speaker": parts[7]}
            )
    turns.sort(key=lambda t: (t["start"], t["end"]))
    return turns


def diarize_nemo(x, sr, tmpdir):
    import soundfile as sf

    exe = ensure_nemo_speech()
    wav = os.path.join(tmpdir, "diarization.wav")
    rttm = os.path.join(tmpdir, "diarization.rttm")
    sf.write(wav, x, sr)

    preset = os.environ.get("NEMO_DIAR_PRESET", "v3-offline")
    device = os.environ.get("NEMO_DIAR_DEVICE", "auto")
    model = os.environ.get("NEMO_DIAR_MODEL") or NEMO_DIAR_MODEL
    log(f"diarizing with {model} (nemo-speech {NEMO_SPEECH_VERSION}) ...")
    cmd = [
        exe,
        "diarize",
        wav,
        "--format",
        "rttm",
        "--recording-id",
        "audio",
        "--model",
        model,
        "--device",
        device,
        "-o",
        rttm,
    ]
    result = subprocess.run(
        cmd + (["--preset", preset] if preset else []),
        capture_output=True,
        text=True,
        env=nemo_env(),
    )
    if result.returncode != 0 and preset:
        log(f"preset '{preset}' rejected, retrying with the default streaming pass")
        try:
            os.remove(rttm)
        except OSError:
            pass
        result = subprocess.run(cmd, capture_output=True, text=True, env=nemo_env())
    if result.returncode != 0 or not os.path.exists(rttm):
        raise RuntimeError(
            "nemo-speech diarization failed:\n" + (result.stderr or result.stdout or "")[-1500:]
        )

    turns = _parse_rttm(rttm)
    if not turns:
        raise RuntimeError("diarization produced no speaker turns (no speech, or the model rejected the audio)")
    return turns


def speech_blocks(turns, sr=None, min_speech=3.0, merge_gap=15.0):
    runs = [(t["start"], t["end"]) for t in turns if t["end"] - t["start"] > 0.2]
    if not runs:
        return []
    runs.sort()
    blocks = [[runs[0][0], runs[0][1]]]
    for s, e in runs[1:]:
        if s - blocks[-1][1] <= merge_gap:
            blocks[-1][1] = max(blocks[-1][1], e)
        else:
            blocks.append([s, e])
    out = []
    for s, e in blocks:
        talk = sum(min(e, te) - max(s, ts) for ts, te in runs if min(e, te) > max(s, ts))
        if talk >= min_speech:
            out.append((max(0.0, s - 1.0), e + 1.0))
    return out


def windows_from_blocks(blocks, win=30.0):
    segs = []
    for a, b in blocks:
        s = a
        while s < b - 0.5:
            e = min(s + win, b)
            segs.append((s, e))
            s = e
    return segs


def speech_segments(turns, sr, duration):
    """Padded speaker blocks clamped to the audio, cut into <=30 s ASR windows.

    ``speech_blocks`` pads each block by a second. When a clip ends exactly on a
    window boundary that pad points past the last sample, and the extra window is
    empty: llama.cpp answers 400 "Failed to load image or audio file" for a WAV
    with no frames, so both the blocks and the windows are trimmed here.
    """
    blocks = [
        (max(0.0, s), min(e, duration))
        for s, e in speech_blocks(turns, sr)
        if min(e, duration) - s >= 0.5
    ]
    segs = [(s, e) for s, e in windows_from_blocks(blocks) if e - s >= 0.2]
    return blocks, segs


# ---------------------------------------------------------------- Jais variants
# Artifacts published in https://huggingface.co/collections/IFM/jais-speech.
# Tafreegh only ships the GGUF builds: they are served by the llama.cpp server
# the app bundles, so there is no transformers / bitsandbytes model loading.
JAIS_COLLECTION = "https://huggingface.co/collections/IFM/jais-speech"

JAIS_VARIANTS = {
    "gguf": {
        "repo": "IFM/Jais-ASR-GGUF",
        "label": "Jais-ASR Q4_K_M (GGUF)",
        "bytes": 3_712_101_824,
        "wer": 22.99,
        "vramGb": 5.5,
        "files": ["Jais-ASR-Q4_K_M.gguf", "mmproj-Jais-ASR-Q6_K.gguf"],
    },
    "gguf-q8": {
        "repo": "IFM/Jais-ASR-GGUF",
        "label": "Jais-ASR Q8_0 (GGUF)",
        "bytes": 6_714_641_344,
        "wer": 22.83,
        "vramGb": 7.6,
        "files": ["Jais-ASR-Q8_0.gguf", "mmproj-Jais-ASR-F16.gguf"],
    },
}

# VRAM from which the Q8_0 pair (~7.6 GB resident) replaces Q4_K_M (~5.5 GB).
JAIS_Q8_MIN_VRAM_GB = 9.0


def _nvidia_device() -> dict | None:
    """First NVIDIA GPU as reported by the driver.

    Torch is not part of the runtime any more, so VRAM and the device name come
    from `nvidia-smi` (installed with every NVIDIA driver). AMD/Intel machines
    simply return None and llama.cpp's own device list decides placement.
    """
    commands = [
        ["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader,nounits"],
    ]
    if sys.platform == "win32":
        commands.append(
            [
                os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32", "nvidia-smi.exe"),
                "--query-gpu=name,memory.total",
                "--format=csv,noheader,nounits",
            ]
        )
    for cmd in commands:
        try:
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
        except Exception:  # noqa: BLE001
            continue
        if result.returncode != 0:
            continue
        line = next((item for item in result.stdout.splitlines() if "," in item), "")
        if not line:
            continue
        name, _, memory = line.rpartition(",")
        try:
            vram = round(float(memory.strip()) / 1024, 1)
        except ValueError:
            continue
        return {"name": name.strip(), "vramGb": vram}
    return None


def device_profile() -> dict:
    """Hardware facts that decide which Jais artifact to download."""
    info = {"cuda": False, "vramGb": 0.0, "ramGb": 0.0, "device": None, "platform": platform.system()}
    gpu = _nvidia_device()
    if gpu:
        info["cuda"] = True
        info["vramGb"] = gpu["vramGb"]
        info["device"] = gpu["name"]
    try:
        if hasattr(os, "sysconf"):  # POSIX
            info["ramGb"] = round(os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES") / 1024**3, 1)
        else:  # Windows
            import ctypes

            class _MemStatus(ctypes.Structure):
                _fields_ = [
                    ("dwLength", ctypes.c_ulong),
                    ("dwMemoryLoad", ctypes.c_ulong),
                    ("ullTotalPhys", ctypes.c_ulonglong),
                    ("ullAvailPhys", ctypes.c_ulonglong),
                    ("ullTotalPageFile", ctypes.c_ulonglong),
                    ("ullAvailPageFile", ctypes.c_ulonglong),
                    ("ullTotalVirtual", ctypes.c_ulonglong),
                    ("ullAvailVirtual", ctypes.c_ulonglong),
                    ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
                ]

            stat = _MemStatus()
            stat.dwLength = ctypes.sizeof(_MemStatus)
            ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(stat))
            info["ramGb"] = round(stat.ullTotalPhys / 1024**3, 1)
    except Exception:  # noqa: BLE001
        pass
    return info


def select_jais_variant(profile: dict | None = None, preference: str | None = None) -> str:
    """Pick the GGUF quantization this machine can hold.

    Q4_K_M (3.7 GB on disk, ~5.5 GB resident) fits a 6 GB laptop card; Q8_0
    (6.7 GB, ~7.6 GB resident) needs roughly 9 GB of VRAM. Everything else —
    CPU-only, an unknown card, or an unrecognised preference — lands on Q4_K_M.
    """
    forced = preference or os.environ.get("TAFREEGH_JAIS_VARIANT") or ""
    if forced in JAIS_VARIANTS:
        return forced
    info = profile or device_profile()
    vram = float(info.get("vramGb") or 0)
    return "gguf-q8" if vram >= JAIS_Q8_MIN_VRAM_GB else "gguf"


def jais_dir(models_dir: str) -> str:
    """Single managed slot for whichever GGUF pair is installed."""
    return os.path.join(models_dir, "jais-asr")


def detect_jais_variant(d: str) -> str | None:
    """Which GGUF quantization is in this folder, judged from its files."""
    try:
        from . import jais_gguf

        pair = jais_gguf.gguf_files(d)
    except Exception:  # noqa: BLE001
        return None
    if not pair:
        return None
    return "gguf-q8" if "q8_0" in os.path.basename(pair[0]).lower() else "gguf"


def _jais_dir_complete(d: str) -> bool:
    """True when the folder holds the text model *and* its audio projector."""
    try:
        from . import jais_gguf

        return jais_gguf.gguf_files(d) is not None
    except Exception:  # noqa: BLE001
        return False


def _jais_fallback_dirs() -> list[str]:
    """Folders earlier tools used for the same weights (kept for reuse)."""
    return [
        os.path.expanduser("~/.local/share/opencode/models/jais-asr"),
        os.path.expanduser("~/.cache/jais-asr"),
    ]


def resolve_jais_model(model_dir: str | None = None) -> str:
    """Return the folder that holds the managed GGUF pair.

    llama.cpp needs both files on disk, so a folder without them is unusable:
    there is no hub fallback any more, only the setup screen download.
    """
    candidates = []
    if model_dir:
        candidates.append(model_dir)
    env = os.environ.get("JAIS_LOCAL_DIR")
    if env:
        candidates.append(env)
    # The app-owned slot is the default install target, so it must be found
    # even when the caller did not pass --model-dir.
    candidates.append(jais_dir(os.path.join(data_root(), "models")))
    candidates += _jais_fallback_dirs()
    complete = [
        d
        for d in dict.fromkeys(candidates)
        if os.path.isdir(d) and _jais_dir_complete(d)
    ]
    if complete:
        # Prefer the quantization this device actually wants: a managed GGUF
        # download wins over a borrowed pair of the other size.
        wanted = select_jais_variant()
        for d in complete:
            if detect_jais_variant(d) == wanted:
                return d
        return complete[0]
    raise RuntimeError(
        "لم يُعثر على نموذج Jais-ASR بصيغة GGUF. "
        "أنزل النموذج من شاشة الإعدادات ثم أعد المحاولة."
    )
# ---------------------------------------------------------------- outputs
RLM, LRM = "\u200f", "\u200e"

# Arabic letters (base block, supplement, extended-A).
ARABIC_RE = re.compile(r"[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]")


def base_dir(text: str) -> str:
    """Paragraph direction for a code-switched line.

    `dir="auto"` looks at the first strong character only, so a window that
    happens to start with an English word ("okay.") flipped the whole Arabic
    block to LTR: left-aligned, punctuation reordered. The app is Arabic-first,
    so anything containing Arabic reads RTL; only a line without any Arabic
    (an English quote, a bare timestamp) is LTR.
    """
    return "rtl" if ARABIC_RE.search(text) else "ltr"


def _clause_split(txt: str):
    return [p for p in (q.strip() for q in re.split(r"(?<=[.؟!،؛?,:])\s+", txt)) if p]


def dominant_speaker(turns, start: float, end: float):
    """Speaker with the largest overlap in [start, end].

    Diarization turns are sparse: short utterances separated by gaps. Picking
    the turn that merely contains a midpoint leaves whole windows unlabeled, so
    fall back to the nearest turn when nothing overlaps.
    """
    best, best_overlap = None, 0.0
    for turn in turns:
        overlap = min(end, turn["end"]) - max(start, turn["start"])
        if overlap > best_overlap:
            best, best_overlap = turn, overlap
    if best is None and turns:
        mid = (start + end) / 2
        best = min(turns, key=lambda t: abs((t["start"] + t["end"]) / 2 - mid))
    return best["speaker"] if best else None


def build_outputs(
    job_dir: str,
    display_name: str,
    lines,
    turns,
    audio_b64,
    a,
    b,
    mime="audio/mp4",
    quant="Q4_K_M",
):
    labels = {}
    for t in sorted(turns, key=lambda x: x["start"]):
        if t["speaker"] not in labels:
            labels[t["speaker"]] = f"Speaker {chr(ord('A') + len(labels))}"

    def speaker_at(start, end):
        return labels.get(dominant_speaker(turns, start, end), "Speaker ?")

    spk_list = sorted(set(labels.values()))
    body = []
    for s, e, txt in lines:
        body.append(
            f'    <div class="win"><div class="meta" dir="ltr">[{fmt(s)}&thinsp;&ndash;&thinsp;{fmt(e)}]</div>'
        )
        if not txt:
            body.append('      <p class="txt" dir="rtl"><i>(لا يوجد كلام)</i></p></div>')
            continue
        clauses = _clause_split(txt)
        total = sum(len(c) for c in clauses) or 1
        dur, acc = e - s, 0.0
        body.append(f'      <p class="txt" dir="{base_dir(txt)}">')
        for c in clauses:
            cs = s + dur * acc / total
            acc += len(c)
            ce = s + dur * acc / total
            spk = speaker_at(cs, ce).split()[-1]
            # Each clause is an isolate with its own base direction, so an
            # English clause keeps its word order and punctuation inside an
            # Arabic paragraph (and the other way round).
            body.append(
                f'<span class="chunk s{spk}" data-start="{cs:.2f}" data-end="{ce:.2f}"'
                f' dir="{base_dir(c)}">{esc(c)} </span>'
            )
        body.append("</p></div>")

    legend = "".join(
        f'<span class="dot" style="background:{SPEAKER_COLORS.get(spk, "#141414")}"></span>{spk}'
        for spk in spk_list
    )

    html = """<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>__TITLE__ — تفريغ</title>
<style>
* { box-sizing: border-box; }
body { font-family: 'Segoe UI', 'Noto Naskh Arabic', 'Geeza Pro', system-ui, sans-serif;
       background: #faf9f6; color: #1c1b18; margin: 0; padding: 0 0 3rem; }
.player { position: sticky; top: 0; z-index: 5; background: #fffdf8ee; backdrop-filter: blur(6px);
          border-bottom: 1px solid #e7e4db; padding: .7rem 1rem; }
.player audio { width: 100%; max-width: 680px; display: block; margin: 0 auto; }
.hdr { max-width: 760px; margin: 1.2rem auto .4rem; padding: 0 1rem; }
.hdr h1 { font-size: 1.15rem; margin: 0 0 .2rem; }
.hdr .sub { color: #6b675e; font-size: .82rem; }
.legend { max-width: 760px; margin: .4rem auto 1rem; padding: 0 1rem; font-size: .82rem; color: #6b675e; }
.legend .dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin: 0 6px 0 14px; }
main { max-width: 760px; margin: 0 auto; padding: 0 1rem; }
.win { background: #fff; border: 1px solid #e7e4db; border-radius: 12px; padding: .8rem 1.1rem; margin: .7rem 0; }
.meta { font-size: .75rem; color: #8a857a; margin-bottom: .3rem; letter-spacing: .02em; }
.txt { font-size: 1.12rem; line-height: 2.05; margin: 0; text-align: start; }
.chunk { cursor: pointer; border-radius: 5px; padding: 1px 2px; transition: background .15s;
         unicode-bidi: isolate; }
.chunk:hover { background: #eee9dc; }
.sA { border-bottom: 2px solid #1d4ed866; } .sB { border-bottom: 2px solid #0f766e66; }
.sC { border-bottom: 2px solid #7e22ce66; } .sD { border-bottom: 2px solid #be185d66; }
.sE { border-bottom: 2px solid #a1620766; } .sF { border-bottom: 2px solid #15803d66; }
.sG { border-bottom: 2px solid #0e749066; } .sH { border-bottom: 2px solid #47556966; }
.chunk.on.sA { background: #1d4ed82e; } .chunk.on.sB { background: #0f766e2e; }
.chunk.on.sC { background: #7e22ce2e; } .chunk.on.sD { background: #be185d2e; }
.chunk.on.sE { background: #a162072e; } .chunk.on.sF { background: #15803d2e; }
.chunk.on.sG { background: #0e74902e; } .chunk.on.sH { background: #4755692e; }
.hint { text-align: center; color: #8a857a; font-size: .8rem; margin: .8rem 0 0; }
</style>
</head>
<body>
<div class="player"><audio id="au" controls preload="auto" src="data:__MIME__;base64,__AUDIO__"></audio>
<div class="hint" dir="rtl">انقر أي نص للانتقال &middot; الجملة الحالية تتظلل أثناء التشغيل</div></div>
<div class="hdr">
<h1>__TITLE__</h1>
<div class="sub" dir="rtl">Jais-ASR (__QUANT__) &middot; NVIDIA Nemotron-3-Diarization &middot; الكلام __A__&ndash;__B__ &middot; العربية كما نُطقت، والإنجليزية بحروفها اللاتينية</div>
</div>
<div class="legend" dir="rtl">ألوان المتحدثين: __LEGEND__</div>
<main>
__BODY__
</main>
<script>
const au = document.getElementById('au');
const chunks = Array.from(document.querySelectorAll('.chunk'));
let last = null;
chunks.forEach(c => c.addEventListener('click', () => {
  au.currentTime = parseFloat(c.dataset.start) + 0.01;
  if (au.paused) au.play();
}));
au.addEventListener('timeupdate', () => {
  const t = au.currentTime;
  let act = null;
  for (const c of chunks) {
    const on = t >= parseFloat(c.dataset.start) && t < parseFloat(c.dataset.end);
    c.classList.toggle('on', on);
    if (on) act = c;
  }
  if (act && act !== last) { act.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); last = act; }
});
</script>
</body>
</html>"""
    html = (
        html.replace("__AUDIO__", audio_b64)
        .replace("__MIME__", mime)
        .replace("__TITLE__", esc(display_name))
        .replace("__QUANT__", quant)
        .replace("__A__", fmt(a))
        .replace("__B__", fmt(b))
        .replace("__LEGEND__", legend)
        .replace("__BODY__", "\n".join(body))
    )
    html_path = os.path.join(job_dir, "transcript.html")
    with open(html_path, "w", encoding="utf-8") as f:
        f.write(html)

    out = [
        f"تفريغ — {display_name}",
        "(Jais-ASR " + quant + " + NVIDIA Nemotron-3-Diarization; English in Latin script)",
        f"نطاق الكلام: {fmt(a)}-{fmt(b)} | المتحدثون: {', '.join(spk_list)}",
        "=" * 70,
        "",
    ]
    for s, e, txt in lines:
        out.append(LRM + f"[{fmt(s)}-{fmt(e)}]")
        if txt:
            # RLM for Arabic blocks, LRM for an all-English one: Notepad has no
            # per-paragraph direction, and an RLM before English moved its final
            # period to the wrong end of the line.
            out.append((RLM if base_dir(txt) == "rtl" else LRM) + txt)
        else:
            out.append(LRM + "(لا يوجد كلام)")
        out.append("")
    txt_path = os.path.join(job_dir, "transcript.txt")
    with open(txt_path, "w", encoding="utf-8-sig") as f:
        f.write("\n".join(out))
    return html_path, txt_path, spk_list, labels


_TAG_RE = re.compile(r"<[^>]+>")
_DIR_ATTR_RE = re.compile(r'\s*dir="[^"]*"')
_CHUNK_SPAN_RE = re.compile(r'<span class="chunk s([A-Z])"([^>]*)>(.*?)</span>', re.S)
_TXT_P_RE = re.compile(r'<p class="txt"([^>]*)>(.*?)</p>', re.S)
_AUTO_CSS = "<style>.txt{text-align:start}.chunk{unicode-bidi:isolate}</style>\n"


def _plain(fragment: str) -> str:
    return html_lib.unescape(_TAG_RE.sub("", fragment))


def repair_bidi(html_path: str) -> bool:
    """Fix the direction markup of a page written by an older build.

    Pages keep the audio inline, so they are never regenerated on their own: a
    recording made before this fix would keep rendering `dir="auto"` (which
    flips a window that starts with an English word) unless we rewrite it. Only
    the `dir` attributes and one CSS rule change; everything else, including
    the embedded player and the summary, stays byte-identical. Returns True when
    the file was rewritten.
    """
    with open(html_path, encoding="utf-8") as f:
        html = f.read()
    if 'class="txt"' not in html:
        return False

    def chunk(m):
        spk, attrs, body = m.group(1), m.group(2), m.group(3)
        attrs = _DIR_ATTR_RE.sub("", attrs).rstrip()
        return f'<span class="chunk s{spk}"{attrs} dir="{base_dir(_plain(body))}">{body}</span>'

    def paragraph(m):
        attrs, body = m.group(1), m.group(2)
        attrs = _DIR_ATTR_RE.sub("", attrs).rstrip()
        return f'<p class="txt"{attrs} dir="{base_dir(_plain(body))}">{body}</p>'

    repaired = _CHUNK_SPAN_RE.sub(chunk, html)
    repaired = _TXT_P_RE.sub(paragraph, repaired)
    repaired = repaired.replace(
        '<section class="summary" id="recording-summary" dir="auto">',
        '<section class="summary" id="recording-summary" dir="rtl">',
    )
    if "unicode-bidi:isolate" not in repaired and "</head>" in repaired:
        repaired = repaired.replace("</head>", _AUTO_CSS + "</head>", 1)
    if repaired == html:
        return False
    with open(html_path, "w", encoding="utf-8") as f:
        f.write(repaired)
    return True


def write_transcript_json(
    job_dir,
    display_name,
    lines,
    turns,
    labels,
    duration,
    a,
    b,
    language,
    windows,
    quant="Q4_K_M",
):
    def speaker_at(start, end):
        return labels.get(dominant_speaker(turns, start, end), "Speaker ?")

    payload = {
        "title": display_name,
        "duration": round(duration, 3),
        "speechStart": round(a, 3),
        "speechEnd": round(b, 3),
        "language": language,
        "model": f"IFM/Jais-ASR-GGUF ({quant})",
        "quant": quant,
        "diarizer": "NVIDIA Nemotron-3-Diarization",
        "speakers": sorted(set(labels.values())),
        "windows": windows,
        "lines": [
            {
                "start": round(s, 3),
                "end": round(e, 3),
                "text": txt,
                "speaker": speaker_at(s, e),
            }
            for s, e, txt in lines
        ],
        "turns": [
            {"start": round(t["start"], 3), "end": round(t["end"], 3), "speaker": t["speaker"]}
            for t in turns
        ],
    }
    path = os.path.join(job_dir, "transcript.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    return path


# ---------------------------------------------------------------- mock mode
MOCK_LINES = [
    (0.0, 9.0, "أهلاً بيكم في اجتماع فريق المنتج. النهارده هنراجع خطة الربع الجاي ونحدد أولوياتنا."),
    (9.0, 20.0, "أنا شايف إن أهم حاجة نخلّص تجربة المستخدم الجديدة قبل نهاية الشهر، عشان نلحق إطلاق النسخة التجريبية."),
    (20.0, 31.0, "تمام، بس محتاجين نتأكد إن فريق التصميم خلّص الـ design system، وكمان نراجع الـ onboarding flow."),
    (31.0, 43.0, "أنا هتواصل مع سارة النهارده وأبعت لها الملاحظات. وكمان هنحتاج نجهّز خطة اختبار مع فريق الـ QA."),
    (43.0, 55.0, "بالنسبة للميزانية، الإدارة وافقت على مبلغ إضافي للـ cloud infrastructure، بس بشرط نقدّم تقرير أسبوعي."),
    (55.0, 67.0, "خلاص، أنا هكتب التقرير الأول وأشاركوه معاكم يوم الخميس. هل في أي اعتراض على المواعيد دي؟"),
    (67.0, 79.0, "مفيش اعتراض. بس خلّونا نحدد مسؤول لكل بند، عشان مفيش حاجة تضيع."),
    (79.0, 92.0, "اتفقنا. هبعت ملخص الاجتماع على الإيميل، والاجتماع الجاي يوم الأحد الساعة عشرة الصبح. شكراً للجميع."),
]


def _write_mock_audio(path: str, seconds: float = 92.0, sr: int = 8000) -> None:
    import math
    import random

    random.seed(7)
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        frames = bytearray()
        for i in range(int(seconds * sr)):
            t = i / sr
            env = 0.5 + 0.5 * math.sin(2 * math.pi * 0.23 * t)
            tone = 0.05 * math.sin(2 * math.pi * 180 * t) + 0.02 * math.sin(2 * math.pi * 320 * t)
            noise = 0.006 * (random.random() * 2 - 1)
            sample = int(max(-1.0, min(1.0, (tone * env + noise))) * 32767)
            frames += sample.to_bytes(2, "little", signed=True)
        w.writeframes(bytes(frames))


def run_mock(job_dir: str, display_name: str, language: str) -> dict:
    t0 = time.time()
    progress("decode", 0.2, "فك ترميز الصوت…", True)
    time.sleep(0.7)
    progress("enhance", 0.2, "تنقية الضوضاء…", True)
    time.sleep(1.0)
    progress("enhance", 0.9, "ضبط نطق الكلام…")
    progress("diarize", 0.15, "تحديد المتحدثين…", True)
    time.sleep(1.0)
    progress("diarize", 0.9, "تم تحديد متحدثين")
    progress("load", 0.1, "تحميل نموذج التفريغ…", True)
    time.sleep(1.0)
    progress("load", 0.95, "النموذج جاهز")

    duration = 92.0
    turns = [
        {"start": 0.0, "end": 31.0, "speaker": "spk0"},
        {"start": 31.0, "end": 67.0, "speaker": "spk1"},
        {"start": 67.0, "end": 92.0, "speaker": "spk0"},
    ]
    lines = [(s, e, txt) for s, e, txt in MOCK_LINES]
    for i in range(len(lines)):
        time.sleep(0.35)
        progress("transcribe", (i + 1) / len(lines), "تفريغ الكلام…", False, window=i + 1, windows=len(lines))
    progress("audio", 0.3, "تجهيز ملف الصوت المحسّن…", True)
    wav = os.path.join(job_dir, "enhanced.wav")
    _write_mock_audio(wav, duration)
    audio_b64 = base64.b64encode(open(wav, "rb").read()).decode()
    progress("audio", 0.9, "تم تجهيز الصوت")
    progress("artifacts", 0.3, "بناء صفحة التفريغ…", True)
    html_path, txt_path, spk_list, labels = build_outputs(
        job_dir, display_name, lines, turns, audio_b64, 0.0, duration, mime="audio/wav"
    )
    json_path = write_transcript_json(
        job_dir, display_name, lines, turns, labels, duration, 0.0, duration, language, len(lines)
    )
    os.remove(wav)
    progress("artifacts", 1.0, "اكتمل التفريغ")
    return {
        "html": html_path,
        "txt": txt_path,
        "json": json_path,
        "audio": None,
        "speakers": spk_list,
        "duration": duration,
        "speechStart": 0.0,
        "speechEnd": duration,
        "windows": len(lines),
        "elapsed": time.time() - t0,
    }


# ---------------------------------------------------------------- job runner
def run_job(
    input_path: str,
    job_dir: str,
    display_name: str,
    language: str = "EG",
    enhance_enabled: bool = True,
    model_dir: str | None = None,
    max_seconds: float = 0.0,
) -> dict:
    if os.environ.get("TAFREEGH_MOCK") == "1":
        return run_mock(job_dir, display_name, language)

    source = resolve_jais_model(model_dir)
    variant = detect_jais_variant(source)
    if not variant:
        raise RuntimeError(
            f"تعذّر تحديد صيغة النموذج في المجلد: {source}. أعد تنزيله من الإعدادات."
        )
    quant = "Q8_0" if variant == "gguf-q8" else "Q4_K_M"
    log(f"precision: {quant} (artifact: {variant})")

    t0 = time.time()
    os.makedirs(job_dir, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        progress("decode", 0.05, "فك ترميز الصوت…", True)
        x, sr = decode(input_path, tmp)
        if max_seconds:
            x = x[: int(max_seconds * sr)]
        duration = len(x) / sr
        log(f"total: {duration:.0f}s")

        player_src = None
        if enhance_enabled:
            progress("enhance", 0.02, "تنقية الصوت وتوضيح الكلام…", True)
            y, sr_y = enhance(x, sr)
            player_src = (y, sr_y)
            x = resample_16k(y, sr_y)
            sr = 16000
            duration = len(x) / sr
            log(f"enhanced: {duration:.0f}s, ASR input resampled to 16 kHz")

        progress("diarize", 0.05, "تحديد المتحدثين…", True)
        turns = diarize_nemo(x, sr, tmp)
        log(f"diarization: {len(turns)} speaker turns")
        progress("diarize", 1.0, "تم تحديد المتحدثين")

        blocks, segs = speech_segments(turns, sr, duration)
        if not blocks or not segs:
            raise RuntimeError("لم يُعثر على كلام في هذا الملف.")
        a, b = blocks[0][0], blocks[-1][1]
        total_speech = sum(e - s for s, e in blocks)
        log(f"speech blocks: {[(fmt(s), fmt(e)) for s, e in blocks]}")
        log(f"transcribing {len(segs)} windows ({total_speech:.0f}s of speech) ...")

        progress("load", 0.15, f"تحميل نموذج Jais-ASR ({quant})…", True)
        from . import jais_gguf

        pair = jais_gguf.gguf_files(source)
        if not pair:
            raise RuntimeError("ملفات GGUF غير مكتملة. أعد تنزيل نموذج التفريغ من الإعدادات.")
        profile = device_profile()
        fit_target = jais_gguf.fit_target_for(
            int(round(float(profile.get("vramGb") or 0) * 1024)) or None
        )
        log(
            "llama.cpp placement: "
            + ("cpu only" if not profile.get("vramGb") else f"auto-fit, margin {fit_target} MiB")
        )
        server = jais_gguf.LlamaServer(*pair, fit_target_mb=fit_target).__enter__()
        try:
            progress("load", 1.0, f"النموذج جاهز ({quant})")
            log(f"transcribing with llama.cpp (language pin: {language}) ...")
            lines = []
            on_window = lambda i, n: progress(  # noqa: E731
                "transcribe",
                i / max(1, n),
                f"تفريغ الكلام… {i} / {n}",
                False,
                window=i,
                windows=n,
            )
            wav_path = os.path.join(tmp, "window.wav")
            for index, (s, e) in enumerate(segs):
                jais_gguf.write_window(wav_path, x[int(s * sr) : int(e * sr)], sr)
                text = re.sub(r"\s+", " ", server.transcribe(wav_path, language)).strip()
                lines.append((s, e, text))
                log(f"[{fmt(s)}-{fmt(e)}] {len(text)} chars")
                on_window(index + 1, len(segs))
        finally:
            server.stop()

        progress("audio", 0.1, "تجهيز ملف الصوت المحسّن…", True)
        import soundfile as sf

        py_sig, py_sr = player_src if player_src is not None else (x, sr)
        wav_enh = os.path.join(tmp, "enhanced.wav")
        sf.write(wav_enh, py_sig, py_sr)
        m4a = os.path.join(tmp, "player.m4a")
        cmd = [
            ffmpeg_exe(),
            "-y",
            "-ss",
            f"{max(0.0, a - 1.0):.2f}",
            "-to",
            f"{min(duration, b + 1.0):.2f}",
            "-i",
            wav_enh,
            "-ac",
            "1",
            "-ar",
            "44100",
            "-c:a",
            "aac",
            "-b:a",
            "64k",
            m4a,
        ]
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode != 0 or not os.path.exists(m4a):
            raise RuntimeError("ffmpeg encode failed:\n" + (result.stderr or "")[-1500:])

        audio_path = os.path.join(job_dir, "enhanced.m4a")
        shutil.copyfile(m4a, audio_path)
        audio_b64 = base64.b64encode(open(m4a, "rb").read()).decode()

        trim = max(0.0, a - 1.0)
        lines = [(s - trim, e - trim, txt) for s, e, txt in lines]
        turns = [
            {"start": t["start"] - trim, "end": t["end"] - trim, "speaker": t["speaker"]}
            for t in turns
            if t["end"] > trim
        ]
        a, b = a - trim, b - trim
        progress("audio", 1.0, "تم تجهيز الصوت")

        progress("artifacts", 0.2, "بناء صفحة التفريغ…", True)
        html_path, txt_path, spk_list, labels = build_outputs(
            job_dir,
            display_name,
            lines,
            turns,
            audio_b64,
            a,
            b,
            mime="audio/mp4",
            quant=quant,
        )
        json_path = write_transcript_json(
            job_dir,
            display_name,
            lines,
            turns,
            labels,
            duration - trim,
            a,
            b,
            language,
            len(segs),
            quant=quant,
        )
        progress("artifacts", 1.0, "اكتمل التفريغ")

    return {
        "html": html_path,
        "txt": txt_path,
        "json": json_path,
        "audio": audio_path,
        "speakers": spk_list,
        "duration": duration - trim,
        "speechStart": a,
        "speechEnd": b,
        "windows": len(segs),
        "quant": quant,
        "elapsed": time.time() - t0,
    }

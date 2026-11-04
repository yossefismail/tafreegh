"""First-run model setup: Jais-ASR weights and the NVIDIA diarizer."""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import wave

from . import pipeline


def _emit(event: dict) -> None:
    pipeline.emit(event)


def setup_progress(phase: str, pct: float | None, message: str, indeterminate=False, **extra):
    _emit(
        {
            "type": "setup",
            "phase": phase,
            "pct": 0.0 if pct is None else max(0.0, min(100.0, pct)),
            "indeterminate": indeterminate,
            "message": message,
            **extra,
        }
    )


def _dir_size(path: str) -> int:
    total = 0
    if not os.path.isdir(path):
        return 0
    for base, _dirs, files in os.walk(path):
        for name in files:
            try:
                total += os.path.getsize(os.path.join(base, name))
            except OSError:
                pass
    return total


class _Poller:
    """Emit byte progress while something else writes to disk.

    `source` is either a folder (its size is summed) or a callable returning a
    byte count. The callable form lets the Jais download count only the files it
    owns: a folder-wide sum used to include abandoned `.incomplete` fragments
    left by earlier attempts, so the counter passed the total and the bar stuck
    at 100 % while gigabytes were still missing.
    """

    def __init__(self, source, total: int, phase: str, message: str, offset: int = 0):
        self.source = source
        self.total = max(1, total)
        self.phase = phase
        self.message = message
        self.offset = offset
        self.stop = threading.Event()
        self.thread = threading.Thread(target=self._run, daemon=True)

    def _sample(self) -> tuple[float, int]:
        raw = self.offset + (self.source() if callable(self.source) else _dir_size(self.source))
        # Never report more bytes than the file has: the UI prints the pair
        # verbatim, and "3.80 GB / 3.72 GB" is what a stale fragment looks like.
        done = min(raw, self.total)
        return min(99.0, done * 100.0 / self.total), done

    def _run(self):
        last = -1.0
        last_at = 0.0
        while not self.stop.wait(1.0):
            pct, done = self._sample()
            now = time.monotonic()
            # 0.1 % of a 3.7 GB model is ~4 MB, so the bar moves about once a
            # second; the 2 s heartbeat keeps the number alive on slow links.
            if pct - last >= 0.1 or now - last_at >= 2.0:
                last = pct
                last_at = now
                setup_progress(
                    self.phase,
                    pct,
                    self.message,
                    False,
                    bytesDone=done,
                    bytesTotal=self.total,
                )

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *exc):
        self.stop.set()
        self.thread.join(timeout=2)


def _prune_stale_weights(path: str, variant: str) -> None:
    """After a successful swap, drop weight files the new artifact does not use.

    GGUF is the only format the app loads now, so this also cleans a folder
    left behind by an older safetensors install (12 GB of dead weight sitting
    next to the 3.7 GB pair).
    """
    keep = set(pipeline.JAIS_VARIANTS[variant].get("files") or [])
    if not keep:
        # Never delete weights when we could not read the new layout.
        pipeline.log("skipping stale-weight cleanup: new artifact layout unknown")
        return
    for name in os.listdir(path):
        low = name.lower()
        weight = (
            low.endswith(".gguf")
            or low.endswith(".safetensors")
            or low.endswith(".safetensors.index.json")
            or low == "model.safetensors.index.json"
        )
        if weight and name not in keep:
            try:
                pipeline.log(f"removing stale weight file {name}")
                os.remove(os.path.join(path, name))
            except OSError:
                pass


def _variant_downloaded(path: str, variant: str) -> bool:
    """True when `path` now holds the files this variant ships.

    This cannot be answered with `detect_jais_variant` right after a variant
    switch: the managed slot still holds the previous pair (Q4_K_M next to the
    new Q8_0 files) until `_prune_stale_weights` runs, so detection would
    report the old variant and fail a perfectly good download.
    """
    try:
        names = set(os.listdir(path))
    except OSError:
        return False
    files = pipeline.JAIS_VARIANTS[variant].get("files") or []
    return bool(files) and all(name in names for name in files)


def _jais_staging(target: str) -> str:
    """Where huggingface_hub writes a file while it is still downloading."""
    return os.path.join(target, ".cache", "huggingface", "download")


def _jais_downloaded(target: str, files: list[str]) -> int:
    """Bytes this download has written so far: finished files plus fragments.

    Only the two files this variant ships and the `.incomplete` blobs the
    downloader is still appending to are counted. Summing the whole model
    folder is what produced `3.80 GB / 3.72 GB`: abandoned fragments from
    earlier attempts, plus file-tree caches, were added to the numerator.
    """
    total = 0
    for name in files:
        try:
            total += os.path.getsize(os.path.join(target, name))
        except OSError:
            pass
    staging = _jais_staging(target)
    try:
        entries = os.listdir(staging)
    except OSError:
        return total
    for name in entries:
        if name.endswith(".incomplete"):
            try:
                total += os.path.getsize(os.path.join(staging, name))
            except OSError:
                pass
    return total


def _purge_legacy_staging(target: str) -> int:
    """Reclaim 1.x staging, keeping the longest fragment of each file.

    huggingface_hub 1.x writes `<blob>.<etag>.<uuid8>.incomplete` and opens a
    fresh one on every attempt, so a killed run leaves several fragments of the
    same file. The 0.x line (pinned in requirements.txt) resumes the stable
    `<blob>.<etag>.incomplete` and appends to it, so the longest fragment is
    renamed into that slot instead of being thrown away: a download interrupted
    by 0.9.2 continues on 0.9.3 instead of starting the 3.7 GB over.

    Returns the bytes actually deleted.
    """
    staging = _jais_staging(target)
    try:
        entries = os.listdir(staging)
    except OSError:
        return 0

    suffix = ".incomplete"
    groups: dict[str, list[tuple[int, str]]] = {}
    for name in entries:
        # 0.x: `<blob>.<etag>.incomplete` (2 dots). 1.x adds a uuid segment.
        if not name.endswith(suffix) or name.count(".") < 3:
            continue
        stem = name[: -len(suffix)]
        prefix, _, _uuid = stem.rpartition(".")
        path = os.path.join(staging, name)
        try:
            groups.setdefault(prefix, []).append((os.path.getsize(path), path))
        except OSError:
            continue

    freed = 0
    for prefix, parts in groups.items():
        parts.sort(reverse=True)
        keep_size, keep_path = parts[0]
        resumable = os.path.join(staging, prefix + suffix)
        try:
            if os.path.exists(resumable) and os.path.getsize(resumable) >= keep_size:
                for size, path in parts:
                    os.remove(path)
                    freed += size
                continue
            os.replace(keep_path, resumable)
        except OSError:
            continue
        for size, path in parts[1:]:
            try:
                os.remove(path)
                freed += size
            except OSError:
                pass

    if freed:
        pipeline.log(f"removed {freed / 1e6:.0f} MB of duplicate download staging")
    return freed


def _download_jais_files(spec: dict, target: str, files: list[str]) -> None:
    """Download the variant's two GGUFs through huggingface_hub.

    The 0.x line resumes the same `.incomplete` file after a crash or a closed
    app, which is why `requirements.txt` pins it.
    """
    from huggingface_hub import snapshot_download

    message = f"تنزيل نموذج التفريغ ({spec['label']})"
    total = int(spec["bytes"])

    _purge_legacy_staging(target)
    os.makedirs(target, exist_ok=True)
    setup_progress("jais", 0, message, False, bytesDone=0, bytesTotal=total)

    with _Poller(lambda: _jais_downloaded(target, files), total, "jais", message):
        snapshot_download(
            repo_id=spec["repo"],
            local_dir=target,
            max_workers=4,
            allow_patterns=files,
        )
    # The tree cache and lock files are only useful while a download runs.
    shutil.rmtree(os.path.join(target, ".cache", "huggingface"), ignore_errors=True)


def download_jais(models_dir: str, variant: str | None = None) -> dict:
    if variant not in pipeline.JAIS_VARIANTS:
        variant = pipeline.select_jais_variant()
    spec = pipeline.JAIS_VARIANTS[variant]
    target = pipeline.jais_dir(models_dir)
    if os.environ.get("TAFREEGH_MOCK") == "1":
        # UI tests run the setup screen offline: report the catalog artifact as
        # installed without downloading gigabytes. Empty placeholders keep
        # `models_status` agreeing with the event stream.
        os.makedirs(target, exist_ok=True)
        for name in spec["files"]:
            open(os.path.join(target, name), "ab").close()
        setup_progress(
            "jais",
            100,
            f"وضع الاختبار: {spec['label']}",
            False,
            bytesDone=int(spec["bytes"]),
            bytesTotal=int(spec["bytes"]),
        )
        return {"path": target, "present": True, "variant": variant, "mock": True}

    borrowed = os.environ.get("JAIS_LOCAL_DIR") or ""
    if borrowed and os.path.abspath(borrowed) != os.path.abspath(target):
        # The user pointed the app at weights they already have. Never write
        # into that folder — but when it holds the other quantization (say a
        # borrowed Q4_K_M on a card that wants Q8_0) still fetch the
        # recommended artifact into the app-owned slot so the download button
        # does something useful.
        if not pipeline._jais_dir_complete(borrowed):
            raise RuntimeError(f"المجلد المحدد للنموذج غير مكتمل: {borrowed}")
        installed = pipeline.detect_jais_variant(borrowed)
        if installed == variant:
            setup_progress(
                "jais",
                100,
                "نموذج التفريغ موجود في المجلد المحدد",
                False,
                bytesDone=1,
                bytesTotal=1,
            )
            return {"path": borrowed, "present": True, "variant": installed, "borrowed": True}
        pipeline.log(
            f"borrowed folder holds {installed}; downloading {variant} into the app-owned slot"
        )

    installed = pipeline.detect_jais_variant(target)
    if pipeline._jais_dir_complete(target) and installed == variant:
        setup_progress("jais", 100, "نموذج التفريغ موجود بالفعل", False, bytesDone=1, bytesTotal=1)
        return {"path": target, "present": True, "variant": variant}

    os.makedirs(target, exist_ok=True)
    patterns = spec["files"]
    # Fetch only the two files this variant ships: the repo also carries six
    # other quantizations, so a bare `snapshot_download` would pull the lot.
    pipeline.log(f"{spec['label']} download ({spec['repo']})")

    last_error: Exception | None = None
    for attempt in range(1, 4):
        try:
            _download_jais_files(spec, target, patterns)
            if not _variant_downloaded(target, variant):
                raise RuntimeError(f"download finished but the {variant} weights are missing")
            # Only now that the new artifact is on disk, free the old weights.
            # Pruning before detection is what makes an in-place variant swap
            # work: leftover files of the previous quantization would keep
            # `detect_jais_variant` on the old artifact.
            _prune_stale_weights(target, variant)
            if not pipeline._jais_dir_complete(target):
                raise RuntimeError("download finished but the model snapshot is incomplete")
            got = pipeline.detect_jais_variant(target)
            if got != variant:
                raise RuntimeError(f"downloaded {got} weights while {variant} was requested")
            setup_progress("jais", 100, "اكتمل تنزيل نموذج التفريغ", False)
            return {"path": target, "present": True, "variant": variant}
        except Exception as exc:  # noqa: BLE001
            last_error = exc
            pipeline.log(f"Jais download attempt {attempt} failed: {type(exc).__name__}: {exc}")
            if attempt < 3:
                setup_progress("jais", None, "تعثّر التنزيل… إعادة المحاولة", True)
                time.sleep(2)
    raise RuntimeError(f"تعذّر تنزيل نموذج التفريغ: {last_error}")


def _nemo_cache_dirs() -> list[str]:
    """The app-owned diarizer cache first, then the shared folders old builds used.

    New downloads land in `<data>/models/nemo-diarization` (see
    `pipeline.nemo_env`), so uninstalling the app takes them with it. The legacy
    paths stay in the list so an upgrade still sees weights downloaded before
    this change instead of asking for another 105 MB.
    """
    candidates = [
        pipeline.nemo_model_dir(),
        os.path.join(os.environ.get("LOCALAPPDATA", ""), "NeMoSpeech", "models"),
        os.path.join(os.path.expanduser("~"), ".cache", "NeMoSpeech", "models"),
        os.path.join(os.path.expanduser("~"), ".cache", "nemo-speech", "models"),
    ]
    return [p for p in candidates if p]


def _adopt_legacy_nemo_cache() -> None:
    """Move weights from a shared NeMo-Speech cache into the app's folder."""
    target = pipeline.nemo_model_dir()
    if _dir_size(target) > 0:
        return
    os.makedirs(os.path.dirname(target), exist_ok=True)
    for legacy in _nemo_cache_dirs()[1:]:
        if not os.path.isdir(legacy):
            continue
        try:
            shutil.move(legacy, target)
            pipeline.log(f"nemo-speech: moved the diarizer cache from {legacy} to {target}")
            # %LOCALAPPDATA%\NeMoSpeech\models leaves an empty NeMoSpeech folder.
            parent = os.path.dirname(legacy)
            if os.path.basename(parent) == "NeMoSpeech":
                try:
                    os.rmdir(parent)
                except OSError:
                    pass
            return
        except OSError as exc:  # noqa: BLE001
            pipeline.log(f"nemo-speech: could not move {legacy} ({exc}); leaving it in place")


def _nemo_model_bytes() -> int:
    return sum(_dir_size(p) for p in _nemo_cache_dirs())


def _custom_diarizer() -> str:
    """A .gguf the user picked in Settings, passed through NEMO_DIAR_MODEL."""
    path = os.environ.get("NEMO_DIAR_MODEL") or ""
    return path if path and os.path.isfile(path) else ""


def _diarizer_bytes() -> int:
    custom = _custom_diarizer()
    if custom:
        return os.path.getsize(custom)
    return _nemo_model_bytes()


def _write_warmup_wav(path: str, seconds: float = 3.0, sr: int = 16000) -> None:
    import math

    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        frames = bytearray()
        for i in range(int(seconds * sr)):
            t = i / sr
            sample = int(0.08 * math.sin(2 * math.pi * 220 * t) * 32767)
            frames += sample.to_bytes(2, "little", signed=True)
        w.writeframes(bytes(frames))


def warm_diarizer() -> dict:
    setup_progress("diarizer", None, "تجهيز محرك تمييز المتحدثين", True)
    custom = _custom_diarizer()
    if custom:
        setup_progress("diarizer", 100, "نموذج تمييز المتحدثين من المسار المحدد", False)
        return {"present": True, "bytes": os.path.getsize(custom), "path": custom}
    exe = pipeline.ensure_nemo_speech()
    pipeline.log(f"nemo-speech: {exe}")
    # Weights from a build that used the shared NeMo-Speech cache move into the
    # app's own folder, so "uninstall" removes them with everything else.
    _adopt_legacy_nemo_cache()

    if _nemo_model_bytes() > 50_000_000:
        setup_progress("diarizer", 100, "نموذج تمييز المتحدثين موجود بالفعل")
        return {"present": True, "bytes": _nemo_model_bytes()}

    stop = threading.Event()

    def poll_nemo():
        last = -1.0
        while not stop.wait(1.5):
            done = _nemo_model_bytes()
            pct = min(99.0, done * 100.0 / 110_000_000)
            if pct - last >= 0.5:
                last = pct
                setup_progress(
                    "diarizer",
                    pct,
                    "تنزيل نموذج تمييز المتحدثين",
                    False,
                    bytesDone=done,
                    bytesTotal=110_000_000,
                )

    poller = threading.Thread(target=poll_nemo, daemon=True)
    poller.start()
    try:
        # v0.3.0 documents `nemo-speech pull <repo-id>` and caches the GGUF under
        # NEMO_SPEECH_MODEL_DIR, which nemo_env() points at the app's own models
        # folder. If a build lacks `pull`, fall back to a short warm-up
        # inference, which downloads the model on demand into the same place.
        proc = subprocess.run(
            [exe, "pull", pipeline.NEMO_DIAR_MODEL],
            capture_output=True,
            text=True,
            timeout=900,
            env=pipeline.nemo_env(),
        )
        if proc.returncode != 0:
            pipeline.log("nemo-speech pull failed; falling back to warm-up inference")
            pipeline.log((proc.stderr or proc.stdout or "")[-800:])
            with tempfile.TemporaryDirectory() as tmp:
                wav = os.path.join(tmp, "warmup.wav")
                rttm = os.path.join(tmp, "warmup.rttm")
                _write_warmup_wav(wav)
                env = pipeline.nemo_env()
                env["NEMO_DIAR_DEVICE"] = "cpu"
                proc = subprocess.run(
                    [
                        exe,
                        "diarize",
                        wav,
                        "--format",
                        "rttm",
                        "--recording-id",
                        "warmup",
                        "--model",
                        pipeline.NEMO_DIAR_MODEL,
                        "--device",
                        "cpu",
                        "-o",
                        rttm,
                    ],
                    capture_output=True,
                    text=True,
                    timeout=900,
                    env=env,
                )
                if proc.returncode != 0:
                    pipeline.log((proc.stderr or proc.stdout or "")[-1200:])
    finally:
        stop.set()
        poller.join(timeout=2)

    size = _nemo_model_bytes()
    if size < 50_000_000:
        raise RuntimeError("تعذّر تنزيل نموذج تمييز المتحدثين (nemo-speech)")
    setup_progress("diarizer", 100, "اكتمل تجهيز نموذج تمييز المتحدثين", False)
    return {"present": True, "bytes": size}


def probe() -> dict:
    info = {
        "python": sys.version.split()[0],
        "cuda": False,
        "device": None,
        "vramGb": None,
        "ramGb": None,
        "jaisVariant": None,
    }
    try:
        profile = pipeline.device_profile()
        info["cuda"] = bool(profile.get("cuda"))
        info["device"] = profile.get("device")
        info["vramGb"] = profile.get("vramGb") or None
        info["ramGb"] = profile.get("ramGb") or None
        info["jaisVariant"] = pipeline.select_jais_variant(profile)
    except Exception as exc:  # noqa: BLE001
        info["deviceError"] = f"{type(exc).__name__}: {exc}"
    for mod in ("soundfile", "imageio_ffmpeg", "huggingface_hub", "noisereduce", "scipy"):
        try:
            __import__(mod)
            info[mod] = True
        except Exception:  # noqa: BLE001
            info[mod] = False
    if info["cuda"]:
        setup_progress("probe", 100, "المعالج الرسومي جاهز", False, detail=info.get("device"))
    else:
        setup_progress("probe", 100, "لم يتم العثور على CUDA", False)
    return info


def models_status(models_dir: str) -> dict:
    jais_dir = pipeline.jais_dir(models_dir)
    borrowed = os.environ.get("JAIS_LOCAL_DIR") or ""
    if borrowed and os.path.isdir(borrowed):
        jais_dir = borrowed
    suggested = pipeline.select_jais_variant()
    installed = pipeline.detect_jais_variant(jais_dir)
    active = installed if installed in pipeline.JAIS_VARIANTS else suggested
    spec = pipeline.JAIS_VARIANTS[active]
    return {
        "jais": {
            "present": pipeline._jais_dir_complete(jais_dir),
            "bytes": _dir_size(jais_dir),
            "totalBytes": spec["bytes"],
            "variant": active,
            "variantLabel": spec["label"],
            "installed": installed,
            "suggested": suggested,
            "wer": spec["wer"],
            "collection": pipeline.JAIS_COLLECTION,
            "path": jais_dir,
        },
        "diarizer": {"present": _diarizer_bytes() > 50_000_000, "bytes": _diarizer_bytes()},
    }


def setup_all(models_dir: str, variant: str | None = None) -> dict:
    os.makedirs(models_dir, exist_ok=True)
    result = {"models": models_status(models_dir)}
    result["jais"] = download_jais(models_dir, variant)
    result["diarizer"] = warm_diarizer()
    result["models"] = models_status(models_dir)
    return result

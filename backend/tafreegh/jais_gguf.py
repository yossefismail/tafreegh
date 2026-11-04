"""llama.cpp backend for the GGUF builds of Jais-ASR.

Tafreegh only ships GGUF now: the Q4_K_M pair (3.7 GB, ~5.5 GB resident) fits a
6 GB card, and IFM publishes it for llama.cpp, which the app bundles
(``resources/llama/llama-server.exe``).
"""

from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import wave

from .pipeline import log

SERVER_NAMES = ("llama-server.exe", "llama-server")
# Q4_K_M text decoder + Q6_K audio projector: 3.71 GB, ~5 GiB at runtime.
MODEL_FILE = "Jais-ASR-Q4_K_M.gguf"
MMPROJ_FILE = "mmproj-Jais-ASR-Q6_K.gguf"
# The model's chat template treats this system message as `code_switch=True`
# (see chat_template.jinja in IFM/Jais-ASR): Arabic stays in Arabic script and
# English/French/Italian spans stay verbatim, i.e. Latin script, instead of
# being transliterated into Arabic letters.
CODE_SWITCH_PROMPT = "[Code-switch]"


def server_executable() -> str | None:
    """Locate llama-server: explicit env, the bundled runtime, then PATH."""
    explicit = os.environ.get("TAFREEGH_LLAMA_SERVER")
    if explicit and os.path.isfile(explicit):
        return explicit
    roots = []
    for key in ("TAFREEGH_LLAMA_DIR", "TAFREEGH_RESOURCES_DIR"):
        value = os.environ.get(key)
        if value:
            roots.append(value)
            roots.append(os.path.join(value, "llama"))
    here = os.path.dirname(os.path.abspath(__file__))
    roots += [
        os.path.join(here, "llama"),
        os.path.join(here, "..", "..", "resources", "llama"),
        os.path.join(here, "..", "..", ".llama"),
    ]
    for root in roots:
        for name in SERVER_NAMES:
            candidate = os.path.join(root, name)
            if os.path.isfile(candidate):
                return os.path.abspath(candidate)
    for name in SERVER_NAMES:
        found = shutil.which(name)
        if found:
            return found
    return None


def backend() -> str:
    """Which acceleration the bundled llama.cpp was built with."""
    exe = server_executable()
    if not exe:
        return "none"
    root = os.path.dirname(exe)
    marker = os.path.join(root, "backend.txt")
    if os.path.isfile(marker):
        try:
            with open(marker, encoding="utf-8") as handle:
                value = handle.read().strip().lower()
            if value in ("cpu", "vulkan", "cuda"):
                return value
        except OSError:
            pass
    if os.path.isfile(os.path.join(root, "ggml-cuda.dll")):
        return "cuda"
    if os.path.isfile(os.path.join(root, "ggml-vulkan.dll")):
        return "vulkan"
    return "cpu"


def gpu_available() -> bool:
    """True when the bundled llama.cpp was built with Vulkan or CUDA."""
    return backend() in ("vulkan", "cuda")


def gguf_files(directory: str) -> tuple[str, str] | None:
    """Return (text model, audio projector) when this folder holds the GGUF pair."""
    if not os.path.isdir(directory):
        return None
    names = os.listdir(directory)
    model = (
        os.path.join(directory, MODEL_FILE)
        if MODEL_FILE in names
        else next(
            (
                os.path.join(directory, name)
                for name in sorted(names)
                if name.lower().endswith(".gguf") and not name.lower().startswith("mmproj")
            ),
            None,
        )
    )
    mmproj = (
        os.path.join(directory, MMPROJ_FILE)
        if MMPROJ_FILE in names
        else next(
            (
                os.path.join(directory, name)
                for name in sorted(names)
                if name.lower().startswith("mmproj") and name.lower().endswith(".gguf")
            ),
            None,
        )
    )
    if model and mmproj:
        return model, mmproj
    return None


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _multipart(fields: dict[str, str], file_field: str, file_path: str, file_type: str):
    boundary = f"----tafreegh{int(time.time() * 1000)}"
    chunks: list[bytes] = []
    for name, value in fields.items():
        chunks.append(
            (
                f"--{boundary}\r\n"
                f'Content-Disposition: form-data; name="{name}"\r\n\r\n'
                f"{value}\r\n"
            ).encode("utf-8")
        )
    with open(file_path, "rb") as handle:
        payload = handle.read()
    chunks.append(
        (
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="{file_field}"; filename="{os.path.basename(file_path)}"\r\n'
            f"Content-Type: {file_type}\r\n\r\n"
        ).encode("utf-8")
    )
    chunks.append(payload)
    chunks.append(f"\r\n--{boundary}--\r\n".encode("utf-8"))
    return boundary, b"".join(chunks)


def _pick_device(exe: str) -> str | None:
    """Prefer the discrete NVIDIA GPU when the Vulkan backend lists two."""
    try:
        out = subprocess.run(
            [exe, "--list-devices"],
            capture_output=True,
            text=True,
            timeout=90,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        ).stdout
    except Exception:  # noqa: BLE001
        return None
    devices: list[tuple[str, str]] = []
    for line in out.splitlines():
        head, sep, tail = line.partition(":")
        if not sep:
            continue
        name = head.strip()
        if not name or not name[-1].isdigit():
            continue
        devices.append((name, tail.strip()))
    for name, desc in devices:
        if "nvidia" in desc.lower() or "geforce" in desc.lower() or "rtx" in desc.lower():
            return name
    return devices[0][0] if devices else None


def offload_args(device: str | None, fit_target_mb: int | None = None) -> list[str]:
    """Placement flags for llama-server.

    With a GPU we hand placement back to llama.cpp: ``-ngl auto`` with
    ``--fit on`` keeps as many layers resident as actually fit and reserves a
    VRAM margin, so a model larger than the card degrades to a partial offload
    (the rest runs on the CPU) instead of failing to allocate. Without a GPU we
    pin everything to the CPU so the server never probes a device that is not
    there.
    """
    if not device:
        return ["-ngl", "0"]
    args = ["-ngl", "auto", "--fit", "on"]
    if fit_target_mb and fit_target_mb > 0:
        args += ["--fit-target", str(int(fit_target_mb))]
    return args


def fit_target_for(vram_mb: int | None) -> int | None:
    """VRAM margin (MiB) handed to ``--fit``.

    llama.cpp defaults to 1024 MiB, which is stingy on 4-6 GB cards and leaves
    too much of the model on the CPU. Smaller cards get a smaller reserve; the
    goal is to maximise resident layers while still leaving room for the compute
    buffers the server allocates after the weights.
    """
    if not vram_mb or vram_mb <= 0:
        return None
    if vram_mb >= 8192:
        return 1024
    if vram_mb >= 4096:
        return 640
    return 448


class LlamaServer:
    """One llama-server process per job, bound to loopback."""

    def __init__(
        self,
        model: str,
        mmproj: str,
        threads: int = 0,
        fit_target_mb: int | None = None,
    ):
        self.model = model
        self.mmproj = mmproj
        self.threads = threads
        self.fit_target_mb = fit_target_mb
        self.port = 0
        self.proc: subprocess.Popen | None = None
        self._log = None

    def __enter__(self) -> "LlamaServer":
        self.start()
        return self

    def __exit__(self, *exc) -> None:
        self.stop()

    def start(self, timeout: float = 300.0) -> None:
        exe = server_executable()
        if not exe:
            raise RuntimeError(
                "محرّك llama.cpp غير موجود (llama-server.exe). أعد تثبيت التطبيق ثم حاول مجددًا."
            )
        self.port = _free_port()
        device = _pick_device(exe)
        args = [
            exe,
            "-m",
            self.model,
            "--mmproj",
            self.mmproj,
            "--host",
            "127.0.0.1",
            "--port",
            str(self.port),
            "-c",
            "2048",
        ]
        if device:
            args += ["--device", device]
        # Partial offload: let llama.cpp place as many layers as fit instead of
        # forcing every layer into VRAM (the old `-ngl 999` failed on cards that
        # cannot hold the whole model).
        args += offload_args(device, self.fit_target_mb)
        if self.threads:
            args += ["-t", str(self.threads)]
        log(f"llama.cpp: starting {os.path.basename(exe)} on 127.0.0.1:{self.port} ({device or 'default device'})")
        self._log = tempfile.NamedTemporaryFile(
            prefix="llama-server-", suffix=".log", delete=False, mode="w+", encoding="utf-8"
        )
        env = dict(os.environ)
        # The bundled runtime ships next to the exe; keep its DLLs reachable.
        env["PATH"] = os.path.dirname(exe) + os.pathsep + env.get("PATH", "")
        self.proc = subprocess.Popen(
            args,
            stdout=self._log,
            stderr=subprocess.STDOUT,
            cwd=os.path.dirname(exe),
            env=env,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self.proc.poll() is not None:
                tail = self._tail()
                # The process is gone: drop the log file and the handle instead
                # of leaking one temp file per failed start.
                self.stop()
                raise RuntimeError(f"توقّف محرّك llama.cpp أثناء التحميل:\n{tail}")
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{self.port}/health", timeout=2) as res:
                    if res.status == 200:
                        log("llama.cpp: server ready")
                        return
            except Exception:  # noqa: BLE001
                pass
            time.sleep(0.5)
        self.stop()
        raise RuntimeError("لم يستجب محرّك llama.cpp في الوقت المتوقع.")

    def _tail(self, lines: int = 20) -> str:
        try:
            name = self._log.name if self._log else ""
            if not name or not os.path.isfile(name):
                return ""
            with open(name, encoding="utf-8", errors="replace") as handle:
                return "".join(handle.readlines()[-lines:]).strip()
        except Exception:  # noqa: BLE001
            return ""

    def stop(self) -> None:
        if self.proc and self.proc.poll() is None:
            try:
                self.proc.terminate()
                self.proc.wait(timeout=10)
            except Exception:  # noqa: BLE001
                try:
                    self.proc.kill()
                    # Reap it so the process is really gone (and its VRAM
                    # released) before the caller continues.
                    self.proc.wait(timeout=10)
                except Exception:  # noqa: BLE001
                    pass
        self.proc = None
        if self._log:
            # Windows refuses to unlink an open file, and leaving the handle
            # open leaks a descriptor for every job.
            try:
                self._log.close()
            except Exception:  # noqa: BLE001
                pass
            try:
                os.unlink(self._log.name)
            except OSError:
                pass
            self._log = None

    def transcribe(
        self,
        wav_path: str,
        language: str = "",
        timeout: float = 300.0,
        prompt: str = CODE_SWITCH_PROMPT,
    ) -> str:
        if not self.proc or self.proc.poll() is not None:
            raise RuntimeError("محرّك llama.cpp غير مشغّل.")
        fields = {}
        if language and language != "auto":
            fields["language"] = language
        if prompt:
            # `prompt` becomes the system turn for Jais-ASR (the template reads
            # it as the mode switch), so this is what keeps foreign words in
            # their own script. Pass prompt="" to let the model decide.
            fields["prompt"] = prompt
        boundary, body = _multipart(fields, "file", wav_path, "audio/wav")
        request = urllib.request.Request(
            f"http://127.0.0.1:{self.port}/v1/audio/transcriptions",
            data=body,
            method="POST",
            headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout) as res:
                payload = json.loads(res.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")[:500]
            raise RuntimeError(f"رفض llama.cpp الطلب ({exc.code}): {detail}") from exc
        except OSError as exc:
            # HTTPError is handled above; anything else here means the request
            # never produced a response. When the server died (OOM on a small
            # card is the usual cause) the log tail says why.
            if self.proc is not None and self.proc.poll() is not None:
                raise RuntimeError(
                    f"توقّف محرّك llama.cpp أثناء التفريغ:\n{self._tail()}"
                ) from exc
            raise RuntimeError(f"تعذّر إكمال طلب llama.cpp: {exc}") from exc
        text = payload.get("text") if isinstance(payload, dict) else None
        return (text or "").strip()


def write_window(path: str, samples, sr: int) -> None:
    """16-bit mono WAV for the server (same rate as the pipeline)."""
    import numpy as np

    data = np.clip(np.asarray(samples, dtype="float32"), -1.0, 1.0)
    pcm = (data * 32767.0).astype("<i2")
    if pcm.size == 0:
        # llama.cpp rejects a 0-frame WAV with a bare 400, which reads like a model
        # problem; fail with something the UI can show instead.
        raise RuntimeError("نافذة صوتية فارغة: لا توجد عيّنات لتفريغها.")
    with wave.open(path, "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(sr)
        out.writeframes(pcm.tobytes())

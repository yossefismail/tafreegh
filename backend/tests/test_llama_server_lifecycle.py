"""LlamaServer lifecycle against a local stand-in for llama-server.

The real executable only ships in the packaged app, so these tests generate a
``.bat`` wrapper around ``tests/fake_llama_server.py`` and point
``TAFREEGH_LLAMA_SERVER`` at it. That still exercises the parts that broke in
production: readiness polling, the multipart request, error propagation and
process/log cleanup on stop.
"""

from __future__ import annotations

import os
import socket
import sys
import tempfile
import time

import pytest

from tafreegh import jais_gguf

FAKE_SERVER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fake_llama_server.py")
WINDOWS_ONLY = pytest.mark.skipif(sys.platform != "win32", reason=".bat launcher is Windows-only")


def _bat(tmp_path, body: str) -> str:
    path = tmp_path / "llama-server.exe.bat"
    path.write_text("@echo off\r\n" + body + "\r\n", encoding="ascii")
    return str(path)


def _gguf_pair(tmp_path) -> tuple[str, str]:
    model = tmp_path / jais_gguf.MODEL_FILE
    mmproj = tmp_path / jais_gguf.MMPROJ_FILE
    model.write_bytes(b"GGUF" + b"0" * 64)
    mmproj.write_bytes(b"GGUF" + b"0" * 64)
    return str(model), str(mmproj)


def _spy_temp_logs(monkeypatch) -> list[str]:
    """Record the temp log names LlamaServer creates so cleanup can be checked."""
    created: list[str] = []
    factory = tempfile.NamedTemporaryFile

    def spy(*args, **kwargs):
        handle = factory(*args, **kwargs)
        created.append(handle.name)
        return handle

    monkeypatch.setattr(jais_gguf.tempfile, "NamedTemporaryFile", spy)
    return created


def _port_is_free(port: int) -> bool:
    deadline = time.time() + 3
    while True:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            sock.bind(("127.0.0.1", port))
            return True
        except OSError:
            if time.time() > deadline:
                return False
            time.sleep(0.1)
        finally:
            sock.close()


def _remove_later(path: str) -> None:
    for _ in range(30):
        try:
            os.unlink(path)
            return
        except FileNotFoundError:
            return
        except OSError:
            time.sleep(0.1)


def _fake_process():
    class FakeProcess:
        def __init__(self) -> None:
            self.alive = True
            self.waited = 0.0

        def poll(self):
            return None if self.alive else 0

        def terminate(self) -> None:
            self.alive = False

        def wait(self, timeout=None):
            self.waited = timeout or 0
            return 0

    return FakeProcess()


@WINDOWS_ONLY
def test_llama_server_starts_transcribes_and_releases(tmp_path, monkeypatch):
    exe = _bat(tmp_path, f'"{sys.executable}" "{FAKE_SERVER}" %*')
    monkeypatch.setenv("TAFREEGH_LLAMA_SERVER", exe)
    monkeypatch.setenv("FAKE_READY_DELAY", "0.4")
    (tmp_path / "backend.txt").write_text("vulkan\n", encoding="utf-8")
    logs = _spy_temp_logs(monkeypatch)

    model, mmproj = _gguf_pair(tmp_path)
    wav = str(tmp_path / "window.wav")
    jais_gguf.write_window(wav, [0.0] * 16000, 16000)

    started = time.time()
    server = jais_gguf.LlamaServer(model, mmproj)
    try:
        server.start(timeout=30)
        assert server.proc is not None and server.proc.poll() is None
        assert server.port > 0
        # Readiness waits for /health, so a forced 0.4s delay must be honored.
        assert time.time() - started >= 0.4
        assert server.transcribe(wav, "EG") == "مرحبا بالعالم"
        # No language pin, but the code-switch system message still goes out.
        assert server.transcribe(wav, "auto") == "code-switch"
        # prompt="" is the opt-out: no language field and no system turn.
        assert server.transcribe(wav, "auto", prompt="") == "no-language"
    finally:
        port = server.port
        proc = server.proc
        server.stop()

    assert proc is not None and proc.poll() is not None
    # stop() must free the port along with the process handle.
    assert _port_is_free(port) is True
    assert server._log is None
    # Windows keeps the log locked until the .bat's python child notices its
    # launcher died, so the deletion itself is asserted in the unit test below;
    # this only tidies up the harness.
    for name in logs:
        _remove_later(name)


@WINDOWS_ONLY
def test_llama_server_startup_crash_reports_log_and_cleans_up(tmp_path, monkeypatch):
    exe = _bat(tmp_path, "echo llama-server: failed to load model 1>&2\r\nexit /b 1")
    monkeypatch.setenv("TAFREEGH_LLAMA_SERVER", exe)
    logs = _spy_temp_logs(monkeypatch)

    model, mmproj = _gguf_pair(tmp_path)
    server = jais_gguf.LlamaServer(model, mmproj)
    with pytest.raises(RuntimeError) as excinfo:
        server.start(timeout=20)

    message = str(excinfo.value)
    assert "llama.cpp" in message
    assert "failed to load model" in message, "the server log tail must reach the error"
    assert server.proc is None
    assert logs and not os.path.exists(logs[0]), "a crashed start must not leak its log"


@WINDOWS_ONLY
def test_llama_server_returns_no_device_for_unparseable_output(tmp_path):
    exe = _bat(tmp_path, "echo no devices here\r\nexit /b 0")
    assert jais_gguf._pick_device(exe) is None


def test_transcribe_surfaces_the_server_log_when_it_crashes(tmp_path, monkeypatch):
    """A llama-server OOM during transcription must not surface as a bare
    ConnectionResetError: the job error should carry the server's last words."""
    server = jais_gguf.LlamaServer("model.gguf", "mmproj.gguf")
    server.proc = _fake_process()
    server.port = 1
    handle = tempfile.NamedTemporaryFile(
        prefix="llama-server-", suffix=".log", delete=False, mode="w+", encoding="utf-8"
    )
    handle.write("ggml: CUDA error: out of memory\n")
    handle.flush()
    server._log = handle

    def boom(request, timeout=None):
        server.proc.terminate()
        raise ConnectionResetError("connection reset by peer")

    monkeypatch.setattr(jais_gguf.urllib.request, "urlopen", boom)
    wav = tmp_path / "window.wav"
    jais_gguf.write_window(str(wav), [0.0] * 16, 16000)

    with pytest.raises(RuntimeError) as excinfo:
        server.transcribe(str(wav), "EG")

    message = str(excinfo.value)
    assert "llama.cpp" in message
    assert "CUDA error: out of memory" in message
    server.stop()
    assert not os.path.exists(handle.name)


def test_stop_closes_and_removes_the_server_log():
    """Regression: the handle stayed open, so Windows refused the unlink and
    every job leaked a `llama-server-*.log` plus one descriptor."""
    handle = tempfile.NamedTemporaryFile(
        prefix="llama-server-", suffix=".log", delete=False, mode="w+", encoding="utf-8"
    )
    server = jais_gguf.LlamaServer("model.gguf", "mmproj.gguf")
    server.proc = _fake_process()
    server._log = handle

    server.stop()

    assert server.proc is None
    assert server._log is None
    assert handle.closed is True
    assert not os.path.exists(handle.name)

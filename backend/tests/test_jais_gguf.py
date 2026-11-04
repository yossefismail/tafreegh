"""tafreegh.jais_gguf helpers that do not start llama-server."""

from __future__ import annotations

from pathlib import Path

from tafreegh import jais_gguf


def test_gguf_files_prefers_the_documented_pair(tmp_path):
    (tmp_path / "Jais-ASR-Q4_K_M.gguf").write_bytes(b"x")
    (tmp_path / "mmproj-Jais-ASR-Q6_K.gguf").write_bytes(b"x")

    assert jais_gguf.gguf_files(str(tmp_path)) == (
        str(tmp_path / "Jais-ASR-Q4_K_M.gguf"),
        str(tmp_path / "mmproj-Jais-ASR-Q6_K.gguf"),
    )


def test_gguf_files_accepts_other_quantizations(tmp_path):
    (tmp_path / "Jais-ASR-Q8_0.gguf").write_bytes(b"x")
    (tmp_path / "mmproj-Jais-ASR-F16.gguf").write_bytes(b"x")

    model, mmproj = jais_gguf.gguf_files(str(tmp_path))
    assert model.endswith("Jais-ASR-Q8_0.gguf")
    assert mmproj.endswith("mmproj-Jais-ASR-F16.gguf")


def test_gguf_files_requires_both_halves(tmp_path):
    (tmp_path / "Jais-ASR-Q4_K_M.gguf").write_bytes(b"x")
    assert jais_gguf.gguf_files(str(tmp_path)) is None

    (tmp_path / "mmproj-Jais-ASR-Q6_K.gguf").write_bytes(b"x")
    assert jais_gguf.gguf_files(str(tmp_path)) is not None


def test_gguf_files_missing_directory(tmp_path):
    assert jais_gguf.gguf_files(str(tmp_path / "nope")) is None


def test_server_executable_honors_environment(tmp_path, monkeypatch):
    exe = tmp_path / "llama-server.exe"
    exe.write_bytes(b"x")
    monkeypatch.setenv("TAFREEGH_LLAMA_SERVER", str(exe))
    assert jais_gguf.server_executable() == str(exe)


def test_server_executable_absent_from_environment(monkeypatch, tmp_path):
    monkeypatch.setenv("TAFREEGH_LLAMA_SERVER", str(tmp_path / "nope.exe"))
    monkeypatch.setenv("TAFREEGH_LLAMA_DIR", str(tmp_path))
    # No executable anywhere: the result is either nothing or a real file.
    assert jais_gguf.server_executable() is None or Path(
        jais_gguf.server_executable()
    ).exists()


def test_write_window_produces_16_bit_mono(tmp_path):
    import wave

    import numpy as np

    path = tmp_path / "window.wav"
    jais_gguf.write_window(str(path), np.zeros(1600, dtype="float32"), 16000)
    with wave.open(str(path), "rb") as handle:
        assert handle.getnchannels() == 1
        assert handle.getsampwidth() == 2
        assert handle.getframerate() == 16000
        assert handle.getnframes() == 1600


def test_multipart_body_carries_language_and_file(tmp_path):
    wav = tmp_path / "clip.wav"
    wav.write_bytes(b"RIFF0000")
    boundary, body = jais_gguf._multipart({"language": "EG"}, "file", str(wav), "audio/wav")
    assert boundary.encode() in body
    assert b'name="language"' in body and b"EG" in body
    assert b'name="file"' in body and b"RIFF0000" in body


def test_backend_marker_controls_gpu_gating(tmp_path, monkeypatch):
    exe = tmp_path / "llama-server.exe"
    exe.write_bytes(b"x")
    monkeypatch.setenv("TAFREEGH_LLAMA_SERVER", str(exe))

    (tmp_path / "backend.txt").write_text("cpu\n", encoding="utf-8")
    assert jais_gguf.backend() == "cpu"
    assert jais_gguf.gpu_available() is False

    (tmp_path / "backend.txt").write_text("vulkan\n", encoding="utf-8")
    assert jais_gguf.backend() == "vulkan"
    assert jais_gguf.gpu_available() is True

    (tmp_path / "backend.txt").unlink()
    (tmp_path / "ggml-cuda.dll").write_bytes(b"x")
    assert jais_gguf.backend() == "cuda"
    assert jais_gguf.gpu_available() is True

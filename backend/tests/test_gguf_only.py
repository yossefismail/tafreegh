"""GGUF-only contract for the Python backend.

Tafreegh loads Jais-ASR exclusively through the bundled llama.cpp server, so the
backend must not grow a transformers / bitsandbytes model-loading path again.
These tests pin the artifact catalog, the VRAM-based choice, and the absence of
the old stack in the source tree.
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

import pytest

from tafreegh import pipeline

BACKEND = Path(__file__).resolve().parents[1]

# Anything that only made sense for the safetensors era.
REMOVED_STACK = (
    "transformers",
    "bitsandbytes",
    "compressed_tensors",
    "compressed-tensors",
    "accelerate",
    "safetensors",
    "sentencepiece",
)


# ------------------------------------------------------------------ catalog
def test_catalog_is_gguf_only():
    assert set(pipeline.JAIS_VARIANTS) == {"gguf", "gguf-q8"}


def test_catalog_describes_the_gguf_pairs():
    q4 = pipeline.JAIS_VARIANTS["gguf"]
    q8 = pipeline.JAIS_VARIANTS["gguf-q8"]

    # Sizes and filenames checked against the HF API on 2026-11-03.
    for spec in (q4, q8):
        assert spec["repo"] == "IFM/Jais-ASR-GGUF"
        assert spec["bytes"] > 1_000_000_000
        assert 0 < spec["wer"] < 30

    assert "Q4_K_M" in q4["label"]
    assert 3.5e9 < q4["bytes"] < 3.9e9
    assert q4["files"] == ["Jais-ASR-Q4_K_M.gguf", "mmproj-Jais-ASR-Q6_K.gguf"]

    assert "Q8_0" in q8["label"]
    assert 6.5e9 < q8["bytes"] < 6.9e9
    assert q8["files"] == ["Jais-ASR-Q8_0.gguf", "mmproj-Jais-ASR-F16.gguf"]


# ---------------------------------------------------------------- selection
@pytest.mark.parametrize(
    ("vram_gb", "expected"),
    [
        (0, "gguf"),
        (6, "gguf"),
        (8.9, "gguf"),
        (9, "gguf-q8"),
        (12, "gguf-q8"),
        (24, "gguf-q8"),
    ],
)
def test_select_jais_variant_uses_vram(monkeypatch, vram_gb, expected):
    monkeypatch.delenv("TAFREEGH_JAIS_VARIANT", raising=False)
    assert pipeline.select_jais_variant({"cuda": True, "vramGb": vram_gb}) == expected


def test_select_jais_variant_defaults_to_gguf_without_a_gpu(monkeypatch):
    monkeypatch.delenv("TAFREEGH_JAIS_VARIANT", raising=False)
    assert pipeline.select_jais_variant({"cuda": False, "vramGb": 0}) == "gguf"
    assert pipeline.select_jais_variant({}) == "gguf"


def test_select_jais_variant_honors_a_known_env_value(monkeypatch):
    monkeypatch.setenv("TAFREEGH_JAIS_VARIANT", "gguf-q8")
    assert pipeline.select_jais_variant({"cuda": True, "vramGb": 6}) == "gguf-q8"

    monkeypatch.setenv("TAFREEGH_JAIS_VARIANT", "gguf")
    assert pipeline.select_jais_variant({"cuda": True, "vramGb": 24}) == "gguf"


@pytest.mark.parametrize("junk", ["awq", "fp8", "bf16", "not-a-variant", ""])
def test_select_jais_variant_ignores_unknown_env_values(monkeypatch, junk):
    monkeypatch.setenv("TAFREEGH_JAIS_VARIANT", junk)
    assert pipeline.select_jais_variant({"cuda": True, "vramGb": 24}) == "gguf-q8"
    assert pipeline.select_jais_variant({"cuda": True, "vramGb": 6}) == "gguf"


# ------------------------------------------------------- no safetensors path
IMPORT_RE = re.compile(
    r"^\s*(?:from|import)\s+(" + "|".join(re.escape(name) for name in REMOVED_STACK) + r")\b",
    re.MULTILINE,
)


def _python_sources() -> list[Path]:
    return [
        path
        for path in BACKEND.rglob("*.py")
        if "__pycache__" not in path.parts and ".pytest_cache" not in path.parts
    ]


def test_no_module_imports_the_removed_stack():
    offenders = []
    for path in _python_sources():
        text = path.read_text(encoding="utf-8")
        for match in IMPORT_RE.finditer(text):
            offenders.append(f"{path.relative_to(BACKEND)}: {match.group(0).strip()}")
    assert offenders == [], f"removed stack still imported: {offenders}"


def test_backend_imports_with_the_removed_stack_blocked():
    """`import tafreegh.pipeline` must work when none of those packages exist."""
    script = """
import sys

sys.path.insert(0, sys.argv[1])

BLOCKED = set(sys.argv[2].split(","))


class Blocker:
    def find_spec(self, name, path=None, target=None):
        root = name.split(".")[0]
        if root in BLOCKED:
            raise ImportError(f"{root} is blocked: Tafreegh backend is GGUF-only")
        return None


sys.meta_path.insert(0, Blocker())

import worker
from tafreegh import jais_gguf, pipeline, render, setup_models

# `worker` points fd 1 at stderr on import; report on stderr on purpose.
sys.stderr.write("VARIANTS=" + ",".join(sorted(pipeline.JAIS_VARIANTS)))
"""
    proc = subprocess.run(
        [
            sys.executable,
            "-c",
            script,
            str(BACKEND),
            ",".join(name.replace("-", "_") for name in REMOVED_STACK),
        ],
        cwd=str(BACKEND),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=120,
    )

    assert proc.returncode == 0, proc.stderr[-3000:]
    assert "VARIANTS=gguf,gguf-q8" in proc.stderr


def test_requirements_do_not_reinstall_the_removed_stack():
    lines = (BACKEND / "requirements.txt").read_text(encoding="utf-8").splitlines()
    packages = {
        re.split(r"[<>=!~\[ ;]", line.strip(), maxsplit=1)[0].lower()
        for line in lines
        if line.strip() and not line.strip().startswith("#")
    }

    assert packages, "requirements.txt is empty"
    assert not (packages & {name.replace("-", "_") for name in REMOVED_STACK})
    # The runtime is torch-free now, so requirements must never pull it back in.
    assert not (packages & {"torch"}), "torch is not part of the app runtime"


def test_backend_sources_stay_torch_free():
    sources = [*(BACKEND / "tafreegh").glob("*.py"), BACKEND / "worker.py"]
    offenders: list[str] = []
    for path in sources:
        text = path.read_text(encoding="utf-8")
        if re.search(r"^\s*(?:import|from)\s+torch\b", text, re.MULTILINE):
            offenders.append(f"{path.name}: imports torch")
        for needle in ("resemble_enhance", "RESEMBLE_", "TAFREEGH_RESEMBLE_DIR"):
            if needle in text:
                offenders.append(f"{path.name}: {needle}")
    assert not offenders, offenders

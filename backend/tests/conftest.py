"""Shared fixtures for the Tafreegh backend tests.

The tests shell out to the real worker with Python 3.12 (the interpreter the
Electron app ships against) so the JSONL contract and the rendered artifacts
are exercised end-to-end. When 3.12 is not installed the tests skip instead of
failing, and only the stdlib + pytest are required.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1]

# Let the pure-helper tests import tafreegh.* without extra setup.
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))


def _candidate_launchers() -> list[list[str]]:
    launchers: list[list[str]] = []
    py = shutil.which("py") or shutil.which("py.exe")
    if py:
        launchers.append([py, "-3.12"])
    for name in ("python3.12", "python3.12.exe"):
        exe = shutil.which(name)
        if exe:
            launchers.append([exe])
    return launchers


def _is_py312(cmd: list[str]) -> bool:
    try:
        proc = subprocess.run(
            cmd + ["-c", "import json,sys;print(json.dumps(sys.version_info[:2]))"],
            capture_output=True,
            text=True,
            timeout=60,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    if proc.returncode != 0:
        return False
    try:
        return tuple(json.loads(proc.stdout.strip())) == (3, 12)
    except (ValueError, TypeError):
        return False


def find_py312() -> list[str] | None:
    for cmd in _candidate_launchers():
        if _is_py312(cmd):
            return cmd
    return None


def worker_env(mock: bool = True) -> dict:
    env = os.environ.copy()
    # Never let an inherited mock flag leak into a real test.
    env.pop("TAFREEGH_MOCK", None)
    if mock:
        env["TAFREEGH_MOCK"] = "1"
    env["PYTHONUNBUFFERED"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    existing = env.get("PYTHONPATH", "")
    parts = [str(BACKEND)]
    if existing:
        parts.append(existing)
    env["PYTHONPATH"] = os.pathsep.join(parts)
    return env


def run_worker(py312: list[str], *args: str, timeout: int = 600) -> subprocess.CompletedProcess:
    """Run backend/worker.py with cwd=backend and mock mode enabled."""
    return subprocess.run(
        [*py312, str(BACKEND / "worker.py"), *args],
        cwd=str(BACKEND),
        env=worker_env(mock=True),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
    )


def parse_jsonl(stdout: str) -> list[dict]:
    """Parse stdout as JSON Lines, failing loudly on any non-JSON line."""
    events: list[dict] = []
    for number, line in enumerate(stdout.splitlines(), 1):
        if not line.strip():
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError as exc:  # pragma: no cover - failure path
            raise AssertionError(f"stdout line {number} is not JSON: {line[:200]!r} ({exc})") from exc
        if not isinstance(event, dict):
            raise AssertionError(f"stdout line {number} is not a JSON object: {line[:200]!r}")
        events.append(event)
    return events


@pytest.fixture(scope="session")
def py312() -> list[str]:
    cmd = find_py312()
    if cmd is None:
        pytest.skip("Python 3.12 (py -3.12) is not available on this machine")
    return cmd


@pytest.fixture(scope="session")
def run(py312):
    def _run(*args: str, timeout: int = 600) -> subprocess.CompletedProcess:
        return run_worker(py312, *args, timeout=timeout)

    return _run


@pytest.fixture(scope="session")
def mock_job(run, tmp_path_factory) -> dict:
    """One real ``worker.py run`` in mock mode, shared by the tests in a session."""
    job_dir = tmp_path_factory.mktemp("mock-job")
    input_path = job_dir / "sample.m4a"
    input_path.write_bytes(b"\x00" * 32)  # mock mode never decodes the input

    proc = run(
        "run",
        "--input",
        str(input_path),
        "--job-dir",
        str(job_dir),
        "--display-name",
        "اجتماع فريق المنتج",
        "--language",
        "EG",
        timeout=900,
    )
    if proc.returncode != 0:
        raise AssertionError(
            f"worker.py run failed with {proc.returncode}\n"
            f"stdout:\n{proc.stdout[-4000:]}\nstderr:\n{proc.stderr[-4000:]}"
        )
    return {
        "dir": job_dir,
        "proc": proc,
        "events": parse_jsonl(proc.stdout),
    }

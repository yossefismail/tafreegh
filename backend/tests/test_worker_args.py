"""worker.py argument contract.

The app once shipped with a hard-coded variant list, so `--variant gguf` (the
artifact small cards need) died with "argument --variant: invalid choice".
These tests pin the parser to the pipeline catalog so the two lists can never
drift again.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys

from conftest import BACKEND
from tafreegh import pipeline

CHOICES_PROBE = r"""
import sys

sys.path.insert(0, sys.argv[1])

import worker
from tafreegh import pipeline

parser = worker.build_parser()
bad = []
for command in ("setup-models", "setup-jais"):
    for variant in pipeline.JAIS_VARIANTS:
        try:
            args = parser.parse_args(
                [command, "--models-dir", "unused", "--variant", variant]
            )
        except SystemExit:
            bad.append(f"{command}:{variant}")
            continue
        if args.variant != variant:
            bad.append(f"{command}:{variant}->{args.variant}")
worker.send({"type": "test", "bad": bad, "variants": list(pipeline.JAIS_VARIANTS)})
"""


def _worker(*args: str, timeout: int = 120) -> subprocess.CompletedProcess:
    env = os.environ.copy()
    env.pop("TAFREEGH_MOCK", None)
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUNBUFFERED"] = "1"
    return subprocess.run(
        [sys.executable, *args],
        cwd=str(BACKEND),
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
    )


def test_every_variant_is_accepted_by_setup_commands():
    proc = _worker("-c", CHOICES_PROBE, str(BACKEND))
    assert proc.returncode == 0, proc.stderr[-2000:]

    lines = [line for line in proc.stdout.splitlines() if line.strip()]
    assert len(lines) == 1, f"expected one JSON event, got: {proc.stdout!r}"
    event = json.loads(lines[0])

    assert event["variants"] == list(pipeline.JAIS_VARIANTS)
    assert set(event["variants"]) == {"gguf", "gguf-q8"}
    assert event["bad"] == [], f"parser rejects catalog variants: {event['bad']}"


SYSTEM_EXIT_PROBE = r"""
import sys

sys.path.insert(0, sys.argv[1])

import worker


def boom(args):
    sys.exit("vendored script said no")


worker.cmd_probe = boom
raise SystemExit(worker.main(["probe"]))
"""


def test_system_exit_is_reported_as_an_error_event():
    """`sys.exit()` inside a vendored script must not kill the JSONL channel.

    Regression: the process left exit code 1 and zero events, so the app could
    only show "the assistant failed (1) without details".
    """
    proc = _worker("-c", SYSTEM_EXIT_PROBE, str(BACKEND))

    assert proc.returncode == 1
    events = [json.loads(line) for line in proc.stdout.splitlines() if line.strip()]
    assert events, "SystemExit produced no event at all"
    assert events[-1]["type"] == "error"
    assert events[-1]["errorType"] == "SystemExit"
    assert "vendored script said no" in events[-1]["message"]
    assert events[-1]["traceback"]


def test_run_rejects_negative_max_seconds_before_side_effects(tmp_path):
    job_dir = tmp_path / "job"

    proc = _worker(
        str(BACKEND / "worker.py"),
        "run",
        "--input",
        str(tmp_path / "sample.m4a"),
        "--job-dir",
        str(job_dir),
        "--max-seconds",
        "-5",
    )

    assert proc.returncode == 2
    assert "max-seconds" in proc.stderr
    # Nothing ran: no JSONL event, no job folder.
    assert proc.stdout.strip() == ""
    assert not job_dir.exists()


def test_run_no_longer_accepts_the_removed_quant_flag(tmp_path):
    """Precision comes from the GGUF variant; there is no bitsandbytes level."""
    job_dir = tmp_path / "job"

    proc = _worker(
        str(BACKEND / "worker.py"),
        "run",
        "--input",
        str(tmp_path / "sample.m4a"),
        "--job-dir",
        str(job_dir),
        "--quant",
        "4bit",
    )

    assert proc.returncode == 2
    assert "--quant" in proc.stderr
    assert proc.stdout.strip() == ""
    assert not job_dir.exists()

"""The worker's JSONL contract and mock-mode artifacts."""

from __future__ import annotations

import json
from pathlib import Path

from conftest import parse_jsonl


def test_mock_run_emits_only_json_lines(mock_job):
    proc = mock_job["proc"]
    lines = [line for line in proc.stdout.splitlines() if line.strip()]

    assert lines, "worker produced no events on stdout"
    assert proc.stdout.startswith("{"), "stdout must begin with a JSON object"
    for line in lines:
        assert line.lstrip().startswith("{"), f"free text on the JSONL channel: {line[:160]!r}"


def test_mock_run_event_stream_is_well_formed(mock_job):
    events = mock_job["events"]

    # Re-parsing proves the stream is valid JSON Lines, not just line-ish text.
    assert parse_jsonl(mock_job["proc"].stdout) == events

    types = [event.get("type") for event in events]
    assert "progress" in types
    assert "error" not in types

    progress = [event for event in events if event["type"] == "progress"]
    for event in progress:
        assert 0.0 <= float(event["overall"]) <= 100.0
        assert 0.0 <= float(event["stageFraction"]) <= 1.0
        assert isinstance(event["stage"], str) and event["stage"]

    # Progress must be non-decreasing: the Electron progress bar relies on it.
    overalls = [float(event["overall"]) for event in progress]
    assert overalls == sorted(overalls)


def test_mock_run_final_event_is_done(mock_job):
    events = mock_job["events"]

    assert events[-1]["type"] == "done"
    assert events[-1]["elapsed"] >= 0
    assert [event["type"] for event in events].count("done") == 1


def test_mock_run_writes_artifacts(mock_job):
    job_dir = mock_job["dir"]
    result = mock_job["events"][-1]["result"]

    for name in ("transcript.html", "transcript.txt", "transcript.json"):
        artifact = job_dir / name
        assert artifact.is_file(), f"{name} was not written to the job dir"
        assert artifact.stat().st_size > 0, f"{name} is empty"

    for key, suffix in (("html", "transcript.html"), ("txt", "transcript.txt"), ("json", "transcript.json")):
        assert key in result, f"done event is missing {key!r}"
        assert result[key].endswith(suffix)
        assert (job_dir / suffix).resolve() == Path(result[key]).resolve()

    assert result["speakers"], "mock output must include speaker labels"
    assert result["duration"] > 0
    assert result["windows"] == 8


def test_mock_run_transcript_json_shape(mock_job):
    job_dir = mock_job["dir"]
    data = json.loads((job_dir / "transcript.json").read_text(encoding="utf-8"))

    assert data["lines"], "transcript.json has no lines"
    assert len(data["lines"]) == 8  # MOCK_LINES
    assert data["duration"] > 0
    for line in data["lines"]:
        assert line["end"] >= line["start"]
        assert line["text"].strip()
        assert line["speaker"]

    html = (job_dir / "transcript.html").read_text(encoding="utf-8")
    assert "<main" in html

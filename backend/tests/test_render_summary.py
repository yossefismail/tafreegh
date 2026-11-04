"""`worker.py render` must put the summary before <main> and keep the theme."""

from __future__ import annotations

import shutil

import pytest

from conftest import parse_jsonl

SUMMARY_MARKDOWN = """## ملخص الاجتماع

- تجربة المستخدم الجديدة قبل نهاية الشهر.
- تقرير أسبوعي عن البنية السحابية.
"""


@pytest.fixture(scope="session")
def rendered(run, mock_job, tmp_path_factory) -> dict:
    """Render the shared mock job with a summary file into a fresh job dir."""
    job_dir = tmp_path_factory.mktemp("render-job")
    for name in ("transcript.html", "transcript.txt", "transcript.json"):
        shutil.copy2(mock_job["dir"] / name, job_dir / name)

    summary = job_dir / "summary.md"
    summary.write_text(SUMMARY_MARKDOWN, encoding="utf-8")

    proc = run(
        "render",
        "--job-dir",
        str(job_dir),
        "--summary",
        str(summary),
        timeout=300,
    )
    if proc.returncode != 0:
        raise AssertionError(
            f"worker.py render failed with {proc.returncode}\n"
            f"stdout:\n{proc.stdout[-4000:]}\nstderr:\n{proc.stderr[-4000:]}"
        )
    return {
        "dir": job_dir,
        "events": parse_jsonl(proc.stdout),
        "html": (job_dir / "transcript.html").read_text(encoding="utf-8"),
    }


def test_render_finishes_with_done(rendered):
    assert rendered["events"][-1]["type"] == "done"
    assert rendered["events"][-1]["result"]["summary"] is not None


def test_render_summary_section_exists_once(rendered):
    html = rendered["html"]
    marker = '<section class="summary" id="recording-summary"'
    assert marker in html
    assert html.count('id="recording-summary"') == 1


def test_render_summary_precedes_main(rendered):
    html = rendered["html"]
    summary_at = html.index('<section class="summary" id="recording-summary"')
    main_at = html.index("<main")

    assert summary_at < main_at, "summary section must appear before <main> (summary-first ordering)"
    # The summary content must travel with the section.
    assert "ملخص الاجتماع" in html
    assert html.index("ملخص الاجتماع") < main_at


def test_render_keeps_drafting_sheet_theme(rendered):
    html = rendered["html"]

    assert 'id="ui-theme"' in html
    assert "ui-player-js" in html
    assert "titleblock" in html


def test_render_is_repeatable_when_a_summary_is_retried(rendered, run, tmp_path):
    """`jobs:retry-summary` renders an already themed job a second time.

    Regression: add_summary required the literal `<script>` anchor, which the
    first render had already renamed to `<script id="ui-player-js">`, so the
    retry died with exit code 1 and no error event (summary never updated).
    """
    job_dir = tmp_path / "retry"
    job_dir.mkdir()
    for name in ("transcript.html", "transcript.txt", "transcript.json"):
        shutil.copy2(rendered["dir"] / name, job_dir / name)
    summary = job_dir / "summary.md"
    summary.write_text("## ملخص محدّث\n\n- نقطة جديدة.\n", encoding="utf-8")

    proc = run("render", "--job-dir", str(job_dir), "--summary", str(summary), timeout=300)
    assert proc.returncode == 0, (
        f"re-render failed with {proc.returncode}\n"
        f"stdout:\n{proc.stdout[-2000:]}\nstderr:\n{proc.stderr[-2000:]}"
    )
    assert parse_jsonl(proc.stdout)[-1]["type"] == "done"

    html = (job_dir / "transcript.html").read_text(encoding="utf-8")
    assert html.count('id="recording-summary"') == 1
    section = html[html.index('id="recording-summary"') :]
    section = section[: section.index("</section>")]
    assert "ملخص محدّث" in section
    assert "ملخص الاجتماع" not in section, "the previous summary must be replaced"
    assert html.count('id="ui-player-js"') == 1
    assert html.count('id="ui-theme"') == 1


"""Render the final self-contained HTML and TXT for a finished job.

This reuses the audited `add_summary.py` and `apply_ui.py` scripts from the
arabic-transcribe skill (copied under backend/skill_scripts) so the delivered
file is byte-identical in behaviour to the skill's output.
"""

from __future__ import annotations

import json
import os
import re
import sys
from types import SimpleNamespace

from . import pipeline

HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND = os.path.dirname(HERE)
SKILL_SCRIPTS = os.path.join(BACKEND, "skill_scripts")
if SKILL_SCRIPTS not in sys.path:
    sys.path.insert(0, SKILL_SCRIPTS)

import add_summary  # noqa: E402
import apply_ui  # noqa: E402


def _moments_from_transcript(transcript: dict, max_moments: int = 8) -> list[dict]:
    lines = [ln for ln in transcript.get("lines", []) if ln.get("text")]
    if not lines:
        return []
    duration = max(1.0, float(transcript.get("duration") or 1))
    count = min(max_moments, max(2, int(duration // 180) + 2), len(lines))
    step = max(1, len(lines) // count)
    moments = []
    for line in lines[::step][:count]:
        text = line["text"].strip()
        label = " ".join(text.split()[:6])
        if len(text) > 60:
            label += "…"
        moments.append({"t": round(float(line["start"]), 2), "label": label})
    return moments


def _normalize_moments(raw) -> list[dict]:
    out = []
    for item in raw or []:
        if not isinstance(item, dict):
            continue
        try:
            t = item.get("t")
            if isinstance(t, str) and ":" in t:
                t = apply_ui.sec_of(t)
            out.append({"t": float(t), "label": str(item.get("label") or "").strip()})
        except Exception:  # noqa: BLE001
            continue
    out.sort(key=lambda m: m["t"])
    return [m for m in out if m["label"]]


def _move_summary_to_top(html_path: str) -> None:
    """Default reading order: summary first, then the transcript index.

    add_summary.py appends the summary after </main>. apply_ui.py renders the
    section numbers from the summary's position, so moving the whole section
    (its checkbox script travels with it) before <main> gives
    01 Recording / 02 Summary / 03 Transcription.
    """
    with open(html_path, encoding="utf-8") as f:
        html = f.read()
    match = re.search(
        r'<section class="summary" id="recording-summary"[^>]*>.*?</section>',
        html,
        re.S,
    )
    if not match:
        return
    section = match.group(0)
    html = html[: match.start()] + html[match.end() :]
    main_at = html.find("<main>")
    if main_at == -1:
        return
    html = html[:main_at] + section + "\n" + html[main_at:]
    with open(html_path, "w", encoding="utf-8") as f:
        f.write(html)


def render(
    job_dir: str,
    summary_path: str | None,
    title: str,
    kicker: str,
    note: str,
    project: str,
    date: str,
    model: str,
    heading: str,
    end: str | None,
    moments: list | None = None,
    no_fonts: bool = False,
    speaker_names: dict | None = None,
) -> dict:
    html_path = os.path.join(job_dir, "transcript.html")
    txt_path = os.path.join(job_dir, "transcript.txt")
    if not os.path.exists(html_path):
        raise RuntimeError("transcript.html is missing; run the transcription stage first")
    # A page written before the direction fix keeps `dir="auto"` on every
    # window, which flips any window that opens with an English word. Rewrite
    # the attributes in place so an existing recording renders correctly too.
    if pipeline.repair_bidi(html_path):
        pipeline.log("repaired mixed-direction markup from an older build")

    summary_md = ""
    if summary_path and os.path.isfile(summary_path):
        with open(summary_path, encoding="utf-8-sig") as f:
            summary_md = f.read().strip()
    if summary_md:
        pipeline.progress("artifacts", 0.25, "إضافة الملخص إلى صفحة التفريغ…", True)
        try:
            add_summary.inject_html(html_path, summary_md)
        except SystemExit as exc:  # add_summary.die() exits
            raise RuntimeError(f"summary injection failed: {exc}") from exc
        _move_summary_to_top(html_path)
        if os.path.exists(txt_path):
            add_summary.inject_txt(txt_path, summary_md)

    if not moments:
        tpath = os.path.join(job_dir, "transcript.json")
        if os.path.exists(tpath):
            with open(tpath, encoding="utf-8") as f:
                moments = _moments_from_transcript(json.load(f))
    moments = _normalize_moments(moments)

    opts = SimpleNamespace(
        title=title,
        kicker=kicker,
        note=note,
        project=project,
        date=date,
        model=model,
        heading=heading,
        end=end,
        moments=moments or None,
        summary=summary_path if summary_md else None,
        no_fonts=no_fonts,
        speaker_names=speaker_names or None,
    )
    pipeline.progress("artifacts", 0.6, "تطبيق واجهة ورقة الرسم…", True)
    try:
        apply_ui.apply(html_path, opts)
    except SystemExit as exc:  # apply_ui.die() exits
        raise RuntimeError(f"UI theme failed: {exc}") from exc

    pipeline.progress("artifacts", 1.0, "اكتملت الصفحة")
    return {
        "html": html_path,
        "txt": txt_path,
        "summary": summary_path if summary_md else None,
        "moments": len(moments),
    }

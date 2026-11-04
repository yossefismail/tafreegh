"""Speaker strip: colours, editable names and their round-trip through the page."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1]
SCRIPTS = BACKEND / "skill_scripts"
for path in (str(BACKEND), str(SCRIPTS)):
    if path not in sys.path:
        sys.path.insert(0, path)

from tafreegh import pipeline  # noqa: E402

apply_ui = pytest.importorskip("apply_ui")


MINIMAL_PLAYER = """<!DOCTYPE html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>تسجيل — تفريغ</title></head>
<body>
<div class="player"><audio id="au" src="data:audio/mp4;base64,AA=="></audio></div>
<div class="hdr"><h1>تسجيل</h1><div class="sub">الكلام 00:00-00:30</div></div>
<div class="legend" dir="rtl">ألوان المتحدثين: <span class="dot"></span>Speaker A <span class="dot"></span>Speaker B</div>
<main>
<div class="win"><div class="meta" dir="ltr">[00:00 – 00:30]</div>
<p class="txt" dir="rtl"><span class="chunk sA" data-start="0.00" data-end="15.00">مرحبا </span><span class="chunk sB" data-start="15.00" data-end="30.00">أهلا </span></p></div>
</main>
<script>
const au = document.getElementById('au');
</script>
</body></html>
"""


def _apply(tmp_path: Path, names: dict | None) -> tuple[str, dict, list]:
    page = tmp_path / "transcript.html"
    page.write_text(MINIMAL_PLAYER, encoding="utf-8")
    opts = apply_ui.argparse.Namespace(
        title="تسجيل",
        kicker=None,
        note=None,
        project=None,
        date=None,
        model=None,
        heading=None,
        end=None,
        moments=None,
        summary=None,
        no_fonts=True,
        speaker_names=names,
    )
    info, moments = apply_ui.apply(str(page), opts)
    return page.read_text(encoding="utf-8"), info, moments


def test_palette_is_shared_with_the_pipeline():
    assert apply_ui.PALETTE == pipeline.SPEAKER_COLORS
    assert len(set(apply_ui.PALETTE.values())) == 8


def test_strip_lives_inside_the_player(tmp_path):
    html, info, _ = _apply(tmp_path, None)
    start = html.index('<section class="playerbar"')
    end = html.index("</section>", start)
    player = html[start:end]
    assert 'class="pb-speakers"' in player
    assert player.count('data-spk="') == 2
    assert info["speakers"] == ["A", "B"]


def test_names_are_rendered_and_embedded(tmp_path):
    html, _, _ = _apply(tmp_path, {"A": "د. سارة"})
    assert 'data-spk="A"' in html
    assert "د. سارة" in html
    block = html.split('id="ui-speaker-names">', 1)[1].split("</script>", 1)[0]
    assert json.loads(block.replace("<\\/", "</")) == {"A": "د. سارة"}


def test_render_without_names_keeps_the_stored_ones(tmp_path):
    html, _, _ = _apply(tmp_path, {"B": "أحمد"})
    page = tmp_path / "transcript.html"
    page.write_text(html, encoding="utf-8")

    opts = apply_ui.argparse.Namespace(
        title="تسجيل",
        kicker=None,
        note=None,
        project=None,
        date=None,
        model=None,
        heading=None,
        end=None,
        moments=None,
        summary=None,
        no_fonts=True,
        speaker_names=None,
    )
    apply_ui.apply(str(page), opts)
    again = page.read_text(encoding="utf-8")
    assert "أحمد" in again
    block = again.split('id="ui-speaker-names">', 1)[1].split("</script>", 1)[0]
    assert json.loads(block.replace("<\\/", "</")) == {"B": "أحمد"}


def test_chips_are_keyboard_reachable_and_truncate_one_line(tmp_path):
    html, _, _ = _apply(tmp_path, None)
    assert 'role="button" tabindex="0"' in html
    # A chip never wraps: the label truncates and the strip reflows instead.
    css = html.split("<style", 1)[1]
    assert ".spk__name{" in css
    assert "white-space:nowrap" in css
    assert "flex-wrap:wrap" in css

"""Mixed Arabic/English text keeps its direction and its structure.

`dir="auto"` follows the first strong character, so a window that starts with
"okay." flipped a whole Arabic paragraph to LTR, and a summary card that was
`dir="auto"` computed LTR in Chrome (its direct text nodes are whitespace),
which sent every checkbox to the far side of the card. Direction is now decided
per block, containers stay RTL, and anything that must not reorder (clock
ranges, English clauses) is isolated.
"""

from __future__ import annotations

import pytest

from tafreegh import pipeline, render

add_summary = render.add_summary


# --------------------------------------------------------------- base_dir
def test_base_dir_keeps_arabic_first_lines_rtl():
    assert pipeline.base_dir("okay. الفكرة إن الـdiagrammatic approach محتاجة focused") == "rtl"
    assert pipeline.base_dir("وده هيوصل للـstatement والـfunctions") == "rtl"
    assert pipeline.base_dir("مشروع (Architecture Approach) معماري") == "rtl"


def test_base_dir_only_uses_ltr_for_all_latin_lines():
    assert pipeline.base_dir("Okay, so the main feedback was about the diagram.") == "ltr"
    assert pipeline.base_dir("Speaker A/B · 12:47") == "ltr"


def test_base_dir_is_ltr_only_without_arabic():
    assert pipeline.base_dir("01:17–04:17") == "ltr"
    assert pipeline.base_dir("—") == "ltr"


# ------------------------------------------------------------ transcript html
def _build(tmp_path, lines):
    turns = [{"start": s, "end": e, "speaker": "SPK_0"} for s, e, _ in lines]
    html_path, txt_path, _, _ = pipeline.build_outputs(
        str(tmp_path), "تسجيل", lines, turns, "", lines[0][0], lines[-1][1]
    )
    return html_path, txt_path


def test_player_declares_an_rtl_document(tmp_path):
    html_path, _ = _build(tmp_path, [(0.0, 10.0, "مرحبا بالعالم.")])
    html = open(html_path, encoding="utf-8").read()

    assert '<html lang="ar" dir="rtl">' in html


def test_window_starting_with_english_still_reads_rtl(tmp_path):
    """Regression: `dir="auto"` on the window flipped it to LTR for "okay."."""
    html_path, _ = _build(
        tmp_path,
        [(0.0, 30.0, "okay. فكرة الـdiagrammatic approach إننا نقلل الـtext.")],
    )
    html = open(html_path, encoding="utf-8").read()

    assert 'dir="auto"' not in html
    assert '<p class="txt" dir="rtl">' in html


def test_each_clause_is_isolated_with_its_own_direction(tmp_path):
    """An English clause inside an Arabic paragraph must not drag its neighbours."""
    html_path, _ = _build(
        tmp_path,
        [(0.0, 30.0, "okay. فكرة الـdiagrammatic approach إننا نقلل الـtext.")],
    )
    html = open(html_path, encoding="utf-8").read()

    assert 'dir="ltr">okay. </span>' in html
    assert 'dir="rtl">فكرة الـdiagrammatic approach إننا نقلل الـtext. </span>' in html
    # Every chunk isolates itself, so punctuation cannot jump between clauses.
    assert "unicode-bidi: isolate" in html


def test_all_english_window_stays_ltr(tmp_path):
    html_path, _ = _build(
        tmp_path, [(0.0, 10.0, "Okay, so the main feedback was about the diagram.")]
    )
    html = open(html_path, encoding="utf-8").read()

    assert '<p class="txt" dir="ltr">' in html


def test_txt_marks_english_blocks_ltr(tmp_path):
    """Notepad has no `dir`: the mark in front of the line decides."""
    _, txt_path = _build(
        tmp_path,
        [
            (0.0, 10.0, "okay. الفكرة إن الـpresentation محتاجة focused"),
            (10.0, 20.0, "Okay, so the main feedback was about the diagram."),
        ],
    )
    text = open(txt_path, encoding="utf-8-sig").read()

    assert "\u200fokay. الفكرة" in text
    assert "\u200eOkay, so the main feedback" in text
    assert "\u200fOkay, so the main" not in text


# --------------------------------------------------------------- summary html
def test_summary_section_is_rtl_not_auto():
    assert add_summary.base_dir("Feedback: هذا ملخص") == "rtl"
    assert add_summary.base_dir("Fix the timeline width.") == "ltr"


def test_summary_checkbox_stays_on_the_rtl_side():
    html, count = add_summary.md_to_html("- [ ] مهمة (Speaker A/B).\n")

    assert count == 1
    # The box is the first child of the label (right edge in an RTL card) and
    # only the sentence itself follows its own direction.
    assert html.startswith('<label class="chk"><input type="checkbox" data-chk="0"><bdi dir="rtl">')
    assert html.endswith("</bdi></label>")


def test_summary_bullet_keeps_the_list_marker_rtl_for_english_items():
    html, _ = add_summary.md_to_html("- Fix the timeline width in the presentation.\n")

    assert html == '<ul>\n<li><bdi dir="ltr">Fix the timeline width in the presentation.</bdi></li>\n</ul>'


def test_summary_paragraphs_follow_their_own_script():
    html, _ = add_summary.md_to_html("نظرة عامة\n\nAction points\n")

    assert '<p dir="rtl">نظرة عامة</p>' in html
    assert '<p dir="ltr">Action points</p>' in html


# ------------------------------------------------------------------- bidi runs
def test_clock_ranges_are_isolated_so_they_never_reverse():
    html, _ = add_summary.md_to_html("**تحديد (01:17–04:17):**\n")
    assert '<bdi dir="ltr">01:17–04:17</bdi>' in html

    html_en, _ = add_summary.md_to_html("Range 04:47 - 11:17 inside the deck\n")
    assert '<bdi dir="ltr">04:47–11:17</bdi>' in html_en


def test_latex_arrows_become_reading_order_arrows():
    html, _ = add_summary.md_to_html("الإطار $\\rightarrow$ المنهج $\\to$ التايبولوجي\n")
    assert "\\rightarrow" not in html and "$" not in html
    assert "الإطار ← المنهج ← التايبولوجي" in html

    html_en, _ = add_summary.md_to_html("Principles $\\rightarrow$ Approach\n")
    assert "Principles → Approach" in html_en


def test_txt_ranges_use_bidi_isolates(tmp_path):
    txt = tmp_path / "t.txt"
    txt.write_text("", encoding="utf-8")

    add_summary.inject_txt(str(txt), "**عرض (04:47–11:17)**\n- أ $\\rightarrow$ ب\n")

    rendered = txt.read_text(encoding="utf-8-sig")
    assert "\u206604:47–11:17\u2069" in rendered, "LRI/PDI keep the range LTR in Notepad"
    assert "أ ← ب" in rendered
    assert "\\rightarrow" not in rendered


def test_injected_summary_section_is_rtl(tmp_path):
    html_path = tmp_path / "transcript.html"
    html_path.write_text(
        "<html><body><main></main><script>1</script></body></html>", encoding="utf-8"
    )

    add_summary.inject_html(
        str(html_path),
        "**ملخص (01:17–04:17)**\n\n- [ ] مهمة.\n\n- Fix the deck.\n",
    )

    html = html_path.read_text(encoding="utf-8")
    assert '<section class="summary" id="recording-summary" dir="rtl">' in html
    assert '<h2 dir="rtl">الملخص</h2>' in html
    assert "dir=\"auto\"" not in html
    assert '<bdi dir="ltr">01:17–04:17</bdi>' in html

"""Append an agent-written summary of the recording to both deliverables of the
arabic-transcribe pipeline: the synced HTML player (styled card at the end) and
the plain-text transcript (bidi-marked section at the end).

The pipeline itself has no text LLM (Jais-ASR is ASR-only), so the summary is
written by the agent after transcription, saved as a small UTF-8 file, and
injected with this script. Idempotent: re-running replaces the previous
summary instead of duplicating it.

Summary format (markdown-lite): blank-line-separated paragraphs, "- " bullets,
**bold**, and action points as task lines "- [ ] task" / "- [x] task" — these
render as interactive checkboxes in the HTML (state kept in localStorage) and
as ballot boxes (☐/☒) in the TXT.

Usage:
    py -3.12 add_summary.py "<base>" --summary-file "<summary.md>"

where <base> is the transcript path WITHOUT the " - arabic transcript.*"
suffix (same convention run_pipeline.py uses). With no --summary-file, the
summary is read from stdin.
"""
import argparse, os, re, sys

RLM, LRM = "\u200f", "\u200e"
LRI, PDI = "\u2066", "\u2069"
SUMMARY_ID = "recording-summary"
TXT_MARK = "الملخص"          # LRM-prefixed when written
AR = re.compile(r"[\u0600-\u06FF]")
TASK_RE = re.compile(r"^- \[( |x|X)\]\s+(.+)$")
# "01:17–04:17": two clock times around a dash. Inside an RTL paragraph the
# numbers are LTR runs but the dash between them is neutral, so the browser
# reversed the range ("04:17–01:17"). Isolate it, never reorder it.
RANGE_RE = re.compile(r"(?<![\d:])(\d{1,3}:\d{2})\s*[–—\-]\s*(\d{1,3}:\d{2})(?![\d:])")

# LaTeX the summary models like to emit ("$\\rightarrow$") must not reach the
# page as punctuation soup.
MATH = {
    "rightarrow": "→", "to": "→", "longrightarrow": "→", "Rightarrow": "⇒", "implies": "⇒",
    "leftarrow": "←", "gets": "←", "longleftarrow": "←", "Leftarrow": "⇐",
    "leftrightarrow": "↔", "Leftrightarrow": "⇔", "times": "×", "cdot": "·", "div": "÷",
    "leq": "≤", "le": "≤", "geq": "≥", "ge": "≥", "neq": "≠", "pm": "±", "approx": "≈",
}

def die(msg):
    print("ERROR:", msg, flush=True)
    sys.exit(1)

def esc(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

def base_dir(line):
    """RTL for anything containing Arabic, LTR only for an all-Latin line.

    `dir="auto"` follows the first strong character, so an Arabic line that
    opens with an English word ("Feedback: ...") flipped to LTR and the list
    marker / checkbox jumped to the other side of the card.
    """
    return "rtl" if AR.search(line) else "ltr"

def bidi_line(line):
    """RLM for lines containing Arabic, LRM for LTR lines — the skill's Notepad rule."""
    return (RLM if AR.search(line) else LRM) + line

def _math(s, direction="rtl"):
    """Turn `$\\rightarrow$` into an arrow that points along the reading order."""
    def one(name):
        glyph = MATH.get(name)
        if glyph is None:
            return None
        if glyph in "→←" and direction == "rtl":
            glyph = "←" if glyph == "→" else "→"
        return glyph

    def dollars(m):
        body = m.group(1).strip()
        cmd = re.fullmatch(r"\\([A-Za-z]+)", body)
        glyph = one(cmd.group(1)) if cmd else None
        return glyph if glyph is not None else body

    s = re.sub(r"\$([^$]+)\$", dollars, s)
    return re.sub(r"\\([A-Za-z]+)", lambda m: one(m.group(1)) or m.group(0), s)

def _ranges_html(s):
    return RANGE_RE.sub(lambda m: f'<bdi dir="ltr">{m.group(1)}–{m.group(2)}</bdi>', s)

def _ranges_text(s):
    return RANGE_RE.sub(lambda m: f"{LRI}{m.group(1)}–{m.group(2)}{PDI}", s)

# ---------------------------------------------------------------- markdown-lite -> HTML
def _inline(s, direction="rtl"):
    s = esc(s)
    s = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", s)
    s = re.sub(r"(?<!\*)\*([^*\n]+)\*(?!\*)", r"<em>\1</em>", s)
    s = _ranges_html(_math(s, direction))
    return s

def md_to_html(md):
    """Returns (html, n_checkboxes)."""
    out, in_list, chk_i = [], False, 0

    def close_list():
        nonlocal in_list
        if in_list:
            out.append("</ul>")
            in_list = False

    for raw in md.splitlines():
        line = raw.strip()
        if not line:
            close_list()
            continue
        # `#`-headings are not part of the format, but a model sometimes sends
        # them; strip the marks instead of printing them.
        line = re.sub(r"^#{1,6}\s+", "", line)
        direction = base_dir(line)
        m = TASK_RE.match(line)
        if m:                                   # action point -> checkbox
            close_list()
            done = m.group(1).lower() == "x"
            # The box lives on the card's right edge (the section is RTL);
            # only the sentence itself follows its own direction.
            out.append(f'<label class="chk"><input type="checkbox" data-chk="{chk_i}"'
                       f'{" checked" if done else ""}>'
                       f'<bdi dir="{direction}">{_inline(m.group(2), direction)}</bdi></label>')
            chk_i += 1
            continue
        if line.startswith(("- ", "* ")):
            if not in_list:
                out.append("<ul>")
                in_list = True
            out.append(f'<li><bdi dir="{direction}">{_inline(line[2:].strip(), direction)}</bdi></li>')
        else:
            close_list()
            out.append(f'<p dir="{direction}">{_inline(line, direction)}</p>')
    close_list()
    return "\n".join(out), chk_i

CHK_JS = """<script>(()=>{try{
const KEY='recording-summary-chk',sv=JSON.parse(localStorage.getItem(KEY)||'[]');
document.querySelectorAll('#recording-summary input[data-chk]').forEach(cb=>{const i=+cb.dataset.chk;
if(i<sv.length)cb.checked=sv[i];
cb.addEventListener('change',()=>{const a=JSON.parse(localStorage.getItem(KEY)||'[]');a[i]=cb.checked;localStorage.setItem(KEY,JSON.stringify(a));});});
}catch(e){}})();</script>"""

SUMMARY_CSS = """.summary { max-width: 980px; margin: 1.4rem auto 2.2rem; padding: 1.1rem 1.4rem;
            background: #f7f6f2; border: 2px solid #141414; border-radius: 0; direction: rtl; }
.summary h2 { font-size: 1.45rem; font-weight: 900; line-height: 1.2; margin: 0 0 .6rem;
            padding-bottom: .55rem; border-bottom: 1px solid #141414; color: #141414; }
.summary p, .summary li { font-size: 1.02rem; line-height: 2.0; color: #3a3833; }
.summary ul { margin: .3rem 0 0; padding-inline-start: 1.3rem; }
.summary strong { color: #141414; font-weight: 700; }
.chklist { display: flex; flex-direction: column; gap: .25rem; margin: .2rem 0 0; }
.chk { display: flex; align-items: flex-start; gap: .6rem; font-size: 1.02rem; line-height: 1.9;
       padding: .45rem 0; cursor: pointer; border-bottom: 1px solid #14141420; }
.chk input { appearance: none; -webkit-appearance: none; flex: none; width: 17px; height: 17px;
             margin: .3rem 0 0; border: 1.5px solid #141414; background: #eceae4;
             border-radius: 0; position: relative; cursor: pointer; accent-color: #c8321e; }
.chk input:checked { background: #c8321e; border-color: #c8321e; }
.chk input:checked::after { content: ""; position: absolute; left: 4.5px; top: 1.5px;
             width: 4.5px; height: 9px; border-right: 2px solid #fff;
             border-bottom: 2px solid #fff; transform: rotate(40deg); }
.chk bdi { flex: 1; text-align: right; }
.chk input:checked + bdi { text-decoration: line-through; color: #5e5b55; }"""

def inject_html(html_path, summary_md):
    with open(html_path, encoding="utf-8") as f:
        html = f.read()
    # "</main>" plus some <script> tag. Accept attributes: re-rendering (retry
    # summary) works on the themed page, where apply_ui has already turned the
    # plain player script into <script id="ui-player-js">.
    if "</main>" not in html or "<script" not in html:
        die(f"{html_path} does not look like a pipeline HTML player (missing </main>/<script>)")

    body_html, n_chk = md_to_html(summary_md)
    section = (f'<section class="summary" id="{SUMMARY_ID}" dir="rtl">\n'
               f'<h2 dir="rtl">الملخص</h2>\n{body_html}')
    if n_chk:
        section += "\n" + CHK_JS
    section += "\n</section>"

    # idempotent: drop a previous summary section, then insert fresh before <script>
    html = re.sub(rf'\n*<section class="summary" id="{SUMMARY_ID}"[^>]*>.*?</section>',
                  "", html, count=1, flags=re.S)
    if ".summary {" not in html:                      # add the CSS once
        html = html.replace("</style>", SUMMARY_CSS + "\n</style>", 1)
    html = html.replace("</main>", "</main>\n" + section, 1)

    with open(html_path, "w", encoding="utf-8") as f:
        f.write(html)

# ---------------------------------------------------------------- TXT append
def inject_txt(txt_path, summary_md):
    with open(txt_path, encoding="utf-8-sig") as f:
        txt = f.read()
    lines = []
    for raw in summary_md.strip().splitlines():
        line = raw.strip()
        if not line:
            lines.append("")
            continue
        line = re.sub(r"^#{1,6}\s+", "", line)
        m = TASK_RE.match(line)
        if m:                                        # action point -> ballot box
            box = "\u2612" if m.group(1).lower() == "x" else "\u2610"
            line = box + " " + m.group(2)
        direction = base_dir(line)
        lines.append(bidi_line(_ranges_text(_math(line, direction))))
    sep = "=" * 70
    block = "\n" + sep + "\n" + LRM + TXT_MARK + "\n" + sep + "\n\n" + "\n".join(lines) + "\n"
    # idempotent: replace everything from the previous mark on, else append
    pat = re.compile(r"\n={70}\n" + re.escape(LRM + TXT_MARK) + r"\n={70}\n[\s\S]*$")
    if pat.search(txt):
        txt = pat.sub("", txt).rstrip("\n")
    txt = txt.rstrip("\n") + block
    with open(txt_path, "w", encoding="utf-8-sig") as f:
        f.write(txt)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("base", help="transcript path without the ' - arabic transcript.*' suffix")
    ap.add_argument("--summary-file", help="UTF-8 (markdown-lite) summary; default: stdin")
    args = ap.parse_args()

    if args.summary_file:
        if not os.path.exists(args.summary_file):
            die(f"summary file not found: {args.summary_file}")
        with open(args.summary_file, encoding="utf-8-sig") as f:
            md = f.read()
    else:
        md = sys.stdin.read()
    if not md.strip():
        die("summary is empty — nothing to inject")

    html_path = args.base + " - arabic transcript.html"
    txt_path = args.base + " - arabic transcript.txt"
    if not os.path.exists(html_path):
        die(f"HTML player not found: {html_path}")

    inject_html(html_path, md)
    print("SAVED", html_path, "(summary section updated)", flush=True)
    if os.path.exists(txt_path):
        inject_txt(txt_path, md)
        print("SAVED", txt_path, "(summary section updated)", flush=True)
    else:
        print("WARN no TXT transcript found — summary injected into HTML only", flush=True)

if __name__ == "__main__":
    main()
